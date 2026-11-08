import { BUSINESS_TYPES, validateDefinition } from './adm-workflow.ts';
import type { AssigneeRule, TimeoutAction, WorkflowDefinition, WorkflowStep } from './adm-workflow.ts';
import { message } from './messages.ts';

/**
 * The approval of a weekly disbursement report on the ADM workflow engine (WF-1, ST-DIS-006). The steps a tenant runs are data in the governance rules registry (rule type `APPROVAL_WORKFLOW_DEFINITION`, code
 * `REPORT_ACCEPT`, versioned and approved by someone other than who proposed it): the built-in default is the single decision of the unit reviewer as it has always been, and a tenant that approves the staged
 * mode runs the chain unit approver, planning review, period close, push, each with a deadline on the working calendar and reminders from the engine.
 */

export const APPROVAL_WORKFLOW_RULE_TYPE = 'APPROVAL_WORKFLOW_DEFINITION';
/** The rule code is the document type the matrix of authority limits the business type under. */
export const REPORT_WORKFLOW_RULE_CODE = 'REPORT_ACCEPT';
export const REPORT_ACCEPT_BUSINESS_TYPE = 'report.accept';
/** What the engine calls the record: the revision of a report (the resource of its instance). */
export const REPORT_WORKFLOW_RESOURCE = 'report_revision';

export const WORKFLOW_MODES = ['SINGLE_DECISION', 'STAGED'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

/** The steps of the chain, in the order they run; a definition keeps this order and uses each kind once. */
export const REPORT_STEP_KINDS = ['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'] as const;
export type ReportStepKind = (typeof REPORT_STEP_KINDS)[number];

export const REPORT_STEP_ASSIGNEE_TYPES = ['DOA', 'ROLE_IN_UNIT', 'SPECIFIC'] as const;

/** One step as the rule writes it: the kind says what it is for, the rest is what the engine needs to run it. */
export interface ReportWorkflowStep {
  id: string;
  kind: ReportStepKind;
  name: string;
  assigneeType: (typeof REPORT_STEP_ASSIGNEE_TYPES)[number];
  roleCode?: string;
  unitId?: string;
  membershipIds?: string[];
  minApprovals: number;
  slaWorkingHours: number;
  onTimeout: TimeoutAction;
  escalateTo?: string;
}

export interface ReportWorkflow {
  mode: WorkflowMode;
  steps: ReportWorkflowStep[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The built-in default: the single decision of the unit reviewer, which the engine does not run (the tenant that never approved a rule keeps the review as it was). The step is shown on the screens as the one step there is. */
export function defaultReportWorkflowParams(): Record<string, unknown> {
  return {
    mode: 'SINGLE_DECISION',
    steps: [{ id: 'unit-approver', kind: 'UNIT_APPROVER', name: message('dis.workflow.step.unit_approver'), assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND' }],
  };
}

/** Reads params that passed the schema of the rule type into the steps; params that are not of the shape fail the registry first, so this is for what already passed. */
export function reportWorkflowOf(params: unknown): ReportWorkflow {
  const record = isRecord(params) ? params : {};
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return {
    mode: record.mode === 'STAGED' ? 'STAGED' : 'SINGLE_DECISION',
    steps: steps.filter(isRecord).map((raw) => ({
      id: String(raw.id),
      kind: raw.kind as ReportStepKind,
      name: String(raw.name),
      assigneeType: raw.assignee_type as ReportWorkflowStep['assigneeType'],
      ...(typeof raw.role_code === 'string' ? { roleCode: raw.role_code } : {}),
      ...(typeof raw.unit_id === 'string' ? { unitId: raw.unit_id } : {}),
      ...(Array.isArray(raw.membership_ids) ? { membershipIds: raw.membership_ids.map(String) } : {}),
      minApprovals: Number(raw.min_approvals),
      slaWorkingHours: Number(raw.sla_working_hours),
      onTimeout: raw.on_timeout as TimeoutAction,
      ...(typeof raw.escalate_to === 'string' ? { escalateTo: raw.escalate_to } : {}),
    })),
  };
}

function assigneeRuleOf(step: ReportWorkflowStep): AssigneeRule {
  if (step.assigneeType === 'ROLE_IN_UNIT') return { type: 'ROLE_IN_UNIT', ...(step.roleCode === undefined ? {} : { role_code: step.roleCode }), ...(step.unitId === undefined ? {} : { unit_id: step.unitId }) };
  if (step.assigneeType === 'SPECIFIC') return { type: 'SPECIFIC', ...(step.membershipIds === undefined ? {} : { membership_ids: step.membershipIds }) };
  return { type: 'DOA' };
}

/** The definition the ADM engine runs for these steps: the same fields, and the ends of the business type `report.accept`. */
export function engineDefinitionOf(workflow: ReportWorkflow): WorkflowDefinition {
  const spec = BUSINESS_TYPES.find((type) => type.code === REPORT_ACCEPT_BUSINESS_TYPE);
  if (spec === undefined) throw new Error('the business type report.accept is not registered');
  return {
    steps: workflow.steps.map(
      (step): WorkflowStep => ({
        id: step.id,
        name: step.name,
        assignee_rule: assigneeRuleOf(step),
        min_approvals: step.minApprovals,
        sla_working_hours: step.slaWorkingHours,
        on_timeout: step.onTimeout,
        ...(step.escalateTo === undefined ? {} : { escalate_to: step.escalateTo }),
        tag: step.kind,
      }),
    ),
    terminal: { approved: spec.commands.APPROVED, returned: spec.commands.RETURNED, rejected: spec.commands.REJECTED },
  };
}

/** A path of the engine definition as the rule names the field (`steps[1].assignee_rule.unit_id` is `steps[1].unit_id`). */
const ruleFieldOf = (path: string): string =>
  path
    .replace(/^\$\.?/, '')
    .replace('assignee_rule.type', 'assignee_type')
    .replace('assignee_rule.', '')
    .replace(/\.assignee_rule$/, '.assignee_type');

/**
 * The field of the params that makes them wrong, or undefined when they are a definition the platform can run: the steps are the ones of the chain, each kind once and in the order of the chain starting with the unit approver,
 * the single decision is the one step of the unit approver, and whatever the engine refuses (a role without a unit, an escalation without a target, an SLA out of range) is refused here with the same field.
 */
export function reportWorkflowDefect(params: Record<string, unknown>): string | undefined {
  const workflow = reportWorkflowOf(params);
  if (!WORKFLOW_MODES.includes(workflow.mode)) return 'mode';
  const kinds = workflow.steps.map((step) => step.kind);
  const order = kinds.map((kind) => REPORT_STEP_KINDS.indexOf(kind));
  for (let at = 0; at < order.length; at += 1) {
    if ((order[at] ?? -1) < 0) return `steps[${at}].kind`;
    if (at > 0 && (order[at] ?? 0) <= (order[at - 1] ?? 0)) return `steps[${at}].kind`;
  }
  if (kinds[0] !== 'UNIT_APPROVER') return 'steps[0].kind';
  if (workflow.mode === 'SINGLE_DECISION' && workflow.steps.length !== 1) return 'steps';
  const defect = validateDefinition(engineDefinitionOf(workflow), REPORT_ACCEPT_BUSINESS_TYPE)[0];
  return defect === undefined ? undefined : ruleFieldOf(defect.path);
}

/** Whether the rule asks for the chain: a tenant on the default never runs the engine for a report. */
export const isStaged = (params: unknown): boolean => reportWorkflowOf(params).mode === 'STAGED';
