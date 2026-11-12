import { SCHEDULE_STEP_KINDS, scheduleStepState } from './reporting-schedule.ts';
import type { ScheduleStepKind, ScheduleStepState, StepDeadline } from './reporting-schedule.ts';

/**
 * The status board of a period by input point (QT.02, ENT-4c): for every unit that must report, where each of the five steps of the schedule stands. The board is a read model over facts the platform already keeps (reports,
 * figure revisions, the period); it adds none. A step with no fact behind it is `NOT_TRACKED`, never "open" or "done": the review of the planning board and the push to the group system get their facts from the staged approval
 * chain (ENT-3c, `chainStepFact`) where a tenant runs one, and on every other tenant the board says so in words.
 */

/** What the platform knows about the projects of one unit in one period. */
export interface UnitPeriodFacts {
  unitId: string;
  unitCode: string;
  unitName: string;
  /** The projects of the unit that must report in the period. */
  projects: number;
  /** Of them, the ones whose figures were handed in (a report sent, or an actual submitted or accepted). */
  entered: number;
  /** The latest instant a project of the unit handed its figures in, when all of them did. */
  enteredAt: string | null;
  /** Of them, the ones whose figures were approved (the report accepted, the actual accepted). */
  approved: number;
  approvedAt: string | null;
}

/** The facts that belong to the period as a whole. `undefined` means the platform has none yet. */
export interface PeriodStepFacts {
  planningReviewAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  pushedAt?: string | null | undefined;
}

export interface ScheduleBoardStep {
  kind: ScheduleStepKind;
  dueAt: string;
  state: ScheduleStepState;
  /** How many of the unit's projects have passed the step; null for a step of the period as a whole. */
  done: number | null;
  of: number | null;
  doneAt: string | null;
}

export interface ScheduleBoardUnit {
  unitId: string;
  unitCode: string;
  unitName: string;
  projects: number;
  steps: ScheduleBoardStep[];
}

export interface ScheduleBoardResult {
  /** The steps of the period as a whole: one fact for everybody (review, close, push). */
  periodSteps: ScheduleBoardStep[];
  units: ScheduleBoardUnit[];
  /** For each step, how many units stand in each state: the row that heads the board. */
  tally: Record<ScheduleStepKind, Record<ScheduleStepState, number>>;
}

const emptyTally = (): Record<ScheduleStepState, number> => ({ DONE: 0, DONE_LATE: 0, DUE_SOON: 0, OPEN: 0, OVERDUE: 0, NOT_TRACKED: 0 });

/** Entry and unit approval are facts of the projects of a unit; the other steps are facts of the period. */
const UNIT_STEPS: readonly ScheduleStepKind[] = ['ENTRY', 'UNIT_APPROVAL'];

function unitStep(kind: 'ENTRY' | 'UNIT_APPROVAL', deadline: StepDeadline, unit: UnitPeriodFacts, now: Date): ScheduleBoardStep {
  const done = kind === 'ENTRY' ? unit.entered : unit.approved;
  const doneAt = kind === 'ENTRY' ? unit.enteredAt : unit.approvedAt;
  // A unit with no project that must report has nothing to hand in or approve: there is no fact to show.
  if (unit.projects === 0) return { kind, dueAt: deadline.dueAt, state: 'NOT_TRACKED', done, of: 0, doneAt: null };
  const finished = done >= unit.projects;
  return { kind, dueAt: deadline.dueAt, state: scheduleStepState(deadline.dueAt, finished ? (doneAt ?? new Date(0).toISOString()) : null, now), done, of: unit.projects, doneAt: finished ? doneAt : null };
}

function periodStep(kind: ScheduleStepKind, deadline: StepDeadline, facts: PeriodStepFacts, now: Date): ScheduleBoardStep {
  const doneAt = kind === 'PLANNING_REVIEW' ? facts.planningReviewAt : kind === 'PERIOD_CLOSE' ? facts.closedAt : facts.pushedAt;
  return { kind, dueAt: deadline.dueAt, state: scheduleStepState(deadline.dueAt, doneAt, now), done: null, of: null, doneAt: doneAt ?? null };
}

/** Puts the facts of a period against the deadlines of its schedule. */
export function buildBoard(deadlines: readonly StepDeadline[], units: readonly UnitPeriodFacts[], period: PeriodStepFacts, now: Date): ScheduleBoardResult {
  const byKind = new Map(deadlines.map((deadline) => [deadline.kind, deadline]));
  const periodSteps = SCHEDULE_STEP_KINDS.filter((kind) => !UNIT_STEPS.includes(kind) && byKind.has(kind)).map((kind) => periodStep(kind, byKind.get(kind) as StepDeadline, period, now));
  const tally = Object.fromEntries(SCHEDULE_STEP_KINDS.map((kind) => [kind, emptyTally()])) as ScheduleBoardResult['tally'];
  const rows = units.map((unit): ScheduleBoardUnit => {
    const steps = SCHEDULE_STEP_KINDS.filter((kind) => byKind.has(kind)).map((kind): ScheduleBoardStep => {
      if (kind === 'ENTRY' || kind === 'UNIT_APPROVAL') return unitStep(kind, byKind.get(kind) as StepDeadline, unit, now);
      return periodSteps.find((step) => step.kind === kind) as ScheduleBoardStep;
    });
    for (const step of steps) tally[step.kind][step.state] += 1;
    return { unitId: unit.unitId, unitCode: unit.unitCode, unitName: unit.unitName, projects: unit.projects, steps };
  });
  return { periodSteps, units: rows, tally };
}

/** How many reports of a period run a chain with one kind of step, how many of them passed it, and the latest instant one did. */
export interface ChainStepCount {
  total: number;
  passed: number;
  doneAt: string | null;
}

/**
 * The fact of a period step that the staged approval chain keeps (the review of the planning board, the push), read from the instances of the reports of the period: `undefined` when no report runs a chain with
 * that step (a tenant on the single decision has none: the platform has no fact, and the board says so), `null` while a report has not passed it, and the instant the last report did once all have. A step whose
 * instant is not known is never shown as done.
 */
export function chainStepFact(count: ChainStepCount): string | null | undefined {
  if (count.total === 0) return undefined;
  return count.passed >= count.total ? count.doneAt : null;
}
