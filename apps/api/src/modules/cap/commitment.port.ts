import { Injectable } from '@nestjs/common';
import { CapAvailabilityStore } from '@machvon/db';
import type { CommitInput, CommitResult } from '@machvon/db';
import type { CommandScope } from '../../command-scope';

const COMMITMENT_EVENT = 'capital.commitment_posted.v1';
const RESOURCE_TYPE = 'allocation_line';

/**
 * The port through which the modules that spend capital (the activation of a contract, ST-CTR-004, and later the payment) commit it against the availability policy (ST-CAP-005,
 * BR-CAP-06). It runs in the transaction of the caller's command: the availability is judged and the balance moves with its ledger entry under the row lock of the line, the audit
 * row and `capital.commitment_posted.v1` are written with them, and a refusal (AVC_BLOCKED, AVC_WARNING_ACK_REQUIRED) leaves nothing behind. Asking again for a fact that was
 * posted answers what was done and writes nothing more.
 */
@Injectable()
export class CapitalCommitments {
  private readonly availability = new CapAvailabilityStore();

  /** Whether the line can take the amount under its availability policy (the evaluation of a change that adds to a contract asks it); nothing is committed, and a refusal is 422 `ALLOCATION_UNAVAILABLE`. */
  assertCanAbsorb(scope: CommandScope, allocationLineId: string, amountVnd: string): Promise<void> {
    return this.availability.assertCanAbsorb(scope.tx, allocationLineId, amountVnd);
  }

  async checkAndCommit(scope: CommandScope, input: CommitInput, now: Date = new Date()): Promise<CommitResult> {
    const result = await this.availability.checkAndCommit(scope.tx, input, scope.tenant.membershipId);
    if (result.replayed) return result;
    await scope.audit({
      action: 'capital.commitment_posted',
      resourceType: RESOURCE_TYPE,
      resourceId: result.allocationLineId,
      diff: {
        amount_vnd: result.amountVnd,
        source_ref_kind: input.sourceKind,
        source_ref_id: input.sourceId,
        avc_state: result.line.state,
        consumption_pct: result.line.consumptionPct,
        avc_policy_id: result.policyId,
        warning_acknowledged: result.warningAcknowledged,
        ledger_entry_id: result.entryId,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: result.allocationLineId,
      aggregateVersion: Number(result.balanceVersion ?? 0),
      type: COMMITMENT_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        allocation_line_id: result.allocationLineId,
        appropriation_id: result.appropriationId,
        project_id: result.projectId,
        plan_year: result.planYear,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        amount_vnd: result.amountVnd,
        source_ref_kind: input.sourceKind,
        source_ref_id: input.sourceId,
        ledger_entry_id: result.entryId,
        avc_state: result.line.state,
        consumption_pct: result.line.consumptionPct,
        avc_policy_id: result.policyId,
        warning_acknowledged: result.warningAcknowledged,
      },
      // One fact, one event: the same business fact posted twice emits once.
      eventKey: `${RESOURCE_TYPE}:${result.allocationLineId}:commit:${input.sourceKind}:${input.sourceId}`,
    });
    return result;
  }
}
