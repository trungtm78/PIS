import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { displayNameOf } from './omni-channel.ts';

/**
 * The contact directory (ST-OMNI-002, OMNI.md 3.5, BR-OMNI-05): a contact is a person outside the tenant that talks to it, known by identities (a phone number, an e-mail address, a Zalo or WhatsApp id). An identity is kept as the hash of its
 * normalised form and a masked copy, is verified by a code, by the provider that authenticates the sender, or by a document, and two contacts are merged only on a verified identity they share; never by name. The rules below are pure.
 *
 *   contact: Unverified -(an identity is verified)-> Verified -merge-> Merged          identity: Pending -verify-> Verified
 */
export const CONTACT_CLASSIFICATIONS = ['CITIZEN', 'CONTRACTOR_STAFF', 'AGENCY_STAFF', 'OTHER'] as const;
export type ContactClassification = (typeof CONTACT_CLASSIFICATIONS)[number];
export const IDENTITY_CHANNELS = ['PHONE', 'EMAIL', 'ZALO', 'WHATSAPP'] as const;
export type IdentityChannel = (typeof IDENTITY_CHANNELS)[number];
export const VERIFICATION_METHODS = ['OTP', 'PROVIDER_VERIFIED', 'ADMIN_DOCUMENT'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** The channels a code can be sent on. */
export const OTP_CHANNELS: ReadonlySet<string> = new Set(['PHONE', 'EMAIL']);

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_FAILURES = 5;
export const OTP_LOCK_MS = 30 * 60_000;
export const DOCUMENT_REF_MAX = 200;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export const isIdentityChannel = (value: unknown): value is IdentityChannel => typeof value === 'string' && (IDENTITY_CHANNELS as readonly string[]).includes(value);

export interface ContactDraft {
  displayName: string;
  classification: ContactClassification;
  preferredChannel: IdentityChannel | undefined;
}

/** What a new contact may carry: a name, one of the classes, and the channel the person likes best, if said. */
export function assertContactDraft(raw: { display_name?: unknown; classification?: unknown; preferred_channel?: unknown }): ContactDraft {
  const displayName = displayNameOf(raw.display_name);
  const classification = CONTACT_CLASSIFICATIONS.find((candidate) => candidate === raw.classification);
  if (classification === undefined) throw invalid('classification');
  let preferredChannel: IdentityChannel | undefined;
  if (raw.preferred_channel !== undefined) {
    if (!isIdentityChannel(raw.preferred_channel)) throw invalid('preferred_channel');
    preferredChannel = raw.preferred_channel;
  }
  return { displayName, classification, preferredChannel };
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A phone number as the digits of E.164 with its plus: a number with the leading zero of Vietnam, or the country code without the plus, is that number. */
function normalisePhone(value: string): string | undefined {
  const compact = value.replace(/[\s().-]/g, '');
  const international = compact.startsWith('+') ? compact : compact.startsWith('00') ? `+${compact.slice(2)}` : compact.startsWith('0') ? `+84${compact.slice(1)}` : compact.startsWith('84') ? `+${compact}` : undefined;
  return international !== undefined && E164.test(international) ? international : undefined;
}

/** The identity in the one form it is compared in, or a 422 on the field `external_id`. */
export function normaliseIdentity(channel: IdentityChannel, raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('external_id');
  const value = raw.normalize('NFC').trim();
  let normalised: string | undefined;
  if (channel === 'PHONE' || channel === 'WHATSAPP') normalised = normalisePhone(value);
  else if (channel === 'EMAIL') normalised = EMAIL.test(value.toLowerCase()) && value.length <= 200 ? value.toLowerCase() : undefined;
  else normalised = CHANNEL_ID.test(value) ? value : undefined;
  if (normalised === undefined) throw invalid('external_id');
  return normalised;
}

/** sha256 of the normalised identity: the same phone number is the same hash on the phone and on WhatsApp, which is what lets a merge recognise one person across channels. */
export const identityHash = (normalised: string): string => createHash('sha256').update(normalised, 'utf8').digest('hex');

/** The copy that may be shown: enough to recognise, not enough to use. */
export function maskIdentity(channel: IdentityChannel, normalised: string): string {
  if (channel === 'PHONE' || channel === 'WHATSAPP') return `${normalised.slice(0, 3)}${'*'.repeat(Math.max(1, normalised.length - 5))}${normalised.slice(-2)}`;
  if (channel === 'EMAIL') {
    const at = normalised.indexOf('@');
    // A local part of one character shows none of it.
    return `${at > 1 ? normalised.slice(0, 1) : ''}***${normalised.slice(at)}`;
  }
  // An id shows the ends only when it is long enough to leave something hidden: from 8 characters two at each end, from 5 one, otherwise nothing.
  const edge = normalised.length >= 8 ? 2 : normalised.length >= 5 ? 1 : 0;
  return `${normalised.slice(0, edge)}***${edge === 0 ? '' : normalised.slice(-edge)}`;
}

// ---- the code ------------------------------------------------------------------------------------------------------------------------

/** A code of six digits from a source of random integers (a test gives its own). */
export function generateOtp(randomInt: (below: number) => number): string {
  return String(randomInt(10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

/** The code is kept as a hash bound to the identity it was sent for: a code of another identity does not fit. */
export const otpHashOf = (identityId: string, otp: string): string => createHash('sha256').update(`${identityId.toLowerCase()}:${otp}`, 'utf8').digest('hex');

export interface OtpState {
  hash: string | null;
  expiresAt: Date | null;
  failures: number;
  lockedUntil: Date | null;
}

export type OtpVerdict =
  | { kind: 'OK' }
  /** The code is not the one sent; `failures` is the count now, and `lockedUntil` is set when it reached the limit. */
  | { kind: 'INVALID'; failures: number; lockedUntil: Date | undefined }
  | { kind: 'LOCKED'; until: Date };

/**
 * Judges a code: five wrong codes lock the identity for 30 minutes, a locked identity answers LOCKED whatever is sent, a code that was never sent or has run out (10 minutes) is INVALID like a wrong one,
 * and a right code is OK. A right code is judged against the state before the failure is counted, so it never opens a lock.
 */
export function judgeOtp(state: OtpState, otp: string, identityId: string, now: Date): OtpVerdict {
  if (state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()) return { kind: 'LOCKED', until: state.lockedUntil };
  const live = state.hash !== null && state.expiresAt !== null && state.expiresAt.getTime() > now.getTime();
  if (live && state.hash === otpHashOf(identityId, otp)) return { kind: 'OK' };
  // The count starts again once a lock has run out.
  const failures = (state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime() ? 0 : state.failures) + 1;
  return { kind: 'INVALID', failures, lockedUntil: failures >= OTP_MAX_FAILURES ? new Date(now.getTime() + OTP_LOCK_MS) : undefined };
}

export interface Verification {
  method: VerificationMethod;
  otp: string | undefined;
  documentRef: string | undefined;
}

/** What a verification may carry: a code of six digits for OTP, a reference to the document for ADMIN_DOCUMENT, nothing for the provider; whatever does not belong to the method is refused. */
export function assertVerification(raw: { method?: unknown; otp?: unknown; document_ref?: unknown }): Verification {
  const method = VERIFICATION_METHODS.find((candidate) => candidate === raw.method);
  if (method === undefined) throw invalid('method');
  if (method === 'OTP') {
    if (typeof raw.otp !== 'string' || !/^[0-9]{6}$/.test(raw.otp)) throw invalid('otp');
    if (raw.document_ref !== undefined) throw invalid('document_ref');
    return { method, otp: raw.otp, documentRef: undefined };
  }
  if (raw.otp !== undefined) throw invalid('otp');
  if (method === 'ADMIN_DOCUMENT') {
    const ref = typeof raw.document_ref === 'string' ? raw.document_ref.trim() : '';
    if (ref === '' || ref.length > DOCUMENT_REF_MAX) throw invalid('document_ref');
    return { method, otp: undefined, documentRef: ref };
  }
  if (raw.document_ref !== undefined) throw invalid('document_ref');
  return { method, otp: undefined, documentRef: undefined };
}

// ---- the merge -----------------------------------------------------------------------------------------------------------------------

export interface MergeIdentity {
  id: string;
  contactId: string;
  channel: string;
  hash: string;
  status: string;
}

export interface MergeContact {
  id: string;
  status: string;
}

export interface MergeCase {
  survivor: MergeContact;
  merged: MergeContact;
  /** The identity the caller names as the one they share. */
  named: MergeIdentity | undefined;
  /** Every identity of the two contacts. */
  identities: readonly MergeIdentity[];
}

/**
 * Whether two contacts may be merged (BR-OMNI-05): they must be two live contacts, and share a verified identity, that is, each of them holds a Verified identity with the same hash (the identity table is unique by channel
 * and hash, so the same number appears on the phone of one contact and on the WhatsApp of the other). The identity named must be one of them and Verified. The name of a contact is never looked at.
 * A merge without a shared verified identity is 422 RECIPIENT_AMBIGUOUS; a named identity that is not Verified is 422 IDENTITY_UNVERIFIED.
 */
export function assertMergeable(input: MergeCase): void {
  if (input.survivor.id === input.merged.id) throw invalid('merged_contact_id');
  for (const contact of [input.survivor, input.merged]) if (contact.status === 'Merged' || contact.status === 'Blocked') throw new DomainError('CONTACT_STATE_INVALID', 409, 'status');
  const named = input.named;
  if (named === undefined || (named.contactId !== input.survivor.id && named.contactId !== input.merged.id)) throw new DomainError('RECIPIENT_AMBIGUOUS', 422, 'shared_verified_identity_id');
  if (named.status !== 'Verified') throw new DomainError('IDENTITY_UNVERIFIED', 422, 'shared_verified_identity_id');
  const otherId = named.contactId === input.survivor.id ? input.merged.id : input.survivor.id;
  const shared = input.identities.some((identity) => identity.contactId === otherId && identity.status === 'Verified' && identity.hash === named.hash);
  if (!shared) throw new DomainError('RECIPIENT_AMBIGUOUS', 422, 'shared_verified_identity_id');
}

export interface MergeRequest {
  survivorId: string;
  mergedId: string;
  identityId: string;
  reason: string;
}

export function assertMergeRequest(raw: { survivor_contact_id?: unknown; merged_contact_id?: unknown; shared_verified_identity_id?: unknown; reason?: unknown }): MergeRequest {
  const id = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid(field);
    return value.toLowerCase();
  };
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 10 || reason.length > 2000) throw invalid('reason');
  return { survivorId: id(raw.survivor_contact_id, 'survivor_contact_id'), mergedId: id(raw.merged_contact_id, 'merged_contact_id'), identityId: id(raw.shared_verified_identity_id, 'shared_verified_identity_id'), reason };
}
