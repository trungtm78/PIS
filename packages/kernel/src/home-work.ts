/**
 * The work of a person in one list (ST-HOME-004, HOME 3 F5, HOME-02): what is asked of them in each module, ordered as it is looked at: what is late, then what is near its day, then the rest; inside each the earliest
 * day first, then the kind that comes first, then the id, so that the same list is always in the same order. The reads are of the modules; the order is here.
 */
export const WORK_KINDS = [
  'APPROVAL',
  'EXPLANATION',
  'REPORT_RETURNED',
  'REPORT_DRAFT_OVERDUE',
  'EXPLANATION_REVIEW',
  'MNE_OBLIGATION',
  // The alert centre adds what the other modules ask for: the warnings of DIS, the advances of PAY, the permits of PMT, the recommendations of AUD, the issues of ISS, the diaries of QMS and the guarantees of CTR.
  'EARLY_WARNING',
  'ADVANCE_OVERDUE',
  'PERMIT_EXPIRY',
  'AUDIT_RECOMMENDATION_OVERDUE',
  'ISSUE_SLA_BREACH',
  'SITE_DIARY_MISSING',
  'GUARANTEE_EXPIRING',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkBucket = 'OVERDUE' | 'NEAR' | 'LATER';

/** How many days ahead a task is "near its day". */
export const NEAR_DAYS = 7;

/** Which kind comes first when two tasks have the same day: an approval that waits for the person, then an explanation they owe, then a report that came back, and so on. */
const PRIORITY: Readonly<Record<WorkKind, number>> = {
  APPROVAL: 1,
  EXPLANATION: 2,
  REPORT_RETURNED: 3,
  REPORT_DRAFT_OVERDUE: 4,
  EXPLANATION_REVIEW: 5,
  MNE_OBLIGATION: 6,
  EARLY_WARNING: 7,
  ADVANCE_OVERDUE: 8,
  PERMIT_EXPIRY: 9,
  AUDIT_RECOMMENDATION_OVERDUE: 10,
  ISSUE_SLA_BREACH: 11,
  SITE_DIARY_MISSING: 12,
  GUARANTEE_EXPIRING: 13,
};

export interface WorkItem {
  id: string;
  kind: WorkKind;
  /** The day (Vietnam time) the task is due on, or null for a task that has none. */
  dueOn: string | null;
  /** The first day it was asked for, which a later due day does not hide (an explanation that was sent back with a new day is still late by the day it was first asked on). */
  originalDueOn: string | null;
  title: string;
  /** The place the task is about (a project, a unit), when it has one. */
  subtitle: string | null;
  status: string;
}

const day = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);

export function workBucket(item: Pick<WorkItem, 'dueOn' | 'originalDueOn'>, today: string): WorkBucket {
  if (item.dueOn === null) return 'LATER';
  const days = day(item.dueOn) - day(today);
  if (days < 0) return 'OVERDUE';
  return days <= NEAR_DAYS ? 'NEAR' : 'LATER';
}

const RANK: Readonly<Record<WorkBucket, number>> = { OVERDUE: 0, NEAR: 1, LATER: 2 };

/**
 * The order of two tasks: negative when the first is looked at first. It is a position, not a list: a page can go on from a task that is no longer in the list (it was done meanwhile) by asking for what comes after it.
 */
export function compareWork(left: Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'>, right: Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'>, today: string): number {
  const byBucket = RANK[workBucket(left, today)] - RANK[workBucket(right, today)];
  if (byBucket !== 0) return byBucket;
  // A task with no day comes after the ones that have one.
  if (left.dueOn !== right.dueOn) return left.dueOn === null ? 1 : right.dueOn === null ? -1 : left.dueOn.localeCompare(right.dueOn);
  return PRIORITY[left.kind] - PRIORITY[right.kind] || left.id.localeCompare(right.id, 'en');
}

/** The tasks in the order they are looked at; the list that was given is left as it was. */
export function orderWork<T extends WorkItem>(items: readonly T[], today: string): T[] {
  return [...items].sort((left, right) => compareWork(left, right, today));
}
