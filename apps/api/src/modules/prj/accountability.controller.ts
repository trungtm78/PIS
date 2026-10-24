import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjAccountabilityStore, assignmentEndedRecord, assignmentMadeRecord, projectScope } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const ASSIGN_PERMISSION = PERMISSIONS.assignProjectLeader;

/**
 * Who answers for a project (ST-PRJ-005, PRJ 3.1 F9, BR-PRJ-10). The module document gives these two commands to the office that administers the
 * assignments for the whole tenant, so a grant on one unit subtree is not enough (403 SCOPE_DENIED): the leader of a project is a fact of the tenant, and
 * the register of one unit must not decide it. Each command leaves the audit row and the event of the same transaction and clears the pages of the
 * project bank, whose cards show the leader in charge.
 */
@Controller()
export class ProjectAccountabilityController {
  private readonly accountability = new PrjAccountabilityStore();
  private readonly cache: PipelineCache;

  constructor(@Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache) {
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Post('projects/:id/accountability-assignments')
  @HttpCode(200)
  @OperationId('assignProjectLeader')
  @Command({ operation: 'assignProjectLeader' })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLeaderAssignment']): Promise<CommandResult> {
    const now = new Date();
    this.requireWholeTenant(access);
    const made = await this.accountability.assign(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      leaderMembershipId: body.leader_membership_id,
      role: body.accountability_role,
      validFrom: body.valid_from,
      assignmentDocumentId: body.assignment_document_id,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, ASSIGN_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
      now,
    });
    const record = assignmentMadeRecord(made, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    scope.afterCommit(() => this.cache.invalidate(scope.tenant.tenantId));
    return commandResult(scope, made.status, made.version, made.id);
  }

  @Post('accountability-assignments/:id/end')
  @HttpCode(200)
  @OperationId('endProjectLeaderAssignment')
  @Command({ operation: 'endProjectLeaderAssignment', versioned: true })
  async end(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjAssignmentEnd']): Promise<CommandResult> {
    const now = new Date();
    this.requireWholeTenant(access);
    const ended = await this.accountability.end(scope.tx, {
      assignmentId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      validUntil: body.valid_until,
      endReason: body.end_reason,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, ASSIGN_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    const record = assignmentEndedRecord(ended, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    scope.afterCommit(() => this.cache.invalidate(scope.tenant.tenantId));
    return commandResult(scope, ended.status, ended.version, ended.id);
  }

  private requireWholeTenant(access: EffectiveAccess): void {
    if (!holdsOnWholeTenant(access, ASSIGN_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
  }
}
