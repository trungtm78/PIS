import { PERMISSIONS } from '@machvon/contracts';
import { CapPlanStore, CapReallocationStore, reallocationAppliedEvent, reallocationRecord } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { planPublishedEvent } from './plan-events';
import { unitAuthorizer } from './plan-approval.service';
import type { StepScope } from './plan-approval.service';

/** What a step answers: the proposal, the status and the version it has now. */
export interface ReallocationStepResult {
  proposalId: string;
  status: string;
  version: number;
}

export interface ReallocationDecision {
  decision: string;
  reason: string;
}

/**
 * The three steps of the approval of a reallocation proposal (ST-CAP-010, CAP 3.1 F5): submit, decide and apply. Each judges the unit of the proposal against the grants of the caller, runs the store in the
 * transaction it is given, and leaves its audit rows and its events in that transaction. The commands of the API and the activities of the approval workflow run these same steps, so a proposal moved by the
 * workflow leaves what one moved by the API leaves, and the four-eyes of the store (the decider and the applier are neither the author nor the submitter) holds on either path.
 */
export class ReallocationApprovalService {
  private readonly store = new CapReallocationStore();
  private readonly plans = new CapPlanStore();

  async submit(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, now: Date = new Date()): Promise<ReallocationStepResult> {
    const done = await this.store.submit(step.tx, { id, expectedVersion, actor: step.actorId, now, authorize: unitAuthorizer(access, PERMISSIONS.submitReallocationProposal, now) });
    await step.audit(reallocationRecord('submitted', done));
    return resultOf(done.row);
  }

  async decide(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, input: ReallocationDecision, now: Date = new Date()): Promise<ReallocationStepResult> {
    const done = await this.store.decide(step.tx, {
      id,
      expectedVersion,
      actor: step.actorId,
      now,
      authorize: unitAuthorizer(access, PERMISSIONS.decideReallocationProposal, now),
      decision: input.decision,
      reason: input.reason,
    });
    await step.audit(reallocationRecord(input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'returned', done));
    return resultOf(done.row);
  }

  async apply(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, command: { decisionDocumentId: string }, now: Date = new Date()): Promise<ReallocationStepResult> {
    const done = await this.store.apply(step.tx, { id, expectedVersion, actor: step.actorId, now, authorize: unitAuthorizer(access, PERMISSIONS.applyReallocationProposal, now), decisionDocumentId: command.decisionDocumentId });
    await step.audit(reallocationRecord('applied', done));
    // The revision that the application published is published like any other: its own audit row and its own event, which the project register reads to move the projects that now have money.
    await step.audit({
      action: 'capital.plan_published',
      resourceType: 'capital_plan',
      resourceId: done.resultingPlanId,
      diff: {
        via: 'reallocation',
        proposal_id: done.row.id,
        revision: done.published.revision,
        plan_year: done.published.planYear,
        superseded_plan_id: done.published.supersededId,
        decision_document_id: done.published.decisionDocumentId,
        total_before_vnd: done.published.totalBeforeVnd,
        total_after_vnd: done.published.totalAfterVnd,
        transferred: done.transferred.map((entry) => ({ entry_type: entry.entryType, project_id: entry.projectId, allocation_line_id: entry.allocationLineId, amount_vnd: entry.amountVnd })),
      },
    });
    await step.emit(reallocationAppliedEvent(done, step.tenantId, step.actorId, now));
    const facts = await this.plans.publicationFacts(step.tx, done.resultingPlanId);
    if (facts === undefined) throw new Error('a plan that was just published is not published');
    await step.emit(planPublishedEvent(step.tenantId, step.actorId, facts, done.published.version, now));
    return resultOf(done.row);
  }
}

function resultOf(row: { id: string; status: string; version: number }): ReallocationStepResult {
  return { proposalId: row.id, status: row.status, version: row.version };
}
