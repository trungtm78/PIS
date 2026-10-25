import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrChangeChainStore, CtrContractSource, TenantDatabase, contractScope, projectScope } from '@machvon/db';
import type { ContractScopes, CtrChangeResult, CtrSetTiersResult } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
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
import { CapitalCommitments } from '../cap/commitment.port';
import { changeActionsOf, changeRequestView, tierConfigView } from './change-view';
import type { ChangePermissions } from './change-view';
import { reaches, refsOf } from './contract.controller';

const CONFIGURE_PERMISSION = PERMISSIONS.setChangeChainTiers;
const CREATE_PERMISSION = PERMISSIONS.createChangeRequest;
const PROMOTE_PERMISSION = PERMISSIONS.promoteChangeRequest;
const EVALUATE_PERMISSION = PERMISSIONS.evaluateChangeRequest;
const WITHDRAW_PERMISSION = PERMISSIONS.withdrawChangeRequest;
const CHAIN_READ_PERMISSION = PERMISSIONS.getChangeChain;
const REQUEST_READ_PERMISSION = PERMISSIONS.get_resources_change_request;
const CONFIG_RESOURCE = 'change_chain_config';
const REQUEST_RESOURCE = 'change_request';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: ChangePermissions = { promote: PROMOTE_PERMISSION, evaluate: EVALUATE_PERMISSION, withdraw: WITHDRAW_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, CHAIN_READ_PERMISSION, now) });

/**
 * The chain of changes of a contract (ST-CTR-006, CTR 3.3). The business owner sets how many tiers a project uses (1, 2 or 3) until the first request is raised, which fixes the number
 * (409 `CHANGE_TIERS_LOCKED`; the database refuses a statement that bypasses the command). A request is raised at the first tier of the chain only (422 `CHANGE_STAGE_NOT_ALLOWED`
 * elsewhere) on a contract that is being performed, promoted from tier to tier, evaluated at a PCO or a CO (an increase has to fit the line of capital it is paid from, asked of CAP
 * through its port) or withdrawn. The decision of a CO and the revision it makes of the contract are another story. Status, tier, code and version are written by no body.
 */
