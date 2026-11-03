import { createHmac } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { ProviderSignatureScheme } from './provider-signature.ts';

/**
 * Document interoperability through the LGSP of the agency (ST-DOC-021, DOC.md F13, QD 28/2018/QD-TTg, QCVN 102:2016/BTTTT). A message leaves (OUTBOUND, one for each distribution on the LGSP channel) or arrives
 * (INBOUND, one for each envelope). Everything that judges a message lives here as pure functions: the states and the edges between them, the progressive waits between the attempts to send, the hosts the system
 * may call, and what an envelope is signed over. The adapter of the real LGSP is PROPOSED until the specification of the pilot tenant exists [CXN-06]; none of this depends on it.
 */

export const INTEROP_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;
export type InteropDirection = (typeof INTEROP_DIRECTIONS)[number];

export const OUTBOUND_STATUSES = ['QUEUED', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'DEAD'] as const;
export const INBOUND_STATUSES = ['RECEIVED', 'PROCESSED'] as const;
export const INTEROP_STATUSES = [...OUTBOUND_STATUSES, ...INBOUND_STATUSES] as const;
export type InteropStatus = (typeof INTEROP_STATUSES)[number];

/** What the system knows of the adapter that carried a message: the same words as the connectors and the integration cursors. */
export const INTEROP_ADAPTER_STATUSES = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'] as const;
export type InteropAdapterStatus = (typeof INTEROP_ADAPTER_STATUSES)[number];

/** The twentieth failed attempt ends a message as DEAD: a person takes it up again (`retryInteropMessage`), the system does not. */
export const INTEROP_MAX_ATTEMPTS = 20;

/** The wait after the first failed attempt, and the longest wait: the waits double until they reach the longest. */
export const INTEROP_BACKOFF_BASE_SECONDS = 60;
export const INTEROP_BACKOFF_CAP_SECONDS = 6 * 3600;

/** How long to wait before the next attempt when `failedAttempts` attempts have failed so far (one or more): 1, 2, 4 ... minutes up to six hours. */
export function interopBackoffSeconds(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) throw new RangeError('failedAttempts is a whole number of at least one');
  // The exponent is bounded before the power is taken, so that a count gone wild does not overflow into Infinity.
  const doublings = Math.min(failedAttempts - 1, 20);
  return Math.min(INTEROP_BACKOFF_BASE_SECONDS * 2 ** doublings, INTEROP_BACKOFF_CAP_SECONDS);
}

export interface FailurePlan {
  status: 'FAILED' | 'DEAD';
  attempts: number;
  /** When the next attempt is due; none once the message is DEAD. */
  nextAttemptAt: Date | null;
}

/** What one more failed attempt does to a message that had `attemptsBefore` attempts: it waits for the next one, or it is DEAD when the attempts are spent. */
export function planFailure(attemptsBefore: number, now: Date): FailurePlan {
  const attempts = attemptsBefore + 1;
  if (attempts >= INTEROP_MAX_ATTEMPTS) return { status: 'DEAD', attempts: INTEROP_MAX_ATTEMPTS, nextAttemptAt: null };
  return { status: 'FAILED', attempts, nextAttemptAt: new Date(now.getTime() + interopBackoffSeconds(attempts) * 1000) };
}

export type InteropEvent = 'send' | 'fail' | 'requeue' | 'retry' | 'cancel' | 'acknowledge' | 'reject' | 'process';

// The events a message takes, and the direction and statuses each is taken from. Where it goes is said beside it; the guard trigger of V1230 holds the same table.
const EDGES: Readonly<Record<InteropEvent, { direction: InteropDirection; from: readonly InteropStatus[] }>> = {
  // An attempt the adapter accepted: QUEUED to SENT.
  send: { direction: 'OUTBOUND', from: ['QUEUED'] },
  // An attempt that failed: the message waits for the next one (FAILED), or is DEAD when the attempts are spent.
  fail: { direction: 'OUTBOUND', from: ['QUEUED'] },
  // The wait is over: FAILED to QUEUED.
  requeue: { direction: 'OUTBOUND', from: ['FAILED'] },
  // A person asked for it again: FAILED or DEAD to QUEUED.
  retry: { direction: 'OUTBOUND', from: ['FAILED', 'DEAD'] },
  // The distribution was called off (the document was recalled) before the message left: it ends as REJECTED with that reason, and nothing is sent.
  cancel: { direction: 'OUTBOUND', from: ['QUEUED', 'FAILED'] },
  // The receiving agency confirmed or refused what the adapter handed over: SENT to ACKED or REJECTED.
  acknowledge: { direction: 'OUTBOUND', from: ['SENT'] },
  reject: { direction: 'OUTBOUND', from: ['SENT'] },
  // What arrived was made into a letter: RECEIVED to PROCESSED.
  process: { direction: 'INBOUND', from: ['RECEIVED'] },
};

