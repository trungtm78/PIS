import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrChangeChainStore, CtrChangeDecisionStore, CtrChangeTierStore, CtrContractSource, CtrRetroactiveStore, DoaMatrixStore, TenantDatabase, contractScope, projectScope } from '@machvon/db';
import type { TierOutcome } from '@machvon/db';
import type { ContractScopes, CtrChangeResult, CtrDecisionResult, CtrRetroactiveResult, CtrSetTiersResult } from '@machvon/db';
import { CHANGE_DOA_DOCUMENT_TYPE, DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertWithinDelegation } from '../../doa-delegation';
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
const DECIDE_PERMISSION = PERMISSIONS.post_contract_changes_id_decision;
const ADJUST_PERMISSION = PERMISSIONS.approveRetroactiveAdjustment;
const CHAIN_READ_PERMISSION = PERMISSIONS.getChangeChain;
const CLEAR_ADJUSTMENT_PERMISSION = PERMISSIONS.clearChangeAdjustmentCheck;
const ADJUSTMENT_RESOURCE = 'change_adjustment_check';
const REQUEST_READ_PERMISSION = PERMISSIONS.get_resources_change_request;
const CONFIG_RESOURCE = 'change_chain_config';
const REVISION_RESOURCE = 'contract_revision';
const REQUEST_RESOURCE = 'change_request';
const LEDGER_RESOURCE = 'cumulative_ledger';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: ChangePermissions = { promote: PROMOTE_PERMISSION, evaluate: EVALUATE_PERMISSION, withdraw: WITHDRAW_PERMISSION, decide: DECIDE_PERMISSION, adjust: ADJUST_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, CHAIN_READ_PERMISSION, now) });

/**
 * The chain of changes of a contract (ST-CTR-006, CTR 3.3). The business owner sets how many tiers a project uses (1, 2 or 3) until the first request is raised, which fixes the number
 * (409 `CHANGE_TIERS_LOCKED`; the database refuses a statement that bypasses the command). A request is raised at the first tier of the chain only (422 `CHANGE_STAGE_NOT_ALLOWED`
 * elsewhere) on a contract that is being performed, promoted from tier to tier, evaluated at a PCO or a CO (an increase has to fit the line of capital it is paid from, asked of CAP
 * through its port) or withdrawn. An assessed CO is decided by someone who had no part in its chain (ST-CTR-007): the approval rests on a decision document, begins today or later, keeps the
 * value of the contract at or above what was accepted and paid, is within the delegation limit of the matrix when the tenant configured one, and makes the next revision of the contract,
 * pending until its day. A CO that applies from a day before today is approved by the retroactive adjustment instead (ST-CTR-016): it makes the revision, puts it in force at once and posts the money
 * difference of the acceptances it reaches on the ledger of PAY as adjustments, without touching what was approved; it is refused while a verified or closed settlement has read the ledger.
 * Status, tier, code and version are written by no body.
 */
