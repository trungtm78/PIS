import { randomUUID } from 'node:crypto';
import { REMINDER_ALERT_TYPES, SCHEDULE_REMINDER_KINDS, buildBoard, daysOverdue, localTimeOf, reminderDue, reminderEventOf, stepDeadlines, vietnamDateOf } from '@machvon/kernel';
import type { ScheduleCode, ScheduleReminderKind, ScheduleStepKind } from '@machvon/kernel';
import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { enqueueOutbox } from './outbox.ts';
import { ReportingCalendarStore, WHOLE_TENANT, seriesKeyOf } from './reporting-calendar-store.ts';
import type { CalendarPeriodRow, ScheduleReminderRecord } from './reporting-calendar-store.ts';
import { ReportingScheduleReader } from './reporting-schedule-reader.ts';
import type { ScheduleReading } from './reporting-schedule-reader.ts';
import type { TenantTx } from './tenant-database.ts';

export const CALENDAR_REMINDER_METRIC = 'dis_calendar_reminder_total';
/** A step whose deadline passed more than this many days ago is not reminded: switching the schedule on does not flood people with the overdue steps of the past. */
export const REMINDER_HORIZON_DAYS = 45;
/** The most reminders one pass records; the rest follow on the next pass. */
export const MAX_REMINDERS_PER_PASS = 2000;
const PERIOD_TYPE_CODE: Record<CalendarPeriodRow['periodType'], ScheduleCode> = { MONTH: 'MONTH', QUARTER: 'QUARTER', YEAR: 'YEAR' };
const DAY_MS = 86_400_000;
const MAX_ORDINAL = 31;

export interface CalendarReminderResult {
  periods: number;
  checked: number;
  reminders: number;
  escalations: number;
}

interface Target {
  unitId: string | null;
  unitPath: string;
  step: ScheduleStepKind;
  dueAt: string;
  finished: boolean;
}

/**
 * The job `calendar-reminder` for the tenant of the transaction (QT.02, ENT-4c): for each generated period of the schedule kinds (month, quarter, year) whose steps are still within reach, it puts the facts of the period
 * against the deadlines of the schedule rule in force, and for each unit and step that is not finished decides by the rule which reminder is due (before the deadline, after it, the escalation). Each reminder is a row in
 * `reporting_reminder` with a series key, so a pass run twice or by two processes records it once, and an event in the outbox in the same transaction; the notification workflow of the tenant carries the event to people and
 * channels. Steps that have no fact behind them (the review of the planning board, the push) are never reminded: a reminder about something the platform cannot see would be noise. Steering meetings and plan adjustments are on
 * the calendar and on the board but have no fact either, so they are not reminded yet.
 */
