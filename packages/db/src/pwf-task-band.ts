import { BUILTIN_POLICY_VERSION, pwfDeadlineBand } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';
import type { BandPolicySet } from './pwf-band-policies.ts';

/**
 * The ONE resolution of the official ladder and colour of a task of a project (PWF-5, R59, R73): the ladder the frozen template of the project gave this very task (the columns `band_*` of `project_task`, tier `STEP`), else
 * the rule `DEADLINE_BAND_POLICY` in force for the unit of the project on the day of the read (`POLICY_OVERRIDE` when one of its overrides fits the task, else `POLICY`), else the built-in default of the source (`SYSTEM`: nobody
 * approved a rule for the tenant or the unit). Every read that colours a task goes through here: the list and the detail of the tasks, "my tasks", the deadline board (its counts, its colour filter and its file), the reminders and
 * the alert centre. Two reads of one task on one day therefore cannot disagree. What a person set for themselves is not a tier of the official colour (R40) and is merged by the caller that shows a personal colour.
 */

/** The columns of `project_task` that carry the frozen ladder, as the database returns them. */
export interface TaskBandColumns {
  band_tier: string | null;
  band_green_days: number | null;
  band_yellow_days: number | null;
  band_red_days: number | null;
}

/** The band columns of the alias `alias`, for a select list or a `group by`. */
export const bandColumnsOf = (alias: string): string => `${alias}.band_tier, ${alias}.band_green_days, ${alias}.band_yellow_days, ${alias}.band_red_days`;

/** A value no ladder can hold (red is at least -1), standing for "no line" where SQL compares keys and NULL would never match. */
export const NO_LINE = -2;

/**
 * The band columns of the alias as one key of three numbers a row is grouped and matched by: two tasks with the same day and different ladders are never one group (R73). The tier adds nothing to the key: a ladder is stored
 * exactly when the tier is (the check of the table).
 */
export const bandKeyOf = (alias: string): string => `coalesce(${alias}.band_green_days, ${NO_LINE}), coalesce(${alias}.band_yellow_days, ${NO_LINE}), coalesce(${alias}.band_red_days, ${NO_LINE})`;

/** The three numbers of `bandKeyOf` for a row read by the application. */
export const bandKeyValues = (row: TaskBandColumns): [number, number, number] => [row.band_green_days ?? NO_LINE, row.band_yellow_days ?? NO_LINE, row.band_red_days ?? NO_LINE];

/**
 * A bound in SQL on the tasks that can have a colour today: within `horizon` (a parameter of the day the widest green line of the POLICIES reaches) for a task that follows the policy, and for a task with a ladder of its own
 * within a number of calendar days that is never short of its own green line in working days (a week for five of them and a month of margin, the conservative edge of `windowEdge`); a ladder without a green line is always green.
 */
export const withinGreenLine = (alias: string, due: string, horizon: string, today: string): string =>
  `(case when ${alias}.band_tier is null then ${due} <= ${horizon}::date else ${alias}.band_green_days is null or ${due} <= ${today}::date + (${alias}.band_green_days + 1) * 7 + 30 end)`;

/** The ladder the frozen template gave the task, or null when the task follows the policy. */
export function stepLadderOf(row: TaskBandColumns): pwfDeadlineBand.BandThresholds | null {
  if (row.band_tier === null || row.band_yellow_days === null || row.band_red_days === null) return null;
  return { green_days: row.band_green_days, yellow_days: Number(row.band_yellow_days), red_days: Number(row.band_red_days) };
}

/** What a task is judged on: what it is (the overrides of a policy match on it), the unit that owns its project (the nearest rule wins) and the ladder of its own. */
export interface TaskBandSubject {
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  phaseCode: string;
  unitPath: string | null;
  step: pwfDeadlineBand.BandThresholds | null;
}

export interface TaskLadder extends pwfDeadlineBand.OfficialThresholds {
  /** The policy in force for the unit of the project: the unit of the days, the reminder points and the escalation are always its own (R73), whatever tier gave the ladder. */
  policy: pwfDeadlineBand.BandPolicy;
}

/** The official ladder of a task and the tier that gave it. */
export function officialTaskLadder(policies: BandPolicySet, subject: TaskBandSubject): TaskLadder {
  const policy = policies.forUnitPath(subject.unitPath);
  const context: pwfDeadlineBand.BandContext = { taskKind: subject.kind, priority: subject.priority, phase: subject.phaseCode };
  // The rule that decided is the built-in default of the source when nobody approved one for the tenant or a unit above the project: that is the tier SYSTEM, and its ladder is the one the default gives this task.
  const builtin = policies.versionForUnitPath(subject.unitPath) === BUILTIN_POLICY_VERSION;
  const official = pwfDeadlineBand.officialThresholds({ step: subject.step, system: pwfDeadlineBand.policyThresholds(policy, context).thresholds, ...(builtin ? {} : { policy }) }, context);
  return { ...official, policy };
}

export interface TaskBandClock {
  today: string;
  calendars: WorkCalendarSource | undefined;
}

export interface TaskBand extends TaskLadder {
  result: pwfDeadlineBand.DeadlineBandResult;
}

/** The official colour of a task on a day: its ladder (above) on its official deadline, counted in the unit the source declares on the published calendars. */
export function officialTaskBand(policies: BandPolicySet, subject: TaskBandSubject, dueOn: string | null, clock: TaskBandClock): TaskBand {
  const ladder = officialTaskLadder(policies, subject);
  return { ...ladder, result: pwfDeadlineBand.deadlineBand({ dueOn, today: clock.today, unit: ladder.policy.unit, calendars: clock.calendars, thresholds: ladder.thresholds }) };
}

/** The contract fields that say where a colour came from: the tier and the ladder that was used. */
export interface BandExplanation {
  band_tier: pwfDeadlineBand.BandTier;
  band_thresholds: pwfDeadlineBand.BandThresholds;
}

export const bandExplanationOf = (ladder: pwfDeadlineBand.OfficialThresholds): BandExplanation => ({ band_tier: ladder.tier, band_thresholds: { green_days: ladder.thresholds.green_days, yellow_days: ladder.thresholds.yellow_days, red_days: ladder.thresholds.red_days } });

/** The columns of `project_task` that carry the time limit of a task in its own unit (R58). */
export interface TaskDurationColumns {
  duration_value: number | null;
  duration_unit: string | null;
  duration_roll: boolean | null;
  effective_working_days: number | null;
}

export const durationColumnsOf = (alias: string): string => `${alias}.duration_value, ${alias}.duration_unit, ${alias}.duration_roll, ${alias}.effective_working_days`;

export interface DurationView {
  value: number;
  unit: 'WORKING_DAY' | 'CALENDAR_DAY' | 'MONTH';
  roll_to_working_day: boolean;
}

/** The contract fields of the limit of a task: `duration` is null for a task whose limit is `duration_working_days` alone. */
export const durationViewOf = (row: TaskDurationColumns): { duration: DurationView | null; effective_working_days: number | null } => ({
  duration: row.duration_value === null || row.duration_unit === null ? null : { value: Number(row.duration_value), unit: row.duration_unit as DurationView['unit'], roll_to_working_day: row.duration_roll === true },
  effective_working_days: row.effective_working_days === null ? null : Number(row.effective_working_days),
});
