import { ApiError } from '@machvon/api-client';
import type { Contact, IdentityChannel } from '../contact/model';

/** Permissions of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'contact_consent.read';
export const MANAGE_PERMISSION = 'omni.consent.manage';
export const CONTACT_READ_PERMISSION = 'contact.read';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const TEXT_VERSION_MAX = 50;
export const EVIDENCE_MAX = 500;

export const CHANNELS = ['EMAIL', 'SMS', 'ZALO', 'WHATSAPP'] as const;
export type ConsentChannel = (typeof CHANNELS)[number];
export const PURPOSES = ['OPERATIONAL', 'REMINDER', 'ANNOUNCEMENT', 'SUPPORT_CONVERSATION'] as const;
export type ConsentPurpose = (typeof PURPOSES)[number];
export const METHODS = ['IN_APP', 'WEB_FORM', 'CHANNEL_OPT_IN', 'PAPER_SCANNED'] as const;
export type CaptureMethod = (typeof METHODS)[number];
export type ConsentStatus = 'Granted' | 'Withdrawn' | 'Expired';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface Consent {
  id: string;
  subjectId: string;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  effectiveAt: string;
  revokedAt: string | undefined;
  textVersion: string;
  captureMethod: string;
  version: number;
}

export function toConsent(raw: unknown): Consent | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const status = (['Granted', 'Withdrawn', 'Expired'] as const).find((candidate) => candidate === raw.status);
  if (status === undefined) return undefined;
  return {
    id: raw.id,
    subjectId: text(raw.subject_id),
    channel: text(raw.channel),
    purpose: text(raw.purpose),
    status,
    effectiveAt: text(raw.effective_at),
    revokedAt: optional(raw.revoked_at),
    textVersion: text(raw.consent_text_version),
    captureMethod: text(raw.capture_method),
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export const toConsents = (rows: readonly unknown[]): Consent[] => rows.flatMap((row) => toConsent(row) ?? []);

/** The channel of a consent a contact can give, from the identity it holds that is Verified: a phone for the text messages, an address for the mail, a Zalo or WhatsApp id for its own channel. */
const CHANNEL_OF_IDENTITY: Readonly<Record<IdentityChannel, ConsentChannel>> = { PHONE: 'SMS', EMAIL: 'EMAIL', ZALO: 'ZALO', WHATSAPP: 'WHATSAPP' };

export function channelsOf(contact: Pick<Contact, 'identities'>): ConsentChannel[] {
  const found = new Set(contact.identities.filter((identity) => identity.status === 'Verified').map((identity) => CHANNEL_OF_IDENTITY[identity.channel]));
  return CHANNELS.filter((channel) => found.has(channel));
}

/** A contact that is alive takes consents; one that was merged away or is blocked does not. */
export const takesConsent = (contact: Pick<Contact, 'status'>): boolean => contact.status === 'Unverified' || contact.status === 'Verified';

// ---- the form ---------------------------------------------------------------------------------------------------------------------

export interface ConsentForm {
  channel: ConsentChannel | '';
  purpose: ConsentPurpose;
  textVersion: string;
  method: CaptureMethod;
  evidence: string;
}

export const emptyForm = (channel: ConsentChannel | ''): ConsentForm => ({ channel, purpose: 'SUPPORT_CONVERSATION', textVersion: '', method: 'IN_APP', evidence: '' });
export type ConsentProblem = 'channel' | 'textVersion' | 'evidence';

/** The ways of capture that leave a proof: the reference of it is required. */
export const needsEvidence = (method: CaptureMethod): boolean => method === 'CHANNEL_OPT_IN' || method === 'PAPER_SCANNED';

export function consentProblems(form: ConsentForm): ConsentProblem[] {
  const found: ConsentProblem[] = [];
  if (form.channel === '') found.push('channel');
  if (form.textVersion.trim() === '' || form.textVersion.trim().length > TEXT_VERSION_MAX) found.push('textVersion');
  const evidence = form.evidence.trim();
  if ((needsEvidence(form.method) && evidence === '') || evidence.length > EVIDENCE_MAX) found.push('evidence');
  return found;
}

export function consentBody(form: ConsentForm): Record<string, unknown> {
  return {
    channel: form.channel,
    purpose: form.purpose,
    consent_text_version: form.textVersion.trim(),
    capture_method: form.method,
    ...(form.evidence.trim() === '' ? {} : { evidence_reference: form.evidence.trim() }),
  };
}

export const reasonProblem = (reason: string): boolean => reason.trim().length < REASON_MIN || reason.trim().length > REASON_MAX;

// ---- what the server refused with ----------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'unverified' | 'already' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  IDENTITY_UNVERIFIED: 'unverified',
  CONSENT_ALREADY_GRANTED: 'already',
  CONSENT_STATE_INVALID: 'state',
  CONTACT_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
