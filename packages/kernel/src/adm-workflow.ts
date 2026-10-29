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
}

/** The business types the platform knows (ADM 3.7); until the owning module registers its real commands they are bound to test doubles. */
export const BUSINESS_TYPES: readonly BusinessTypeSpec[] = [
  { code: 'report.accept', documentType: 'REPORT_ACCEPT', commands: { APPROVED: 'acceptReport', RETURNED: 'returnReport', REJECTED: 'rejectReport' } },
  { code: 'plan.publish', documentType: 'CAPITAL_PLAN_PUBLISH', commands: { APPROVED: 'publishPlan', RETURNED: 'returnPlan', REJECTED: 'rejectPlan' } },
  { code: 'payment.approve', documentType: 'PAYMENT_APPROVE', commands: { APPROVED: 'approvePaymentRequest', RETURNED: 'returnPaymentRequest', REJECTED: 'rejectPaymentRequest' } },
  { code: 'contract.change', documentType: 'CONTRACT_CHANGE', commands: { APPROVED: 'approveContractChange', RETURNED: 'returnContractChange', REJECTED: 'rejectContractChange' } },
  { code: 'period.reopen', documentType: 'PERIOD_REOPEN', commands: { APPROVED: 'reopenPeriod', RETURNED: 'returnPeriodReopen', REJECTED: 'rejectPeriodReopen' } },
];

export const businessTypeOf = (code: string): BusinessTypeSpec | undefined => BUSINESS_TYPES.find((type) => type.code === code);

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
      unknownKeys(raw, ['id', 'name', 'assignee_rule', 'min_approvals', 'sla_working_hours', 'on_timeout', 'escalate_to', 'allow_return_to'], path, defects);
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
