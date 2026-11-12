import type { DependencyKind, GateTarget, Priority, TaskKind, TemplateParams, TemplatePhase, TemplateTask } from '../model';

/** The pure side of the template editor and the library: the shape the editor holds, the edits it makes, the checks made before anything is sent and the comparison of two versions. */

type Params = Record<string, unknown>;
type Dependency = TemplateTask['predecessors'][number];
type Constraint = NonNullable<TemplateTask['constraint']>;
type Checklist = NonNullable<TemplateTask['checklist']>[number];
type Condition = NonNullable<TemplateTask['when']>[number];

export type ConstraintKind = Constraint['kind'];
export type ConditionField = Condition['field'];

export const DEPENDENCY_KINDS: readonly DependencyKind[] = ['FS', 'SS', 'FF', 'SF'];
export const CONSTRAINT_KINDS: readonly ConstraintKind[] = ['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO'];
export const CONDITION_FIELDS: readonly ConditionField[] = ['project_group', 'funding_source', 'project_type'];
export const TASK_KINDS: readonly TaskKind[] = ['TASK', 'MILESTONE'];
export const PRIORITIES: readonly Priority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
export const GATE_TARGETS: readonly GateTarget[] = [
  'submitProjectForAppraisal',
  'decideProjectAppraisal',
  'capital.plan_published.v1',
  'startProjectImplementation',
  'suspendProject',
  'resumeProject',
  'completeProject',
  'settlement.closed.v1',
  'closeProject',
];

/** The limits of a template (BR-PWF-12) and of its parts (the schema of the rule type). */
export const MAX_TASKS = 400;
export const MAX_PHASES = 12;
export const MAX_PREDECESSORS = 20;
export const MAX_CHECKLIST = 30;
export const MAX_CONDITIONS = 5;
export const MAX_CODES = 10;
export const MAX_LAG = 365;
export const MAX_DURATION = 1095;
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/** A task as the editor holds it: every optional part of the contract is present (an empty list, no constraint). */
export type EditorTask = Omit<TemplateTask, 'constraint' | 'legal_doc_types' | 'form_templates' | 'checklist' | 'kpi_codes' | 'when'> & {
  constraint: Constraint | null;
  legal_doc_types: string[];
  form_templates: string[];
  checklist: Checklist[];
  kpi_codes: string[];
  when: Condition[];
};

export interface Template {
  name: string;
  project_type: string | null;
  phases: TemplatePhase[];
  tasks: EditorTask[];
}

export const blankTemplate = (): Template => ({ name: '', project_type: null, phases: [], tasks: [] });

// ---- reading and writing the params of a rule ----------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => options.find((option) => option === value) ?? fallback;

function readTask(raw: Record<string, unknown>): EditorTask {
  const constraint = isRecord(raw.constraint) ? { kind: oneOf(CONSTRAINT_KINDS, raw.constraint.kind, 'SNET'), offset_working_days: count(raw.constraint.offset_working_days) } : null;
  return {
    code: text(raw.code),
    name: text(raw.name),
    phase: text(raw.phase),
    kind: oneOf(TASK_KINDS, raw.kind, 'TASK'),
    duration_working_days: count(raw.duration_working_days),
    required: raw.required !== false,
    responsible_role: text(raw.responsible_role),
    approver_role: typeof raw.approver_role === 'string' && raw.approver_role !== '' ? raw.approver_role : null,
    priority: oneOf(PRIORITIES, raw.priority, 'NORMAL'),
    predecessors: records(raw.predecessors).map((item) => ({ task: text(item.task), kind: oneOf(DEPENDENCY_KINDS, item.kind, 'FS'), lag_working_days: count(item.lag_working_days) })),
    constraint,
    legal_doc_types: strings(raw.legal_doc_types),
    form_templates: strings(raw.form_templates),
    checklist: records(raw.checklist).map((item) => ({ code: text(item.code), name: text(item.name), required: item.required !== false, evidence_kinds: strings(item.evidence_kinds) })),
    kpi_codes: strings(raw.kpi_codes),
    when: records(raw.when).map((item) => ({ field: oneOf(CONDITION_FIELDS, item.field, 'project_group'), in: strings(item.in) })),
  };
}

/** Reads the params of a `PROJECT_WORKFLOW_TEMPLATE` rule into what the editor holds; what is not there is left empty, never guessed. */
export function readTemplate(params: unknown): Template {
  if (!isRecord(params)) return blankTemplate();
  return {
    name: text(params.name),
    project_type: typeof params.project_type === 'string' && params.project_type !== '' ? params.project_type : null,
    phases: records(params.phases).map((item) => ({ code: text(item.code), name: text(item.name), gates: GATE_TARGETS.filter((target) => strings(item.gates).includes(target)) })),
    tasks: records(params.tasks).map(readTask),
  };
}

