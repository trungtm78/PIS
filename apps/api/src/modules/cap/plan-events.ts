import { PLAN_PUBLISHED_EVENT } from '@machvon/db';
import type { OutboxEventInput, PublicationFacts } from '@machvon/db';

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
