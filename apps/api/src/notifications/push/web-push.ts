/**
 * Web push for the installed manager application (PWA, YCK.01, eng review R7): the server side of the subscription a browser makes with the push API.
 * It follows the pattern of the other push providers (docs/not-push.md): a port that makes one call for one device (`PushProviderPort`), a stand-in (MOCK)
 * that records what it was asked to send, and a real sender that is used only when the VAPID keys are configured. The real sender is written from RFC 8030
 * (the protocol), RFC 8291 (message encryption, `aes128gcm`) and RFC 8292 (VAPID) and is VERIFIED only after a sandbox spike against the real push services
 * of the browsers, so the channel stays MOCK (never active in production) until then, like FCM and APNs.
 *
 * A web device is a device registration of platform `web` whose token is its subscription (a JSON with the endpoint and the two keys, kept in the vault of
 * the push tokens like any other token): there is no second store, the registration, the revocation, the retention and the audit of devices serve it.
 *
 * What a web push carries is the rule of the product (design.md, R7): a generic title and a link, never an amount or a name. `webPushDataOf` writes
 * `{"v":1,"title":"...","url":"..."}` and refuses anything else, and the worker of the browser reads it again with the same rule (`apps/web/src/pwa/push-payload.ts`).
 */
import { createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign, createCipheriv } from 'node:crypto';
import { DomainError, OPAQUE_LINK } from '@machvon/kernel';
import type { PushProviderAnswer, PushProviderMessage, PushProviderPort } from './ports';

/** The platform a web subscription is registered under (`registerDevice`, `platform: 'web'`). */
export const WEB_PLATFORM = 'web';

// ---- the subscription ----------------------------------------------------------------------------------------------------------------------------------

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const decodeKey = (value: unknown, bytes: number): Buffer | undefined => {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes ? decoded : undefined;
};

/**
 * A subscription from the token of a device: the JSON that `PushSubscription.toJSON()` gives, with an `https` endpoint, the public key of the browser (an
 * uncompressed P-256 point: 65 bytes starting with 0x04) and the authentication secret (16 bytes). Anything else is undefined, so a token of another kind
 * (a Firebase registration token) is never taken for a subscription.
 */
export function parseWebPushSubscription(token: string): WebPushSubscription | undefined {
  if (!token.trimStart().startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { endpoint, keys } = parsed as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || keys === null || typeof keys !== 'object' || keys === undefined) return undefined;
  const key = decodeKey(keys.p256dh, 65);
  const auth = decodeKey(keys.auth, 16);
  if (key === undefined || key[0] !== 0x04 || auth === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  return { endpoint: url.href, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } };
}

export const isWebPushToken = (token: string): boolean => parseWebPushSubscription(token) !== undefined;

/**
 * The push services the browsers use. A subscription names an address the browser chose, and the server will POST to it, so an address that is not one of
 * these is refused (the device is revoked as a token nobody knows): a person who registers `https://internal-service/` makes the server call nothing.
 * Other hosts are added with `MACHVON_WEBPUSH_ALLOWED_HOSTS` (comma separated suffixes, for example a push service of a domestic browser).
 */
export const DEFAULT_PUSH_SERVICE_SUFFIXES: readonly string[] = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

export function endpointAllowed(endpoint: string, suffixes: readonly string[] = DEFAULT_PUSH_SERVICE_SUFFIXES): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// ---- the payload -------------------------------------------------------------------------------------------------------------------------------------

/** The links a web push may open: the opaque link of a notification, or a start page of the manager screens. */
export const MANAGER_START_PATHS: readonly string[] = ['/m', '/m/approvals', '/m/dashboard', '/m/directives'];
export const TITLE_MAX = 60;
const MONEY_WORDS = /(?:vnd|vnđ|usd|đồng|dong|tỷ|ty\s|triệu|trieu|nghìn|billion|million|thousand|₫|\$)/i;
const IDENTIFYING = /(?:@|\d|[A-Z]{2,}-[A-Z0-9]+)/;

