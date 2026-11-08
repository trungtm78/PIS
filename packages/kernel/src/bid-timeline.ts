import { workflowAddDays, workflowDaysBetween, addWorkingDays, workingDaysBetween } from './bid-workflow.ts';
import type { EntryKind, ExitKind, WorkflowDefinition } from './bid-workflow.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The day-by-day timeline of a package under its workflow (PRC-1, "process tree"): every change of state, who made it, how long the package had spent in the state it left, the reason, the evidence, the items of the checklist completed
 * that day, the holds, exceptions, returns and corrections, the milestones that came in by hand or from a file of the national bidding network, and the days a clock ran out. `buildPackageTimeline` is the one function that builds it; it
 * only READS facts (the append-only history of the steps, the items, the log of the workflow, the milestones): nothing here is stored or edited, so a timeline is the same every time it is built from the same facts.
 * The same module builds the day groups (`groupTimelineByDay`), the filters (`filterTimeline`), the summary text data (`timelineSummary`), the planned-versus-actual strip (`ganttOf`) and the merged feed of a node of the tree (`mergeRecentChanges`).
 */

export const TIMELINE_KINDS = ['START', 'STATE_CHANGE', 'RETURN', 'CORRECTION', 'CHECKLIST_DONE', 'HOLD', 'RESUME', 'EXCEPTION', 'ASSIGNMENT', 'MILESTONE', 'IMPORT', 'CLOCK_OVERDUE', 'CANCEL', 'COMPLETE'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
/** The kinds that are a change of the state of the package (the "only state changes" filter). */
export const STATE_CHANGE_KINDS: readonly TimelineKind[] = ['START', 'STATE_CHANGE', 'RETURN', 'CORRECTION', 'HOLD', 'RESUME', 'CANCEL', 'COMPLETE'];

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
export const timelineDayOf = (instant: string): string => new Date(Date.parse(instant) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

export interface TimelineVisitFact {
  /** The number of the visit of the package (1, 2, 3 ...; a return makes a new visit). */
  visit: number;
  stepCode: string;
  enteredAt: string;
  enteredBy: string | null;
  entryKind: EntryKind;
  exitedAt: string | null;
  exitedBy: string | null;
  exitKind: ExitKind | null;
  dueOn: string | null;
  note: string | null;
}

export interface TimelineEvidence {
  kind: string;
  documentId: string | null;
  milestoneKind: string | null;
  reference: string | null;
}

export interface TimelineItemFact {
  stepCode: string;
  itemCode: string;
  name: string;
  required: boolean;
  dueOn: string | null;
  completedAt: string | null;
  completedBy: string | null;
  status: 'OPEN' | 'DONE' | 'WAIVED';
  evidence: readonly TimelineEvidence[];
}

export const LOG_KINDS = ['HOLD', 'RESUME', 'ASSIGN_OWNER', 'REASSIGN_OWNER', 'EXCEPTION_REQUESTED', 'EXCEPTION_APPROVED', 'EXCEPTION_REJECTED', 'CORRECTION', 'CANCEL', 'ASSIGN_ITEM'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface TimelineLogFact {
  kind: LogKind;
  at: string;
  actor: string | null;
  stepCode: string | null;
  reason: string | null;
  /** The person an assignment is to, when it is one. */
  subject: string | null;
}

export interface TimelineMilestoneFact {
  kind: string;
  actualAt: string;
  source: 'MANUAL' | 'IMPORT';
  importBatchId: string | null;
}

export interface TimelineInput {
  definition: WorkflowDefinition;
  startedAt: string;
  startedBy: string | null;
  completedAt: string | null;
  visits: readonly TimelineVisitFact[];
  items: readonly TimelineItemFact[];
  log: readonly TimelineLogFact[];
  milestones: readonly TimelineMilestoneFact[];
  /** The day the timeline is read on (clock events are only those that have happened by then). */
  today: string;
}

export interface TimelineEntry {
  /** A stable id of the entry inside the timeline (kind, instant, and what it is about). */
  id: string;
  kind: TimelineKind;
  /** The instant (ISO) and the Vietnam day of it. */
  at: string;
  day: string;
  from: string | null;
  to: string | null;
  actor: string | null;
  /** How long the package had been in the state it left, in calendar days (and working days when the calendar is published); null when the entry is not a change of state. */
  spentCalendarDays: number | null;
  spentWorkingDays: number | null;
  reason: string | null;
  evidence: readonly TimelineEvidence[];
  /** The item of the checklist, for `CHECKLIST_DONE`, and the milestone kind, for `MILESTONE` and `IMPORT`. */
  subject: string | null;
  stateChange: boolean;
}

const rankOf = (kind: TimelineKind): number => (STATE_CHANGE_KINDS.includes(kind) ? 0 : 1);

/**
 * Builds the timeline, oldest first. Rules: the start is the first entry; each visit that ends makes one entry (the move out of its step: ADVANCE is `STATE_CHANGE`, RETURN `RETURN`, a corrected visit `CORRECTION`, the last is `COMPLETE`, a cancelled
 * one `CANCEL`) carrying the days the package spent in the visit it left; each item completed is `CHECKLIST_DONE` with its evidence; each log row is its own entry; each milestone with an actual date is `MILESTONE` (`IMPORT` when a file
 * of the national bidding network wrote it); and a step whose due day has passed without the visit ending gives one `CLOCK_OVERDUE` entry on the day after the due day (so the day a clock ran out is on the timeline, derived, not stored).
 * Entries of one instant come with the changes of state first.
 */
export function buildPackageTimeline(input: TimelineInput, calendars?: WorkCalendarSource): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const push = (entry: Omit<TimelineEntry, 'day' | 'stateChange'>): void => {
    entries.push({ ...entry, day: timelineDayOf(entry.at), stateChange: STATE_CHANGE_KINDS.includes(entry.kind) });
  };
  const visits = [...input.visits].sort((left, right) => left.visit - right.visit);
  const first = visits[0];
  push({ id: `START:${input.startedAt}`, kind: 'START', at: input.startedAt, from: null, to: first?.stepCode ?? null, actor: input.startedBy, spentCalendarDays: null, spentWorkingDays: null, reason: null, evidence: [], subject: null });

  const spent = (visit: TimelineVisitFact, exitedAt: string): { calendar: number; working: number | null } => {
    const enteredOn = timelineDayOf(visit.enteredAt);
    const exitedOn = timelineDayOf(exitedAt);
    return { calendar: Math.max(0, workflowDaysBetween(enteredOn, exitedOn)), working: workingDaysBetween(calendars, enteredOn, exitedOn) ?? null };
  };

  visits.forEach((visit, index) => {
    if (visit.exitedAt === null || visit.exitKind === null) return;
    const next = visits[index + 1];
    const days = spent(visit, visit.exitedAt);
    const kind: TimelineKind = visit.exitKind === 'ADVANCE' ? 'STATE_CHANGE' : visit.exitKind === 'RETURN' ? 'RETURN' : visit.exitKind === 'CORRECTED' ? 'CORRECTION' : visit.exitKind === 'CANCEL' ? 'CANCEL' : 'COMPLETE';
    push({
      id: `${kind}:${visit.exitedAt}:${visit.visit}`,
      kind,
      at: visit.exitedAt,
      from: visit.stepCode,
      to: visit.exitKind === 'COMPLETE' || visit.exitKind === 'CANCEL' ? null : (next?.stepCode ?? null),
      actor: visit.exitedBy,
      spentCalendarDays: days.calendar,
      spentWorkingDays: days.working,
      reason: next?.note ?? visit.note,
      evidence: [],
      subject: null,
    });
  });

  for (const item of input.items) {
    if (item.status !== 'DONE' || item.completedAt === null) continue;
    push({ id: `ITEM:${item.completedAt}:${item.stepCode}:${item.itemCode}`, kind: 'CHECKLIST_DONE', at: item.completedAt, from: item.stepCode, to: item.stepCode, actor: item.completedBy, spentCalendarDays: null, spentWorkingDays: null, reason: null, evidence: item.evidence, subject: item.itemCode });
  }

  const LOG_TO_KIND: Readonly<Record<LogKind, TimelineKind>> = { HOLD: 'HOLD', RESUME: 'RESUME', ASSIGN_OWNER: 'ASSIGNMENT', REASSIGN_OWNER: 'ASSIGNMENT', ASSIGN_ITEM: 'ASSIGNMENT', EXCEPTION_REQUESTED: 'EXCEPTION', EXCEPTION_APPROVED: 'EXCEPTION', EXCEPTION_REJECTED: 'EXCEPTION', CORRECTION: 'CORRECTION', CANCEL: 'CANCEL' };
  input.log.forEach((row, index) => {
    // A cancellation and a correction are already a move out of a visit above; the log row only adds the reason when that visit carries none, so it is not a second state change.
    if (row.kind === 'CANCEL' || row.kind === 'CORRECTION') return;
    push({ id: `LOG:${row.kind}:${row.at}:${index}`, kind: LOG_TO_KIND[row.kind], at: row.at, from: row.stepCode, to: row.stepCode, actor: row.actor, spentCalendarDays: null, spentWorkingDays: null, reason: row.reason, evidence: [], subject: row.kind });
  });

  for (const milestone of input.milestones) {
    push({ id: `MILESTONE:${milestone.kind}:${milestone.actualAt}`, kind: milestone.source === 'IMPORT' ? 'IMPORT' : 'MILESTONE', at: milestone.actualAt, from: null, to: null, actor: null, spentCalendarDays: null, spentWorkingDays: null, reason: milestone.importBatchId, evidence: [{ kind: 'MILESTONE', documentId: null, milestoneKind: milestone.kind, reference: milestone.importBatchId }], subject: milestone.kind });
  }

  for (const visit of visits) {
    if (visit.dueOn === null) continue;
    const overdueOn = workflowAddDays(visit.dueOn, 1);
    const ended = visit.exitedAt === null ? null : timelineDayOf(visit.exitedAt);
    if (overdueOn > input.today || (ended !== null && ended <= visit.dueOn)) continue;
    push({ id: `OVERDUE:${visit.visit}`, kind: 'CLOCK_OVERDUE', at: `${overdueOn}T00:00:00.000+07:00`, from: visit.stepCode, to: visit.stepCode, actor: null, spentCalendarDays: null, spentWorkingDays: null, reason: visit.dueOn, evidence: [], subject: null });
  }

  return entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || rankOf(left.kind) - rankOf(right.kind) || left.id.localeCompare(right.id));
}

export interface TimelineFilter {
  fromDay?: string | undefined;
  toDay?: string | undefined;
  actor?: string | undefined;
  onlyStateChanges?: boolean | undefined;
}

export function filterTimeline(entries: readonly TimelineEntry[], filter: TimelineFilter): TimelineEntry[] {
  return entries.filter((entry) => (filter.fromDay === undefined || entry.day >= filter.fromDay) && (filter.toDay === undefined || entry.day <= filter.toDay) && (filter.actor === undefined || entry.actor === filter.actor) && (filter.onlyStateChanges !== true || entry.stateChange));
}

export interface TimelineDay {
  day: string;
  entries: readonly TimelineEntry[];
  stateChanges: number;
  checklistDone: number;
}

/** The entries grouped by Vietnam day; `newestFirst` reverses the days and the entries inside each (the feed order). */
export function groupTimelineByDay(entries: readonly TimelineEntry[], newestFirst = false): TimelineDay[] {
  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const group = days.get(entry.day);
    if (group === undefined) days.set(entry.day, [entry]);
    else group.push(entry);
  }
  const result = [...days.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([day, group]): TimelineDay => ({ day, entries: newestFirst ? [...group].reverse() : group, stateChanges: group.filter((entry) => entry.stateChange).length, checklistDone: group.filter((entry) => entry.kind === 'CHECKLIST_DONE').length }));
  return newestFirst ? result.reverse() : result;
}

