import { ApiError } from '@machvon/api-client';

export const READ_PAGE_SIZE = 25;

/**
 * The version of the text the person agrees to when they give a consent (BR-NOT-07: a consent is specific, and its evidence is the text it was given
 * against). It travels with every grant as `consent_text_version`; a change of the text is a new value here and a new consent from everyone.
 */
export const CONSENT_TEXT_VERSION = 'consent-2026-1';

/** The channels a person can consent to, and the purposes (ConsentGrant of openapi.json). The inbox needs no consent and is shown as locked. */
export const CONSENT_CHANNELS = ['EMAIL', 'SMS', 'ZALO', 'WHATSAPP', 'PUSH'] as const;
export const CONSENT_PURPOSES = ['OPERATIONAL', 'REMINDER', 'ANNOUNCEMENT', 'SUPPORT_CONVERSATION'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentStatus = 'Granted' | 'Withdrawn' | 'Expired';

/** One consent of the history (NOT-17), as the screen uses it. */
export interface ConsentItem {
  id: string;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  effectiveAt: string;
  revokedAt: string | undefined;
  textVersion: string;
  /** The version a withdrawal is made under (`If-Match`). */
  version: number;
}

const STATUSES: readonly string[] = ['Granted', 'Withdrawn', 'Expired'];

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Reads one item of `GET /me/consents`; an item that is not readable is left out rather than shown half. */
export function toConsent(raw: unknown): ConsentItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  if (!isText(item.id) || !isText(item.channel) || !isText(item.purpose) || !isText(item.status) || !STATUSES.includes(item.status) || !isText(item.effective_at)) return undefined;
  if (typeof item.version !== 'number' || !Number.isInteger(item.version)) return undefined;
  return {
    id: item.id,
    channel: item.channel,
    purpose: item.purpose,
    status: item.status as ConsentStatus,
    effectiveAt: item.effective_at,
    revokedAt: isText(item.revoked_at) ? item.revoked_at : undefined,
    textVersion: isText(item.consent_text_version) ? item.consent_text_version : '',
    version: item.version,
  };
}

/** Whether a consent for the channel and the purpose is in force: the grant form does not offer a second one. */
export const isLive = (items: readonly ConsentItem[], channel: string, purpose: string): boolean =>
  items.some((item) => item.status === 'Granted' && item.channel === channel && item.purpose === purpose);

export type ProblemReason = 'alreadyGranted' | 'identity' | 'stale' | 'ended' | 'notFound' | 'denied' | 'invalid' | 'session' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  CONSENT_ALREADY_GRANTED: 'alreadyGranted',
  CHANNEL_IDENTITY_UNVERIFIED: 'identity',
  VERSION_CONFLICT: 'stale',
  CONSENT_STATE_INVALID: 'ended',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  VALIDATION_FAILED: 'invalid',
  SESSION_EXPIRED: 'session',
};

/** What went wrong with a command, by the code of the server; nothing else of the answer is shown. */
export function problemReasonOf(error: unknown): ProblemReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}
