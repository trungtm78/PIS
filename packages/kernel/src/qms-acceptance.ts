import { DomainError } from './errors.ts';
import type { InspectionType, SignerRole } from './qms-inspection.ts';

/**
 * The quality acceptance minutes of an inspection (ST-QMS-005, QMS 3.2, BR-QMS-02, BR-QMS-03 and BR-QMS-05): minutes are drafted from an inspection that passed, signed by each role the
 * regime of the day requires over one hash of what they say, and approved by someone other than whoever drafted them once every required role has signed.
 */
export const ACCEPTANCE_SCOPES = ['WORK_ITEM', 'STAGE', 'PART', 'COMPLETION'] as const;
export type AcceptanceScope = (typeof ACCEPTANCE_SCOPES)[number];

export const ACCEPTANCE_STATUSES = ['DRAFT', 'SIGNING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export const SIGNATURE_METHODS = ['IN_APP_OTP', 'IN_APP_WEBAUTHN', 'DIGITAL_CERT'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/** The kinds of inspection that minutes of each scope can be drafted from: the scope says how much of the work the minutes accept, and the kind of inspection says how much was inspected. */
const SCOPE_INSPECTIONS: Readonly<Record<AcceptanceScope, readonly InspectionType[]>> = {
  WORK_ITEM: ['MATERIAL_ENTRY', 'CONCEALED_WORK', 'SAFETY', 'OTHER'],
  STAGE: ['CONSTRUCTION_STAGE'],
  PART: ['PART_ACCEPTANCE'],
  COMPLETION: ['COMPLETION'],
};

export const scopeAccepts = (scope: AcceptanceScope, inspection: InspectionType): boolean => SCOPE_INSPECTIONS[scope].includes(inspection);

export const ACCEPTANCE_COMMANDS = ['sign', 'approve', 'reject', 'revoke'] as const;
export type AcceptanceCommand = (typeof ACCEPTANCE_COMMANDS)[number];

const TRANSITIONS: Readonly<Record<AcceptanceCommand, { from: readonly AcceptanceStatus[]; to: AcceptanceStatus }>> = {
  sign: { from: ['DRAFT', 'SIGNING'], to: 'SIGNING' },
  approve: { from: ['SIGNING'], to: 'APPROVED' },
  reject: { from: ['SIGNING'], to: 'REJECTED' },
  revoke: { from: ['APPROVED'], to: 'REVOKED' },
};

/** 409 `QUALITY_ACCEPTANCE_STATE_INVALID` (with the status) unless the command applies to the status; otherwise the status the command leads to. */
export function assertAcceptanceTransition(command: AcceptanceCommand, status: AcceptanceStatus): AcceptanceStatus {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(status)) throw new DomainError('QUALITY_ACCEPTANCE_STATE_INVALID', 409, 'status', { extensions: { acceptance_status: status } });
  return rule.to;
}

/** What a signature is worth (BR-QMS-03): an in-app confirmation is an internal record; only a certificate gives a legal electronic signature. */
export const legalEffectOf = (method: SignatureMethod): 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE' => (method === 'DIGITAL_CERT' ? 'LEGAL_E_SIGNATURE' : 'INTERNAL_RECORD');

/**
 * The roles that have not signed yet, in the order the minutes require them. A role counts as signed only by a signature over the hash the minutes carry now: a signature over other
 * content is void (BR-QMS-02).
 */
export function missingSigners(required: readonly SignerRole[], signatures: ReadonlyArray<{ role: string; contentHash: string }>, contentHash: string): SignerRole[] {
  const signed = new Set(signatures.filter((signature) => signature.contentHash === contentHash).map((signature) => signature.role));
  return required.filter((role) => !signed.has(role));
}

/** 422 `SIGNATURES_INCOMPLETE` naming the roles that have not signed, unless every required role has. */
export function assertSignaturesComplete(required: readonly SignerRole[], signatures: ReadonlyArray<{ role: string; contentHash: string }>, contentHash: string): void {
  const missing = missingSigners(required, signatures, contentHash);
  if (missing.length > 0) throw new DomainError('SIGNATURES_INCOMPLETE', 422, 'signatures', { extensions: { missing_roles: missing } });
}

/** What the signers sign: the facts of the minutes in a fixed order, so that the same minutes always give the same text (BR-QMS-02: sorted keys, numbers as strings). */
export interface AcceptanceContent {
  acceptanceId: string;
  contractId: string;
  inspectionId: string;
  recordNo: string;
  acceptanceScope: AcceptanceScope;
  documentVersionId: string;
  requiredRoles: readonly SignerRole[];
  inspectionResult: string;
  checklist: ReadonlyArray<{ code: string; outcome?: string | undefined; note?: string | undefined }>;
}

export function canonicalContent(content: AcceptanceContent): string {
  return JSON.stringify({
    acceptance_id: content.acceptanceId,
    acceptance_scope: content.acceptanceScope,
    checklist: [...content.checklist].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((item) => ({ code: item.code, note: item.note ?? null, outcome: item.outcome ?? null })),
    contract_id: content.contractId,
    document_version_id: content.documentVersionId,
    inspection_id: content.inspectionId,
    inspection_result: content.inspectionResult,
    record_no: content.recordNo,
    required_roles: [...content.requiredRoles].sort(),
  });
}

/** Who a person is to the contract: a member of the staff, or a guest of one of the contractors. */
export type SignerStanding = { kind: 'STAFF' } | { kind: 'GUEST_CONTRACTOR'; contractorId: string };

/**
 * The roles a person may sign minutes as. The contractor signs for the contractor: a guest of the contractor of the contract (or of a member of its joint venture) signs as `CONTRACTOR`
 * and as nothing else. Everyone else signs as one of the roles on the side of the procuring entity (`SUPERVISOR`, `OWNER`, `DESIGNER`); a guest of another firm signs as none, so that nobody
 * signs for the other side.
 */
export function rolesSignableBy(standing: SignerStanding, contractContractorIds: readonly string[]): SignerRole[] {
  if (standing.kind === 'STAFF') return ['SUPERVISOR', 'OWNER', 'DESIGNER'];
  return contractContractorIds.includes(standing.contractorId) ? ['CONTRACTOR'] : [];
}
