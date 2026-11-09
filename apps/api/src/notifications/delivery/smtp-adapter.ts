import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions } from 'node:tls';
import { TIMESTAMPED_HMAC_SHA256, isProductionEnvironment } from '@machvon/kernel';
import type { AdapterStatus, ChannelAdapter, ChannelLookupResult, ChannelSendRequest, ChannelSendResult, ParsedChannelCallback, ProviderSignatureScheme } from '@machvon/kernel';

/** The name of the provider in the status items and the inbox, and the channel it serves. The in-memory stand-in is `smtp-relay`; this is the adapter of a real relay. */
export const SMTP_PROVIDER = 'smtp';
export const SMTP_CHANNEL = 'EMAIL';

export type SmtpSecurity = 'TLS' | 'STARTTLS' | 'NONE';

export interface SmtpConfig {
  host: string;
  port: number;
  /** `TLS` is a connection that starts encrypted (port 465), `STARTTLS` upgrades the connection before anything secret is sent (587), `NONE` stays in clear text (an internal relay, and only when the operator said so). */
  security: SmtpSecurity;
  user?: string | undefined;
  password?: string | undefined;
  /** The address of the sender (the envelope sender and the From header). */
  from: string;
  fromName?: string | undefined;
  /** The name this client gives in EHLO. */
  helo: string;
  timeoutMs: number;
  /** The certificate authority of the relay when it is not one the system trusts (an internal one), in PEM. */
  ca?: string | undefined;
  /** When true the relay may be reached in clear text with a password; never the default. */
  allowInsecureAuth?: boolean | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT: Readonly<Record<SmtpSecurity, number>> = { TLS: 465, STARTTLS: 587, NONE: 25 };
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAX_ADDRESS = 254;
const MAX_SUBJECT = 998 - 'Subject: '.length;
const CRLF = '\r\n';

const secretVariable = (reference: string): string => `MACHVON_SECRET_${reference.replace(/^secret:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

/**
 * The configuration of the relay from the environment, or undefined when it is not (fully) given: the host and the sender are required, the port and the security have defaults, the password is named by a vault reference
 * (`MACHVON_SMTP_PASSWORD_REF`, read as `MACHVON_SECRET_<REFERENCE>`) or, in a development setup, given in `MACHVON_SMTP_PASSWORD`. Clear text is refused where real data lives unless `MACHVON_SMTP_ALLOW_PLAINTEXT=true`,
 * and a password is never sent over a connection that is not encrypted unless `MACHVON_SMTP_ALLOW_INSECURE_AUTH=true`. Nothing here reads a file but the optional CA bundle named in `MACHVON_SMTP_CA_FILE`.
 */
export function smtpConfigFromEnv(env: Environment, environment: string | undefined): SmtpConfig | undefined {
  const host = env.MACHVON_SMTP_HOST?.trim();
  const from = env.MACHVON_SMTP_FROM?.trim();
  if (host === undefined || host === '' || !HOST.test(host) || from === undefined || !ADDRESS.test(from)) return undefined;
  const allowed = (env.MACHVON_SMTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (allowed.length > 0 && !allowed.some((entry) => host.toLowerCase() === entry || host.toLowerCase().endsWith(`.${entry}`))) return undefined;
  const requested = (env.MACHVON_SMTP_SECURITY ?? 'STARTTLS').trim().toUpperCase();
  if (requested !== 'TLS' && requested !== 'STARTTLS' && requested !== 'NONE') return undefined;
  const security: SmtpSecurity = requested;
  if (security === 'NONE' && isProductionEnvironment(environment) && env.MACHVON_SMTP_ALLOW_PLAINTEXT !== 'true') return undefined;
  const port = env.MACHVON_SMTP_PORT === undefined ? DEFAULT_PORT[security] : Number(env.MACHVON_SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const timeout = env.MACHVON_SMTP_TIMEOUT_MS === undefined ? 15_000 : Number(env.MACHVON_SMTP_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) return undefined;
  const user = env.MACHVON_SMTP_USER?.trim();
  const reference = env.MACHVON_SMTP_PASSWORD_REF?.trim();
  const password = (reference === undefined || reference === '' ? env.MACHVON_SMTP_PASSWORD : env[secretVariable(reference)])?.trim();
  if ((user === undefined || user === '') !== (password === undefined || password === '')) return undefined;
  let ca: string | undefined;
  if (env.MACHVON_SMTP_CA_FILE !== undefined && env.MACHVON_SMTP_CA_FILE.trim() !== '') {
    try {
      ca = readFileSync(env.MACHVON_SMTP_CA_FILE.trim(), 'utf8');
    } catch {
      return undefined;
    }
  }
  const helo = env.MACHVON_SMTP_HELO?.trim();
  return {
    host,
    port,
    security,
    ...(user === undefined || user === '' ? {} : { user, password }),
    from,
    ...(env.MACHVON_SMTP_FROM_NAME === undefined || env.MACHVON_SMTP_FROM_NAME.trim() === '' ? {} : { fromName: env.MACHVON_SMTP_FROM_NAME.trim() }),
    helo: helo !== undefined && HOST.test(helo) ? helo : 'machvon.local',
    timeoutMs: timeout,
    ...(ca === undefined ? {} : { ca }),
    allowInsecureAuth: env.MACHVON_SMTP_ALLOW_INSECURE_AUTH === 'true',
  };
}

interface SmtpReply {
  code: number;
  text: string;
}

/** A reply that is not the one the dialogue needs. */
class SmtpReplyError extends Error {
  constructor(
    readonly reply: SmtpReply,
    readonly stage: string,
  ) {
    super(`smtp ${stage} ${reply.code}`);
  }
}

class SmtpConnectionError extends Error {
  constructor(readonly errorCode: 'SMTP_CONNECT_FAILED' | 'SMTP_TIMEOUT' | 'SMTP_TLS_FAILED' | 'SMTP_PROTOCOL_ERROR') {
    super(errorCode);
  }
}

/** One conversation with the relay: replies are read whole (a reply may span lines), one at a time, each within the time limit. */
class SmtpSession {
  private buffer = '';
  private failure: SmtpConnectionError | undefined;
  private waiting: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  secure = false;

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.deliver();
    });
    socket.on('error', () => this.fail(new SmtpConnectionError(this.secure ? 'SMTP_TLS_FAILED' : 'SMTP_CONNECT_FAILED')));
    socket.on('close', () => this.fail(new SmtpConnectionError('SMTP_CONNECT_FAILED')));
  }

  private fail(error: SmtpConnectionError): void {
    this.failure ??= error;
    if (this.waiting !== undefined) {
      const { reject, timer } = this.waiting;
      this.waiting = undefined;
      clearTimeout(timer);
      reject(this.failure);
    }
  }

  /** A whole reply, when the buffer holds one: the last line of a reply has a space after the code, the lines before it a hyphen. */
  private take(): SmtpReply | undefined {
    const lines = this.buffer.split('\n');
    const complete = lines.slice(0, -1).map((line) => line.replace(/\r$/, ''));
    for (let at = 0; at < complete.length; at += 1) {
      const line = complete[at] as string;
      if (!/^\d{3}[ -]/.test(line)) throw new SmtpConnectionError('SMTP_PROTOCOL_ERROR');
      if (line[3] === ' ') {
        this.buffer = lines.slice(at + 1).join('\n');
        return { code: Number(line.slice(0, 3)), text: complete.slice(0, at + 1).map((one) => one.slice(4)).join('\n') };
      }
    }
    return undefined;
  }

  private deliver(): void {
    if (this.waiting === undefined) return;
    let reply: SmtpReply | undefined;
    try {
      reply = this.take();
    } catch (error) {
      this.fail(error as SmtpConnectionError);
      return;
    }
    if (reply === undefined) return;
    const { resolve, timer } = this.waiting;
    this.waiting = undefined;
    clearTimeout(timer);
    resolve(reply);
  }

  reply(): Promise<SmtpReply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new SmtpConnectionError('SMTP_TIMEOUT')), this.timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.deliver();
    });
  }

  write(text: string): void {
    if (this.failure !== undefined) throw this.failure;
    this.socket.write(text);
  }

  /** Starts TLS on the connection after the relay agreed to it; whatever was buffered before is dropped (a relay that sent data ahead of the handshake is not trusted). */
  async upgrade(options: ConnectionOptions): Promise<void> {
    this.socket.removeAllListeners('data');
    this.buffer = '';
    await new Promise<void>((resolve, reject) => {
      const secured = tlsConnect({ ...options, socket: this.socket }, () => resolve());
      const timer = setTimeout(() => reject(new SmtpConnectionError('SMTP_TIMEOUT')), this.timeoutMs);
      secured.once('secureConnect', () => clearTimeout(timer));
      secured.once('error', () => {
        clearTimeout(timer);
        reject(new SmtpConnectionError('SMTP_TLS_FAILED'));
      });
      this.socket = secured;
      this.attach(secured);
    });
    this.secure = true;
  }

  destroy(): void {
    if (this.waiting !== undefined) clearTimeout(this.waiting.timer);
    this.socket.destroy();
  }
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
const wrap = (encoded: string): string => (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
const ascii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

/** A header value that is not plain ASCII, as RFC 2047 encoded words of at most 45 bytes (so each word stays within 75 characters). */
function encodedWords(value: string): string {
  if (ascii(value)) return value;
  const words: string[] = [];
  let current = '';
  for (const char of value) {
    if (Buffer.byteLength(current + char, 'utf8') > 45) {
      words.push(current);
      current = '';
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words.map((word) => `=?UTF-8?B?${b64(word)}?=`).join(`${CRLF} `);
}

/** The message as the relay receives it: headers, then the text in base64 so no line is long and no dot starts one. */
export function mimeMessage(config: Pick<SmtpConfig, 'from' | 'fromName'>, request: Pick<ChannelSendRequest, 'to' | 'subject' | 'text' | 'idempotencyKey'>, now: Date = new Date()): { raw: string; messageId: string } {
  const domain = config.from.slice(config.from.indexOf('@') + 1);
  const messageId = `<${request.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '.')}@${domain}>`;
  const from = config.fromName === undefined ? config.from : `${encodedWords(config.fromName.replace(/["\r\n]/g, ''))} <${config.from}>`;
  const headers = [
    `From: ${from}`,
    `To: ${request.to}`,
    `Subject: ${encodedWords((request.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, MAX_SUBJECT))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  return { raw: `${headers.join(CRLF)}${CRLF}${CRLF}${wrap(b64(request.text.replace(/\r?\n/g, CRLF)))}${CRLF}`, messageId };
}

/**
 * The adapter of the e-mail channel to a real SMTP relay (YCK.01, QT.02): the reminders and the alerts reach people by e-mail through the relay of the operator (the customer's own, or any submission service) over TLS.
 * The delivery engine owns the queue, the schedule of retries, the fallback and the log of every attempt (NOT-11 to NOT-13): this adapter only makes the call and says what happened. A refusal before the message is accepted
 * (a 4xx reply, a refused connection, a timeout before the end of the data) is a failure that can be tried again; a 5xx reply is for good; a connection lost AFTER the end of the data was sent is `UNKNOWN`, because the relay
 * may have the message: it is never sent again on its own. SMTP keeps no idempotency key, so a lookup cannot tell and the answer is `UNDETERMINED`; delivery receipts and bounces are not read.
 */
export class SmtpChannelAdapter implements ChannelAdapter {
  readonly provider = SMTP_PROVIDER;
  readonly channel = SMTP_CHANNEL;
  readonly paid = false;
  readonly signature: ProviderSignatureScheme = TIMESTAMPED_HMAC_SHA256;

  constructor(
    private readonly config: SmtpConfig,
    readonly status: AdapterStatus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private tlsOptions(): ConnectionOptions {
    return { host: this.config.host, servername: this.config.host, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(this.config.ca === undefined ? {} : { ca: this.config.ca }) };
  }

  private open(): Promise<SmtpSession> {
    return new Promise<SmtpSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SmtpConnectionError('SMTP_TIMEOUT'));
      }, this.config.timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        const session = new SmtpSession(socket, this.config.timeoutMs);
        session.secure = this.config.security === 'TLS';
        resolve(session);
      };
      const socket: Socket =
        this.config.security === 'TLS'
          ? tlsConnect({ ...this.tlsOptions(), port: this.config.port }, done)
          : netConnect({ host: this.config.host, port: this.config.port }, done);
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new SmtpConnectionError(this.config.security === 'TLS' ? 'SMTP_TLS_FAILED' : 'SMTP_CONNECT_FAILED'));
      });
    });
  }

  private async expect(session: SmtpSession, stage: string, ok: readonly number[]): Promise<SmtpReply> {
    const reply = await session.reply();
    if (!ok.includes(reply.code)) throw new SmtpReplyError(reply, stage);
    return reply;
  }

  private async command(session: SmtpSession, stage: string, line: string, ok: readonly number[]): Promise<SmtpReply> {
    session.write(`${line}${CRLF}`);
    return this.expect(session, stage, ok);
  }

  private async authenticate(session: SmtpSession, capabilities: string): Promise<void> {
    const { user, password } = this.config;
    if (user === undefined || password === undefined) return;
    if (!session.secure && this.config.allowInsecureAuth !== true) throw new SmtpReplyError({ code: 530, text: 'a password is not sent over a connection that is not encrypted' }, 'AUTH');
    const methods = capabilities.split('\n').find((line) => /^AUTH[ =]/i.test(line))?.toUpperCase() ?? '';
    if (methods.includes('PLAIN')) {
      await this.command(session, 'AUTH', `AUTH PLAIN ${b64(`\u0000${user}\u0000${password}`)}`, [235]);
    } else if (methods.includes('LOGIN')) {
      await this.command(session, 'AUTH', 'AUTH LOGIN', [334]);
      await this.command(session, 'AUTH', b64(user), [334]);
      await this.command(session, 'AUTH', b64(password), [235]);
    } else {
      throw new SmtpReplyError({ code: 504, text: 'no authentication method in common' }, 'AUTH');
    }
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const to = request.to.trim();
    if (to.length > MAX_ADDRESS || !ADDRESS.test(to)) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_ADDRESS_INVALID' };
    const { raw, messageId } = mimeMessage(this.config, { ...request, to }, this.now());
    let session: SmtpSession | undefined;
    let terminatorSent = false;
    try {
      session = await this.open();
      await this.expect(session, 'GREETING', [220]);
      let hello = await this.command(session, 'EHLO', `EHLO ${this.config.helo}`, [250]);
      if (this.config.security === 'STARTTLS') {
        await this.command(session, 'STARTTLS', 'STARTTLS', [220]);
        await session.upgrade(this.tlsOptions());
        hello = await this.command(session, 'EHLO', `EHLO ${this.config.helo}`, [250]);
      }
      await this.authenticate(session, hello.text);
      await this.command(session, 'MAIL', `MAIL FROM:<${this.config.from}>`, [250]);
      await this.command(session, 'RCPT', `RCPT TO:<${to}>`, [250, 251]);
      await this.command(session, 'DATA', 'DATA', [354]);
      // Dot-stuffing: a line that starts with a dot gets one more, so the end marker cannot be forged by the text.
      terminatorSent = true;
      session.write(`${raw.replace(/^\./gm, '..')}.${CRLF}`);
      await this.expect(session, 'DATA_END', [250]);
      // The message is accepted; a relay that has already hung up, or answers slowly to QUIT, costs nothing.
      try {
        session.write(`QUIT${CRLF}`);
        await session.reply();
      } catch {
        // Nothing to do: the answer to QUIT is a courtesy.
      }
      return { kind: 'ACCEPTED', providerMessageId: messageId };
    } catch (error) {
      return this.classify(error, terminatorSent);
    } finally {
      session?.destroy();
    }
  }

  private classify(error: unknown, terminatorSent: boolean): ChannelSendResult {
    if (error instanceof SmtpReplyError) {
      const { code } = error.reply;
      if (error.stage === 'AUTH') return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_AUTH_FAILED' };
      if (code >= 400 && code < 500) return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: `SMTP_${code}` };
      if (error.stage === 'RCPT' || error.stage === 'DATA_END') return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: `SMTP_${code}` };
      // A refusal of the greeting, the hello, the sender or the data command is about the relay or its policy, not about this message: tried again when the operator fixed it.
      return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: `SMTP_${code}` };
    }
    const connection = error instanceof SmtpConnectionError ? error.errorCode : 'SMTP_CONNECT_FAILED';
    // After the end of the data was sent the relay may hold the message: the answer is lost, not refused.
    if (terminatorSent) return { kind: 'UNKNOWN', errorCode: 'SMTP_RESULT_LOST' };
    return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: connection };
  }

  /** SMTP keeps no idempotency key: the relay cannot say whether a message was received. */
  lookup(): Promise<ChannelLookupResult> {
    return Promise.resolve({ kind: 'UNDETERMINED' });
  }

  /** The relay reports nothing back to the platform (bounces arrive in the mailbox of the sender). */
  parseCallback(): ParsedChannelCallback | undefined {
    return undefined;
  }
}

/** The adapter the environment asks for, or undefined when the relay is not configured. In production it is `PROPOSED` (never sends) until the operator attests that the relay was verified (`MACHVON_SMTP_VERIFIED=true`); elsewhere it is `MOCK`. */
export function smtpAdapterFromEnv(env: Environment, environment: string | undefined): SmtpChannelAdapter | undefined {
  const config = smtpConfigFromEnv(env, environment);
  if (config === undefined) return undefined;
  const status: AdapterStatus = isProductionEnvironment(environment) ? (env.MACHVON_SMTP_VERIFIED === 'true' ? 'VERIFIED' : 'PROPOSED') : 'MOCK';
  return new SmtpChannelAdapter(config, status);
}
