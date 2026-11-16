import { DomainError, pwfTable, pwfWorkflow } from '@machvon/kernel';
import type { pwfSchedule } from '@machvon/kernel';
import type { TaskRow } from './pwf-schedule-support.ts';

/**
 * Extending the time limit of a task of a project (PWF-5, docs PWF 22.4, R72): what the frozen template of the workflow says of each task, the lines of one proposal as the kernel judges them (`assessExtensions`, on the whole
 * proposal), and what a line does to the limit of its task. Nothing here writes: the reschedule store previews with it, judges with it again when the proposal is decided, and spends the caps when it publishes.
 */

/** One line of a proposal: the limit of the task is raised by `addValue`, in the unit of its extension rule. */
export interface ExtensionLine {
  taskCode: string;
  addValue: number;
}

/** What the frozen template says of the extension of each of ITS tasks (null: nothing, the task behaves as before R72). A task the project added itself is not in the map. */
export type ExtensionRules = ReadonlyMap<string, pwfWorkflow.TemplateExtension | null>;

export const MAX_EXTENSION_LINES = 100;
/** The largest limit a task may have in its own unit (the bound of `duration.value` in a template). */
export const MAX_LIMIT_VALUE = 1095;
/** The bound of `project_task.duration_working_days` (V3002). */
const MAX_WORKING_DAYS = 3650;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export const extensionRulesOf = (template: pwfWorkflow.ProjectWorkflowTemplate): ExtensionRules => new Map(template.tasks.map((one) => [one.code, one.extension ?? null] as const));

/**
 * The rules of a frozen template for a READ that never needed the template before R72 (the list of tasks): a stored template the schema of today cannot read declares no rule the commands could apply (they parse it and refuse), so
 * such a list says nothing of extensions instead of failing.
 */
export function readExtensionRules(template: unknown): ExtensionRules {
  try {
    return extensionRulesOf(pwfWorkflow.parseProjectWorkflowTemplate(template));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PROJECT_WORKFLOW_TEMPLATE_INVALID') return new Map();
    throw error;
  }
}

/** The lines of a proposal, checked for their shape alone (whether they fit the caps is the kernel's judgement). */
export function checkedExtensions(lines: readonly ExtensionLine[] | undefined): ExtensionLine[] {
  if (lines === undefined) return [];
  if (!Array.isArray(lines) || lines.length > MAX_EXTENSION_LINES) throw invalid('extensions');
  return lines.map((line, index) => {
    if (typeof line?.taskCode !== 'string' || !CODE.test(line.taskCode)) throw invalid(`extensions[${index}].task_code`);
    if (!Number.isInteger(line.addValue) || line.addValue < 1 || line.addValue > MAX_LIMIT_VALUE) throw invalid(`extensions[${index}].add_value`);
    return { taskCode: line.taskCode, addValue: line.addValue };
  });
}

/** What the kernel judges the lines against: every task of the workflow with the rule of the frozen template, what its approved extensions used so far, and whether it is over (done, cancelled, or a branch the project left out). */
export const extensionSubjectsOf = (rows: readonly TaskRow[], rules: ExtensionRules): pwfTable.ExtensionSubject[] =>
  rows.map((row) => ({ code: row.code, extension: rules.get(row.code) ?? null, timesUsed: row.extensionTimesUsed, valueUsed: row.extensionValueUsed, closed: row.status === 'DONE' || row.status === 'CANCELLED' || row.excluded }));

/** The judgement of the WHOLE proposal (several lines of one task add up and count once each), on the counters as they are stored now. The same call runs when the proposal is made and again when it is approved. */
export const judgeExtensions = (rows: readonly TaskRow[], rules: ExtensionRules, lines: readonly ExtensionLine[]): pwfTable.ExtensionVerdict => pwfTable.assessExtensions(extensionSubjectsOf(rows, rules), lines);

