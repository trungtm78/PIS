import type { DependencyKind, GateTarget, Priority, TaskKind, TemplateParams, TemplatePhase, TemplateTask } from '../model';

/** The pure side of the template editor and the library: the shape the editor holds, the edits it makes, the checks made before anything is sent and the comparison of two versions. */

type Params = Record<string, unknown>;
type Dependency = TemplateTask['predecessors'][number];
type Constraint = NonNullable<TemplateTask['constraint']>;
type Checklist = NonNullable<TemplateTask['checklist']>[number];
type Condition = NonNullable<TemplateTask['when']>[number];

export type LegalBasisInput = NonNullable<TemplateTask['legal_basis']>[number];
export type FormPolicy = NonNullable<TemplateTask['form_policies']>[number];
export type FormPolicyKind = FormPolicy['policy'];
/** A step of a phase as the editor holds it (R44): the role that answers for it and its legal grounds are optional. */
export type EditorStep = NonNullable<TemplateParams['steps']>[number];

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
export const MAX_STEPS = 80;
export const MAX_LEGAL_BASIS = 12;
export const MAX_ARTICLE = 160;
export const MAX_NOTE = 400;
export const FORM_POLICY_KINDS: readonly FormPolicyKind[] = ['LATEST_APPROVED', 'PINNED'];
export const DOCUMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
/** The code of a form as the document store names it (document_template.template_code): capitals, digits, dot, underscore and hyphen, 3 to 80 characters. */
export const FORM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{2,79}$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * The record of the rule an entity (the template, a phase, a step, a task) was read from. It travels with the entity through every edit (a spread copies it) and is what makes a template read and written back
 * the params it was (R62): a field nobody touched is written exactly as it was stored. A row that is copied drops it (`fresh`).
 */
export const ORIGIN: unique symbol = Symbol('pwf.template.origin');
/** The code of the entity is provisional: the row was added and has no name yet, so its code is made from the name when the name is first given (R63), once. */
export const PENDING: unique symbol = Symbol('pwf.template.pendingCode');
/** What the screen keys a row by: made when a row is added and kept for as long as the row is in the editor, whatever its code becomes (the code is made from the name when the row is first named, and a row must not be drawn again then). */
export const UID: unique symbol = Symbol('pwf.template.uid');
let uidSequence = 0;
interface Marks {
  [ORIGIN]?: Params;
  [PENDING]?: true;
  [UID]?: string;
}
export const uidOf = (entity: object): string | undefined => (entity as Marks)[UID];
export const originOf = (entity: object): Params | undefined => (entity as Marks)[ORIGIN];
export const isPending = (entity: object): boolean => (entity as Marks)[PENDING] === true;
/** The entity as a new one: not read from any rule, its code final. */
export function fresh<E extends object>(entity: E): E {
  const copy = { ...entity } as E & Marks;
  delete copy[ORIGIN];
  delete copy[PENDING];
  delete copy[UID];
  return copy;
}
export const pending = <E extends object>(entity: E): E => ({ ...entity, [PENDING]: true, [UID]: `u${(uidSequence += 1)}` });
export const settled = <E extends object>(entity: E): E => {
  const copy = { ...entity } as E & Marks;
  delete copy[PENDING];
  return copy;
};

export type DurationUnit = NonNullable<TemplateTask['duration']>['unit'];
export const DURATION_UNITS: readonly DurationUnit[] = ['WORKING_DAY', 'CALENDAR_DAY', 'MONTH'];
export type TaskDuration = NonNullable<TemplateTask['duration']>;
export type TaskExtension = NonNullable<TemplateTask['extension']>;
export type ResponsibleUnit = NonNullable<TemplateTask['responsible_units']>[number];
export type UnitPart = ResponsibleUnit['part'];
/** The ladder of a task while it is typed: a line not filled yet is absent, and the checks ask for it before anything is sent. */
export interface EditorBands {
  green_days?: number;
  yellow_days?: number;
  red_days?: number;
}

/** A task as the editor holds it: every optional part of the contract is present (an empty list, no constraint). */
export type EditorTask = Omit<TemplateTask, 'constraint' | 'legal_doc_types' | 'form_templates' | 'checklist' | 'kpi_codes' | 'when' | 'bands'> & {
  constraint: Constraint | null;
  legal_doc_types: string[];
  form_templates: string[];
  checklist: Checklist[];
  kpi_codes: string[];
  when: Condition[];
  bands?: EditorBands;
};

