import { PLAN_PUBLISHED_EVENT } from '@machvon/db';
import type { DecideResult, OutboxEventInput, PublicationFacts, SubmitResult } from '@machvon/db';

export const PLAN_SUBMITTED_EVENT = 'capital.plan_submitted.v1';
export const PLAN_DECIDED_EVENT = 'capital.plan_decided.v1';

/** The event `capital.plan_submitted.v1` (CAP 3.1 section 9): a revision is in review. The approvers' inboxes and the plan list read it. */
export function planSubmittedEvent(tenantId: string, actorId: string, result: SubmitResult, occurredAt: Date): Omit<OutboxEventInput, 'correlationId'> {
  return {
    aggregateType: 'capital_plan',
    aggregateId: result.planId,
    aggregateVersion: result.version,
    type: PLAN_SUBMITTED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      capital_plan_id: result.planId,
      version: result.version,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      revision: result.revision,
      plan_year: result.planYear,
      line_count: result.lineCount,
      project_count: result.projectCount,
      total_vnd: result.totalVnd,
    },
    eventKey: `capital_plan:${result.planId}:submitted:${result.version}`,
  };
}

/** The event `capital.plan_decided.v1`: the decision on a revision in review. The reason is for the planner on the screen and the audit trail, never for the event. */
export function planDecidedEvent(tenantId: string, actorId: string, result: DecideResult, occurredAt: Date): Omit<OutboxEventInput, 'correlationId'> {
  return {
    aggregateType: 'capital_plan',
    aggregateId: result.planId,
    aggregateVersion: result.version,
    type: PLAN_DECIDED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      capital_plan_id: result.planId,
      version: result.version,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      revision: result.revision,
      plan_year: result.planYear,
      decision: result.decision,
      status: result.status,
    },
    eventKey: `capital_plan:${result.planId}:decided:${result.version}`,
  };
}

/**
 * The event `capital.plan_published.v1` (CAP 3.1 section 9) for the publication of a plan: the payload the project register reads to move
 * the projects of the pipeline that have a funded line to BUDGETED (`apps/api/src/modules/prj/plan-published.consumer.ts`), with the decision
 * document and the moment the plan takes effect for the disbursement reports. `facts` come from `CapPlanStore.publicationFacts`, read in the
 * transaction of the publication, so the event names exactly the projects that have money in the plan the transaction publishes. The
 * publication command (ST-CAP-003) emits it with `scope.emit` in the same transaction as the state change.
 */
export function planPublishedEvent(
  tenantId: string,
  actorId: string,
  facts: PublicationFacts,
  planVersion: number,
  occurredAt: Date,
): Omit<OutboxEventInput, 'correlationId'> {
  return {
    aggregateType: 'capital_plan',
    aggregateId: facts.capitalPlanId,
    aggregateVersion: planVersion,
    type: PLAN_PUBLISHED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      capital_plan_id: facts.capitalPlanId,
      version: planVersion,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      revision: facts.revision,
      plan_year: facts.planYear,
      effective_at: facts.effectiveAt,
      decision_document_id: facts.decisionDocumentId,
      project_ids: facts.projectIds,
    },
    eventKey: `capital_plan:${facts.capitalPlanId}:published`,
  };
}
