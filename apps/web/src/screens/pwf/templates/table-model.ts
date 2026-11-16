import type { TemplatePhase } from '../model';
import { provisionalCode, workflowCodeFrom } from './codes-model';
import {
  MAX_PHASES,
  MAX_STEPS,
  MAX_TASKS,
  fresh,
  hasSteps,
  isPending,
  nominalWorkingDays,
  pending,
  removePhase,
  removeTask,
  renamePhase,
  renameStep,
  renameTask,
  settled,
  stepsOf,
  uidOf,
} from './template-model';
import type { DurationUnit, EditorBands, EditorStep, EditorTask, LegalBasisInput, ResponsibleUnit, TaskDuration, Template, TemplateParty, TemplateRole } from './template-model';

/**
 * The table of steps of the editor (PWF-02, PWF 22): one row is one step of the procedure. This file is the pure side of that table: which rows a template shows, and what each cell writes. Every edit writes only
 * the field the person used, so a template nobody touched in a column keeps its params and its hash (R62), and no edit ever asks for a code (R63).
 */

// ---- the rows ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TableLine {
  /** `step:<code>` or `task:<code>`: what an anchor names. It changes when a row that was added is given its code. */
  key: string;
  /** What the screen draws the row by: it never changes while the row is in the editor. */
  uid: string;
  kind: 'step' | 'task';
  /** The number people read: `3` for a row of the table, `3.2` for a task under a step that has several. */
  number: string;
  /** A task shown under its step (the step has more than one). */
  child: boolean;
  stepIndex: number | null;
  /** The one task the cells of the row edit; null for a step with several tasks (its row is read-only, the tasks are the rows under it) and for a step that has none yet. */
  taskIndex: number | null;
  /** Every task of the row. */
  taskIndexes: number[];
  name: string;
  code: string;
  phase: string;
}

export interface TableGroup {
  phaseIndex: number | null;
  phase: TemplatePhase | null;
  lines: TableLine[];
}

/** A template is written with steps when it names some, and a template that has nothing yet starts that way (a row of the new table is a step with one task). A template of tasks alone stays in its two tiers (R64). */
export const usesSteps = (template: Template): boolean => hasSteps(template) || template.tasks.length === 0;

/**
 * The rows of the table under their phase. A step with exactly one task is one row (the cells edit that task); a step with several is a read-only row followed by its tasks; a template without steps shows each task as
 * a row under its phase. Tasks that name no step of their phase, and tasks of a phase that is not there, are still shown (nothing a template holds is hidden).
 */
export function tableOf(template: Template): TableGroup[] {
  const steps = stepsOf(template);
  const withSteps = steps.length > 0;
  let counter = 0;
  const taskLine = (index: number, number: string, child: boolean, stepIndex: number | null): TableLine => {
    const task = template.tasks[index] as EditorTask;
    return { key: `task:${task.code}`, uid: uidOf(task) ?? `task:${task.code}`, kind: 'task', number, child, stepIndex, taskIndex: index, taskIndexes: [index], name: task.name, code: task.code, phase: task.phase };
  };
  const linesOf = (phase: string | null): TableLine[] => {
    const known = new Set(template.phases.map((one) => one.code));
    const inPhase = (code: string): boolean => (phase === null ? !known.has(code) : code === phase);
    const lines: TableLine[] = [];
    if (!withSteps) {
      template.tasks.forEach((task, index) => {
        if (inPhase(task.phase)) lines.push(taskLine(index, String((counter += 1)), false, null));
      });
      return lines;
    }
    const placed = new Set<number>();
    steps.forEach((step, stepIndex) => {
      if (!inPhase(step.phase)) return;
      const own = template.tasks.flatMap((task, index) => (task.step === step.code ? [index] : []));
      own.forEach((index) => placed.add(index));
      const number = String((counter += 1));
      lines.push({ key: `step:${step.code}`, uid: uidOf(step) ?? `step:${step.code}`, kind: 'step', number, child: false, stepIndex, taskIndex: own.length === 1 ? (own[0] as number) : null, taskIndexes: own, name: step.name, code: step.code, phase: step.phase });
      if (own.length > 1) own.forEach((index, at) => lines.push(taskLine(index, `${number}.${at + 1}`, true, stepIndex)));
    });
    // A task of the phase that names no step of the template: shown after the steps, so that it can be seen and put right.
    const stepCodes = new Set(steps.map((step) => step.code));
    template.tasks.forEach((task, index) => {
      if (inPhase(task.phase) && !placed.has(index) && (task.step === undefined || task.step === null || !stepCodes.has(task.step))) lines.push(taskLine(index, String((counter += 1)), false, null));
    });
    return lines;
  };
  const groups: TableGroup[] = template.phases.map((phase, phaseIndex) => ({ phaseIndex, phase, lines: linesOf(phase.code) }));
  const orphans = linesOf(null);
  return orphans.length === 0 ? groups : [...groups, { phaseIndex: null, phase: null, lines: orphans }];
}