/** A party of the project the template names itself (R61): a seat the person who starts a project fills with a real unit. */
export interface TemplateParty {
  code: string;
  name: string;
}
export const MAX_PARTIES = 30;
export const MAX_UNITS = 8;
export const BUILT_IN_PARTIES: readonly string[] = ['INVESTOR', 'DECISION_AUTHORITY'];
export const UNIT_REF_PATTERN = /^(PROJECT_OWNER|PROJECT_PARTY:[A-Z][A-Z0-9_]{1,39}|UNIT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The working days a limit stands for where no calendar is at hand (PWF 22.2): what `duration_working_days` must be when the task has a `duration`. */
export function nominalWorkingDays(value: number, unit: DurationUnit): number {
  if (unit === 'CALENDAR_DAY') return Math.max(1, Math.ceil((value * 5) / 7));
  return unit === 'MONTH' ? value * 22 : value;
}

/** A role the template names itself: the code its steps and tasks use and what people call it (a role a tenant made up has no name in the shipped catalogue). */
export interface TemplateRole {
  code: string;
  name: string;
}
export const MAX_ROLES = 60;

export interface Template {
  name: string;
  project_type: string | null;
  /** The names the template gives its own roles; absent or empty in a template that names none (its params and its hash are then what they always were). */
  roles?: TemplateRole[];
  phases: TemplatePhase[];
  /** The steps the template names (R44); absent or empty in a template without steps, where every phase is one step. */
  steps?: EditorStep[];
  tasks: EditorTask[];
  /** The parties the template names beside the investor and the authority that decides (R61); absent in a template that names none. */
  parties?: TemplateParty[];
  /** The task whose finish is the deadline of the whole file; absent or null when the template marks none. */
  overall_deadline_task?: string | null;
}

export const stepsOf = (template: Template): EditorStep[] => template.steps ?? [];
export const hasSteps = (template: Template): boolean => stepsOf(template).length > 0;

/** Every role code the steps and the tasks of the template use (who does, who approves, who answers for a step), each once, in the order they first appear. */
export function usedRoleCodes(template: Template): string[] {
  const codes = [...stepsOf(template).map((step) => step.responsible_role), ...template.tasks.flatMap((task) => [task.responsible_role, task.approver_role])];
  return [...new Set(codes.map((code) => (code ?? '').trim()).filter((code) => code !== ''))];
}

/** What the template calls a role, or undefined when it does not name it. */
export const templateRoleName = (template: Pick<Template, 'roles'>, code: string | null | undefined): string | undefined => {
  const name = (template.roles ?? []).find((role) => role.code === code)?.name.trim() ?? '';
  return name === '' ? undefined : name;
};

/** The template with the name of a role set; an empty name takes the role off the list (the screen then falls back to the shipped catalogue of roles). */
export function nameRole(template: Template, code: string, name: string): Template {
  const others = (template.roles ?? []).filter((role) => role.code !== code);
  const at = (template.roles ?? []).findIndex((role) => role.code === code);
  if (name.trim() === '') return { ...template, roles: others };
  if (at < 0) return { ...template, roles: [...others, { code, name }] };
  return { ...template, roles: (template.roles ?? []).map((role, index) => (index === at ? { code, name } : role)) };
}

export const blankTemplate = (): Template => ({ name: '', project_type: null, phases: [], tasks: [] });

// ---- reading and writing the params of a rule ----------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => options.find((option) => option === value) ?? fallback;

const readLegalBasis = (value: unknown): LegalBasisInput[] =>
  records(value).map((item) => ({
    document: text(item.document),
    ...(typeof item.article === 'string' ? { article: item.article } : {}),
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    verification: item.verification === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    // The stamp of the server (R75) is kept as it came: the editor never makes one, and drops it from a line it changes.
    ...(typeof item.verified_by === 'string' ? { verified_by: item.verified_by } : {}),
    ...(typeof item.verified_at === 'string' ? { verified_at: item.verified_at } : {}),
  }));

const readFormPolicies = (value: unknown): FormPolicy[] => records(value).map((item) => ({ form: text(item.form), policy: oneOf(FORM_POLICY_KINDS, item.policy, 'LATEST_APPROVED'), ...(typeof item.revision === 'number' ? { revision: item.revision } : {}) }));

/** The legal grounds as the rule keeps them: an article and a note that are empty are left out, never written as empty text. */
const writeLegalBasis = (basis: readonly LegalBasisInput[]): LegalBasisInput[] =>
  basis.map((one) => ({
    document: one.document.trim(),
    ...(one.article === undefined || one.article.trim() === '' ? {} : { article: one.article.trim() }),
    ...(one.note === undefined || one.note.trim() === '' ? {} : { note: one.note.trim() }),
    verification: one.verification,
    ...(one.verification === 'VERIFIED' && typeof one.verified_by === 'string' && typeof one.verified_at === 'string' ? { verified_by: one.verified_by, verified_at: one.verified_at } : {}),
  }));

const wholeOrNone = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

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
    // What a template written before steps, legal grounds and form policies does not have is not added to it (its params stay what they were).
    ...(typeof raw.step === 'string' && raw.step !== '' ? { step: raw.step } : {}),
    ...(records(raw.legal_basis).length === 0 ? {} : { legal_basis: readLegalBasis(raw.legal_basis) }),
    ...(records(raw.form_policies).length === 0 ? {} : { form_policies: readFormPolicies(raw.form_policies) }),
    // The fields of the table of steps (PWF 22.2): each is there only when the rule has it.
    ...(isRecord(raw.duration) ? { duration: { value: count(raw.duration.value), unit: oneOf(DURATION_UNITS, raw.duration.unit, 'WORKING_DAY'), roll_to_working_day: raw.duration.roll_to_working_day !== false } } : {}),
    ...(isRecord(raw.bands) ? { bands: bandsOf(raw.bands) } : {}),
    ...(records(raw.responsible_units).length === 0 ? {} : { responsible_units: records(raw.responsible_units).map((item) => ({ unit_ref: text(item.unit_ref), role: text(item.role), part: item.part === 'SUPPORT' ? ('SUPPORT' as const) : ('LEAD' as const) })) }),
    ...(isRecord(raw.extension) ? { extension: extensionOf(raw.extension) } : {}),
    [ORIGIN]: raw,
  } as EditorTask;
}

