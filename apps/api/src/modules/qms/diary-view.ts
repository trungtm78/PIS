import type { QmsDiaryLine } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { placeRefs, reaches } from '../ctr/contract.controller';

export interface DiaryPermissions {
  write: string;
  contractorSign: string;
  supervise: string;
  ownerConfirm: string;
  lock: string;
  correct: string;
}

type Action = 'revise' | 'contractorSign' | 'supervise' | 'ownerConfirm' | 'lock' | 'correct';

/**
 * What the caller may do with the diary as it stands: the command applies to its status and the caller holds the permission over the contract; a role is offered only to someone on the side of the contract that signs
 * it, and not to someone who has signed already. A button is shown for exactly these; the server judges each command again.
 */
export function diaryActionsOf(line: QmsDiaryLine, access: EffectiveAccess, now: Date, permissions: DiaryPermissions): { actions: Record<Action, boolean>; signableRoles: string[] } {
  const refs = placeRefs(line.reach);
  const holds = (permission: string): boolean => reaches(access, permission, refs, now);
  const signable = (role: string, permission: string): boolean => holds(permission) && line.viewerSignableRoles.includes(role as never);
  return {
    actions: {
      revise: line.status === 'DRAFT' && holds(permissions.write),
      contractorSign: line.status === 'DRAFT' && signable('CONTRACTOR', permissions.contractorSign),
      supervise: line.status === 'CONTRACTOR_SIGNED' && signable('SUPERVISOR', permissions.supervise),
      ownerConfirm: line.status === 'SUPERVISED' && signable('OWNER', permissions.ownerConfirm),
      lock: (line.status === 'SUPERVISED' || line.status === 'OWNER_CONFIRMED') && holds(permissions.lock),
      correct: line.status === 'LOCKED' && holds(permissions.correct),
    },
    signableRoles: line.viewerSignableRoles.filter((role) => (role === 'CONTRACTOR' ? holds(permissions.contractorSign) : role === 'SUPERVISOR' ? holds(permissions.supervise) : role === 'OWNER' && holds(permissions.ownerConfirm))),
  };
}

/** The diary as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. */
export function diaryView(line: QmsDiaryLine, shown: ReturnType<typeof diaryActionsOf>): Record<string, unknown> {
  return {
    id: line.id,
    diary_no: line.diaryNo,
    contract: { id: line.contract.id, code: line.contract.code, status: line.contract.status },
    project_id: line.projectId,
    record_date: line.recordDate,
    status: line.status,
    content: line.content,
    content_hash: line.contentHash,
    weather_code: line.weatherCode,
    workforce_count: line.workforceCount,
    supervisor_remark: line.supervisorRemark,
    owner_note: line.ownerNote,
    lock_reason: line.lockReason,
    locked_at: line.lockedAt,
    correction_of_id: line.correctionOfId,
    correction_reason: line.correctionReason,
    author: { membership_id: line.author.membershipId, display_name: line.author.displayName },
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
    signature_value: { cxn: line.signatureValue.cxn, awaiting_confirmation: line.signatureValue.awaitingConfirmation },
    signable_roles: shown.signableRoles,
    actions: shown.actions,
    created_at: line.createdAt,
    updated_at: line.updatedAt,
    version: line.version,
  };
}
