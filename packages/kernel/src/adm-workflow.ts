import { DomainError } from './errors.ts';

/**
 * The approval workflow of ADM (ST-ADM-012, ADM 3.7, BR-ADM-05): the language a tenant writes a workflow in, what makes a definition valid, and the pure rules by which a decision moves an instance. A definition is data;
 * the engine (`ApprovalStore`) only follows it, and the database stays the authority of the state.
 */

/** What a business module registers so that a workflow can end in its domain: the document type the DoA limits it under, and the command each outcome calls. */
export interface BusinessTypeSpec {
  code: string;
  documentType: string;
  commands: { APPROVED: string; RETURNED: string; REJECTED: string };
  /** The module that owns the record and binds the real final commands. */
  ownerModule: string;
  /** Enabled in every deployment that mounts the owning module: the platform then refuses to boot without the real final commands (R14). Types still false are enabled by configuration (`MACHVON_APPROVAL_BUSINESS_TYPES`) once their module binds them. */
  enabledByDefault: boolean;
}

/** The business types the platform knows (ADM 3.7); a test build binds the ones without a real final command to doubles, any other build has none (R14). */
export const BUSINESS_TYPES: readonly BusinessTypeSpec[] = [
  { code: 'report.accept', documentType: 'REPORT_ACCEPT', commands: { APPROVED: 'acceptReport', RETURNED: 'returnReport', REJECTED: 'rejectReport' }, ownerModule: 'DIS', enabledByDefault: true },
  { code: 'plan.publish', documentType: 'CAPITAL_PLAN_PUBLISH', commands: { APPROVED: 'publishPlan', RETURNED: 'returnPlan', REJECTED: 'rejectPlan' }, ownerModule: 'CAP', enabledByDefault: false },
  { code: 'payment.approve', documentType: 'PAYMENT_APPROVE', commands: { APPROVED: 'approvePaymentRequest', RETURNED: 'returnPaymentRequest', REJECTED: 'rejectPaymentRequest' }, ownerModule: 'PAY', enabledByDefault: false },
  { code: 'contract.change', documentType: 'CONTRACT_CHANGE', commands: { APPROVED: 'approveContractChange', RETURNED: 'returnContractChange', REJECTED: 'rejectContractChange' }, ownerModule: 'CTR', enabledByDefault: false },
  { code: 'period.reopen', documentType: 'PERIOD_REOPEN', commands: { APPROVED: 'reopenPeriod', RETURNED: 'returnPeriodReopen', REJECTED: 'rejectPeriodReopen' }, ownerModule: 'DIS', enabledByDefault: false },
  { code: 'document.review', documentType: 'DOCUMENT_REVIEW', commands: { APPROVED: 'approveDocumentReview', RETURNED: 'requestDocumentSupplement', REJECTED: 'rejectDocumentReview' }, ownerModule: 'DOC', enabledByDefault: false },
  { code: 'fnd.figures.accept', documentType: 'FND_FIGURE_ACCEPT', commands: { APPROVED: 'acceptFundingFigures', RETURNED: 'returnFundingFigures', REJECTED: 'rejectFundingFigures' }, ownerModule: 'FND', enabledByDefault: false },
  { code: 'ind.entry.accept', documentType: 'IND_ENTRY_ACCEPT', commands: { APPROVED: 'acceptIndicatorEntry', RETURNED: 'returnIndicatorEntry', REJECTED: 'rejectIndicatorEntry' }, ownerModule: 'IND', enabledByDefault: false },
  // PWF-3 (R43): the response of a person to their score, handled by the approvers of the tenant when it published a workflow for the type; without one a person with `staff_score.approve` handles it directly.
  { code: 'score.response', documentType: 'STAFF_SCORE_RESPONSE', commands: { APPROVED: 'upholdStaffScoreResponse', RETURNED: 'returnStaffScoreResponse', REJECTED: 'keepStaffScore' }, ownerModule: 'PWF', enabledByDefault: false },
];

export const businessTypeOf = (code: string): BusinessTypeSpec | undefined => BUSINESS_TYPES.find((type) => type.code === code);