function bandsOf(raw: Record<string, unknown>): EditorBands {
  const green = wholeOrNone(raw.green_days);
  const yellow = wholeOrNone(raw.yellow_days);
  const red = wholeOrNone(raw.red_days);
  return { ...(green === undefined ? {} : { green_days: green }), ...(yellow === undefined ? {} : { yellow_days: yellow }), ...(red === undefined ? {} : { red_days: red }) };
}

function extensionOf(raw: Record<string, unknown>): TaskExtension {
  const times = wholeOrNone(raw.max_times);
  const value = wholeOrNone(raw.max_value);
  return { allowed: raw.allowed === true, ...(times === undefined ? {} : { max_times: times }), ...(value === undefined ? {} : { max_value: value }), unit: oneOf(DURATION_UNITS, raw.unit, 'WORKING_DAY') };
}

function readStep(item: Record<string, unknown>): EditorStep {
  return {
    code: text(item.code),
    name: text(item.name),
    phase: text(item.phase),
    ...(typeof item.responsible_role === 'string' && item.responsible_role !== '' ? { responsible_role: item.responsible_role } : {}),
    ...(records(item.legal_basis).length === 0 ? {} : { legal_basis: readLegalBasis(item.legal_basis) }),
    [ORIGIN]: item,
  } as EditorStep;
}

const readPhase = (item: Record<string, unknown>): TemplatePhase => ({ code: text(item.code), name: text(item.name), gates: GATE_TARGETS.filter((target) => strings(item.gates).includes(target)), [ORIGIN]: item }) as TemplatePhase;

/** Reads the params of a `PROJECT_WORKFLOW_TEMPLATE` rule into what the editor holds; what is not there is left empty, never guessed. */
export function readTemplate(params: unknown): Template {
  if (!isRecord(params)) return blankTemplate();
  return {
    name: text(params.name),
    project_type: typeof params.project_type === 'string' && params.project_type !== '' ? params.project_type : null,
    ...(records(params.roles).length === 0 ? {} : { roles: records(params.roles).map((item) => ({ code: text(item.code), name: text(item.name) })) }),
    phases: records(params.phases).map(readPhase),
    ...(records(params.steps).length === 0 ? {} : { steps: records(params.steps).map(readStep) }),
    tasks: records(params.tasks).map(readTask),
    ...(records(params.parties).length === 0 ? {} : { parties: records(params.parties).map((item) => ({ code: text(item.code), name: text(item.name) })) }),
    ...(typeof params.overall_deadline_task === 'string' && params.overall_deadline_task !== '' ? { overall_deadline_task: params.overall_deadline_task } : {}),
    [ORIGIN]: params,
  } as Template;
}

// ---- writing: a field nobody touched is written as it was stored (R62) ------------------------------------------------------------------------------------------------

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The record of an entity as the rule keeps it. `written` is what the editor writes for an entity of its own making. For an entity read from a rule every field is compared with what that rule gave: a field that is
 * what it was is written exactly as it was stored (present or absent, `null` or left out, with whatever the editor does not know of), and only a field the person changed takes the editor's own form. Keys of the
 * stored record the editor has no field for are carried over untouched: nothing is dropped on save.
 */
function preserve(entity: object, written: Params, read: (raw: Params) => object, fields: readonly string[]): Params {
  const raw = originOf(entity);
  if (raw === undefined) return written;
  const was = readOnce(raw, read);
  const now = entity as Record<string, unknown>;
  const out: Params = {};
  for (const key of Object.keys(raw)) if (!fields.includes(key)) out[key] = raw[key];
  for (const key of fields) {
    if (sameValue(now[key], was[key])) {
      if (key in raw) out[key] = raw[key];
    } else if (key in written) out[key] = written[key];
  }
  return out;
}

/** What a stored record reads as, read once: the editor asks at every keystroke. */
const READ = new WeakMap<object, Record<string, unknown>>();
function readOnce(raw: Params, read: (raw: Params) => object): Record<string, unknown> {
  const known = READ.get(raw);
  if (known !== undefined) return known;
  const made = read(raw) as Record<string, unknown>;
  READ.set(raw, made);
  return made;
}

const PHASE_KEYS: readonly string[] = ['code', 'name', 'gates'];
const STEP_KEYS: readonly string[] = ['code', 'name', 'phase', 'responsible_role', 'legal_basis'];
const TASK_KEYS: readonly string[] = ['code', 'name', 'phase', 'kind', 'duration_working_days', 'required', 'responsible_role', 'approver_role', 'priority', 'predecessors', 'constraint', 'legal_doc_types', 'form_templates', 'checklist', 'kpi_codes', 'when', 'step', 'legal_basis', 'form_policies', 'duration', 'bands', 'responsible_units', 'extension'];
/** The lists of entities (`phases`, `steps`, `tasks`) are written entity by entity, so they are fields of the template the comparison never sees as "what the rule gave". */
const ROOT_KEYS: readonly string[] = ['name', 'project_type', 'roles', 'parties', 'overall_deadline_task', 'phases', 'steps', 'tasks'];
const ROOT_OWN: readonly string[] = ['name', 'project_type', 'roles', 'parties', 'overall_deadline_task'];

