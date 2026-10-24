import { PERMISSIONS } from '@machvon/contracts';
import { BalanceDriftError, CAP_PLAN_DECISIONS, CapPlanApprovalStore, CapPlanPublicationStore, CapPlanStore } from '@machvon/db';
import type { AuditEntry, CapPlanDecision, OutboxEventInput, PlanAuthorizer, PublishResult, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { planDecidedEvent, planPublishedEvent, planSubmittedEvent } from './plan-events';

const RESOURCE_TYPE = 'capital_plan';
const SUBMIT_PERMISSION = PERMISSIONS.submitCapitalPlan;
const DECIDE_PERMISSION = PERMISSIONS.decideCapitalPlan;
const PUBLISH_PERMISSION = PERMISSIONS.post_plans_id_publish;
const PUBLISH_LATENCY_METRIC = 'cap_publish_latency_ms';
const DRIFT_METRIC = 'cap_balance_drift_vnd';

/**
 * Where a step of the approval runs: a transaction of the tenant, the person who acts, and the places the step writes its audit row and its event.
 * A command gives the ones of its CommandScope; a workflow activity gives the ones of its own transaction. Either way the audit row and the event
 * are written in the transaction of the step.
 */
export interface StepScope {
  tx: TenantTx;
  tenantId: string;
  actorId: string;
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<unknown>;
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<unknown>;
}

/** What a step answers: the status and version the plan has now. */
export interface StepResult {
  planId: string;
  status: string;
  version: number;
}

export interface DecisionInput {
  decision: string;
  reason: string;
}

export interface PublishCommand {
  decisionDocumentId: string;
  effectiveAt?: string | undefined;
}

/** Judges the unit a plan belongs to: the grant that holds the permission must reach it (a plan is submitted, decided and published for its own unit). */
export function unitAuthorizer(access: EffectiveAccess, permission: string, now: Date): PlanAuthorizer {
  return (unit) => {
    if (!holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), permission)) throw new DomainError('SCOPE_DENIED', 403);
  };
}

/** What the audit row of a publication keeps: the totals before and after and the entries it appended, so a reviewer can follow the money without the ledger. */
function publishDiff(expectedVersion: number, result: PublishResult): Record<string, unknown> {
  return {
    plan_version_before: expectedVersion,
    plan_version_after: result.version,
    revision: result.revision,
    plan_year: result.planYear,
    superseded_plan_id: result.supersededId,
    decision_document_id: result.decisionDocumentId,
    effective_at: result.effectiveAt,
    line_count: result.lineCount,
    total_before_vnd: result.totalBeforeVnd,
    total_after_vnd: result.totalAfterVnd,
    allocate_vnd: result.allocateVnd,
    reduce_vnd: result.reduceVnd,
    ledger_entry_count: result.ledger.length,
    ledger_entry_ids: result.ledger.map((entry) => entry.entryId),
    national_code_warning_project_ids: result.nationalCodeWarnings,
  };
}

/**
 * The three steps of the approval of the capital plan (ST-CAP-003, CAP 3.1 F2 steps 3 to 5): submit, decide and publish. Each judges the unit of
 * the plan against the grants of the caller, runs the store in the transaction it is given, and leaves its audit row and its event in that
 * transaction. The commands of the API and the activities of the approval workflow run these same steps.
 */
export class CapitalPlanApprovalService {
  private readonly approvals = new CapPlanApprovalStore();
  private readonly publication = new CapPlanPublicationStore();
  private readonly plans = new CapPlanStore();
  private readonly metrics: MetricsSink;

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
  }

  async submit(step: StepScope, access: EffectiveAccess, planId: string, expectedVersion: number, now: Date = new Date()): Promise<StepResult> {
    const result = await this.approvals.submit(step.tx, planId, expectedVersion, step.actorId, unitAuthorizer(access, SUBMIT_PERMISSION, now));
    await step.audit({
      action: 'capital.plan_submitted',
      resourceType: RESOURCE_TYPE,
      resourceId: result.planId,
      diff: {
        plan_version_before: expectedVersion,
        plan_version_after: result.version,
        revision: result.revision,
        plan_year: result.planYear,
        line_count: result.lineCount,
        project_count: result.projectCount,
        total_vnd: result.totalVnd,
      },
    });
    await step.emit(planSubmittedEvent(step.tenantId, step.actorId, result, now));
    return { planId: result.planId, status: result.status, version: result.version };
  }

  async decide(step: StepScope, access: EffectiveAccess, planId: string, expectedVersion: number, input: DecisionInput, now: Date = new Date()): Promise<StepResult> {
    if (!CAP_PLAN_DECISIONS.includes(input.decision as CapPlanDecision)) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const result = await this.approvals.decide(step.tx, planId, expectedVersion, input.decision as CapPlanDecision, input.reason, step.actorId, unitAuthorizer(access, DECIDE_PERMISSION, now));
    await step.audit({
      action: 'capital.plan_decided',
      resourceType: RESOURCE_TYPE,
      resourceId: result.planId,
      reason: input.reason.trim(),
      diff: {
        decision: result.decision,
        status: result.status,
        plan_version_before: expectedVersion,
        plan_version_after: result.version,
        revision: result.revision,
        plan_year: result.planYear,
        line_count: result.lineCount,
        released_ceilings: result.released.map((move) => ({ appropriation_id: move.id, allocated_before_vnd: move.allocatedBeforeVnd, allocated_after_vnd: move.allocatedAfterVnd })),
      },
    });
    await step.emit(planDecidedEvent(step.tenantId, step.actorId, result, now));
    return { planId: result.planId, status: result.status, version: result.version };
  }

  async publish(step: StepScope, access: EffectiveAccess, planId: string, expectedVersion: number, command: PublishCommand, now: Date = new Date()): Promise<StepResult> {
    const started = performance.now();
    let result: PublishResult;
    try {
      result = await this.publication.publish(step.tx, planId, expectedVersion, command, step.actorId, unitAuthorizer(access, PUBLISH_PERMISSION, now), undefined, now);
    } catch (error) {
      if (error instanceof BalanceDriftError) this.metrics.gauge(DRIFT_METRIC, Number(error.totalVnd), {});
      throw error;
    }
    this.metrics.gauge(DRIFT_METRIC, 0, {});
    this.metrics.gauge(PUBLISH_LATENCY_METRIC, Math.round(performance.now() - started), { outcome: result.supersededId === null ? 'first' : 'revision' });
    await step.audit({ action: 'capital.plan_published', resourceType: RESOURCE_TYPE, resourceId: result.planId, diff: publishDiff(expectedVersion, result) });
    // The facts are read in this transaction, so the event names exactly the projects that have money in the plan this transaction publishes.
    const facts = await this.plans.publicationFacts(step.tx, result.planId);
    if (facts === undefined) throw new Error('a plan that was just published is not published');
    await step.emit(planPublishedEvent(step.tenantId, step.actorId, facts, result.version, now));
    return { planId: result.planId, status: 'PUBLISHED', version: result.version };
  }
}
