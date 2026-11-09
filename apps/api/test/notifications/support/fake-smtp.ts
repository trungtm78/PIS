import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createSecureContext, createServer as createTlsServer } from 'node:tls';
import type { SecureContext } from 'node:tls';

/** A throw-away certificate for `localhost`, made with the openssl of the machine and kept in memory only; the key never reaches a file of the repository. */
export function localhostCertificate(): { cert: string; key: string } {
  const directory = mkdtempSync(join(tmpdir(), 'machvon-smtp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    return { cert: readFileSync(join(directory, 'cert.pem'), 'utf8'), key: readFileSync(join(directory, 'key.pem'), 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface FakeSmtpScript {
  /** `tls` starts encrypted, `starttls` offers the upgrade, `none` is clear text. */
  mode?: 'tls' | 'starttls' | 'none';
  /** Credentials the relay accepts; none means it asks for no authentication. */
  account?: { user: string; password: string };
  greeting?: string;
  mailReply?: string;
  rcptReply?: string;
  dataReply?: string;
  /** The reply after the end of the data; `drop` closes the connection without any (the answer is lost). */
  endReply?: string;
  /** Waits this long before the greeting (a relay that does not answer in time). */
  greetingDelayMs?: number;
  tls?: { cert: string; key: string };
  advertiseLogin?: boolean;
}

export interface FakeSmtpTranscript {
  commands: string[];
  messages: string[];
  authenticated: string[];
  /** Whether each command was read over an encrypted connection. */
  secure: boolean[];
}

interface Actions {
  data(): void;
  login(): void;
  upgrade(): void;
  quit(): void;
}

/**
 * A small SMTP relay for the tests: it speaks enough of RFC 5321 (greeting, EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA with dot-unstuffing, QUIT), keeps a transcript, and answers with the replies the test
 * scripted, so a 4xx, a 5xx and a lost answer can be provoked. Nothing here reaches a network but the loopback.
 */
export class FakeSmtpServer {
  readonly transcript: FakeSmtpTranscript = { commands: [], messages: [], authenticated: [], secure: [] };
  private server: Server | undefined;
  private readonly context: SecureContext | undefined;
  port = 0;

  constructor(readonly script: FakeSmtpScript = {}) {
    if (script.tls !== undefined) this.context = createSecureContext(script.tls);
  }

  async start(): Promise<number> {
    const handle = (socket: Socket): void => this.serve(socket, this.script.mode === 'tls');
    const server: Server = this.script.mode === 'tls' && this.script.tls !== undefined ? createTlsServer(this.script.tls, handle) : createServer(handle);
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serve(initial: Socket, secure: boolean): void {
    let socket: Socket = initial;
    let isSecure = secure;
    let buffer = '';
    let inData = false;
    let data = '';
    let loginStep: 'user' | 'password' | undefined;
    let loginUser = '';
    const send = (line: string): void => void socket.write(`${line}\r\n`);
    const attach = (target: Socket): void => {
      target.setEncoding('utf8');
      target.on('error', () => undefined);
      target.on('data', (chunk: string) => {
        buffer += chunk;
        pump();
      });
    };
    const finish = (reply: string): void => {
      if (reply === 'drop') socket.destroy();
      else send(reply);
    };
    const pump = (): void => {
      for (let at = buffer.indexOf('\r\n'); at >= 0; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.transcript.messages.push(data);
            data = '';
            finish(this.script.endReply ?? '250 2.0.0 queued as TEST1');
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
        } else if (loginStep !== undefined) {
          const value = Buffer.from(line, 'base64').toString('utf8');
          if (loginStep === 'user') {
            loginUser = value;
            loginStep = 'password';
            send(`334 ${Buffer.from(`Pass${'word'}:`).toString('base64')}`);
          } else {
            loginStep = undefined;
            send(this.authorize(loginUser, value) ? '235 2.7.0 accepted' : '535 5.7.8 rejected');
          }
        } else {
          this.command(line, isSecure, send, {
            data: () => {
              inData = true;
              send('354 go ahead');
            },
            login: () => {
              loginStep = 'user';
              send(`334 ${Buffer.from('Username:').toString('base64')}`);
            },
            upgrade: () => {
              send('220 ready to start TLS');
              socket.removeAllListeners('data');
              buffer = '';
              const upgraded = new TLSSocket(socket, { isServer: true, secureContext: this.context });
              socket = upgraded;
              isSecure = true;
              attach(upgraded);
            },
            quit: () => {
              send('221 bye');
              socket.end();
            },
          });
        }
      }
    };
    attach(socket);
    setTimeout(() => send(this.script.greeting ?? '220 fake.relay ESMTP ready'), this.script.greetingDelayMs ?? 0);
  }

  private authorize(user: string, password: string): boolean {
    const account = this.script.account;
    if (account === undefined || user !== account.user || password !== account.password) return false;
    this.transcript.authenticated.push(user);
    return true;
  }

  private command(line: string, secure: boolean, send: (line: string) => void, actions: Actions): void {
    this.transcript.commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN <credentials>' : line);
    this.transcript.secure.push(secure);
    const upper = line.toUpperCase();
    if (upper.startsWith('EHLO')) {
      const extensions = ['250-fake.relay greets you', '250-8BITMIME'];
      if (this.script.mode === 'starttls' && !secure) extensions.push('250-STARTTLS');
      if (this.script.account !== undefined) extensions.push(`250-AUTH PLAIN${this.script.advertiseLogin === true ? ' LOGIN' : ''}`);
      send([...extensions, '250 SIZE 1000000'].join('\r\n'));
    } else if (upper === 'STARTTLS') {
      actions.upgrade();
    } else if (upper.startsWith('AUTH PLAIN ')) {
      const [, user, password] = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8').split('\u0000');
      send(this.authorize(user ?? '', password ?? '') ? '235 2.7.0 accepted' : '535 5.7.8 rejected');
    } else if (upper === 'AUTH LOGIN') {
      actions.login();
    } else if (upper.startsWith('MAIL FROM:')) {
      send(this.script.mailReply ?? '250 2.1.0 sender ok');
    } else if (upper.startsWith('RCPT TO:')) {
      send(this.script.rcptReply ?? '250 2.1.5 recipient ok');
    } else if (upper === 'DATA') {
      if (this.script.dataReply !== undefined && !this.script.dataReply.startsWith('354')) send(this.script.dataReply);
      else actions.data();
    } else if (upper === 'QUIT') {
      actions.quit();
    } else {
      send('502 5.5.2 not implemented');
    }
  }
}