const writePhase = (phase: TemplatePhase): Params => preserve(phase, { code: phase.code, name: phase.name.trim(), gates: [...phase.gates] }, readPhase, PHASE_KEYS);

const writeStep = (step: EditorStep): Params =>
  preserve(
    step,
    {
      code: step.code,
      name: step.name.trim(),
      phase: step.phase,
      ...(step.responsible_role === undefined || step.responsible_role === null || step.responsible_role.trim() === '' ? {} : { responsible_role: step.responsible_role.trim() }),
      ...((step.legal_basis ?? []).length === 0 ? {} : { legal_basis: writeLegalBasis(step.legal_basis ?? []) }),
    },
    readStep,
    STEP_KEYS,
  );

function writeTask(task: EditorTask, withSteps: boolean): Params {
  const policies = (task.form_policies ?? []).filter((policy) => task.form_templates.includes(policy.form));
  const written: Params = {
    code: task.code,
    name: task.name.trim(),
    phase: task.phase,
    kind: task.kind,
    duration_working_days: task.duration_working_days,
    required: task.required,
    responsible_role: task.responsible_role,
    // The stored form of a task nobody approves has no approver at all.
    ...(task.approver_role === null || task.approver_role === undefined || task.approver_role === '' ? {} : { approver_role: task.approver_role }),
    priority: task.priority,
    predecessors: task.predecessors,
    ...(task.constraint === null ? {} : { constraint: task.constraint }),
    legal_doc_types: task.legal_doc_types,
    form_templates: task.form_templates,
    checklist: task.checklist,
    kpi_codes: task.kpi_codes,
    when: task.when,
    ...(withSteps && typeof task.step === 'string' && task.step !== '' ? { step: task.step } : {}),
    ...((task.legal_basis ?? []).length === 0 ? {} : { legal_basis: writeLegalBasis(task.legal_basis ?? []) }),
    // The policy of a form the task no longer has goes with the form.
    ...(policies.length === 0 ? {} : { form_policies: policies.map((policy) => ({ form: policy.form, policy: policy.policy, ...(policy.policy === 'PINNED' && typeof policy.revision === 'number' ? { revision: policy.revision } : {}) })) }),
    ...(task.duration === undefined || task.kind === 'MILESTONE' ? {} : { duration: task.duration }),
    ...(task.bands === undefined || Object.keys(task.bands).length === 0 ? {} : { bands: task.bands }),
    ...((task.responsible_units ?? []).length === 0 ? {} : { responsible_units: task.responsible_units }),
    ...(task.extension === undefined ? {} : { extension: task.extension }),
  };
  const out = preserve(task, written, readTask, TASK_KEYS);
  // A task taken out of its steps names no step, whatever the rule said.
  if (!withSteps && typeof out.step === 'string') delete out.step;
  return out;
}

/** An empty list of the template is written the way it was stored (`[]` or not at all); a new template leaves it out. */
const emptyList = (template: Template, key: string): Params => {
  const raw = originOf(template);
  return raw !== undefined && Array.isArray(raw[key]) && (raw[key] as unknown[]).length === 0 ? { [key]: [] } : {};
};

/** The params the rule store keeps (snake_case, as the contract says): no empty constraint, no empty approver, no empty project type; and for a template read from a rule, every field nobody touched as it was. */
export function paramsOfTemplate(template: Template): TemplateParams & Params {
  const withSteps = hasSteps(template);
  const roles = template.roles ?? [];
  const parties = template.parties ?? [];
  const overall = template.overall_deadline_task;
  const own: Params = {
    name: template.name.trim(),
    project_type: template.project_type === null || template.project_type.trim() === '' ? null : template.project_type.trim(),
    ...(roles.length === 0 ? {} : { roles: roles.map((role) => ({ code: role.code, name: role.name.trim() })) }),
    ...(parties.length === 0 ? {} : { parties: parties.map((party) => ({ code: party.code, name: party.name.trim() })) }),
    ...(typeof overall === 'string' && overall !== '' ? { overall_deadline_task: overall } : {}),
  };
  const raw = originOf(template);
  const was = raw === undefined ? undefined : readOnce(raw, readTemplate);
  const now = template as unknown as Record<string, unknown>;
  const kept: Params = {};
  if (raw === undefined || was === undefined) Object.assign(kept, own);
  else {
    for (const key of Object.keys(raw)) if (!ROOT_KEYS.includes(key)) kept[key] = raw[key];
    for (const key of ROOT_OWN) {
      if (sameValue(now[key], was[key])) {
        if (key in raw) kept[key] = raw[key];
      } else if (key in own) kept[key] = own[key];
    }
  }
  return {
    ...kept,
    phases: template.phases.map(writePhase),
    ...(withSteps ? { steps: stepsOf(template).map(writeStep) } : emptyList(template, 'steps')),
    tasks: template.tasks.map((task) => writeTask(task, withSteps)),
  } as TemplateParams & Params;
}

export interface TemplateSummary {
  name: string;
  projectType: string | null;
  phases: number;
  /** The steps the template names; absent for a template without steps (every phase is then one step). */
  steps?: number;
  tasks: number;
}

