import { PERMISSIONS } from '@machvon/contracts';
import { CapPlanStore, CapReallocationImpactStore, CapReallocationStore, DoaMatrixStore, reallocationAppliedEvent, reallocationImpactRecord, reallocationRecord } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { planPublishedEvent } from './plan-events';
import { unitAuthorizer } from './plan-approval.service';
import type { StepScope } from './plan-approval.service';
import { assertReallocationDelegation } from './reallocation.delegation';

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
 *
 * GOV-11a (G1-12) adds three things to the steps without changing their order: submitting writes the impact of the proposal on the disbursement rates once (`reallocation_impact`, evidence for the approver);
 * approving needs that record when the policy `REALLOCATION_POLICY` says `simulation_required` (422 `REALLOCATION_IMPACT_MISSING`); and approving or applying is limited by the delegation matrix of ADM for the
 * total of the proposal (document type `CAP_REALLOCATION`), so a leader below the band that covers the amount is refused (403 `SCOPE_DENIED`).
 */
export class ReallocationApprovalService {
  private readonly store = new CapReallocationStore();
  private readonly plans = new CapPlanStore();
  private readonly impacts = new CapReallocationImpactStore();
  private readonly doa = new DoaMatrixStore();

  async submit(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, now: Date = new Date()): Promise<ReallocationStepResult> {
    const done = await this.store.submit(step.tx, { id, expectedVersion, actor: step.actorId, now, authorize: unitAuthorizer(access, PERMISSIONS.submitReallocationProposal, now) });
    await step.audit(reallocationRecord('submitted', done));
    // The impact on the rates is evidence for whoever decides: it is written once, here, for the version the proposal now has.
    const impact = await this.impacts.record(step.tx, { id: done.row.id, version: done.row.version, basisSnapshotId: done.row.basisSnapshotId }, step.actorId, now);
    await step.audit(reallocationImpactRecord(impact, step.actorId));
    return resultOf(done.row);
  }

  async decide(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, input: ReallocationDecision, now: Date = new Date()): Promise<ReallocationStepResult> {
    if (input.decision === 'approve') await this.assertReadyToApprove(step, access, id, expectedVersion, now);
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
    await this.assertDelegation(step, access, id, PERMISSIONS.applyReallocationProposal, now);
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

  /** The impact is recorded for the version that is decided (when the policy asks for it), and the approver is within the delegation for the total. A stale version and a state that cannot be decided are left to the store to refuse (409). */
  private async assertReadyToApprove(step: StepScope, access: EffectiveAccess, id: string, expectedVersion: number, now: Date): Promise<void> {
    const proposal = await this.store.find(step.tx, id);
    if (proposal === undefined || proposal.version !== expectedVersion) return;
    // A proposal that is not waiting for a decision has no impact to ask for: the state is refused by the store (409 STAGE_TRANSITION_DENIED), not by a missing record.
    if (proposal.status !== 'SUBMITTED') return;
    const policy = await this.impacts.policy(step.tx, now);
    if (policy.policy.simulation_required && !(await this.impacts.isRecorded(step.tx, id, expectedVersion))) {
      throw new DomainError('REALLOCATION_IMPACT_MISSING', 422, 'id', { extensions: { proposal_version: expectedVersion } });
    }
    await this.assertDelegation(step, access, id, PERMISSIONS.decideReallocationProposal, now);
  }

  private async assertDelegation(step: StepScope, access: EffectiveAccess, id: string, permission: string, now: Date): Promise<void> {
    const proposal = await this.store.find(step.tx, id);
    if (proposal === undefined) return;
    const units = await step.tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [proposal.scopeUnitId]);
    const unit = units[0];
    if (unit === undefined) return;
    const policy = await this.impacts.policy(step.tx, now);
    await assertReallocationDelegation(this.doa, step.tx, access, { documentType: policy.policy.delegation_document_type, permission, amountVnd: proposal.totalVnd, unit, now });
  }
}

function resultOf(row: { id: string; status: string; version: number }): ReallocationStepResult {
  return { proposalId: row.id, status: row.status, version: row.version };
}