export interface StepSummary {
  stepCode: string;
  order: number;
  /** The days the package spent in the step across all its visits (a returned step adds up): working days when every visit has them, else calendar days. */
  days: number;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  standardWorkingDays: number;
  /** Days over the standard, 0 when within it; with calendar days as the basis the number is a calendar count and the screen says so. */
  daysOver: number;
  current: boolean;
}

/** "12 days in step 3, 4 days late against the standard": one row per step the package has been in, from its visits (an open visit counts up to `today`). */
export function timelineSummary(definition: WorkflowDefinition, visits: readonly TimelineVisitFact[], today: string, calendars?: WorkCalendarSource): StepSummary[] {
  const byStep = new Map<string, { calendar: number; working: number | null; current: boolean }>();
  for (const visit of visits) {
    const from = timelineDayOf(visit.enteredAt);
    const to = visit.exitedAt === null ? today : timelineDayOf(visit.exitedAt);
    const calendar = Math.max(0, workflowDaysBetween(from, to));
    const working = workingDaysBetween(calendars, from, to) ?? null;
    const held = byStep.get(visit.stepCode);
    byStep.set(visit.stepCode, { calendar: (held?.calendar ?? 0) + calendar, working: held === undefined ? working : held.working === null || working === null ? null : held.working + working, current: (held?.current ?? false) || visit.exitedAt === null });
  }
  const rows: StepSummary[] = [];
  for (const step of definition.steps) {
    const found = byStep.get(step.code);
    if (found === undefined) continue;
    const working = found.working !== null;
    const days = working ? (found.working as number) : found.calendar;
    rows.push({ stepCode: step.code, order: step.order, days, basis: working ? 'WORKING_DAYS' : 'CALENDAR_DAYS', standardWorkingDays: step.standardWorkingDays, daysOver: Math.max(0, days - step.standardWorkingDays), current: found.current });
  }
  return rows;
}

