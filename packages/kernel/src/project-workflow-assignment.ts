import type { FieldSpec, RuleParams, RuleRegistry } from './governance-rules.ts';
import { PWF_PROCESS_TEXT as T } from './messages/pwf-process-texts.ts';
import { CONDITION_FIELDS } from './project-workflow.ts';
import type { ConditionField, ProjectFacts } from './project-workflow.ts';

/**
 * Which kind of workflow a project takes when it is registered (PWF-4, R47). The rule type `PROJECT_WORKFLOW_ASSIGNMENT` is a table of lines read in the order of their priority: the first line whose every condition holds for the
 * facts of the project (its type, its group, its source of capital) names the code of the workflow template. When no line holds, the template whose own `project_type` is the type of the project is taken (when exactly one has it), then
 * the default of the rule. The rule is versioned and approved like every governance rule (the one who approves is never the one who wrote it); a unit may have a rule of its own, and the rule of the nearest unit wins over the rule of the
 * tenant (the unit chain of the governance port), which is how "by unit" is said without a condition that names units inside the params.
 *
 * The answer is a SUGGESTION: the person who registers the project confirms it or picks another template and says why; what was suggested, by which version of the rule, and what was chosen is written with the workflow.
 */

export const WORKFLOW_ASSIGNMENT_RULE_TYPE = 'PROJECT_WORKFLOW_ASSIGNMENT';
/** The one code of the rule a tenant (or a unit) keeps. */
export const WORKFLOW_ASSIGNMENT_CODE = 'DEFAULT';

export const MAX_ASSIGNMENT_LINES = 60;

export interface AssignmentCondition {
  field: ConditionField;
  in: readonly string[];
}

export interface AssignmentLine {
  code: string;
  /** Lower is read first; no two lines share one. */
  priority: number;
  templateCode: string;
  when: readonly AssignmentCondition[];
  note: string | null;
}

export interface WorkflowAssignment {
  lines: readonly AssignmentLine[];
  defaultTemplateCode: string | null;
}

const code: FieldSpec = { kind: 'text', max: 40, pattern: '^[A-Z][A-Z0-9_]{1,39}$' };
const templateCode: FieldSpec = code;

export const WORKFLOW_ASSIGNMENT_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  lines: {
    kind: 'list',
    max: MAX_ASSIGNMENT_LINES,
    of: {
      kind: 'object',
      fields: {
        code,
        priority: { kind: 'int', min: 1, max: 9999 },
        template_code: templateCode,
        when: {
          kind: 'list',
          min: 1,
          max: CONDITION_FIELDS.length,
          of: { kind: 'object', fields: { field: { kind: 'enum', values: CONDITION_FIELDS }, in: { kind: 'list', min: 1, max: 40, of: { kind: 'text', max: 40, pattern: '^[A-Za-z0-9_.-]{1,40}$' } } } },
        },
        note: { kind: 'text', max: 300, optional: true },
      },
    },
  },
  default_template_code: { ...templateCode, optional: true },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** What the closed schema cannot say: a line code and a priority are used once (the order must not depend on how the list is written), and a line names a field and a value once. */
export function assignmentDefect(params: Record<string, unknown>): string | undefined {
  const codes = new Set<unknown>();
  const priorities = new Set<unknown>();
  for (const [index, raw] of arrayOf(params.lines).entries()) {
    const line = isRecord(raw) ? raw : {};
    if (codes.has(line.code)) return `lines[${index}].code`;
    codes.add(line.code);
    if (priorities.has(line.priority)) return `lines[${index}].priority`;
    priorities.add(line.priority);
    const fields = new Set<unknown>();
    for (const [position, entry] of arrayOf(line.when).entries()) {
      const condition = isRecord(entry) ? entry : {};
      if (fields.has(condition.field)) return `lines[${index}].when[${position}].field`;
      fields.add(condition.field);
      const values = arrayOf(condition.in);
      if (new Set(values).size !== values.length) return `lines[${index}].when[${position}].in`;
    }
  }
  return undefined;
}

/** Reads the params of a `PROJECT_WORKFLOW_ASSIGNMENT` rule (already judged by the schema), the lines in the order they are read. */
export function parseWorkflowAssignment(params: RuleParams): WorkflowAssignment {
  const lines = arrayOf(params.lines).map((raw): AssignmentLine => {
    const line = raw as Record<string, unknown>;
    return {
      code: String(line.code),
      priority: line.priority as number,
      templateCode: String(line.template_code),
      when: arrayOf(line.when).map((entry) => {
        const condition = entry as Record<string, unknown>;
        return { field: condition.field as ConditionField, in: arrayOf(condition.in).map(String) };
      }),
      note: typeof line.note === 'string' ? line.note : null,
    };
  });
  return { lines: [...lines].sort((left, right) => left.priority - right.priority), defaultTemplateCode: typeof params.default_template_code === 'string' ? params.default_template_code : null };
}

/** A template as much as the suggestion needs. */
export interface AssignableTemplate {
  code: string;
  /** The `project_type` the template says it is for. */
  projectType: string | null;
}

export const SUGGESTION_BASES = ['RULE', 'PROJECT_TYPE', 'DEFAULT', 'NONE'] as const;
export type SuggestionBasis = (typeof SUGGESTION_BASES)[number];