export const linesOf = (template: Template): TableLine[] => tableOf(template).flatMap((group) => group.lines);
export const lineOf = (template: Template, key: string): TableLine | undefined => linesOf(template).find((line) => line.key === key);

// ---- adding, naming and coding rows ------------------------------------------------------------------------------------------------------------------------------------

const blankTask = (code: string, phase: string): EditorTask => ({
  code,
  name: '',
  phase,
  kind: 'TASK',
  duration_working_days: 1,
  required: true,
  responsible_role: '',
  approver_role: null,
  priority: 'NORMAL',
  predecessors: [],
  constraint: null,
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
});

/** What a new row takes from the row above: who does it, the time limit with its unit, the three colours and whether it may be extended. Never its name, its documents, its legal grounds or its links. */
function copiedFrom(above: EditorTask | undefined): Partial<EditorTask> {
  if (above === undefined) return {};
  return {
    responsible_role: above.responsible_role,
    duration_working_days: above.kind === 'MILESTONE' ? 1 : above.duration_working_days,
    ...(above.duration === undefined || above.kind === 'MILESTONE' ? {} : { duration: { ...above.duration } }),
    ...(above.bands === undefined ? {} : { bands: { ...above.bands } }),
    ...(above.responsible_units === undefined ? {} : { responsible_units: above.responsible_units.map((unit) => ({ ...unit })) }),
    ...(above.extension === undefined ? {} : { extension: { ...above.extension } }),
  };
}

export interface Added {
  template: Template;
  /** The key of the new row (the screen puts the caret in its name). */
  key: string;
}

/**
 * Adds a row at the end of a phase. It copies the row above (the last row of the phase, else the last row before it) and starts when that row is done; the first row of a template starts with the project. The row has
 * no name yet, so its code is provisional and is made from the name when the name is given (`settleCodes`).
 */
export function addRow(template: Template, phaseCode: string): Added | undefined {
  if (template.tasks.length >= MAX_TASKS || !template.phases.some((phase) => phase.code === phaseCode)) return undefined;
  const groups = tableOf(template);
  const at = groups.findIndex((group) => group.phase?.code === phaseCode);
  const before = groups.slice(0, at + 1).flatMap((group) => group.lines.filter((line) => !line.child));
  const above = before[before.length - 1];
  const aboveTask = above === undefined ? undefined : template.tasks[above.taskIndexes[above.taskIndexes.length - 1] ?? -1];
  const withSteps = usesSteps(template);
  if (withSteps && stepsOf(template).length >= MAX_STEPS) return undefined;
  const taskCode = provisionalCode(template.tasks.map((task) => task.code));
  const stepCode = provisionalCode(stepsOf(template).map((step) => step.code));
  const task = pending<EditorTask>({ ...blankTask(taskCode, phaseCode), ...copiedFrom(aboveTask), ...(withSteps ? { step: stepCode } : {}) });
  // The tasks of a phase are kept together in the list (a row added to an earlier phase does not land after the rows of a later one).
  const lastOfPhase = template.tasks.reduce((found, one, index) => (one.phase === phaseCode ? index : found), -1);
  const tasks = lastOfPhase < 0 ? [...template.tasks, task] : [...template.tasks.slice(0, lastOfPhase + 1), task, ...template.tasks.slice(lastOfPhase + 1)];
  let next: Template = { ...template, tasks };
  if (withSteps) {
    const steps = stepsOf(template);
    const lastStep = steps.reduce((found, one, index) => (one.phase === phaseCode ? index : found), -1);
    const step = pending<EditorStep>({ code: stepCode, name: '', phase: phaseCode });
    next = { ...next, steps: lastStep < 0 ? [...steps, step] : [...steps.slice(0, lastStep + 1), step, ...steps.slice(lastStep + 1)] };
  }
  const key = withSteps ? `step:${stepCode}` : `task:${taskCode}`;
  const index = next.tasks.findIndex((one) => one.code === taskCode);
  return { template: above === undefined ? next : setAnchor(next, index, above.key), key };
}

/** Adds a phase with no name yet (its code is made from the name when the name is given). */
export function addNamedPhase(template: Template, name = ''): Template {
  if (template.phases.length >= MAX_PHASES) return template;
  const codes = template.phases.map((phase) => phase.code);
  const phase: TemplatePhase = name.trim() === '' ? pending({ code: provisionalCode(codes), name: '', gates: [] }) : { code: workflowCodeFrom(name, codes), name, gates: [] };
  return { ...template, phases: [...template.phases, phase] };
}

