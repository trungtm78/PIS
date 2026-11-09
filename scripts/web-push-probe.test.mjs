import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes, verify, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encryptPayload, generateVapidKeys, main, readSubscription, vapidHeader, verdictOf } from './web-push-probe.mjs';

function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = randomBytes(16);
  return { keys, auth, subscription: { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

function decrypt(body, b) {
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body.readUInt8(20));
  const record = body.subarray(21 + body.readUInt8(20));
  const ikm = Buffer.from(hkdfSync('sha256', b.keys.computeSecret(senderPublic), b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.keys.getPublicKey(), senderPublic]), 32));
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

test('the body decrypts the way a browser does it', () => {
  const b = browser();
  assert.equal(decrypt(encryptPayload(b.subscription, '{"v":1,"title":"","url":"/m"}'), b), '{"v":1,"title":"","url":"/m"}');
});

test('the VAPID header verifies with the public key', () => {
  const keys = generateVapidKeys();
  const header = vapidHeader({ ...keys, subject: 'mailto:ops@example.vn' }, 'https://fcm.googleapis.com/fcm/send/abc', 1_800_000_000);
  const [, jwt, k] = /^vapid t=(\S+), k=(\S+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = jwt.split('.');
  const point = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://fcm.googleapis.com');
});

test('a subscription of another host, of http or of the wrong key size is refused', () => {
  const b = browser();
  assert.ok(readSubscription(JSON.stringify(b.subscription)));
  assert.throws(() => readSubscription(JSON.stringify({ ...b.subscription, endpoint: 'https://internal.example.vn/x' })), /not a known push service/);
  assert.throws(() => readSubscription(JSON.stringify({ ...b.subscription, endpoint: 'http://fcm.googleapis.com/x' })), /https/);
  assert.throws(() => readSubscription(JSON.stringify({ ...b.subscription, keys: { ...b.subscription.keys, auth: 'AA' } })), /auth/);
  assert.ok(readSubscription(JSON.stringify({ ...b.subscription, endpoint: 'https://push.example.vn/x' }), ['example.vn']));
});

test('the verdicts name what to do', () => {
  assert.match(verdictOf(201), /^ACCEPTED/);
  assert.match(verdictOf(410), /^GONE/);
  assert.match(verdictOf(429), /^QUOTA/);
  assert.match(verdictOf(403), /^AUTH/);
  assert.match(verdictOf(503), /^UNAVAILABLE/);
});

test('keygen writes the private key to a file and prints only the public one; send posts to the push service and reports the verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-probe-'));
  const lines = [];
  const io = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const privateFile = join(dir, 'private.key');
  assert.equal(await main(['keygen', '--out-private', privateFile], io), 0);
  const publicKey = /: (\S+)$/m.exec(lines[0])[1];
  assert.equal(lines.join('\n').includes(readFileSync(privateFile, 'utf8').trim()), false);
  await assert.rejects(() => main(['keygen', '--out-private', privateFile], io), /EEXIST/);

  const b = browser();
  const subscriptionFile = join(dir, 'sub.json');
  writeFileSync(subscriptionFile, JSON.stringify(b.subscription));
  const seen = [];
  const http = async (url, init) => {
    seen.push({ url, init });
    return new Response(null, { status: 201, headers: { location: 'https://push.example/m/1' } });
  };
  lines.length = 0;
  const code = await main(['send', '--subscription', subscriptionFile, '--public-key', publicKey, '--private-key-file', privateFile, '--subject', 'mailto:ops@example.vn', '--urgency', 'high', '--ttl', '120'], io, http);
  assert.equal(code, 0);
  assert.equal(seen[0].url, b.subscription.endpoint);
  assert.equal(seen[0].init.headers.Urgency, 'high');
  assert.equal(seen[0].init.headers.TTL, '120');
  assert.equal(decrypt(Buffer.from(seen[0].init.body), b), '{"v":1,"title":"","url":"/m"}');
  const text = lines.join('\n');
  assert.match(text, /status:\s+201/);
  assert.match(text, /verdict:\s+ACCEPTED/);
  assert.equal(text.includes(b.subscription.keys.auth), false);
  assert.equal(text.includes(b.subscription.keys.p256dh), false);
  const failing = await main(['send', '--subscription', subscriptionFile, '--public-key', publicKey, '--private-key-file', privateFile, '--subject', 'mailto:ops@example.vn'], io, async () => new Response(null, { status: 410 }));
  assert.equal(failing, 1);
});
