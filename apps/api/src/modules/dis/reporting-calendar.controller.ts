import { Controller, Get, Inject, Optional, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DirDirectiveStore, DirectivePolicyReader, MasterRules, ReportingCalendarStore, ReportingScheduleReader, TenantDatabase, directiveScope, meetingScope, projectScope } from '@machvon/db';
import type { ScheduleReading } from '@machvon/db';
import { BASIS_OF, DomainError, activeGrants, buildBoard, holdsPermission, localTimeOf, meetingPeriod, schedulePeriods, stepDeadlines, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ScheduleBasis, ScheduleCode, SchedulePeriod, StepDeadline, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportingCalendar;
const DEFAULT_CALENDAR_TIME = '10:00';
/** The most directives the calendar lists for a year: the directive module has its own lists and board for more. */
const DIRECTIVE_LIMIT = 200;
const REMINDER_LIMIT = 50;
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;
const DIRECTIVE_TEXT_MAX = 160;

const holds = (access: EffectiveAccess, permission: string, now: Date): boolean => activeGrants(access, now).some((grant) => holdsPermission(new Set(grant.permissions), permission));

function yearOf(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const year = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  return year;
}

const stepView = (step: StepDeadline): Record<string, unknown> => ({ kind: step.kind, due_at: step.dueAt, due_on: step.dueOn, due_time: step.dueTime });

export const scheduleView = (reading: ScheduleReading): Record<string, unknown> => ({
  code: reading.code,
  basis: BASIS_OF[reading.code],
  version: reading.version,
  source: reading.source,
  unverified: reading.unverified,
  rule_id: reading.ruleId,
  steps: reading.policy.steps.map((step) => ({ kind: step.kind, offset_days: step.offsetDays, time: step.time })),
  reminder_days_before: reading.policy.reminderDaysBefore,
  overdue_repeat_days: reading.policy.overdueRepeatDays,
  overdue_max_reminders: reading.policy.overdueMaxReminders,
  escalate_after_overdue_days: reading.policy.escalateAfterOverdueDays,
});

interface Item {
  kind: string;
  key: string;
  code: string;
  starts_on: string;
  ends_on: string;
  [field: string]: unknown;
}

/**
 * The reporting calendar of the enterprise edition (QT.02, ENT-4c): the periods of a year (month, quarter, year), the in-year plan adjustment, the steering meetings and the directives that fall due, each with the deadline
 * of every step of the schedule rule in force; and, for one period, the status board by input point. The deadlines come from the governance rule `REPORTING_SCHEDULE` (versioned, approved by someone other than who
 * proposed it): a period that exists keeps the entry deadline it was generated with, the other steps follow the rule in force today. A step with no fact behind it is `NOT_TRACKED`, never open or done.
 */
@Controller()
export class ReportingCalendarController {
  private readonly store = new ReportingCalendarStore();
  private readonly schedules = new ReportingScheduleReader();
  private readonly masters = new MasterRules();
  private readonly directives = new DirDirectiveStore();
  private readonly policy = new DirectivePolicyReader();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('reporting-calendar')
  @OperationId('getReportingCalendar')
  async calendar(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('year') yearValue?: unknown): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const year = yearOf(yearValue, Number(today.slice(0, 4)));
    const mayReadDirectives = holds(access, PERMISSIONS.getDirective, now);
    return this.database.withTenant(tenant, async (tx) => {
      const readings = await this.schedules.all(tx, today);
      const byCode = new Map<ScheduleCode, ScheduleReading>(readings.map((reading) => [reading.code, reading]));
      const calendarTime = String((await this.masters.read(tx, 'CALENDAR', 'DEFAULT', today))?.attributes.deadline_time ?? DEFAULT_CALENDAR_TIME);
      const generated = new Map((await this.store.periods(tx, [year])).map((period) => [period.code, period]));
      const items: Item[] = [];
      const withSteps = (code: ScheduleCode, period: Pick<SchedulePeriod, 'endsOn'>, time: string, entryDueAt?: string): Record<string, unknown>[] =>
        stepDeadlines((byCode.get(code) as ScheduleReading).policy, period, time, undefined, entryDueAt).map(stepView);
      for (const basis of ['MONTH', 'QUARTER', 'YEAR'] as const) {
        for (const period of schedulePeriods(basis, year)) {
          const row = generated.get(period.code);
          items.push({
            kind: 'REPORT_PERIOD',
            key: row?.id ?? period.code,
            code: period.code,
            period_type: basis,
            period_id: row?.id ?? null,
            generated: row !== undefined,
            status: row?.status ?? null,
            starts_on: period.startsOn,
            ends_on: period.endsOn,
            schedule_code: basis,
            steps: withSteps(basis, period, row === undefined ? calendarTime : localTimeOf(row.deadlineAt), row?.deadlineAt),
          });
        }
      }
      // The in-year plan adjustment runs on the quarters, with the steps of its own rule.
      for (const period of schedulePeriods('QUARTER', year)) {
        items.push({ kind: 'PLAN_ADJUSTMENT', key: `PLAN_ADJUSTMENT:${period.code}`, code: period.code, starts_on: period.startsOn, ends_on: period.endsOn, schedule_code: 'PLAN_ADJUSTMENT', steps: withSteps('PLAN_ADJUSTMENT', period, calendarTime) });
      }
      if (mayReadDirectives) {
        const meetings = await this.store.meetings(tx, meetingScope(access, PERMISSIONS.getDirective, now), year);
        for (const meeting of meetings) {
          const period = meetingPeriod(meeting.code, meeting.meetingDate);
          items.push({ kind: 'MEETING', key: meeting.id, code: meeting.code, title: meeting.title, meeting_type: meeting.meetingType, unit: { id: meeting.unitId, name: meeting.unitName }, starts_on: meeting.meetingDate, ends_on: meeting.meetingDate, schedule_code: 'MEETING', steps: withSteps('MEETING', period, calendarTime) });
        }
        const policy = await this.policy.get(tx, today);
        const lines = await this.directives.list(tx, directiveScope(access, PERMISSIONS.getDirective, now), { dueFrom: `${year}-01-01`, dueTo: `${year}-12-31` }, { limit: DIRECTIVE_LIMIT, after: undefined }, today, policy.params);
        for (const line of lines) {
          if (line.clock.status === 'DONE' || line.clock.status === 'CANCELLED') continue;
          items.push({
            kind: 'DIRECTIVE_DUE',
            key: line.id,
            code: line.code,
            title: line.text.length > DIRECTIVE_TEXT_MAX ? `${line.text.slice(0, DIRECTIVE_TEXT_MAX - 1)}…` : line.text,
            starts_on: line.dueOn,
            ends_on: line.dueOn,
            status: line.clock.status,
            overdue_days: line.clock.overdueDays,
            assignee_unit: { id: line.assigneeUnit.id, name: line.assigneeUnit.name },
            meeting: { id: line.meeting.id, code: line.meeting.code },
          });
        }
      }
      items.sort((a, b) => (a.ends_on < b.ends_on ? -1 : a.ends_on > b.ends_on ? 1 : a.key < b.key ? -1 : 1));
      return { year, calendar_time: calendarTime, schedules: readings.map(scheduleView), items, as_of: now.toISOString() };
    });
  }

  @Get('reporting-calendar/periods/:id/board')
  @OperationId('getReportingCalendarBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const period = await this.store.period(tx, id.toLowerCase());
      if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const code: ScheduleCode = period.periodType;
      const reading = await this.schedules.get(tx, code, today);
      const deadlines = stepDeadlines(reading.policy, { endsOn: period.endDate }, localTimeOf(period.deadlineAt), undefined, period.deadlineAt);
      const facts = await this.store.unitFacts(tx, projectScope(access, READ_PERMISSION, now), period);
      const chain = await this.store.chainFacts(tx, projectScope(access, READ_PERMISSION, now), period);
      const board = buildBoard(deadlines, facts, { ...chain, closedAt: period.status === 'LOCKED' ? period.lockedAt : null }, now);
      const reminders = await this.store.recent(tx, period.id, REMINDER_LIMIT);
      const basis: ScheduleBasis = BASIS_OF[code];
      return {
        period: { id: period.id, code: period.code, period_type: period.periodType, basis, fiscal_year: period.fiscalYear, start_date: period.startDate, end_date: period.endDate, deadline_at: period.deadlineAt, status: period.status },
        schedule: scheduleView(reading),
        steps: deadlines.map(stepView),
        period_steps: board.periodSteps.map((step) => ({ kind: step.kind, due_at: step.dueAt, state: step.state, done_at: step.doneAt })),
        units: board.units.map((unit) => ({
          unit: { id: unit.unitId, code: unit.unitCode, name: unit.unitName },
          projects: unit.projects,
          steps: unit.steps.map((step) => ({ kind: step.kind, due_at: step.dueAt, state: step.state, done: step.done, of: step.of, done_at: step.doneAt })),
        })),
        tally: board.tally,
        reminders: reminders.map((reminder) => ({ id: reminder.id, unit_id: reminder.unitId, step: reminder.step, kind: reminder.kind, ordinal: reminder.ordinal, due_at: reminder.dueAt, created_at: reminder.createdAt })),
        as_of: now.toISOString(),
      };
    });
  }
}