/** Names a row. A step with one task that carried the same name (or none) is one thing to the person, so its task is named with it; a task that was named apart keeps its own name. */
export function nameLine(template: Template, line: Pick<TableLine, 'kind' | 'stepIndex' | 'taskIndex'>, name: string): Template {
  if (line.kind === 'task' || line.stepIndex === null) {
    if (line.taskIndex === null) return template;
    return { ...template, tasks: template.tasks.map((task, at) => (at === line.taskIndex ? { ...task, name } : task)) };
  }
  const step = stepsOf(template)[line.stepIndex];
  if (step === undefined) return template;
  const steps = stepsOf(template).map((one, at) => (at === line.stepIndex ? { ...one, name } : one));
  const tasks = template.tasks.map((task, at) => (at === line.taskIndex && (task.name === step.name || task.name.trim() === '') ? { ...task, name } : task));
  return { ...template, steps, tasks };
}

/**
 * Gives every row that was added and has a name by now its code, made from that name once (R63): the provisional code is replaced everywhere it is named (the links of other tasks, the step of a task, the mark of the
 * overall deadline). A row that has its code keeps it whatever it is renamed to.
 */
export function settleCodes(template: Template): Template {
  let next = template;
  next.phases.forEach((phase, index) => {
    if (!isPending(phase) || phase.name.trim() === '') return;
    const code = workflowCodeFrom(phase.name, next.phases.filter((_, at) => at !== index).map((one) => one.code));
    next = renamePhase(next, index, code);
    next = { ...next, phases: next.phases.map((one, at) => (at === index ? settled(one) : one)) };
  });
  stepsOf(next).forEach((step, index) => {
    if (!isPending(step) || step.name.trim() === '') return;
    const code = workflowCodeFrom(step.name, stepsOf(next).filter((_, at) => at !== index).map((one) => one.code));
    next = renameStep(next, index, code);
    next = { ...next, steps: stepsOf(next).map((one, at) => (at === index ? settled(one) : one)) };
  });
  next.tasks.forEach((task, index) => {
    if (!isPending(task) || task.name.trim() === '') return;
    const code = workflowCodeFrom(task.name, next.tasks.filter((_, at) => at !== index).map((one) => one.code));
    next = renameTask(next, index, code);
    next = { ...next, tasks: next.tasks.map((one, at) => (at === index ? settled(one) : one)) };
  });
  return next;
}

/** A step with one task becomes a step with two: the second copies who does the first and its limit, and starts when the first is done. The step row turns read-only and the tasks are the rows under it. */
export function splitStep(template: Template, stepIndex: number): Added | undefined {
  const step = stepsOf(template)[stepIndex];
  if (step === undefined || template.tasks.length >= MAX_TASKS) return undefined;
  const own = template.tasks.flatMap((task, index) => (task.step === step.code ? [index] : []));
  const last = own[own.length - 1];
  const above = last === undefined ? undefined : template.tasks[last];
  const code = provisionalCode(template.tasks.map((task) => task.code));
  const task = pending<EditorTask>({ ...blankTask(code, step.phase), ...copiedFrom(above), step: step.code, ...(above === undefined ? {} : { predecessors: [{ task: above.code, kind: 'FS' as const, lag_working_days: 0 }] }) });
  const at = last === undefined ? template.tasks.length : last + 1;
  return { template: { ...template, tasks: [...template.tasks.slice(0, at), task, ...template.tasks.slice(at)] }, key: `task:${code}` };
}

// ---- moving, copying and removing rows ----------------------------------------------------------------------------------------------------------------------------------

const swap = <T>(list: readonly T[], a: number, b: number): T[] => list.map((item, at) => (at === a ? (list[b] as T) : at === b ? (list[a] as T) : item));

/**
 * Moves a row one place up or down among the rows of its kind: a step among the steps of its phase, a task among the tasks of its step (or of its phase in a template without steps). At the edge of a phase a
 * step goes to the neighbouring phase with its tasks. The order of a list is all that changes: when a row starts is said by its anchor, never by where it stands.
 */
