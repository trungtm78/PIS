import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { DomainError, assertLockScreenSafe } from '@machvon/kernel';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';
import { MockPushProvider } from '../../src/notifications/push/ports';
import type { PushProviderMessage } from '../../src/notifications/push/ports';
import { PushChannelAdapter } from '../../src/notifications/push/push-adapter';
import {
  DEFAULT_PUSH_SERVICE_SUFFIXES,
  MockWebPushSender,
  VapidWebPushSender,
  WebAwarePushProvider,
  WebPushProvider,
  allowedSuffixesFromEnv,
  answerCodeOf,
  encryptWebPushPayload,
  endpointAllowed,
  isGenericTitle,
  isWebPushToken,
  parseWebPushSubscription,
  topicOf,
  vapidAuthorization,
  vapidConfigFromEnv,
  webPushDataOf,
  webPushSenderFromEnv,
} from '../../src/notifications/push/web-push';
import type { VapidConfig, WebPushSubscription } from '../../src/notifications/push/web-push';

const ID = 'AbCdEfGhIjKlMnOpQrSt1234';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

/** A browser: the key pair of its subscription and the authentication secret. */
function browser(endpoint = ENDPOINT) {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = randomBytes(16);
  const subscription: WebPushSubscription = { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  return { keys, auth, subscription, token: JSON.stringify({ endpoint, expirationTime: null, keys: subscription.keys }) };
}

/** The decryption of RFC 8291 as the browser does it: its private key, the secret and the header of the message. */
function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  expect(recordSize).toBe(4096);
  expect(keyLength).toBe(65);
  const record = body.subarray(21 + keyLength);
  const shared = b.keys.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.keys.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(0x02);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function vapidWithRealPrivate(): { config: VapidConfig; publicKey: Buffer } {
  // A private scalar is 32 bytes; the generated one may be shorter when it starts with zero bytes, so pad on the left.
  let keys = createECDH('prime256v1');
  keys.generateKeys();
  while (keys.getPrivateKey().length !== 32) {
    keys = createECDH('prime256v1');
    keys.generateKeys();
  }
  return { config: { publicKey: keys.getPublicKey().toString('base64url'), privateKey: keys.getPrivateKey().toString('base64url'), subject: 'mailto:ops@example.vn' }, publicKey: keys.getPublicKey() };
}

const message = (token: string, extra: Partial<PushProviderMessage> = {}): PushProviderMessage => ({
  token,
  body: 'A dossier needs your attention.',
  data: { deep_link: `/r/${ID}` },
  silent: false,
  idempotencyKey: 'n1:PUSH_FCM:1:d1',
  ...extra,
});

describe('web push: the subscription of a browser', () => {
  it('reads the JSON of a PushSubscription, and nothing that is not one', () => {
    const b = browser();
    expect(parseWebPushSubscription(b.token)).toEqual({ endpoint: ENDPOINT, keys: b.subscription.keys });
    expect(isWebPushToken(b.token)).toBe(true);
    const refused = [
      'fcm-registration-token:APA91bE',
      '',
      '{',
      '[]',
      'null',
      JSON.stringify({ endpoint: 'http://fcm.googleapis.com/x', keys: b.subscription.keys }),
      JSON.stringify({ endpoint: 'https://user:pass@fcm.googleapis.com/x', keys: b.subscription.keys }),
      JSON.stringify({ endpoint: 'not a url', keys: b.subscription.keys }),
      JSON.stringify({ endpoint: ENDPOINT }),
      JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: 'short', auth: b.subscription.keys.auth } }),
      JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: b.subscription.keys.p256dh, auth: 'short' } }),
      JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: b.subscription.keys.auth } }),
      JSON.stringify({ endpoint: `https://fcm.googleapis.com/${'a'.repeat(3000)}`, keys: b.subscription.keys }),
    ];
    for (const token of refused) expect(parseWebPushSubscription(token)).toBeUndefined();
  });

  it('sends only to the push services of the browsers, never to an address a person made up', () => {
    for (const endpoint of [ENDPOINT, 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect(endpointAllowed(endpoint)).toBe(true);
    for (const endpoint of ['https://internal-service/', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com.example/x', 'https://notfcm.googleapis.com.attacker.vn', 'not a url']) expect(endpointAllowed(endpoint)).toBe(false);
    expect(endpointAllowed('https://push.example.vn/abc', allowedSuffixesFromEnv({ MACHVON_WEBPUSH_ALLOWED_HOSTS: ' push.example.vn ,bad host' }))).toBe(true);
    expect(allowedSuffixesFromEnv({})).toEqual(DEFAULT_PUSH_SERVICE_SUFFIXES);
  });
});

describe('web push: what a message carries (R7)', () => {
  it('writes the version, a generic title and the link, and nothing else', () => {
    expect(JSON.parse(webPushDataOf('A dossier needs your attention.', `/r/${ID}`))).toEqual({ v: 1, title: 'A dossier needs your attention.', url: `/r/${ID}` });
    expect(Object.keys(JSON.parse(webPushDataOf('x', '/m')) as object).sort()).toEqual(['title', 'url', 'v']);
    expect(JSON.parse(webPushDataOf(undefined, undefined))).toEqual({ v: 1, title: '', url: '/m' });
    for (const link of ['/m', '/m/approvals', '/m/dashboard', '/m/directives']) expect(JSON.parse(webPushDataOf('', link)).url).toBe(link);
  });

  it('drops a title that holds a figure, a code, a mail address or a word of money, and refuses a link that names a record', () => {
    for (const title of ['Duyệt 2.500.000.000 đồng', 'Báo cáo BC-2027-001', 'Gửi an@example.vn', 'Giải ngân 3 tỷ', 'Chi 5 triệu', 'Payment of $5', 'x'.repeat(61)]) {
      expect(isGenericTitle(title)).toBe(false);
      expect(JSON.parse(webPushDataOf(title, '/m')).title).toBe('');
    }
    for (const link of ['/projects/DA-001', '/m/approvals?task=1', 'https://evil.example/r/' + ID, '/r/short', '//evil.example', '/home/home-09']) {
      expect(() => webPushDataOf('x', link)).toThrow(DomainError);
    }
  });
});

describe('web push: the encryption of RFC 8291 and the signature of RFC 8292', () => {
  it('encrypts so that the browser, and only the browser, reads the message', () => {
    const b = browser();
    const payload = JSON.stringify({ v: 1, title: 'Việc mới', url: `/r/${ID}` });
    const body = encryptWebPushPayload(b.subscription, Buffer.from(payload, 'utf8'));
    // salt, record size, key length, key, then the payload with its delimiter and the tag of 16 bytes.
    expect(body.length).toBe(21 + 65 + Buffer.byteLength(payload) + 1 + 16);
    expect(body.includes(Buffer.from(payload))).toBe(false);
    expect(decrypt(body, b)).toBe(payload);
    const other = browser();
    expect(() => decrypt(body, other)).toThrow();
    const tampered = Buffer.from(body);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] as number) ^ 1;
    expect(() => decrypt(tampered, b)).toThrow();
  });

  it('uses a new key and a new salt for every message', () => {
    const b = browser();
    const one = encryptWebPushPayload(b.subscription, Buffer.from('same'));
    const two = encryptWebPushPayload(b.subscription, Buffer.from('same'));
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
  });

  it('refuses a payload that does not fit one record', () => {
    expect(() => encryptWebPushPayload(browser().subscription, Buffer.alloc(4000))).toThrow(DomainError);
  });

  it('signs the request with ES256 for the origin of the push service, for at most a day, and the signature verifies with the public key', () => {
    const { config, publicKey } = vapidWithRealPrivate();
    const header = vapidAuthorization(config, `${ENDPOINT}?x=1`, 1_800_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match as RegExpExecArray as unknown as [string, string, string, string, string];
    expect(k).toBe(config.publicKey);
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    expect(body).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:ops@example.vn' });
    expect(body.exp - 1_800_000_000).toBeLessThanOrEqual(24 * 3600);
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33, 65).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(verify('sha256', Buffer.from(`${head}.${claims}x`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(false);
  });
});

describe('web push: the keys of the deployment', () => {
  const { config } = vapidWithRealPrivate();

  it('reads the VAPID keys from the environment, or from a secret reference, and uses the stand-in when any is missing or malformed', () => {
    const direct = { MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: config.publicKey, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY: config.privateKey, MACHVON_WEBPUSH_SUBJECT: config.subject };
    expect(vapidConfigFromEnv(direct)).toEqual(config);
    expect(webPushSenderFromEnv(direct).mode).toBe('vapid');
    const byReference = { MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: config.publicKey, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_REF: 'secret://prod/webpush/vapid', MACHVON_SECRET_PROD_WEBPUSH_VAPID: config.privateKey, MACHVON_WEBPUSH_SUBJECT: 'https://pis.example.vn/contact' };
    expect(vapidConfigFromEnv(byReference)).toEqual({ ...config, subject: 'https://pis.example.vn/contact' });
    // A reference that names nothing the process can read is no key.
    expect(vapidConfigFromEnv({ ...byReference, MACHVON_SECRET_PROD_WEBPUSH_VAPID: undefined })).toBeUndefined();
    for (const broken of [{}, { ...direct, MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: undefined }, { ...direct, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY: undefined }, { ...direct, MACHVON_WEBPUSH_SUBJECT: undefined }, { ...direct, MACHVON_WEBPUSH_VAPID_PRIVATE_KEY: 'short' }, { ...direct, MACHVON_WEBPUSH_VAPID_PUBLIC_KEY: 'short' }, { ...direct, MACHVON_WEBPUSH_SUBJECT: 'ops@example.vn' }]) {
      expect(vapidConfigFromEnv(broken)).toBeUndefined();
      expect(webPushSenderFromEnv(broken).mode).toBe('mock');
    }
    expect(webPushSenderFromEnv({}).sender).toBeInstanceOf(MockWebPushSender);
  });
});

describe('web push: the real sender over a push service', () => {
  const { config } = vapidWithRealPrivate();

  function over(status: number, headers: Record<string, string> = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status, headers }));
    }) as unknown as typeof fetch;
    return { calls, sender: new VapidWebPushSender(config, http, () => 1_800_000_000_000) };
  }

  it('posts the encrypted message to the endpoint with the headers of the protocol, and the browser can read it', async () => {
    const b = browser();
    const world = over(201, { location: 'https://fcm.googleapis.com/message/42' });
    const payload = webPushDataOf('A dossier needs your attention.', `/r/${ID}`);
    const result = await world.sender.send(b.subscription, payload, { ttlSeconds: 86400, urgency: 'normal', topic: topicOf('k') });
    expect(result).toEqual({ status: 201, location: 'https://fcm.googleapis.com/message/42' });
    const [call] = world.calls as [(typeof world.calls)[number]];
    expect(call.url).toBe(ENDPOINT);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('86400');
    expect(headers.Urgency).toBe('normal');
    expect(headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers['Content-Length']).toBe(String((call.init.body as Uint8Array).length));
    expect(decrypt(Buffer.from(call.init.body as Uint8Array), b)).toBe(payload);
  });

  it('keeps the Retry-After of a push service that is busy', async () => {
    const result = await over(429, { 'retry-after': '120' }).sender.send(browser().subscription, '{}', { ttlSeconds: 1, urgency: 'low', topic: 't' });
    expect(result).toEqual({ status: 429, retryAfterSeconds: 120 });
  });

  it('says what each answer of the push service means in the codes of the engine', () => {
    expect(answerCodeOf({ status: 201, location: 'https://x/1' })).toEqual({ ok: true, messageId: 'https://x/1' });
    expect(answerCodeOf({ status: 202 })).toEqual({ ok: true, messageId: 'web-push-202' });
    expect(answerCodeOf({ status: 410 })).toEqual({ ok: false, code: 'UNREGISTERED' });
    expect(answerCodeOf({ status: 404 })).toEqual({ ok: false, code: 'UNREGISTERED' });
    expect(answerCodeOf({ status: 429 })).toEqual({ ok: false, code: 'QUOTA_EXCEEDED' });
    expect(answerCodeOf({ status: 503 })).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(answerCodeOf({ status: 401 })).toEqual({ ok: false, code: 'THIRD_PARTY_AUTH_ERROR' });
    expect(answerCodeOf({ status: 400 })).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(answerCodeOf({ status: 413 })).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
  });
});

