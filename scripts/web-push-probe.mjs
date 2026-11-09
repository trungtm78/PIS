#!/usr/bin/env node
/**
 * Live check of the web-push channel against a real subscription (docs/runbooks/web-push-spike.md).
 *
 *   node scripts/web-push-probe.mjs keygen --out-private /secure/path/vapid-private.key        make a VAPID key pair (the private key goes to a file, mode 600)
 *   node scripts/web-push-probe.mjs send --subscription sub.json --public-key <b64url> \
 *        --private-key-file /secure/path/vapid-private.key --subject mailto:ops@example.vn   send one push to the subscription in sub.json
 *
 * The subscription is the JSON a browser gives (`PushSubscription.toJSON()`), saved to a file on this machine; it is never printed, committed or sent anywhere but its push
 * service. The message is the same shape the server sends (`{"v":1,"title":"","url":"/m"}`): no amount, no name. Nothing here needs a dependency: RFC 8291 (aes128gcm)
 * and RFC 8292 (VAPID, ES256) are written with node:crypto and the platform fetch, the same as apps/api/src/notifications/push/web-push.ts.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RECORD_SIZE = 4096;
const SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const b64u = (value) => Buffer.from(value).toString('base64url');
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/** A VAPID key pair: the public key (uncompressed P-256 point) and the private scalar (32 bytes), both base64url. */
export function generateVapidKeys() {
  for (;;) {
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    if (keys.getPrivateKey().length === 32) return { publicKey: b64u(keys.getPublicKey()), privateKey: b64u(keys.getPrivateKey()) };
  }
}

/** The body of a push (RFC 8291, one record). `fixed` lets a test pin the sender key and the salt. */
export function encryptPayload(subscription, payload, fixed = {}) {
  const userAgentPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = fixed.ecdh ?? createECDH('prime256v1');
  if (fixed.ecdh === undefined) ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(userAgentPublic);
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, senderPublic]), 32);
  const salt = fixed.salt ?? randomBytes(16);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, record]);
}

/** The `Authorization` header of a VAPID request (RFC 8292). */
export function vapidHeader({ publicKey, privateKey, subject }, endpoint, nowSeconds = Math.floor(Date.now() / 1000)) {
  const point = Buffer.from(publicKey, 'base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) } });
  const unsigned = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject }))}`;
  return `vapid t=${unsigned}.${b64u(sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }))}, k=${publicKey}`;
}

/** What the answer of a push service means for the channel, in the words of the runbook. */
export function verdictOf(status) {
  if (status >= 200 && status < 300) return 'ACCEPTED: the push service took the message (the device shows it only if the browser is running and the permission is granted)';
  if (status === 404 || status === 410) return 'GONE: the subscription no longer exists; the server revokes such a device';
  if (status === 429) return 'QUOTA: the service asks to slow down (Retry-After)';
  if (status === 401 || status === 403) return 'AUTH: the VAPID key is not the one the subscription was made with, or the claims are wrong';
  if (status === 400 || status === 413) return 'REFUSED: the message or the headers are malformed';
  if (status >= 500) return 'UNAVAILABLE: the push service is down; the server tries again';
  return `OTHER: ${status}`;
}

/** The subscription of a file, checked for shape and for the address (a push service of a browser, https). Never echoes the keys. */
export function readSubscription(text, extraSuffixes = []) {
  const parsed = JSON.parse(text);
  const url = new URL(parsed.endpoint);
  if (url.protocol !== 'https:') throw new Error('the endpoint must be https');
  const suffixes = [...SUFFIXES, ...extraSuffixes];
  if (!suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw new Error(`the host ${url.hostname} is not a known push service (use --allow-host to add one)`);
  if (Buffer.from(parsed.keys?.p256dh ?? '', 'base64url').length !== 65) throw new Error('keys.p256dh must be a 65-byte P-256 point');
  if (Buffer.from(parsed.keys?.auth ?? '', 'base64url').length !== 16) throw new Error('keys.auth must be 16 bytes');
  return { endpoint: url.href, keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth } };
}

function argsOf(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
    else out._.push(arg);
  }
  return out;
}

export async function main(argv, io = { log: console.log, error: console.error }, http = fetch) {
  const args = argsOf(argv);
  const command = args._[0];
  if (command === 'keygen') {
    if (typeof args['out-private'] !== 'string') throw new Error('keygen needs --out-private <file> (the private key is written there, not printed)');
    const keys = generateVapidKeys();
    writeFileSync(args['out-private'], `${keys.privateKey}\n`, { mode: 0o600, flag: 'wx' });
    io.log(`public key (set MACHVON_WEBPUSH_VAPID_PUBLIC_KEY and VITE_WEBPUSH_VAPID_PUBLIC_KEY): ${keys.publicKey}`);
    io.log(`private key written to ${args['out-private']} (set MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_FILE to it; never commit it)`);
    return 0;
  }
  if (command !== 'send') {
    io.error('usage: web-push-probe.mjs keygen --out-private <file> | send --subscription <file> --public-key <b64url> --private-key-file <file> --subject <mailto:|https:> [--title t] [--url /m] [--urgency normal] [--ttl 60] [--allow-host suffix]');
    return 2;
  }
  for (const name of ['subscription', 'public-key', 'private-key-file', 'subject']) if (typeof args[name] !== 'string') throw new Error(`--${name} is required`);
  const subscription = readSubscription(readFileSync(args.subscription, 'utf8'), typeof args['allow-host'] === 'string' ? [args['allow-host']] : []);
  const config = { publicKey: args['public-key'], privateKey: readFileSync(args['private-key-file'], 'utf8').trim(), subject: args.subject };
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(config.subject)) throw new Error('--subject must be mailto: or https:');
  const title = typeof args.title === 'string' ? args.title : '';
  const url = typeof args.url === 'string' ? args.url : '/m';
  const body = encryptPayload(subscription, JSON.stringify({ v: 1, title, url }));
  const urgency = typeof args.urgency === 'string' ? args.urgency : 'normal';
  if (!['very-low', 'low', 'normal', 'high'].includes(urgency)) throw new Error('--urgency must be very-low, low, normal or high');
  const started = Date.now();
  const response = await http(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(config, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(Number(args.ttl ?? 60)),
      Urgency: urgency,
      Topic: b64u(randomBytes(12)),
    },
    body: new Uint8Array(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  io.log(`host:       ${new URL(subscription.endpoint).hostname}`);
  io.log(`status:     ${response.status} in ${Date.now() - started} ms`);
  io.log(`location:   ${response.headers.get('location') ?? '-'}`);
  io.log(`retry-after:${response.headers.get('retry-after') ?? '-'}`);
  io.log(`verdict:    ${verdictOf(response.status)}`);
  io.log('Now look at the device: the notification must appear within a minute with the fixed sentence of the application and open the link when tapped.');
  return response.status >= 200 && response.status < 300 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`web-push-probe: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    },
  );
}
