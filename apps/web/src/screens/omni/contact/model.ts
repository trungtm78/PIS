import { ApiError } from '@machvon/api-client';

/** Permissions of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'contact.read';
export const MANAGE_PERMISSION = 'omni.contact.manage';
export const MERGE_PERMISSION = 'omni.contact.merge';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const NAME_MAX = 120;
export const VALUE_MAX = 200;
export const DOCUMENT_REF_MAX = 200;

export const CLASSIFICATIONS = ['CITIZEN', 'CONTRACTOR_STAFF', 'AGENCY_STAFF', 'OTHER'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const IDENTITY_CHANNELS = ['PHONE', 'EMAIL', 'ZALO', 'WHATSAPP'] as const;
export type IdentityChannel = (typeof IDENTITY_CHANNELS)[number];
export const METHODS = ['OTP', 'PROVIDER_VERIFIED', 'ADMIN_DOCUMENT'] as const;
export type Method = (typeof METHODS)[number];
export type ContactStatus = 'Unverified' | 'Verified' | 'Merged' | 'Blocked';
export type IdentityStatus = 'Pending' | 'Verified' | 'Revoked';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface Identity {
  id: string;
  contactId: string;
  channel: IdentityChannel;
  masked: string;
  status: IdentityStatus;
  method: Method | undefined;
  verifiedAt: string | undefined;
  version: number;
}

export interface MergeCandidate {
  contactId: string;
  displayName: string;
  identityId: string;
}

export interface Contact {
  id: string;
  displayName: string;
  classification: Classification;
  status: ContactStatus;
  preferredChannel: string | undefined;
  mergedIntoId: string | undefined;
  identities: Identity[];
  mergeCandidates: MergeCandidate[];
  createdAt: string;
  version: number;
}

export interface ContactPage {
  items: Contact[];
  nextCursor: string | undefined;
}

function toIdentity(raw: unknown): Identity | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const channel = IDENTITY_CHANNELS.find((candidate) => candidate === raw.channel);
  const status = (['Pending', 'Verified', 'Revoked'] as const).find((candidate) => candidate === raw.status);
  if (channel === undefined || status === undefined) return undefined;
  return {
    id: raw.id,
    contactId: text(raw.contact_id),
    channel,
    masked: text(raw.masked),
    status,
    method: METHODS.find((candidate) => candidate === raw.verification_method),
    verifiedAt: optional(raw.verified_at),
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export function toContact(raw: unknown): Contact | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.display_name !== 'string') return undefined;
  const classification = CLASSIFICATIONS.find((candidate) => candidate === raw.classification);
  const status = (['Unverified', 'Verified', 'Merged', 'Blocked'] as const).find((candidate) => candidate === raw.status);
  if (classification === undefined || status === undefined) return undefined;
  return {
    id: raw.id,
    displayName: raw.display_name,
    classification,
    status,
    preferredChannel: optional(raw.preferred_channel),
    mergedIntoId: optional(raw.merged_into_id),
    identities: Array.isArray(raw.identities) ? raw.identities.flatMap((item) => toIdentity(item) ?? []) : [],
    mergeCandidates: Array.isArray(raw.merge_candidates)
      ? raw.merge_candidates.filter(isRecord).map((candidate) => ({ contactId: text(candidate.contact_id), displayName: text(candidate.display_name), identityId: text(candidate.identity_id) }))
      : [],
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export function toContactPage(raw: unknown): ContactPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toContact(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

/** The methods a person can verify an identity of the channel by: the code where one can be sent, and a document for a supervisor. The provider's own word is written by the processing of the inbound messages, not by a person. */
export function methodsFor(channel: IdentityChannel, canMerge: boolean): Method[] {
  const methods: Method[] = [];
  if (channel === 'PHONE' || channel === 'EMAIL') methods.push('OTP');
  if (canMerge) methods.push('ADMIN_DOCUMENT');
  return methods;
}

/** A merge is offered only to whoever may merge, and only for a contact that is alive and shares a verified identity with another. */
export const mayMerge = (contact: Pick<Contact, 'status' | 'mergeCandidates'>, canMerge: boolean): boolean => canMerge && contact.mergeCandidates.length > 0 && (contact.status === 'Verified' || contact.status === 'Unverified');

// ---- the forms ---------------------------------------------------------------------------------------------------------------------

export interface ContactForm {
  name: string;
  classification: Classification;
  preferredChannel: IdentityChannel | '';
}

export const emptyContactForm = (): ContactForm => ({ name: '', classification: 'CITIZEN', preferredChannel: '' });
export type ContactProblem = 'name';
export const contactProblems = (form: ContactForm): ContactProblem[] => (form.name.trim().length < 1 || form.name.trim().length > NAME_MAX ? ['name'] : []);
export const contactBody = (form: ContactForm): Record<string, unknown> => ({
  display_name: form.name.trim(),
  classification: form.classification,
  ...(form.preferredChannel === '' ? {} : { preferred_channel: form.preferredChannel }),
});

export interface IdentityForm {
  channel: IdentityChannel;
  value: string;
}

export const emptyIdentityForm = (): IdentityForm => ({ channel: 'PHONE', value: '' });
export const identityProblem = (form: IdentityForm): boolean => form.value.trim().length < 1 || form.value.trim().length > VALUE_MAX;

export interface VerifyForm {
  method: Method;
  otp: string;
  documentRef: string;
}

export const emptyVerifyForm = (method: Method): VerifyForm => ({ method, otp: '', documentRef: '' });
export type VerifyProblem = 'otp' | 'document';

export function verifyProblems(form: VerifyForm): VerifyProblem[] {
  if (form.method === 'OTP' && !/^[0-9]{6}$/.test(form.otp)) return ['otp'];
  if (form.method === 'ADMIN_DOCUMENT' && (form.documentRef.trim() === '' || form.documentRef.trim().length > DOCUMENT_REF_MAX)) return ['document'];
  return [];
}

export function verifyBody(form: VerifyForm): Record<string, unknown> {
  if (form.method === 'OTP') return { method: 'OTP', otp: form.otp };
  return { method: 'ADMIN_DOCUMENT', document_ref: form.documentRef.trim() };
}

export const reasonProblem = (reason: string): boolean => reason.trim().length < REASON_MIN || reason.trim().length > REASON_MAX;

// ---- what the server refused with --------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'taken' | 'otp' | 'ambiguous' | 'unverified' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** When a wrong code locked the identity: until when. */
  lockedUntil: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  IDENTITY_TAKEN: 'taken',
  OTP_INVALID: 'otp',
  RECIPIENT_AMBIGUOUS: 'ambiguous',
  IDENTITY_UNVERIFIED: 'unverified',
  CONTACT_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, lockedUntil: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, lockedUntil: typeof error.extensions.locked_until === 'string' ? error.extensions.locked_until : undefined };
}