export interface GanttBar {
  stepCode: string;
  order: number;
  /** The bar the standard says: from the day the package entered the first step plus the standard days of the steps before, to that plus the standard days of this one; null when the working calendar is not published (a plan is never guessed). */
  planned: { startOn: string; endOn: string } | null;
  /** The bar that happened: from the first day in the step to the day the last visit ended (or today). Null for a step not reached. */
  actual: { startOn: string; endOn: string; open: boolean } | null;
}

export function ganttOf(definition: WorkflowDefinition, visits: readonly TimelineVisitFact[], today: string, calendars?: WorkCalendarSource): GanttBar[] {
  const ordered = [...visits].sort((left, right) => left.visit - right.visit);
  const origin = ordered[0] === undefined ? null : timelineDayOf(ordered[0].enteredAt);
  let cursor: string | null = origin;
  return definition.steps.map((step): GanttBar => {
    const mine = ordered.filter((visit) => visit.stepCode === step.code);
    let planned: GanttBar['planned'] = null;
    if (cursor !== null) {
      const end = addWorkingDays(calendars, cursor, step.standardWorkingDays);
      planned = end === undefined ? null : { startOn: cursor, endOn: end };
      cursor = end ?? null;
    }
    const firstVisit = mine[0];
    const last = mine[mine.length - 1];
    const actual: GanttBar['actual'] = firstVisit === undefined || last === undefined ? null : { startOn: timelineDayOf(firstVisit.enteredAt), endOn: last.exitedAt === null ? today : timelineDayOf(last.exitedAt), open: last.exitedAt === null };
    return { stepCode: step.code, order: step.order, planned, actual };
  });
}

/** An entry of the feed of a node of the tree: the entry and the package it is about. */
export interface FeedEntry {
  packageId: string;
  entry: TimelineEntry;
}

/** The most recent changes across packages (the feed of a node): only changes of state by default, newest first, `limit` of them; entries of one instant keep a fixed order (package id) so a page boundary never repeats or drops one. */
export function mergeRecentChanges(feeds: ReadonlyMap<string, readonly TimelineEntry[]>, limit: number, onlyStateChanges = true): FeedEntry[] {
  const all: FeedEntry[] = [];
  for (const [packageId, entries] of feeds) for (const entry of entries) if (!onlyStateChanges || entry.stateChange) all.push({ packageId, entry });
  return all.sort((left, right) => Date.parse(right.entry.at) - Date.parse(left.entry.at) || left.packageId.localeCompare(right.packageId) || left.entry.id.localeCompare(right.entry.id)).slice(0, limit);
}