export async function runCalendarReminders(tx: TenantTx, tenantId: string, now: Date, increment: (name: string, labels?: Record<string, string>) => void = () => undefined): Promise<CalendarReminderResult> {
  const store = new ReportingCalendarStore();
  const schedules = new ReportingScheduleReader();
  const today = vietnamDateOf(now);
  const year = Number(today.slice(0, 4));
  const result: CalendarReminderResult = { periods: 0, checked: 0, reminders: 0, escalations: 0 };
  const readings = new Map<ScheduleCode, ScheduleReading>();
  for (const reading of await schedules.all(tx, today)) readings.set(reading.code, reading);
  const periods = await store.periods(tx, [year - 1, year]);
  const sent = await store.sentSeries(tx, periods.map((period) => period.id));
  const root = await store.rootUnit(tx);
  for (const period of periods) {
    const reading = readings.get(PERIOD_TYPE_CODE[period.periodType]) as ScheduleReading;
    const deadlines = stepDeadlines(reading.policy, { endsOn: period.endDate }, localTimeOf(period.deadlineAt), undefined, period.deadlineAt);
    // A period is out of reach when every step is long past and nothing can be reminded any more.
    const last = deadlines.reduce((latest, step) => Math.max(latest, Date.parse(step.dueAt)), 0);
    if (now.getTime() - last > REMINDER_HORIZON_DAYS * DAY_MS) continue;
    result.periods += 1;
    const facts = await store.unitFacts(tx, WHOLE_TENANT, period);
    const board = buildBoard(deadlines, facts, { closedAt: period.status === 'LOCKED' ? period.lockedAt : null }, now);
    const targets: Target[] = [];
    for (const unit of board.units) {
      const path = facts.find((one) => one.unitId === unit.unitId)?.unitPath ?? '/';
      for (const step of unit.steps) {
        if (step.kind !== 'ENTRY' && step.kind !== 'UNIT_APPROVAL') continue;
        // A unit with no project to report has nothing to hand in: there is no fact, so no reminder.
        if (step.state === 'NOT_TRACKED') continue;
        targets.push({ unitId: unit.unitId, unitPath: path, step: step.kind, dueAt: step.dueAt, finished: step.state === 'DONE' || step.state === 'DONE_LATE' });
      }
    }
    const closing = board.periodSteps.find((step) => step.kind === 'PERIOD_CLOSE');
    if (closing !== undefined && root !== undefined) targets.push({ unitId: null, unitPath: root.path, step: 'PERIOD_CLOSE', dueAt: closing.dueAt, finished: closing.state === 'DONE' || closing.state === 'DONE_LATE' });
    for (const target of targets) {
      result.checked += 1;
      if (target.finished) continue;
      if (now.getTime() - Date.parse(target.dueAt) > REMINDER_HORIZON_DAYS * DAY_MS) continue;
      const already = Object.fromEntries(SCHEDULE_REMINDER_KINDS.map((kind) => [kind, [] as number[]])) as Record<ScheduleReminderKind, number[]>;
      for (const kind of SCHEDULE_REMINDER_KINDS) {
        for (let ordinal = 1; ordinal <= MAX_ORDINAL; ordinal += 1) if (sent.has(seriesKeyOf({ itemKey: period.id, unitId: target.unitId, step: target.step, kind, ordinal }))) already[kind].push(ordinal);
      }
      const due = reminderDue(reading.policy, target.dueAt, now, already, period.endDate);
      if (due === undefined) continue;
      if (result.reminders + result.escalations >= MAX_REMINDERS_PER_PASS) return result;
      const record: ScheduleReminderRecord = {
        itemKind: 'REPORT_PERIOD',
        itemKey: period.id,
        scheduleCode: PERIOD_TYPE_CODE[period.periodType],
        unitId: target.unitId,
        step: target.step,
        kind: due.kind,
        ordinal: due.ordinal,
        alertType: REMINDER_ALERT_TYPES[due.kind],
        dueAt: target.dueAt,
        ruleVersion: reading.version,
      };
      const made = await store.record(tx, record);
      if (!made.created) continue;
      sent.add(seriesKeyOf(record));
      if (due.kind === 'ESCALATED') result.escalations += 1;
      else result.reminders += 1;
      await enqueueOutbox(tx, {
        aggregateType: 'reporting_reminder',
        aggregateId: made.id,
        aggregateVersion: 1,
        type: reminderEventOf(due.kind),
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          actor_id: WORKER_MEMBERSHIP_ID,
          occurred_at: now.toISOString(),
          reminder_id: made.id,
          item_kind: record.itemKind,
          item_key: period.id,
          period_code: period.code,
          ...(target.unitId === null ? {} : { unit_id: target.unitId }),
          step: target.step,
          kind: due.kind,
          ordinal: due.ordinal,
          due_at: target.dueAt,
          days_overdue: daysOverdue(target.dueAt, now),
          alert_type: record.alertType,
          // Whom it is for is the notification workflow of the tenant: the roles it names, in the scope of this unit. The payload carries the unit and nothing of the figures.
          notification: { resource: { type: 'report', id: period.id, ownerUnitId: target.unitId ?? (root as { id: string }).id, ownerUnitPath: target.unitPath } },
        },
        eventKey: `reporting_reminder:${seriesKeyOf(record)}`,
        correlationId: randomUUID(),
      });
      increment(CALENDAR_REMINDER_METRIC, { kind: due.kind, step: target.step });
    }
  }
  return result;
}
