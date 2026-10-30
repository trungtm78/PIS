/**
 * The ports to Firebase Cloud Messaging and to the Apple Push Notification service (ST-NOT-007, NOT 9). The adapters follow the public documentation of the two providers and are VERIFIED only after a sandbox spike
 * (the assumption of the story): until then the only implementations are the stand-ins below (MOCK). A port makes one call for one device and says what the provider answered; it never decides what to do about it.
 */
import { randomUUID } from 'node:crypto';

export interface PushProviderMessage {
  /** The token of the device, read from the vault for this call. */
  token: string;
  /** The visible part: a neutral sentence. Absent on a silent data message. */
  body?: string;
  /** The data that travels with the message, strings only: the opaque link of a notification, or what a silent message asks the app to read again. */
  data: Record<string, string>;
  /** A data message that wakes the app and shows nothing. */
  silent: boolean;
  /** One send of one notification to one device: a provider that supports it sends once however often it is asked. */
  idempotencyKey: string;
}

export type PushProviderAnswer =
  | { ok: true; messageId: string }
  /** `code` is the error code of FCM or the reason of APNs, as the provider wrote it. */
  | { ok: false; code: string };

export interface PushProviderPort {
  send(message: PushProviderMessage): Promise<PushProviderAnswer>;
}

/** The stand-in of a provider: it records what it was asked to send and accepts, unless a test says a token is unknown or the provider is down. */
export class MockPushProvider implements PushProviderPort {
  /** Every call, in order. Kept as the provider would see it: a test reads here what would have been on a lock screen. */
  readonly sent: PushProviderMessage[] = [];
  private readonly answers = new Map<string, string>();
  private outage: string | undefined;

  /** The token is refused with this code from now on (`UNREGISTERED`, `BadDeviceToken`...). */
  refuseToken(token: string, code: string): void {
    this.answers.set(token, code);
  }

  /** Every call fails with this code (an outage of the provider) until \`recover\`. */
  failAll(code: string): void {
    this.outage = code;
  }

  recover(): void {
    this.outage = undefined;
    this.answers.clear();
  }

  async send(message: PushProviderMessage): Promise<PushProviderAnswer> {
    this.sent.push(message);
    if (this.outage !== undefined) return { ok: false, code: this.outage };
    const refused = this.answers.get(message.token);
    if (refused !== undefined) return { ok: false, code: refused };
    return { ok: true, messageId: `mock-push-${randomUUID()}` };
  }
}