/** The params the rule store keeps (snake_case, as the contract says): no empty constraint, no empty approver, no empty project type. */
export function paramsOfTemplate(template: Template): TemplateParams & Params {
  return {
    name: template.name.trim(),
    project_type: template.project_type === null || template.project_type.trim() === '' ? null : template.project_type.trim(),
    phases: template.phases.map((phase) => ({ code: phase.code, name: phase.name.trim(), gates: [...phase.gates] })),
    tasks: template.tasks.map(({ constraint, approver_role: approver, ...task }) => ({
      ...task,
      name: task.name.trim(),
      approver_role: approver === null || approver === '' ? null : approver,
      ...(constraint === null ? {} : { constraint }),
    })),
  };
}

export interface TemplateSummary {
  name: string;
  projectType: string | null;
  phases: number;
  tasks: number;
}

/** What the library says of the params of a version without reading the whole template. */
export function summaryOf(params: Params): TemplateSummary {
  return {
    name: text(params.name),
    projectType: typeof params.project_type === 'string' ? params.project_type : null,
    phases: Array.isArray(params.phases) ? params.phases.length : 0,
    tasks: Array.isArray(params.tasks) ? params.tasks.length : 0,
  };
}

// ---- edits --------------------------------------------------------------------------------------------------------------------------------------------------------------------

const nextCode = (prefix: string, taken: readonly string[]): string => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
};

export function addPhase(template: Template): Template {
  if (template.phases.length >= MAX_PHASES) return template;
  return { ...template, phases: [...template.phases, { code: nextCode('P', template.phases.map((phase) => phase.code)), name: '', gates: [] }] };
}

/** A phase is removed with its tasks (a task with no phase would not be part of any stage). */
export function removePhase(template: Template, index: number): Template {
  const phase = template.phases[index];
  if (phase === undefined) return template;
  const tasks = template.tasks.filter((task) => task.phase !== phase.code);
  const gone = new Set(template.tasks.filter((task) => task.phase === phase.code).map((task) => task.code));
  return { ...template, phases: template.phases.filter((_, at) => at !== index), tasks: tasks.map((task) => ({ ...task, predecessors: task.predecessors.filter((link) => !gone.has(link.task)) })) };
}

export function renamePhase(template: Template, index: number, code: string): Template {
  const old = template.phases[index]?.code;
  if (old === undefined) return template;
  return { ...template, phases: template.phases.map((phase, at) => (at === index ? { ...phase, code } : phase)), tasks: template.tasks.map((task) => (task.phase === old ? { ...task, phase: code } : task)) };
}

export function updatePhase(template: Template, index: number, patch: Partial<TemplatePhase>): Template {
  return { ...template, phases: template.phases.map((phase, at) => (at === index ? { ...phase, ...patch } : phase)) };
}

export function addTask(template: Template, phase: string): Template {
  if (template.tasks.length >= MAX_TASKS) return template;
  const task: EditorTask = {
    code: nextCode('T', template.tasks.map((item) => item.code)),
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
  };
  return { ...template, tasks: [...template.tasks, task] };
}

export function updateTask(template: Template, index: number, patch: Partial<EditorTask>): Template {
  return { ...template, tasks: template.tasks.map((task, at) => (at === index ? { ...task, ...patch } : task)) };
}

/** A task code is changed in every link that points at it. */
export function renameTask(template: Template, index: number, code: string): Template {
  const old = template.tasks[index]?.code;
  if (old === undefined) return template;
  return {
    ...template,
    tasks: template.tasks.map((task, at) => ({
      ...(at === index ? { ...task, code } : task),
      predecessors: task.predecessors.map((link) => (link.task === old ? { ...link, task: code } : link)),
    })),
  };
}

export function removeTask(template: Template, index: number): Template {
  const old = template.tasks[index]?.code;
  if (old === undefined) return template;
  return { ...template, tasks: template.tasks.filter((_, at) => at !== index).map((task) => ({ ...task, predecessors: task.predecessors.filter((link) => link.task !== old) })) };
}

/** Adds a link; the same (task, kind) is never added twice and a task has at most twenty. */
export function addPredecessor(template: Template, index: number, link: Dependency): Template {
  const task = template.tasks[index];
  if (task === undefined || task.predecessors.length >= MAX_PREDECESSORS) return template;
  if (task.predecessors.some((item) => item.task === link.task && item.kind === link.kind)) return template;
  return updateTask(template, index, { predecessors: [...task.predecessors, link] });
}

