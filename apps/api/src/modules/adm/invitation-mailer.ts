import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What the person invited receives: the one-time token and the link data, never stored by the server. */
export interface InvitationMessage {
  tenantId: string;
  invitationId: string;
  toEmail: string;
  token: string;
  expiresAt: Date;
}

/**
 * The port through which an invitation reaches the invited person. The email channel belongs to the OMNI module (R1);
 * until it exists, the MOCK adapter keeps the messages in memory so tests and the development stack can read the link.
 */
export interface InvitationMailer {
  send(message: InvitationMessage): Promise<void>;
}

export const INVITATION_MAILER = Symbol('INVITATION_MAILER');

/** In-memory adapter: it records what a real mailer would have sent. Never use it where invitations must be delivered. */
export class MockInvitationMailer implements InvitationMailer {
  readonly sent: InvitationMessage[] = [];

  send(message: InvitationMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The newest message to an address, as a test or the development stack needs it. */
  lastTo(email: string): InvitationMessage | undefined {
    const wanted = email.trim().toLowerCase();
    return [...this.sent].reverse().find((message) => message.toEmail === wanted);
  }
}

/** The directory of the hand-over outbox: named, the invitations are written there for the operator; not named, nothing leaves the process. */
export const INVITATION_OUTBOX_VARIABLE = 'MACHVON_INVITATION_OUTBOX_DIR';

/** One invitation as the operator reads it from the outbox: who it is for, the link to hand over and until when it works. */
export interface InvitationHandOver {
  invitation_id: string;
  tenant_id: string;
  to_email: string;
  /** The page of the web application that accepts the invitation; absent when the origin of the web application is not configured. */
  link?: string;
  token: string;
  expires_at: string;
}

const HAND_OVER_FILE = /^[0-9a-f-]{36}\.json$/;

/**
 * The outbox of an installation that has no e-mail relay the application can reach (the on-prem services have no route out of the host): every invitation becomes one file,
 * readable by the service user only, that the operator reads on the host and hands to the invited person over a channel the customer trusts. The token is the only secret in it
 * and it is useless once the invitation is accepted, replaced or expired: the file of an invitation that expired is removed at the next send, and an operator removes a file after
 * handing it over. Accepting still needs a sign-in whose verified e-mail is the invited one, so the file alone lets nobody in.
 */
export class FileInvitationMailer implements InvitationMailer {
  constructor(
    private readonly directory: string,
    private readonly webBaseUrl: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(message: InvitationMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.removeExpired();
    const handOver: InvitationHandOver = {
      invitation_id: message.invitationId,
      tenant_id: message.tenantId,
      to_email: message.toEmail,
      ...(this.webBaseUrl === undefined ? {} : { link: `${this.webBaseUrl}/invitations/${message.invitationId}/accept?token=${encodeURIComponent(message.token)}` }),
      token: message.token,
      expires_at: message.expiresAt.toISOString(),
    };
    // An invitation that is sent again has a new token under the same or a new id: the newest file wins.
    await writeFile(join(this.directory, `${message.invitationId}.json`), `${JSON.stringify(handOver, null, 2)}\n`, { mode: 0o600 });
  }

  private async removeExpired(): Promise<void> {
    const limit = this.now().getTime();
    for (const name of await readdir(this.directory)) {
      if (!HAND_OVER_FILE.test(name)) continue;
      const path = join(this.directory, name);
      try {
        const expires = Date.parse((JSON.parse(await readFile(path, 'utf8')) as Partial<InvitationHandOver>).expires_at ?? '');
        if (Number.isNaN(expires) || expires <= limit) await rm(path, { force: true });
      } catch {
        // A file that cannot be read or parsed is not an invitation anyone can use: it is left for the operator to look at.
      }
    }
  }
}

/**
 * The mailer of the process. The e-mail channel belongs to OMNI (R1) and does not exist yet, so by default the MOCK adapter keeps the messages in memory (tests and the development
 * stack read them); where `MACHVON_INVITATION_OUTBOX_DIR` names a directory, the invitations are handed to the operator through it.
 */
export function invitationMailerFromEnv(variables: Readonly<Record<string, string | undefined>> = process.env): InvitationMailer {
  const directory = variables[INVITATION_OUTBOX_VARIABLE]?.trim();
  if (directory === undefined || directory === '') return new MockInvitationMailer();
  const origin = variables.WEB_BASE_URL?.trim();
  return new FileInvitationMailer(directory, origin === undefined || origin === '' ? undefined : origin.replace(/\/+$/, ''));
}
