import type { ApprovalTaskRecord as TaskRecord, HoldRecord, WorkflowInstanceRecord as InstanceRecord } from '@machvon/db';
import type { ApprovalWorkflowDefinition, ReportStepKind, ReportWorkflow, RevisionStatus } from '@machvon/kernel';
import { REPORT_STEP_KINDS } from '@machvon/kernel';
import type { GovernedWorkflow } from './report-approval.flow';

export type StepStatus = 'WAITING' | 'CURRENT' | 'AWAITING_RECEIPT' | 'PUSH_FAILED' | 'DONE' | 'CANCELLED';

/** The screen where the receipt of a held PUSH step is recorded. */
const RECEIPT_SCREEN = 'HPM-01';

interface StepFacts {
  id: string;
  kind: ReportStepKind;
  name: string;
  slaWorkingHours: number;
}

const kindOf = (tag: string | undefined, fallback: ReportStepKind): ReportStepKind => REPORT_STEP_KINDS.find((kind) => kind === tag) ?? fallback;

/** The status of a step of a report that has no instance, from the status of the report: the single decision is the one step, current while the report waits for it. */
function plainStatus(report: RevisionStatus, index: number): StepStatus {
  switch (report) {
    case 'DRAFT':
      return 'WAITING';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return index === 0 ? 'CURRENT' : 'WAITING';
    case 'RETURNED':
    case 'WITHDRAWN':
      return 'CANCELLED';
    default:
      return 'DONE';
  }
}

function instanceStatus(instance: InstanceRecord, index: number): StepStatus {
  if (instance.status === 'Running') return index < instance.currentStep ? 'DONE' : index === instance.currentStep ? 'CURRENT' : 'WAITING';
  if (instance.outcome === 'APPROVED') return 'DONE';
  return index < instance.currentStep ? 'DONE' : 'CANCELLED';
}

/**
 * The steps of the approval of a report as a screen reads them (WF-1): the steps the instance runs by (or, with no instance, the ones the rule in force names), each with its status, the deadline and who was given it. The
 * deadline of a step is the earliest deadline of its open tasks, or the one it had when it was decided; a step is overdue when it is current and the deadline is passed.
 */
export function workflowView(input: {
  governed: GovernedWorkflow;
  report: RevisionStatus;
  instance: InstanceRecord | undefined;
  definition: ApprovalWorkflowDefinition | undefined;
  tasks: TaskRecord[];
  holds?: HoldRecord[];
  now: Date;
}): Record<string, unknown> {
  const { governed, instance, definition, now } = input;
  const facts: StepFacts[] =
    instance !== undefined && definition !== undefined
      ? definition.steps.map((step, index) => ({ id: step.id, kind: kindOf(step.tag, REPORT_STEP_KINDS[Math.min(index, REPORT_STEP_KINDS.length - 1)] ?? 'UNIT_APPROVER'), name: step.name, slaWorkingHours: step.sla_working_hours }))
      : (governed.workflow as ReportWorkflow).steps.map((step) => ({ id: step.id, kind: step.kind, name: step.name, slaWorkingHours: step.slaWorkingHours }));
  const steps = facts.map((fact, index) => {
    const plain = instance === undefined ? plainStatus(input.report, index) : instanceStatus(instance, index);
    const tasks = input.tasks.filter((task) => task.stepIndex === index && task.status !== 'Reassigned');
    // A PUSH step that handed its package over is waiting for the receipt, never done (R22): the hold of its newest task says so.
    const hold = (input.holds ?? []).find((one) => tasks.some((task) => task.id === one.taskId));
    const status: StepStatus = hold !== undefined && (hold.state === 'AWAITING_RECEIPT' || hold.state === 'PUSH_FAILED') && instance?.status === 'Running' ? hold.state : plain;
    // Only the traversal of the step the instance is in now counts for its deadline: the tasks of an earlier pass (after a return) are history.
    const open = tasks.filter((task) => task.status === 'Pending');
    const dueSource = open.length > 0 ? open : tasks.filter((task) => task.status === 'Decided');
    const due = dueSource.map((task) => task.dueAt).sort()[0] ?? null;
    return {
      id: fact.id,
      kind: fact.kind,
      name: fact.name,
      status,
      sla_working_hours: fact.slaWorkingHours,
      due_at: due,
      overdue: status === 'CURRENT' && due !== null && Date.parse(due) < now.getTime(),
      receipt:
        hold === undefined
          ? null
          : { state: hold.state, push_id: hold.pushId, push_key: hold.pushKey, push_status: hold.pushStatus, attempts: hold.attempts, held_by: hold.heldBy, held_at: hold.createdAt, receipt_at: hold.receiptAt, receiver_screen: RECEIPT_SCREEN },
      tasks: tasks.map((task) => ({
        task_id: task.id,
        assignee: { id: task.assigneeId, name: task.assigneeName },
        status: task.status,
        decision: task.decision,
        decided_at: task.decidedAt,
        due_at: task.dueAt,
        overdue_reminders: task.overdueReminders,
        escalated_at: task.escalatedAt,
      })),
    };
  });
  return {
    mode: governed.workflow.mode,
    rule_version: governed.ruleVersion,
    rule_source: governed.ruleId === null ? 'DEFAULT' : 'RULE',
    instance:
      instance === undefined
        ? null
        : { id: instance.id, status: instance.status, outcome: instance.outcome, current_step: instance.currentStep, started_at: instance.startedAt, ended_at: instance.endedAt },
    steps,
    as_of: now.toISOString(),
  };
}