export interface PhaseGroup {
  phase: TemplatePhase | null;
  tasks: { index: number; task: EditorTask }[];
}

/** The task tree: the tasks under their phase in the order of the phases; the tasks of a phase that is not there are kept apart. */
export function groupByPhase(template: Template): PhaseGroup[] {
  const indexed = template.tasks.map((task, index) => ({ index, task }));
  const groups: PhaseGroup[] = template.phases.map((phase) => ({ phase, tasks: indexed.filter((item) => item.task.phase === phase.code) }));
  const orphans = indexed.filter((item) => !template.phases.some((phase) => phase.code === item.task.phase));
  return orphans.length === 0 ? groups : [...groups, { phase: null, tasks: orphans }];
}

export const splitCodes = (value: string): string[] => value.split(/[\s,;]+/).filter((item) => item !== '');
export const joinCodes = (values: readonly string[]): string => values.join(', ');

// ---- the checks made before anything is sent -------------------------------------------------------------------------------------------------------------------

export type TemplateProblemKind = 'required' | 'pattern' | 'duplicate' | 'range' | 'length' | 'limit' | 'unknownRef' | 'selfLink';
export interface TemplateProblem {
  path: string;
  problem: TemplateProblemKind;
}

const whole = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

function codeProblem(path: string, value: string, taken?: ReadonlySet<string>): TemplateProblem | undefined {
  if (value.trim() === '') return { path, problem: 'required' };
  if (!CODE_PATTERN.test(value)) return { path, problem: 'pattern' };
  return taken?.has(value) === true ? { path, problem: 'duplicate' } : undefined;
}

function nameProblem(path: string, value: string, max: number): TemplateProblem | undefined {
  if (value.trim() === '') return { path, problem: 'required' };
  return value.trim().length > max ? { path, problem: 'length' } : undefined;
}

function codeListProblems(path: string, values: readonly string[], pattern: RegExp = CODE_PATTERN): TemplateProblem[] {
  if (values.length > MAX_CODES) return [{ path, problem: 'limit' }];
  return values.some((value) => !pattern.test(value)) ? [{ path, problem: 'pattern' }] : [];
}

function linkProblems(path: string, task: EditorTask, codes: ReadonlySet<string>): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  if (task.predecessors.length > MAX_PREDECESSORS) out.push({ path: `${path}.predecessors`, problem: 'limit' });
  const seen = new Set<string>();
  task.predecessors.forEach((link, at) => {
    const base = `${path}.predecessors[${at}]`;
    if (link.task === task.code) out.push({ path: `${base}.task`, problem: 'selfLink' });
    else if (!codes.has(link.task)) out.push({ path: `${base}.task`, problem: 'unknownRef' });
    if (!whole(link.lag_working_days, -MAX_LAG, MAX_LAG)) out.push({ path: `${base}.lag_working_days`, problem: 'range' });
    const key = `${link.task}:${link.kind}`;
    if (seen.has(key)) out.push({ path: `${base}.kind`, problem: 'duplicate' });
    seen.add(key);
  });
  return out;
}

function detailProblems(path: string, task: EditorTask): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  if (task.constraint !== null && !whole(task.constraint.offset_working_days, 0, MAX_DURATION)) out.push({ path: `${path}.constraint.offset_working_days`, problem: 'range' });
  if (task.checklist.length > MAX_CHECKLIST) out.push({ path: `${path}.checklist`, problem: 'limit' });
  task.checklist.forEach((item, at) => {
    const base = `${path}.checklist[${at}]`;
    const code = codeProblem(`${base}.code`, item.code);
    if (code !== undefined) out.push(code);
    const name = nameProblem(`${base}.name`, item.name, 200);
    if (name !== undefined) out.push(name);
    out.push(...codeListProblems(`${base}.evidence_kinds`, item.evidence_kinds));
  });
  if (task.when.length > MAX_CONDITIONS) out.push({ path: `${path}.when`, problem: 'limit' });
  task.when.forEach((condition, at) => {
    const base = `${path}.when[${at}].in`;
    if (condition.in.length === 0) out.push({ path: base, problem: 'required' });
    else if (condition.in.length > 20 || condition.in.some((value) => !VALUE_PATTERN.test(value))) out.push({ path: base, problem: 'pattern' });
  });
  out.push(...codeListProblems(`${path}.legal_doc_types`, task.legal_doc_types));
  out.push(...codeListProblems(`${path}.form_templates`, task.form_templates));
  out.push(...codeListProblems(`${path}.kpi_codes`, task.kpi_codes));
  return out;
}

