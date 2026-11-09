import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { ChannelSendRequest } from '@machvon/kernel';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';
import { SMTP_PROVIDER, SmtpChannelAdapter, mimeMessage, smtpAdapterFromEnv, smtpConfigFromEnv } from '../../src/notifications/delivery/smtp-adapter';
import type { SmtpConfig } from '../../src/notifications/delivery/smtp-adapter';
import { FakeSmtpServer, localhostCertificate } from './support/fake-smtp';
import type { FakeSmtpScript } from './support/fake-smtp';

const certificate = localhostCertificate();
const RELAY_SECRET = `s-${randomUUID()}`;
const NOW = new Date('2027-10-05T03:00:00.000Z');
const VIETNAMESE_SUBJECT = 'Nhắc việc: hạn nhập số liệu kỳ tháng 9';
const BODY = 'Xin chào,\n.Dòng này bắt đầu bằng dấu chấm.\nHạn nhập liệu là ngày 05/10.';

const request = (over: Partial<ChannelSendRequest> = {}): ChannelSendRequest => ({
  idempotencyKey: '7f3c2a10-0000-4000-8000-000000000001:EMAIL:1',
  to: 'nguoi.nhap@example.com',
  subject: VIETNAMESE_SUBJECT,
  text: BODY,
  accountId: 'acct-1',
  ...over,
});

const configFor = (port: number, over: Partial<SmtpConfig> = {}): SmtpConfig => ({ host: 'localhost', port, security: 'NONE', from: 'khdt@example.com', fromName: 'Ban KHĐT', helo: 'machvon.test', timeoutMs: 3000, ...over });

async function withRelay<T>(script: FakeSmtpScript, work: (relay: FakeSmtpServer) => Promise<T>): Promise<T> {
  const relay = new FakeSmtpServer(script);
  await relay.start();
  try {
    return await work(relay);
  } finally {
    await relay.stop();
  }
}