export function moveLine(template: Template, key: string, by: -1 | 1): Template {
  const line = lineOf(template, key);
  if (line === undefined) return template;
  if (line.kind === 'step' && line.stepIndex !== null) {
    const steps = stepsOf(template);
    const step = steps[line.stepIndex] as EditorStep;
    const peers = steps.flatMap((one, index) => (one.phase === step.phase ? [index] : []));
    const other = peers[peers.indexOf(line.stepIndex) + by];
    if (other !== undefined) return { ...template, steps: swap(steps, line.stepIndex, other) };
    const phaseAt = template.phases.findIndex((phase) => phase.code === step.phase);
    const target = template.phases[phaseAt + by];
    if (phaseAt < 0 || target === undefined) return template;
    // Into the neighbouring phase: last of the phase before, first of the phase after.
    const rest = steps.filter((_, index) => index !== line.stepIndex);
    const moved = { ...step, phase: target.code };
    const targetPeers = rest.flatMap((one, index) => (one.phase === target.code ? [index] : []));
    const at = by < 0 ? (targetPeers.length === 0 ? rest.length : (targetPeers[targetPeers.length - 1] as number) + 1) : (targetPeers[0] ?? rest.length);
    return { ...template, steps: [...rest.slice(0, at), moved, ...rest.slice(at)], tasks: template.tasks.map((task) => (task.step === step.code ? { ...task, phase: target.code } : task)) };
  }
  if (line.taskIndex === null) return template;
  const task = template.tasks[line.taskIndex] as EditorTask;
  const peers = template.tasks.flatMap((one, index) => (one.phase === task.phase && (one.step ?? null) === (task.step ?? null) ? [index] : []));
  const other = peers[peers.indexOf(line.taskIndex) + by];
  return other === undefined ? template : { ...template, tasks: swap(template.tasks, line.taskIndex, other) };
}

export function movePhase(template: Template, index: number, by: -1 | 1): Template {
  return template.phases[index + by] === undefined || template.phases[index] === undefined ? template : { ...template, phases: swap(template.phases, index, index + by) };
}

/** Removes a row: a step with its tasks, or one task. Links that pointed at a removed task go with it, and so does the mark of the overall deadline. Removing the last step of a template takes its tasks too. */
export function removeLine(template: Template, key: string): Template {
  const line = lineOf(template, key);
  if (line === undefined) return template;
  let next = template;
  const codes = line.taskIndexes.map((index) => (template.tasks[index] as EditorTask).code);
  if (line.kind === 'task') {
    for (const code of codes) next = removeTask(next, next.tasks.findIndex((task) => task.code === code));
    return next;
  }
  for (const code of codes) next = removeTask(next, next.tasks.findIndex((task) => task.code === code));
  const left = stepsOf(next).filter((step) => step.code !== line.code);
  if (left.length > 0 || next.tasks.length === 0) return { ...next, steps: left };
  // The last step is gone and tasks without a step remain (they named a step the template no longer has): the template is in two tiers again.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the steps are what is dropped
  const { steps, ...rest } = next;
  return rest;
}

/** A phase is removed with its steps and tasks, and with the mark of the overall deadline when it stood on one of them. */
export function removePhaseRows(template: Template, index: number): Template {
  const next = removePhase(template, index);
  if (typeof next.overall_deadline_task !== 'string' || next.tasks.some((task) => task.code === next.overall_deadline_task)) return next;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the mark is what is dropped
  const { overall_deadline_task: gone, ...rest } = next;
  return rest;
}

/** A legal ground on a row it was not checked for is not checked (R75): a copied line is unverified and carries no stamp. */
export const unverifiedCopy = (basis: readonly LegalBasisInput[] | undefined): LegalBasisInput[] =>
  (basis ?? []).map((one) => ({ document: one.document, ...(one.article === undefined ? {} : { article: one.article }), ...(one.note === undefined ? {} : { note: one.note }), verification: 'UNVERIFIED' as const }));

/**
 * Copies a row with everything it holds, right under it. The copy is a new row: its codes are made from its name (the name of the original with the suffix the caller gives), its legal grounds come unverified, and
 * the links between the copied tasks follow the copies; links to other rows are kept.
 */
export function duplicateLine(template: Template, key: string, nameOf: (name: string) => string): Added | undefined {
  const line = lineOf(template, key);
  if (line === undefined || template.tasks.length + line.taskIndexes.length > MAX_TASKS) return undefined;
  const taken = template.tasks.map((task) => task.code);
  const renamed = new Map<string, string>();
  const copies = line.taskIndexes.map((index) => {
    const task = template.tasks[index] as EditorTask;
    const name = nameOf(task.name);
    const code = workflowCodeFrom(name, taken);
    taken.push(code);
    renamed.set(task.code, code);
    return { task, name, code };
  });
  let stepCode: string | undefined;
  let steps = template.steps;
  if (line.kind === 'step' && line.stepIndex !== null) {
    if (stepsOf(template).length >= MAX_STEPS) return undefined;
    const step = stepsOf(template)[line.stepIndex] as EditorStep;
    const name = nameOf(step.name);
    stepCode = workflowCodeFrom(name, stepsOf(template).map((one) => one.code));
    const copy: EditorStep = fresh({ ...step, code: stepCode, name, ...(step.legal_basis === undefined ? {} : { legal_basis: unverifiedCopy(step.legal_basis) }) });
    steps = [...stepsOf(template).slice(0, line.stepIndex + 1), copy, ...stepsOf(template).slice(line.stepIndex + 1)];
  }
  const made = copies.map(({ task, name, code }): EditorTask =>
    fresh({
      ...task,
      code,
      name,
      ...(stepCode === undefined ? {} : { step: stepCode }),
      predecessors: task.predecessors.map((link) => ({ ...link, task: renamed.get(link.task) ?? link.task })),
      ...(task.legal_basis === undefined ? {} : { legal_basis: unverifiedCopy(task.legal_basis) }),
    }),
  );
  const at = Math.max(...line.taskIndexes, -1) + 1;
  const tasks = [...template.tasks.slice(0, at), ...made, ...template.tasks.slice(at)];
  return { template: { ...template, ...(steps === undefined ? {} : { steps }), tasks }, key: stepCode === undefined ? `task:${made[0]?.code ?? ''}` : `step:${stepCode}` };
}

