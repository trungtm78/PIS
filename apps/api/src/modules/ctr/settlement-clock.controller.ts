import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CONTRACT_ADJUSTMENT_REVIEWED_EVENT, CONTRACT_ADJUSTMENT_RESOURCE, CtrAdjustmentStore, CtrLinkageReads, CtrSettlementClockStore, TenantDatabase, adjustmentRecord, contractScope } from '@machvon/db';
import type { AdjustmentRow, CtrLinkageView, SettlementClockRow, SettlementRuleReading } from '@machvon/db';
import { DomainError, SETTLEMENT_CLOCK_GROUPS } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { snakeKeys } from '../../snake-case';
import { CurrentTenant } from '../../tenant-context.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ['RUNNING', 'NEAR', 'OVERDUE', 'MET', 'MET_LATE'] as const;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const ruleView = (rule: SettlementRuleReading): Record<string, unknown> => ({
  version: rule.version,
  source: rule.source,
  unverified: rule.unverified,
  params: snakeKeys(rule.params),
  provenance: rule.provenance === null ? null : { formula: rule.provenance.formula, source: rule.provenance.source, as_of: rule.provenance.asOf, legal_status: rule.provenance.legalStatus },
});

export function clockRowView(row: SettlementClockRow): Record<string, unknown> {
  return {
    id: row.id,
    contract: row.contract,
    project: row.project,
    contractor: row.contractor,
    project_group: row.projectGroup,
    started_on: row.startedOn,
    months_allowed: row.monthsAllowed,
    due_on: row.dueOn,
    policy_version: row.policyVersion,
    state: row.state,
    days_left: row.daysLeft,
    met_on: row.metOn,
    settlement_id: row.settlementId,
  };
}

/** The totals of the clocks of the whole scope, never of the page; the in-time rate is the clocks handed in on time over all that were handed in (one decimal, half up). */
export function clockSummary(rows: readonly SettlementClockRow[]): Record<string, unknown> {
  const count = (state: SettlementClockRow['state']): number => rows.filter((row) => row.state === state).length;
  const met = count('MET');
  const late = count('MET_LATE');
  const handed = met + late;
  const scaled = handed === 0 ? 0 : Math.floor((met * 2000 + handed) / (2 * handed));
  return {
    total: rows.length,
    open: rows.length - handed,
    running: count('RUNNING'),
    near: count('NEAR'),
    overdue: count('OVERDUE'),
    met,
    met_late: late,
    in_time_rate_pct: handed === 0 ? null : `${Math.floor(scaled / 10)}.${scaled % 10}`,
    by_group: SETTLEMENT_CLOCK_GROUPS.map((group) => ({ group, total: rows.filter((row) => row.projectGroup === group).length, overdue: rows.filter((row) => row.projectGroup === group && row.state === 'OVERDUE').length })),
  };
}

