import { localTimeOf, periodLockVerdict, stepDeadlines, vietnamDateOf } from '@machvon/kernel';
import type { LockHold, ScheduleCode } from '@machvon/kernel';
import type { PeriodRow } from './dis-period-store.ts';
import { ReportingCalendarStore } from './reporting-calendar-store.ts';
import { ReportingScheduleReader } from './reporting-schedule-reader.ts';
import type { TenantTx } from './tenant-database.ts';

/** Asked by the job that locks periods before each lock: the reason the lock must wait, or nothing when it may go ahead. */
export interface PeriodLockGate {
  hold(tx: TenantTx, period: PeriodRow, now: Date): Promise<LockHold | undefined>;
}

let editionGate: PeriodLockGate | undefined;

/** The enterprise edition registers its gate when it loads (like the baselines of an edition); a public process registers none, so its job keeps the D03 rule alone. */
export function registerEditionPeriodLockGate(gate: PeriodLockGate): void {
  editionGate = gate;
}

export const editionPeriodLockGate = (): PeriodLockGate | undefined => editionGate;

const SCHEDULE_OF: Readonly<Record<string, ScheduleCode>> = { MONTH: 'MONTH', QUARTER: 'QUARTER', YEAR: 'YEAR' };

/**
 * The gate of the enterprise edition (INT-2, QT.02): a period of the schedule kinds (month, quarter, year) is not locked before the review of the planning board and the close of the period have finished, by the rule
 * `periodLockVerdict` of the kernel: the facts of the staged approval when the platform has them, the deadlines of the schedule rule in force when it has not. A period of another kind (the weeks of the public edition)
 * has no such steps, so it has no hold.
 */
export class SchedulePeriodLockGate implements PeriodLockGate {
  private readonly schedules: ReportingScheduleReader;
  private readonly calendar: ReportingCalendarStore;

  constructor(schedules: ReportingScheduleReader = new ReportingScheduleReader(), calendar: ReportingCalendarStore = new ReportingCalendarStore()) {
    this.schedules = schedules;
    this.calendar = calendar;
  }

  async hold(tx: TenantTx, period: PeriodRow, now: Date): Promise<LockHold | undefined> {
    const code = SCHEDULE_OF[period.periodType];
    if (code === undefined) return undefined;
    const reading = await this.schedules.get(tx, code, vietnamDateOf(now));
    const deadlines = stepDeadlines(reading.policy, { endsOn: period.endDate }, localTimeOf(period.deadlineAt), undefined, period.deadlineAt);
    const progress = await this.calendar.stepProgress(tx, { id: period.id, periodType: period.periodType as 'MONTH' | 'QUARTER' | 'YEAR', fiscalYear: period.fiscalYear, endDate: period.endDate });
    const verdict = periodLockVerdict(deadlines, progress, now);
    return verdict.open ? undefined : verdict.hold;
  }
}
