import { DomainError } from './errors.ts';

/**
 * Access of a contractor to the portal through the contractor registry (PORTAL-2; docs/plans/portal2.md). ADM-17 invites a guest through contracts; a contractor with no contract had no way in. An invitation here is bound to
 * the REGISTRY ENTRY: one person proposes a contact of the contractor with the proof that the contact is the contractor's, a different person approves, the proposal and the access expire, and a revocation ends the access at
 * once. Pure rules only; the store keeps the rows and the controller creates the invited guest.
 */

export const PORTAL_INVITATION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED'] as const;
export type PortalInvitationStatus = (typeof PORTAL_INVITATION_STATUSES)[number];
export const PORTAL_INVITATION_MOVES = ['APPROVE', 'REJECT', 'REVOKE', 'EXPIRE'] as const;
export type PortalInvitationMove = (typeof PORTAL_INVITATION_MOVES)[number];

/** The proof that a contact is the contractor's. REGISTRY_EMAIL is checked by the server against the e-mail on the registry entry; the others name a paper (a letter number, a record number) that the approver can look at. */
export const CONTACT_BASES = ['REGISTRY_EMAIL', 'REPRESENTATIVE_LETTER', 'TAX_AUTHORITY_RECORD', 'OTHER_EVIDENCE'] as const;
export type ContactBasis = (typeof CONTACT_BASES)[number];

/** Rule `VENDOR_PORTAL_ACCESS`: how long a proposal waits, how long an approved access lasts, how many live accounts one contractor may have, the largest file of a portal upload. */
export interface PortalAccessPolicy {
  proposal_days: number;
  access_days: number;
  max_live_accounts: number;
  max_upload_bytes: number;
}

export const PORTAL_ACCESS_DEFAULTS: PortalAccessPolicy = { proposal_days: 7, access_days: 365, max_live_accounts: 3, max_upload_bytes: 10 * 1024 * 1024 };

export function portalAccessPolicyOf(params: unknown): PortalAccessPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const record = params as Record<string, unknown>;
  const whole = (field: keyof PortalAccessPolicy, min: number, max: number): number => {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  return {
    proposal_days: whole('proposal_days', 1, 60),
    access_days: whole('access_days', 30, 730),
    max_live_accounts: whole('max_live_accounts', 1, 20),
    max_upload_bytes: whole('max_upload_bytes', 100 * 1024, 10 * 1024 * 1024),
  };
}

const STEPS: Readonly<Record<PortalInvitationMove, { from: readonly PortalInvitationStatus[]; to: PortalInvitationStatus; reason: boolean }>> = {
  APPROVE: { from: ['PROPOSED'], to: 'APPROVED', reason: false },
  REJECT: { from: ['PROPOSED'], to: 'REJECTED', reason: true },
  REVOKE: { from: ['PROPOSED', 'APPROVED'], to: 'REVOKED', reason: true },
  EXPIRE: { from: ['PROPOSED', 'APPROVED'], to: 'EXPIRED', reason: false },
};

/** The status after a move; 409 `PORTAL_INVITATION_STATE_INVALID` from the wrong status, 422 for a missing reason (at least 5 characters). */
export function nextInvitationStatus(current: PortalInvitationStatus, move: PortalInvitationMove, reason?: string | null): PortalInvitationStatus {
  const step = STEPS[move];
  if (!step.from.includes(current)) throw new DomainError('PORTAL_INVITATION_STATE_INVALID', 409, 'status', { extensions: { invitation_status: current } });
  if (step.reason && (reason === undefined || reason === null || reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return step.to;
}

/** The person who approves is never the person who proposed (403 `SCOPE_DENIED`: the two-person rule). */
export function assertSecondPerson(proposedBy: string, decidedBy: string): void {
  if (proposedBy.toLowerCase() === decidedBy.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403, 'decided_by');
}

/** What a reader sees: the stored status, except that a proposal past its expiry or an access past its end reads as EXPIRED even before the nightly job writes it. */
export function effectiveInvitationStatus(input: { status: PortalInvitationStatus; proposalExpiresAt: string; accessValidUntil: string | null; now: Date }): PortalInvitationStatus {
  if (input.status === 'PROPOSED' && new Date(input.proposalExpiresAt).getTime() <= input.now.getTime()) return 'EXPIRED';
  if (input.status === 'APPROVED' && input.accessValidUntil !== null && new Date(input.accessValidUntil).getTime() <= input.now.getTime()) return 'EXPIRED';
  return input.status;
}

const DAY_MS = 86_400_000;
export const plusDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The address as it is kept: trimmed, lower case; 422 `VALIDATION_FAILED` on `contact_email` when it is not an address. */
export function normaliseContactEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL.test(email)) throw new DomainError('VALIDATION_FAILED', 422, 'contact_email');
  return email;
}

