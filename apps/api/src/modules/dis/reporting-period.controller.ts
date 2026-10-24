import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DIS_PERIOD_TRANSITION_METRIC, DisPeriodStore, PERIOD_RESOURCE, PERIOD_TYPES, periodMoveRecord, transitionLabels, TenantDatabase } from '@machvon/db';
import type { PeriodFilter, PeriodMove, PeriodReopenRow, PeriodRow, PeriodStatus, PeriodType } from '@machvon/db';
import { DomainError, NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const PERIOD_STATUSES: ReadonlySet<string> = new Set(['OPEN', 'SOFT_CLOSED', 'LOCKED']);
const PERIOD_TYPE_SET: ReadonlySet<string> = new Set(PERIOD_TYPES);
const YEAR = /^\d{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CALENDAR_CODE = 50;
const MIN_REASON = 5;

const reopenViewOf = (row: PeriodReopenRow): Record<string, unknown> => ({
  id: row.id,
  scope_kind: row.scopeKind,
  status: row.status,
  window_until: row.windowUntil,
  requested_at: row.requestedAt,
});

/** A period as the calendar shows it: its status is the one source of truth, `locked_at` follows it, and the history of reopening goes with it. */
function periodViewOf(row: PeriodRow, reopens: readonly PeriodReopenRow[]): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    calendar_code: row.calendarCode,
    period_type: row.periodType,
    fiscal_year: row.fiscalYear,
    start_date: row.startDate,
    end_date: row.endDate,
    deadline_at: row.deadlineAt,
    calendar_version: row.calendarRevision,
    calendar_version_id: row.calendarVersionId,
    status: row.status,
    soft_closed_at: row.softClosedAt,
    locked_at: row.lockedAt,
    locked_by: row.lockedBy,
    version: row.version,
    reopens: reopens.map(reopenViewOf),
  };
}

function reasonOf(value: string): string {
  const reason = value.trim();
  if (reason.length < MIN_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason;
}

function filterOf(query: Record<string, unknown>): PeriodFilter {
  const { fiscal_year: year, status, period_type: type, calendar_code: calendar } = query;
  if (year !== undefined && (typeof year !== 'string' || !YEAR.test(year))) throw new DomainError('VALIDATION_FAILED', 422, 'fiscal_year');
  if (status !== undefined && (typeof status !== 'string' || !PERIOD_STATUSES.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  if (type !== undefined && (typeof type !== 'string' || !PERIOD_TYPE_SET.has(type))) throw new DomainError('VALIDATION_FAILED', 422, 'period_type');
  if (calendar !== undefined && (typeof calendar !== 'string' || calendar === '' || calendar.length > MAX_CALENDAR_CODE || calendar.includes('\0'))) {
    throw new DomainError('VALIDATION_FAILED', 422, 'calendar_code');
  }
  return {
    fiscalYear: year === undefined ? undefined : Number(year),
    status: status as PeriodStatus | undefined,
    periodType: type as PeriodType | undefined,
    calendarCode: calendar as string | undefined,
  };
}

/**
 * The reporting period calendar (ST-DIS-001, DIS 3 F4): the weeks of a year are generated from the reporting calendar of MDM-11 and each keeps
 * the version of that calendar; a period is soft closed after its deadline (reports are still taken, and are late) and then locked. The
 * status is the one source of truth and nothing writes it directly: only these two commands move it, and the table refuses any other move.
 */
@Controller()
export class ReportingPeriodController {
  private readonly periods = new DisPeriodStore();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(DIS_METRICS) metrics?: MetricsSink, @Optional() @Inject(DIS_CLOCK) clock?: () => Date) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('reporting-periods/generate')
  @HttpCode(200)
  @OperationId('generateReportingPeriods')
  @Command({ operation: 'generateReportingPeriods' })
  async generate(@Scope() scope: CommandScope, @Body() body: Schemas['DisPeriodGenerate']): Promise<CommandResult> {
    const generated = await this.periods.generate(
      scope.tx,
      { calendarCode: body.calendar_code, fiscalYear: body.fiscal_year, periodType: body.period_type },
      scope.tenant.membershipId,
      this.clock(),
    );
    const first = generated.periods[0];
    const last = generated.periods[generated.periods.length - 1];
    if (first === undefined || last === undefined) throw new Error('the reporting calendar produced no period');
    await scope.audit({
      action: 'dis.periods_generated',
      resourceType: PERIOD_RESOURCE,
      resourceId: first.id,
      diff: {
        calendar_code: body.calendar_code.trim(),
        period_type: body.period_type,
        fiscal_year: body.fiscal_year,
        count: generated.periods.length,
        first_code: first.code,
        last_code: last.code,
        calendar_version_id: generated.calendar.versionId,
        calendar_revision: generated.calendar.revision,
      },
    });
    return commandResult(scope, 'OPEN', 1, first.id);
  }

  @Post('reporting-periods/:id/soft-close')
  @HttpCode(200)
  @OperationId('softCloseReportingPeriod')
  @Command({ operation: 'softCloseReportingPeriod', versioned: true })
  async softClose(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisPeriodTransition']): Promise<CommandResult> {
    const reason = reasonOf(body.reason);
    const row = await this.periods.softClose(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, this.clock());
    return this.recorded(scope, 'soft_close', row, reason);
  }

  @Post('reporting-periods/:id/lock')
  @HttpCode(200)
  @OperationId('lockReportingPeriod')
  @Command({ operation: 'lockReportingPeriod', versioned: true })
  async lock(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisPeriodTransition']): Promise<CommandResult> {
    const reason = reasonOf(body.reason);
    const row = await this.periods.lock(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, this.clock());
    return this.recorded(scope, 'lock', row, reason);
  }

  private async recorded(scope: CommandScope, move: PeriodMove, row: PeriodRow, reason: string): Promise<CommandResult> {
    const record = periodMoveRecord(move, row, reason, 'MANUAL');
    await scope.audit(record.audit);
    await scope.emit(record.event);
    scope.afterCommit(() => this.metrics.increment(DIS_PERIOD_TRANSITION_METRIC, transitionLabels(move, 'MANUAL')));
    return commandResult(scope, row.status, row.version, row.id);
  }
}

/** Reads of the period calendar (DIS-14): the status and the deadline by the calendar version of each period, with the history of reopening. */
@Controller('resources/reporting_period')
export class ReportingPeriodReadsController {
  private readonly periods = new DisPeriodStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_reporting_period')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('fiscal_year') fiscalYear?: unknown,
    @Query('status') status?: unknown,
    @Query('period_type') periodType?: unknown,
    @Query('calendar_code') calendarCode?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf({ fiscal_year: fiscalYear, status, period_type: periodType, calendar_code: calendarCode });
    if (request.after !== undefined && !DATE.test(request.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const { rows, reopens } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.periods.list(tx, filter, { limit: request.limit + 1, after: request.after });
      return { rows: found, reopens: await this.periods.reopens(tx, found.slice(0, request.limit).map((row) => row.id)) };
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => periodViewOf(row, reopens.get(row.id) ?? [])),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.startDate, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_reporting_period_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const { row, reopens } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.periods.find(tx, id);
      return { row: found, reopens: found === undefined ? new Map<string, PeriodReopenRow[]>() : await this.periods.reopens(tx, [found.id]) };
    });
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return periodViewOf(row, reopens.get(row.id) ?? []);
  }
}