/** What a refusal tells the caller: the task, and for a cap which one, what was used, what is asked and the cap. */
export const refusalDetails = (refusal: pwfTable.ExtensionRefusal): Record<string, unknown> => ({
  task_code: refusal.task,
  ...(refusal.limit === undefined ? {} : { limit: refusal.limit, used: refusal.used, asked: refusal.asked, max: refusal.max }),
});

/**
 * The refusal of a proposal that is being MADE: 422 with the code of the kernel and the details of the first refusal (every refusal is listed under `refusals`). A line that names a task the workflow does not have is the
 * validation error of its field, as an unknown task is everywhere else in a proposal.
 */
export function extensionRefusal(verdict: pwfTable.ExtensionVerdict, lines: readonly ExtensionLine[]): DomainError {
  const unknown = verdict.refusals.find((one) => one.code === 'PWF_EXTENSION_TASK_UNKNOWN');
  if (unknown !== undefined) return invalid(`extensions[${lines.findIndex((line) => line.taskCode === unknown.task)}].task_code`);
  const first = verdict.refusals[0] as pwfTable.ExtensionRefusal;
  return new DomainError(first.code, 422, 'extensions', { extensions: { ...refusalDetails(first), refusals: verdict.refusals.map((one) => ({ code: one.code, ...refusalDetails(one) })) } });
}

/** A change through `overrides.change` that RAISES the limit of a task whose frozen template declares an extension rule: such a raise is an extension and goes through `extensions[]`, where it is counted (no back door). */
export const extensionRequired = (taskCode: string, rule: pwfWorkflow.TemplateExtension): DomainError =>
  new DomainError('PWF_EXTENSION_REQUIRED', 422, 'overrides.change', { extensions: { task_code: taskCode, extension_allowed: rule.allowed } });

/** The limit of a task once `add` is added to it in its own unit: a task with a `duration` keeps the unit and takes the nominal working days of the new value; a task without one lasts that many working days more. */
export function raisedLimit(task: Pick<pwfSchedule.ScheduleTask, 'durationWorkingDays' | 'duration'>, add: number): { durationWorkingDays: number; duration?: pwfSchedule.ScheduleDuration } | null {
  if (task.duration === undefined || task.duration === null) {
    const days = task.durationWorkingDays + add;
    return days > MAX_LIMIT_VALUE ? null : { durationWorkingDays: days };
  }
  const value = task.duration.value + add;
  const days = pwfWorkflow.nominalWorkingDays({ value, unit: task.duration.unit });
  return value > MAX_LIMIT_VALUE || days > MAX_WORKING_DAYS ? null : { durationWorkingDays: days, duration: { ...task.duration, value } };
}

/** What each task of the proposal asks in all: its lines and their sum. */
export function extensionSums(lines: readonly ExtensionLine[]): Map<string, { times: number; value: number }> {
  const sums = new Map<string, { times: number; value: number }>();
  for (const line of lines) {
    const sum = sums.get(line.taskCode) ?? { times: 0, value: 0 };
    sums.set(line.taskCode, { times: sum.times + 1, value: sum.value + line.addValue });
  }
  return sums;
}

export interface ExtensionView {
  allowed: boolean;
  max_times: number | null;
  max_value: number | null;
  unit: pwfWorkflow.DurationUnit;
  times_used: number;
  value_used: number;
}

/** The extension rule of a task and what is used of it, for a read; undefined for a task whose frozen template declares none. */
export function extensionViewOf(row: Pick<TaskRow, 'extensionTimesUsed' | 'extensionValueUsed'>, rule: pwfWorkflow.TemplateExtension | null | undefined): ExtensionView | undefined {
  if (rule === undefined || rule === null) return undefined;
  return { allowed: rule.allowed, max_times: rule.maxTimes, max_value: rule.maxValue, unit: rule.unit, times_used: row.extensionTimesUsed, value_used: row.extensionValueUsed };
}