/** What the library says of the params of a version without reading the whole template. */
export function summaryOf(params: Params): TemplateSummary {
  return {
    name: text(params.name),
    projectType: typeof params.project_type === 'string' ? params.project_type : null,
    phases: Array.isArray(params.phases) ? params.phases.length : 0,
    ...(Array.isArray(params.steps) && params.steps.length > 0 ? { steps: params.steps.length } : {}),
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
  return {
    ...template,
    phases: template.phases.filter((_, at) => at !== index),
    ...(template.steps === undefined ? {} : { steps: template.steps.filter((step) => step.phase !== phase.code) }),
    tasks: tasks.map((task) => ({ ...task, predecessors: task.predecessors.filter((link) => !gone.has(link.task)) })),
  };
}

export function renamePhase(template: Template, index: number, code: string): Template {
  const old = template.phases[index]?.code;
  if (old === undefined) return template;
  return {
    ...template,
    phases: template.phases.map((phase, at) => (at === index ? { ...phase, code } : phase)),
    ...(template.steps === undefined ? {} : { steps: template.steps.map((step) => (step.phase === old ? { ...step, phase: code } : step)) }),
    tasks: template.tasks.map((task) => (task.phase === old ? { ...task, phase: code } : task)),
  };
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
  // In a template with steps a new task goes to the first step of its phase (the person moves it).
  const step = stepsOf(template).find((one) => one.phase === phase);
  return { ...template, tasks: [...template.tasks, step === undefined ? task : { ...task, step: step.code }] };
}

// ---- the steps (R44) ----------------------------------------------------------------------------------------------------------------------------------------------------

/** Gives a template without steps one step per phase (the name of the phase) and puts every task in the step of its phase: the starting point from which steps are split. */
export function enableSteps(template: Template): Template {
  if (hasSteps(template)) return template;
  const taken: string[] = [];
  const byPhase = new Map<string, string>();
  const steps: EditorStep[] = template.phases.map((phase) => {
    const code = CODE_PATTERN.test(`S_${phase.code}`) && !taken.includes(`S_${phase.code}`) ? `S_${phase.code}` : nextCode('S', taken);
    taken.push(code);
    byPhase.set(phase.code, code);
    return { code, name: phase.name, phase: phase.code };
  });
  return { ...template, steps, tasks: template.tasks.map((task) => (byPhase.has(task.phase) ? { ...task, step: byPhase.get(task.phase) as string } : task)) };
}

/** Takes the steps away again: the template is in two tiers as before, every phase standing for one step. The legal grounds of the steps go with them. */
export function disableSteps(template: Template): Template {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the steps are what is dropped
  const { steps, ...rest } = template;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the step of each task is what is dropped
  return { ...rest, tasks: template.tasks.map(({ step, ...task }) => task) };
}

export function addStep(template: Template, phase: string): Template {
  const steps = stepsOf(template);
  if (steps.length >= MAX_STEPS) return template;
  return { ...template, steps: [...steps, { code: nextCode('S', steps.map((step) => step.code)), name: '', phase }] };
}

export function updateStep(template: Template, index: number, patch: Partial<EditorStep>): Template {
  const steps = stepsOf(template);
  const old = steps[index];
  if (old === undefined) return template;
  const next = { ...old, ...patch };
  // A step that moves to another phase leaves its tasks where they are: they now name a step of another phase, which the checks say.
  return { ...template, steps: steps.map((step, at) => (at === index ? next : step)) };
}

/** A step code is changed in every task that names it. */
export function renameStep(template: Template, index: number, code: string): Template {
  const old = stepsOf(template)[index]?.code;
  if (old === undefined) return template;
  return { ...template, steps: stepsOf(template).map((step, at) => (at === index ? { ...step, code } : step)), tasks: template.tasks.map((task) => (task.step === old ? { ...task, step: code } : task)) };
}

/** A step is removed and its tasks go to another step of the same phase when there is one; removing the last step of the template takes the steps away altogether. */
export function removeStep(template: Template, index: number): Template {
  const steps = stepsOf(template);
  const gone = steps[index];
  if (gone === undefined) return template;
  const left = steps.filter((_, at) => at !== index);
  if (left.length === 0) return disableSteps(template);
  const heir = left.find((step) => step.phase === gone.phase)?.code;
  return {
    ...template,
    steps: left,
    tasks: template.tasks.map((task) => {
      if (task.step !== gone.code) return task;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a task with no step left to go to names none (the checks say so)
      const { step, ...rest } = task;
      return heir === undefined ? rest : { ...rest, step: heir };
    }),
  };
}

export interface StepGroup {
  phase: TemplatePhase | null;
  steps: { index: number; step: EditorStep; tasks: number }[];
}

/** The steps under their phase in the order of the phases, each with how many tasks it has; steps of a phase that is not there are kept apart. */
export function groupSteps(template: Template): StepGroup[] {
  const indexed = stepsOf(template).map((step, index) => ({ index, step, tasks: template.tasks.filter((task) => task.step === step.code).length }));
  const groups: StepGroup[] = template.phases.map((phase) => ({ phase, steps: indexed.filter((item) => item.step.phase === phase.code) }));
  const orphans = indexed.filter((item) => !template.phases.some((phase) => phase.code === item.step.phase));
  return orphans.length === 0 ? groups : [...groups, { phase: null, steps: orphans }];
}

/** The revision policy of a form of a task: what the task says, else the newest approved revision. */
export const formPolicyOf = (task: Pick<EditorTask, 'form_policies'>, form: string): FormPolicy => (task.form_policies ?? []).find((one) => one.form === form) ?? { form, policy: 'LATEST_APPROVED' };

/** Sets the policy of one form of a task; `LATEST_APPROVED` is the absence of a policy, so the list holds only the pinned forms. */
export function setFormPolicy(task: EditorTask, form: string, policy: FormPolicyKind, revision: number | null): FormPolicy[] {
  const others = (task.form_policies ?? []).filter((one) => one.form !== form && task.form_templates.includes(one.form));
  return policy === 'PINNED' ? [...others, { form, policy, ...(revision === null ? {} : { revision }) }] : others;
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
    ...(template.overall_deadline_task === old ? { overall_deadline_task: code } : {}),
    tasks: template.tasks.map((task, at) => {
      const named = at === index ? { ...task, code } : task;
      return named.predecessors.some((link) => link.task === old) ? { ...named, predecessors: named.predecessors.map((link) => (link.task === old ? { ...link, task: code } : link)) } : named;
    }),
  };
}

