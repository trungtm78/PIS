import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';
import { VapidWebPushSender, WebPushProvider, retryAfterSecondsOf, urgencyOf, vapidConfigFromEnv, webPushProviderFromEnv } from '../../src/notifications/push/web-push';
import type { VapidConfig, WebPushSubscription } from '../../src/notifications/push/web-push';
import { TenantRateLimiter, receiptKeysFromEnv, secretFromEnv, webPushStateOf } from '../../src/notifications/push/web-push-config';
import { RECEIPT_TOKEN_LENGTH, looksLikeReceipt, mintReceipt, verifyReceipt } from '../../src/notifications/push/web-push-receipt';
import type { PushProviderMessage } from '../../src/notifications/push/ports';

const NOTIFICATION = randomUUID();
const TENANT = randomUUID();
const DEVICE = randomUUID();
const KEY = 'k'.repeat(40);

function browser(endpoint: string) {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = randomBytes(16);
  const subscription: WebPushSubscription = { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  return { keys, auth, subscription, token: JSON.stringify({ endpoint, expirationTime: null, keys: subscription.keys }) };
}

function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const shared = b.keys.computeSecret(senderPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.keys.getPublicKey(), senderPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function vapid(): { config: VapidConfig } {
  let keys = createECDH('prime256v1');
  keys.generateKeys();
  while (keys.getPrivateKey().length !== 32) {
    keys = createECDH('prime256v1');
    keys.generateKeys();
  }
  return { config: { publicKey: keys.getPublicKey().toString('base64url'), privateKey: keys.getPrivateKey().toString('base64url'), subject: 'mailto:ops@example.vn' } };
}

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A push service on a local port: records what it received and answers with the next scripted answer. */
class FakePushService {
  readonly seen: Seen[] = [];
  readonly answers: Array<{ status: number; headers?: Record<string, string> }> = [];
  private server: Server | undefined;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.seen.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
        const answer = this.answers.shift() ?? { status: 201, headers: { location: 'https://push.example/message/1' } };
        response.writeHead(answer.status, answer.headers ?? {});
        response.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }

  /** The `fetch` the sender uses: a subscription names a real push service, the request goes to this one instead. */
  readonly fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(String(input).replace('https://fcm.googleapis.com', this.base), init);
}

const message = (token: string, extra: Partial<PushProviderMessage> = {}): PushProviderMessage => ({
  token,
  body: 'A dossier needs your attention.',
  data: { deep_link: `/r/${NOTIFICATION}` },
  silent: false,
  idempotencyKey: 'n1:PUSH_FCM:1:d1',
  tenantId: TENANT,
  deviceId: DEVICE,
  ...extra,
});

describe('the settings of the channel', () => {
  it('reads a secret from a file first, then a reference, then the variable, and cuts the last line break', () => {
    const files = new Map([['/run/secrets/vapid', 'from-file\n']]);
    const read = (path: string) => files.get(path);
    const env = { X_FILE: '/run/secrets/vapid', X_REF: 'secret://prod/x', MACHVON_SECRET_PROD_X: 'from-ref', X: 'plain' };
    expect(secretFromEnv(env, 'X', read)).toBe('from-file');
    expect(secretFromEnv({ X_REF: 'secret://prod/x', MACHVON_SECRET_PROD_X: 'from-ref', X: 'plain' }, 'X', read)).toBe('from-ref');
    expect(secretFromEnv({ X: 'plain' }, 'X', read)).toBe('plain');
    expect(secretFromEnv({ X_FILE: '/missing', X: 'plain' }, 'X', read)).toBeUndefined();
    expect(secretFromEnv({}, 'X', read)).toBeUndefined();
  });

  it('takes the VAPID private key from a file and counts a malformed one as not set', () => {
    const pair = vapid().config;
    const env = { MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: pair.publicKey, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_FILE: '/run/secrets/key', MACHVON_WEBPUSH_SUBJECT: pair.subject };
    expect(vapidConfigFromEnv(env, () => `${pair.privateKey}\r\n`)).toEqual(pair);
    expect(vapidConfigFromEnv(env, () => 'short')).toBeUndefined();
    expect(vapidConfigFromEnv(env, () => undefined)).toBeUndefined();
  });

  it('reads the receipt keys, several while one is rotated, and refuses a short one', () => {
    expect(receiptKeysFromEnv({ MACHVON_WEBPUSH_RECEIPT_KEY: `${KEY}, ${'n'.repeat(40)}` })).toEqual([KEY, 'n'.repeat(40)]);
    expect(receiptKeysFromEnv({ MACHVON_WEBPUSH_RECEIPT_KEY: `${KEY},short` })).toEqual([]);
    expect(receiptKeysFromEnv({})).toEqual([]);
  });

  it('says how far the channel has been proven', () => {
    expect(webPushStateOf(false, { MACHVON_WEBPUSH_SPIKE_VERIFIED: 'true' })).toBe('MOCK');
    expect(webPushStateOf(true, {})).toBe('PENDING_SPIKE');
    expect(webPushStateOf(true, { MACHVON_WEBPUSH_SPIKE_VERIFIED: 'yes' })).toBe('PENDING_SPIKE');
    expect(webPushStateOf(true, { MACHVON_WEBPUSH_SPIKE_VERIFIED: 'TRUE' })).toBe('VERIFIED');
  });

  it('limits each tenant on its own and refills with time', () => {
    let now = 0;
    const limiter = new TenantRateLimiter(60, () => now);
    for (let index = 0; index < 60; index += 1) expect(limiter.take('a').ok).toBe(true);
    const refused = limiter.take('a');
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take('b').ok).toBe(true);
    now += 2000;
    expect(limiter.take('a').ok).toBe(true);
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterSecondsOf('30', 0)).toBe(30);
    expect(retryAfterSecondsOf('0', 0)).toBeUndefined();
    expect(retryAfterSecondsOf(null, 0)).toBeUndefined();
    expect(retryAfterSecondsOf('Wed, 21 Oct 2026 07:28:30 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(30);
    expect(retryAfterSecondsOf('Wed, 21 Oct 2026 07:28:30 GMT', Date.parse('Wed, 21 Oct 2026 08:00:00 GMT'))).toBeUndefined();
    expect(retryAfterSecondsOf('soon', 0)).toBeUndefined();
  });

  it('maps the priority of the engine to the urgency of the push service', () => {
    expect(urgencyOf('CRITICAL')).toBe('high');
    expect(urgencyOf('HIGH')).toBe('high');
    expect(urgencyOf('LOW')).toBe('low');
    expect(urgencyOf('NORMAL')).toBe('normal');
    expect(urgencyOf(undefined)).toBe('normal');
  });
});

describe('the receipt token', () => {
  const scope = { tenantId: TENANT, notificationId: NOTIFICATION, deviceId: DEVICE };

  it('round-trips the scope and has a fixed size', () => {
    const token = mintReceipt(KEY, scope, 1000) as string;
    expect(token).toHaveLength(RECEIPT_TOKEN_LENGTH);
    expect(looksLikeReceipt(token)).toBe(true);
    const verified = verifyReceipt([KEY], token, 1001);
    expect(verified.ok && verified.receipt).toMatchObject(scope);
  });

  it('carries no readable name or figure', () => {
    const raw = Buffer.from(mintReceipt(KEY, scope, 1000) as string, 'base64url').toString('latin1');
    expect(raw).not.toContain(NOTIFICATION);
    expect(mintReceipt(KEY, scope, 1000)).not.toContain(NOTIFICATION);
  });

  it('refuses a changed byte, another key, an expired token and a token of the wrong shape', () => {
    const token = mintReceipt(KEY, scope, 1000) as string;
    const raw = Buffer.from(token, 'base64url');
    for (const index of [0, 5, 30, 50, 60, raw.length - 1]) {
      const changed = Buffer.from(raw);
      changed[index] = (changed[index] as number) ^ 1;
      expect(verifyReceipt([KEY], changed.toString('base64url'), 1001).ok).toBe(false);
    }
    expect(verifyReceipt(['x'.repeat(40)], token, 1001)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyReceipt([KEY], token, 1000 + 48 * 3600)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verifyReceipt([KEY], token.slice(1), 1001)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyReceipt([KEY], 'not a token', 1001)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyReceipt([], token, 1001)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('verifies with the old key while a new one signs, and writes none for an id that is not a UUID', () => {
    const token = mintReceipt(KEY, scope, 1000) as string;
    expect(verifyReceipt(['n'.repeat(40), KEY], token, 1001).ok).toBe(true);
    expect(mintReceipt(KEY, { ...scope, notificationId: 'AbCdEfGhIjKlMnOpQrSt1234' }, 1000)).toBeUndefined();
  });
});

describe('the real sender against a push service', () => {
  const service = new FakePushService();
  beforeAll(() => service.start());
  afterAll(() => service.stop());
  beforeEach(() => {
    service.seen.length = 0;
    service.answers.length = 0;
  });

  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

  function provider(keys: readonly string[] = [KEY], limiter?: TenantRateLimiter, now = () => 1_800_000_000_000) {
    const { config } = vapid();
    const sender = new VapidWebPushSender(config, service.fetcher as typeof fetch, now);
    return { config, provider: new WebPushProvider(sender, undefined, { receiptKeys: keys, ...(limiter === undefined ? {} : { limiter }), now }) };
  }

  it('sends an encrypted message with the VAPID signature, the TTL, the urgency and the topic', async () => {
    const b = browser(ENDPOINT);
    const { config, provider: web } = provider();
    const answer = await web.send(message(b.token, { priority: 'CRITICAL' }));
    expect(answer).toEqual({ ok: true, messageId: 'https://push.example/message/1' });
    const seen = service.seen[0] as Seen;
    expect(seen.path).toBe('/fcm/send/abc123');
    expect(seen.headers['content-encoding']).toBe('aes128gcm');
    expect(seen.headers.ttl).toBe(String(4 * 3600));
    expect(seen.headers.urgency).toBe('high');
    expect(seen.headers.topic).toHaveLength(32);
    const authorization = String(seen.headers.authorization);
    const [, jwt, k] = /^vapid t=(\S+), k=(\S+)$/.exec(authorization) as RegExpExecArray;
    expect(k).toBe(config.publicKey);
    const [header, claims, signature] = (jwt as string).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: config.subject });
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: Buffer.from(config.publicKey, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(config.publicKey, 'base64url').subarray(33).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    const payload = JSON.parse(decrypt(seen.body, b)) as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(['rcpt', 'title', 'url', 'v']);
    expect(payload.url).toBe(`/r/${NOTIFICATION}`);
    expect(verifyReceipt([KEY], payload.rcpt as string, 1_800_000_001).ok).toBe(true);
  });

  it('sends no receipt when no receipt key is configured, and none for a link that is a start page', async () => {
    const b = browser(ENDPOINT);
    await provider([]).provider.send(message(b.token));
    expect(Object.keys(JSON.parse(decrypt((service.seen[0] as Seen).body, b)) as object).sort()).toEqual(['title', 'url', 'v']);
    await provider().provider.send(message(b.token, { data: { deep_link: '/m/approvals' } }));
    expect(Object.keys(JSON.parse(decrypt((service.seen[1] as Seen).body, b)) as object).sort()).toEqual(['title', 'url', 'v']);
  });

  it('uses the ordinary urgency and a day of TTL by default', async () => {
    await provider().provider.send(message(browser(ENDPOINT).token));
    expect((service.seen[0] as Seen).headers.urgency).toBe('normal');
    expect((service.seen[0] as Seen).headers.ttl).toBe(String(24 * 3600));
  });

  it('answers in the codes of the engine: gone is unregistered, a quota keeps its pause, an outage is tried again, a refusal is for good', async () => {
    const { provider: web } = provider();
    const b = browser(ENDPOINT);
    service.answers.push({ status: 410 }, { status: 404 }, { status: 429, headers: { 'retry-after': '120' } }, { status: 503, headers: { 'retry-after': '7' } }, { status: 500 }, { status: 401 }, { status: 400 });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'UNREGISTERED' });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'UNREGISTERED' });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'QUOTA_EXCEEDED', retryAfterSeconds: 120 });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'UNAVAILABLE', retryAfterSeconds: 7 });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'THIRD_PARTY_AUTH_ERROR' });
    expect(await web.send(message(b.token))).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('does not follow a redirect and says the service could not be reached', async () => {
    service.answers.push({ status: 302, headers: { location: `${service.base}/elsewhere` } });
    const answer = await provider().provider.send(message(browser(ENDPOINT).token));
    expect(answer).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(service.seen.map((seen) => seen.path)).toEqual(['/fcm/send/abc123']);
  });

  it('never calls an address that is not a push service of a browser', async () => {
    const b = browser('https://internal.example.vn/hook');
    expect(await provider().provider.send(message(b.token))).toEqual({ ok: false, code: 'INVALID_ARGUMENT_TOKEN' });
    expect(service.seen).toHaveLength(0);
  });

  it('holds a tenant that sends too much and lets the others through', async () => {
    let now = 1_800_000_000_000;
    const { provider: web } = provider([KEY], new TenantRateLimiter(2, () => now), () => now);
    const b = browser(ENDPOINT);
    expect((await web.send(message(b.token))).ok).toBe(true);
    expect((await web.send(message(b.token))).ok).toBe(true);
    const held = await web.send(message(b.token));
    expect(held).toMatchObject({ ok: false, code: 'QUOTA_EXCEEDED' });
    expect((held as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(service.seen).toHaveLength(2);
    expect((await web.send(message(b.token, { tenantId: randomUUID() }))).ok).toBe(true);
    now += 60_000;
    expect((await web.send(message(b.token))).ok).toBe(true);
  });
});

