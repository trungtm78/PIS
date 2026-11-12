import { isEvidenceKind } from './bid-workflow.ts';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { TASK_KINDS, TASK_PRIORITIES } from './deadline-band.ts';
import { DOCUMENT_CLASSES } from './doc-repository.ts';
import { DomainError } from './errors.ts';
import type { FieldSpec, RuleParams, RuleRegistry } from './governance-rules.ts';
import { PWF_TEXT as T } from './messages/pwf-texts.ts';
import { PUBLIC_INVESTMENT_TEMPLATE, PUBLIC_LEGAL_DOC_TYPES, PUBLIC_PROCUREMENT_TEMPLATE, PUBLIC_REPAIR_TEMPLATE } from './project-workflow-defaults.ts';
import { findingOf } from './rule-findings.ts';
import type { RuleFinding } from './rule-findings.ts';

/**
 * The workflow of a project (PWF-1): a template of phases and tasks that a project takes a frozen copy of when it starts (or when a running project is taken in), from which the schedule, the deadlines and the KPIs of the project follow. This
 * module is the DATA side and the pure checks: the rule type `PROJECT_WORKFLOW_TEMPLATE` (one code per kind of project, versioned and approved through the governance store like every rule), the validation of a template, the dependency graph, the
 * conditional branches, the references to documents, forms, KPIs and roles, whether one task may be completed, and whether a legal command of the project (a change of stage) may run. The dates are computed in project-schedule.ts.
 *
 * The phases of a workflow are NOT the legal stages of the project (PIMA, the table of `prj-stage-machine.ts`): they are configured by the template, and a phase says which legal commands (or events of the system) it opens a gate for. The gate is checked
 * in the same transaction as the command; a project that has no workflow behaves as it always did.
 */

export const PROJECT_WORKFLOW_RULE_TYPE = 'PROJECT_WORKFLOW_TEMPLATE';

