import { canonicalJson, pwfKpi, sha256Hex } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';

/**
 * The pure part of the score of a period (PWF-3, R34): from the snapshot of the INPUTS (the tasks with the results of their KPIs and the ledger of assignments, the policy, the people of the unit) to the lines of
 * the period and the signals of gaming. The store reads the inputs from the database; the lock writes them with the figures into the snapshot and takes the hash of it; `verifySnapshot` reads them back and computes
 * the lines again, which is how "the same inputs give the same hash" is proved for any locked period, whatever has changed since. Nothing here reads the clock or the database.
 */

export const SNAPSHOT_VERSION = 1;

export interface SnapshotKpi {
  kpi_code: string;
  operation: pwfKpi.KpiOperationCode;
  state: pwfKpi.OperationState;
  value: number | null;
  score: number | null;
  weight: number;
  inputs_hash: string;
  /** The row of `task_kpi_result` the figure is, or null for the reading of a task that was still open at the end of the period (it is computed, not recorded). */
  result_id: string | null;
}

export interface SnapshotAssignment {
  membership_id: string;
  role: pwfKpi.AssignmentRole;
  from: string;
  to: string | null;
  share_pct: number;
}

export interface SnapshotTask {
  task_id: string;
  workflow_id: string;
  project_id: string;
  code: string;
  name: string;
  state: pwfKpi.StaffTaskState;
  priority: pwfKpi.TaskPriority;
  planned_working_days: number;
  window_from: string;
  window_to: string;
  kpi: SnapshotKpi[];
  assignments: SnapshotAssignment[];
  created_on: string;
  parent_key: string | null;
  baseline_due: string | null;
  finished_on: string | null;
}

export interface SnapshotInputs {
  version: typeof SNAPSHOT_VERSION;
  period: { unit_id: string; from: string; to: string; kind: pwfKpi.StaffScoringPolicy['periodKind'] };
  policy: { code: string; rule_id: string | null; version: number; params: Record<string, unknown> };
  kpi_sets: Array<{ code: string; rule_id: string | null; version: number }>;
  calendars: Array<{ year: number; version: number }>;
  workflows: Array<{ workflow_id: string; baseline_locked_on: string | null; baseline_revisions: string[] }>;
  /** The people of the unit (and under it) at the time the period was computed, with the unit each belonged to: the unit decides who may read the line. */
  members: Array<{ membership_id: string; unit_id: string }>;
  tasks: SnapshotTask[];
}

export interface LineSpan {
  role: pwfKpi.AssignmentRole;
  valid_from: string;
  valid_to: string | null;
  share_pct: number;
}

export interface LineContribution {
  task_id: string;
  task_code: string;
  name: string;
  project_id: string;
  fraction: number;
  weight: number;
  score: number;
  spans: LineSpan[];
}

export interface LineExclusion {
  task_id: string;
  task_code: string;
  reason: string;
}

export interface LineDraft {
  membership_id: string;
  unit_id: string;
  score_computed: number | null;
  rating: string | null;
  state: 'RATED' | 'NOT_RATED' | 'SMALL_SAMPLE';
  rated_task_count: number;
  effective_weight: number;
  contributions: LineContribution[];
  excluded: LineExclusion[];
}

export interface SignalDraft {
  membership_id: string;
  unit_id: string;
  code: pwfKpi.GamingFlagCode;
  task_codes: string[];
}

export interface PeriodFigures {
  lines: LineDraft[];
  signals: SignalDraft[];
  summary: { rated: number; small_sample: number; not_rated: number; people: number; mean_score: number | null; excluded_tasks: number; signals: number };
}