export function removeTask(template: Template, index: number): Template {
  const old = template.tasks[index]?.code;
  if (old === undefined) return template;
  const left = { ...template, tasks: template.tasks.filter((_, at) => at !== index).map((task) => (task.predecessors.some((link) => link.task === old) ? { ...task, predecessors: task.predecessors.filter((link) => link.task !== old) } : task)) };
  // The mark of the overall deadline goes with the task it was on (no other task is taken in its place).
  if (template.overall_deadline_task !== old) return left;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the mark is what is dropped
  const { overall_deadline_task: gone, ...rest } = left;
  return rest;
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

export type TemplateProblemKind = 'required' | 'pattern' | 'duplicate' | 'range' | 'length' | 'limit' | 'unknownRef' | 'selfLink' | 'nominal' | 'bandOrder' | 'oneLead' | 'leadRole' | 'extensionUnit' | 'capsNotAllowed' | 'milestoneLimit';
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
  out.push(...codeListProblems(`${path}.form_templates`, task.form_templates, FORM_CODE_PATTERN));
  out.push(...codeListProblems(`${path}.kpi_codes`, task.kpi_codes));
  out.push(...legalBasisProblems(path, task.legal_basis ?? []));
  (task.form_policies ?? []).forEach((policy, at) => {
    if (!task.form_templates.includes(policy.form)) return;
    // A pinned form names the revision it is pinned to.
    if (policy.policy === 'PINNED' && !(typeof policy.revision === 'number' && whole(policy.revision, 1, 100000))) out.push({ path: `${path}.form_policies[${at}].revision`, problem: 'range' });
  });
  return out;
}

/** A legal ground cites a document of the catalogue by its code, once per article; the article and the note keep within their length. */
function legalBasisProblems(path: string, basis: readonly LegalBasisInput[]): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  if (basis.length > MAX_LEGAL_BASIS) out.push({ path: `${path}.legal_basis`, problem: 'limit' });
  const seen = new Set<string>();
  basis.forEach((one, at) => {
    const base = `${path}.legal_basis[${at}]`;
    if (one.document.trim() === '') out.push({ path: `${base}.document`, problem: 'required' });
    else if (!DOCUMENT_CODE_PATTERN.test(one.document)) out.push({ path: `${base}.document`, problem: 'pattern' });
    const key = `${one.document}|${(one.article ?? '').trim()}`;
    if (seen.has(key)) out.push({ path: `${base}.document`, problem: 'duplicate' });
    seen.add(key);
    if ((one.article ?? '').trim().length > MAX_ARTICLE) out.push({ path: `${base}.article`, problem: 'length' });
    if ((one.note ?? '').trim().length > MAX_NOTE) out.push({ path: `${base}.note`, problem: 'length' });
  });
  return out;
}

function taskProblems(task: EditorTask, index: number, taken: ReadonlySet<string>, codes: ReadonlySet<string>, phases: ReadonlySet<string>, stepPhase: ReadonlyMap<string, string>, parties: ReadonlySet<string>): TemplateProblem[] {
  const path = `tasks[${index}]`;
  const out: TemplateProblem[] = [];
  const push = (problem: TemplateProblem | undefined): void => {
    if (problem !== undefined) out.push(problem);
  };
  push(codeProblem(`${path}.code`, task.code, taken));
  push(nameProblem(`${path}.name`, task.name, 200));
  if (!phases.has(task.phase)) out.push({ path: `${path}.phase`, problem: 'unknownRef' });
  // In a template with steps every task names a step of its own phase (R44).
  if (stepPhase.size > 0) {
    if (task.step === undefined || task.step === null || task.step === '') out.push({ path: `${path}.step`, problem: 'required' });
    else if (stepPhase.get(task.step) !== task.phase) out.push({ path: `${path}.step`, problem: 'unknownRef' });
  }
  if (!whole(task.duration_working_days, 0, MAX_DURATION)) out.push({ path: `${path}.duration_working_days`, problem: 'range' });
  push(codeProblem(`${path}.responsible_role`, task.responsible_role));
  if (typeof task.approver_role === 'string' && !CODE_PATTERN.test(task.approver_role)) out.push({ path: `${path}.approver_role`, problem: 'pattern' });
  out.push(...linkProblems(path, task, codes), ...detailProblems(path, task), ...tableProblems(path, task, parties));
  return out;
}

