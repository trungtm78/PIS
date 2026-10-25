import type { HandoverLine, HandoverPlace, HandoverTrace, PunchLine } from '@machvon/db';
import { assertPunchVerifier, assertPunchWaiver } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef } from '@machvon/kernel';
import { refsOf, reaches } from '../ctr/contract.controller';

export interface HandoverPermissions {
  manage: string;
  respond: string;
  verify: string;
  waive: string;
  approve: string;
}

/** The places a handover lies in for the permission test: the contract (the units that own and invest in its project, the project, the contract) and the unit that receives the work. */
export function handoverRefs(place: HandoverPlace): ResourceRef[] {
  return [...refsOf(place, place.projectId, place.contractId), ...refsOf({ ownerUnit: place.recipientUnit, investorUnit: null }, place.projectId, place.contractId)];
}

const sameMember = (left: string, right: string | null): boolean => right !== null && left.toLowerCase() === right.toLowerCase();

const refused = (check: () => void): boolean => {
  try {
    check();
    return false;
  } catch {
    return true;
  }
};

export interface CallerFacts {
  /** The membership of the caller. */
  membershipId: string;
  /** The contractor the caller is a guest of; undefined for the staff. */
  contractorId: string | undefined;
}

const handoverOpen = (status: HandoverLine['status']): boolean => status === 'DRAFT' || status === 'INSPECTING' || status === 'PUNCH_PENDING';

/**
 * What the caller may do with the handover as it stands: the command applies to its status, the caller holds the permission over the contract or the receiving unit and, where the rule asks
 * for independence, is none of the people the rule names. A button is shown for exactly these; the server judges each command again.
 */
export function handoverAllowed(
  line: HandoverLine,
  access: EffectiveAccess,
  now: Date,
  caller: CallerFacts,
  permissions: HandoverPermissions,
): Record<'add_item' | 'approve' | 'return' | 'reject', boolean> {
  const refs = handoverRefs(line.reach);
  const open = handoverOpen(line.status);
  const decides = open && reaches(access, permissions.approve, refs, now);
  return {
    add_item: open && reaches(access, permissions.manage, refs, now),
    approve: decides && !sameMember(caller.membershipId, line.createdBy),
    return: decides && (line.status === 'INSPECTING' || line.status === 'PUNCH_PENDING'),
    reject: decides,
  };
}

/** What the caller may do with one item of the punch list. */
export function punchAllowed(
  line: HandoverLine,
  item: PunchLine,
  access: EffectiveAccess,
  now: Date,
  caller: CallerFacts,
  permissions: HandoverPermissions,
): Record<'fix' | 'verify' | 'waive', boolean> {
  const refs = handoverRefs(line.reach);
  const open = handoverOpen(line.status);
  const answers = caller.contractorId === undefined || item.responsibleContractorId === null || caller.contractorId === item.responsibleContractorId;
  return {
    fix: open && item.status === 'OPEN' && answers && reaches(access, permissions.respond, refs, now),
    verify: open && item.status === 'FIXED' && reaches(access, permissions.verify, refs, now) && !refused(() => assertPunchVerifier(caller.membershipId, item.fixedBy)),
    waive:
      open &&
      (item.status === 'OPEN' || item.status === 'FIXED') &&
      item.severity !== 'CRITICAL' &&
      reaches(access, permissions.waive, refs, now) &&
      !refused(() => assertPunchWaiver(caller.membershipId, item.createdBy)),
  };
}

/** A handover as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function handoverView(line: HandoverLine, allowed: Record<string, boolean>): Record<string, unknown> {
  return {
    id: line.id,
    handover_no: line.handoverNo,
    handover_kind: line.handoverKind,
    status: line.status,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    recipient_unit: { id: line.recipientUnit.id, code: line.recipientUnit.code, name: line.recipientUnit.name },
    quality_acceptance_id: line.qualityAcceptanceId,
    planned_on: line.plannedOn,
    handed_on: line.handedOn,
    accepted_at: line.acceptedAt,
    accepted_by: line.acceptedBy,
    rejection_reason: line.rejectionReason,
    decision_note: line.decisionNote,
    open_critical_punch_count: line.openCriticalPunchCount,
    punch_item_count: line.punchItemCount,
    document_version_id: line.documentVersionId,
    as_built_document_version_id: line.asBuiltDocumentVersionId,
    om_manual_document_version_id: line.omManualDocumentVersionId,
    warranty_certificate_document_version_id: line.warrantyCertificateDocumentVersionId,
    created_at: line.createdAt,
    allowed,
    version: line.version,
  };
}

export function punchView(item: PunchLine, allowed: Record<string, boolean>): Record<string, unknown> {
  return {
    id: item.id,
    item_no: item.itemNo,
    description: item.description,
    severity: item.severity,
    location_text: item.locationText,
    responsible_contractor: item.responsibleContractorId === null ? null : { id: item.responsibleContractorId, name: item.responsibleContractorName ?? '' },
    due_on: item.dueOn,
    overdue: item.overdue,
    status: item.status,
    defect_photo_id: item.defectPhotoId,
    evidence_photo_id: item.evidencePhotoId,
    evidence_document_version_id: item.evidenceDocumentVersionId,
    fixed_by: item.fixedBy,
    fixed_at: item.fixedAt,
    fixed_note: item.fixedNote,
    verified_by: item.verifiedBy,
    verified_at: item.verifiedAt,
    verification_note: item.verificationNote,
    waiver_reason: item.waiverReason,
    waiver_approved_by: item.waiverApprovedBy,
    reopen_count: item.reopenCount,
    allowed,
    version: item.version,
  };
}

/** The trace of a handover (UAT-AC65): the handover, its punch list, the assets it produced, its minutes and the unit that receives it. */
export function traceView(trace: HandoverTrace, allowed: Record<string, boolean>, items: Array<Record<string, unknown>>, asOf: Date): Record<string, unknown> {
  return {
    handover: handoverView(trace.handover, allowed),
    receiving_unit: { id: trace.handover.recipientUnit.id, code: trace.handover.recipientUnit.code, name: trace.handover.recipientUnit.name },
    items,
    assets: trace.assets.map((asset) => ({
      id: asset.id,
      asset_code: asset.assetCode,
      name: asset.name,
      value_vnd: asset.valueVnd,
      status: asset.status,
      recipient_unit_id: asset.recipientUnitId,
      external_asset_id: asset.externalAssetId,
    })),
    documents: trace.documents.map((document) => ({ role: document.role, document_version_id: document.documentVersionId })),
    quality_acceptance:
      trace.qualityAcceptance === null
        ? null
        : { id: trace.qualityAcceptance.id, record_no: trace.qualityAcceptance.recordNo, scope: trace.qualityAcceptance.scope, status: trace.qualityAcceptance.status },
    as_of: asOf.toISOString(),
  };
}
