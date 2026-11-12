import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { dayNumber, dayText, isWorkflowDay } from './process-core.ts';
import { activeTasks, topologicalOrder } from './project-workflow.ts';
import type { ConstraintKind, DependencyKind, ProjectFacts, ProjectWorkflowTemplate } from './project-workflow.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarContent } from './working-time.ts';

/**
 * The schedule of a project (PWF-2, R28, R32): the dates of every task and milestone computed from the planned start, the durations of the workflow and the working calendar, and the float and the critical path that follow. Everything is pure.
 *
 * A project is laid on a LINE of working days: slot 0 is the first working day on or after the earliest date the project mentions, and the calendars given (one version per year, pinned by the caller) are joined year after year, so a project longer
 * than the three years that a day-by-day scan stops at is planned all the same. A task of duration d that starts in slot s occupies slots s .. s+d-1 (it ends, exclusive, at e = s+d); a milestone sits at one point and is dated by the working day
 * on which its predecessors end. The four kinds of link tie the ends of two tasks (FS: end to start, SS: start to start, FF: end to end, SF: start to end) with a lag or a lead in working days; a constraint holds a start or a finish to a date.
 * A task that is cancelled or left out of the project is a node of zero length that keeps the order of the tasks around it. A calendar year that is not given is never guessed: every task that would fall in it says CALENDAR_UNAVAILABLE.
 */

export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

export interface ScheduleLink {
  task: string;
  kind: DependencyKind;
  lagWorkingDays: number;
}

/** A constraint holds a start or a finish to a date: an absolute day, or working days after the planned start (as a template says it). */
export type ScheduleConstraint = { kind: ConstraintKind } & ({ date: string; offsetWorkingDays?: never } | { offsetWorkingDays: number; date?: never });

export interface ScheduleTask {
  code: string;
  kind: 'TASK' | 'MILESTONE';
  /** The planned duration in working days (0 for a milestone). */
  durationWorkingDays: number;
  predecessors: readonly ScheduleLink[];
  constraint?: ScheduleConstraint | null;
  status?: TaskStatus;
  /** A branch of the template that this project does not have: the task is a node of zero length. */
  excluded?: boolean;
  actualStart?: string | null;
  actualFinish?: string | null;
  remainingWorkingDays?: number | null;
  percentComplete?: number | null;
}

/** One version of the working calendar of one year, as the project pinned it. */
export interface PinnedCalendar {
  year: number;
  version: number;
  content: WorkCalendarContent;
}

export interface ScheduleBaseline {
  [code: string]: { start: string | null; finish: string | null };
}

export interface ScheduleInput {
  tasks: readonly ScheduleTask[];
  plannedStart: string;
  calendars: readonly PinnedCalendar[];
  /** The day the progress is as of: a task that has not started cannot begin before it, and the work left of a task in progress starts on it. */
  statusDate?: string | null;
  /** The day the project must be finished by: float is measured against it instead of against the last task. */
  targetFinish?: string | null;
  /** A task is critical when its total float is at most this (default 0). */
  criticalFloatDays?: number;
  baseline?: ScheduleBaseline | null;
}

export type ScheduleFindingCode = 'CONSTRAINT_CONFLICT' | 'CONSTRAINT_VIOLATED' | 'ACTUAL_DATES_MISSING' | 'CALENDAR_UNAVAILABLE';

export interface ScheduleFinding {
  code: ScheduleFindingCode;
  /** The task the finding is about, or null for the project. */
  task: string | null;
  /** The year without a calendar, for CALENDAR_UNAVAILABLE. */
  year?: number;
}

export type ScheduledState = 'SCHEDULED' | 'COMPLETED' | 'PASS_THROUGH' | 'CALENDAR_UNAVAILABLE';

export interface ScheduledTask {
  code: string;
  kind: 'TASK' | 'MILESTONE';
  state: ScheduledState;
  /** The first working day the task works (a milestone: its day); null when it has no dates. */
  start: string | null;
  finish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  /** Position on the line of working days (slot 0 is the first working day of the line); the end is exclusive. */
  startSlot: number;
  endSlot: number;
  /** In working days; null for a task that is done or left out. */
  totalFloat: number | null;
  freeFloat: number | null;
  critical: boolean;
  drivingPredecessor: string | null;
  findings: ScheduleFinding[];
  missingYear: number | null;
  /** Working days between the baseline and this schedule (positive: later); null when there is no baseline for the task. */
  startVarianceDays: number | null;
  finishVarianceDays: number | null;
}

