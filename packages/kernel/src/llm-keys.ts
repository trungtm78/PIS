import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';

/**
 * The virtual keys of the AI gateway (ST-LLM-002, LLM F5, BR-LLM-09): a key is made at LiteLLM, its secret goes to the vault and nowhere else, and the application keeps a fingerprint and a reference. The secret
 * is never in an answer, an audit row, an event, a log or a trace; what is shown of a key is its alias, its fingerprint and its state.
 */
export const KEY_SCOPES = ['TENANT', 'UNIT', 'PROJECT', 'SERVICE'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** The old key of a rotation goes on working for a day, so that what uses it can be moved to the new one, and is then revoked. */
export const KEY_ROTATION_HOURS = 24;
const MAX_VALIDITY_DAYS = 366;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const MAX_RATE = 10_000_000;

/** What LiteLLM does for the application, through its admin API on the internal network. */
export interface LiteLlmAdminPort {
  /** Makes a key for the models named (by their ids at the provider) and answers its reference at LiteLLM and its secret, once. */
  createKey(input: { alias: string; models: readonly string[]; rpmLimit: number | null; tpmLimit: number | null; expiresAt: Date }): Promise<{ keyRef: string; secret: string }>;
  /** Stops a key at once: the next call with it fails. */
  revokeKey(keyRef: string): Promise<void>;
  /** Makes a key end at the moment given instead of its own expiry. */
  limitLifetime(keyRef: string, until: Date): Promise<void>;
}

/** Where the secrets are kept (OpenBao or the KMS of the platform); the application only writes them and later removes them. */
export interface SecretVaultPort {
  put(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

/** What is shown of a secret: the start and the end of its hash, so that two keys can be told apart and a leaked one recognised without the secret being given. */
export function fingerprintOf(secret: string): string {
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

/** The place of the secret of a key in the vault; it names the tenant and the key, never the secret. */
export function secretRefOf(tenantId: string, keyId: string): string {
  return `secret://tenants/${tenantId}/litellm/${keyId}`;
}

const REDACTED = '[REDACTED]';
// A prefixed key (sk-...), a bearer token, and any long run of the characters of a key or a hash: what looks like a secret is not written to a log or a trace.
const KEY_LIKE: readonly RegExp[] = [/\b(?:sk|vk|pk|key)[-_][A-Za-z0-9_-]{16,}/gi, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, /\b[A-Za-z0-9+/_-]{40,}={0,2}/g];

/** The text with everything that looks like a key replaced, for the messages that reach a log or a trace (BR-LLM-09). */
export function scrubSecrets(text: string): string {
  return KEY_LIKE.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

export interface KeyDraft {
  alias: string;
  scopeKind: string;
  allowedModelIds: readonly string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  expiresAt: Date;
  now: Date;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** What a key needs to be made: an alias that can be told, a scope, models each once, rates that are numbers and an end that is in the future and not more than a year away. */
export function assertKeyDraft(draft: KeyDraft): void {
  if (!ALIAS.test(draft.alias)) throw invalid('key_alias');
  if (!(KEY_SCOPES as readonly string[]).includes(draft.scopeKind)) throw invalid('scope_kind');
  if (new Set(draft.allowedModelIds).size !== draft.allowedModelIds.length) throw invalid('allowed_model_ids');
  for (const [field, value] of [['rpm_limit', draft.rpmLimit], ['tpm_limit', draft.tpmLimit]] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > MAX_RATE)) throw invalid(field);
  }
  if (Number.isNaN(draft.expiresAt.getTime()) || draft.expiresAt.getTime() <= draft.now.getTime()) throw invalid('expires_at');
  if (draft.expiresAt.getTime() > draft.now.getTime() + MAX_VALIDITY_DAYS * 86_400_000) throw invalid('expires_at');
}

/** The moment the old key of a rotation ends: a day from now, or its own end if that comes first. */
export function rotationDeadline(now: Date, expiresAt: Date): Date {
  return new Date(Math.min(expiresAt.getTime(), now.getTime() + KEY_ROTATION_HOURS * 3_600_000));
}
