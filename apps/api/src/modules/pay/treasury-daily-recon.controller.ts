import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TREASURY_RECON_ITEM_RESOURCE, TenantDatabase, TreasuryDailyReconStore, projectScope, reconRunRecord } from '@machvon/db';
import type { DailyReconItemChange, ReconItemView, ReconLineView, ReconRunView } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, reconAddDays, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { PAY_METRICS } from './tokens';

const ASSIGNED_EVENT = 'pay.treasury_daily_recon.item_assigned.v1';
const RESOLVED_EVENT = 'pay.treasury_daily_recon.item_resolved.v1';
/** The longest range of days the screen may ask the state of at once. */
const MAX_DAYS = 62;

export function reconRunView(run: ReconRunView): Record<string, unknown> {
  return {
    id: run.id,
    recon_date: run.reconDate,
    run_no: run.runNo,
    status: run.status,
    partial_reason: run.partialReason,
    statement_imports: run.statementImports,
    transaction_count: run.transactionCount,
    line_count: run.lineCount,
    difference_line_count: run.differenceLineCount,
    opened_items: run.openedItems,
    cleared_items: run.clearedItems,
    books_total_vnd: run.booksTotalVnd,
    treasury_total_vnd: run.treasuryTotalVnd,
    rule: { version: run.ruleVersion, source: run.ruleSource, unverified: run.ruleUnverified, threshold_vnd: run.thresholdVnd, threshold_pct: run.thresholdPct, due_days: run.dueDays, partial_after_days: run.partialAfterDays },
    calendar_basis: run.calendarBasis,
    origin: run.origin,
    created_by: run.createdBy,
    created_at: run.createdAt,
  };
}

export function reconLineView(line: ReconLineView): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    project_code: line.projectCode,
    fund_key: line.fundKey,
    fund_label: line.fundLabel,
    books_vnd: line.booksVnd,
    treasury_vnd: line.treasuryVnd,
    difference_vnd: line.differenceVnd,
    books_count: line.booksCount,
    treasury_count: line.treasuryCount,
    kind: line.kind,
    opens_item: line.opensItem,
  };
}

/** An item as openapi.json exposes it (an allowlist). The buttons say which commands its state allows; the server judges each command again. */
export function reconItemView(item: ReconItemView): Record<string, unknown> {
  const waiting = item.status === 'OPEN' || item.status === 'EXPLAINED';
  return {
    id: item.id,
    project_id: item.projectId,
    project_code: item.projectCode,
    fund_key: item.fundKey,
    fund_label: item.fundLabel,
    recon_date: item.reconDate,
    kind: item.kind,
    status: item.status,
    books_vnd: item.booksVnd,
    treasury_vnd: item.treasuryVnd,
    difference_vnd: item.differenceVnd,
    latest_difference_vnd: item.latestDifferenceVnd,
    owner_membership_id: item.ownerMembershipId,
    owner_name: item.ownerName,
    due_on: item.dueOn,
    overdue: item.overdue,
    opened_run_id: item.openedRunId,
    last_run_id: item.lastRunId,
    cleared_run_id: item.clearedRunId,
    explained_by: item.explainedBy,
    resolution_note: item.resolutionNote,
    resolved_by: item.resolvedBy,
    resolved_at: item.resolvedAt,
    approval_document_version_id: item.approvalDocumentVersionId,
    issue_id: item.issueId,
    created_at: item.createdAt,
    version: item.version,
    actions: { assign: waiting, explain: item.status === 'OPEN', resolve: waiting, write_off: waiting },
  };
}

type ItemAnswer = Schemas['TreasuryDailyReconItemResult'];

function itemAnswer(scope: CommandScope, change: DailyReconItemChange): ItemAnswer {
  const { view } = change;
  return { ...commandResult(scope, view.status, view.version, view.id), resource_id: view.id, owner_membership_id: view.ownerMembershipId, due_on: view.dueOn, difference_vnd: view.latestDifferenceVnd };
}

/**
 * The daily reconciliation with the Treasury (G4-4, PAY): running a day by project code and fund, and the work on the items of difference it opens. A pass that finds the very lines of the latest pass of the day writes
 * nothing; a day whose statement is not in is PARTIAL and says so. The items are given an owner and a due day; a write-off asks for the document that approves it and for someone who is neither the owner, nor the person who
 * explained it, nor the one who opened it. The per-transaction items of `ReconciliationController` are not touched.
 */
