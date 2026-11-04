import { DomainError } from '../src/errors.ts';
import { KEY_ROTATION_HOURS, assertKeyDraft, fingerprintOf, rotationDeadline, scrubSecrets, secretRefOf } from '../src/llm-keys.ts';

const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const NOW = new Date('2026-10-22T00:00:00Z');
const DRAFT = { alias: 'bid-prod', scopeKind: 'TENANT', allowedModelIds: ['m1', 'm2'], rpmLimit: 600, tpmLimit: 100000, expiresAt: new Date('2027-10-22T00:00:00+07:00'), now: NOW };

describe('the virtual keys of the AI gateway (ST-LLM-002, LLM F5, BR-LLM-09)', () => {
  it('AC-ST-LLM-002-1: UAT-AC20 shows of a secret only the start and the end of its hash, the same every time and not the secret', () => {
    const secret = ['sk', '1234567890abcdefghijklmnopqrstuv'].join('-');
    const fingerprint = fingerprintOf(secret);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
    expect(fingerprintOf(secret)).toBe(fingerprint);
    expect(fingerprintOf(`${secret}x`)).not.toBe(fingerprint);
    expect(fingerprint).not.toContain('1234567890');
    expect(secret).not.toContain(fingerprint);
  });

  it('AC-ST-LLM-002-1: UAT-AC20 names the place of a secret by the tenant and the key, never by anything of the secret', () => {
    expect(secretRefOf('t-a', 'k-1')).toBe('secret://tenants/t-a/litellm/k-1');
  });

  it('AC-ST-LLM-002-1: UAT-AC20 takes what looks like a key out of a text that is to be logged, and leaves ordinary text alone', () => {
    const secret = ['sk', '1234567890abcdefghijklmnopqrstuv'].join('-');
    expect(scrubSecrets(`LiteLLM said no for ${secret}`)).toBe('LiteLLM said no for [REDACTED]');
    expect(scrubSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789')).toBe('Authorization: [REDACTED]');
    expect(scrubSecrets(`hash ${'a1b2c3d4'.repeat(8)} done`)).toBe('hash [REDACTED] done');
    expect(scrubSecrets('vk_ABCDEFGHIJKLMNOPQRSTUV')).toBe('[REDACTED]');
    expect(scrubSecrets('provider VN-HOST answered 503 after 30 seconds')).toBe('provider VN-HOST answered 503 after 30 seconds');
    // The global patterns are not left in a state that makes the second text pass.
    expect(scrubSecrets(secret)).toBe('[REDACTED]');
    expect(scrubSecrets(secret)).toBe('[REDACTED]');
  });

  it('takes a good draft and refuses an alias that cannot be told, an unknown scope, a repeated model, a rate that is not a number and an end that is past or too far', () => {
    expect(() => assertKeyDraft(DRAFT)).not.toThrow();
    expect(() => assertKeyDraft({ ...DRAFT, allowedModelIds: [], rpmLimit: null, tpmLimit: null })).not.toThrow();
    const field = (change: Partial<typeof DRAFT>) => thrown(() => assertKeyDraft({ ...DRAFT, ...change })).detail;
    expect(field({ alias: 'a' })).toBe('key_alias');
    expect(field({ alias: 'has space' })).toBe('key_alias');
    expect(field({ scopeKind: 'GLOBAL' })).toBe('scope_kind');
    expect(field({ allowedModelIds: ['m1', 'm1'] })).toBe('allowed_model_ids');
    expect(field({ rpmLimit: 0 })).toBe('rpm_limit');
    expect(field({ tpmLimit: 1.5 })).toBe('tpm_limit');
    expect(field({ expiresAt: new Date('2026-10-21T00:00:00Z') })).toBe('expires_at');
    expect(field({ expiresAt: new Date('2029-01-01T00:00:00Z') })).toBe('expires_at');
    expect(field({ expiresAt: new Date('nope') })).toBe('expires_at');
  });

  it('AC-ST-LLM-002-2: UAT-AC20 ends the old key of a rotation a day from now, or at its own end when that comes first', () => {
    expect(KEY_ROTATION_HOURS).toBe(24);
    expect(rotationDeadline(NOW, new Date('2027-01-01T00:00:00Z')).toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(rotationDeadline(NOW, new Date('2026-10-22T10:00:00Z')).toISOString()).toBe('2026-10-22T10:00:00.000Z');
  });
});
