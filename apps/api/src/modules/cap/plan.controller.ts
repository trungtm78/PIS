import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapPlanReads, CapPlanStore, PLAN_KINDS, PLAN_STATUSES, TenantDatabase, planReadScope, projectScope } from '@machvon/db';
import type { DraftResult, LineInput, PlanKind, PlanStatus } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { lineView, planProjectView, planView } from './plan-view';
import { CAP_METRICS } from './tokens';

const RESOURCE_TYPE = 'capital_plan';
const DRAFT_PERMISSION = PERMISSIONS.draftCapitalAllocation;
const CREATE_PERMISSION = PERMISSIONS.createCapitalPlan;
const LINES_PERMISSION = PERMISSIONS.listCapitalPlanLines;
const PLAN_VERSION_PERMISSION = PERMISSIONS.get_resources_plan_version;
const ALLOCATION_LINE_PERMISSION = PERMISSIONS.get_resources_allocation_line;
const PLAN_YEAR = /^\d{4}$/;
const PLAN_KIND_VALUES: readonly string[] = PLAN_KINDS;
const PLAN_STATUS_VALUES: readonly string[] = PLAN_STATUSES;
const REASON_MAX = 2000;
/** The draft commands count what refused them: a lost race is the normal outcome of two planners on one ceiling, and worth seeing. */
const CONFLICT_METRIC = 'cap_allocation_conflict_total';
const DRAFT_LATENCY_METRIC = 'cap_draft_latency_ms';
const COUNTED_REFUSALS: readonly string[] = ['VERSION_CONFLICT', 'APPROPRIATION_EXCEEDED', 'PLAN_NOT_DRAFT'];

/** Whether a grant that carries the permission has a scope that contains the unit. */
function reaches(access: EffectiveAccess, permission: string, unit: { id: string; path: string }, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), permission);
}

function lineOf(line: Schemas['CapAllocationLineInput']): LineInput {
  return {
    projectId: line.project_id,
    appropriationId: line.appropriation_id,
    bucket: line.bucket,
    sourceYear: line.source_year,
    amountVnd: line.amount_vnd,
    ctmtqgSubsetVnd: line.ctmtqg_subset_vnd,
    programMasterVersionId: line.program_master_version_id,
    previousLineId: line.previous_line_id,
  };
}

/** The audit row of a draft: what was stored (lower-case ids, whole amounts), line by line, and where each ceiling stood before and after. */
function draftDiff(expectedVersion: number, result: DraftResult): Record<string, unknown> {
  return {
    plan_version_before: expectedVersion,
    plan_version_after: result.version,
    changes: result.changes.map((change) => ({
      kind: change.kind,
      line_id: change.lineId,
      project_id: change.projectId,
      appropriation_id: change.appropriationId,
      bucket: change.bucket,
      source_year: change.sourceYear,
      from_vnd: change.fromVnd,
      to_vnd: change.toVnd,
      ctmtqg_from_vnd: change.ctmtqgFromVnd,
      ctmtqg_to_vnd: change.ctmtqgToVnd,
    })),
    appropriations: result.appropriations.map((move) => ({
      appropriation_id: move.id,
      amount_vnd: move.amountVnd,
      allocated_before_vnd: move.allocatedBeforeVnd,
      allocated_after_vnd: move.allocatedAfterVnd,
    })),
  };
}

/**
 * The drafting of the capital plan (ST-CAP-002, CAP 3.1 F2): a planner creates a plan revision and proposes lines for projects, each drawn on
 * one appropriation. A line never takes more than the appropriation has left, however many planners draft at the same moment; a line is for a
 * project in the scope of the planner (a project outside it does not exist for them). Status, approver and the allocated total are written by
 * no body: the plan starts as a DRAFT and the later commands (submit, decide, publish) move it.
 */
@Controller()
export class CapitalPlanController {
  private readonly plans = new CapPlanStore();
  private readonly metrics: MetricsSink;