/** The rules of the fields of the table of steps (PWF 22.2), each told at the field it is about. */
function tableProblems(path: string, task: EditorTask, parties: ReadonlySet<string>): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const limit = task.duration;
  if (limit !== undefined) {
    if (task.kind === 'MILESTONE') out.push({ path: `${path}.duration`, problem: 'milestoneLimit' });
    else if (!whole(limit.value, 1, MAX_DURATION)) out.push({ path: `${path}.duration.value`, problem: 'range' });
    // The old field is never typed freely beside a limit in its own unit: it is the nominal value of that limit.
    else if (task.duration_working_days !== nominalWorkingDays(limit.value, limit.unit)) out.push({ path: `${path}.duration_working_days`, problem: 'nominal' });
  }
  const bands = task.bands;
  if (bands !== undefined && Object.keys(bands).length > 0) {
    const { green_days: green, yellow_days: yellow, red_days: red } = bands;
    if (yellow === undefined) out.push({ path: `${path}.bands.yellow_days`, problem: 'required' });
    else if (!whole(yellow, 0, 3650)) out.push({ path: `${path}.bands.yellow_days`, problem: 'range' });
    if (red === undefined) out.push({ path: `${path}.bands.red_days`, problem: 'required' });
    else if (!whole(red, -1, 3650)) out.push({ path: `${path}.bands.red_days`, problem: 'range' });
    if (green !== undefined && !whole(green, 1, 3650)) out.push({ path: `${path}.bands.green_days`, problem: 'range' });
    // The ladder is strict: green above yellow above red.
    if (yellow !== undefined && red !== undefined && (yellow <= red || (green !== undefined && green <= yellow))) out.push({ path: `${path}.bands`, problem: 'bandOrder' });
  }
  const units = task.responsible_units ?? [];
  if (units.length > 0) {
    if (units.length > MAX_UNITS) out.push({ path: `${path}.responsible_units`, problem: 'limit' });
    const seen = new Set<string>();
    units.forEach((unit, at) => {
      const base = `${path}.responsible_units[${at}]`;
      if (unit.unit_ref === '') out.push({ path: `${base}.unit_ref`, problem: 'required' });
      else if (!UNIT_REF_PATTERN.test(unit.unit_ref)) out.push({ path: `${base}.unit_ref`, problem: 'pattern' });
      else if (unit.unit_ref.startsWith('PROJECT_PARTY:') && !parties.has(unit.unit_ref.slice('PROJECT_PARTY:'.length))) out.push({ path: `${base}.unit_ref`, problem: 'unknownRef' });
      if (unit.role === '') out.push({ path: `${base}.role`, problem: 'required' });
      else if (!CODE_PATTERN.test(unit.role)) out.push({ path: `${base}.role`, problem: 'pattern' });
      const key = `${unit.unit_ref}|${unit.role}`;
      if (seen.has(key)) out.push({ path: `${base}.unit_ref`, problem: 'duplicate' });
      seen.add(key);
    });
    const leads = units.filter((unit) => unit.part === 'LEAD');
    if (leads.length !== 1) out.push({ path: `${path}.responsible_units`, problem: 'oneLead' });
    // One truth for the role that answers for the task: the role of the unit that leads.
    else if (leads[0]?.role !== task.responsible_role) out.push({ path: `${path}.responsible_units`, problem: 'leadRole' });
  }
  const extension = task.extension;
  if (extension !== undefined) {
    if (extension.unit !== (limit?.unit ?? 'WORKING_DAY')) out.push({ path: `${path}.extension.unit`, problem: 'extensionUnit' });
    if (!extension.allowed && (extension.max_times !== undefined || extension.max_value !== undefined)) out.push({ path: `${path}.extension`, problem: 'capsNotAllowed' });
    if (extension.max_times !== undefined && !whole(extension.max_times, 1, 20)) out.push({ path: `${path}.extension.max_times`, problem: 'range' });
    if (extension.max_value !== undefined && !whole(extension.max_value, 1, MAX_DURATION)) out.push({ path: `${path}.extension.max_value`, problem: 'range' });
  }
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
  const roles = template.roles ?? [];
  if (roles.length > MAX_ROLES) out.push({ path: 'roles', problem: 'limit' });
  const roleCodes = new Set<string>();
  roles.forEach((role, index) => {
    const code = codeProblem(`roles[${index}].code`, role.code, roleCodes);
    if (code !== undefined) out.push(code);
    roleCodes.add(role.code);
    const label = nameProblem(`roles[${index}].name`, role.name, 120);
    if (label !== undefined) out.push(label);
  });
  const steps = stepsOf(template);
  if (steps.length > MAX_STEPS) out.push({ path: 'steps', problem: 'limit' });
  const stepCodes = new Set<string>();
  const stepPhase = new Map<string, string>();
  steps.forEach((step, index) => {
    const at = `steps[${index}]`;
    const code = codeProblem(`${at}.code`, step.code, stepCodes);
    if (code !== undefined) out.push(code);
    stepCodes.add(step.code);
    stepPhase.set(step.code, step.phase);
    const label = nameProblem(`${at}.name`, step.name, 200);
    if (label !== undefined) out.push(label);
    if (!phaseCodes.has(step.phase)) out.push({ path: `${at}.phase`, problem: 'unknownRef' });
    if (typeof step.responsible_role === 'string' && step.responsible_role !== '' && !CODE_PATTERN.test(step.responsible_role)) out.push({ path: `${at}.responsible_role`, problem: 'pattern' });
    // A step with no task is not a step of the procedure.
    if (!template.tasks.some((task) => task.step === step.code)) out.push({ path: `${at}.tasks`, problem: 'required' });
    out.push(...legalBasisProblems(at, step.legal_basis ?? []));
  });
  const declared = template.parties ?? [];
  if (declared.length > MAX_PARTIES) out.push({ path: 'parties', problem: 'limit' });
  const partyCodes = new Set<string>(BUILT_IN_PARTIES);
  declared.forEach((party, index) => {
    // The two parties every project has are not declared a second time.
    const code = codeProblem(`parties[${index}].code`, party.code, partyCodes);
    if (code !== undefined) out.push(code);
    partyCodes.add(party.code);
    const label = nameProblem(`parties[${index}].name`, party.name, 120);
    if (label !== undefined) out.push(label);
  });
  const allCodes = new Set(template.tasks.map((task) => task.code));
  const taken = new Set<string>();
  template.tasks.forEach((task, index) => {
    out.push(...taskProblems(task, index, taken, allCodes, phaseCodes, stepPhase, partyCodes));
    taken.add(task.code);
  });
  const overall = template.overall_deadline_task;
  if (typeof overall === 'string' && overall !== '' && !allCodes.has(overall)) out.push({ path: 'overall_deadline_task', problem: 'unknownRef' });
  return out;
}