export interface SuggestionCandidate {
  templateCode: string;
  basis: Exclude<SuggestionBasis, 'NONE'>;
  /** The line that named it, when a line did. */
  line: string | null;
}

export interface WorkflowSuggestion {
  templateCode: string | null;
  basis: SuggestionBasis;
  line: string | null;
  /** Everything that would have been suggested, best first (the first one is the suggestion): the screen shows why a template is offered. */
  candidates: SuggestionCandidate[];
  /** The lines that name a template the tenant does not have: they are skipped, and told so that the rule gets fixed. */
  unknownTemplates: string[];
}

const holds = (when: readonly AssignmentCondition[], facts: ProjectFacts): boolean =>
  when.every((condition) => {
    const value = facts[condition.field];
    // A fact that is not known never makes a condition hold (as for the branches of a template).
    return value !== undefined && condition.in.includes(value);
  });

/**
 * The kind of workflow the rule suggests for a project with these facts, among the templates the tenant has. Never a guess: when no line holds, no single template is of the project's type and the rule has no default (or names a
 * template that does not exist), the answer is `NONE` and the person chooses.
 */
export function suggestWorkflowTemplate(assignment: WorkflowAssignment, facts: ProjectFacts, templates: readonly AssignableTemplate[]): WorkflowSuggestion {
  const known = new Set(templates.map((one) => one.code));
  const candidates: SuggestionCandidate[] = [];
  const unknown: string[] = [];
  const add = (templateCode: string, basis: SuggestionCandidate['basis'], line: string | null): void => {
    if (!known.has(templateCode)) {
      if (!unknown.includes(templateCode)) unknown.push(templateCode);
      return;
    }
    if (!candidates.some((one) => one.templateCode === templateCode)) candidates.push({ templateCode, basis, line });
  };
  for (const line of assignment.lines) if (holds(line.when, facts)) add(line.templateCode, 'RULE', line.code);
  const type = facts.project_type;
  const ofType = type === undefined ? [] : templates.filter((one) => one.projectType === type);
  if (ofType.length === 1 && ofType[0] !== undefined) add(ofType[0].code, 'PROJECT_TYPE', null);
  if (assignment.defaultTemplateCode !== null) add(assignment.defaultTemplateCode, 'DEFAULT', null);
  const first = candidates[0];
  return first === undefined ? { templateCode: null, basis: 'NONE', line: null, candidates, unknownTemplates: unknown } : { templateCode: first.templateCode, basis: first.basis, line: first.line, candidates, unknownTemplates: unknown };
}

export const SELECTION_MODES = ['AUTO', 'CONFIRMED', 'OVERRIDE', 'MANUAL'] as const;
/** How the template of a workflow was chosen: the rule alone (`AUTO`), the person agreeing with the rule (`CONFIRMED`), the person choosing another one (`OVERRIDE`, with a reason), or the person choosing where the rule had nothing to say (`MANUAL`). */
export type SelectionMode = (typeof SELECTION_MODES)[number];

/** The mode of a choice: `chosen` is what the person sent (undefined: they left it to the rule). */
export function selectionModeOf(suggested: string | null, chosen: string | undefined): SelectionMode {
  if (chosen === undefined) return 'AUTO';
  if (suggested === null) return 'MANUAL';
  return chosen === suggested ? 'CONFIRMED' : 'OVERRIDE';
}

/** The shortest reason that is one: choosing against the rule is said in a sentence. */
export const MIN_OVERRIDE_REASON = 10;
export const MAX_OVERRIDE_REASON = 500;

const AS_OF = '2026-11-14';

const line = (lineCode: string, priority: number, template: string, types: readonly string[]): RuleParams => ({ code: lineCode, priority, template_code: template, when: [{ field: 'project_type', in: [...types] }] });

/** The built-in rule of the public edition: the two special kinds by the type of the project, everything else is a construction investment project. A starting value the agency confirms (`UNVERIFIED`). */
export const PUBLIC_WORKFLOW_ASSIGNMENT: RuleParams = {
  lines: [line('PROCUREMENT', 10, 'PUBLIC_PROCUREMENT', ['PUBLIC_PROCUREMENT', 'PROCUREMENT', 'EQUIPMENT']), line('REPAIR', 20, 'PUBLIC_REPAIR', ['PUBLIC_REPAIR', 'REPAIR', 'RENOVATION'])],
  default_template_code: 'PUBLIC_INVESTMENT',
};

/** Registers `PROJECT_WORKFLOW_ASSIGNMENT` with the built-in rule `DEFAULT`. Called by the registry of governance-rules.ts. */
export function registerWorkflowAssignmentRules(registry: RuleRegistry): void {
  registry.registerRuleType({
    type: WORKFLOW_ASSIGNMENT_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'PRJ', 'ADM'],
    formula: T.assignment_formula,
    source: T.assignment_source,
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: WORKFLOW_ASSIGNMENT_SCHEMA,
    refine: assignmentDefect,
    codePattern: `^${WORKFLOW_ASSIGNMENT_CODE}$`,
    defaults: { [WORKFLOW_ASSIGNMENT_CODE]: { params: PUBLIC_WORKFLOW_ASSIGNMENT } },
  });
}