/** Refuses an event that the message cannot take in its direction and state: 409 `INTEROP_STATE_INVALID` with the status. */
export function assertInteropEvent(event: InteropEvent, direction: InteropDirection, from: InteropStatus): void {
  const edge = EDGES[event];
  if (edge.direction !== direction || !edge.from.includes(from)) throw new DomainError('INTEROP_STATE_INVALID', 409, 'status', { extensions: { status: from, direction } });
}

/** A message is sent again by a person only when it failed or died; a delivered, queued or received message is not. */
export const assertRetryable = (direction: InteropDirection, status: InteropStatus): void => assertInteropEvent('retry', direction, status);

// ---- the hosts the system may call -----------------------------------------------------------------------------------------------------------

export type EgressRefusal = 'ENDPOINT_INVALID' | 'SCHEME_NOT_HTTPS' | 'HOST_NOT_ALLOWED';

const HOST_ENTRY = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** An allowlist entry is a host name, or `*.` and a domain for every host below it; nothing else (no scheme, no path, no port) is an entry. */
export const isEgressEntry = (entry: unknown): entry is string => typeof entry === 'string' && entry.length <= 253 && HOST_ENTRY.test(entry);

/**
 * Whether the system may call `endpoint`: it is an https address whose host is on the allowlist of the tenant. A wildcard entry covers the hosts below its domain and not the domain itself; an entry that is not
 * well formed matches nothing, and an empty allowlist allows nothing (the tenant must have said where the system may go).
 */
export function egressDecision(endpoint: unknown, allowlist: readonly unknown[]): { allowed: true; host: string; endpoint: string } | { allowed: false; reason: EgressRefusal } {
  let url: URL;
  try {
    url = new URL(typeof endpoint === 'string' ? endpoint : '');
  } catch {
    return { allowed: false, reason: 'ENDPOINT_INVALID' };
  }
  if (url.protocol !== 'https:') return { allowed: false, reason: 'SCHEME_NOT_HTTPS' };
  // The parser has lower-cased the host.
  const host = url.hostname;
  const listed = allowlist.filter(isEgressEntry).map((entry) => entry.toLowerCase());
  const matches = listed.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
  return matches ? { allowed: true, host, endpoint: url.href } : { allowed: false, reason: 'HOST_NOT_ALLOWED' };
}

/** The host and the address (as written out by the URL parser) the system may call; 422 `EGRESS_NOT_ALLOWED` with the reason for any other. */
export function assertEgressAllowed(endpoint: unknown, allowlist: readonly unknown[]): { host: string; endpoint: string } {
  const decision = egressDecision(endpoint, allowlist);
  if (!decision.allowed) throw new DomainError('EGRESS_NOT_ALLOWED', 422, 'endpoint', { extensions: { reason: decision.reason } });
  return { host: decision.host, endpoint: decision.endpoint };
}

// ---- what an inbound message is signed over ----------------------------------------------------------------------------------------------------

export interface InteropSignedFields {
  externalMessageId: string;
  senderCode: string;
  envelopeSha256: string;
  envelopeObjectKey: string;
  signatureKeyId: string;
}

/**
 * The bytes the sending agency signs: the fields of the message in a fixed order as one JSON array. An array is unambiguous where a joined string is not, and the signature itself is not part of it. The digest of
 * the envelope is among them, so a signature binds the message to the very bytes of the envelope, which the receiver hashes again.
 */
export function interopSignedPayload(fields: InteropSignedFields): Buffer {
  return Buffer.from(JSON.stringify([fields.externalMessageId, fields.senderCode, fields.envelopeSha256, fields.envelopeObjectKey, fields.signatureKeyId]), 'utf8');
}

/** `hex(hmac_sha256(secret, payload))` with no timestamp under it: a message that comes twice is stopped by its envelope digest, not by a window. */
export const INTEROP_SIGNATURE_SCHEME: ProviderSignatureScheme = {
  signedPayload: (_timestampSeconds, rawBody) => rawBody,
  encoding: 'hex',
  prefix: '',
};

/** The signature that the MOCK LGSP (and the tests) put on a message. */
export const signInteropMessage = (secret: Buffer, fields: InteropSignedFields): string => createHmac('sha256', secret).update(interopSignedPayload(fields)).digest('hex');