// ---- comparing two versions -----------------------------------------------------------------------------------------------------------------------------------------

export interface TemplateChange {
  scope: 'template' | 'phase' | 'step' | 'task';
  code: string;
  kind: 'added' | 'removed' | 'changed';
  /** The fields of the part that differ (empty for a part added or removed). */
  fields: string[];
}

const TASK_FIELDS = ['name', 'phase', 'step', 'kind', 'duration_working_days', 'required', 'responsible_role', 'approver_role', 'priority', 'predecessors', 'constraint', 'legal_doc_types', 'form_templates', 'form_policies', 'legal_basis', 'checklist', 'kpi_codes', 'when', 'duration', 'bands', 'responsible_units', 'extension'] as const;
const STEP_FIELDS = ['name', 'phase', 'responsible_role', 'legal_basis'] as const;

const differing = <T extends object>(before: T, after: T, fields: readonly (keyof T)[]): string[] => fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map(String);

function compareParts<T extends { code: string }>(scope: 'phase' | 'step' | 'task', before: readonly T[], after: readonly T[], fields: readonly (keyof T)[]): TemplateChange[] {
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
  const own = differing(before, after, ['name', 'project_type', 'overall_deadline_task', 'parties']);
  return [...(own.length === 0 ? [] : [{ scope: 'template' as const, code: '', kind: 'changed' as const, fields: own }]), ...compareParts('phase', before.phases, after.phases, ['name', 'gates']), ...compareParts('step', stepsOf(before), stepsOf(after), STEP_FIELDS), ...compareParts('task', before.tasks, after.tasks, TASK_FIELDS)];
}

/** What a template holds, counted for the outline above the tabs of the editor (PWF-02): each figure is read from the template on the screen, nothing is asked of the server. */
export interface TemplateFigures {
  phases: number;
  /** Gates of PRJ commands or events over all phases. */
  gates: number;
  tasks: number;
  workingDays: number;
  required: number;
  withResponsible: number;
  withApprover: number;
  /** Links between tasks by kind, and how many of them carry a lag. */
  links: Readonly<Record<'FS' | 'SS' | 'FF' | 'SF', number>>;
  lagged: number;
  /** Tasks that only exist on a branch (a condition on the group of the project, the source of the funding or the kind of project). */
  branched: number;
  legalDocTypes: number;
  forms: number;
  checklistItems: number;
  withKpi: number;
}

export function templateFigures(template: Template): TemplateFigures {
  const links = { FS: 0, SS: 0, FF: 0, SF: 0 };
  let lagged = 0;
  const legal = new Set<string>();
  const forms = new Set<string>();
  for (const task of template.tasks) {
    for (const link of task.predecessors) {
      links[link.kind] += 1;
      if (link.lag_working_days !== 0) lagged += 1;
    }
    for (const code of task.legal_doc_types) legal.add(code);
    for (const code of task.form_templates) forms.add(code);
  }
  return {
    phases: template.phases.length,
    gates: template.phases.reduce((sum, phase) => sum + phase.gates.length, 0),
    tasks: template.tasks.length,
    workingDays: template.tasks.reduce((sum, task) => sum + (Number.isFinite(task.duration_working_days) ? task.duration_working_days : 0), 0),
    required: template.tasks.filter((task) => task.required).length,
    withResponsible: template.tasks.filter((task) => task.responsible_role !== '').length,
    withApprover: template.tasks.filter((task) => task.approver_role !== null && task.approver_role !== undefined && task.approver_role !== '').length,
    links,
    lagged,
    branched: template.tasks.filter((task) => task.when.length > 0).length,
    legalDocTypes: legal.size,
    forms: forms.size,
    checklistItems: template.tasks.reduce((sum, task) => sum + task.checklist.length, 0),
    withKpi: template.tasks.filter((task) => task.kpi_codes.length > 0).length,
  };
}
