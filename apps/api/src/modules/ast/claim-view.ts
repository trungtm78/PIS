import type { ClaimLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { reaches } from '../ctr/contract.controller';
import { handoverRefs } from './handover-view';

/** Who is reading: the member, and the contractor it belongs to when it is a guest contractor (undefined for any other member). */
export interface ClaimCaller {
  memberId: string;
  guestContractorId: string | null | undefined;
}

export interface ClaimPermissions {
  claim: string;
  respond: string;
  verify: string;
}

/**
 * What the caller may do with the claim as it stands: the contractor acknowledges an open claim and says a claim is put right (again after a dispute); somebody who neither reported the defect nor said it was put
 * right verifies a fixed claim. Each needs the right over the contract or the receiving unit; the server judges every command again.
 */
export function claimAllowed(
  line: ClaimLine,
  access: EffectiveAccess,
  caller: ClaimCaller,
  now: Date,
  permissions: ClaimPermissions,
): { acknowledge: boolean; fix: boolean; verify: boolean } {
  const refs = handoverRefs(line.reach);
  // A contractor member answers for the claims addressed to its own contractor and for no other, as the commands judge it.
  const own = caller.guestContractorId === undefined || line.responder === null || caller.guestContractorId === line.responder.id;
  const responds = own && reaches(access, permissions.respond, refs, now);
  const memberId = caller.memberId;
  const who = memberId.toLowerCase();
  const involved = line.reportedBy.toLowerCase() === who || line.fixedBy?.toLowerCase() === who;
  return {
    acknowledge: line.status === 'OPEN' && responds,
    fix: (line.status === 'ACKNOWLEDGED' || line.status === 'REPAIRING' || line.status === 'DISPUTED') && responds,
    verify: line.status === 'FIXED' && !involved && reaches(access, permissions.verify, refs, now),
  };
}

/** A claim as openapi.json exposes it (x-exposure dto): an allowlist. `overdue` is the lateness of the answer on the day; the members who reported and fixed are not named, only what the caller may do. */
export function claimView(line: ClaimLine, access: EffectiveAccess, caller: ClaimCaller, now: Date, permissions: ClaimPermissions): Record<string, unknown> {
  return {
    id: line.id,
    claim_no: line.claimNo,
    obligation: { id: line.obligation.id, ends_on: line.obligation.endsOn, status: line.obligation.status },
    contract: { id: line.contract.id, code: line.contract.code },
    handover: { id: line.handover.id, handover_no: line.handover.handoverNo },
    project_id: line.projectId,
    severity: line.severity,
    defect_description: line.defectDescription,
    location_text: line.locationText,
    responder: line.responder === null ? null : { id: line.responder.id, name: line.responder.name },
    reported_on: line.reportedOn,
    response_due_on: line.responseDueOn,
    committed_fix_on: line.committedFixOn,
    fixed_on: line.fixedOn,
    evidence_photo_id: line.evidencePhotoId,
    evidence_document_version_id: line.evidenceDocumentVersionId,
    fix_evidence_photo_id: line.fixEvidencePhotoId,
    fix_evidence_document_version_id: line.fixEvidenceDocumentVersionId,
    fix_note: line.fixNote,
    verification_note: line.verificationNote,
    cost_borne_by: line.costBorneBy,
    status: line.status,
    overdue: line.overdue,
    issue: line.issue === null ? null : { id: line.issue.id, code: line.issue.code },
    created_at: line.createdAt,
    allowed: claimAllowed(line, access, caller, now, permissions),
    version: line.version,
  };
}
