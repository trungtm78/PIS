import type { QmsAcceptanceLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface AcceptancePermissions {
  sign: string;
  approve: string;
  revoke: string;
}

/**
 * What the caller may do with the minutes as they stand: the command applies to their status and the caller holds the permission over the contract. Whoever drafted the minutes is not
 * offered the approval, and a person is offered the roles they could sign as and have not signed (the store knows who they are to the contract). A button is shown for exactly these; the
 * server judges each command again.
 */
export function acceptanceActionsOf(line: QmsAcceptanceLine, access: EffectiveAccess, now: Date, permissions: AcceptancePermissions): { actions: Record<'sign' | 'approve' | 'reject' | 'revoke', boolean>; signableRoles: string[] } {
  const refs = placeRefs(line.reach);
  const mayDecide = reaches(access, permissions.approve, refs, now);
  const signableRoles = reaches(access, permissions.sign, refs, now) ? line.viewerSignableRoles : [];
  return {
    actions: {
      sign: signableRoles.length > 0,
      approve: line.status === 'SIGNING' && mayDecide && line.createdBy.membershipId !== line.viewerMembershipId,
      reject: line.status === 'SIGNING' && mayDecide,
      revoke: line.status === 'APPROVED' && reaches(access, permissions.revoke, refs, now),
    },
    signableRoles,
  };
}

/** Minutes as openapi.json exposes them (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function acceptanceView(line: QmsAcceptanceLine, shown: ReturnType<typeof acceptanceActionsOf>): Record<string, unknown> {
  return {
    id: line.id,
    record_no: line.recordNo,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    inspection: { id: line.inspection.id, inspection_no: line.inspection.inspectionNo, inspection_type: line.inspection.inspectionType, title: line.inspection.title, result: line.inspection.result },
    boq_item: line.boqItem === null ? null : { id: line.boqItem.id, business_key: line.boqItem.businessKey, description: line.boqItem.description },
    acceptance_scope: line.acceptanceScope,
    document_version_id: line.documentVersionId,
    status: line.status,
    required_roles: line.requiredRoles,
    signatures: line.signatures.map((signature) => ({
      role: signature.role,
      membership_id: signature.membershipId,
      signer_name: signature.signerName,
      method: signature.method,
      legal_effect: signature.legalEffect,
      cert_serial: signature.certSerial,
      signed_at: signature.signedAt,
      valid: signature.valid,
    })),
    missing_roles: line.missingRoles,
    open_critical_ncr: line.openCriticalNcr,
    regime: { version_id: line.regime.versionId, label: line.regime.label, legal_basis: line.regime.legalBasis, awaiting_confirmation: line.regime.awaitingConfirmation, cxn: line.regime.cxn },
    decision_note: line.decisionNote,
    approved_at: line.approvedAt,
    approved_by: line.approvedBy === null ? null : { membership_id: line.approvedBy.membershipId, display_name: line.approvedBy.displayName },
    created_by: { membership_id: line.createdBy.membershipId, display_name: line.createdBy.displayName },
    revoke_reason: line.revokeReason,
    revoked_at: line.revokedAt,
    created_at: line.createdAt,
    signable_roles: shown.signableRoles,
    actions: shown.actions,
    version: line.version,
  };
}
