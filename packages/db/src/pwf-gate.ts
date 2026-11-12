import { DomainError, pwfWorkflow } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The gate of the stage commands (PWF-1, R29, BR-PWF-13): the legal life cycle of a project (the table of `prj-stage-machine`) is moved only by its own commands and system events, and each of them asks this gate, inside its
 * own transaction, whether the workflow of the project allows the move. A project that has no workflow is never asked anything and behaves as it always did. A phase of the frozen template lists the commands it keeps closed
 * until its required tasks are done and approved (or waived, or cancelled, each with a decision of a second person); the answer names the tasks that are still missing and why.
 */

export interface GateOutcome {
  workflowId: string;
  target: string;
  gated: boolean;
  open: boolean;
  missing: Array<{ task: string; taskId: string | null; phase: string; reason: pwfWorkflow.GateMissingReason }>;
}

export interface ProjectWorkflowGatePort {
  /** Whether the target may run for the project; `undefined` when the project has no workflow (nothing to check). */
  assess(tx: TenantTx, projectId: string, target: string): Promise<GateOutcome | undefined>;
  /** Refuses the target (422 `PWF_GATE_CLOSED` with the missing tasks) when the workflow of the project keeps it closed; does nothing otherwise. */
  assert(tx: TenantTx, projectId: string, target: string): Promise<void>;
}

interface GateSql {
  workflow_id: string;
  template: Record<string, unknown>;
  facts: pwfWorkflow.ProjectFacts;
}

interface TaskGateSql {
  id: string;
  task_code: string;
  status: string;
  tracked: boolean;
  excluded: boolean;
  approver_role: string | null;
  approved_by: string | null;
  cancelled_by: string | null;
  waived: boolean;
}

export const gateRefusal = (outcome: GateOutcome): DomainError =>
  new DomainError('PWF_GATE_CLOSED', 422, 'target', { extensions: { target: outcome.target, missing: outcome.missing.map((one) => ({ task: one.task, task_id: one.taskId, phase: one.phase, reason: one.reason })) } });

export class SqlProjectWorkflowGate implements ProjectWorkflowGatePort {
  async assess(tx: TenantTx, projectId: string, target: string): Promise<GateOutcome | undefined> {
    const workflows = await tx.query<GateSql>('select id as workflow_id, template, facts from machvon.project_workflow where project_id = $1::uuid', [projectId]);
    const workflow = workflows[0];
    if (workflow === undefined) return undefined;
    const template = pwfWorkflow.parseProjectWorkflowTemplate(workflow.template);
    // A command no phase lists is not gated: nothing else is read.
    if (!template.phases.some((phase) => (phase.gates as readonly string[]).includes(target))) return { workflowId: workflow.workflow_id, target, gated: false, open: true, missing: [] };
    const rows = await tx.query<TaskGateSql>(
      `select t.id, t.task_code, t.status, t.tracked, t.excluded, t.approver_role, t.approved_by, t.cancelled_by,
              exists (select 1 from machvon.project_task_exception e
                       where e.tenant_id = t.tenant_id and e.task_id = t.id and e.kind = 'WAIVE_REQUIREMENT' and e.status in ('APPROVED', 'USED') and e.items ? 'TASK') as waived
         from machvon.project_task t where t.workflow_id = $1::uuid`,
      [workflow.workflow_id],
    );
    const ids = new Map(rows.map((row) => [row.task_code, row.id] as const));
    const states: pwfWorkflow.TaskGateState[] = rows.map((row) => ({
      code: row.task_code,
      status: row.status === 'DONE' || row.status === 'CANCELLED' || row.status === 'NOT_STARTED' ? row.status : 'IN_PROGRESS',
      completionApproved: !row.tracked || row.approver_role === null || row.approved_by !== null,
      waived: row.waived,
      cancelApproved: row.cancelled_by !== null,
    }));
    const verdict = pwfWorkflow.gateFor(template, target, workflow.facts, states);
    return { workflowId: workflow.workflow_id, target, gated: verdict.gated, open: verdict.open, missing: verdict.missing.map((one) => ({ task: one.task, taskId: ids.get(one.task) ?? null, phase: one.phase, reason: one.reason })) };
  }

  async assert(tx: TenantTx, projectId: string, target: string): Promise<void> {
    const outcome = await this.assess(tx, projectId, target);
    if (outcome !== undefined && outcome.gated && !outcome.open) throw gateRefusal(outcome);
  }
}
