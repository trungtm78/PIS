import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapScheduleStore, SCHEDULE_GRAINS, SCHEDULE_KINDS, TenantDatabase, projectScope } from '@machvon/db';
import type { ScheduleFilter, ScheduleGrain, ScheduleKind, ScheduleRegistered, ScheduleRow } from '@machvon/db';
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
import { scheduleRegisteredEvent } from './schedule-events';

const RESOURCE_TYPE = 'disbursement_schedule_line';
const REGISTER_PERMISSION = PERMISSIONS.registerDisbursementSchedule;
const LIST_PERMISSION = PERMISSIONS.listDisbursementSchedules;
const REASON_MAX = 2000;
const PLAN_YEAR = /^\d{4}$/;
const MONTH = /^\d{1,2}$/;
const KIND_VALUES: readonly string[] = SCHEDULE_KINDS;
const GRAIN_VALUES: readonly string[] = SCHEDULE_GRAINS;

/** A registration as the screens read it: the project it is for, the key, the amounts, and for a monthly registration the paid and the rate. */
export function scheduleView(row: ScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    project: row.project,
    allocation_line_id: row.allocationLineId,
    plan_year: row.planYear,
    granularity: row.granularity,
    month: row.month,
    period: row.period,
    bucket: row.bucket,
    budget_level: row.budgetLevel,
    kind: row.kind,
    amount_vnd: row.amountVnd,
    ctmtqg_subset_vnd: row.ctmtqgSubsetVnd,
    assumption: row.assumption,
    revision: row.revision,
    is_current: row.isCurrent,
    supersedes_id: row.supersedesId,
    achievement: row.achievement === null ? null : { disbursed_vnd: row.achievement.disbursedVnd, rate: row.achievement.rate },
  };
}

function auditDiff(created: ScheduleRegistered): Record<string, unknown> {
  return {
    project_id: created.projectId,
    plan_year: created.planYear,
    granularity: created.granularity,
    month: created.month,
    period_id: created.periodId,
    kind: created.kind,
    bucket: created.bucket,
    budget_level: created.budgetLevel,
    amount_vnd_before: created.previousAmountVnd,
    amount_vnd_after: created.amountVnd,
    ctmtqg_subset_vnd: created.ctmtqgSubsetVnd,
    revision: created.revision,
    supersedes_id: created.supersedesId,
  };
}

function filterOf(query: Record<string, unknown>): ScheduleFilter {
  const text = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
    return value;
  };
  const projectId = text('project_id');
  const planYear = text('plan_year');
  const kind = text('kind');
  const granularity = text('granularity');
  const month = text('month');
  const history = text('history');
  if (projectId !== undefined && asUuid(projectId) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
  if (planYear !== undefined && !PLAN_YEAR.test(planYear)) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
  if (kind !== undefined && !KIND_VALUES.includes(kind)) throw new DomainError('VALIDATION_FAILED', 422, 'kind');
  if (granularity !== undefined && !GRAIN_VALUES.includes(granularity)) throw new DomainError('VALIDATION_FAILED', 422, 'granularity');
  if (month !== undefined && (!MONTH.test(month) || Number(month) < 1 || Number(month) > 13)) throw new DomainError('VALIDATION_FAILED', 422, 'month');
  if (history !== undefined && history !== 'true' && history !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'history');
  return {
    ...(projectId === undefined ? {} : { projectId: asUuid(projectId) as string }),
    ...(planYear === undefined ? {} : { planYear: Number(planYear) }),
    ...(kind === undefined ? {} : { kind: kind as ScheduleKind }),
    ...(granularity === undefined ? {} : { granularity: granularity as ScheduleGrain }),
    ...(month === undefined ? {} : { month: Number(month) }),
    ...(history === 'true' ? { history: true } : {}),
  };
}

/**
 * The disbursement schedule (ST-CAP-009, CAP 3.1 F7, BR-CAP-08): an investor registers next month's disbursement per project and source group
 * (CTMTQG as a subset of it), and a forecast or a weekly commitment the same way. A registration is a promise: it is compared with what the
 * Treasury paid and never added to it. Registering again replaces the current row with a new revision.
 */
@Controller('disbursement-schedules')
export class DisbursementScheduleController {
  private readonly schedules = new CapScheduleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post()
  @HttpCode(200)
  @OperationId('registerDisbursementSchedule')
  @Command({ operation: 'registerDisbursementSchedule', versioned: false })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapScheduleInput']): Promise<CommandResult> {
    const now = new Date();
    const reason = body.revision_reason?.trim();
    if (reason !== undefined && reason.length > REASON_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'revision_reason');
    const created = await this.schedules.register(
      scope.tx,
      {
        projectId: body.project_id,
        allocationLineId: body.allocation_line_id,
        planYear: body.plan_year,
        granularity: body.granularity,
        periodId: body.period_id,
        month: body.month,
        kind: body.kind,
        bucket: body.bucket,
        budgetLevel: body.budget_level,
        amountVnd: body.amount_vnd,
        ctmtqgSubsetVnd: body.ctmtqg_subset_vnd,
        assumption: body.assumption,
      },
      scope.tenant.membershipId,
      projectScope(access, REGISTER_PERMISSION, now),
      now,
    );
    await scope.audit({ action: 'capital.schedule_registered', resourceType: RESOURCE_TYPE, resourceId: created.id, ...(reason === undefined || reason === '' ? {} : { reason }), diff: auditDiff(created) });
    await scope.emit(scheduleRegisteredEvent(scope.tenant.tenantId, scope.tenant.membershipId, created, now));
    return commandResult(scope, 'CURRENT', created.version, created.id);
  }

  @Get()
  @OperationId('listDisbursementSchedules')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query() query: Record<string, unknown>,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(query.limit, query.cursor);
    const filter = filterOf(query);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.schedules.list(tx, filter, projectScope(access, LIST_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(scheduleView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