export function adjustmentView(row: AdjustmentRow): Record<string, unknown> {
  return {
    id: row.id,
    revision_id: row.revisionId,
    revision: row.revision,
    change_request_id: row.changeRequestId,
    contract: row.contract,
    project: row.project,
    original_vnd: row.originalVnd,
    previous_vnd: row.previousVnd,
    new_vnd: row.newVnd,
    delta_vnd: row.deltaVnd,
    delta_pct_of_previous: row.deltaPctOfPrevious,
    cumulative_delta_vnd: row.cumulativeDeltaVnd,
    cumulative_pct_of_original: row.cumulativePctOfOriginal,
    baseline_version: row.baselineVersion,
    baseline_bac_vnd: row.baselineBacVnd,
    share_of_baseline_pct: row.shareOfBaselinePct,
    classification: row.classification,
    reasons: row.reasons,
    policy_version: row.policyVersion,
    made_by: row.madeBy,
    review_status: row.reviewStatus,
    review_decision: row.reviewDecision,
    reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt,
    review_note: row.reviewNote,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function linkageView(view: CtrLinkageView, now: Date): Record<string, unknown> {
  return {
    contract: snakeKeys(view.contract),
    project: view.project,
    package: view.package === null ? null : snakeKeys(view.package),
    contractor: view.contractor,
    award: view.award === null ? null : snakeKeys(view.award),
    parties: snakeKeys(view.parties),
    ok: view.reading.ok,
    award_gap_vnd: view.reading.awardGapVnd,
    findings: view.reading.findings,
    as_of: now.toISOString(),
  };
}

/**
 * The settlement clock of contracts, the linkage of a contract to its project, package and contractor, and the adjustment versions with their review (G1-18, CTR). Reads are in the scope of the caller; the review
 * of a version that changes the baseline is a command: audited, idempotent, with the version of the record, and never by the person who made the change.
 */
@Controller()
export class SettlementClockController {
  private readonly clocks = new CtrSettlementClockStore();
  private readonly adjustments = new CtrAdjustmentStore();
  private readonly linkage = new CtrLinkageReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contract-settlement-clocks')
  @OperationId('listContractSettlementClocks')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('state') state?: unknown, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    const now = new Date();
    if (state !== undefined && (typeof state !== 'string' || !(STATES as readonly string[]).includes(state))) throw invalid('state');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    const board = await this.database.withTenant(tenant, (tx) =>
      this.clocks.board(tx, contractScope(access, PERMISSIONS.listContractSettlementClocks, now), { state: state as SettlementClockRow['state'] | undefined, unitId: unitId === undefined ? undefined : (unitId as string).toLowerCase() }, now),
    );
    return { items: board.rows.map(clockRowView), summary: clockSummary(board.all), rule: ruleView(board.rule), truncated: board.truncated, as_of: now.toISOString() };
  }

  @Get('contracts/:id/linkage')
  @OperationId('getContractLinkage')
  async linked(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, (tx) => this.linkage.read(tx, contractScope(access, PERMISSIONS.getContractLinkage, now), id.toLowerCase()));
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return linkageView(view, now);
  }

  @Get('contracts/:id/adjustments')
  @OperationId('listContractAdjustments')
  async versions(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = await this.database.withTenant(tenant, async (tx) => {
      const scope = contractScope(access, PERMISSIONS.listContractAdjustments, now);
      const rows = await this.adjustments.ofContract(tx, scope, id.toLowerCase());
      // A contract without versions answers an empty list; a contract that does not exist, or is out of the scope of the caller, answers 404.
      if (rows.length === 0 && (await this.linkage.read(tx, scope, id.toLowerCase())) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return { rows, rule: await this.adjustments.policy(tx, now) };
    });
    return {
      items: read.rows.map(adjustmentView),
      rule: { version: read.rule.version, source: read.rule.source, unverified: read.rule.unverified, params: snakeKeys(read.rule.policy), provenance: read.rule.provenance === null ? null : { formula: read.rule.provenance.formula, source: read.rule.provenance.source, as_of: read.rule.provenance.asOf, legal_status: read.rule.provenance.legalStatus } },
      as_of: now.toISOString(),
    };
  }

  @Post('contract-adjustments/:id/review')
  @HttpCode(200)
  @OperationId('reviewContractAdjustment')
  @Command({ operation: 'reviewContractAdjustment', versioned: true })
  async review(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrAdjustmentReview']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.adjustments.review(scope.tx, contractScope(access, PERMISSIONS.reviewContractAdjustment, now), {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      decision: body.decision,
      note: body.note,
      actor: scope.tenant.membershipId,
      now,
    });
    await scope.audit({ ...adjustmentRecord('contract.adjustment_reviewed', done.row), classification: 'INTERNAL', reason: body.note });
    await scope.emit({
      aggregateType: CONTRACT_ADJUSTMENT_RESOURCE,
      aggregateId: done.row.id,
      aggregateVersion: done.row.version,
      type: CONTRACT_ADJUSTMENT_REVIEWED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, contract_id: done.row.contract.id, project_id: done.row.project.id, revision: done.row.revision, decision: done.row.reviewDecision, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CONTRACT_ADJUSTMENT_RESOURCE}:${done.row.id}:${done.row.version}:reviewed`,
    });
    return commandResult(scope, done.row.reviewStatus, done.row.version, done.row.id);
  }
}