function taskProblems(task: EditorTask, index: number, taken: ReadonlySet<string>, codes: ReadonlySet<string>, phases: ReadonlySet<string>): TemplateProblem[] {
  const path = `tasks[${index}]`;
  const out: TemplateProblem[] = [];
  const push = (problem: TemplateProblem | undefined): void => {
    if (problem !== undefined) out.push(problem);
  };
  push(codeProblem(`${path}.code`, task.code, taken));
  push(nameProblem(`${path}.name`, task.name, 200));
  if (!phases.has(task.phase)) out.push({ path: `${path}.phase`, problem: 'unknownRef' });
  if (!whole(task.duration_working_days, 0, MAX_DURATION)) out.push({ path: `${path}.duration_working_days`, problem: 'range' });
  push(codeProblem(`${path}.responsible_role`, task.responsible_role));
  if (task.approver_role !== null && !CODE_PATTERN.test(task.approver_role)) out.push({ path: `${path}.approver_role`, problem: 'pattern' });
  out.push(...linkProblems(path, task, codes), ...detailProblems(path, task));
  return out;
}

/** What is wrong with a template that can be told without the server (the server judges again: cycles, references to other rules, the schedule). */
export function localProblems(template: Template): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const name = nameProblem('name', template.name, 200);
  if (name !== undefined) out.push(name);
  if (template.phases.length === 0) out.push({ path: 'phases', problem: 'required' });
  if (template.phases.length > MAX_PHASES) out.push({ path: 'phases', problem: 'limit' });
  if (template.tasks.length === 0) out.push({ path: 'tasks', problem: 'required' });
  if (template.tasks.length > MAX_TASKS) out.push({ path: 'tasks', problem: 'limit' });
  const phaseCodes = new Set<string>();
  template.phases.forEach((phase, index) => {
    const code = codeProblem(`phases[${index}].code`, phase.code, phaseCodes);
    if (code !== undefined) out.push(code);
    phaseCodes.add(phase.code);
    const label = nameProblem(`phases[${index}].name`, phase.name, 120);
    if (label !== undefined) out.push(label);
  });
  const allCodes = new Set(template.tasks.map((task) => task.code));
  const taken = new Set<string>();
  template.tasks.forEach((task, index) => {
    out.push(...taskProblems(task, index, taken, allCodes, phaseCodes));
    taken.add(task.code);
  });
  return out;
}

// ---- comparing two versions -----------------------------------------------------------------------------------------------------------------------------------------

export interface TemplateChange {
  scope: 'template' | 'phase' | 'task';
  code: string;
  kind: 'added' | 'removed' | 'changed';
  /** The fields of the part that differ (empty for a part added or removed). */
  fields: string[];
}

const TASK_FIELDS = ['name', 'phase', 'kind', 'duration_working_days', 'required', 'responsible_role', 'approver_role', 'priority', 'predecessors', 'constraint', 'legal_doc_types', 'form_templates', 'checklist', 'kpi_codes', 'when'] as const;

const differing = <T extends object>(before: T, after: T, fields: readonly (keyof T)[]): string[] => fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map(String);

function compareParts<T extends { code: string }>(scope: 'phase' | 'task', before: readonly T[], after: readonly T[], fields: readonly (keyof T)[]): TemplateChange[] {
  const old = new Map(before.map((item) => [item.code, item]));
  const next = new Map(after.map((item) => [item.code, item]));
  const changes: TemplateChange[] = [];
  for (const [code, item] of next) {
    const was = old.get(code);
    if (was === undefined) changes.push({ scope, code, kind: 'added', fields: [] });
    else {
      const changed = differing(was, item, fields);
      if (changed.length > 0) changes.push({ scope, code, kind: 'changed', fields: changed });
    }
  }
  for (const code of old.keys()) if (!next.has(code)) changes.push({ scope, code, kind: 'removed', fields: [] });
  return changes;
}

/** What differs between two versions of a template: the template itself, then the phases and the tasks added, removed or changed. */
export function compareTemplates(before: Template, after: Template): TemplateChange[] {
  const own = differing(before, after, ['name', 'project_type']);
  return [...(own.length === 0 ? [] : [{ scope: 'template' as const, code: '', kind: 'changed' as const, fields: own }]), ...compareParts('phase', before.phases, after.phases, ['name', 'gates']), ...compareParts('task', before.tasks, after.tasks, TASK_FIELDS)];
}