@Controller()
export class ChangeChainController {
  private readonly source = new CtrContractSource();
  private readonly chain = new CtrChangeChainStore(this.source);
  private readonly contractors = new BidContractorStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(CapitalCommitments) private readonly commitments: CapitalCommitments,
  ) {}

  @Post('projects/:id/change-chain-config')
  @HttpCode(200)
  @OperationId('setChangeChainTiers')
  @Command({ operation: 'setChangeChainTiers' })
  async setTiers(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrSetChangeChainTiers']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.chain.setTiers(scope.tx, id.toLowerCase(), body.tier_count, scope.tenant.membershipId, projectScope(access, CONFIGURE_PERMISSION, now));
    await this.configured(scope, done, now);
    return commandResult(scope, 'CONFIGURED', done.version, done.id);
  }

  @Post('contracts/:id/change-requests')
  @HttpCode(200)
  @OperationId('createChangeRequest')
  @Command({ operation: 'createChangeRequest' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrCreateChangeRequest']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.chain.create(
      scope.tx,
      id.toLowerCase(),
      { stage: body.stage, baselineRevisionId: body.baseline_revision_id, eventKind: body.event_kind, reason: body.reason, estimatedDeltaVnd: body.estimated_delta_vnd, scheduleImpactDays: body.schedule_impact_days },
      scope.tenant.membershipId,
      scopesFor(access, CREATE_PERMISSION, now),
    );
    await this.written(scope, made, 'change.opened', 'ctr.change.opened.v1', now, { baseline_revision_id: body.baseline_revision_id, locked_tiers: made.lockedTiers });
    return commandResult(scope, made.status, made.version, made.id);
  }

  @Post('change-requests/:id/promote')
  @HttpCode(200)
  @OperationId('promoteChangeRequest')
  @Command({ operation: 'promoteChangeRequest', versioned: true })
  async promote(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrPromoteChangeRequest']): Promise<CommandResult> {
    const now = new Date();
    const child = await this.chain.promote(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, PROMOTE_PERMISSION, now));
    // The request that was promoted changed its status, and a new one stands above it: each has its audit row, and the event is the promotion.
    await scope.audit({
      action: 'change.promoted',
      resourceType: REQUEST_RESOURCE,
      resourceId: id.toLowerCase(),
      classification: CLASSIFICATION,
      reason: body.reason,
      diff: { from_status: child.fromStatus, to_status: 'PROMOTED', promoted_to_id: child.id, promoted_to_stage: child.stage },
    });
    await this.written(scope, child, 'change.opened', 'ctr.change.promoted.v1', now, { promoted_from_id: child.parentId }, body.reason);
    return commandResult(scope, child.status, child.version, child.id);
  }

  @Post('change-requests/:id/evaluate')
  @HttpCode(200)
  @OperationId('evaluateChangeRequest')
  @Command({ operation: 'evaluateChangeRequest', versioned: true })
  async evaluate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEvaluateChangeRequest']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.chain.evaluate(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        evaluatedDeltaVnd: body.evaluated_delta_vnd,
        scheduleImpactDays: body.schedule_impact_days,
        fundingImpactNote: body.funding_impact_note,
        scopeImpactNote: body.scope_impact_note,
        allocationLineId: body.allocation_line_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, EVALUATE_PERMISSION, now),
      { available: (allocationLineId, amountVnd) => this.commitments.assertCanAbsorb(scope, allocationLineId, amountVnd) },
    );
    await this.written(scope, done, 'change.evaluated', 'ctr.change.evaluated.v1', now, {});
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('change-requests/:id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawChangeRequest')
  @Command({ operation: 'withdrawChangeRequest', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrWithdrawChangeRequest']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.chain.withdraw(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, WITHDRAW_PERMISSION, now));
    await this.written(scope, done, 'change.withdrawn', 'ctr.change.withdrawn.v1', now, {}, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The board of a project (CTR-19) and the form of a contract (CTR-07): the tiers of the project, the requests in the scope of the caller and what the caller may do with each. */
  @Get('projects/:id/change-chain')
  @OperationId('getChangeChain')
  async view(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query('contract_id') contractId?: unknown): Promise<Record<string, unknown>> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const now = new Date();
    const projectId = id.toLowerCase();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const project = await this.source.projectRef(tx, projectId);
      if (project === undefined) return undefined;
      const refs = refsOf(project, project.id);
      const reads = contractScope(access, CHAIN_READ_PERMISSION, now);
      // The staff reach the project; a guest contractor reaches only its own contract in it.
      const staff = reaches(access, CHAIN_READ_PERMISSION, refs, now);
      if (!staff && !(await this.chain.contractVisible(tx, projectId, reads))) return undefined;
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      const internal = staff && !guest;
      const config = internal ? await this.chain.config(tx, projectId, projectScope(access, CHAIN_READ_PERMISSION, now)) : undefined;
      const lines = await this.chain.list(tx, reads, { projectId, contractId: filter?.toLowerCase(), limit: 1000 });
      return {
        project_id: projectId,
        ...(config === undefined ? {} : { config: tierConfigView(config) }),
        requests: lines.map((line) => changeRequestView(line, { internal: !guest }, guest ? undefined : changeActionsOf(line, config?.tierCount, access, now, ACTION_PERMISSIONS))),
        actions: { configure: internal && reaches(access, CONFIGURE_PERMISSION, refs, now), open: internal && reaches(access, CREATE_PERMISSION, refs, now) },
        as_of: now.toISOString(),
      };
    });
    // A project of another tenant, or one the caller does not reach, is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }

  private async configured(scope: CommandScope, done: CtrSetTiersResult, now: Date): Promise<void> {
    await scope.audit({
      action: 'change.tiers_configured',
      resourceType: CONFIG_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { project_id: done.projectId, tier_count: done.tierCount, previous_tier_count: done.previousTierCount },
    });
    await scope.emit({
      aggregateType: CONFIG_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ctr.change_chain.configured.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: done.projectId,
        tier_count: done.tierCount,
        previous_tier_count: done.previousTierCount,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${CONFIG_RESOURCE}:${done.id}:${done.version}`,
    });
  }

  /** The audit row and the event of a command that moved a request: ids, codes, tiers, statuses and amounts, never the words of the reason beyond the row that keeps them. */
  private async written(scope: CommandScope, done: CtrChangeResult, action: string, type: string, now: Date, extra: Record<string, unknown>, reason?: string): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      code: done.code,
      stage: done.stage,
      parent_id: done.parentId,
      tier_count: done.tierCount,
      event_kind: done.eventKind,
      estimated_delta_vnd: done.estimatedDeltaVnd,
      evaluated_delta_vnd: done.evaluatedDeltaVnd,
      schedule_impact_days: done.scheduleImpactDays,
      allocation_line_id: done.allocationLineId,
    };
    await scope.audit({
      action,
      resourceType: REQUEST_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts, ...extra },
    });
    await scope.emit({
      aggregateType: REQUEST_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, change_request_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${REQUEST_RESOURCE}:${done.id}:${done.version}`,
    });
  }
}

/** The requests of the contracts in the scope of the caller (the right to read them is `change_request.read`); a guest contractor reads the tier and the status of the requests of its own contract. */
@Controller('resources/change_request')
export class ChangeRequestReadsController {
  private readonly chain = new CtrChangeChainStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_change_request')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.chain.list(tx, contractScope(access, REQUEST_READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => changeRequestView(line, { internal: !guest })),
      // The ordering key of the page is the creation time and the id, which the store compares as a pair.
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_change_request_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const line = await this.chain.find(tx, id.toLowerCase(), contractScope(access, REQUEST_READ_PERMISSION, now));
      if (line === undefined) return undefined;
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      return changeRequestView(line, { internal: !guest });
    });
    // A request in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