@Controller()
export class TreasuryDailyReconController {
  private readonly store: TreasuryDailyReconStore;

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink) {
    this.store = new TreasuryDailyReconStore(metrics ?? NOOP_METRICS);
  }

  @Post('treasury-daily-recon/runs')
  @HttpCode(200)
  @OperationId('runTreasuryDailyRecon')
  @Command({ operation: 'runTreasuryDailyRecon' })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['TreasuryDailyReconRunRequest']): Promise<Schemas['TreasuryDailyReconRunResult']> {
    const now = new Date();
    // A pass holds the whole tenant: a person who sees only a part of the projects runs none.
    if (projectScope(access, PERMISSIONS.runTreasuryDailyRecon, now)(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    const outcome = await this.store.runDay(scope.tx, { day: body.recon_date, actor: scope.tenant.membershipId, now, origin: 'MANUAL', judgeMissing: true });
    const { run } = outcome;
    if (run === null) throw new Error('a manual pass always judges the day');
    const record = reconRunRecord({ ...outcome, run }, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit({ ...record.audit, diff: { ...record.audit.diff, reused: outcome.reused } });
    if (!outcome.reused) await scope.emit(record.event);
    await this.store.refreshGauges(scope.tx, now);
    return {
      ...commandResult(scope, run.status, run.runNo, run.id),
      resource_id: run.id,
      recon_date: run.reconDate,
      run_no: run.runNo,
      run_status: run.status,
      partial_reason: run.partialReason,
      reused: outcome.reused,
      line_count: run.lineCount,
      opened_items: outcome.reused ? 0 : outcome.openedItemIds.length,
      cleared_items: outcome.reused ? 0 : outcome.clearedItemIds.length,
    };
  }

  @Post('treasury-daily-recon/items/:id/assign')
  @HttpCode(200)
  @OperationId('assignTreasuryDailyReconItem')
  @Command({ operation: 'assignTreasuryDailyReconItem', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['TreasuryDailyReconAssignItem']): Promise<ItemAnswer> {
    const now = new Date();
    const change = await this.store.assign(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { ownerMembershipId: body.owner_membership_id, dueOn: body.due_on }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.assignTreasuryDailyReconItem, now), now);
    const { view } = change;
    const facts = { project_id: view.projectId, fund_key: view.fundKey, recon_date: view.reconDate, kind: view.kind, status: view.status, owner_membership_id: view.ownerMembershipId, due_on: view.dueOn, difference_vnd: view.latestDifferenceVnd };
    await scope.audit({ action: 'treasury_daily_recon_item.assigned', resourceType: TREASURY_RECON_ITEM_RESOURCE, resourceId: view.id, classification: 'CONFIDENTIAL', diff: { ...facts, from_owner_membership_id: change.fromOwnerMembershipId } });
    await scope.emit({
      aggregateType: TREASURY_RECON_ITEM_RESOURCE,
      aggregateId: view.id,
      aggregateVersion: view.version,
      type: ASSIGNED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, item_id: view.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${TREASURY_RECON_ITEM_RESOURCE}:${view.id}:${view.version}`,
    });
    return itemAnswer(scope, change);
  }

  @Post('treasury-daily-recon/items/:id/resolve')
  @HttpCode(200)
  @OperationId('resolveTreasuryDailyReconItem')
  @Command({ operation: 'resolveTreasuryDailyReconItem', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['TreasuryDailyReconResolveItem']): Promise<ItemAnswer> {
    const now = new Date();
    const change = await this.store.resolve(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { resolution: body.resolution, note: body.note, approvalDocumentVersionId: body.approval_document_version_id },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.resolveTreasuryDailyReconItem, now),
      now,
    );
    const { view } = change;
    const facts = {
      project_id: view.projectId,
      fund_key: view.fundKey,
      recon_date: view.reconDate,
      kind: view.kind,
      from_status: change.fromStatus,
      to_status: view.status,
      resolution: body.resolution,
      owner_membership_id: view.ownerMembershipId,
      books_vnd: view.booksVnd,
      treasury_vnd: view.treasuryVnd,
      difference_vnd: view.differenceVnd,
      approval_document_version_id: view.approvalDocumentVersionId,
    };
    // The words of the person stay in the audit row; the event carries identifiers and figures.
    await scope.audit({ action: 'treasury_daily_recon_item.resolved', resourceType: TREASURY_RECON_ITEM_RESOURCE, resourceId: view.id, classification: 'CONFIDENTIAL', reason: view.resolutionNote ?? undefined, diff: facts });
    await scope.emit({
      aggregateType: TREASURY_RECON_ITEM_RESOURCE,
      aggregateId: view.id,
      aggregateVersion: view.version,
      type: RESOLVED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, item_id: view.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${TREASURY_RECON_ITEM_RESOURCE}:${view.id}:${view.version}`,
    });
    return itemAnswer(scope, change);
  }
}

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};
const textFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};
const dayFilter = (value: unknown, field: string): string | undefined => {
  const text = textFilter(value, field);
  if (text !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text;
};

/** The passes and the items of the daily reconciliation (`treasury.daily_recon.read`), in the scope of the projects of the caller. */
@Controller()
export class TreasuryDailyReconReadsController {
  private readonly store = new TreasuryDailyReconStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('treasury-daily-recon/runs')
  @OperationId('listTreasuryDailyReconRuns')
  async runs(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('recon_date') reconDate?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const first = dayFilter(from, 'from');
    const last = dayFilter(to, 'to');
    if ((first === undefined) !== (last === undefined)) throw new DomainError('VALIDATION_FAILED', 422, first === undefined ? 'from' : 'to');
    if (first !== undefined && last !== undefined && (first > last || reconAddDays(first, MAX_DAYS) < last)) throw new DomainError('VALIDATION_FAILED', 422, 'to');
    const scope = projectScope(access, 'treasury.daily_recon.read', now);
    const answer = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.store.listRuns(tx, scope, { limit: request.limit + 1, after: request.after, status: textFilter(status, 'status'), reconDate: dayFilter(reconDate, 'recon_date') }),
      days: first === undefined || last === undefined ? undefined : await this.store.days(tx, first, last),
      rule: await this.store.rule(tx, vietnamDateOf(now)),
    }));
    const shown = answer.rows.slice(0, request.limit);
    const tail = shown[shown.length - 1];
    return {
      items: shown.map(reconRunView),
      next_cursor: answer.rows.length > request.limit && tail !== undefined ? encodeCursor({ code: tail.orderKey, id: tail.id }) : null,
      as_of: now.toISOString(),
      today: vietnamDateOf(now),
      rule: { version: answer.rule.version, source: answer.rule.source, unverified: answer.rule.unverified, threshold_vnd: String(answer.rule.policy.thresholdVnd), threshold_pct: answer.rule.policy.thresholdPct, due_days: answer.rule.policy.dueDays, partial_after_days: answer.rule.policy.partialAfterDays },
      ...(answer.days === undefined
        ? {}
        : {
            days: answer.days.map((day) => ({ recon_date: day.reconDate, status: day.status, partial_reason: day.partialReason, run_no: day.runNo, run_id: day.id })),
          }),
    };
  }

  @Get('treasury-daily-recon/runs/:id')
  @OperationId('getTreasuryDailyReconRun')
  async run(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.store.getRun(tx, projectScope(access, 'treasury.daily_recon.read', now), id));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...reconRunView(found.run), lines: found.lines.map(reconLineView), hidden_lines: found.hiddenLines, as_of: now.toISOString() };
  }

  @Get('treasury-daily-recon/items')
  @OperationId('listTreasuryDailyReconItems')
  async items(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('owner_membership_id') owner?: unknown,
    @Query('project_id') project?: unknown,
    @Query('recon_date') reconDate?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string; summary: Record<string, unknown> }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const scope = projectScope(access, 'treasury.daily_recon.read', now);
    const { rows, summary } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.store.listItems(
        tx,
        scope,
        { status: textFilter(status, 'status'), ownerMembershipId: idFilter(owner, 'owner_membership_id'), projectId: idFilter(project, 'project_id'), reconDate: dayFilter(reconDate, 'recon_date'), limit: request.limit + 1, after: request.after },
        now,
      ),
      summary: await this.store.summary(tx, scope, now),
    }));
    const shown = rows.slice(0, request.limit);
    const tail = shown[shown.length - 1];
    return {
      items: shown.map(reconItemView),
      next_cursor: rows.length > request.limit && tail !== undefined ? encodeCursor({ code: tail.dueOn, id: tail.id }) : null,
      as_of: now.toISOString(),
      summary: { waiting: summary.waiting, overdue: summary.overdue, waiting_difference_vnd: summary.waitingDifferenceVnd },
    };
  }

  @Get('treasury-daily-recon/items/:id')
  @OperationId('getTreasuryDailyReconItem')
  async item(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.store.findItem(tx, projectScope(access, 'treasury.daily_recon.read', now), id, now));
    // An item in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reconItemView(found);
  }
}