describe('the channel in a deployment', () => {
  const pair = vapid().config;
  const keys = { MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: pair.publicKey, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY: pair.privateKey, MACHVON_WEBPUSH_SUBJECT: pair.subject };

  it('is the stand-in without keys and a real sender not yet proven with them', () => {
    expect(webPushProviderFromEnv({})).toMatchObject({ mode: 'mock', state: 'MOCK' });
    expect(webPushProviderFromEnv(keys)).toMatchObject({ mode: 'vapid', state: 'PENDING_SPIKE' });
    expect(webPushProviderFromEnv({ ...keys, MACHVON_WEBPUSH_SPIKE_VERIFIED: 'true' })).toMatchObject({ mode: 'vapid', state: 'VERIFIED' });
  });

  it('registers nothing in production until the spike is done, and then only the web channel', () => {
    expect(defaultChannelAdapters('production', {}).providers()).toEqual([]);
    expect(defaultChannelAdapters('production', keys).providers()).toEqual([]);
    const verified = defaultChannelAdapters('production', { ...keys, MACHVON_WEBPUSH_SPIKE_VERIFIED: 'true' });
    expect(verified.providers()).toEqual(['web-push']);
    expect(verified.statusOf('PUSH_FCM')).toBe('VERIFIED');
    expect(verified.usable('PUSH_FCM')).toBeDefined();
    expect(defaultChannelAdapters('production', { MACHVON_WEBPUSH_SPIKE_VERIFIED: 'true' }).providers()).toEqual([]);
  });

  it('keeps the stand-in channel outside production, with keys or without', () => {
    expect(defaultChannelAdapters('test', {}).statusOf('PUSH_FCM')).toBe('MOCK');
    expect(defaultChannelAdapters('test', keys).statusOf('PUSH_FCM')).toBe('MOCK');
  });
});