// ---- the anchor: when a row starts (R57) -----------------------------------------------------------------------------------------------------------------------------------

export type Anchor =
  /** With the project: the task waits for nothing. */
  | { kind: 'start' }
  /** When a row is done: one finish-to-start link without a lag to every task of that row. */
  | { kind: 'after'; key: string }
  /** Anything else (a link of another kind, a lag, several rows): said in words on the row and edited in the details. */
  | { kind: 'advanced' };

/** The rows a task may start after: every row but its own (and, for a task under a step, but that step). */
export function anchorTargets(template: Template, taskIndex: number): TableLine[] {
  const task = template.tasks[taskIndex];
  if (task === undefined) return [];
  return linesOf(template).filter((line) => !line.taskIndexes.includes(taskIndex) && line.taskIndexes.length > 0);
}

export function anchorOf(template: Template, taskIndex: number): Anchor {
  const task = template.tasks[taskIndex];
  if (task === undefined || task.predecessors.length === 0) return { kind: 'start' };
  if (task.predecessors.some((link) => link.kind !== 'FS' || link.lag_working_days !== 0)) return { kind: 'advanced' };
  const waited = [...new Set(task.predecessors.map((link) => link.task))].sort();
  const found = anchorTargets(template, taskIndex).find((line) => {
    const codes = line.taskIndexes.map((index) => (template.tasks[index] as EditorTask).code).sort();
    return codes.length === waited.length && codes.every((code, at) => code === waited[at]);
  });
  return found === undefined ? { kind: 'advanced' } : { kind: 'after', key: found.key };
}

/** Sets when the task starts: with the project (`start`) or when a row is done. This replaces every link of the task; an advanced link is only ever replaced when the person picks one of the two. */
export function setAnchor(template: Template, taskIndex: number, target: 'start' | string): Template {
  const line = target === 'start' ? undefined : lineOf(template, target);
  const predecessors = line === undefined ? [] : line.taskIndexes.filter((index) => index !== taskIndex).map((index) => ({ task: (template.tasks[index] as EditorTask).code, kind: 'FS' as const, lag_working_days: 0 }));
  return { ...template, tasks: template.tasks.map((task, at) => (at === taskIndex ? { ...task, predecessors } : task)) };
}

// ---- the time limit, the three colours, the extension ---------------------------------------------------------------------------------------------------------------

/** The limit of a task as the table shows it: in its own unit when it has one, else in working days. */
export const limitOf = (task: Pick<EditorTask, 'duration' | 'duration_working_days'>): TaskDuration => task.duration ?? { value: task.duration_working_days, unit: 'WORKING_DAY', roll_to_working_day: true };

const patchTask = (template: Template, index: number, change: (task: EditorTask) => EditorTask): Template => ({ ...template, tasks: template.tasks.map((task, at) => (at === index ? change(task) : task)) });

/**
 * Sets the limit of a task. In working days it is the old field alone (the template keeps the shape it always had); in days or months the task gets `duration` and the old field takes its nominal value, which is
 * never typed (PWF 22.2). The unit of an extension follows the unit of the limit.
 */
export function setLimit(template: Template, taskIndex: number, change: Partial<TaskDuration>): Template {
  return patchTask(template, taskIndex, (task) => {
    const limit = { ...limitOf(task), ...change };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the limit in its own unit is what is dropped
    const { duration, ...rest } = task;
    const extension = task.extension === undefined ? {} : { extension: { ...task.extension, unit: limit.unit } };
    if (limit.unit === 'WORKING_DAY') return { ...rest, duration_working_days: limit.value, ...extension };
    return { ...rest, duration: limit, duration_working_days: nominalWorkingDays(limit.value, limit.unit), ...extension };
  });
}

export type BandLine = 'green_days' | 'yellow_days' | 'red_days';

/** Sets one line of the ladder of a task; a ladder with no line left is no ladder (the task then follows the policy). */
export function setBand(template: Template, taskIndex: number, line: BandLine, value: number | undefined): Template {
  return patchTask(template, taskIndex, (task) => {
    const bands: EditorBands = { ...(task.bands ?? {}) };
    if (value === undefined) delete bands[line];
    else bands[line] = value;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the ladder is what is replaced
    const { bands: old, ...rest } = task;
    return Object.keys(bands).length === 0 ? rest : { ...rest, bands };
  });
}

