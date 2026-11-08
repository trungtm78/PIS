import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, BidWorkflowStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BidWorkflowFilter, BidWorkflowPackageRow, BidWorkflowResult } from '@machvon/db';
import { DomainError, asUuid, csvOf, isTreeNodeId, isWorkflowDay, isWorkflowMethod, message, vietnamDateOf, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, ExportColumn, ExportDocument, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { detailDto, entryDto, peopleOf, rowDto, timelineDto, treeDto } from './workflow-view';

const RESOURCE_TYPE = 'package_workflow';
const CLASSIFICATION = 'INTERNAL';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv; charset=utf-8';
const READ = PERMISSIONS.getPackageWorkflow;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

// ---- the query, judged ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A query value that must be one string or absent (`?a=1&a=2` and `?a[x]=1` are refused). */
function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(field);
  return value;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw invalid(field);
  return value === 'true';
}

function uuid(value: unknown, field: string): string | undefined {
  const raw = text(value, field);
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id.toLowerCase();
}

function day(value: unknown, field: string): string | undefined {
  const raw = text(value, field);
  if (raw !== undefined && !isWorkflowDay(raw)) throw invalid(field);
  return raw;
}

/** The filters every read shares; an unknown method or a malformed id is 422 naming the field. */
export function filterOf(query: Record<string, unknown>): BidWorkflowFilter {
  const method = text(query.method, 'method');
  if (method !== undefined && !isWorkflowMethod(method)) throw invalid('method');
  const q = text(query.q, 'q');
  if (q !== undefined && q.length > 100) throw invalid('q');
  return { unitId: uuid(query.unit_id, 'unit_id'), projectId: uuid(query.project_id, 'project_id'), method, ownerId: uuid(query.owner_id, 'owner_id'), lateOnly: flag(query.late_only, 'late_only'), q };
}

function periodOf(query: Record<string, unknown>, now: Date): { from: string; to: string } {
  const fallback = BidWorkflowReads.defaultPeriod(now);
  return { from: day(query.from, 'from') ?? fallback.from, to: day(query.to, 'to') ?? fallback.to };
}

const byCode = (left: BidWorkflowPackageRow, right: BidWorkflowPackageRow): number => (left.packageCode < right.packageCode ? -1 : left.packageCode > right.packageCode ? 1 : left.packageId < right.packageId ? -1 : left.packageId > right.packageId ? 1 : 0);

/** A page of rows in the order of their code, after the anchor of the cursor; the cursor is the code and id of the last row. */
function pageOf(rows: readonly BidWorkflowPackageRow[], limit: unknown, cursor: unknown): { page: BidWorkflowPackageRow[]; next: string | null } {
  const request = parsePageRequest(limit, cursor);
  const sorted = [...rows].sort(byCode);
  const after = request.after;
  const rest = after === undefined ? sorted : sorted.filter((row) => row.packageCode > after.code || (row.packageCode === after.code && row.packageId > after.id));
  const page = rest.slice(0, request.limit);
  const last = page[page.length - 1];
  return { page, next: rest.length > page.length && last !== undefined ? encodeCursor({ code: last.packageCode, id: last.packageId }) : null };
}

const COLUMNS: readonly ExportColumn[] = [
  { key: 'method', label: message('bid.workflow.export.column.method'), numeric: false },
  { key: 'step_code', label: message('bid.workflow.export.column.step_code'), numeric: false },
  { key: 'step_name', label: message('bid.workflow.export.column.step_name'), numeric: false },
  { key: 'completed_visits', label: message('bid.workflow.export.column.completed_visits'), numeric: true },
  { key: 'median_days', label: message('bid.workflow.export.column.median_days'), numeric: true },
  { key: 'basis', label: message('bid.workflow.export.column.basis'), numeric: false },
  { key: 'on_time_share_pct', label: message('bid.workflow.export.column.on_time_share_pct'), numeric: true },
  { key: 'open_visits', label: message('bid.workflow.export.column.open_visits'), numeric: true },
  { key: 'over_standard', label: message('bid.workflow.export.column.over_standard'), numeric: true },
];

/**
 * The commands on the workflow of a procurement package (PRC-1, BID 3 F11): start it, complete the items of the checklist with evidence, move the package on, back, on hold or off hold, give it an owner, ask for and decide an
 * exception, cancel it. Every command is audited (ADM-11) and announced in the outbox with ids, codes and days only, never the words of a person; the reason of a move is in the history the timeline reads.
 */
@Controller()
export class PackageWorkflowController {
  private readonly store = new BidWorkflowStore();