/** A title is generic when it is a short phrase with no digit, no code, no mail address and no word of money. */
export function isGenericTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= TITLE_MAX && !IDENTIFYING.test(trimmed) && !MONEY_WORDS.test(trimmed);
}

export const isSafeWebLink = (link: string): boolean => OPAQUE_LINK.test(link) || MANAGER_START_PATHS.includes(link);

/**
 * The data of a web push: the version, a generic title (the neutral sentence of the template when it is generic, else none: the worker then shows the name
 * of the product) and the link. A link that names a record is refused here as the last look before the push service (the template is judged when it is
 * written, and again by `assertLockScreenSafe`); nothing else can be put in the message because there is no other member.
 */
export function webPushDataOf(title: string | undefined, link: string | undefined): string {
  const url = link === undefined || link === '' ? '/m' : link;
  if (!isSafeWebLink(url)) throw new DomainError('TEMPLATE_INVALID', 422, 'lockscreen_link');
  const text = (title ?? '').trim();
  return JSON.stringify({ v: 1, title: isGenericTitle(text) ? text : '', url });
}

// ---- the sender --------------------------------------------------------------------------------------------------------------------------------------

export interface WebPushSendOptions {
  /** Seconds the push service keeps the message for a browser that is offline. */
  ttlSeconds: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** A message with the same topic replaces the one that waits (RFC 8030): the idempotency key of the send, shortened. */
  topic: string;
}

/** What the push service answered. */
export interface WebPushSendResult {
  status: number;
  retryAfterSeconds?: number;
  /** The `Location` of the message the service created (its id). */
  location?: string;
}

export interface WebPushSender {
  send(subscription: WebPushSubscription, payload: string, options: WebPushSendOptions): Promise<WebPushSendResult>;
}

/** The stand-in: it records what it was asked to send (the data as the browser would receive it) and accepts, unless a test says the push service refuses. */
export class MockWebPushSender implements WebPushSender {
  readonly sent: Array<{ endpoint: string; payload: string; options: WebPushSendOptions }> = [];
  private readonly answers = new Map<string, WebPushSendResult>();
  private outage: WebPushSendResult | undefined;

  /** The endpoint answers with this result from now on (`{status: 410}` for a subscription that was cancelled). */
  answerFor(endpoint: string, result: WebPushSendResult): void {
    this.answers.set(endpoint, result);
  }

  failAll(result: WebPushSendResult): void {
    this.outage = result;
  }

  recover(): void {
    this.outage = undefined;
    this.answers.clear();
  }

  async send(subscription: WebPushSubscription, payload: string, options: WebPushSendOptions): Promise<WebPushSendResult> {
    this.sent.push({ endpoint: subscription.endpoint, payload, options });
    return this.outage ?? this.answers.get(subscription.endpoint) ?? { status: 201, location: `https://mock.push.invalid/message/${this.sent.length}` };
  }
}

// ---- the encryption of RFC 8291 and the signature of RFC 8292 -------------------------------------------------------------------------------------------

const RECORD_SIZE = 4096;
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

export interface EncryptionInputs {
  /** The ephemeral key pair of the sender; random for a message, fixed by a test. */
  senderKeys?: { publicKey: Buffer; computeSecret(peer: Buffer): Buffer };
  salt?: Buffer;
}

/**
 * The body of a web push message: `aes128gcm` content coding (RFC 8188) keyed as RFC 8291 says. The header is the salt (16 bytes), the record size
 * (4 bytes), the length of the sender key (1 byte) and the sender key (65 bytes); the one record holds the payload, the delimiter 0x02 and the tag.
 */
export function encryptWebPushPayload(subscription: WebPushSubscription, payload: Buffer, inputs: EncryptionInputs = {}): Buffer {
  if (payload.length > RECORD_SIZE - 17 - 86) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
  const userAgentPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const generated = inputs.senderKeys === undefined ? createECDH('prime256v1') : undefined;
  generated?.generateKeys();
  const senderPublic = inputs.senderKeys?.publicKey ?? (generated as ReturnType<typeof createECDH>).getPublicKey();
  const shared = inputs.senderKeys === undefined ? (generated as ReturnType<typeof createECDH>).computeSecret(userAgentPublic) : inputs.senderKeys.computeSecret(userAgentPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), userAgentPublic, senderPublic]);
  const inputKeyingMaterial = hkdf(shared, authSecret, keyInfo, 32);
  const salt = inputs.salt ?? randomBytes(16);
  const contentKey = hkdf(inputKeyingMaterial, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(inputKeyingMaterial, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, record]);
}

