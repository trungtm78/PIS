import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjTaskForceStore, memberAddedRecord, taskForceCreatedRecord, taskForceDissolvedRecord } from '@machvon/db';
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

const MANAGE_PERMISSION = PERMISSIONS.createTaskForce;

/**
 * The task forces that press the disbursement of the projects of an area (ST-PRJ-005, PRJ 3.1 F9; Directive 162/CD-TTg). A force is founded, receives
 * members whose grants reach into its scope, and is dissolved with all its open terms in one transaction. The module document gives the three commands to
 * the office that administers the assignments for the whole tenant, so a grant on one unit subtree is not enough (403 SCOPE_DENIED): a force is a fact of the
 * tenant, and the members are judged against the scope of the force, not against the scope of the caller.
 */
@Controller()
export class TaskForceController {
  private readonly forces = new PrjTaskForceStore();

  @Post('task-forces')
  @HttpCode(200)
  @OperationId('createTaskForce')
  @Command({ operation: 'createTaskForce' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PrjTaskForceCreate']): Promise<CommandResult> {
    const now = new Date();
    requireWholeTenant(access);
    const made = await this.forces.create(scope.tx, {
      code: body.code,
      name: body.name,
      purpose: body.purpose,
      leadMembershipId: body.lead_membership_id,
      scopeUnitId: body.scope_unit_id,
      validFrom: body.valid_from,
      establishmentDocumentId: body.establishment_document_id,
      actor: scope.tenant.membershipId,
      today: vietnamDateOf(now),
      now,
    });
    const record = taskForceCreatedRecord(made, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    return commandResult(scope, made.status, made.version, made.id);
  }

  @Post('task-forces/:id/members')
  @HttpCode(200)
  @OperationId('addTaskForceMember')
  @Command({ operation: 'addTaskForceMember' })
  async addMember(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjTaskForceMember']): Promise<CommandResult> {
    const now = new Date();
    requireWholeTenant(access);
    const added = await this.forces.addMember(scope.tx, {
      taskForceId: id.toLowerCase(),
      membershipId: body.membership_id,
      role: body.member_role,
      projectId: body.project_id,
      validFrom: body.valid_from,
      actor: scope.tenant.membershipId,
      today: vietnamDateOf(now),
      now,
    });
    await scope.audit(memberAddedRecord(added));
    return commandResult(scope, 'ACTIVE', added.taskForceVersion, added.taskForceId);
  }

  @Post('task-forces/:id/dissolution')
  @HttpCode(200)
  @OperationId('dissolveTaskForce')
  @Command({ operation: 'dissolveTaskForce', versioned: true })
  async dissolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisPeriodTransition']): Promise<CommandResult> {
    const now = new Date();
    requireWholeTenant(access);
    const done = await this.forces.dissolve(scope.tx, {
      taskForceId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      reason: body.reason,
      actor: scope.tenant.membershipId,
      today: vietnamDateOf(now),
    });
    const record = taskForceDissolvedRecord(done, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    return commandResult(scope, done.status, done.version, done.id);
  }
}

function requireWholeTenant(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}
