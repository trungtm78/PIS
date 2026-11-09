import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, ProjectCodeStore, SourceSystemStore, TenantDatabase } from '@machvon/db';
import type { ProjectCodeFilter } from '@machvon/db';
import { DomainError, EGP_MAPPING_STATUSES, SOURCE_SYSTEM_KINDS, egpReasonOf, projectCodeRequestOf, sourceSystemRequestOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { nameLookup, projectCodeDto, sourceSystemDto } from './int-view';
import { queryText } from './machine-account.controller';

const SYSTEM_RESOURCE = 'int_source_system';
const CODE_RESOURCE = 'master_crosswalk';

const people = new BidWorkflowReads();

const wholeTenant = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The other systems of the organization and the codes our projects have in them (INT-03). The codes are rows of `master_crosswalk` (subject PROJECT, type PROJECT_CODE): there is no table of external identities.
 * A code is proposed by one person and approved by another; a wrong code is retired and replaced by a new proposal, so the rows are the history.
 */
@Controller()
export class ProjectCodeController {
  private readonly systems = new SourceSystemStore();
  private readonly codes = new ProjectCodeStore();

  private async announce(scope: CommandScope, resource: string, type: string, id: string, version: number, change: string, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: resource,
      aggregateId: id,
      aggregateVersion: version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, id, change, version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${resource}:${id}:${version}:${change}`,
    });
  }

  @Post('int/source-systems')
  @HttpCode(201)
  @OperationId('registerSourceSystem')
  @Command({ operation: 'registerSourceSystem' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SourceSystemRegister']): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.registerSourceSystem);
    const now = new Date();
    const row = await this.systems.register(scope.tx, sourceSystemRequestOf(body as unknown as Record<string, unknown>), scope.tenant.membershipId);
    await scope.audit({ action: 'int.source_system_registered', resourceType: SYSTEM_RESOURCE, resourceId: row.id, classification: 'INTERNAL', diff: { code: row.code, kind: row.kind, code_pattern: row.codePattern } });
    await this.announce(scope, SYSTEM_RESOURCE, 'int.source_system.changed.v1', row.id, row.version, 'REGISTERED', now);
    return sourceSystemDto(row, holdsOnWholeTenant(access, PERMISSIONS.retireSourceSystem));
  }

  @Post('int/source-systems/:id/retire')
  @HttpCode(200)
  @OperationId('retireSourceSystem')
  @Command({ operation: 'retireSourceSystem', versioned: true })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SourceSystemRetire']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.retireSourceSystem);
    const now = new Date();
    const reason = egpReasonOf(body.reason);
    const done = await this.systems.retire(scope.tx, id, scope.expectedVersion ?? 0, reason, scope.tenant.membershipId, now);
    await scope.audit({ action: 'int.source_system_retired', resourceType: SYSTEM_RESOURCE, resourceId: id, classification: 'INTERNAL', reason, diff: { code: done.row.code } });
    await this.announce(scope, SYSTEM_RESOURCE, 'int.source_system.changed.v1', id, done.row.version, 'RETIRED', now);
    return commandResult(scope, 'RETIRED', done.row.version, id);
  }

  @Post('int/project-codes')
  @HttpCode(201)
  @OperationId('proposeProjectCode')
  @Command({ operation: 'proposeProjectCode' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ProjectCodePropose']): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.proposeProjectCode);
    const now = new Date();
    const input = body as unknown as Record<string, unknown>;
    const request = projectCodeRequestOf(input);
    const reason = egpReasonOf(input.reason);
    const row = await this.codes.propose(scope.tx, { ...request, reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.project_code_proposed',
      resourceType: CODE_RESOURCE,
      resourceId: row.id,
      classification: 'INTERNAL',
      reason,
      diff: { source_system: row.sourceSystem, project_code: row.projectCode, external_code: row.externalCode, valid_from: row.validFrom, valid_until: row.validUntil },
    });
    await this.announce(scope, CODE_RESOURCE, 'int.project_code.changed.v1', row.id, row.version, 'PROPOSED', now);
    const nameOf = nameLookup(await people.names(scope.tx, [row.proposedBy]));
    return projectCodeDto(row, nameOf, { membershipId: scope.tenant.membershipId, mayDecide: holdsOnWholeTenant(access, PERMISSIONS.decideProjectCode), mayRetire: holdsOnWholeTenant(access, PERMISSIONS.retireProjectCode) });
  }

  @Post('int/project-codes/:id/decision')
  @HttpCode(200)
  @OperationId('decideProjectCode')
  @Command({ operation: 'decideProjectCode', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ProjectCodeDecision']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.decideProjectCode);
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const now = new Date();
    const done = await this.codes.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: body.decision === 'APPROVE' ? 'int.project_code_approved' : 'int.project_code_rejected',
      resourceType: CODE_RESOURCE,
      resourceId: id,
      classification: 'INTERNAL',
      reason: done.row.decisionReason ?? body.reason,
      diff: { source_system: done.row.sourceSystem, external_code: done.row.externalCode, from: done.before.status, to: done.row.status, proposed_by: done.row.proposedBy },
    });
    await this.announce(scope, CODE_RESOURCE, 'int.project_code.changed.v1', id, done.row.version, body.decision, now);
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('int/project-codes/:id/retire')
  @HttpCode(200)
  @OperationId('retireProjectCode')
  @Command({ operation: 'retireProjectCode', versioned: true })
  async retireCode(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ProjectCodeRetire']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.retireProjectCode);
    const now = new Date();
    const done = await this.codes.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: 'RETIRE', reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.project_code_retired',
      resourceType: CODE_RESOURCE,
      resourceId: id,
      classification: 'INTERNAL',
      reason: done.row.retireReason ?? body.reason,
      diff: { source_system: done.row.sourceSystem, external_code: done.row.externalCode, from: done.before.status, to: done.row.status },
    });
    await this.announce(scope, CODE_RESOURCE, 'int.project_code.changed.v1', id, done.row.version, 'RETIRED', now);
    return commandResult(scope, done.row.status, done.row.version, id);
  }
}

@Controller()
export class ProjectCodeReadsController {
  private readonly systems = new SourceSystemStore();
  private readonly codes = new ProjectCodeStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('int/source-systems')
  @OperationId('listSourceSystems')
  async listSystems(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.listSourceSystems);
    const now = new Date();
    const mayManage = holdsOnWholeTenant(access, PERMISSIONS.retireSourceSystem);
    return this.database.withTenant(tenant, async (tx) => ({
      items: (await this.systems.list(tx)).map((row) => sourceSystemDto(row, mayManage)),
      kinds: [...SOURCE_SYSTEM_KINDS],
      can_register: holdsOnWholeTenant(access, PERMISSIONS.registerSourceSystem),
      as_of: now.toISOString(),
    }));
  }

  @Get('int/project-codes')
  @OperationId('listProjectCodes')
  async listCodes(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.listProjectCodes);
    const now = new Date();
    const sourceSystem = queryText(query.source_system, 'source_system', 30);
    const status = queryText(query.status, 'status', 20);
    if (status !== undefined && !(EGP_MAPPING_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const q = queryText(query.q, 'q');
    const request = parsePageRequest(query.limit, query.cursor);
    const filter: ProjectCodeFilter = { sourceSystem, status: status as ProjectCodeFilter['status'], q };
    const caller = { membershipId: tenant.membershipId, mayDecide: holdsOnWholeTenant(access, PERMISSIONS.decideProjectCode), mayRetire: holdsOnWholeTenant(access, PERMISSIONS.retireProjectCode) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.codes.list(tx, filter, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const nameOf = nameLookup(await people.names(tx, shown.flatMap((row) => [row.proposedBy, row.approvedBy, row.retiredBy])));
      const systems = (await this.systems.list(tx)).filter((row) => row.status === 'ACTIVE');
      return {
        items: shown.map((row) => projectCodeDto(row, nameOf, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        counts: await this.codes.counts(tx),
        systems: systems.map((row) => ({ code: row.code, name: row.name, code_pattern: row.codePattern })),
        coverage: await Promise.all(
          systems.map(async (row) => {
            const covered = await this.codes.coverage(tx, row.code, vietnamDateOf(now));
            return {
              source_system: covered.sourceSystem,
              projects: covered.projects,
              mapped: covered.mapped,
              direct_only: covered.directOnly,
              unmapped: covered.unmapped,
              proposed: covered.proposed,
              shadows: covered.shadows,
              direct_fallback: covered.directFallback,
            };
          }),
        ),
        can_propose: holdsOnWholeTenant(access, PERMISSIONS.proposeProjectCode),
        as_of: now.toISOString(),
      };
    });
  }
}