describe('web push: the provider of the web devices', () => {
  it('sends the generic title and the link to the subscription, once for one idempotency key', async () => {
    const sender = new MockWebPushSender();
    const provider = new WebPushProvider(sender);
    const b = browser();
    const answer = await provider.send(message(b.token));
    expect(answer.ok).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(JSON.parse((sender.sent[0] as { payload: string }).payload)).toEqual({ v: 1, title: 'A dossier needs your attention.', url: `/r/${ID}` });
    expect((sender.sent[0] as { options: { topic: string } }).options.topic).toBe(topicOf('n1:PUSH_FCM:1:d1'));
    expect(topicOf('n1:PUSH_FCM:1:d1')).toHaveLength(32);
  });

  it('puts nothing but the three members on the wire, whatever the message held besides', async () => {
    const sender = new MockWebPushSender();
    const provider = new WebPushProvider(sender);
    await provider.send(message(browser().token, { body: 'Duyệt 2.500.000.000 đồng của Nguyễn Văn A', data: { deep_link: `/r/${ID}`, amount: '2500000000', name: 'Nguyễn Văn A' } }));
    const wire = (sender.sent[0] as { payload: string }).payload;
    expect(Object.keys(JSON.parse(wire) as object).sort()).toEqual(['title', 'url', 'v']);
    expect(wire).not.toMatch(/2\.?500|Nguyễn|amount|name/);
  });

  it('does not send a silent message: a browser shows a notice of its own for a push that shows nothing', async () => {
    const sender = new MockWebPushSender();
    const answer = await new WebPushProvider(sender).send(message(browser().token, { silent: true, data: { kind: 'refresh', what: 'entitlements' } }));
    expect(answer).toEqual({ ok: true, messageId: 'web-push-silent-not-sent' });
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses a token that is not a subscription, an endpoint that is not a push service and a link that names a record, without calling anyone', async () => {
    const sender = new MockWebPushSender();
    const provider = new WebPushProvider(sender);
    expect(await provider.send(message('fcm-token'))).toEqual({ ok: false, code: 'INVALID_ARGUMENT_TOKEN' });
    expect(await provider.send(message(browser('https://internal-service/hook').token))).toEqual({ ok: false, code: 'INVALID_ARGUMENT_TOKEN' });
    expect(await provider.send(message(browser().token, { data: { deep_link: '/projects/DA-001' } }))).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(sender.sent).toHaveLength(0);
  });

  it('answers a cancelled subscription as a token nobody knows, an outage as retryable and a sender that throws as unavailable', async () => {
    const sender = new MockWebPushSender();
    const provider = new WebPushProvider(sender);
    const b = browser();
    sender.answerFor(b.subscription.endpoint, { status: 410 });
    expect(await provider.send(message(b.token))).toEqual({ ok: false, code: 'UNREGISTERED' });
    sender.recover();
    sender.failAll({ status: 503 });
    expect(await provider.send(message(b.token))).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const throwing = new WebPushProvider({ send: () => Promise.reject(new Error('network')) });
    expect(await throwing.send(message(b.token))).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('serves the PUSH_FCM channel beside Android: a subscription goes to the web provider, every other token to the native one, and a dead subscription revokes its device', async () => {
    const native = new MockPushProvider();
    const sender = new MockWebPushSender();
    const adapter = new PushChannelAdapter('mock-fcm', 'PUSH_FCM', new WebAwarePushProvider(native, new WebPushProvider(sender)));
    const web = browser();
    const gone = browser('https://updates.push.services.mozilla.com/wpush/v2/gone');
    sender.answerFor(gone.subscription.endpoint, { status: 410 });
    const request = { idempotencyKey: 'n1:PUSH_FCM:1', to: '', accountId: 'acct', text: 'A dossier needs your attention.', deepLink: `/r/${ID}` };
    assertLockScreenSafe(request.text, request.deepLink);
    const result = await adapter.send({ ...request, targets: [{ deviceId: 'phone', token: 'android-token' }, { deviceId: 'browser', token: web.token }, { deviceId: 'old-browser', token: gone.token }] });
    expect(result).toMatchObject({ kind: 'ACCEPTED', deadTargets: ['old-browser'] });
    expect(native.sent.map((sent) => sent.token)).toEqual(['android-token']);
    expect(sender.sent.map((sent) => sent.endpoint).sort()).toEqual([ENDPOINT, 'https://updates.push.services.mozilla.com/wpush/v2/gone'].sort());
  });

  it('is the provider of the channel in the default adapters outside production, and the registry stays MOCK', async () => {
    const registry = defaultChannelAdapters('test', {});
    expect(registry.forChannel('PUSH_FCM')?.status).toBe('MOCK');
    const result = await registry.forChannel('PUSH_FCM')?.send({ idempotencyKey: 'k', to: '', accountId: 'a', text: 'A dossier needs your attention.', deepLink: `/r/${ID}`, targets: [{ deviceId: 'd', token: browser().token }] });
    expect(result?.kind).toBe('ACCEPTED');
    expect(defaultChannelAdapters('production', {}).forChannel('PUSH_FCM')).toBeUndefined();
  });
});