const decodeBody = (message: string): string => Buffer.from(message.slice(message.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('SmtpChannelAdapter (a real SMTP relay on the e-mail channel, YCK.01 and QT.02)', () => {
  it('delivers over a connection that starts encrypted and verifies the certificate of the relay', async () => {
    await withRelay({ mode: 'tls', tls: certificate }, async (relay) => {
      const adapter = new SmtpChannelAdapter(configFor(relay.port, { security: 'TLS', ca: certificate.cert }), 'MOCK', () => NOW);
      const result = await adapter.send(request());
      expect(result).toEqual({ kind: 'ACCEPTED', providerMessageId: '<7f3c2a10-0000-4000-8000-000000000001.EMAIL.1@example.com>' });
      expect(relay.transcript.commands).toEqual(['EHLO machvon.test', 'MAIL FROM:<khdt@example.com>', 'RCPT TO:<nguoi.nhap@example.com>', 'DATA', 'QUIT']);
      expect(relay.transcript.secure.every(Boolean)).toBe(true);
      const message = relay.transcript.messages[0] as string;
      expect(message).toContain('To: nguoi.nhap@example.com');
      expect(message).toContain('Content-Transfer-Encoding: base64');
      expect(decodeBody(message)).toBe(BODY.replace(/\n/g, '\r\n'));
    });
  });

  it('refuses a certificate it does not trust: nothing is sent and the failure can be tried again', async () => {
    await withRelay({ mode: 'tls', tls: certificate }, async (relay) => {
      const result = await new SmtpChannelAdapter(configFor(relay.port, { security: 'TLS' }), 'MOCK').send(request());
      expect(result).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_TLS_FAILED' });
      expect(relay.transcript.commands).toEqual([]);
    });
  });

  it('upgrades with STARTTLS before it sends a password, and sends the password only afterwards', async () => {
    await withRelay({ mode: 'starttls', tls: certificate, account: { user: 'machvon', password: RELAY_SECRET } }, async (relay) => {
      const adapter = new SmtpChannelAdapter(configFor(relay.port, { security: 'STARTTLS', ca: certificate.cert, user: 'machvon', password: RELAY_SECRET }), 'MOCK', () => NOW);
      expect((await adapter.send(request())).kind).toBe('ACCEPTED');
      expect(relay.transcript.commands.slice(0, 4)).toEqual(['EHLO machvon.test', 'STARTTLS', 'EHLO machvon.test', 'AUTH PLAIN <credentials>']);
      // The first EHLO and the STARTTLS command were read in clear text; everything after the upgrade, the password included, was encrypted.
      expect(relay.transcript.secure.slice(0, 4)).toEqual([false, false, true, true]);
      expect(relay.transcript.authenticated).toEqual(['machvon']);
    });
  });

  it('does not send a password over a connection that is not encrypted, unless the operator allowed it, and then falls back to LOGIN', async () => {
    await withRelay({ mode: 'none', account: { user: 'machvon', password: RELAY_SECRET }, advertiseLogin: true }, async (relay) => {
      const config = configFor(relay.port, { user: 'machvon', password: RELAY_SECRET });
      expect(await new SmtpChannelAdapter(config, 'MOCK').send(request())).toEqual({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_AUTH_FAILED' });
      expect(relay.transcript.authenticated).toEqual([]);
      expect(relay.transcript.commands.some((line) => line.startsWith('AUTH'))).toBe(false);
      expect((await new SmtpChannelAdapter({ ...config, allowInsecureAuth: true }, 'MOCK').send(request())).kind).toBe('ACCEPTED');
      expect(relay.transcript.authenticated).toEqual(['machvon']);
    });
  });

  it('reports a wrong password as a failure for good', async () => {
    await withRelay({ mode: 'none', account: { user: 'machvon', password: RELAY_SECRET } }, async (relay) => {
      const adapter = new SmtpChannelAdapter(configFor(relay.port, { user: 'machvon', password: `${RELAY_SECRET}-x`, allowInsecureAuth: true }), 'MOCK');
      expect(await adapter.send(request())).toEqual({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_AUTH_FAILED' });
    });
  });

  it.each([
    ['a service that is closing (421 at the greeting)', { greeting: '421 4.3.2 service not available' }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_421' }],
    ['a mailbox that is busy (451 at the recipient)', { rcptReply: '451 4.3.0 try later' }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_451' }],
    ['a mailbox that does not exist (550 at the recipient)', { rcptReply: '550 5.1.1 no such user' }, { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_550' }],
    ['a queue that is full (452 after the data)', { endReply: '452 4.3.1 insufficient storage' }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_452' }],
    ['a message the relay will not take (554 after the data)', { endReply: '554 5.7.1 rejected as spam' }, { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_554' }],
    ['a sender the relay does not accept (550 at the sender)', { mailReply: '550 5.7.1 sender not allowed' }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_550' }],
  ])('classifies %s', async (_name, script: FakeSmtpScript, expected) => {
    await withRelay(script, async (relay) => {
      expect(await new SmtpChannelAdapter(configFor(relay.port), 'MOCK').send(request())).toEqual(expected);
    });
  });

  it('says the answer is lost, and never refused, when the connection drops after the end of the data', async () => {
    await withRelay({ endReply: 'drop' }, async (relay) => {
      expect(await new SmtpChannelAdapter(configFor(relay.port), 'MOCK').send(request())).toEqual({ kind: 'UNKNOWN', errorCode: 'SMTP_RESULT_LOST' });
      // The relay did receive the message: sending it again on its own would be a second e-mail.
      expect(relay.transcript.messages).toHaveLength(1);
    });
  });

  it('fails in time, and can be tried again, when the relay does not answer or is not there', async () => {
    await withRelay({ greetingDelayMs: 1500 }, async (relay) => {
      expect(await new SmtpChannelAdapter(configFor(relay.port, { timeoutMs: 300 }), 'MOCK').send(request())).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_TIMEOUT' });
    });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await new SmtpChannelAdapter(configFor(port), 'MOCK').send(request())).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_CONNECT_FAILED' });
  });

  it('refuses an address that could smuggle a command or a header, before any connection', async () => {
    await withRelay({}, async (relay) => {
      const adapter = new SmtpChannelAdapter(configFor(relay.port), 'MOCK');
      for (const to of ['a@example.com\r\nRCPT TO:<x@evil.example>', 'not-an-address', 'a b@example.com', '<a@example.com>']) {
        expect(await adapter.send(request({ to }))).toEqual({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_ADDRESS_INVALID' });
      }
      expect(relay.transcript.commands).toEqual([]);
    });
  });

  it('keeps a line that starts with a dot, and a subject with Vietnamese letters, intact', async () => {
    await withRelay({}, async (relay) => {
      await new SmtpChannelAdapter(configFor(relay.port), 'MOCK', () => NOW).send(request({ subject: `${VIETNAMESE_SUBJECT}\r\nBcc: attacker@example.com` }));
      const message = relay.transcript.messages[0] as string;
      expect(decodeBody(message)).toContain('\r\n.Dòng này bắt đầu bằng dấu chấm.\r\n');
      const subject = message.split('\r\n\r\n')[0]?.match(/Subject: ([\s\S]*?)\r\n(?=[A-Z][A-Za-z-]+: )/)?.[1] ?? '';
      const words = subject.split(/\r\n /).map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8'));
      expect(words.join('')).toBe(`${VIETNAMESE_SUBJECT} Bcc: attacker@example.com`);
      expect(message.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
    });
  });

  it('builds the same message id for the same send, and an encoded sender name', () => {
    const one = mimeMessage({ from: 'khdt@example.com', fromName: 'Ban KHĐT' }, request(), NOW);
    expect(one.messageId).toBe(mimeMessage({ from: 'khdt@example.com', fromName: 'Ban KHĐT' }, request(), NOW).messageId);
    expect(one.raw).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <khdt@example\.com>\r\n/);
    expect(one.raw).toContain('Date: Tue, 05 Oct 2027 03:00:00 +0000');
  });

  it('cannot say whether a message was received (SMTP keeps no idempotency key), and reads no receipt', async () => {
    const adapter = new SmtpChannelAdapter(configFor(25), 'MOCK');
    expect(await adapter.lookup()).toEqual({ kind: 'UNDETERMINED' });
    expect(adapter.parseCallback()).toBeUndefined();
  });
});

describe('the SMTP configuration from the environment', () => {
  const BASE = { MACHVON_SMTP_HOST: 'mail.example.com', MACHVON_SMTP_FROM: 'khdt@example.com' };

  it('needs a host and a sender, has defaults for the rest, and takes the password from the vault reference', () => {
    expect(smtpConfigFromEnv({}, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ MACHVON_SMTP_HOST: 'mail.example.com' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv(BASE, 'production')).toMatchObject({ host: 'mail.example.com', port: 587, security: 'STARTTLS', timeoutMs: 15_000 });
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_SECURITY: 'tls' }, 'production')).toMatchObject({ port: 465, security: 'TLS' });
    const withReference = smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_USER: 'machvon', MACHVON_SMTP_PASSWORD_REF: 'secret://production/smtp', MACHVON_SECRET_PRODUCTION_SMTP: RELAY_SECRET }, 'production');
    expect(withReference).toMatchObject({ user: 'machvon', password: RELAY_SECRET });
  });

  it('refuses what is unsafe or incomplete: clear text in production, a user without a password, a host off the allow-list, a number out of range', () => {
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_SECURITY: 'NONE' }, 'production')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_SECURITY: 'NONE', MACHVON_SMTP_ALLOW_PLAINTEXT: 'true' }, 'production')).toMatchObject({ security: 'NONE', port: 25 });
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_SECURITY: 'NONE' }, 'staging')).toMatchObject({ security: 'NONE' });
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_USER: 'machvon' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_ALLOWED_HOSTS: 'corp.example' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_ALLOWED_HOSTS: 'example.com' }, 'staging')).toBeDefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_PORT: '70000' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_TIMEOUT_MS: '10' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_SECURITY: 'SSL3' }, 'staging')).toBeUndefined();
    expect(smtpConfigFromEnv({ ...BASE, MACHVON_SMTP_FROM: 'not an address' }, 'staging')).toBeUndefined();
  });

  it('is honest about its status: MOCK outside production, PROPOSED (never sends) in production until the operator attests it, then VERIFIED', () => {
    expect(smtpAdapterFromEnv(BASE, 'staging')?.status).toBe('MOCK');
    expect(smtpAdapterFromEnv(BASE, 'production')?.status).toBe('PROPOSED');
    expect(smtpAdapterFromEnv({ ...BASE, MACHVON_SMTP_VERIFIED: 'true' }, 'production')?.status).toBe('VERIFIED');
    expect(smtpAdapterFromEnv({}, 'production')).toBeUndefined();
  });

  it('takes the e-mail channel from the in-memory stand-in when it is configured, and is registered in production without being allowed to send', () => {
    const staging = defaultChannelAdapters('staging', BASE);
    expect(staging.forChannel('EMAIL')?.provider).toBe(SMTP_PROVIDER);
    expect(staging.usable('EMAIL')).toBeDefined();
    const production = defaultChannelAdapters('production', BASE);
    expect(production.forChannel('EMAIL')?.provider).toBe(SMTP_PROVIDER);
    expect(production.statusOf('EMAIL')).toBe('PROPOSED');
    expect(production.usable('EMAIL')).toBeUndefined();
    expect(defaultChannelAdapters('production', { ...BASE, MACHVON_SMTP_VERIFIED: 'true' }).usable('EMAIL')).toBeDefined();
    expect(defaultChannelAdapters('production', {}).statusOf('EMAIL')).toBe('MISSING');
    expect(defaultChannelAdapters('staging', {}).forChannel('EMAIL')?.provider).toBe('smtp-relay');
  });
});
