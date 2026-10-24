import { DomainError, addWorkingTime, vietnamDateOf } from '@machvon/kernel';
import type { WorkCalendarContent, WorkCalendarSource, WorkingInterval } from '@machvon/kernel';
import { IssSlaPolicyStore } from './iss-sla-policy-store.ts';
import type { SlaPolicyRow } from './iss-sla-policy-store.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';
import type { WorkCalendarRow } from './work-calendar-store.ts';

/**
 * The working window of an issue SLA: 07:30 to 17:00 (ISS 5, BR-ISS-01: Friday 16:00 plus 4 hours falls due on Monday 10:30). The
 * ADM default is 08:00-12:00 and 13:00-17:00 (BR-ADM-08); the calendar tables carry no hours of the day yet, so this module passes its
 * own window to the one function that counts working time (XM-ADM-01, docs/adm-working-time.md).
 */
export const ISS_WORKING_INTERVALS: readonly WorkingInterval[] = [{ from: '07:30', to: '17:00' }];

/** The calendar years after the year of the start that a deadline may need: a policy lasts at most 2400 working hours. */
const YEARS_AHEAD = 3;

export interface SlaDeadlineRequest {
  categoryVersionId: string;
  severity: string;
  /** The unit that owns the issue: its own policy comes before the default of the tenant. */
  ownerUnitId: string | null;
  /** The moment the issue is created; the policy in force on its Vietnam date is the one that applies. */
  startAt: Date;
}

/** The deadlines of an issue and the evidence of how they were reached: the policy version and the calendar versions that were read. */
export interface SlaDeadline {
  policy: SlaPolicyRow;
  /** The working calendar versions (one per year the count passed through) that the deadlines were computed on. */
  calendarVersionIds: string[];
  responseDueAt: Date;
  dueAt: Date;
}

/**
 * The deadlines of an issue (BR-ISS-01, BR-ISS-02): the policy in force on the day the issue is created, and the hours of that policy
 * counted on the published working calendar of the policy, so that weekends, holidays and make-up days are skipped. The policy version
 * and the calendar versions come back with the result: a deadline that has been stored is never recounted from newer versions.
 */
export class IssSlaDeadlines {
  private readonly policies: IssSlaPolicyStore;
  private readonly calendars: WorkCalendarStore;
  private readonly intervals: readonly WorkingInterval[];

  constructor(policies: IssSlaPolicyStore = new IssSlaPolicyStore(), calendars: WorkCalendarStore = new WorkCalendarStore(), intervals: readonly WorkingInterval[] = ISS_WORKING_INTERVALS) {
    this.policies = policies;
    this.calendars = calendars;
    this.intervals = intervals;
  }

  async calculate(tx: TenantTx, request: SlaDeadlineRequest): Promise<SlaDeadline> {
    const policy = await this.policies.inForce(tx, {
      categoryVersionId: request.categoryVersionId,
      severity: request.severity,
      ownerUnitId: request.ownerUnitId,
      on: vietnamDateOf(request.startAt),
    });
    if (policy === undefined) throw new DomainError('SLA_POLICY_MISSING', 422);
    const firstYear = Number(vietnamDateOf(request.startAt).slice(0, 4));
    const byYear = new Map<number, WorkCalendarRow>();
    for (let year = firstYear; year <= firstYear + YEARS_AHEAD; year += 1) {
      const row = await this.calendars.published(tx, policy.calendarCode, year);
      if (row !== undefined) byYear.set(year, row);
    }
    const used = new Set<string>();
    const source: WorkCalendarSource = {
      forYear(year): WorkCalendarContent | undefined {
        const row = byYear.get(year);
        if (row !== undefined) used.add(row.id);
        return row?.content;
      },
    };
    const responseDueAt = addWorkingTime(source, request.startAt, { hours: policy.responseHours }, this.intervals);
    const dueAt = addWorkingTime(source, request.startAt, { hours: policy.resolveHours }, this.intervals);
    return { policy, calendarVersionIds: [...used], responseDueAt, dueAt };
  }
}