export type ExtensionChoice = 'unset' | 'allowed' | 'denied';
export const extensionChoice = (task: Pick<EditorTask, 'extension'>): ExtensionChoice => (task.extension === undefined ? 'unset' : task.extension.allowed ? 'allowed' : 'denied');

/** Whether the limit may be extended: not said (the task follows what the module did before), allowed (with the caps it had or none), or refused (a refusal carries no cap). */
export function setExtension(template: Template, taskIndex: number, choice: ExtensionChoice, caps: { max_times?: number | undefined; max_value?: number | undefined } = {}): Template {
  return patchTask(template, taskIndex, (task) => {
    const { extension, ...rest } = task;
    if (choice === 'unset') return rest;
    const unit: DurationUnit = limitOf(task).unit;
    if (choice === 'denied') return { ...rest, extension: { allowed: false, unit } };
    const times = 'max_times' in caps ? caps.max_times : extension?.max_times;
    const value = 'max_value' in caps ? caps.max_value : extension?.max_value;
    return { ...rest, extension: { allowed: true, ...(times === undefined ? {} : { max_times: times }), ...(value === undefined ? {} : { max_value: value }), unit } };
  });
}

/** Marks the task as the deadline of the whole file, or takes the mark off when it is the one marked. */
export function toggleOverall(template: Template, taskCode: string): Template {
  if (template.overall_deadline_task !== taskCode) return { ...template, overall_deadline_task: taskCode };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the mark is what is dropped
  const { overall_deadline_task: gone, ...rest } = template;
  return rest;
}

// ---- who receives the step (R61) ---------------------------------------------------------------------------------------------------------------------------------------

export const PROJECT_OWNER = 'PROJECT_OWNER';
export const partyRef = (code: string): string => `PROJECT_PARTY:${code}`;
export const unitRef = (id: string): string => `UNIT:${id}`;

export type UnitRefKind = { kind: 'owner' } | { kind: 'party'; code: string } | { kind: 'unit'; id: string } | { kind: 'unknown' };
export function unitRefKind(ref: string): UnitRefKind {
  if (ref === PROJECT_OWNER) return { kind: 'owner' };
  if (ref.startsWith('PROJECT_PARTY:')) return { kind: 'party', code: ref.slice('PROJECT_PARTY:'.length) };
  return ref.startsWith('UNIT:') ? { kind: 'unit', id: ref.slice('UNIT:'.length) } : { kind: 'unknown' };
}

export const leadOf = (task: Pick<EditorTask, 'responsible_units'>): ResponsibleUnit | undefined => (task.responsible_units ?? []).find((unit) => unit.part === 'LEAD');
export const supportsOf = (task: Pick<EditorTask, 'responsible_units'>): ResponsibleUnit[] => (task.responsible_units ?? []).filter((unit) => unit.part === 'SUPPORT');

const withUnits = (task: EditorTask, units: ResponsibleUnit[]): EditorTask => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the units are what is replaced
  const { responsible_units: old, ...rest } = task;
  return units.length === 0 ? rest : { ...rest, responsible_units: units };
};

/** Sets the unit that leads the task (empty: the task names no unit, as a template written before the table). The role of the lead line is the role that answers for the task: one truth. */
export function setLeadUnit(template: Template, taskIndex: number, ref: string): Template {
  return patchTask(template, taskIndex, (task) => {
    const others = supportsOf(task);
    return withUnits(task, ref === '' ? others : [{ unit_ref: ref, role: task.responsible_role, part: 'LEAD' }, ...others]);
  });
}

/** Sets the role that answers for the task, on the task and on its lead unit together. */
export function setRole(template: Template, taskIndex: number, role: string): Template {
  return patchTask(template, taskIndex, (task) => withUnits({ ...task, responsible_role: role }, (task.responsible_units ?? []).map((unit) => (unit.part === 'LEAD' ? { ...unit, role } : unit))));
}

export function addSupport(template: Template, taskIndex: number, ref: string, role: string): Template {
  return patchTask(template, taskIndex, (task) => withUnits(task, [...(task.responsible_units ?? []), { unit_ref: ref, role, part: 'SUPPORT' }]));
}

/** Changes or removes (`change` null) the n-th supporting unit of the task. */
export function updateSupport(template: Template, taskIndex: number, at: number, change: Partial<Pick<ResponsibleUnit, 'unit_ref' | 'role'>> | null): Template {
  return patchTask(template, taskIndex, (task) => {
    let seen = -1;
    const units = (task.responsible_units ?? []).flatMap((unit) => {
      if (unit.part !== 'SUPPORT') return [unit];
      seen += 1;
      if (seen !== at) return [unit];
      return change === null ? [] : [{ ...unit, ...change }];
    });
    return withUnits(task, units);
  });
}

