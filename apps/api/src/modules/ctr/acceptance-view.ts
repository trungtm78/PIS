import type { CtrAcceptanceLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from './contract.controller';

export interface AcceptancePermissions {
  submit: string;
  decide: string;
  revoke: string;
}

/**
 * What the caller may do with the acceptance as it stands: the command applies to its status, the caller holds the permission over the contract, and the caller is not one of the people the
 * command must not come from (whoever drafted or sent an acceptance does not decide it; whoever sent or approved it does not revoke it). A button is shown for exactly these; the server
 * judges each command again.
 */
export function acceptanceActionsOf(line: CtrAcceptanceLine, access: EffectiveAccess, now: Date, permissions: AcceptancePermissions, viewer: string): Record<'submit' | 'decide' | 'revoke', boolean> {
  const refs = placeRefs(line.reach);
  const is = (person: string | null): boolean => person !== null && person.toLowerCase() === viewer.toLowerCase();
  return {
    submit: line.status === 'DRAFT' && reaches(access, permissions.submit, refs, now),
    decide: line.status === 'SUBMITTED' && reaches(access, permissions.decide, refs, now) && !is(line.submittedBy) && !is(line.createdBy),
    revoke: line.status === 'APPROVED' && reaches(access, permissions.revoke, refs, now) && !is(line.submittedBy) && !is(line.decidedBy),
  };
}

/** An acceptance as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function acceptanceView(line: CtrAcceptanceLine, actions: Record<'submit' | 'decide' | 'revoke', boolean>): Record<string, unknown> {
  return {
    id: line.id,
    acceptance_no: line.acceptanceNo,
    contract: {
      id: line.contract.id,
      code: line.contract.code,
      status: line.contract.status,
      requires_quality_acceptance: line.contract.requiresQualityAcceptance,
      contract_value_vnd: line.contract.contractValueVnd,
      accepted_total_vnd: line.contract.acceptedTotalVnd,
    },
    project_id: line.projectId,
    period: { id: line.period.id, code: line.period.code },
    document_version_id: line.documentVersionId,
    accepted_on: line.acceptedOn,
    status: line.status,
    accepted_amount_vnd: line.acceptedAmountVnd,
    lines: line.lines.map((entry) => ({
      id: entry.id,
      measurement_id: entry.measurementId,
      boq_item: { id: entry.boqItemId, business_key: entry.businessKey, description: entry.description, unit_code: entry.unitCode },
      party_id: entry.partyId,
      contract_revision_id: entry.contractRevisionId,
      quantity: entry.quantity,
      unit_price_snapshot: entry.unitPriceSnapshot,
      amount_vnd: entry.amountVnd,
      retention_pct_snapshot: entry.retentionPctSnapshot,
      active: entry.active,
      reference_no: entry.referenceNo,
    })),
    quality_acceptance: line.quality === null ? null : { id: line.quality.id, record_no: line.quality.recordNo, status: line.quality.status },
    open_critical_ncr: line.openCriticalNcr,
    signer_refs: line.signerRefs,
    submitted_by: line.submittedBy,
    submitted_at: line.submittedAt,
    decided_by: line.decidedBy,
    approved_at: line.approvedAt,
    decision_reason: line.decisionReason,
    revoke_reason: line.revokeReason,
    revoked_at: line.revokedAt,
    created_by: line.createdBy,
    created_at: line.createdAt,
    actions,
    version: line.version,
  };
}