  constructor(@Optional() @Inject(CAP_METRICS) metrics?: MetricsSink) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('capital-plans')
  @HttpCode(200)
  @OperationId('createCapitalPlan')
  @Command({ operation: 'createCapitalPlan' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapCapitalPlanCreate']): Promise<CommandResult> {
    const now = new Date();
    const created = await this.plans.createPlan(
      scope.tx,
      {
        planCode: body.plan_code,
        planKind: body.plan_kind,
        planYear: body.plan_year,
        periodFromYear: body.period_from_year,
        periodToYear: body.period_to_year,
        scopeUnitId: body.scope_unit_id,
      },
      scope.tenant.membershipId,
      (unit) => {
        if (!reaches(access, CREATE_PERMISSION, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
      },
    );
    await scope.audit({
      action: 'capital.plan_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: {
        plan_code: created.planCode,
        plan_kind: created.planKind,
        plan_year: created.planYear,
        period_from_year: created.periodFromYear,
        period_to_year: created.periodToYear,
        scope_unit_id: created.scopeUnitId,
        revision: created.revision,
      },
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('capital-plans/:id/allocations')
  @HttpCode(200)
  @OperationId('draftCapitalAllocation')
  @Command({ operation: 'draftCapitalAllocation', versioned: true, ttl: 'extended' })
  async draft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapAllocationDraft']): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const note = body.note?.trim();
    if (note !== undefined && note.length > REASON_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const started = performance.now();
    let result: DraftResult;
    try {
      result = await this.plans.draft(
        scope.tx,
        id,
        expected,
        { lines: body.lines.map(lineOf), removeLineIds: body.remove_line_ids },
        scope.tenant.membershipId,
        { write: projectScope(access, DRAFT_PERMISSION, now), read: planReadScope(access, LINES_PERMISSION, now) },
      );
    } catch (error) {
      if (error instanceof DomainError && COUNTED_REFUSALS.includes(error.code)) this.metrics.increment(CONFLICT_METRIC, { code: error.code });
      throw error;
    }
    this.metrics.gauge(DRAFT_LATENCY_METRIC, Math.round(performance.now() - started), { outcome: result.changes.length === 0 ? 'unchanged' : 'changed' });
    // A request that changes nothing is recorded as such and leaves the version of the plan and the ceilings as they were.
    await scope.audit({
      action: result.changes.length === 0 ? 'capital.plan_allocation_unchanged' : 'capital.plan_allocation_drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      ...(note === undefined || note === '' ? {} : { reason: note }),
      diff: draftDiff(expected, result),
    });
    return commandResult(scope, result.status, result.version, id);
  }
}

function filterOf(planKind: unknown, status: unknown, planYear: unknown): { planKind?: PlanKind; status?: PlanStatus; planYear?: number } {
  if (planKind !== undefined && (typeof planKind !== 'string' || !PLAN_KIND_VALUES.includes(planKind))) throw new DomainError('VALIDATION_FAILED', 422, 'plan_kind');
  if (status !== undefined && (typeof status !== 'string' || !PLAN_STATUS_VALUES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  if (planYear !== undefined && (typeof planYear !== 'string' || !PLAN_YEAR.test(planYear))) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
  return {
    ...(planKind === undefined ? {} : { planKind: planKind as PlanKind }),
    ...(status === undefined ? {} : { status: status as PlanStatus }),
    ...(planYear === undefined ? {} : { planYear: Number(planYear) }),
  };
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/** The lines of one plan revision for the planning screens (CAP-02, CAP-03, CAP-06): the header, the lines of the projects the caller may see, and their total. */
@Controller('capital-plans')
export class CapitalPlanLinesController {
  private readonly reads = new CapPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get(':id/lines')
  @OperationId('listCapitalPlanLines')
  async lines(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('project_id') projectId?: unknown,
    @Query('fund_source_version_id') fundSourceVersionId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter = { capitalPlanId: id, projectId: optionalUuid(projectId, 'project_id'), fundSourceVersionId: optionalUuid(fundSourceVersionId, 'fund_source_version_id') };
    const now = new Date();
    const scope = planReadScope(access, LINES_PERMISSION, now);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const plan = await this.reads.findPlan(tx, id, scope);
      if (plan === undefined) return undefined;
      const rows = await this.reads.listLines(tx, filter, scope, { limit: request.limit + 1, after: request.after });
      const totals = await this.reads.lineTotals(tx, filter, scope);
      return { plan, rows, totals };
    });
    // A plan of another tenant, or a revision in work the caller does not draft or approve, is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const shown = found.rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      plan: planView(found.plan),
      items: shown.map(lineView),
      totals: { line_count: found.totals.lineCount, allocated_vnd: found.totals.allocatedVnd, ctmtqg_subset_vnd: found.totals.ctmtqgSubsetVnd },
      next_cursor: found.rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}

/**
 * The plan revisions (the scaffold read of the plan version): CAP-01 lists them, CAP-03 opens one. A revision in work is shown to the people
 * who draft and approve plans only; the totals are those of the lines in the scope of the caller.
 */
@Controller('resources/plan_version')
export class PlanVersionReadsController {
  private readonly reads = new CapPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_plan_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('plan_kind') planKind?: unknown,
    @Query('status') status?: unknown,
    @Query('plan_year') planYear?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf(planKind, status, planYear);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.listPlans(tx, planReadScope(access, PLAN_VERSION_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(planView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_plan_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const scope = planReadScope(access, PLAN_VERSION_PERMISSION, new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const plan = await this.reads.findPlan(tx, id, scope);
      return plan === undefined ? undefined : { plan, projects: await this.reads.planProjects(tx, id, scope) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...planView(found.plan), projects: found.projects.map(planProjectView) };
  }
}

/** The lines across plans (the scaffold read of the allocation line); the planning screens read the lines of one plan through `listCapitalPlanLines`. */
@Controller('resources/allocation_line')
export class AllocationLineReadsController {
  private readonly reads = new CapPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_allocation_line')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.listLines(tx, {}, planReadScope(access, ALLOCATION_LINE_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(lineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_allocation_line_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.reads.findLine(tx, id, planReadScope(access, ALLOCATION_LINE_PERMISSION, new Date())));
    // A line of another tenant, outside the scope of the caller or in a revision in work that the caller does not see does not exist for them.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return lineView(found);
  }
}