/** The environment variable that enables business types besides the ones enabled by default: a comma separated list of codes (`plan.publish,payment.approve`). */
export const APPROVAL_BUSINESS_TYPES_VARIABLE = 'MACHVON_APPROVAL_BUSINESS_TYPES';

/**
 * The business types a process runs workflows for: the ones enabled by default and the ones the configuration names, restricted to the types whose owning module is mounted in this process (`mounted` is the list of
 * module codes; absent means the host does not say, as in a test of the engine alone). A code the configuration names that is not a business type is a mistake of the deployment and stops it.
 */
export function enabledBusinessTypes(variables: Readonly<Record<string, string | undefined>>, mounted?: readonly string[]): string[] {
  const named = (variables[APPROVAL_BUSINESS_TYPES_VARIABLE] ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');
  for (const code of named) if (businessTypeOf(code) === undefined) throw new Error(`${APPROVAL_BUSINESS_TYPES_VARIABLE} names ${code}, which is not a business type`);
  return BUSINESS_TYPES.filter((type) => (type.enabledByDefault || named.includes(type.code)) && (mounted === undefined || mounted.includes(type.ownerModule))).map((type) => type.code);
}

/** Whether the build may bind test doubles to the final commands: a test build only (jest sets `NODE_ENV=test`), never a process that serves real data. */
export const testDoublesAllowed = (variables: Readonly<Record<string, string | undefined>>): boolean => variables.NODE_ENV === 'test';

export const ASSIGNEE_RULE_TYPES = ['DOA', 'ROLE_IN_UNIT', 'SPECIFIC'] as const;
export type AssigneeRuleType = (typeof ASSIGNEE_RULE_TYPES)[number];
export const TIMEOUT_ACTIONS = ['REMIND', 'ESCALATE', 'EXPIRE'] as const;
export type TimeoutAction = (typeof TIMEOUT_ACTIONS)[number];
export const OUTCOMES = ['APPROVED', 'RETURNED', 'REJECTED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const MAX_STEPS = 10;
export const MAX_MIN_APPROVALS = 5;
export const MAX_SLA_WORKING_HOURS = 720;
const STEP_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const STEP_TAG = /^[A-Z][A-Z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AssigneeRule {
  type: AssigneeRuleType;
  /** ROLE_IN_UNIT: the role (by code) the approvers hold, and the unit they hold it in. */
  role_code?: string;
  unit_id?: string;
  /** SPECIFIC: the memberships that approve. */
  membership_ids?: string[];
}

export interface WorkflowStep {
  id: string;
  name: string;
  assignee_rule: AssigneeRule;
  min_approvals: number;
  sla_working_hours: number;
  on_timeout: TimeoutAction;
  /** ESCALATE: the membership the task is also given to when the SLA is passed. */
  escalate_to?: string;
  /** The earlier step an approver may send the record back to. */
  allow_return_to?: string;
  /** A label the owning module gives the step so that its screens can say what the step is for (`PLANNING_REVIEW`); the engine does not read it. */
  tag?: string;
}

export interface WorkflowDefinition {
  steps: WorkflowStep[];
  /** The command each outcome calls in the owning module; it has to be one the business type registered. */
  terminal: { approved: string; returned: string; rejected: string };
}

/** One defect of a definition: where (a JSON path from the definition), what (a stable code the screen can word) and a message for logs. */
export interface DefinitionDefect {
  path: string;
  code: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, defects: DefinitionDefect[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) defects.push({ path: `${path}.${key}`, code: 'UNKNOWN_FIELD', message: `${key} is not a field of the definition` });
}

/**
 * Every defect of a definition (BR-ADM-05), each with its JSON path; an empty list means it is valid. The steps have unique ids, the assignee rule has what its type needs, the approvals, the SLA and the timeout are in range, a step
 * may only return to a step before it (so the graph has no cycle but the returns), and every end maps to a command the business type registered. A definition that is not an object has one defect, at the root.
 */
export function validateDefinition(definition: unknown, businessType: string): DefinitionDefect[] {
  const defects: DefinitionDefect[] = [];
  const add = (path: string, code: string, message: string): void => {
    defects.push({ path, code, message });
  };
  const spec = businessTypeOf(businessType);
  if (spec === undefined) add('$.business_type', 'BUSINESS_TYPE_UNKNOWN', `${businessType} is not a registered business type`);
  if (!isRecord(definition)) {
    add('$', 'NOT_AN_OBJECT', 'the definition is an object');
    return defects;
  }
  unknownKeys(definition, ['steps', 'terminal'], '$', defects);
  const steps = definition.steps;
  if (!Array.isArray(steps) || steps.length === 0) add('$.steps', 'STEPS_REQUIRED', 'at least one step');
  else if (steps.length > MAX_STEPS) add('$.steps', 'TOO_MANY_STEPS', `at most ${MAX_STEPS} steps`);
  const ids: string[] = [];
  if (Array.isArray(steps)) {
    steps.forEach((raw, index) => {
      const path = `$.steps[${index}]`;
      if (!isRecord(raw)) {
        add(path, 'NOT_AN_OBJECT', 'a step is an object');
        return;
      }
      unknownKeys(raw, ['id', 'name', 'assignee_rule', 'min_approvals', 'sla_working_hours', 'on_timeout', 'escalate_to', 'allow_return_to', 'tag'], path, defects);
      if (raw.tag !== undefined && (typeof raw.tag !== 'string' || !STEP_TAG.test(raw.tag))) add(`${path}.tag`, 'STEP_TAG_INVALID', 'a step tag is 2 to 40 characters: upper-case letters, digits or _, starting with a letter');
      const id = raw.id;
      if (typeof id !== 'string' || !STEP_ID.test(id)) add(`${path}.id`, 'STEP_ID_INVALID', 'a step id is 2 to 40 characters: a lower-case letter, then letters, digits, - or _');
      else if (ids.includes(id)) add(`${path}.id`, 'STEP_ID_DUPLICATE', `the step id ${id} is used twice`);
      ids.push(typeof id === 'string' ? id : '');
      if (typeof raw.name !== 'string' || raw.name.trim().length < 2 || raw.name.length > 120) add(`${path}.name`, 'STEP_NAME_INVALID', 'a step has a name of 2 to 120 characters');
      const rule = raw.assignee_rule;
      let specific = 0;
      if (!isRecord(rule)) add(`${path}.assignee_rule`, 'ASSIGNEE_RULE_REQUIRED', 'a step says who approves');
      else {
        unknownKeys(rule, ['type', 'role_code', 'unit_id', 'membership_ids'], `${path}.assignee_rule`, defects);
        const type = ASSIGNEE_RULE_TYPES.find((candidate) => candidate === rule.type);
        if (type === undefined) add(`${path}.assignee_rule.type`, 'ASSIGNEE_TYPE_INVALID', `the type is one of ${ASSIGNEE_RULE_TYPES.join(', ')}`);
        if (type === 'ROLE_IN_UNIT') {
          if (typeof rule.role_code !== 'string' || !/^[A-Z][A-Z0-9_]{1,59}$/.test(rule.role_code)) add(`${path}.assignee_rule.role_code`, 'ROLE_CODE_REQUIRED', 'a role code, as the roles are written');
          if (typeof rule.unit_id !== 'string' || !UUID.test(rule.unit_id)) add(`${path}.assignee_rule.unit_id`, 'UNIT_REQUIRED', 'the unit the role is held in');
        }
        if (type === 'SPECIFIC') {
          const members = rule.membership_ids;
          if (!Array.isArray(members) || members.length === 0 || members.some((member) => typeof member !== 'string' || !UUID.test(member))) add(`${path}.assignee_rule.membership_ids`, 'MEMBERS_REQUIRED', 'one or more members');
          else if (new Set(members).size !== members.length) add(`${path}.assignee_rule.membership_ids`, 'MEMBERS_DUPLICATE', 'a member is listed once');
          else specific = members.length;
        }
        if (type === 'DOA' && (rule.role_code !== undefined || rule.unit_id !== undefined || rule.membership_ids !== undefined)) add(`${path}.assignee_rule`, 'DOA_TAKES_NO_OPERANDS', 'a DoA step takes its approvers from the matrix');
        if (type === 'ROLE_IN_UNIT' && rule.membership_ids !== undefined) add(`${path}.assignee_rule.membership_ids`, 'UNEXPECTED_OPERAND', 'a role in a unit does not list members');
        if (type === 'SPECIFIC' && (rule.role_code !== undefined || rule.unit_id !== undefined)) add(`${path}.assignee_rule`, 'UNEXPECTED_OPERAND', 'a specific step does not name a role or a unit');
      }
      const min = raw.min_approvals;
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > MAX_MIN_APPROVALS) add(`${path}.min_approvals`, 'MIN_APPROVALS_INVALID', `min_approvals is a whole number from 1 to ${MAX_MIN_APPROVALS}`);
      else if (specific > 0 && min > specific) add(`${path}.min_approvals`, 'MIN_APPROVALS_EXCEEDS_APPROVERS', `${min} approvals asked of ${specific} named approvers`);
      const sla = raw.sla_working_hours;
      if (typeof sla !== 'number' || !Number.isFinite(sla) || sla <= 0 || sla > MAX_SLA_WORKING_HOURS) add(`${path}.sla_working_hours`, 'SLA_INVALID', `sla_working_hours is above 0 and at most ${MAX_SLA_WORKING_HOURS}`);
      const timeout = TIMEOUT_ACTIONS.find((candidate) => candidate === raw.on_timeout);
      if (timeout === undefined) add(`${path}.on_timeout`, 'ON_TIMEOUT_INVALID', `on_timeout is one of ${TIMEOUT_ACTIONS.join(', ')}`);
      if (timeout === 'ESCALATE' && (typeof raw.escalate_to !== 'string' || !UUID.test(raw.escalate_to))) add(`${path}.escalate_to`, 'ESCALATE_TO_REQUIRED', 'a step that escalates says to whom');
      if (timeout !== 'ESCALATE' && raw.escalate_to !== undefined) add(`${path}.escalate_to`, 'UNEXPECTED_OPERAND', 'only a step that escalates says to whom');
      if (raw.allow_return_to !== undefined) {
        const target = ids.slice(0, index).indexOf(String(raw.allow_return_to));
        if (typeof raw.allow_return_to !== 'string' || target < 0) add(`${path}.allow_return_to`, 'RETURN_TARGET_INVALID', 'a step returns only to a step before it');
      }
    });
  }
  const terminal = definition.terminal;
  if (!isRecord(terminal)) add('$.terminal', 'TERMINAL_REQUIRED', 'the definition maps its ends to the commands of the business type');
  else {
    unknownKeys(terminal, ['approved', 'returned', 'rejected'], '$.terminal', defects);
    for (const [key, outcome] of [['approved', 'APPROVED'], ['returned', 'RETURNED'], ['rejected', 'REJECTED']] as const) {
      const command = terminal[key];
      if (typeof command !== 'string') add(`$.terminal.${key}`, 'COMMAND_REQUIRED', `the command called when the outcome is ${outcome}`);
      else if (spec !== undefined && command !== spec.commands[outcome]) add(`$.terminal.${key}`, 'COMMAND_NOT_REGISTERED', `${command} is not the ${outcome} command registered for ${spec.code} (${spec.commands[outcome]})`);
    }
  }
  return defects;
}

/** 422 `WORKFLOW_DEFINITION_INVALID` with the defects (path and code) when there are any. */
export function assertValidDefinition(definition: unknown, businessType: string): WorkflowDefinition {
  const defects = validateDefinition(definition, businessType);
  if (defects.length > 0) throw new DomainError('WORKFLOW_DEFINITION_INVALID', 422, defects[0]?.path, { extensions: { defects: defects.map((defect) => ({ path: defect.path, code: defect.code, message: defect.message })) } });
  return definition as WorkflowDefinition;
}

/** How many distinct approvals a step needs: the DoA band can ask for more levels than the step says. */
export function requiredApprovals(step: WorkflowStep, doaLevels: number | undefined): number {
  return step.assignee_rule.type === 'DOA' && doaLevels !== undefined ? Math.max(step.min_approvals, doaLevels) : step.min_approvals;
}

export type Decision = 'approve' | 'return' | 'reject';

export type Advance =
  | { kind: 'STAY' }
  | { kind: 'NEXT_STEP'; stepIndex: number }
  | { kind: 'RETURN_TO_STEP'; stepIndex: number }
  | { kind: 'COMPLETE'; outcome: Outcome };

/**
 * What a decision does to the instance. An approval that does not reach the number the step needs leaves the step open; the one that does moves to the next step, or completes the instance as APPROVED after the last. A
 * return goes back to the step the current one allows (`returnTo`, which must be that step) or, with no target, ends the instance as RETURNED to the initiator. A rejection ends it as REJECTED.
 */
export function advance(definition: WorkflowDefinition, stepIndex: number, decision: Decision, approvalsSoFar: number, doaLevels: number | undefined, returnTo: string | undefined): Advance {
  const step = definition.steps[stepIndex];
  if (step === undefined) throw new DomainError('WORKFLOW_DEFINITION_INVALID', 422, '$.steps');
  if (decision === 'reject') return { kind: 'COMPLETE', outcome: 'REJECTED' };
  if (decision === 'return') {
    if (returnTo === undefined) return { kind: 'COMPLETE', outcome: 'RETURNED' };
    const target = definition.steps.findIndex((candidate) => candidate.id === returnTo);
    if (returnTo !== step.allow_return_to || target < 0 || target >= stepIndex) throw new DomainError('VALIDATION_FAILED', 422, 'return_to_step');
    return { kind: 'RETURN_TO_STEP', stepIndex: target };
  }
  if (approvalsSoFar < requiredApprovals(step, doaLevels)) return { kind: 'STAY' };
  return stepIndex + 1 < definition.steps.length ? { kind: 'NEXT_STEP', stepIndex: stepIndex + 1 } : { kind: 'COMPLETE', outcome: 'APPROVED' };
}

/** The key the final command of an instance is sent with, so that a retry of the activity never applies it twice (ADM 3.7 item 6). */
export const finalCommandKey = (instanceId: string, sequence: number): string => `wf:${instanceId}:final:${sequence}`;

/** The times of a pending task that the SLA judges (ADM 3.7 item 4): the point 80 percent of the working time to the deadline, the deadline, and when the last reminder was sent. */
export interface TaskClock {
  remindAt: Date | null;
  remindedAt: Date | null;
  dueAt: Date;
  /** When the next reminder of an overdue task is due; empty until the first one is sent. */
  nextReminderAt: Date | null;
  escalatedAt: Date | null;
}

export type SlaAction = 'NONE' | 'REMIND_BEFORE_DUE' | 'OVERDUE_REMIND' | 'ESCALATE' | 'EXPIRE';

/**
 * What the SLA asks of a pending task now: a reminder once at 80 percent; at the deadline what the step says (`on_timeout`): REMIND repeats the reminder when the next one is due (every working day), ESCALATE gives the task to
 * the escalation target once and then goes on reminding, EXPIRE ends the task. A task found after its deadline is dealt with as overdue and never gets the reminder of the time before it.
 */
export function slaAction(clock: TaskClock, onTimeout: TimeoutAction, now: Date): SlaAction {
  const at = now.getTime();
  if (at < clock.dueAt.getTime()) return clock.remindAt !== null && clock.remindedAt === null && at >= clock.remindAt.getTime() ? 'REMIND_BEFORE_DUE' : 'NONE';
  if (onTimeout === 'EXPIRE') return 'EXPIRE';
  if (onTimeout === 'ESCALATE' && clock.escalatedAt === null) return 'ESCALATE';
  return clock.nextReminderAt === null || at >= clock.nextReminderAt.getTime() ? 'OVERDUE_REMIND' : 'NONE';
}