/** Adds a role the template names itself: the person gives the name, the code is made from it (R63). */
export function addRole(template: Template, name: string, known: readonly string[] = []): { template: Template; code: string } {
  const roles: TemplateRole[] = template.roles ?? [];
  const code = workflowCodeFrom(name, [...roles.map((role) => role.code), ...known]);
  return { template: { ...template, roles: [...roles, { code, name: name.trim() }] }, code };
}

/** Adds a party of the project the template names itself (a seat the person who starts a project fills): the code is made from the name. */
export function addParty(template: Template, name: string): { template: Template; code: string } {
  const parties: TemplateParty[] = template.parties ?? [];
  const code = workflowCodeFrom(name, [...parties.map((party) => party.code), 'INVESTOR', 'DECISION_AUTHORITY']);
  return { template: { ...template, parties: [...parties, { code, name: name.trim() }] }, code };
}

/** Parties nobody refers to any more are not kept (a declared party no step uses would be a seat nobody can explain). */
export function dropUnusedParties(template: Template): Template {
  const used = new Set(template.tasks.flatMap((task) => (task.responsible_units ?? []).map((unit) => unit.unit_ref)));
  const parties = (template.parties ?? []).filter((party) => used.has(partyRef(party.code)));
  if (parties.length === (template.parties ?? []).length) return template;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parties are what is replaced
  const { parties: old, ...rest } = template;
  return parties.length === 0 ? rest : { ...rest, parties };
}

// ---- legal grounds (R75) ---------------------------------------------------------------------------------------------------------------------------------------------------

/** How a citation stands: checked and stamped by the server, said to be checked by the person and waiting for the stamp of the next save, or not checked. */
export type BasisState = 'stamped' | 'claimed' | 'unverified';
export const basisState = (basis: LegalBasisInput): BasisState => (basis.verification !== 'VERIFIED' ? 'unverified' : typeof basis.verified_by === 'string' && typeof basis.verified_at === 'string' ? 'stamped' : 'claimed');

/**
 * Changes the document, the article or the note of a citation: what was checked is no longer what is cited, so the line is unverified again and loses its stamp. The client never writes a stamp of its own.
 */
export function editBasis(list: readonly LegalBasisInput[], index: number, change: Partial<Pick<LegalBasisInput, 'document' | 'article' | 'note'>>): LegalBasisInput[] {
  return list.map((one, at) => {
    if (at !== index) return one;
    const next = { ...one, ...change };
    const same = next.document === one.document && (next.article ?? '') === (one.article ?? '') && (next.note ?? '') === (one.note ?? '');
    if (same) return one;
    return { document: next.document, ...(next.article === undefined ? {} : { article: next.article }), ...(next.note === undefined ? {} : { note: next.note }), verification: 'UNVERIFIED' };
  });
}

/** The person says the citation was checked against the source text (or takes that back). The stamp is the server's: a line marked here carries none until it is saved. */
export function markBasis(list: readonly LegalBasisInput[], index: number, verified: boolean): LegalBasisInput[] {
  return list.map((one, at) => {
    if (at !== index || (one.verification === 'VERIFIED') === verified) return one;
    return { document: one.document, ...(one.article === undefined ? {} : { article: one.article }), ...(one.note === undefined ? {} : { note: one.note }), verification: verified ? 'VERIFIED' : 'UNVERIFIED' };
  });
}

/** Every citation of a row: those of the step and those of its tasks. */
export function basisOfLine(template: Template, line: TableLine): LegalBasisInput[] {
  const step = line.kind === 'step' && line.stepIndex !== null ? (stepsOf(template)[line.stepIndex]?.legal_basis ?? []) : [];
  return [...step, ...line.taskIndexes.flatMap((index) => template.tasks[index]?.legal_basis ?? [])];
}

/** How many rows of the table cite a ground nobody checked against the source text yet (the yellow note above the table, and the library). A task under a step counts with its step. */
export function unverifiedRows(template: Template): number {
  return linesOf(template).filter((line) => !line.child && basisOfLine(template, line).some((basis) => basis.verification !== 'VERIFIED')).length;
}

// ---- what a row holds besides its cells ---------------------------------------------------------------------------------------------------------------------------------

/** The papers a row asks for: legal documents, forms and checklist items of its tasks. */
export function dossierCount(template: Template, line: Pick<TableLine, 'taskIndexes'>): number {
  return line.taskIndexes.reduce((sum, index) => {
    const task = template.tasks[index];
    return task === undefined ? sum : sum + task.legal_doc_types.length + task.form_templates.length + task.checklist.length;
  }, 0);
}