export interface VapidConfig {
  /** The public key of the application server: an uncompressed P-256 point, base64url (the web build is given the same value as `VITE_WEBPUSH_VAPID_PUBLIC_KEY`). */
  publicKey: string;
  /** The private key: the 32-byte scalar, base64url. Read from the environment or from a secret reference, never stored in the database or logged. */
  privateKey: string;
  /** A contact for the push services, `mailto:` or `https:` (RFC 8292). */
  subject: string;
}

const b64u = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** The `Authorization` header of a VAPID request to a push service: a JWT signed with ES256 for the origin of the endpoint, valid for twelve hours. */
export function vapidAuthorization(config: VapidConfig, endpoint: string, nowSeconds: number): string {
  const audience = new URL(endpoint).origin;
  const publicKey = Buffer.from(config.publicKey, 'base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: config.privateKey, x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)) } });
  const unsigned = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: config.subject }))}`;
  const signature = sign('sha256', Buffer.from(unsigned, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${config.publicKey}`;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** The real sender: encrypts the message, signs the request with the VAPID key and POSTs it to the endpoint of the subscription. */
export class VapidWebPushSender implements WebPushSender {
  constructor(
    private readonly config: VapidConfig,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(subscription: WebPushSubscription, payload: string, options: WebPushSendOptions): Promise<WebPushSendResult> {
    const body = encryptWebPushPayload(subscription, Buffer.from(payload, 'utf8'));
    const response = await this.http(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(this.config, subscription.endpoint, Math.floor(this.now() / 1000)),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        TTL: String(options.ttlSeconds),
        Urgency: options.urgency,
        Topic: options.topic,
      },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const retryAfter = Number(response.headers.get('retry-after'));
    return {
      status: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      ...(response.headers.get('location') === null ? {} : { location: response.headers.get('location') as string }),
    };
  }
}

// ---- the configuration -------------------------------------------------------------------------------------------------------------------------------

type Environment = Readonly<Record<string, string | undefined>>;

/** `secret://<environment>/<path>` is the variable `MACHVON_SECRET_<ENVIRONMENT>_<PATH>`, the convention of the webhook secrets, until the vault of the platform is deployed. */
const secretVariable = (reference: string): string => `MACHVON_SECRET_${reference.replace(/^secret:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

/**
 * The VAPID keys of the deployment, or undefined when they are not all set (the stand-in is used). The public key is in `MACHVON_WEBPUSH_VAPID_PUBLIC_KEY`;
 * the private key is in `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY`, or named by a vault reference in `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_REF`; the contact is
 * `MACHVON_WEBPUSH_SUBJECT`. A key that is not a P-256 key of the right size counts as not set.
 */
export function vapidConfigFromEnv(env: Environment): VapidConfig | undefined {
  const publicKey = env.MACHVON_WEBPUSH_VAPID_PUBLIC_KEY?.trim();
  const reference = env.MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_REF?.trim();
  const privateKey = (reference === undefined || reference === '' ? env.MACHVON_WEBPUSH_VAPID_PRIVATE_KEY : env[secretVariable(reference)])?.trim();
  const subject = env.MACHVON_WEBPUSH_SUBJECT?.trim();
  if (publicKey === undefined || privateKey === undefined || subject === undefined) return undefined;
  if (decodeKey(publicKey, 65)?.[0] !== 0x04 || decodeKey(privateKey, 32) === undefined) return undefined;
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) return undefined;
  return { publicKey, privateKey, subject };
}

export function allowedSuffixesFromEnv(env: Environment): readonly string[] {
  const extra = (env.MACHVON_WEBPUSH_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((suffix) => suffix.trim().toLowerCase())
    .filter((suffix) => /^[a-z0-9.-]+$/.test(suffix) && suffix !== '');
  return [...DEFAULT_PUSH_SERVICE_SUFFIXES, ...extra];
}

/** The sender of the deployment: the real one when the VAPID keys are configured, else the stand-in. */
export function webPushSenderFromEnv(env: Environment): { sender: WebPushSender; mode: 'vapid' | 'mock' } {
  const config = vapidConfigFromEnv(env);
  return config === undefined ? { sender: new MockWebPushSender(), mode: 'mock' } : { sender: new VapidWebPushSender(config), mode: 'vapid' };
}

// ---- the provider -----------------------------------------------------------------------------------------------------------------------------------

const TTL_SECONDS = 24 * 3600;

/** The topic of a send: a hash of its idempotency key in the 32 characters RFC 8030 allows, so a repeated send replaces the message that waits instead of ringing twice. */
export const topicOf = (idempotencyKey: string): string => createHash('sha256').update(idempotencyKey, 'utf8').digest('base64url').slice(0, 32);

/** The answer of a push service in the codes of the engine (`classifyFcmError`): a cancelled subscription is a token nobody knows, an outage is tried again. */
export function answerCodeOf(result: WebPushSendResult): PushProviderAnswer {
  if (result.status >= 200 && result.status < 300) return { ok: true, messageId: result.location ?? `web-push-${result.status}` };
  if (result.status === 404 || result.status === 410) return { ok: false, code: 'UNREGISTERED' };
  if (result.status === 429) return { ok: false, code: 'QUOTA_EXCEEDED' };
  if (result.status >= 500) return { ok: false, code: 'UNAVAILABLE' };
  if (result.status === 401 || result.status === 403) return { ok: false, code: 'THIRD_PARTY_AUTH_ERROR' };
  return { ok: false, code: 'INVALID_ARGUMENT' };
}

/** The provider of the web devices over a sender: one call for one device, in the words of `PushProviderPort`. */
export class WebPushProvider implements PushProviderPort {
  constructor(
    private readonly sender: WebPushSender,
    private readonly allowedSuffixes: readonly string[] = DEFAULT_PUSH_SERVICE_SUFFIXES,
  ) {}

  async send(message: PushProviderMessage): Promise<PushProviderAnswer> {
    // A silent message shows nothing, and a browser must show something for every push it receives (`userVisibleOnly`): a silent push to a web device
    // would put a notice of the browser's own on the screen. The page reads the entitlements again whenever it is opened, so none is sent.
    if (message.silent) return { ok: true, messageId: 'web-push-silent-not-sent' };
    const subscription = parseWebPushSubscription(message.token);
    // A token that is not a subscription, or an address that is not a push service, is a token nobody knows: the device is revoked.
    if (subscription === undefined || !endpointAllowed(subscription.endpoint, this.allowedSuffixes)) return { ok: false, code: 'INVALID_ARGUMENT_TOKEN' };
    let payload: string;
    try {
      payload = webPushDataOf(message.body, message.data.deep_link);
    } catch {
      return { ok: false, code: 'INVALID_ARGUMENT' };
    }
    try {
      return answerCodeOf(await this.sender.send(subscription, payload, { ttlSeconds: TTL_SECONDS, urgency: 'normal', topic: topicOf(message.idempotencyKey) }));
    } catch {
      // The push service could not be reached: tried again.
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }
}

/**
 * The provider of the PUSH_FCM channel, which serves Android and the web (PLATFORMS_OF_CHANNEL): a token that is a web subscription goes to the web
 * provider, every other token to the native one. The channel, the vault, the revocation and the audit are the ones every push already has.
 */
export class WebAwarePushProvider implements PushProviderPort {
  constructor(
    private readonly native: PushProviderPort,
    private readonly web: PushProviderPort,
  ) {}

  send(message: PushProviderMessage): Promise<PushProviderAnswer> {
    return isWebPushToken(message.token) ? this.web.send(message) : this.native.send(message);
  }
}
