import { randomUUID } from 'node:crypto';
import { DEFAULT_WORKING_INTERVALS, DomainError, NOOP_METRICS, addWorkingTime, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, WorkCalendarSource, WorkingInterval } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import {
  DEFAULT_LOCK_AFTER_WORKING_DAYS,
  DIS_PERIOD_TRANSITION_METRIC,
  DisPeriodStore,
  PERIOD_WORKING_CALENDAR,
  periodMoveRecord,
  transitionLabels,
} from './dis-period-store.ts';
import type { PeriodMove, PeriodRow } from './dis-period-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { PeriodLockGate } from './period-lock-gate.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

const MINUTES_PER_HOUR = 60;
/** The reasons the job writes to the audit trail: codes, not prose, as it has no person to explain to. */
export const AUTOCLOSE_SOFT_CLOSE_REASON = 'AUTO_SOFT_CLOSE_AFTER_DEADLINE';
export const AUTOCLOSE_LOCK_REASON = 'AUTO_LOCK_AFTER_WORKING_DAYS';
/** Counts the locks the gate held back, by the reason it gave. */
export const DIS_PERIOD_LOCK_HELD_METRIC = 'dis_period_lock_held_total';

export interface AutocloseResult {
  softClosed: number;
  locked: number;
  /** Periods whose lock time could not be counted because the working calendar of their year is not published; they are left soft closed. */
  skipped: number;
  /** Periods whose lock time came but that the lock gate holds (the review or the close of the enterprise schedule has not finished); only present when the job has a gate. */
  held?: number;
}

export interface AutocloseOptions {
  store?: DisPeriodStore;
  calendars?: WorkCalendarStore;
  /** Working days between the deadline and the lock (D03 assumption: three). */
  lockAfterWorkingDays?: number;
  intervals?: readonly WorkingInterval[];
  metrics?: MetricsSink;
  /**
   * Asked before each lock: a period it holds stays soft closed until the next run (INT-2). The public edition runs without one and keeps the D03 rule alone; the enterprise edition passes the gate that waits for the
   * review and the close of its schedule (`SchedulePeriodLockGate`).
   */
  lockGate?: PeriodLockGate | (() => PeriodLockGate | undefined);
}

/** The hours of one working day on the intervals: what "three working days" means as working time. */
export function workingHoursPerDay(intervals: readonly WorkingInterval[]): number {
  const minutes = intervals.reduce((sum, { from, to }) => sum + minuteOf(to) - minuteOf(from), 0);
  return minutes / MINUTES_PER_HOUR;
}

function minuteOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

/**
 * The job `dis.period-autoclose` (DIS 3 F4): it soft-closes the periods whose deadline has passed and locks the soft-closed ones once the
 * lock time has come, by calling the same moves as the commands and leaving the same audit row and event. A period that a command is
 * acting on at that moment is left to the next run. The lock time is the deadline plus the working days of the policy, counted on the
 * published working calendar of the year; with no such calendar the period stays soft closed and is counted as skipped. With a lock gate (the enterprise edition) a period whose lock time has come is locked only when the gate
 * lets it go: it waits for the review of the planning board and the close of its schedule, and is counted as held until then (INT-2).
 */
export class DisPeriodAutoclose {
  private readonly store: DisPeriodStore;
  private readonly calendars: WorkCalendarStore;
  private readonly lockHours: number;
  private readonly intervals: readonly WorkingInterval[];
  private readonly metrics: MetricsSink;
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly lockGate: PeriodLockGate | (() => PeriodLockGate | undefined) | undefined;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, options: AutocloseOptions = {}) {
    this.audit = audit;
    this.store = options.store ?? new DisPeriodStore();
    this.calendars = options.calendars ?? new WorkCalendarStore();
    this.intervals = options.intervals ?? DEFAULT_WORKING_INTERVALS;
    this.lockHours = (options.lockAfterWorkingDays ?? DEFAULT_LOCK_AFTER_WORKING_DAYS) * workingHoursPerDay(this.intervals);
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.lockGate = options.lockGate;
  }

  /** One pass for the tenant of the transaction. Running it again at the same moment does nothing more. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<AutocloseResult> {
    const gate = typeof this.lockGate === 'function' ? this.lockGate() : this.lockGate;
    const result: AutocloseResult = gate === undefined ? { softClosed: 0, locked: 0, skipped: 0 } : { softClosed: 0, locked: 0, skipped: 0, held: 0 };
    const correlationId = randomUUID();
    const sources = new Map<number, WorkCalendarSource>();
    for (const found of await this.store.pastDeadline(tx, now)) {
      let period: PeriodRow = found;
      if (period.status === 'OPEN') {
        period = await this.store.softClose(tx, period.id, period.version, actor, now);
        await this.trace(tx, 'soft_close', period, actor, correlationId, AUTOCLOSE_SOFT_CLOSE_REASON);
        result.softClosed += 1;
      }
      const lockAt = await this.lockTime(tx, period, sources);
      if (lockAt === undefined) {
        result.skipped += 1;
      } else if (lockAt.getTime() <= now.getTime()) {
        const hold = await gate?.hold(tx, period, now);
        if (hold !== undefined) {
          result.held = (result.held ?? 0) + 1;
          this.metrics.increment(DIS_PERIOD_LOCK_HELD_METRIC, { reason: hold.toLowerCase() });
          continue;
        }
        period = await this.store.lock(tx, period.id, period.version, actor, now);
        await this.trace(tx, 'lock', period, actor, correlationId, AUTOCLOSE_LOCK_REASON);
        result.locked += 1;
      }
    }
    return result;
  }

  /** The moment a soft-closed period is locked: its deadline plus the working days, or undefined without a working calendar for the years it passes through. */
  private async lockTime(tx: TenantTx, period: PeriodRow, sources: Map<number, WorkCalendarSource>): Promise<Date | undefined> {
    const year = Number(vietnamDateOf(new Date(period.deadlineAt)).slice(0, 4));
    let source = sources.get(year);
    if (source === undefined) {
      source = await this.calendars.source(tx, PERIOD_WORKING_CALENDAR, year);
      sources.set(year, source);
    }
    try {
      return addWorkingTime(source, new Date(period.deadlineAt), { hours: this.lockHours }, this.intervals);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CALENDAR_NOT_EFFECTIVE') return undefined;
      throw error;
    }
  }

  private async trace(tx: TenantTx, move: PeriodMove, period: PeriodRow, actor: string, correlationId: string, reason: string): Promise<void> {
    const record = periodMoveRecord(move, period, reason, 'AUTO');
    await this.audit.recordInTx(tx, actor, { ...record.audit, correlationId, requestId: randomUUID() });
    await enqueueOutbox(tx, { ...record.event, correlationId });
    this.metrics.increment(DIS_PERIOD_TRANSITION_METRIC, transitionLabels(move, 'AUTO'));
  }
}
