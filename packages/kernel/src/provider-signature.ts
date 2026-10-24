import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import { NOOP_METRICS } from './ports.ts';
import type { MetricsSink } from './ports.ts';

/** A provider's timestamp may differ from the server clock by at most this long, in either direction (BR-OMNI-04). */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/** Counter of callbacks refused for a bad signature or a stale timestamp, by provider (OMNI telemetry). */
export const SIGNATURE_FAILURE_METRIC = 'webhook_signature_failures_total';

/** A key the provider may sign with. A provider that rotates keys has two in force at once; the secret comes from the vault. */
export interface ProviderSigningKey {
  keyId: string;
  secret: Buffer;
}

/**
 * How one provider signs: the bytes covered, how the HMAC-SHA256 digest is written and what precedes it in the header. The schemes of
 * NOT, OMNI and PAY providers are values of this type; the check itself is the same for all of them.
 */
export interface ProviderSignatureScheme {
  signedPayload(timestampSeconds: number, rawBody: Buffer): Buffer;
  encoding: 'hex' | 'base64';
  prefix: string;
}

/** `hex(hmac_sha256(secret, "<timestamp>.<raw body>"))`: the timestamp is signed, so it cannot be replayed with a fresh one. */
export const TIMESTAMPED_HMAC_SHA256: ProviderSignatureScheme = {
  signedPayload: (timestampSeconds, rawBody) => Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), rawBody]),
  encoding: 'hex',
  prefix: '',
};

/** `sha256=hex(hmac_sha256(secret, raw body))`, the shape of the WhatsApp and Meta webhooks. */
export const BODY_HMAC_SHA256_PREFIXED: ProviderSignatureScheme = {
  signedPayload: (_timestampSeconds, rawBody) => rawBody,
  encoding: 'hex',
  prefix: 'sha256=',
};

export interface VerifyCallbackInput {
  provider: string;
  /** The body exactly as it arrived: a parsed and re-serialised body does not verify. */
  rawBody: Buffer;
  /** The signature header, or undefined when it is missing. */
  signature: string | undefined;
  /** The timestamp the provider states, in seconds since the epoch (already parsed), or undefined when it is missing. */
  timestampSeconds: number | undefined;
  keys: readonly ProviderSigningKey[];
  scheme?: ProviderSignatureScheme;
  replayWindowSeconds?: number;
  /** Seconds since the epoch; tests inject it. */
  now?: () => number;
  metrics?: MetricsSink;
}

function digestOf(scheme: ProviderSignatureScheme, key: ProviderSigningKey, timestampSeconds: number, rawBody: Buffer): string {
  const digest = createHmac('sha256', key.secret).update(scheme.signedPayload(timestampSeconds, rawBody)).digest(scheme.encoding);
  return `${scheme.prefix}${digest}`;
}

function sameText(given: string, expected: string): boolean {
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The key id whose signature the header carries, or undefined. Every key is tried, so the time taken does not tell which one matched. */
function matchingKeyId(input: VerifyCallbackInput, scheme: ProviderSignatureScheme, timestampSeconds: number, signature: string): string | undefined {
  const given = scheme.encoding === 'hex' ? signature.toLowerCase() : signature;
  let matched: string | undefined;
  for (const key of input.keys) {
    // An empty secret is a vault that answered nothing: HMAC accepts it, so anybody could sign with it. It verifies nothing.
    if (key.secret.length > 0 && sameText(given, digestOf(scheme, key, timestampSeconds, input.rawBody))) matched ??= key.keyId;
  }
  return matched;
}

/**
 * Checks the signature of a provider callback on its raw body and then its timestamp, and returns the id of the key that signed it.
 * A missing, malformed or wrong signature is 401 SIGNATURE_INVALID; a good signature on a timestamp more than the replay window from
 * now is 401 REPLAY_WINDOW_EXCEEDED. The signature is judged first, so a forger learns nothing about the window. Nothing is read from
 * the body and nothing is stored here: a callback that fails leaves no trace but the metric.
 */
export function verifyProviderCallback(input: VerifyCallbackInput): { keyId: string } {
  const scheme = input.scheme ?? TIMESTAMPED_HMAC_SHA256;
  const metrics = input.metrics ?? NOOP_METRICS;
  const refuse = (code: 'SIGNATURE_INVALID' | 'REPLAY_WINDOW_EXCEEDED'): DomainError => {
    metrics.increment(SIGNATURE_FAILURE_METRIC, { provider: input.provider });
    return new DomainError(code, 401);
  };
  const { signature, timestampSeconds } = input;
  if (signature === undefined || signature === '' || timestampSeconds === undefined || !Number.isFinite(timestampSeconds)) {
    throw refuse('SIGNATURE_INVALID');
  }
  const keyId = matchingKeyId(input, scheme, timestampSeconds, signature);
  if (keyId === undefined) throw refuse('SIGNATURE_INVALID');
  const now = (input.now ?? ((): number => Math.floor(Date.now() / 1000)))();
  if (Math.abs(now - timestampSeconds) > (input.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS)) throw refuse('REPLAY_WINDOW_EXCEEDED');
  return { keyId };
}

const SECONDS_PATTERN = /^\d{1,12}$/;

/** A timestamp header written as whole seconds since the epoch, or undefined for anything else (a missing header, text, milliseconds). */
export function parseCallbackTimestamp(header: string | undefined): number | undefined {
  return header !== undefined && SECONDS_PATTERN.test(header) ? Number(header) : undefined;
}