/**
 * Whether the proof of the contact stands. REGISTRY_EMAIL: the address equals the e-mail on the registry entry (422 `PORTAL_CONTACT_UNPROVEN` when the entry has none or another one) and carries no reference. The other
 * bases need a reference of at least 6 characters that the approver reads; a reference with REGISTRY_EMAIL, or none with another basis, is 422 `VALIDATION_FAILED`.
 */
export function assertContactProof(input: { basis: string; reference: string | null | undefined; email: string; registryEmail: string | null }): { basis: ContactBasis; reference: string | null } {
  const basis = CONTACT_BASES.find((candidate) => candidate === input.basis);
  if (basis === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contact_basis');
  const reference = input.reference === undefined || input.reference === null || input.reference.trim() === '' ? null : input.reference.trim();
  if (basis === 'REGISTRY_EMAIL') {
    if (reference !== null) throw new DomainError('VALIDATION_FAILED', 422, 'basis_reference');
    if (input.registryEmail === null || input.registryEmail.trim().toLowerCase() !== input.email) throw new DomainError('PORTAL_CONTACT_UNPROVEN', 422, 'contact_email');
    return { basis, reference: null };
  }
  if (reference === null || reference.length < 6 || reference.length > 300) throw new DomainError('VALIDATION_FAILED', 422, 'basis_reference');
  return { basis, reference };
}

/** A contractor can be invited only while its registry entry is verified: the contact of an unverified entry proves nothing (422 `CONTRACTOR_NOT_INVITABLE`). */
export function assertInvitable(input: { verificationStatus: string; restricted: boolean }): void {
  if (input.verificationStatus !== 'VERIFIED' || input.restricted) throw new DomainError('CONTRACTOR_NOT_INVITABLE', 422, 'contractor_id', { extensions: { verification_status: input.verificationStatus, restricted: input.restricted } });
}

// -- The limits of a portal upload ----------------------------------------------------------------------------------------------------------------------------------------------------------

export const PORTAL_UPLOAD_PURPOSES = ['REQUEST_RESPONSE', 'CERTIFICATE', 'REMEDIATION_EVIDENCE', 'OTHER'] as const;
export type PortalUploadPurpose = (typeof PORTAL_UPLOAD_PURPOSES)[number];
export const PORTAL_UPLOAD_MIMES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

/** What the scan hook can answer. UNAVAILABLE (no scanner, a failure, a timeout) is a refusal: a portal upload is never accepted unscanned. */
export type PortalScanVerdict = 'CLEAN' | 'INFECTED' | 'UNAVAILABLE';

/** The refusal for a verdict that is not CLEAN: 422 `FILE_NOT_CLEAN` for an infected file, 409 `SCAN_PENDING` when no scan could be made (fail closed). */
export function assertScanClean(verdict: PortalScanVerdict): void {
  if (verdict === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
  if (verdict !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
}

/** 413 `PAYLOAD_TOO_LARGE` over the limit of the rule, 422 `VALIDATION_FAILED` for a purpose that is not one of the four. */
export function assertPortalUpload(input: { purpose: string; sizeBytes: number; maxBytes: number }): PortalUploadPurpose {
  const purpose = PORTAL_UPLOAD_PURPOSES.find((candidate) => candidate === input.purpose);
  if (purpose === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'purpose');
  if (input.sizeBytes <= 0) throw new DomainError('VALIDATION_FAILED', 422, 'file');
  if (input.sizeBytes > input.maxBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
  return purpose;
}