/** The score of a task from the results of its KPIs (the weights are re-normalised over the ones that have a score) and what was left out of it. */
export function taskScoreOfSnapshot(task: SnapshotTask): { score: number | null; leftOut: Array<{ kpiCode: string; reason: string }> } {
  return pwfKpi.taskScoreOf(task.kpi.map((one) => ({ kpiCode: one.kpi_code, operation: one.operation, state: one.state, value: one.value, score: one.score, weight: one.weight, inputsHash: one.inputs_hash })));
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** The lines and the signals of a period from its inputs. The order of the tasks and the people never changes a figure: both are sorted. */
export function computeFigures(inputs: SnapshotInputs, policy: pwfKpi.StaffScoringPolicy, calendars: WorkCalendarSource | undefined): PeriodFigures {
  const tasks = [...inputs.tasks].sort((left, right) => (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0));
  const byId = new Map(tasks.map((task) => [task.task_id, task] as const));
  // The kernel keys a task by one code; the codes of two projects can be the same, so it is given the id of the task, which is never shared.
  const people = pwfKpi.aggregateStaffPeriod({
    periodFrom: inputs.period.from,
    periodTo: inputs.period.to,
    policy,
    calendars,
    tasks: tasks.map((task) => ({
      taskCode: task.task_id,
      taskScore: taskScoreOfSnapshot(task).score,
      state: task.state,
      priority: task.priority,
      plannedWorkingDays: task.planned_working_days,
      windowFrom: task.window_from,
      windowTo: task.window_to,
      assignments: task.assignments.map((one) => ({ membershipId: one.membership_id, role: one.role, from: one.from, to: one.to, sharePct: one.share_pct })),
    })),
  });
  const unitOf = new Map(inputs.members.map((member) => [member.membership_id, member.unit_id] as const));
  const lines: LineDraft[] = [];
  for (const person of people) {
    const unit = unitOf.get(person.membershipId);
    if (unit === undefined) continue;
    const spansOf = (taskId: string): LineSpan[] =>
      (byId.get(taskId)?.assignments ?? []).filter((one) => one.membership_id === person.membershipId).map((one) => ({ role: one.role, valid_from: one.from, valid_to: one.to, share_pct: one.share_pct }));
    lines.push({
      membership_id: person.membershipId,
      unit_id: unit,
      score_computed: person.score,
      rating: person.rating,
      state: person.state,
      rated_task_count: person.ratedTaskCount,
      effective_weight: person.effectiveWeight,
      contributions: person.contributions.map((one) => {
        const task = byId.get(one.taskCode) as SnapshotTask;
        return { task_id: task.task_id, task_code: task.code, name: task.name, project_id: task.project_id, fraction: one.fraction, weight: one.weight, score: one.score, spans: spansOf(task.task_id) };
      }),
      excluded: person.excluded.map((one) => {
        const task = byId.get(one.taskCode) as SnapshotTask;
        return { task_id: task.task_id, task_code: task.code, reason: one.reason };
      }),
    });
  }
  // A member of the unit who held nothing in the period is still on the roster: NOT_RATED, never missing.
  const present = new Set(lines.map((line) => line.membership_id));
  for (const member of [...inputs.members].sort((left, right) => (left.membership_id < right.membership_id ? -1 : 1))) {
    if (!present.has(member.membership_id)) lines.push({ membership_id: member.membership_id, unit_id: member.unit_id, score_computed: null, rating: null, state: 'NOT_RATED', rated_task_count: 0, effective_weight: 0, contributions: [], excluded: [] });
  }
  lines.sort((left, right) => (left.membership_id < right.membership_id ? -1 : left.membership_id > right.membership_id ? 1 : 0));
  const signals = signalsOf(inputs, tasks, unitOf);
  const scored = lines.filter((line) => line.score_computed !== null);
  return {
    lines,
    signals,
    summary: {
      rated: lines.filter((line) => line.state === 'RATED').length,
      small_sample: lines.filter((line) => line.state === 'SMALL_SAMPLE').length,
      not_rated: lines.filter((line) => line.state === 'NOT_RATED').length,
      people: lines.length,
      mean_score: scored.length === 0 ? null : round2(scored.reduce((sum, line) => sum + (line.score_computed as number), 0) / scored.length),
      excluded_tasks: lines.reduce((sum, line) => sum + line.excluded.length, 0),
      signals: signals.length,
    },
  };
}

/** The signals of gaming, a workflow at a time (its baseline is its own), joined by person. They are for the reviewer: nothing in the lines depends on them. */
function signalsOf(inputs: SnapshotInputs, tasks: readonly SnapshotTask[], unitOf: ReadonlyMap<string, string>): SignalDraft[] {
  const merged = new Map<string, Map<pwfKpi.GamingFlagCode, Set<string>>>();
  for (const workflow of inputs.workflows) {
    const own = tasks.filter((task) => task.workflow_id === workflow.workflow_id);
    if (own.length === 0) continue;
    const found = pwfKpi.gamingSignals({
      periodFrom: inputs.period.from,
      periodTo: inputs.period.to,
      baselineLockedOn: workflow.baseline_locked_on,
      baselineRevisions: workflow.baseline_revisions.map((on) => ({ on })),
      tasks: own.map((task) => ({
        taskCode: task.task_id,
        state: task.state,
        parentCode: task.parent_key,
        createdOn: task.created_on,
        plannedWorkingDays: task.planned_working_days,
        baselineDue: task.baseline_due,
        finishedOn: task.finished_on,
        assignments: task.assignments.map((one) => ({ membershipId: one.membership_id, role: one.role, from: one.from, to: one.to })),
      })),
    });
    for (const person of found) {
      if (!unitOf.has(person.membershipId)) continue;
      const flags = merged.get(person.membershipId) ?? new Map<pwfKpi.GamingFlagCode, Set<string>>();
      for (const flag of person.flags) {
        const codes = flags.get(flag.code) ?? new Set<string>();
        for (const taskId of flag.taskCodes) codes.add(tasks.find((task) => task.task_id === taskId)?.code ?? taskId);
        flags.set(flag.code, codes);
      }
      merged.set(person.membershipId, flags);
    }
  }
  const signals: SignalDraft[] = [];
  for (const [membershipId, flags] of [...merged.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    for (const [code, taskCodes] of [...flags.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      signals.push({ membership_id: membershipId, unit_id: unitOf.get(membershipId) as string, code, task_codes: [...taskCodes].sort() });
    }
  }
  return signals;
}

/** The hash of a draft: of the inputs and the figures, never of the time they were computed at, so the same inputs give the same hash. */
export const previewHashOf = (inputs: SnapshotInputs, figures: PeriodFigures): string => sha256Hex(canonicalJson({ inputs, lines: figures.lines, signals: figures.signals }));

/** What a locked period stores: the inputs, the figures, and the instant of the cutoff of the events. */
export interface PeriodSnapshot extends SnapshotInputs {
  lines: LineDraft[];
  signals: SignalDraft[];
  cutoff_at: string;
}

export const snapshotOf = (inputs: SnapshotInputs, figures: PeriodFigures, cutoffAt: string): PeriodSnapshot => ({ ...inputs, lines: figures.lines, signals: figures.signals, cutoff_at: cutoffAt });

/** The hash that locks a period (BR-PWF-39). */
export const snapshotHashOf = (snapshot: PeriodSnapshot): string => pwfKpi.periodSnapshotHash(snapshot);

/** Reads the figures of a snapshot again from its inputs and says whether they are the ones the snapshot holds (and the hash is the one given): the proof that a locked period is reproducible. */
export function verifySnapshot(snapshot: PeriodSnapshot, hash: string, policy: pwfKpi.StaffScoringPolicy, calendars: WorkCalendarSource | undefined): { reproducible: boolean; hashMatches: boolean; figuresMatch: boolean } {
  const { lines, signals, cutoff_at: cutoffAt, ...inputs } = snapshot;
  const again = computeFigures(inputs, policy, calendars);
  const figuresMatch = canonicalJson({ lines: again.lines, signals: again.signals }) === canonicalJson({ lines, signals });
  const hashMatches = snapshotHashOf(snapshotOf(inputs, again, cutoffAt)) === hash;
  return { reproducible: figuresMatch && hashMatches, hashMatches, figuresMatch };
}
