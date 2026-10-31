import { DomainError } from './errors.ts';
import { wholeMoney } from './prj-revision.ts';
import { isCalendarDate } from './retention.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The work breakdown and the milestones of a project (ST-PRJ-009, PRJ 3.1 BR-PRJ-08, PRJ-05, PRJ-07): a tree of components with their planned value, and milestones with a baseline day that never changes, a
 * planned day that may slip, the day it was really done and what each depends on. A delay is counted in calendar days from the baseline. Pure functions of their input.
 */
export const MILESTONE_STATUSES = ['PLANNED', 'DONE', 'DELAYED', 'CANCELLED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
/** The statuses a milestone ends in: it changes no more. */
export const MILESTONE_ENDED: readonly MilestoneStatus[] = ['DONE', 'CANCELLED'];
export const MAX_COMPONENT_DEPTH = 6;

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const NAME_MIN = 2;
const NAME_MAX = 300;
const REASON_MIN = 5;
const REASON_MAX = 2000;
const SORT_MAX = 100_000;
const DAY_MS = 86_400_000;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function codeOf(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!CODE.test(code)) throw invalid('code');
  return code;
}

function nameOf(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (name.length < NAME_MIN || name.length > NAME_MAX) throw invalid('name');
  return name;
}

function dayOf(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !isCalendarDate(raw)) throw invalid(field);
  return raw;
}

function optionalId(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id;
}

export interface ComponentInput {
  code: string;
  name: string;
  parentId: string | undefined;
  plannedValueVnd: string;
  sortOrder: number;
  validFrom: string;
}

/** A component of the work breakdown: a code, a name, an optional parent, the value planned for it in whole dong, its place among its brothers and the day it starts. */
export function assertComponentInput(raw: { code?: unknown; name?: unknown; parent_component_id?: unknown; planned_value_vnd?: unknown; sort_order?: unknown; valid_from?: unknown }): ComponentInput {
  const sort = raw.sort_order === undefined ? 0 : raw.sort_order;
  if (typeof sort !== 'number' || !Number.isInteger(sort) || sort < 0 || sort > SORT_MAX) throw invalid('sort_order');
  return {
    code: codeOf(raw.code),
    name: nameOf(raw.name),
    parentId: optionalId(raw.parent_component_id, 'parent_component_id'),
    plannedValueVnd: wholeMoney(raw.planned_value_vnd, 'planned_value_vnd'),
    sortOrder: sort,
    validFrom: dayOf(raw.valid_from, 'valid_from'),
  };
}

export interface MilestoneInput {
  code: string;
  name: string;
  componentId: string | undefined;
  baselineDate: string;
  plannedDate: string;
  dependsOnId: string | undefined;
}

/** A milestone: a code, a name, the component it belongs to, the baseline day it was promised for (kept for good), the day it is planned for and the milestone it waits for. */
export function assertMilestoneInput(raw: { code?: unknown; name?: unknown; component_id?: unknown; baseline_date?: unknown; planned_date?: unknown; depends_on_milestone_id?: unknown }): MilestoneInput {
  return {
    code: codeOf(raw.code),
    name: nameOf(raw.name),
    componentId: optionalId(raw.component_id, 'component_id'),
    baselineDate: dayOf(raw.baseline_date, 'baseline_date'),
    plannedDate: dayOf(raw.planned_date, 'planned_date'),
    dependsOnId: optionalId(raw.depends_on_milestone_id, 'depends_on_milestone_id'),
  };
}

export interface MilestoneProgress {
  status: 'DONE' | 'DELAYED' | 'CANCELLED';
  actualDate: string | undefined;
  plannedDate: string | undefined;
  reason: string | undefined;
}

export interface MilestoneNow {
  status: MilestoneStatus;
  plannedDate: string;
}

function reasonOf(raw: unknown, required: boolean): string | undefined {
  if (!required && (raw === undefined || (typeof raw === 'string' && raw.trim() === ''))) return undefined;
  const reason = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw invalid('reason');
  return reason;
}

/**
 * What is recorded about a milestone. Done needs the day it was really done, a real day that has come (422 on `actual_date`); delayed needs a later planned day and a reason; cancelled needs a reason; each refuses the
 * fields that belong to the others. A milestone that is done or cancelled changes no more (409 `MILESTONE_STATE_INVALID`).
 */
export function assertMilestoneProgress(raw: { status?: unknown; actual_date?: unknown; planned_date?: unknown; reason?: unknown }, now: MilestoneNow, today: string): MilestoneProgress {
  const status = raw.status === 'DONE' || raw.status === 'DELAYED' || raw.status === 'CANCELLED' ? raw.status : undefined;
  if (status === undefined) throw invalid('status');
  if (MILESTONE_ENDED.includes(now.status)) throw new DomainError('MILESTONE_STATE_INVALID', 409, 'status', { extensions: { status: now.status } });
  switch (status) {
    case 'DONE': {
      if (raw.planned_date !== undefined) throw invalid('planned_date');
      const actual = dayOf(raw.actual_date, 'actual_date');
      if (actual > today) throw invalid('actual_date');
      return { status, actualDate: actual, plannedDate: undefined, reason: reasonOf(raw.reason, false) };
    }
    case 'DELAYED': {
      if (raw.actual_date !== undefined) throw invalid('actual_date');
      const planned = dayOf(raw.planned_date, 'planned_date');
      if (planned <= now.plannedDate) throw invalid('planned_date');
      return { status, actualDate: undefined, plannedDate: planned, reason: reasonOf(raw.reason, true) };
    }
    case 'CANCELLED': {
      if (raw.actual_date !== undefined) throw invalid('actual_date');
      if (raw.planned_date !== undefined) throw invalid('planned_date');
      return { status, actualDate: undefined, plannedDate: undefined, reason: reasonOf(raw.reason, true) };
    }
  }
}

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** The calendar days between two days (`later` minus `earlier`). */
export const calendarDaysBetween = (earlier: string, later: string): number => Math.round(dayNumber(later) - dayNumber(earlier));

export interface MilestoneSchedule {
  status: MilestoneStatus;
  baselineDate: string;
  plannedDate: string;
  actualDate: string | null;
}

/**
 * How many calendar days a milestone is late against its baseline: a milestone that was done is late by the days between the baseline and the day it was done; one that is still open by the days between the baseline
 * and its planned day, or today when that day has passed and it is still not done. A cancelled milestone is late by none.
 */
export function delayDays(milestone: MilestoneSchedule, today: string): number {
  if (milestone.status === 'CANCELLED') return 0;
  const end = milestone.actualDate ?? (milestone.plannedDate > today ? milestone.plannedDate : today);
  return Math.max(0, calendarDaysBetween(milestone.baselineDate, end));
}

/** Whether making `id` wait for `target` would close a loop: `target` is `id`, or waits (through others) for `id`. `waitsFor` is what each milestone waits for today. */
export function formsCycle(waitsFor: ReadonlyMap<string, string | null>, id: string, target: string): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = target;
  while (current !== null && current !== undefined) {
    if (current === id) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = waitsFor.get(current);
  }
  return false;
}

/** Whether the planned value of the first-level components adds up to more than the investment total of the project (BR-PRJ-08; a warning, not a block). */
export function wbsExceedsTotal(firstLevelValues: readonly string[], totalVnd: string): boolean {
  return firstLevelValues.reduce((sum, value) => sum + BigInt(value), 0n) > BigInt(totalVnd);
}