export const DEPENDENCY_KINDS = ['FS', 'SS', 'FF', 'SF'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
/** Start no earlier than, start no later than, finish no earlier than, finish no later than, must start on, must finish on. Plain "as soon as possible" is the absence of a constraint. */
export const CONSTRAINT_KINDS = ['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];
/** The facts of a project that a conditional branch may read. */
export const CONDITION_FIELDS = ['project_group', 'funding_source', 'project_type'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export type ProjectFacts = Partial<Record<ConditionField, string>>;

/** The legal commands of the project and the events of the system that a phase may open a gate for (the edges of the PIMA table, `prj-stage-machine.ts`). */
export const WORKFLOW_GATE_TARGETS = [
  'submitProjectForAppraisal',
  'decideProjectAppraisal',
  'capital.plan_published.v1',
  'startProjectImplementation',
  'suspendProject',
  'resumeProject',
  'completeProject',
  'settlement.closed.v1',
  'closeProject',
] as const;
export type GateTarget = (typeof WORKFLOW_GATE_TARGETS)[number];

/** Limits of a template (R35): a graph is bounded in tasks and in the depth of its longest chain, so that the scheduler and the screens have a known cost. */
export const MAX_TEMPLATE_TASKS = 400;
export const MAX_TEMPLATE_DEPTH = 100;
export const MAX_TEMPLATE_PHASES = 12;

const invalid = (field: string): DomainError => new DomainError('PROJECT_WORKFLOW_TEMPLATE_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The shape of a template.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TemplateDependency {
  task: string;
  kind: DependencyKind;
  /** Working days between the two ends the kind ties together; negative is a lead (the successor may start before the predecessor ends). */
  lagWorkingDays: number;
}

export interface TemplateConstraint {
  kind: ConstraintKind;
  /** Working days after the planned start of the project (0: the first working day on or after it). */
  offsetWorkingDays: number;
}

export interface TemplateCondition {
  field: ConditionField;
  in: readonly string[];
}

export interface TemplateChecklistItem {
  code: string;
  name: string;
  required: boolean;
  evidenceKinds: readonly string[];
}

export interface TemplateTask {
  code: string;
  name: string;
  phase: string;
  kind: (typeof TASK_KINDS)[number];
  durationWorkingDays: number;
  required: boolean;
  responsibleRole: string;
  /** The role that approves the completion; the person who approves is never one who did the work. */
  approverRole: string | null;
  priority: (typeof TASK_PRIORITIES)[number];
  predecessors: readonly TemplateDependency[];
  constraint: TemplateConstraint | null;
  /** Types of legal documents the task needs before it is done, as the edition names them (resolved by `resolveLegalDocType`). */
  legalDocTypes: readonly string[];
  /** Codes of the form templates (`document_template`) the task produces. */
  formTemplates: readonly string[];
  checklist: readonly TemplateChecklistItem[];
  /** Codes of `KPI_DEFINITION` that are measured on this task. */
  kpiCodes: readonly string[];
  /** All of them must hold for the task to be part of a project; a task with none is in every project. */
  when: readonly TemplateCondition[];
}

export interface TemplatePhase {
  code: string;
  name: string;
  /** 1-based position in the template. */
  order: number;
  /** The legal commands and system events that stay closed until every required task of this phase is done. */
  gates: readonly GateTarget[];
}

export interface ProjectWorkflowTemplate {
  name: string;
  projectType: string | null;
  phases: readonly TemplatePhase[];
  tasks: readonly TemplateTask[];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The closed schema of the rule type (the FieldSpec language of governance-rules.ts).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const codeText = (optional = false): FieldSpec => ({ kind: 'text', max: 40, optional, pattern: '^[A-Z][A-Z0-9_]{1,39}$' });
const gateTarget: FieldSpec = { kind: 'enum', values: WORKFLOW_GATE_TARGETS };
const object = (fields: Record<string, FieldSpec>): FieldSpec => ({ kind: 'object', fields });
const list = (of: FieldSpec, max: number, min = 0): FieldSpec => ({ kind: 'list', of, max, min });

const DEPENDENCY: FieldSpec = object({
  task: codeText(),
  kind: { kind: 'enum', values: DEPENDENCY_KINDS },
  lag_working_days: { kind: 'int', min: -365, max: 365 },
});

const CHECKLIST_ITEM: FieldSpec = object({
  code: codeText(),
  name: { kind: 'text', max: 200 },
  required: { kind: 'boolean' },
  evidence_kinds: list(codeText(), 10),
});

const CONDITION: FieldSpec = object({
  field: { kind: 'enum', values: CONDITION_FIELDS },
  in: list({ kind: 'text', max: 40, pattern: '^[A-Za-z0-9_.-]{1,40}$' }, 20, 1),
});

const TASK: FieldSpec = object({
  code: codeText(),
  name: { kind: 'text', max: 200 },
  phase: codeText(),
  kind: { kind: 'enum', values: TASK_KINDS },
  duration_working_days: { kind: 'int', min: 0, max: 1095 },
  required: { kind: 'boolean' },
  responsible_role: codeText(),
  approver_role: codeText(true),
  priority: { kind: 'enum', values: TASK_PRIORITIES },
  predecessors: list(DEPENDENCY, 20),
  constraint: { ...object({ kind: { kind: 'enum', values: CONSTRAINT_KINDS }, offset_working_days: { kind: 'int', min: 0, max: 1095 } }), optional: true },
  legal_doc_types: list(codeText(), 10),
  form_templates: list(codeText(), 10),
  checklist: list(CHECKLIST_ITEM, 30),
  kpi_codes: list(codeText(), 10),
  when: list(CONDITION, 5),
});

const PHASE: FieldSpec = object({
  code: codeText(),
  name: { kind: 'text', max: 120 },
  gates: list(gateTarget, 10),
});

export const PROJECT_WORKFLOW_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  name: { kind: 'text', max: 200 },
  project_type: codeText(true),
  phases: list(PHASE, MAX_TEMPLATE_PHASES, 1),
  tasks: list(TASK, MAX_TEMPLATE_TASKS, 1),
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The dependency graph.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the graph functions need of a task: its code and the codes it follows. */
export interface GraphTask {
  code: string;
  predecessors: ReadonlyArray<{ task: string }>;
}

/** The tasks of one loop of dependencies (in no special order), or null when there is none. Links to a code that is not in the list are ignored here (a template check names them separately). */
export function findDependencyCycle(tasks: readonly GraphTask[]): string[] | null {
  const known = new Set(tasks.map((one) => one.code));
  const byCode = new Map(tasks.map((one) => [one.code, one] as const));
  const state = new Map<string, 'OPEN' | 'DONE'>();
  for (const start of tasks) {
    if (state.has(start.code)) continue;
    const stack: Array<{ code: string; next: number }> = [{ code: start.code, next: 0 }];
    const path: string[] = [start.code];
    state.set(start.code, 'OPEN');
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { code: string; next: number };
      const links = (byCode.get(top.code) as GraphTask).predecessors;
      if (top.next >= links.length) {
        state.set(top.code, 'DONE');
        stack.pop();
        path.pop();
        continue;
      }
      const target = (links[top.next] as { task: string }).task;
      top.next += 1;
      if (!known.has(target)) continue;
      const seen = state.get(target);
      if (seen === 'OPEN') return path.slice(path.indexOf(target));
      if (seen === 'DONE') continue;
      state.set(target, 'OPEN');
      stack.push({ code: target, next: 0 });
      path.push(target);
    }
  }
  return null;
}

/** The codes in an order where every predecessor comes before its successors; ties keep the order of the list, so the result is stable. A loop is 422 PWF_DEPENDENCY_CYCLE. */
export function topologicalOrder(tasks: readonly GraphTask[]): string[] {
  const known = new Set(tasks.map((one) => one.code));
  const waiting = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const one of tasks) {
    const links = one.predecessors.filter((link) => known.has(link.task));
    waiting.set(one.code, links.length);
    for (const link of links) successors.set(link.task, [...(successors.get(link.task) ?? []), one.code]);
  }
  const order: string[] = [];
  const ready = tasks.filter((one) => waiting.get(one.code) === 0).map((one) => one.code);
  const index = new Map(tasks.map((one, position) => [one.code, position] as const));
  while (ready.length > 0) {
    ready.sort((left, right) => (index.get(left) as number) - (index.get(right) as number));
    const code = ready.shift() as string;
    order.push(code);
    for (const next of successors.get(code) ?? []) {
      const left = (waiting.get(next) as number) - 1;
      waiting.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (order.length !== tasks.length) throw new DomainError('PWF_DEPENDENCY_CYCLE', 422, 'predecessors');
  return order;
}

/** The number of tasks on the longest chain of predecessors (a single task is 1). The graph must have no loop. */
export function dependencyDepth(tasks: readonly GraphTask[]): number {
  const byCode = new Map(tasks.map((one) => [one.code, one] as const));
  const depth = new Map<string, number>();
  let longest = 0;
  for (const code of topologicalOrder(tasks)) {
    const links = (byCode.get(code) as GraphTask).predecessors.filter((link) => byCode.has(link.task));
    const value = 1 + Math.max(0, ...links.map((link) => depth.get(link.task) as number));
    depth.set(code, value);
    longest = Math.max(longest, value);
  }
  return longest;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading and checking the params.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The first thing wrong with a template that the closed schema cannot say, as the path of the field (never a value), or undefined. Safe on any input. */
export function templateDefect(params: unknown): string | undefined {
  if (!isRecord(params) || !Array.isArray(params.phases) || !Array.isArray(params.tasks)) return 'params';
  const phases = params.phases as unknown[];
  const tasks = params.tasks as unknown[];
  const phaseCodes = new Set<string>();
  for (const [index, raw] of phases.entries()) {
    const phase = isRecord(raw) ? raw : {};
    if (typeof phase.code !== 'string' || phaseCodes.has(phase.code)) return `phases[${index}].code`;
    phaseCodes.add(phase.code);
    const gates = new Set<unknown>();
    for (const [position, gate] of arrayOf(phase.gates).entries()) {
      if (gates.has(gate)) return `phases[${index}].gates[${position}]`;
      gates.add(gate);
    }
  }
  const codes = new Set<string>();
  const usedPhases = new Set<string>();
  const parsed: GraphTask[] = [];
  for (const [index, raw] of tasks.entries()) {
    const at = `tasks[${index}]`;
    const one = isRecord(raw) ? raw : {};
    if (typeof one.code !== 'string' || codes.has(one.code)) return `${at}.code`;
    codes.add(one.code);
    if (typeof one.phase !== 'string' || !phaseCodes.has(one.phase)) return `${at}.phase`;
    usedPhases.add(one.phase);
    const duration = one.duration_working_days;
    if (one.kind === 'MILESTONE' ? duration !== 0 : typeof duration !== 'number' || duration < 1) return `${at}.duration_working_days`;
    const links = new Set<string>();
    for (const [position, link] of arrayOf(one.predecessors).entries()) {
      const edge = isRecord(link) ? link : {};
      const key = `${String(edge.task)}:${String(edge.kind)}`;
      if (typeof edge.task !== 'string' || edge.task === one.code || links.has(key)) return `${at}.predecessors[${position}].task`;
      links.add(key);
    }
    const checklist = new Set<string>();
    for (const [position, entry] of arrayOf(one.checklist).entries()) {
      const check = isRecord(entry) ? entry : {};
      if (typeof check.code !== 'string' || checklist.has(check.code)) return `${at}.checklist[${position}].code`;
      checklist.add(check.code);
      for (const [kindIndex, kind] of arrayOf(check.evidence_kinds).entries()) if (!isEvidenceKind(kind)) return `${at}.checklist[${position}].evidence_kinds[${kindIndex}]`;
    }
    for (const field of ['legal_doc_types', 'form_templates'] as const) {
      const seen = new Set<unknown>();
      for (const [position, code] of arrayOf(one[field]).entries()) {
        if (seen.has(code)) return `${at}.${field}[${position}]`;
        seen.add(code);
      }
    }
    const fields = new Set<unknown>();
    for (const [position, condition] of arrayOf(one.when).entries()) {
      const rule = isRecord(condition) ? condition : {};
      if (fields.has(rule.field)) return `${at}.when[${position}].field`;
      fields.add(rule.field);
      const values = arrayOf(rule.in);
      if (new Set(values).size !== values.length) return `${at}.when[${position}].in`;
    }
    parsed.push({ code: one.code, predecessors: arrayOf(one.predecessors).map((link) => ({ task: String((link as { task?: unknown }).task) })) });
  }
  for (const [index, raw] of phases.entries()) if (!usedPhases.has((raw as { code: string }).code)) return `phases[${index}].code`;
  for (const [index, one] of parsed.entries()) for (const [position, link] of one.predecessors.entries()) if (!codes.has(link.task)) return `tasks[${index}].predecessors[${position}].task`;
  const loop = findDependencyCycle(parsed);
  if (loop !== null) return `tasks[${parsed.findIndex((one) => one.code === loop[0])}].predecessors`;
  if (dependencyDepth(parsed) > MAX_TEMPLATE_DEPTH) return 'tasks';
  return undefined;
}

const text = (value: unknown): string => String(value);
const strings = (value: unknown): string[] => arrayOf(value).map(text);

function taskOf(raw: Record<string, unknown>): TemplateTask {
  const constraint = isRecord(raw.constraint) ? { kind: raw.constraint.kind as ConstraintKind, offsetWorkingDays: raw.constraint.offset_working_days as number } : null;
  return {
    code: text(raw.code),
    name: text(raw.name),
    phase: text(raw.phase),
    kind: raw.kind as TemplateTask['kind'],
    durationWorkingDays: raw.duration_working_days as number,
    required: raw.required === true,
    responsibleRole: text(raw.responsible_role),
    approverRole: typeof raw.approver_role === 'string' ? raw.approver_role : null,
    priority: raw.priority as TemplateTask['priority'],
    predecessors: arrayOf(raw.predecessors).map((link) => {
      const edge = link as Record<string, unknown>;
      return { task: text(edge.task), kind: edge.kind as DependencyKind, lagWorkingDays: edge.lag_working_days as number };
    }),
    constraint,
    legalDocTypes: strings(raw.legal_doc_types),
    formTemplates: strings(raw.form_templates),
    checklist: arrayOf(raw.checklist).map((entry) => {
      const check = entry as Record<string, unknown>;
      return { code: text(check.code), name: text(check.name), required: check.required === true, evidenceKinds: strings(check.evidence_kinds) };
    }),
    kpiCodes: strings(raw.kpi_codes),
    when: arrayOf(raw.when).map((entry) => {
      const condition = entry as Record<string, unknown>;
      return { field: condition.field as ConditionField, in: strings(condition.in) };
    }),
  };
}

/** Reads the params of a `PROJECT_WORKFLOW_TEMPLATE` rule (snake_case, as the governance store keeps them) into a template, refusing what the schema cannot say. 422 PROJECT_WORKFLOW_TEMPLATE_INVALID naming the first field. */
export function parseProjectWorkflowTemplate(params: unknown): ProjectWorkflowTemplate {
  const defect = templateDefect(params);
  if (defect !== undefined) throw invalid(defect);
  const source = params as Record<string, unknown>;
  return {
    name: text(source.name),
    projectType: typeof source.project_type === 'string' ? source.project_type : null,
    phases: arrayOf(source.phases).map((entry, index) => {
      const phase = entry as Record<string, unknown>;
      return { code: text(phase.code), name: text(phase.name), order: index + 1, gates: strings(phase.gates) as GateTarget[] };
    }),
    tasks: arrayOf(source.tasks).map((entry) => taskOf(entry as Record<string, unknown>)),
  };
}

/** The params of a template, in the shape the rule keeps them (the inverse of `parseProjectWorkflowTemplate`). */
export function templateParamsOf(template: ProjectWorkflowTemplate): RuleParams {
  return {
    name: template.name,
    ...(template.projectType === null ? {} : { project_type: template.projectType }),
    phases: template.phases.map((phase) => ({ code: phase.code, name: phase.name, gates: [...phase.gates] })),
    tasks: template.tasks.map((one) => ({
      code: one.code,
      name: one.name,
      phase: one.phase,
      kind: one.kind,
      duration_working_days: one.durationWorkingDays,
      required: one.required,
      responsible_role: one.responsibleRole,
      ...(one.approverRole === null ? {} : { approver_role: one.approverRole }),
      priority: one.priority,
      predecessors: one.predecessors.map((link) => ({ task: link.task, kind: link.kind, lag_working_days: link.lagWorkingDays })),
      ...(one.constraint === null ? {} : { constraint: { kind: one.constraint.kind, offset_working_days: one.constraint.offsetWorkingDays } }),
      legal_doc_types: [...one.legalDocTypes],
      form_templates: [...one.formTemplates],
      checklist: one.checklist.map((item) => ({ code: item.code, name: item.name, required: item.required, evidence_kinds: [...item.evidenceKinds] })),
      kpi_codes: [...one.kpiCodes],
      when: one.when.map((condition) => ({ field: condition.field, in: [...condition.in] })),
    })),
  };
}

/** The hash a project stores when it freezes a template: the same template gives the same hash whatever the order of the keys. */
export const templateHash = (template: ProjectWorkflowTemplate): string => sha256Hex(canonicalJson(templateParamsOf(template)));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Branches by the facts of the project.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The tasks a project with these facts has, and the codes left out. A fact that is not known never makes a condition hold. A task that is left out is not dropped from the schedule's logic: the scheduler treats it as a node of zero length, so
 * the order of the tasks around it is kept (project-schedule.ts).
 */
export function activeTasks(template: ProjectWorkflowTemplate, facts: ProjectFacts): { active: TemplateTask[]; excluded: string[] } {
  const active: TemplateTask[] = [];
  const excluded: string[] = [];
  for (const one of template.tasks) {
    const holds = one.when.every((condition) => {
      const value = facts[condition.field];
      return value !== undefined && condition.in.includes(value);
    });
    if (holds) active.push(one);
    else excluded.push(one.code);
  }
  return { active, excluded };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The types of legal documents, by edition (R42): the shared code names a type, the edition says what it is.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface LegalDocTypeInfo {
  code: string;
  label: string;
  /** The class of project document (`doc-repository.ts`) a document of this type is filed in. */
  documentClass: string;
}

export interface LegalDocTypeResolver {
  edition: string;
  resolve(code: string): LegalDocTypeInfo | undefined;
  list(): LegalDocTypeInfo[];
}

const RESOLVERS: LegalDocTypeResolver[] = [];

/** An edition registers how it names the legal document types of a task (the enterprise edition maps its catalogue `ENT_LEGAL_DOC_TYPE`); an edition registers once. */
export function registerLegalDocTypeResolver(resolver: LegalDocTypeResolver): void {
  if (RESOLVERS.some((one) => one.edition === resolver.edition)) throw new Error(`legal document type resolver of ${resolver.edition} is already registered`);
  RESOLVERS.push(resolver);
}

export const legalDocTypeResolvers = (): readonly LegalDocTypeResolver[] => [...RESOLVERS];

/** The type as the first edition that knows it names it, or undefined when none does. */
export function resolveLegalDocType(code: string): LegalDocTypeInfo | undefined {
  for (const resolver of RESOLVERS) {
    const found = resolver.resolve(code);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The public edition: the catalogue of the legal documents of a public investment project (the law's own order), and every class of project document as a type of its own (a class names itself).
const PUBLIC_TYPES: readonly LegalDocTypeInfo[] = [
  ...PUBLIC_LEGAL_DOC_TYPES,
  ...DOCUMENT_CLASSES.filter((code) => !PUBLIC_LEGAL_DOC_TYPES.some((one) => one.code === code)).map((code) => ({ code, label: code, documentClass: code })),
];
registerLegalDocTypeResolver({
  edition: 'public',
  resolve: (code) => PUBLIC_TYPES.find((one) => one.code === code),
  list: () => [...PUBLIC_TYPES],
});

/** What a template refers to that only the tenant can answer for: the caller passes the questions it can answer, the others are not checked. Legal document types and evidence kinds are always checked. */
export interface TemplateReferences {
  formTemplate?: (code: string) => boolean;
  kpiCode?: (code: string) => boolean;
  role?: (code: string) => boolean;
}

/** Every reference of a template to something that does not exist (R37, R42), with the path of the field. An empty list means every reference holds. */
export function checkTemplateReferences(template: ProjectWorkflowTemplate, references: TemplateReferences): RuleFinding[] {
  const found: RuleFinding[] = [];
  const add = (field: string, code: string): number => found.push(findingOf('pwf.template.error', field, code));
  template.tasks.forEach((one, index) => {
    const at = `tasks[${index}]`;
    one.checklist.forEach((item, position) => item.evidenceKinds.forEach((kind, kindIndex) => isEvidenceKind(kind) || add(`${at}.checklist[${position}].evidence_kinds[${kindIndex}]`, 'EVIDENCE_KIND_UNKNOWN')));
    one.legalDocTypes.forEach((code, position) => resolveLegalDocType(code) === undefined && add(`${at}.legal_doc_types[${position}]`, 'LEGAL_DOC_TYPE_UNKNOWN'));
    if (references.formTemplate !== undefined) one.formTemplates.forEach((code, position) => references.formTemplate?.(code) === true || add(`${at}.form_templates[${position}]`, 'FORM_TEMPLATE_UNKNOWN'));
    if (references.kpiCode !== undefined) one.kpiCodes.forEach((code, position) => references.kpiCode?.(code) === true || add(`${at}.kpi_codes[${position}]`, 'KPI_CODE_UNKNOWN'));
    if (references.role !== undefined) {
      if (references.role(one.responsibleRole) !== true) add(`${at}.responsible_role`, 'ROLE_UNKNOWN');
      if (one.approverRole !== null && references.role(one.approverRole) !== true) add(`${at}.approver_role`, 'ROLE_UNKNOWN');
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// May this task be completed?
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const COMPLETION_BLOCKER_CODES = ['CHECKLIST_ITEM_OPEN', 'EVIDENCE_MISSING', 'LEGAL_DOC_MISSING', 'FORM_MISSING', 'APPROVER_REQUIRED', 'MAKER_IS_APPROVER'] as const;
export type CompletionBlockerCode = (typeof COMPLETION_BLOCKER_CODES)[number];
const COVERABLE: readonly CompletionBlockerCode[] = ['CHECKLIST_ITEM_OPEN', 'EVIDENCE_MISSING', 'LEGAL_DOC_MISSING', 'FORM_MISSING'];

export interface CompletionBlocker {
  code: CompletionBlockerCode;
  /** The checklist item, the document type, the form, the role or the person the blocker is about. */
  subject: string;
}

export interface CompletionState {
  /** Who completes the task. */
  performer: string;
  /** Who approves the completion, when the task asks for one. */
  approver: string | null;
  /** Everyone who did work on the task or completed an item of it (the performer counts). */
  makers: readonly string[];
  checklist: ReadonlyArray<{ code: string; done: boolean; evidenceKinds: readonly string[] }>;
  legalDocTypes: readonly string[];
  formTemplates: readonly string[];
  /** An approved exception covers the open items, the missing evidence, documents and forms (never the rule that the maker is not the approver). */
  exceptionApproved: boolean;
}

export interface CompletionAssessment {
  ok: boolean;
  blockers: CompletionBlocker[];
  /** The blockers an approved exception covers (listed whether or not the exception is approved, so the screen can offer it). */
  coverable: CompletionBlocker[];
}

/** Whether the task may be completed, and what stops it: the required items of the checklist with their evidence, the legal documents and forms the template asks for, and an approver who is none of the makers. */
export function assessTaskCompletion(definition: TemplateTask, state: CompletionState): CompletionAssessment {
  const found: CompletionBlocker[] = [];
  for (const item of definition.checklist) {
    if (!item.required) continue;
    const done = state.checklist.find((entry) => entry.code === item.code);
    if (done === undefined || !done.done) found.push({ code: 'CHECKLIST_ITEM_OPEN', subject: item.code });
    else if (item.evidenceKinds.length > 0 && !item.evidenceKinds.some((kind) => done.evidenceKinds.includes(kind))) found.push({ code: 'EVIDENCE_MISSING', subject: item.code });
  }
  for (const type of definition.legalDocTypes) if (!state.legalDocTypes.includes(type)) found.push({ code: 'LEGAL_DOC_MISSING', subject: type });
  for (const form of definition.formTemplates) if (!state.formTemplates.includes(form)) found.push({ code: 'FORM_MISSING', subject: form });
  const coverable = found.filter((one) => COVERABLE.includes(one.code));
  const blockers = state.exceptionApproved ? [] : found;
  if (definition.approverRole !== null) {
    if (state.approver === null) blockers.push({ code: 'APPROVER_REQUIRED', subject: definition.approverRole });
    else if (state.approver === state.performer || state.makers.includes(state.approver)) blockers.push({ code: 'MAKER_IS_APPROVER', subject: state.approver });
  }
  return { ok: blockers.length === 0, blockers, coverable };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The gate: may this legal command of the project run?
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TaskGateState {
  code: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  /** The approver of the completion has approved (true when the task asks for no approval). */
  completionApproved: boolean;
  /** An approved exception waives the task for this gate. */
  waived: boolean;
  /** The cancellation of the task was approved by someone other than the one who asked. */
  cancelApproved: boolean;
}

export type GateMissingReason = 'NO_STATE' | 'NOT_DONE' | 'COMPLETION_NOT_APPROVED' | 'CANCELLED_WITHOUT_APPROVAL';

export interface GateMissing {
  task: string;
  phase: string;
  reason: GateMissingReason;
}

export interface GateAssessment {
  /** Whether any phase of the template lists the command: a command no phase lists is not gated. */
  gated: boolean;
  open: boolean;
  missing: GateMissing[];
}

/**
 * Whether the legal command (or the event of the system) `target` may run: every required task, of a branch the project has, in a phase that lists the target, must be done and approved, waived by an approved exception, or cancelled with approval.
 * The caller runs this in the same transaction as the command, whoever sends it (a member or the system).
 */
export function gateFor(template: ProjectWorkflowTemplate, target: string, facts: ProjectFacts, states: readonly TaskGateState[]): GateAssessment {
  const gatedPhases = new Set(template.phases.filter((phase) => (phase.gates as readonly string[]).includes(target)).map((phase) => phase.code));
  if (gatedPhases.size === 0) return { gated: false, open: true, missing: [] };
  const byCode = new Map(states.map((one) => [one.code, one] as const));
  const missing: GateMissing[] = [];
  for (const one of activeTasks(template, facts).active) {
    if (!gatedPhases.has(one.phase) || !one.required) continue;
    const state = byCode.get(one.code);
    const miss = (reason: GateMissingReason): number => missing.push({ task: one.code, phase: one.phase, reason });
    if (state === undefined) miss('NO_STATE');
    else if (state.waived) continue;
    else if (state.status === 'CANCELLED') {
      if (!state.cancelApproved) miss('CANCELLED_WITHOUT_APPROVAL');
    } else if (state.status !== 'DONE') miss('NOT_DONE');
    else if (one.approverRole !== null && !state.completionApproved) miss('COMPLETION_NOT_APPROVED');
  }
  return { gated: true, open: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rule type.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const AS_OF = '2026-11-12';

/** Registers `PROJECT_WORKFLOW_TEMPLATE` with the three starting templates of public investment (construction, purchase of assets, major repair). The kernel calls this through `registerProjectWorkflowModuleRules` of governance-rules.ts. */
export function registerProjectWorkflowRules(registry: RuleRegistry): void {
  registry.registerRuleType({
    type: PROJECT_WORKFLOW_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'PRJ', 'ADM'],
    formula: T.template_formula,
    source: T.template_source,
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: PROJECT_WORKFLOW_SCHEMA,
    refine: templateDefect,
    defaults: {
      PUBLIC_INVESTMENT: { params: PUBLIC_INVESTMENT_TEMPLATE, formula: T.investment_formula, source: T.default_source },
      PUBLIC_PROCUREMENT: { params: PUBLIC_PROCUREMENT_TEMPLATE, formula: T.procurement_formula, source: T.default_source },
      PUBLIC_REPAIR: { params: PUBLIC_REPAIR_TEMPLATE, formula: T.repair_formula, source: T.default_source },
    },
  });
}