export interface ScheduleResult {
  tasks: ScheduledTask[];
  projectStart: string | null;
  projectFinish: string | null;
  /** The tasks whose total float is at most the threshold, in the order of their start. */
  criticalPath: string[];
  /** The chain of driving links that ends at the last task, from the first to the last (P6's "longest path"). */
  longestPath: string[];
  /** The version of each year's calendar the dates rely on, so that a later reschedule can pin the same ones. */
  calendarVersions: Array<{ year: number; version: number }>;
  findings: ScheduleFinding[];
  hash: string;
}

const invalid = (field: string): DomainError => new DomainError('PWF_SCHEDULE_INVALID', 422, field);
const MAX_LAG = 3650;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The line of working days.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface WorkingLine {
  days: string[];
  /** The first year (from the year of the line's start on) that has no calendar. */
  missingYear: number;
  /** Index of the first working day on or after `date` (the length of the line when there is none). */
  ceil(date: string): number;
  /** Index of the last working day on or before `date` (-1 when there is none). */
  floor(date: string): number;
  dateAt(index: number): string | null;
}

function lineOf(calendars: readonly PinnedCalendar[], from: string): WorkingLine {
  const byYear = new Map(calendars.map((one) => [one.year, one] as const));
  const days: string[] = [];
  const startYear = Number(from.slice(0, 4));
  let year = startYear;
  for (; byYear.has(year); year += 1) {
    const content = (byYear.get(year) as PinnedCalendar).content;
    const first = year === startYear ? dayNumber(from) : dayNumber(`${year}-01-01`);
    const last = dayNumber(`${year}-12-31`);
    for (let number = first; number <= last; number += 1) {
      const day = dayText(number);
      if (isWorkingDay(content, day)) days.push(day);
    }
  }
  const search = (date: string): number => {
    let low = 0;
    let high = days.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((days[middle] as string) < date) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    days,
    missingYear: year,
    ceil: search,
    floor: (date) => {
      const at = search(date);
      return days[at] === date ? at : at - 1;
    },
    dateAt: (index) => (index >= 0 && index < days.length ? (days[index] as string) : null),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Checking the input.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const optionalDay = (value: string | null | undefined, field: string): void => {
  if (value !== undefined && value !== null && !isWorkflowDay(value)) throw invalid(field);
};

function checkInput(input: ScheduleInput): void {
  if (!isWorkflowDay(input.plannedStart)) throw invalid('planned_start');
  optionalDay(input.statusDate, 'status_date');
  optionalDay(input.targetFinish, 'target_finish');
  const years = new Set<number>();
  for (const one of input.calendars) {
    if (years.has(one.year) || one.content.year !== one.year) throw invalid('calendars');
    years.add(one.year);
  }
  const codes = new Set<string>();
  for (const [index, one] of input.tasks.entries()) {
    const at = `tasks[${index}]`;
    if (codes.has(one.code)) throw invalid(`${at}.code`);
    codes.add(one.code);
  }
  for (const [index, one] of input.tasks.entries()) {
    const at = `tasks[${index}]`;
    if (!Number.isInteger(one.durationWorkingDays) || one.durationWorkingDays < 0 || (one.kind === 'MILESTONE' && one.durationWorkingDays !== 0)) throw invalid(`${at}.duration_working_days`);
    for (const [position, link] of one.predecessors.entries()) {
      if (!codes.has(link.task) || link.task === one.code || !Number.isInteger(link.lagWorkingDays) || Math.abs(link.lagWorkingDays) > MAX_LAG) throw invalid(`${at}.predecessors[${position}]`);
    }
    if (one.constraint !== undefined && one.constraint !== null) {
      const { constraint } = one;
      if ('date' in constraint && constraint.date !== undefined ? !isWorkflowDay(constraint.date) : !Number.isInteger(constraint.offsetWorkingDays) || (constraint.offsetWorkingDays as number) < 0) throw invalid(`${at}.constraint`);
    }
    optionalDay(one.actualStart, `${at}.actual_start`);
    optionalDay(one.actualFinish, `${at}.actual_finish`);
    const { percentComplete, remainingWorkingDays } = one;
    if (percentComplete !== undefined && percentComplete !== null && !(percentComplete >= 0 && percentComplete <= 100)) throw invalid(`${at}.percent_complete`);
    if (remainingWorkingDays !== undefined && remainingWorkingDays !== null && (!Number.isInteger(remainingWorkingDays) || remainingWorkingDays < 0)) throw invalid(`${at}.remaining_working_days`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The passes.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface Node {
  task: ScheduleTask;
  mode: 'PASS' | 'DONE' | 'ACTIVE';
  /** The duration the node takes on the line (its end minus its start). */
  s: number;
  e: number;
  driving: string | null;
  findings: ScheduleFinding[];
  ls: number;
  le: number;
  totalFloat: number | null;
  freeFloat: number | null;
  successors: Array<{ node: Node; link: ScheduleLink }>;
}

const isMilestone = (task: ScheduleTask): boolean => task.kind === 'MILESTONE';

/** The constraint with a milestone read as a finish (its date is the day it ends): start-no-earlier-than is finish-no-earlier-than, and so on. */
function constraintKind(task: ScheduleTask): ConstraintKind | null {
  const kind = task.constraint?.kind;
  if (kind === undefined) return null;
  if (!isMilestone(task)) return kind;
  return kind === 'SNET' ? 'FNET' : kind === 'SNLT' ? 'FNLT' : kind === 'MSO' ? 'MFO' : kind;
}

/** Schedules a project: forward and backward pass, float, critical path. A loop of dependencies is 422 PWF_DEPENDENCY_CYCLE, any other defect of the input 422 PWF_SCHEDULE_INVALID naming the field. */
export function scheduleProject(input: ScheduleInput): ScheduleResult {
  checkInput(input);
  const order = topologicalOrder(input.tasks.map((one) => ({ code: one.code, predecessors: one.predecessors.map((link) => ({ task: link.task })) })));
  const byCode = new Map(input.tasks.map((one) => [one.code, one] as const));

  // The line starts at the earliest date the project mentions.
  const mentioned = [input.plannedStart, ...input.tasks.flatMap((one) => [one.actualStart, one.actualFinish]), input.statusDate].filter((day): day is string => typeof day === 'string');
  const line = lineOf(input.calendars, mentioned.reduce((first, day) => (day < first ? day : first)));
  const startIdx = line.ceil(input.plannedStart);
  const statusIdx = typeof input.statusDate === 'string' ? line.ceil(input.statusDate) : null;
  const floorOf = Math.max(startIdx, statusIdx ?? startIdx);
  const thresholdFloat = input.criticalFloatDays ?? 0;

  const nodes = new Map<string, Node>();
  const resolve = (task: ScheduleTask): { kind: ConstraintKind; at: number } | null => {
    const kind = constraintKind(task);
    if (kind === null || task.constraint === undefined || task.constraint === null) return null;
    const constraint = task.constraint;
    // A date after the last working day of the line is a date nobody can place: it holds no task back, and the task is reported as unplaced.
    const at = 'date' in constraint && constraint.date !== undefined ? (kind === 'SNLT' || kind === 'FNLT' ? line.floor(constraint.date) : line.ceil(constraint.date)) : startIdx + (constraint.offsetWorkingDays as number);
    return { kind, at };
  };
  const minEnd = (task: ScheduleTask, at: number): number => (isMilestone(task) && at <= startIdx ? startIdx : at + 1);

  // Forward pass.
  for (const code of order) {
    const task = byCode.get(code) as ScheduleTask;
    const node: Node = { task, mode: 'ACTIVE', s: 0, e: 0, driving: null, findings: [], ls: 0, le: 0, totalFloat: null, freeFloat: null, successors: [] };
    nodes.set(code, node);
    const d = task.durationWorkingDays;
    const links = task.predecessors.map((link) => ({ link, node: nodes.get(link.task) as Node }));
    for (const { link, node: before } of links) before.successors.push({ node, link });
    const status = task.status ?? 'NOT_STARTED';

    // The earliest start the logic allows, and the predecessor that gives it.
    let logic = floorOf;
    let driver: string | null = null;
    let finishBound = Number.NEGATIVE_INFINITY;
    let startBoundFs = Number.NEGATIVE_INFINITY;
    for (const { link, node: before } of links) {
      const bound = link.kind === 'FS' ? before.e + link.lagWorkingDays : link.kind === 'SS' ? before.s + link.lagWorkingDays : link.kind === 'FF' ? before.e + link.lagWorkingDays - d : before.s + link.lagWorkingDays - d;
      if (bound > logic) {
        logic = bound;
        driver = link.task;
      }
      if (link.kind === 'FS') startBoundFs = Math.max(startBoundFs, bound);
      if (link.kind === 'FF') finishBound = Math.max(finishBound, before.e + link.lagWorkingDays);
      if (link.kind === 'SF') finishBound = Math.max(finishBound, before.s + link.lagWorkingDays);
    }

    if (task.excluded === true || status === 'CANCELLED') {
      node.mode = 'PASS';
      // A node of zero length sits where its predecessors end; it is not held back by the status day.
      let at = startIdx;
      for (const { link, node: before } of links) {
        const bound = link.kind === 'FS' || link.kind === 'FF' ? before.e + link.lagWorkingDays : before.s + link.lagWorkingDays;
        if (bound > at) {
          at = bound;
          node.driving = link.task;
        }
      }
      node.s = at;
      node.e = at;
      continue;
    }

    if (status === 'DONE' && typeof task.actualFinish === 'string') {
      node.mode = 'DONE';
      const finishIdx = line.floor(task.actualFinish);
      const startAt = typeof task.actualStart === 'string' ? line.ceil(task.actualStart) : Math.min(finishIdx, logic);
      node.e = Math.max(finishIdx + 1, startAt);
      node.s = isMilestone(task) ? node.e : Math.min(startAt, node.e);
      continue;
    }
    if (status === 'DONE') node.findings.push({ code: 'ACTUAL_DATES_MISSING', task: task.code });

    const constraint = resolve(task);
    const started = status === 'IN_PROGRESS' && typeof task.actualStart === 'string';
    if (status === 'IN_PROGRESS' && !started) node.findings.push({ code: 'ACTUAL_DATES_MISSING', task: task.code });

    if (started) {
      const s = line.ceil(task.actualStart as string);
      let remaining = d;
      if (typeof task.remainingWorkingDays === 'number') remaining = task.remainingWorkingDays;
      else if (typeof task.percentComplete === 'number') remaining = Math.ceil(Number(((d * (100 - task.percentComplete)) / 100).toFixed(6)));
      else if (statusIdx !== null) remaining = Math.max(0, d - Math.max(0, statusIdx - s));
      const from = Math.max(s, statusIdx ?? s, startBoundFs);
      node.s = s;
      node.e = Math.max(statusIdx === null && typeof task.remainingWorkingDays !== 'number' && typeof task.percentComplete !== 'number' ? s + d : from + remaining, finishBound, s);
      continue;
    }

    let s = logic;
    let at = driver;
    if (constraint !== null) {
      const { kind } = constraint;
      if (kind === 'SNET' && constraint.at > s) {
        s = constraint.at;
        at = null;
      } else if (kind === 'FNET' && minEnd(task, constraint.at) - d > s) {
        s = minEnd(task, constraint.at) - d;
        at = null;
      } else if (kind === 'MSO' || kind === 'MFO') {
        const forced = kind === 'MSO' ? constraint.at : minEnd(task, constraint.at) - d;
        if (logic > forced) node.findings.push({ code: 'CONSTRAINT_CONFLICT', task: task.code });
        s = forced;
        at = null;
      }
    }
    node.s = s;
    node.e = s + d;
    node.driving = at;
  }

  // Constraints that cap how late a task may be, and the ones the schedule breaks.
  const cap = (node: Node): number => {
    const constraint = resolve(node.task);
    const duration = node.e - node.s;
    if (constraint === null) return Number.POSITIVE_INFINITY;
    if (constraint.kind === 'SNLT') return constraint.at + duration;
    if (constraint.kind === 'FNLT') return constraint.at + 1;
    if (constraint.kind === 'MSO') return constraint.at + duration;
    if (constraint.kind === 'MFO') return constraint.at + 1;
    return Number.POSITIVE_INFINITY;
  };
  for (const node of nodes.values()) {
    if (node.mode !== 'ACTIVE') continue;
    const limit = cap(node);
    const kind = constraintKind(node.task);
    if ((kind === 'SNLT' || kind === 'FNLT') && node.e > limit) node.findings.push({ code: 'CONSTRAINT_VIOLATED', task: node.task.code });
  }

  // Backward pass.
  const open = [...nodes.values()].filter((node) => node.mode === 'ACTIVE');
  const projectEnd = typeof input.targetFinish === 'string' ? line.floor(input.targetFinish) + 1 : open.reduce((last, node) => Math.max(last, node.e), 0);
  for (const code of [...order].reverse()) {
    const node = nodes.get(code) as Node;
    if (node.mode === 'DONE') continue;
    const duration = node.e - node.s;
    let le = projectEnd;
    for (const { node: after, link } of node.successors) {
      if (after.mode === 'DONE') continue;
      const lag = link.lagWorkingDays;
      le = Math.min(le, link.kind === 'FS' ? after.ls - lag : link.kind === 'SS' ? after.ls - lag + duration : link.kind === 'FF' ? after.le - lag : after.le - lag + duration);
    }
    if (node.mode === 'ACTIVE') le = Math.min(le, cap(node));
    node.le = le;
    node.ls = le - duration;
    if (node.mode === 'PASS') continue;
    node.totalFloat = node.le - node.e;
    let free = projectEnd - node.e;
    for (const { node: after, link } of node.successors) {
      if (after.mode === 'DONE') continue;
      const lag = link.lagWorkingDays;
      free = Math.min(free, link.kind === 'FS' ? after.s - lag - node.e : link.kind === 'SS' ? after.s - lag - node.s : link.kind === 'FF' ? after.e - lag - node.e : after.e - lag - node.s);
    }
    node.freeFloat = Math.min(free, node.totalFloat);
  }

  // Dates, availability and the output.
  const length = line.days.length;
  const lastDay = (node: Node): number => (isMilestone(node.task) ? (node.mode === 'DONE' ? node.e - 1 : Math.max(node.e - 1, startIdx)) : node.e > node.s ? node.e - 1 : node.s);
  const findings: ScheduleFinding[] = [];
  const results = new Map<string, ScheduledTask>();
  const baseline = input.baseline ?? null;
  for (const code of order) {
    const node = nodes.get(code) as Node;
    const task = node.task;
    const last = lastDay(node);
    const placed = node.mode === 'PASS' ? false : node.s >= 0 && node.s < length && last < length && last >= 0;
    const state: ScheduledState = node.mode === 'PASS' ? 'PASS_THROUGH' : !placed ? 'CALENDAR_UNAVAILABLE' : node.mode === 'DONE' ? 'COMPLETED' : 'SCHEDULED';
    const taskFindings = [...node.findings];
    if (state === 'CALENDAR_UNAVAILABLE') {
      taskFindings.push({ code: 'CALENDAR_UNAVAILABLE', task: code, year: line.missingYear });
      if (!findings.some((one) => one.code === 'CALENDAR_UNAVAILABLE')) findings.push({ code: 'CALENDAR_UNAVAILABLE', task: null, year: line.missingYear });
    }
    const first = placed ? line.dateAt(isMilestone(task) ? last : node.s) : null;
    const finish = placed ? line.dateAt(last) : null;
    const base = baseline?.[code];
    const variance = (date: string | null, reference: string | null | undefined, pick: (value: string) => number): number | null => {
      if (date === null || reference === undefined || reference === null) return null;
      const there = pick(reference);
      const here = pick(date);
      return here >= length || there >= length || there < 0 ? null : here - there;
    };
    const late = node.mode === 'ACTIVE';
    results.set(code, {
      code,
      kind: task.kind,
      state,
      start: first,
      finish,
      lateStart: late ? line.dateAt(isMilestone(task) ? Math.max(node.le - 1, startIdx) : node.ls) : null,
      lateFinish: late ? line.dateAt(isMilestone(task) ? Math.max(node.le - 1, startIdx) : node.le - 1) : null,
      startSlot: node.s,
      endSlot: node.e,
      totalFloat: node.totalFloat,
      freeFloat: node.freeFloat,
      critical: late && node.totalFloat !== null && node.totalFloat <= thresholdFloat,
      drivingPredecessor: node.driving,
      findings: taskFindings,
      missingYear: state === 'CALENDAR_UNAVAILABLE' ? line.missingYear : null,
      startVarianceDays: variance(first, base?.start, (value) => line.ceil(value)),
      finishVarianceDays: variance(finish, base?.finish, (value) => line.floor(value)),
    });
  }

  const tasks = order.map((code) => results.get(code) as ScheduledTask);
  const dated = tasks.filter((one) => one.state === 'SCHEDULED' || one.state === 'COMPLETED');
  const complete = tasks.every((one) => one.state !== 'CALENDAR_UNAVAILABLE') && dated.length > 0;
  const finishes = dated.map((one) => one.finish as string).sort();
  const slotOrder = (left: ScheduledTask, right: ScheduledTask): number => left.startSlot - right.startSlot || left.endSlot - right.endSlot || left.code.localeCompare(right.code, 'en');
  const criticalPath = tasks.filter((one) => one.critical).sort(slotOrder).map((one) => one.code);

  // The longest path: the chain of driving links that ends at the task that ends last.
  const lastNode = open.length === 0 ? undefined : [...open].sort((left, right) => right.e - left.e || (left.totalFloat as number) - (right.totalFloat as number) || left.task.code.localeCompare(right.task.code, 'en'))[0];
  const longest: string[] = [];
  for (let cursor: Node | undefined = lastNode; cursor !== undefined; cursor = cursor.driving === null ? undefined : nodes.get(cursor.driving)) {
    if (cursor.mode === 'ACTIVE') longest.unshift(cursor.task.code);
    else if (cursor.mode === 'DONE') break;
  }

  const years = dated.flatMap((one) => [Number((one.start as string).slice(0, 4)), Number((one.finish as string).slice(0, 4))]);
  const firstYear = Math.min(...years, Number(input.plannedStart.slice(0, 4)));
  const lastYear = Math.max(...years, firstYear);
  const used = dated.length === 0 ? [] : input.calendars.filter((one) => one.year >= firstYear && one.year <= lastYear).sort((left, right) => left.year - right.year).map((one) => ({ year: one.year, version: one.version }));

  const body = {
    tasks: [...tasks].sort((left, right) => left.code.localeCompare(right.code, 'en')),
    projectStart: line.dateAt(startIdx),
    projectFinish: complete ? (finishes[finishes.length - 1] as string) : null,
    criticalPath,
    longestPath: longest,
    calendarVersions: used,
    findings,
  };
  return { ...body, tasks, hash: sha256Hex(canonicalJson(body)) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Keeping a baseline and rescheduling what is left.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The dates of a schedule as a baseline: what a later reschedule is measured against. Tasks without dates are left out. */
export function baselineOf(result: ScheduleResult): ScheduleBaseline {
  const out: ScheduleBaseline = {};
  for (const one of result.tasks) if (one.start !== null && one.finish !== null) out[one.code] = { start: one.start, finish: one.finish };
  return out;
}

export interface ScheduleChange {
  code: string;
  /** Working days the start and the finish moved (positive: later); null when either schedule has no date. */
  startShiftDays: number | null;
  finishShiftDays: number | null;
  floatChange: number | null;
  becameCritical: boolean;
  becameNonCritical: boolean;
  stateChanged: boolean;
}

/** What changed between two schedules of the same project, task by task, for the screen that previews a reschedule before it is applied. Tasks that did not change are not listed. */
export function diffSchedules(before: ScheduleResult, after: ScheduleResult, calendars: readonly PinnedCalendar[]): ScheduleChange[] {
  const dates = [before, after].flatMap((one) => one.tasks.flatMap((task) => [task.start, task.finish])).filter((day): day is string => day !== null);
  if (dates.length === 0) return [];
  const line = lineOf(calendars, dates.reduce((first, day) => (day < first ? day : first)));
  const shift = (left: string | null, right: string | null, pick: (value: string) => number): number | null => (left === null || right === null ? null : pick(right) - pick(left));
  const earlier = new Map(before.tasks.map((one) => [one.code, one] as const));
  const changes: ScheduleChange[] = [];
  for (const now of after.tasks) {
    const was = earlier.get(now.code);
    if (was === undefined) continue;
    const startShiftDays = shift(was.start, now.start, (value) => line.ceil(value));
    const finishShiftDays = shift(was.finish, now.finish, (value) => line.floor(value));
    const floatChange = was.totalFloat === null || now.totalFloat === null ? null : now.totalFloat - was.totalFloat;
    const change: ScheduleChange = {
      code: now.code,
      startShiftDays,
      finishShiftDays,
      floatChange,
      becameCritical: !was.critical && now.critical,
      becameNonCritical: was.critical && !now.critical,
      stateChanged: was.state !== now.state,
    };
    if ((startShiftDays ?? 0) !== 0 || (finishShiftDays ?? 0) !== 0 || (floatChange ?? 0) !== 0 || change.becameCritical || change.becameNonCritical || change.stateChanged) changes.push(change);
  }
  return changes;
}

export interface RescheduleInput {
  /** The schedule in force: the baseline is taken from it unless one is given. */
  before: ScheduleResult;
  input: Omit<ScheduleInput, 'baseline'>;
  baseline?: ScheduleBaseline;
}

export interface RescheduleResult {
  schedule: ScheduleResult;
  diff: ScheduleChange[];
  /** The baseline the new schedule is measured against; it is never moved by a reschedule. */
  baseline: ScheduleBaseline;
}

/** Plans again what is not done from the progress given, keeps the baseline, and lists what moved so that a person sees it before it is applied. Tasks that are done keep their actual dates. */
export function rescheduleProject(request: RescheduleInput): RescheduleResult {
  const baseline = request.baseline ?? baselineOf(request.before);
  const schedule = scheduleProject({ ...request.input, baseline });
  return { schedule, diff: diffSchedules(request.before, schedule, request.input.calendars), baseline };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// From a template to tasks, and the changes of one project.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TaskProgress {
  status?: TaskStatus;
  actualStart?: string | null;
  actualFinish?: string | null;
  remainingWorkingDays?: number | null;
  percentComplete?: number | null;
}

/** The tasks of a project from its (frozen) template and its facts: a branch the project does not have is marked left out, a constraint keeps the offset the template gives, and the progress of each task is laid on it. */
export function tasksFromTemplate(template: ProjectWorkflowTemplate, facts: ProjectFacts, progress: Readonly<Record<string, TaskProgress>> = {}): ScheduleTask[] {
  const left = new Set(activeTasks(template, facts).excluded);
  return template.tasks.map((one) => ({
    code: one.code,
    kind: one.kind,
    durationWorkingDays: one.durationWorkingDays,
    predecessors: one.predecessors.map((link) => ({ task: link.task, kind: link.kind, lagWorkingDays: link.lagWorkingDays })),
    ...(one.constraint === null ? {} : { constraint: { kind: one.constraint.kind, offsetWorkingDays: one.constraint.offsetWorkingDays } as ScheduleConstraint }),
    ...(left.has(one.code) ? { excluded: true } : {}),
    ...(progress[one.code] ?? {}),
  }));
}

export interface ProjectOverrides {
  add?: readonly ScheduleTask[];
  change?: Readonly<Record<string, Partial<ScheduleTask>>>;
  /** A removed task stays as a node of zero length, so the links around it keep the order. */
  remove?: readonly string[];
}

/** Adds, changes and removes tasks of one project without touching the template or the list given. A code that is added twice or that is not known is 422 PWF_SCHEDULE_INVALID. */
export function applyOverrides(tasks: readonly ScheduleTask[], overrides: ProjectOverrides): ScheduleTask[] {
  const known = new Set(tasks.map((one) => one.code));
  for (const added of overrides.add ?? []) {
    if (known.has(added.code)) throw invalid('add');
    known.add(added.code);
  }
  for (const code of Object.keys(overrides.change ?? {})) if (!known.has(code)) throw invalid('change');
  for (const code of overrides.remove ?? []) if (!known.has(code)) throw invalid('remove');
  const removed = new Set(overrides.remove ?? []);
  return [...tasks, ...(overrides.add ?? [])].map((one) => ({ ...one, ...(overrides.change?.[one.code] ?? {}), ...(removed.has(one.code) ? { excluded: true } : {}) }));
}