  @Post('procurement-packages/:package_id/workflow')
  @HttpCode(200)
  @OperationId('startPackageWorkflow')
  @Command({ operation: 'startPackageWorkflow' })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('package_id', ParseUUIDPipe) packageId: string, @Body() body: Schemas['PackageWorkflowStart']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.start(scope.tx, { packageId, ownerId: body.owner_id }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.startPackageWorkflow, now), now);
    await this.written(scope, done, 'workflow.started', 'bid.workflow.started.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-checklist-items/:item_id/completion')
  @HttpCode(200)
  @OperationId('completePackageChecklistItem')
  @Command({ operation: 'completePackageChecklistItem' })
  async complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('item_id', ParseUUIDPipe) itemId: string, @Body() body: Schemas['PackageChecklistCompletion']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.completeItem(
      scope.tx,
      itemId,
      { evidence: body.evidence.map((one) => ({ kind: one.kind, documentId: one.document_id, milestoneId: one.milestone_id, externalRef: one.external_ref, note: one.note })), note: body.note },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.completePackageChecklistItem, now),
      now,
    );
    await this.written(scope, done, 'workflow.item_completed', 'bid.workflow.item_completed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-checklist-items/:item_id/owner')
  @HttpCode(200)
  @OperationId('assignPackageChecklistItem')
  @Command({ operation: 'assignPackageChecklistItem' })
  async assignItem(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('item_id', ParseUUIDPipe) itemId: string, @Body() body: Schemas['PackageChecklistOwnerAssign']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.assignItem(scope.tx, itemId, { ownerId: body.owner_id }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.assignPackageChecklistItem, now), now);
    await this.written(scope, done, 'workflow.item_assigned', 'bid.workflow.item_assigned.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/advance')
  @HttpCode(200)
  @OperationId('advancePackageStep')
  @Command({ operation: 'advancePackageStep', versioned: true })
  async advance(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageStepAdvance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.advance(scope.tx, id, scope.expectedVersion ?? 0, { note: body.note, exceptionId: body.exception_id }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.advancePackageStep, now), now);
    await this.written(scope, done, done.status === 'COMPLETED' ? 'workflow.completed' : 'workflow.step_advanced', done.status === 'COMPLETED' ? 'bid.workflow.completed.v1' : 'bid.workflow.step_advanced.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/return')
  @HttpCode(200)
  @OperationId('returnPackageStep')
  @Command({ operation: 'returnPackageStep', versioned: true })
  async returnStep(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageStepReturn']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.returnStep(scope.tx, id, scope.expectedVersion ?? 0, { toStep: body.to_step, reason: body.reason }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.returnPackageStep, now), now);
    await this.written(scope, done, 'workflow.step_returned', 'bid.workflow.step_returned.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/hold')
  @HttpCode(200)
  @OperationId('holdPackageWorkflow')
  @Command({ operation: 'holdPackageWorkflow', versioned: true })
  async hold(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageWorkflowHold']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.hold(scope.tx, id, scope.expectedVersion ?? 0, { reason: body.reason }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.holdPackageWorkflow, now), now);
    await this.written(scope, done, 'workflow.held', 'bid.workflow.held.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/resume')
  @HttpCode(200)
  @OperationId('resumePackageWorkflow')
  @Command({ operation: 'resumePackageWorkflow', versioned: true })
  async resume(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageWorkflowResume']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.resume(scope.tx, id, scope.expectedVersion ?? 0, { note: body.note }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.resumePackageWorkflow, now), now);
    await this.written(scope, done, 'workflow.resumed', 'bid.workflow.resumed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/owner')
  @HttpCode(200)
  @OperationId('assignPackageWorkflowOwner')
  @Command({ operation: 'assignPackageWorkflowOwner', versioned: true })
  async assignOwner(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageWorkflowOwnerAssign']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.assignOwner(scope.tx, id, scope.expectedVersion ?? 0, { ownerId: body.owner_id, reason: body.reason }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.assignPackageWorkflowOwner, now), now);
    await this.written(scope, done, 'workflow.owner_assigned', 'bid.workflow.owner_assigned.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('package-workflows/:workflow_id/exceptions')
  @HttpCode(200)
  @OperationId('requestPackageStepException')
  @Command({ operation: 'requestPackageStepException' })
  async requestException(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageStepExceptionRequest']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.requestException(scope.tx, id, { kind: body.kind, reason: body.reason }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.requestPackageStepException, now), now);
    await this.written(scope, done, 'workflow.exception_requested', 'bid.workflow.exception_requested.v1', now, body.reason);
    return { ...commandResult(scope, done.status, done.version, done.exceptionId) };
  }

  @Post('package-step-exceptions/:exception_id/decision')
  @HttpCode(200)
  @OperationId('decidePackageStepException')
  @Command({ operation: 'decidePackageStepException' })
  async decideException(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('exception_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageStepExceptionDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.decideException(scope.tx, id, { decision: body.decision, note: body.note }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.decidePackageStepException, now), now);
    await this.written(scope, done, 'workflow.exception_decided', 'bid.workflow.exception_decided.v1', now, body.note);
    return commandResult(scope, done.status, done.version, done.exceptionId);
  }

  @Post('package-workflows/:workflow_id/cancel')
  @HttpCode(200)
  @OperationId('cancelPackageWorkflow')
  @Command({ operation: 'cancelPackageWorkflow', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflow_id', ParseUUIDPipe) id: string, @Body() body: Schemas['PackageWorkflowCancel']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.cancel(scope.tx, id, scope.expectedVersion ?? 0, { reason: body.reason }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.cancelPackageWorkflow, now), now);
    await this.written(scope, done, 'workflow.cancelled', 'bid.workflow.cancelled.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, codes, steps, days and statuses, never the name of a person. The reason goes to the audit row's reason field only (ADM-11), not to the event. */
  private async written(scope: CommandScope, done: BidWorkflowResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
    const facts = { package_id: done.packageId, package_code: done.packageCode, project_id: done.projectId, method: done.method, from_step: done.fromStep, to_step: done.toStep, visit: done.visit, ...done.facts };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, workflow_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}:${type}`,
    });
  }
}

/** The reads of PRC-1: the process tree and its nodes, the board, the list, the package page and its timeline, the statistics and the export, the summary of the dashboard card. All scoped by `bid.read`; the caller's own commands are told in `actions`. */
@Controller()
export class PackageWorkflowReadsController {
  private readonly reads = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('procurement-packages/:package_id/workflow')
  @OperationId('getPackageWorkflow')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('package_id', ParseUUIDPipe) packageId: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const detail = await this.reads.detail(tx, packageId, projectScope(access, READ, now), now);
      const names = await this.reads.names(tx, peopleOf(detail));
      return detailDto(detail, access, names, now);
    });
  }

  @Get('procurement-packages/:package_id/workflow/timeline')
  @OperationId('getPackageWorkflowTimeline')
  async timeline(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('package_id', ParseUUIDPipe) packageId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const order = text(query.order, 'order');
    if (order !== undefined && order !== 'newest' && order !== 'oldest') throw invalid('order');
    const fromDay = day(query.from, 'from');
    const toDay = day(query.to, 'to');
    if (fromDay !== undefined && toDay !== undefined && toDay < fromDay) throw invalid('to');
    return this.database.withTenant(tenant, async (tx) => {
      const result = await this.reads.timeline(tx, packageId, { fromDay, toDay, actor: uuid(query.actor_id, 'actor_id'), onlyStateChanges: flag(query.only_state_changes, 'only_state_changes'), oldestFirst: order === 'oldest' }, projectScope(access, READ, now), now);
      const names = await this.reads.names(tx, result.entries.map((entry) => entry.actor));
      return timelineDto(result, names);
    });
  }

  @Get('package-workflows')
  @OperationId('listPackageWorkflows')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter = filterOf(query);
    const step = text(query.step, 'step');
    if (step !== undefined && !/^[A-Z][A-Z0-9_]{1,39}$/.test(step)) throw invalid('step');
    const onHold = flag(query.on_hold, 'on_hold');
    const noOwner = flag(query.no_owner, 'no_owner');
    const request = parsePageRequest(query.limit, query.cursor);
    const loaded = await this.database.withTenant(tenant, (tx) => this.reads.packages(tx, filter, projectScope(access, READ, now), now));
    const kept = loaded.rows.filter((row) => {
      if (step !== undefined) {
        const terminal = step === 'NOT_STARTED' || step === 'COMPLETED' || step === 'CANCELLED';
        if (terminal ? row.status !== step : !((row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD') && row.currentStep === step)) return false;
      }
      if (onHold === true && row.status !== 'ON_HOLD') return false;
      if (noOwner === true && !(row.workflowId !== null && row.ownerId === null && (row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD'))) return false;
      return true;
    });
    const { page, next } = pageOf(kept, String(request.limit), query.cursor);
    const withSparks = await this.database.withTenant(tenant, (tx) => this.reads.withSparklines(tx, page, vietnamDateOf(now)));
    return { items: withSparks.map((row) => rowDto(row, access, now)), next_cursor: next, truncated: loaded.truncated, as_of: loaded.asOf };
  }

  @Get('package-workflows/board')
  @OperationId('getPackageWorkflowBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter = filterOf(query);
    const board = await this.database.withTenant(tenant, (tx) => this.reads.board(tx, filter.method, filter, projectScope(access, READ, now), now));
    return {
      method: board.method,
      method_name: board.methodName,
      methods: board.methods,
      columns: board.columns.map((column) => ({ code: column.code, name: column.name, order: column.order, kind: column.kind, standard_working_days: column.standardWorkingDays, count: column.count, value_vnd: column.valueVnd, late_count: column.lateCount, held_count: column.heldCount, cards: column.cards.map((card) => rowDto(card, access, now)) })),
      truncated: board.truncated,
      as_of: board.asOf,
    };
  }

  @Get('package-workflows/process-tree')
  @OperationId('getPackageProcessTree')
  async tree(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter = filterOf(query);
    const period = periodOf(query, now);
    return this.database.withTenant(tenant, async (tx) => {
      const scope = projectScope(access, READ, now);
      const built = await this.reads.tree(tx, filter, period, scope, now);
      const root = built.tree.nodes.find((node) => node.id === 'ROOT');
      const summary = await this.reads.summary(tx, filter, scope, now);
      return treeDto(built.tree, { truncated: built.truncated, asOf: built.asOf, running: summary.running, late: summary.late, stalled: summary.stalled, onHold: summary.onHold, noOwner: summary.noOwner, medianDays: root?.medianDays ?? null });
    });
  }

  @Get('package-workflows/process-tree/node')
  @OperationId('getPackageProcessTreeNode')
  async node(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const nodeId = nodeOf(query.node_id);
    const filter = filterOf(query);
    const overview = await this.database.withTenant(tenant, (tx) => this.reads.nodeOverview(tx, nodeId, filter, projectScope(access, READ, now), now));
    return {
      node_id: overview.nodeId,
      count: overview.count,
      median_days: overview.medianDays,
      longest_days: overview.longestDays,
      shortest_days: overview.shortestDays,
      basis: overview.basis,
      late_count: overview.lateCount,
      stalled_count: overview.stalledCount,
      held_count: overview.heldCount,
      no_owner_count: overview.noOwnerCount,
      top_owners: overview.topOwners,
      unfinished_items: overview.unfinishedItems.map((one) => ({ step_code: one.stepCode, item_code: one.itemCode, name: one.name, count: one.count })),
      weeks: overview.weeks.map((one) => ({ week_of: one.weekOf, arrivals: one.arrivals, departures: one.departures })),
      truncated: overview.truncated,
      as_of: overview.asOf,
    };
  }

  @Get('package-workflows/process-tree/packages')
  @OperationId('listPackageProcessTreeNodePackages')
  async nodePackages(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const nodeId = nodeOf(query.node_id);
    const filter = filterOf(query);
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const inside = await this.reads.nodePackages(tx, nodeId, filter, projectScope(access, READ, now), now);
      const { page, next } = pageOf(inside.rows, String(request.limit), query.cursor);
      const withSparks = await this.reads.withSparklines(tx, page, vietnamDateOf(now));
      return { items: withSparks.map((row) => rowDto(row, access, now)), next_cursor: next, truncated: inside.truncated, as_of: inside.asOf };
    });
  }

  @Get('package-workflows/process-tree/feed')
  @OperationId('getPackageProcessTreeNodeFeed')
  async feed(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const nodeId = nodeOf(query.node_id);
    const filter = filterOf(query);
    const fromDay = day(query.from, 'from');
    const toDay = day(query.to, 'to');
    if (fromDay !== undefined && toDay !== undefined && toDay < fromDay) throw invalid('to');
    const limitText = text(query.limit, 'limit');
    const limit = limitText === undefined ? 30 : /^[1-9][0-9]{0,2}$/.test(limitText) && Number(limitText) <= 200 ? Number(limitText) : -1;
    if (limit < 0) throw invalid('limit');
    const all = flag(query.all_entries, 'all_entries') === true;
    return this.database.withTenant(tenant, async (tx) => {
      const result = await this.reads.nodeFeed(tx, nodeId, filter, { fromDay, toDay }, limit, !all, projectScope(access, READ, now), now);
      const names = await this.reads.names(tx, result.entries.map((one) => one.entry.actor));
      return { items: result.entries.map((one) => ({ package_id: one.packageId, package_code: one.packageCode, entry: entryDto(one.entry, names) })), truncated: result.truncated, as_of: result.asOf };
    });
  }

  @Get('package-workflows/statistics')
  @OperationId('getPackageWorkflowStatistics')
  async statistics(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const stats = await this.database.withTenant(tenant, (tx) => this.reads.statistics(tx, filterOf(query), periodOf(query, now), projectScope(access, READ, now), now));
    return {
      period: stats.period,
      steps: stats.steps.map((one) => ({ method: one.method, step_code: one.stepCode, step_name: one.stepName, completed_visits: one.completedVisits, median_days: one.medianDays, basis: one.basis, on_time_share: one.onTimeShare, open_visits: one.openVisits, over_standard: one.overStandard })),
      stuck: stats.stuck.map((one) => ({ package_id: one.packageId, package_code: one.packageCode, title: one.title, method: one.method, step_code: one.stepCode, step_name: one.stepName, days: one.days, basis: one.basis, value_vnd: one.valueVnd, owner_name: one.ownerName, late: one.late })),
      kpis: { on_time_share: stats.kpis.onTimeShare, completed_visits: stats.kpis.completedVisits, median_days: stats.kpis.medianDays, basis: stats.kpis.basis },
      truncated: stats.truncated,
      as_of: stats.asOf,
    };
  }

  @Get('package-workflows/statistics/export')
  @OperationId('exportPackageWorkflowReport')
  async export(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const format = text(query.format, 'format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw invalid('format');
    const period = periodOf(query, now);
    const stats = await this.database.withTenant(tenant, (tx) => this.reads.statistics(tx, filterOf(query), period, projectScope(access, READ, now), now));
    const document: ExportDocument = {
      title: message('bid.workflow.export.title'),
      header: [
        { key: 'period', label: message('bid.workflow.export.header.period'), value: message('bid.workflow.export.value.period', { from: period.from, to: period.to }) },
        { key: 'as_of', label: message('bid.workflow.export.header.as_of'), value: vietnamDateOf(now) },
        { key: 'median_days', label: message('bid.workflow.export.header.median_days'), value: stats.kpis.medianDays === null ? '' : String(stats.kpis.medianDays) },
        { key: 'on_time_share_pct', label: message('bid.workflow.export.header.on_time_share_pct'), value: stats.kpis.onTimeShare === null ? '' : String(Math.round(stats.kpis.onTimeShare * 10_000) / 100) },
        { key: 'formula', label: message('bid.workflow.export.header.formula'), value: message('bid.workflow.export.value.formula') },
        { key: 'source', label: message('bid.workflow.export.header.source'), value: message('bid.workflow.export.value.source') },
        ...(stats.truncated ? [{ key: 'truncated', label: message('bid.workflow.export.header.truncated'), value: message('bid.workflow.export.value.truncated') }] : []),
      ],
      columns: COLUMNS,
      rows: stats.steps.map((one) => [one.method, one.stepCode, one.stepName ?? '', String(one.completedVisits), one.medianDays === null ? '' : String(one.medianDays), one.basis, one.onTimeShare === null ? '' : String(Math.round(one.onTimeShare * 10_000) / 100), String(one.openVisits), String(one.overStandard)]),
      notice: message('bid.workflow.export.notice'),
    };
    const bytes = format === 'csv' ? Buffer.from(csvOf(document), 'utf8') : Buffer.from(xlsxOf(document));
    return {
      file_name: `tien-do-lua-chon-nha-thau-${period.from}-${period.to}.${format}`,
      content_type: format === 'csv' ? CSV_TYPE : XLSX_TYPE,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_base64: bytes.toString('base64'),
      as_of: stats.asOf,
    };
  }

  @Get('package-workflows/summary')
  @OperationId('getPackageWorkflowSummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const summary = await this.database.withTenant(tenant, (tx) => this.reads.summary(tx, filterOf(query), projectScope(access, READ, now), now));
    return {
      total: summary.total,
      running: summary.running,
      not_started: summary.notStarted,
      completed: summary.completed,
      late: summary.late,
      stalled: summary.stalled,
      on_hold: summary.onHold,
      no_owner: summary.noOwner,
      top_steps: summary.topSteps.map((one) => ({ node_id: one.nodeId, method: one.method, code: one.code, name: one.name, count: one.count, late_count: one.lateCount })),
      truncated: summary.truncated,
      as_of: summary.asOf,
    };
  }
}

function nodeOf(value: unknown): string {
  const raw = text(value, 'node_id');
  if (raw === undefined || !isTreeNodeId(raw)) throw invalid('node_id');
  return raw;
}