@Controller()
export class ChangeChainController {
  private readonly source = new CtrContractSource();
  private readonly chain = new CtrChangeChainStore(this.source);
  private readonly decisions = new CtrChangeDecisionStore(this.source);
  private readonly retroactive = new CtrRetroactiveStore(this.source);
  private readonly contractors = new BidContractorStore();
  private readonly doa = new DoaMatrixStore();
  private readonly tiers = new CtrChangeTierStore();

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
      {
        available: (allocationLineId, amountVnd) => this.commitments.assertCanAbsorb(scope, allocationLineId, amountVnd),
        // The tier of the change order by the thresholds of the policy of the day; a cumulative variation at the threshold raises the check of the project adjustment.
        classify: async (facts) => {
          const outcome = await this.tiers.classify(scope.tx, facts, scope.tenant.membershipId, vietnamDateOf(now));
          if (outcome.checkRaised) await this.checkRaised(scope, outcome, now);
          return { tier: outcome.classification.tier, cumulativePct: outcome.classification.cumulativePct, checkRaised: outcome.checkRaised };
        },
      },
    );
    await this.written(scope, done, 'change.evaluated', 'ctr.change.evaluated.v1', now, { tier: done.tier ?? null, cumulative_variation_pct: done.cumulativeVariationPct ?? null });
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

  @Post('contract-changes/:id/decision')
  @HttpCode(200)
  @OperationId('post_contract_changes_id_decision')
  @Command({ operation: 'post_contract_changes_id_decision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrContractChangeDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.decisions.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        decision: body.decision,
        reason: body.reason,
        evidenceIds: body.evidence_ids,
        approvedDeltaVnd: body.approved_delta_vnd,
        effectiveOn: body.effective_on,
        decisionDocumentVersionId: body.decision_document_version_id,
        boqLines: body.boq_lines,
      },
      scope.tenant.membershipId,
      scopesFor(access, DECIDE_PERMISSION, now),
      vietnamDateOf(now),
      {
        // The size of the change, whichever way it goes, against the bands the tenant configured for change orders; a tenant that configured none leaves it to the permission and its scope.
        authorise: (facts) =>
          assertWithinDelegation(this.doa, scope, access, {
            documentType: CHANGE_DOA_DOCUMENT_TYPE,
            permission: DECIDE_PERMISSION,
            amountVnd: facts.amountVnd,
            unitId: facts.ownerUnit.id,
            place: { ownerUnitPath: facts.ownerUnit.path, ownerUnitId: facts.ownerUnit.id, projectId: facts.projectId, contractId: facts.contractId },
            now,
            unconfigured: 'ALLOW',
          }),
        available: (allocationLineId, amountVnd) => this.commitments.assertCanAbsorb(scope, allocationLineId, amountVnd),
        // The tiers of the change orders (G1-8): the check of the project adjustment, the source of an increase, and the authority asked for the larger of the change and the cumulative variation.
        gate: (facts: { changeId: string; contractId: string; projectId: string; deltaVnd: string }) =>
          this.tiers.gate(scope.tx, facts, scope.tenant.membershipId, vietnamDateOf(now)).then((outcome) => ({ authorityAmountVnd: outcome.classification.authorityAmountVnd })),
      },
    );
    await this.decided(scope, done, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('change-requests/:id/adjustment-check')
  @HttpCode(200)
  @OperationId('clearChangeAdjustmentCheck')
  @Command({ operation: 'clearChangeAdjustmentCheck', versioned: true })
  async clearAdjustment(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClearAdjustmentCheck']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.tiers.clear(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { basis: body.basis, decisionDocumentVersionId: body.decision_document_version_id },
      scope.tenant.membershipId,
      scopesFor(access, CLEAR_ADJUSTMENT_PERMISSION, now),
      vietnamDateOf(now),
    );
    const facts = { change_request_id: done.changeId, contract_id: done.contractId, project_id: done.projectId, cumulative_pct: done.cumulativePct, decision_document_version_id: body.decision_document_version_id };
    await scope.audit({ action: 'change.adjustment_check_cleared', resourceType: ADJUSTMENT_RESOURCE, resourceId: done.checkId, classification: CLASSIFICATION, reason: body.basis, diff: facts });
    await scope.emit({
      aggregateType: ADJUSTMENT_RESOURCE,
      aggregateId: done.checkId,
      aggregateVersion: done.version,
      type: 'ctr.change.adjustment_check_cleared.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ADJUSTMENT_RESOURCE}:${done.checkId}:${done.version}`,
    });
    return { ...commandResult(scope, 'CLEARED', done.version, done.checkId), change_request_id: done.changeId };
  }

  /** The tier of a change order, where an increase is paid from and the check of the project adjustment (CTR-19, CTR-26), in the scope of the caller. */
  @Get('change-requests/:id/tier')
  @OperationId('getChangeTier')
  async tier(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const outcome = await this.tiers.view(tx, id.toLowerCase(), contractScope(access, CHAIN_READ_PERMISSION, now), vietnamDateOf(now));
      if (outcome === undefined) return undefined;
      const project = await this.source.projectRef(tx, outcome.projectId);
      return { outcome, project };
    });
    // A request in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { outcome } = found;
    const refs = found.project === undefined ? [] : refsOf(found.project, outcome.projectId, outcome.contractId);
    const { classification, funding, policy, check } = outcome;
    return {
      change_id: outcome.changeId,
      code: outcome.code,
      stage: outcome.stage,
      status: outcome.status,
      version: outcome.version,
      contract_id: outcome.contractId,
      project_id: outcome.projectId,
      tier: classification.tier,
      cumulative_after_vnd: classification.cumulativeAfterVnd,
      cumulative_pct: classification.cumulativePct,
      delta_pct: classification.deltaPct,
      forces_adjustment: classification.forcesAdjustment,
      authority_amount_vnd: classification.authorityAmountVnd,
      funding: { needs_cover: funding.needsCover, covered: funding.covered, covered_by: funding.coveredBy, shortfall_vnd: funding.shortfallVnd, approved_drawdown_vnd: outcome.approvedDrawdownVnd, contingency_balance_vnd: outcome.contingencyBalanceVnd },
      check:
        check === null
          ? null
          : {
              id: check.id,
              status: check.status,
              cumulative_pct: check.cumulativePct,
              threshold_pct: check.thresholdPct,
              basis: check.basis,
              decision_document_version_id: check.decisionDocumentVersionId,
              required_at: check.requiredAt,
              cleared_by: check.clearedBy,
              cleared_at: check.clearedAt,
              audit_notified_at: check.auditNotifiedAt,
            },
      policy: { version: policy.version, source: policy.source, project_adjustment_pct: policy.projectAdjustmentPct, require_reserve_cover: policy.requireReserveCover },
      actions: {
        clear_adjustment: outcome.stage === 'CO' && outcome.status === 'EVALUATED' && classification.forcesAdjustment && check?.status !== 'CLEARED' && reaches(access, CLEAR_ADJUSTMENT_PERMISSION, refs, now),
      },
      as_of: now.toISOString(),
    };
  }

  @Post('change-requests/:id/retroactive-adjustment')
  @HttpCode(200)
  @OperationId('approveRetroactiveAdjustment')
  @Command({ operation: 'approveRetroactiveAdjustment', versioned: true })
  async adjust(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrApproveRetroactiveAdjustment']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.retroactive.approve(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        adjustmentBasis: body.adjustment_basis,
        decisionDocumentVersionId: body.decision_document_version_id,
        affectedAcceptanceIds: body.affected_acceptance_ids,
        effectiveOn: body.effective_on,
        approvedDeltaVnd: body.approved_delta_vnd,
        boqLines: body.boq_lines,
      },
      scope.tenant.membershipId,
      scopesFor(access, ADJUST_PERMISSION, now),
      vietnamDateOf(now),
      {
        // The larger of the change and the money it moves on the ledger, against the bands the tenant configured for change orders.
        authorise: (facts) =>
          assertWithinDelegation(this.doa, scope, access, {
            documentType: CHANGE_DOA_DOCUMENT_TYPE,
            permission: ADJUST_PERMISSION,
            amountVnd: facts.amountVnd,
            unitId: facts.ownerUnit.id,
            place: { ownerUnitPath: facts.ownerUnit.path, ownerUnitId: facts.ownerUnit.id, projectId: facts.projectId, contractId: facts.contractId },
            now,
            unconfigured: 'ALLOW',
          }),
        available: (allocationLineId, amountVnd) => this.commitments.assertCanAbsorb(scope, allocationLineId, amountVnd),
        // The tiers of the change orders (G1-8): the check of the project adjustment, the source of an increase, and the authority asked for the larger of the change and the cumulative variation.
        gate: (facts: { changeId: string; contractId: string; projectId: string; deltaVnd: string }) =>
          this.tiers.gate(scope.tx, facts, scope.tenant.membershipId, vietnamDateOf(now)).then((outcome) => ({ authorityAmountVnd: outcome.classification.authorityAmountVnd })),
      },
    );
    await this.adjusted(scope, done, now);
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
        requests: lines.map((line) => changeRequestView(line, { internal: !guest }, guest ? undefined : changeActionsOf(line, config?.tierCount, access, now, ACTION_PERMISSIONS, tenant.membershipId))),
        actions: { configure: internal && reaches(access, CONFIGURE_PERMISSION, refs, now), open: internal && reaches(access, CREATE_PERMISSION, refs, now) },
        as_of: now.toISOString(),
      };
    });
    // A project of another tenant, or one the caller does not reach, is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }

  /** The audit row and the event that tell the audit a cumulative variation reached the threshold of the policy and a check of the project adjustment is required (G1-8). */
  private async checkRaised(scope: CommandScope, outcome: TierOutcome, now: Date): Promise<void> {
    const facts = {
      change_request_id: outcome.changeId,
      contract_id: outcome.contractId,
      project_id: outcome.projectId,
      cumulative_pct: outcome.classification.cumulativePct,
      threshold_pct: outcome.policy.projectAdjustmentPct,
      tier: outcome.classification.tier,
      tier_rule_version: outcome.policy.version,
    };
    const checkId = outcome.check?.id ?? outcome.changeId;
    await scope.audit({ action: 'change.adjustment_check_required', resourceType: ADJUSTMENT_RESOURCE, resourceId: checkId, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: ADJUSTMENT_RESOURCE,
      aggregateId: checkId,
      aggregateVersion: 1,
      type: 'ctr.change.adjustment_check_required.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ADJUSTMENT_RESOURCE}:${checkId}:required`,
    });
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

  /** The audit rows and the events of a decision: ids, statuses, amounts and days, never the words of the reason beyond the row that keeps them. */
  private async decided(scope: CommandScope, done: CtrDecisionResult, now: Date): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, project_id: done.projectId, code: done.code, evidence_ids: done.evidenceIds };
    const moved = { from_status: done.fromStatus, to_status: done.status, decision: done.decision };
    const approved = done.revision === undefined ? {} : { approved_delta_vnd: done.approvedDeltaVnd, effective_on: done.effectiveOn, decision_document_version_id: done.decisionDocumentVersionId, revision_id: done.revision.id, from_value_vnd: done.fromValueVnd, to_value_vnd: done.toValueVnd };
    await scope.audit({
      action: done.decision === 'approve' ? 'change.approved' : done.decision === 'return' ? 'change.returned' : 'change.rejected',
      resourceType: REQUEST_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      reason: done.reason,
      diff: { ...moved, ...facts, ...approved },
    });
    await scope.emit({
      aggregateType: REQUEST_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: done.decision === 'approve' ? 'ctr.change.approved.v1' : done.decision === 'return' ? 'ctr.change.returned.v1' : 'ctr.change.rejected.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, change_request_id: done.id, ...facts, ...moved, ...approved, allocation_line_id: done.allocationLineId, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REQUEST_RESOURCE}:${done.id}:${done.version}`,
    });
    if (done.revision === undefined) return;
    const revision = { revision_id: done.revision.id, contract_id: done.contractId, project_id: done.projectId, revision: done.revision.revision, kind: 'CHANGE_ORDER', amount_vnd: done.revision.amountVnd, valid_from: done.revision.validFrom, status: done.revision.status, supersedes_id: done.revision.supersedesId, change_request_id: done.id };
    await scope.audit({ action: 'contract.revision_created', resourceType: REVISION_RESOURCE, resourceId: done.revision.id, classification: CLASSIFICATION, diff: { ...revision, boq_line_count: done.revision.boqLineCount, boq_total_vnd: done.revision.boqTotalVnd } });
    await scope.emit({
      aggregateType: REVISION_RESOURCE,
      aggregateId: done.revision.id,
      aggregateVersion: done.revision.version,
      type: 'ctr.contract_revision.created.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, ...revision, version: done.revision.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REVISION_RESOURCE}:${done.revision.id}:created`,
    });
  }

  /**
   * The audit rows and the events of a retroactive adjustment: the change order and its adjustment, the revision it made and put in force, the capital told the new value, and the ledger told what
   * moved. Ids, days, amounts and counts, never the words of the basis beyond the row that keeps them.
   */
  private async adjusted(scope: CommandScope, done: CtrRetroactiveResult, now: Date): Promise<void> {
    const base = { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() };
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      code: done.code,
      adjustment_id: done.adjustmentId,
      effective_on: done.effectiveOn,
      approved_on: done.approvedOn,
      approved_delta_vnd: done.approvedDeltaVnd,
      decision_document_version_id: done.decisionDocumentVersionId,
      revision_id: done.revision.id,
      from_value_vnd: done.fromValueVnd,
      to_value_vnd: done.toValueVnd,
      total_adjustment_vnd: done.totalAdjustmentVnd,
      affected_acceptance_ids: done.affectedAcceptanceIds,
      balance_count: done.balances.length,
    };
    const moved = { from_status: done.fromStatus, to_status: done.status };
    await scope.audit({ action: 'change.retroactive_applied', resourceType: REQUEST_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, reason: done.adjustmentBasis, diff: { ...moved, ...facts } });
    await scope.emit({
      aggregateType: REQUEST_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ctr.change.retroactive_applied.v1',
      schemaVersion: 1,
      payload: { ...base, change_request_id: done.id, ...moved, ...facts, allocation_line_id: done.allocationLineId, version: done.version },
      eventKey: `${REQUEST_RESOURCE}:${done.id}:${done.version}`,
    });

    const revision = {
      revision_id: done.revision.id,
      contract_id: done.contractId,
      project_id: done.projectId,
      revision: done.revision.revision,
      kind: 'CHANGE_ORDER',
      retroactive: true,
      amount_vnd: done.revision.amountVnd,
      valid_from: done.revision.validFrom,
      status: done.revision.status,
      supersedes_id: done.revision.supersedesId,
      change_request_id: done.id,
    };
    await scope.audit({ action: 'contract.revision_created', resourceType: REVISION_RESOURCE, resourceId: done.revision.id, classification: CLASSIFICATION, diff: { ...revision, boq_line_count: done.revision.boqLineCount, boq_total_vnd: done.revision.boqTotalVnd } });
    await scope.emit({
      aggregateType: REVISION_RESOURCE,
      aggregateId: done.revision.id,
      aggregateVersion: done.revision.version,
      type: 'ctr.contract_revision.created.v1',
      schemaVersion: 1,
      payload: { ...base, ...revision, version: done.revision.version },
      eventKey: `${REVISION_RESOURCE}:${done.revision.id}:created`,
    });
    // The revision is in force from the moment it is made, so the capital is told the value the contract now commits, as it is when the job puts a revision in force.
    await scope.audit({
      action: 'contract.revision_effective',
      resourceType: REVISION_RESOURCE,
      resourceId: done.revision.id,
      classification: CLASSIFICATION,
      diff: {
        contract_id: done.contractId,
        code: done.contractCode,
        revision: done.revision.revision,
        valid_from: done.revision.validFrom,
        from_value_vnd: done.fromValueVnd,
        to_value_vnd: done.toValueVnd,
        superseded_id: done.supersededRevisionId,
        change_request_id: done.id,
      },
    });
    await scope.emit({
      aggregateType: 'contract',
      aggregateId: done.contractId,
      aggregateVersion: done.contractVersion,
      type: 'ctr.commitment.changed.v1',
      schemaVersion: 1,
      payload: {
        ...base,
        contract_id: done.contractId,
        project_id: done.projectId,
        allocation_line_id: done.commitmentAllocationLineId,
        committed_vnd: done.toValueVnd,
        previous_committed_vnd: done.fromValueVnd,
        revision_id: done.revision.id,
        revision: done.revision.revision,
        version: done.contractVersion,
      },
      eventKey: `contract:${done.contractId}:commitment:revision:${done.revision.id}`,
    });

    // The ledger: the entries are in the audit trail of the ledger of the contract, and the event drops the pages of it that are cached.
    await scope.audit({
      action: 'ledger.adjusted',
      resourceType: LEDGER_RESOURCE,
      resourceId: done.contractId,
      classification: CLASSIFICATION,
      diff: {
        adjustment_id: done.adjustmentId,
        change_request_id: done.id,
        total_adjustment_vnd: done.totalAdjustmentVnd,
        entries: done.balances.map((balance) => ({ entry_id: balance.entryId, acceptance_id: balance.acceptanceId, boq_item_id: balance.boqItemId, party_id: balance.partyId, delta_vnd: balance.deltaVnd })),
      },
    });
    await scope.emit({
      aggregateType: LEDGER_RESOURCE,
      aggregateId: done.contractId,
      aggregateVersion: done.contractVersion,
      type: 'pay.ledger.adjusted.v1',
      schemaVersion: 1,
      payload: { ...base, contract_id: done.contractId, adjustment_id: done.adjustmentId, change_request_id: done.id, entries: done.balances.length, total_adjustment_vnd: done.totalAdjustmentVnd, accepted_total_vnd: done.acceptedTotalVnd },
      eventKey: `${LEDGER_RESOURCE}:${done.contractId}:adjusted:${done.adjustmentId}`,
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
