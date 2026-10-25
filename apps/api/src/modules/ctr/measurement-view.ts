import type { CtrMeasurementLine } from '@machvon/db';
import { CHANGEABLE_CONTRACT_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from './contract.controller';

export interface MeasurementPermissions {
  submit: string;
  decide: string;
  correct: string;
}

/** The statuses of a contract in which a quantity is sent and corrected: the work is being performed (a suspended contract still corrects what was measured). */
const SUBMITTING_CONTRACT_STATUSES: readonly string[] = ['ACTIVE'];

/**
 * What the caller may do with the measurement as it stands: the command applies to its status, the contract is in a status that takes it, the caller holds the permission over the contract
 * and, for the decision, is neither the one who recorded the quantity nor the one who sent it. A button is shown for exactly these; the server judges each command again.
 */
export function measurementActionsOf(line: CtrMeasurementLine, access: EffectiveAccess, now: Date, permissions: MeasurementPermissions, caller: string): Record<'submit' | 'decide' | 'correct', boolean> {
  const refs = placeRefs(line.reach);
  const me = caller.toLowerCase();
  return {
    submit: line.status === 'DRAFT' && SUBMITTING_CONTRACT_STATUSES.includes(line.contract.status) && reaches(access, permissions.submit, refs, now),
    decide: line.status === 'SUBMITTED' && reaches(access, permissions.decide, refs, now) && line.createdBy.toLowerCase() !== me && line.submittedBy?.toLowerCase() !== me,
    correct: line.status === 'APPROVED' && CHANGEABLE_CONTRACT_STATUSES.includes(line.contract.status) && reaches(access, permissions.correct, refs, now),
  };
}

/** A measurement as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function measurementView(line: CtrMeasurementLine, actions: Record<'submit' | 'decide' | 'correct', boolean>): Record<string, unknown> {
  return {
    id: line.id,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    contract_revision_id: line.contractRevisionId,
    contract_revision_no: line.contractRevisionNo,
    boq_line_id: line.boqLineId,
    boq_item: { id: line.boqItem.id, business_key: line.boqItem.businessKey, description: line.boqItem.description, unit_code: line.boqItem.unitCode },
    boq_quantity: line.boqQuantity,
    remaining_quantity: line.remainingQuantity,
    party_id: line.partyId,
    period: { id: line.period.id, code: line.period.code },
    quantity_period: line.quantityPeriod,
    quantity_cumulative: line.quantityCumulative,
    revision: line.revision,
    status: line.status,
    evidence_refs: line.evidenceRefs,
    reference_no: line.referenceNo,
    duplicate_override_reason: line.duplicateOverrideReason,
    correction_of_id: line.correctionOfId,
    correction_reason: line.correctionReason,
    inspection_id: line.inspectionId,
    created_by: line.createdBy,
    created_at: line.createdAt,
    submitted_by: line.submittedBy,
    submitted_at: line.submittedAt,
    decided_by: line.decidedBy,
    decided_at: line.decidedAt,
    actions,
    version: line.version,
  };
}
