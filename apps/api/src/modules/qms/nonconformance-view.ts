import type { NcrLine } from '@machvon/db';
import { canAssignAction, canSubmitEvidence, canVerify } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface NonconformancePermissions {
  manage: string;
  respond: string;
  verify: string;
  close: string;
}

export interface Allowed {
  assign: boolean;
  respond: boolean;
  verify: boolean;
  close: boolean;
  reopen: boolean;
}

const sameMember = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * What the caller may do with the non-conformance as it stands: the command applies to its status, the caller holds the permission over the contract and, where the rule asks for independence,
 * is none of the people who put it right. A button is shown for exactly these; the server judges each command again.
 */
export function nonconformanceAllowed(line: NcrLine, access: EffectiveAccess, actor: string, now: Date, permissions: NonconformancePermissions): Allowed {
  const refs = placeRefs(line.reach);
  const open = line.status !== 'CLOSED';
  const involved = [line.actionOwner.membershipId, ...line.actions.map((action) => action.owner.membershipId)];
  return {
    assign: canAssignAction(line.status) && reaches(access, permissions.manage, refs, now),
    respond: open && reaches(access, permissions.respond, refs, now) && line.actions.some((action) => canSubmitEvidence(action.status) && sameMember(action.owner.membershipId, actor)),
    verify:
      open &&
      reaches(access, permissions.verify, refs, now) &&
      line.actions.some((action) => canVerify(action.status) && !sameMember(action.owner.membershipId, actor)) &&
      !sameMember(line.actionOwner.membershipId, actor),
    close: line.status === 'VERIFIED' && reaches(access, permissions.close, refs, now) && !involved.some((member) => sameMember(member, actor)),
    reopen: line.status === 'CLOSED' && reaches(access, permissions.close, refs, now),
  };
}

/** A non-conformance as openapi.json exposes it (x-exposure dto): an allowlist; the root cause is the supervisor's analysis and is not shown to a guest contractor. */
export function nonconformanceView(line: NcrLine, allowed: Allowed, shown: { rootCause: boolean }): Record<string, unknown> {
  return {
    id: line.id,
    ncr_no: line.ncrNo,
    title: line.title,
    description: line.description,
    severity: line.severity,
    source_kind: line.sourceKind,
    status: line.status,
    blocks_acceptance: line.blocksAcceptance,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    inspection_id: line.inspectionId,
    material_test_id: line.materialTestId,
    site_diary_id: line.siteDiaryId,
    measurement_id: line.measurementId,
    detected_on: line.detectedOn,
    due_at: line.dueAt,
    overdue: line.overdue,
    action_owner: { membership_id: line.actionOwner.membershipId, display_name: line.actionOwner.displayName },
    root_cause: shown.rootCause ? line.rootCause : null,
    closure_note: line.closureNote,
    reopen_reason: line.reopenReason,
    reopen_count: line.reopenCount,
    verified_by: line.verifiedBy,
    verified_at: line.verifiedAt,
    closed_by: line.closedBy,
    closed_at: line.closedAt,
    actions: line.actions.map((action) => ({
      id: action.id,
      description: action.description,
      owner: { membership_id: action.owner.membershipId, display_name: action.owner.displayName },
      due_at: action.dueAt,
      overdue: action.overdue,
      status: action.status,
      evidence_document_version_id: action.evidenceDocumentVersionId,
      evidence_photo_id: action.evidencePhotoId,
      evidence_note: action.evidenceNote,
      submitted_at: action.submittedAt,
      verified_by: action.verifiedBy,
      verified_at: action.verifiedAt,
      verification_note: action.verificationNote,
      version: action.version,
    })),
    created_at: line.createdAt,
    allowed,
    version: line.version,
  };
}
