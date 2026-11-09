import { ApprovalStore, GovernancePolicyPort } from '@machvon/db';
import type { ApprovalEffects, HoldRecord, TenantTx, WorkflowInstanceRecord } from '@machvon/db';
import { APPROVAL_WORKFLOW_RULE_TYPE, DomainError, engineDefinitionOf, reportWorkflowOf } from '@machvon/kernel';
import type { ReportWorkflow, StagedApprovalSpec } from '@machvon/kernel';
import type { ApprovalHoldService } from './approval-hold.service';
import type { FinalCommandRegistry } from './approval.service';

/** The rule that governs the staged approval of an owner on the day, with the version that decided (0 for the built-in default). */
export interface StagedWorkflow {
  workflow: ReportWorkflow;
  ruleVersion: number;
  ruleId: string | null;
}

/** What a decision on a step did. `HELD` is the PUSH step that handed its package over and waits for the receipt (R22): the record is not decided yet. */
export interface StagedDecision {
  step: 'STAYED' | 'NEXT_STEP' | 'RETURNED_TO_STEP' | 'COMPLETED' | 'HELD';
  instance: WorkflowInstanceRecord;
  taskId: string;
  hold?: HoldRecord;
}

export interface StagedRecord {
  id: string;
  version: number;
  /** The unit the DoA band is resolved at (the unit that owns the project). */
  unitId: string;
  /** The amount the band is judged on, whole dong as text; null judges the lowest band. */
  amountVnd: string | null;
  /** The membership that handed the record in: the maker, never the checker. */
  initiator: string;
}

/**
 * The staged approval of one owner on the ADM engine (ENT-3c, QT.01): the steps are read from the governance rules (default: the single decision, which never runs the engine), a tenant that approved the staged mode
 * has every record that is handed in start an instance, and the decision command turns into the decision of the task of the person who decides. The last approval ends in the same step as the single decision does
 * (the final command of the business type), a return ends the instance, and a withdrawal cancels it, so the record and the instance never disagree. `ReportApprovalFlow` is the same thing for the weekly report of DIS, kept as
 * it was (regression contract R4); FND batches and IND entry batches use this class.
 */
export class StagedApprovalFlow {
  private readonly policy = new GovernancePolicyPort();
  private readonly approvals = new ApprovalStore();

  constructor(
    readonly spec: StagedApprovalSpec,
    private readonly commands?: FinalCommandRegistry,
    private readonly holds?: ApprovalHoldService,
  ) {}

  async workflowFor(tx: TenantTx, now: Date): Promise<StagedWorkflow> {
    const rule = await this.policy.require(tx, APPROVAL_WORKFLOW_RULE_TYPE, this.spec.ruleCode, now);
    return { workflow: reportWorkflowOf(rule.params), ruleVersion: rule.version, ruleId: rule.ruleId };
  }

  /** Whether the tenant runs the staged mode for this owner on the day. A process where the rule type is not registered runs the single decision, as every tenant did before the staged mode existed. */
  async isStaged(tx: TenantTx, now: Date): Promise<boolean> {
    const rule = await this.policy.get(tx, APPROVAL_WORKFLOW_RULE_TYPE, this.spec.ruleCode, now);
    return rule !== undefined && reportWorkflowOf(rule.params).mode === 'STAGED';
  }

  /**
   * Starts the instance of a record that was handed in, when the tenant runs the staged mode: the definition of the rule is published as the version in force (its author is who proposed the rule, its publisher who approved it)
   * and the first step gives its tasks. Any refusal (no DoA rule, no approver, a business type nobody can end) rolls the hand-in back. Undefined when the tenant runs the single decision.
   */
  async startIfStaged(tx: TenantTx, effects: ApprovalEffects, record: StagedRecord, now: Date): Promise<WorkflowInstanceRecord | undefined> {
    const governed = await this.workflowFor(tx, now);
    if (governed.workflow.mode !== 'STAGED') return undefined;
    if (this.commands === undefined || !this.commands.canHandle(this.spec.businessType)) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    const [rule] = governed.ruleId === null ? [] : await tx.query<{ created_by: string; approved_by: string }>('select created_by, approved_by from machvon.governance_rule where id = $1::uuid and approved_by is not null', [governed.ruleId]);
    if (rule === undefined) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    await this.approvals.adopt(tx, effects, { businessType: this.spec.businessType, definition: engineDefinitionOf(governed.workflow, this.spec.businessType), proposedBy: rule.created_by, approvedBy: rule.approved_by, ruleVersion: governed.ruleVersion, now });
    return this.approvals.start(tx, effects, {
      resourceType: this.spec.resourceType,
      resourceId: record.id,
      resourceVersion: record.version,
      businessType: this.spec.businessType,
      amountVnd: record.amountVnd,
      unitId: record.unitId,
      initiatorMembershipId: record.initiator,
      now,
    });
  }

  /** The instance that is running for the record, if any: a record handed in before the staged mode was approved has none and is decided as it always was. */
  runningFor(tx: TenantTx, recordId: string): Promise<WorkflowInstanceRecord | undefined> {
    return this.approvals.findRunning(tx, this.spec.resourceType, recordId);
  }

  /**
   * An approval on the record that has a running instance: the decision of the pending task of the person who decides (403 `APPROVER_NOT_AUTHORIZED` when they hold none: the record is theirs to review but not at this
   * step). The final command of the business type (the owner's own handler) decides the record itself and runs only when this approval is the last one the instance needs; at the PUSH step of a process that has a
   * receiver it runs when the receipt comes, not now.
   */
  async approve(tx: TenantTx, effects: ApprovalEffects, instance: WorkflowInstanceRecord, input: { reason: string | undefined }, now: Date, tenantId: string): Promise<StagedDecision> {
    if (this.commands === undefined || !this.commands.canHandle(this.spec.businessType)) throw new DomainError('WORKFLOW_NOT_CONFIGURED', 422, 'business_type');
    const task = await this.approvals.pendingTaskFor(tx, instance, effects.actor);
    if (task === undefined) throw new DomainError('APPROVER_NOT_AUTHORIZED', 403, 'assignee');
    const result = await this.approvals.decide(tx, effects, {
      taskId: task.id,
      expectedVersion: task.version,
      decision: 'approve',
      reason: input.reason,
      returnToStep: undefined,
      now,
      hold: this.holds?.hook(tenantId),
      finish: this.commands.asFinalCommand(),
    });
    if (result.kind === 'HELD') return { step: 'HELD', instance: result.instance, taskId: result.task.id, hold: result.hold };
    // The one who handed the record in never reaches here (the command refused them before), so a refusal of the engine is a rule of the engine that the command did not know.
    if (result.kind === 'SELF_APPROVAL') throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await effects.audit({
      action: 'approval.task_decided',
      resourceType: 'approval_task',
      resourceId: result.task.id,
      diff: { decision: 'approve', step_id: result.task.stepId, step: result.step, outcome: result.outcome, final_command: result.finalCommand, instance_id: result.instance.id },
    });
    return { step: result.step, instance: result.instance, taskId: result.task.id };
  }

  /** The record was sent back or taken back: the running instance ends Cancelled with its open tasks and holds (false when there was none). */
  cancelIfRunning(tx: TenantTx, effects: ApprovalEffects, recordId: string, reason: string, now: Date): Promise<boolean> {
    return this.approvals.cancel(tx, effects, { resourceType: this.spec.resourceType, resourceId: recordId, reason, now });
  }
}