/** What a task holds that the table has no cell for, each said in words on the row and edited in the details (R62): nothing a template was written with is hidden. */
export type AdvancedNote =
  | { kind: 'link'; task: string; name: string; link: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }
  | { kind: 'constraint'; constraint: NonNullable<EditorTask['constraint']>['kind']; offset: number }
  | { kind: 'conditions'; count: number }
  | { kind: 'pinnedForms'; count: number }
  | { kind: 'kpi'; count: number }
  | { kind: 'approver'; role: string }
  | { kind: 'optional' }
  | { kind: 'milestone' }
  | { kind: 'priority'; priority: EditorTask['priority'] };

export function advancedNotes(template: Template, taskIndex: number): AdvancedNote[] {
  const task = template.tasks[taskIndex];
  if (task === undefined) return [];
  const notes: AdvancedNote[] = [];
  if (task.kind === 'MILESTONE') notes.push({ kind: 'milestone' });
  if (anchorOf(template, taskIndex).kind === 'advanced') for (const link of task.predecessors) notes.push({ kind: 'link', task: link.task, name: template.tasks.find((one) => one.code === link.task)?.name ?? link.task, link: link.kind, lag: link.lag_working_days });
  if (task.constraint !== null) notes.push({ kind: 'constraint', constraint: task.constraint.kind, offset: task.constraint.offset_working_days });
  if (task.when.length > 0) notes.push({ kind: 'conditions', count: task.when.length });
  const pinned = (task.form_policies ?? []).filter((policy) => policy.policy === 'PINNED').length;
  if (pinned > 0) notes.push({ kind: 'pinnedForms', count: pinned });
  if (task.kpi_codes.length > 0) notes.push({ kind: 'kpi', count: task.kpi_codes.length });
  if (typeof task.approver_role === 'string' && task.approver_role !== '') notes.push({ kind: 'approver', role: task.approver_role });
  if (!task.required) notes.push({ kind: 'optional' });
  if (task.priority !== 'NORMAL') notes.push({ kind: 'priority', priority: task.priority });
  return notes;
}

/** The nominal working days of every task (what the library says of the length of a procedure without a calendar; the dates of the chart are the server's). */
export const totalNominalDays = (template: Template): number => template.tasks.reduce((sum, task) => sum + (Number.isFinite(task.duration_working_days) ? task.duration_working_days : 0), 0);

/** The number of rows of the table (steps, or tasks of a template without steps). */
export const rowCount = (template: Template): number => linesOf(template).filter((line) => !line.child).length;

/** The path of the problems of a task or a step, as `localProblems` writes it. */
export const taskPath = (index: number): string => `tasks[${index}]`;
export const stepPath = (index: number): string => `steps[${index}]`;

/** The row a problem belongs to (the summary above the table jumps to it): the row of the task or the step the path names; undefined for a problem of the template itself or of a phase. */
export function lineOfProblem(template: Template, path: string): TableLine | undefined {
  const task = /^tasks\[(\d+)\]/.exec(path);
  const step = /^steps\[(\d+)\]/.exec(path);
  const lines = linesOf(template);
  if (task !== null) return lines.find((line) => line.kind === 'task' && line.taskIndex === Number(task[1])) ?? lines.find((line) => line.taskIndexes.includes(Number(task[1])));
  return step === null ? undefined : lines.find((line) => line.kind === 'step' && line.stepIndex === Number(step[1]));
}

// ---- the checklist: codes made from names (R63) ---------------------------------------------------------------------------------------------------------------------

/** A checklist item that has a name and no code yet gets its code made from the name, once; an item that has its code keeps it whatever it is renamed to. */
export function settleChecklistCodes(template: Template): Template {
  let changed = false;
  const tasks = template.tasks.map((task) => {
    if (!task.checklist.some((item) => item.code === '' && item.name.trim() !== '')) return task;
    const taken = task.checklist.map((item) => item.code).filter((code) => code !== '');
    const checklist = task.checklist.map((item) => {
      if (item.code !== '' || item.name.trim() === '') return item;
      const code = workflowCodeFrom(item.name, taken);
      taken.push(code);
      return { ...item, code };
    });
    changed = true;
    return { ...task, checklist };
  });
  return changed ? { ...template, tasks } : template;
}

/** Everything that waits for a name to get its code: rows, phases and checklist items. Called when a name is left and before anything is sent. */
export const settleAll = (template: Template): Template => settleChecklistCodes(settleCodes(template));

/** Makes a task a milestone (no limit of its own, no extension: the check refuses them together) or a task again (one working day, the limit the person gives next). */
export function setKind(template: Template, taskIndex: number, kind: EditorTask['kind']): Template {
  return patchTask(template, taskIndex, (task) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the limit and the extension are what a milestone drops
    const { duration, extension, ...rest } = task;
    return kind === 'MILESTONE' ? { ...rest, kind, duration_working_days: 0 } : { ...task, kind, duration_working_days: Math.max(1, task.duration_working_days) };
  });
}
