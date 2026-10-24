import { createHmac } from 'node:crypto';
import type { MetricsSink } from '../src/ports.ts';
import {
  BODY_HMAC_SHA256_PREFIXED,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  SIGNATURE_FAILURE_METRIC,
  TIMESTAMPED_HMAC_SHA256,
  parseCallbackTimestamp,
  verifyProviderCallback,
} from '../src/provider-signature.ts';

const SECRET = Buffer.from('provider-app-secret-0123456789abcdef');
const OLD_SECRET = Buffer.from('previous-app-secret-0123456789abcdef');
const NOW = 1_800_000_000;
const BODY = Buffer.from('{"event":"delivered","id":"evt-1"}', 'utf8');

function sign(secret: Buffer, timestamp: number, body: Buffer): string {
  return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest('hex');
}

class CountingMetrics implements MetricsSink {
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  increment(name: string, labels?: Record<string, string>): void {
    this.counted.push({ name, labels });
  }

  gauge(): void {
    // not used by the check
  }
}

const verify = (overrides: Partial<Parameters<typeof verifyProviderCallback>[0]> = {}) =>
  verifyProviderCallback({
    provider: 'WHATSAPP',
    rawBody: BODY,
    signature: sign(SECRET, NOW, BODY),
    timestampSeconds: NOW,
    keys: [{ keyId: 'k1', secret: SECRET }],
    now: () => NOW,
    ...overrides,
  });

describe('verifyProviderCallback', () => {
  it('accepts a good signature and names the key that signed (AC-ST-KERNEL-071-2)', () => {
    expect(verify()).toEqual({ keyId: 'k1' });
  });

  it('refuses a body changed by one byte with 401 SIGNATURE_INVALID and counts the failure (AC-ST-KERNEL-071-2)', () => {
    const metrics = new CountingMetrics();
    const tampered = Buffer.from('{"event":"delivered","id":"evt-2"}', 'utf8');
    expect(() => verify({ rawBody: tampered, metrics })).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID', status: 401 }));
    expect(metrics.counted).toEqual([{ name: SIGNATURE_FAILURE_METRIC, labels: { provider: 'WHATSAPP' } }]);
  });

  it.each([
    ['a missing signature', { signature: undefined }],
    ['an empty signature', { signature: '' }],
    ['a missing timestamp', { timestampSeconds: undefined }],
    ['a timestamp that is not a number', { timestampSeconds: Number.NaN }],
    ['a signature of another length', { signature: 'abcd' }],
    ['a signature that is not hex', { signature: 'zz'.repeat(32) }],
    ['a signature made with another secret', { signature: sign(Buffer.from('another-secret-0123456789abcdef-xyz'), NOW, BODY) }],
    ['no key at all', { keys: [] }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => verify(overrides)).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID', status: 401 }));
  });

  it('never trusts a key with no secret, so a vault that answered nothing does not let anyone sign', () => {
    const empty = Buffer.alloc(0);
    expect(() => verify({ keys: [{ keyId: 'unset', secret: empty }], signature: sign(empty, NOW, BODY) })).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID', status: 401 }));
    // The key that has a secret still verifies beside it.
    expect(verify({ keys: [{ keyId: 'unset', secret: empty }, { keyId: 'k1', secret: SECRET }] })).toEqual({ keyId: 'k1' });
  });

  it('refuses a signature made for another timestamp, so the timestamp cannot be swapped for a fresh one', () => {
    expect(() => verify({ signature: sign(SECRET, NOW - 3600, BODY) })).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });

  it('accepts an upper-case hex signature', () => {
    expect(verify({ signature: sign(SECRET, NOW, BODY).toUpperCase() })).toEqual({ keyId: 'k1' });
  });

  it('accepts either key while a provider rotates, and names the one that matched', () => {
    const keys = [
      { keyId: 'new', secret: SECRET },
      { keyId: 'old', secret: OLD_SECRET },
    ];
    expect(verify({ keys })).toEqual({ keyId: 'new' });
    expect(verify({ keys, signature: sign(OLD_SECRET, NOW, BODY) })).toEqual({ keyId: 'old' });
  });

  it('refuses a good signature on a timestamp 10 minutes old with 401 REPLAY_WINDOW_EXCEEDED', () => {
    const stale = NOW - 600;
    const metrics = new CountingMetrics();
    expect(() => verify({ timestampSeconds: stale, signature: sign(SECRET, stale, BODY), metrics })).toThrow(
      expect.objectContaining({ code: 'REPLAY_WINDOW_EXCEEDED', status: 401 }),
    );
    expect(metrics.counted).toHaveLength(1);
  });

  it('allows exactly the replay window in the past and in the future, and no more', () => {
    for (const offset of [-DEFAULT_REPLAY_WINDOW_SECONDS, DEFAULT_REPLAY_WINDOW_SECONDS]) {
      const timestamp = NOW + offset;
      expect(verify({ timestampSeconds: timestamp, signature: sign(SECRET, timestamp, BODY) })).toEqual({ keyId: 'k1' });
    }
    const early = NOW + DEFAULT_REPLAY_WINDOW_SECONDS + 1;
    expect(() => verify({ timestampSeconds: early, signature: sign(SECRET, early, BODY) })).toThrow(expect.objectContaining({ code: 'REPLAY_WINDOW_EXCEEDED' }));
  });

  it('honours a window set by the caller and the system clock by default', () => {
    const stale = NOW - 60;
    expect(() => verify({ timestampSeconds: stale, signature: sign(SECRET, stale, BODY), replayWindowSeconds: 30 })).toThrow(
      expect.objectContaining({ code: 'REPLAY_WINDOW_EXCEEDED' }),
    );
    const current = Math.floor(Date.now() / 1000);
    expect(
      verifyProviderCallback({
        provider: 'WHATSAPP',
        rawBody: BODY,
        signature: sign(SECRET, current, BODY),
        timestampSeconds: current,
        keys: [{ keyId: 'k1', secret: SECRET }],
      }),
    ).toEqual({ keyId: 'k1' });
  });

  it('verifies a body-only scheme with a prefix and base64 digests', () => {
    const digest = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verify({ scheme: BODY_HMAC_SHA256_PREFIXED, signature: `sha256=${digest}` })).toEqual({ keyId: 'k1' });
    expect(() => verify({ scheme: BODY_HMAC_SHA256_PREFIXED, signature: digest })).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
    const base64 = createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${NOW}.`), BODY])).digest('base64');
    expect(verify({ scheme: { ...TIMESTAMPED_HMAC_SHA256, encoding: 'base64' }, signature: base64 })).toEqual({ keyId: 'k1' });
  });
});

describe('parseCallbackTimestamp', () => {
  it.each([
    ['1800000000', 1_800_000_000],
    ['0', 0],
  ])('reads %s as seconds', (header, seconds) => {
    expect(parseCallbackTimestamp(header)).toBe(seconds);
  });

  it.each([undefined, '', 'abc', '1.5', '-5', '1800000000000000', ' 1800000000'])('rejects %p', (header) => {
    expect(parseCallbackTimestamp(header)).toBeUndefined();
  });
});
