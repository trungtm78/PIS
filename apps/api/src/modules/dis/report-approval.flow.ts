import { ApprovalStore, GovernancePolicyPort } from '@machvon/db';
import type { ApprovalEffects, ApprovalTaskRecord, TenantTx, WorkflowInstanceRecord } from '@machvon/db';
import { APPROVAL_WORKFLOW_RULE_TYPE, DomainError, REPORT_ACCEPT_BUSINESS_TYPE, REPORT_WORKFLOW_RESOURCE, REPORT_WORKFLOW_RULE_CODE, engineDefinitionOf, reportWorkflowOf } from '@machvon/kernel';
import type { ApprovalWorkflowDefinition, DecisionInput, ReportWorkflow } from '@machvon/kernel';
import type { FinalCommandRegistry } from '../adm/approval.service';

/** The rule that governs the approval of the weekly reports on the day, with the version that decided (0 for the built-in default). */
export interface GovernedWorkflow {
  workflow: ReportWorkflow;
  ruleVersion: number;
  ruleId: string | null;
}

/** What a decision on a step did: whether the report was decided by it (the last step), and the instance after it. */
export interface StepDecision {
  step: 'STAYED' | 'NEXT_STEP' | 'RETURNED_TO_STEP' | 'COMPLETED';
  instance: WorkflowInstanceRecord;
  taskId: string;
}

/**
 * The approval of a weekly report on the ADM engine (WF-1), for the DIS commands. The steps are read from the governance rules (default: the single decision, which never runs the engine); a tenant that approved the staged
 * mode has every handed-in report start an instance, and the decision command turns into the decision of the task of the person who decides. The last approval ends in the same step as the single decision does
 * (`applyReportDecision`), a return ends the instance, and a withdrawal cancels it, so the report and the instance never disagree.
 */
export class ReportApprovalFlow {
  private readonly policy = new GovernancePolicyPort();
  private readonly approvals = new ApprovalStore();

  /** `commands` is the registry of the final commands of the process; absent where the ADM module is not mounted. */
  constructor(private readonly commands?: FinalCommandRegistry) {}

  /** The workflow in force for the tenant on the day (the built-in default when no rule was approved). */
  async workflowFor(tx: TenantTx, now: Date): Promise<GovernedWorkflow> {
    const rule = await this.policy.require(tx, APPROVAL_WORKFLOW_RULE_TYPE, REPORT_WORKFLOW_RULE_CODE, now);
    return { workflow: reportWorkflowOf(rule.params), ruleVersion: rule.version, ruleId: rule.ruleId };
  }

  /**
   * Starts the instance of a report that was handed in, when the tenant runs the staged mode: the definition of the rule is published as the version in force (its author is who proposed the rule, its publisher who approved it),
   * the DoA band is resolved at the unit that owns the project, and the first step gives its tasks. Any refusal (no DoA rule, no approver, a business type nobody can end) rolls the hand-in back and the report stays a draft.
   */
  async startIfStaged(tx: TenantTx, effects: ApprovalEffects, report: { id: string; projectId: string; version: number; submittedBy: string; cumulativeVnd: string }, now: Date): Promise<WorkflowInstanceRecord | undefined> {
    const governed = await this.workflowFor(tx, now);
    if (governed.workflow.mode !== 'STAGED') return undefined;
    if (this.commands === undefined || !this.commands.canHandle(REPORT_ACCEPT_BUSINESS_TYPE)) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    const [rule] = governed.ruleId === null ? [] : await tx.query<{ created_by: string; approved_by: string }>('select created_by, approved_by from machvon.governance_rule where id = $1::uuid and approved_by is not null', [governed.ruleId]);
    if (rule === undefined) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    await this.approvals.adopt(tx, effects, { businessType: REPORT_ACCEPT_BUSINESS_TYPE, definition: engineDefinitionOf(governed.workflow), proposedBy: rule.created_by, approvedBy: rule.approved_by, ruleVersion: governed.ruleVersion, now });
    const [project] = await tx.query<{ owner_unit_id: string }>('select owner_unit_id from machvon.project where id = $1::uuid', [report.projectId]);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.approvals.start(tx, effects, {
      resourceType: REPORT_WORKFLOW_RESOURCE,
      resourceId: report.id,
      resourceVersion: report.version,
      businessType: REPORT_ACCEPT_BUSINESS_TYPE,
      amountVnd: report.cumulativeVnd,
      unitId: project.owner_unit_id,
      initiatorMembershipId: report.submittedBy,
      now,
    });
  }

  /** The instance that is running for the report, if any: a report handed in before the staged mode was approved has none and is decided as it always was. */
  runningFor(tx: TenantTx, reportId: string): Promise<WorkflowInstanceRecord | undefined> {
    return this.approvals.findRunning(tx, REPORT_WORKFLOW_RESOURCE, reportId);
  }

  /**
   * An approval on the report that has a running instance: the decision of the pending task of the person who decides (403 `APPROVER_NOT_AUTHORIZED` when they hold none: the report is theirs to review but not at this
   * step). `apply` is the decision of the report itself and runs only when this approval is the last one the instance needs.
   */
  async approve(tx: TenantTx, effects: ApprovalEffects, instance: WorkflowInstanceRecord, input: DecisionInput, now: Date, apply: () => Promise<void>): Promise<StepDecision> {
    const task = await this.approvals.pendingTaskFor(tx, instance, effects.actor);
    if (task === undefined) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'assignee');
    const result = await this.approvals.decide(tx, effects, {
      taskId: task.id,
      expectedVersion: task.version,
      decision: 'approve',
      reason: input.reason,
      returnToStep: undefined,
      now,
      finish: async () => {
        await apply();
        return 'APPLIED';
      },
    });
    // The one who handed the report in never reaches here (the command refused them before), so a refusal of the engine is a rule of the engine that the command did not know.
    if (result.kind === 'SELF_APPROVAL') throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await effects.audit({
      action: 'approval.task_decided',
      resourceType: 'approval_task',
      resourceId: result.task.id,
      diff: { decision: 'approve', step_id: result.task.stepId, step: result.step, outcome: result.outcome, final_command: result.finalCommand, instance_id: result.instance.id },
    });
    return { step: result.step, instance: result.instance, taskId: result.task.id };
  }

  /** What a screen shows of the approval of a report: the rule in force, the instance the report had last (running or not), the definition it ran by and its tasks. */
  async read(tx: TenantTx, reportId: string, now: Date): Promise<{ governed: GovernedWorkflow; instance: WorkflowInstanceRecord | undefined; definition: ApprovalWorkflowDefinition | undefined; tasks: ApprovalTaskRecord[] }> {
    const governed = await this.workflowFor(tx, now);
    const instance = await this.approvals.findLatest(tx, REPORT_WORKFLOW_RESOURCE, reportId);
    if (instance === undefined) return { governed, instance, definition: undefined, tasks: [] };
    return { governed, instance, definition: await this.approvals.definitionOf(tx, instance), tasks: await this.approvals.tasksOf(tx, instance.id) };
  }

  /** The report was sent back or taken back: the running instance ends Cancelled with its open tasks (false when there was none). */
  cancelIfRunning(tx: TenantTx, effects: ApprovalEffects, reportId: string, reason: string, now: Date): Promise<boolean> {
    return this.approvals.cancel(tx, effects, { resourceType: REPORT_WORKFLOW_RESOURCE, resourceId: reportId, reason, now });
  }
}
