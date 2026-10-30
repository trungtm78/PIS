import type { ChannelSendRequest, ChannelSendResult } from '@machvon/kernel';
import { VN_OFFSET_MS } from '@machvon/kernel';
import { InMemoryChannelAdapter } from './channel-adapters';

/** The hours a text message may be sent, in Vietnam: not in the night [CXN-SPAM-01, the legal opinion on the sending hours of SMS brandname is pending; 07:00 to 21:00 is the working assumption]. */
export interface SendingHours {
  fromMinute: number;
  toMinute: number;
}
export const DEFAULT_SMS_HOURS: SendingHours = { fromMinute: 7 * 60, toMinute: 21 * 60 };

/**
 * The adapter of the SMS gateway (ST-NOT-010, MOCK until the contract with a brandname provider, D06): it records the messages it is given like the in-memory adapter, and it refuses to send outside the sending hours
 * with a failure that can be tried again, with the wait until the hours open, so the engine puts the message back for then instead of sending a text at night.
 */
export class SmsHoursAdapter extends InMemoryChannelAdapter {
  constructor(
    private readonly hours: SendingHours = DEFAULT_SMS_HOURS,
    private readonly now: () => Date = () => new Date(),
  ) {
    super({ provider: 'mock-sms', channel: 'SMS', status: 'MOCK', paid: true });
  }

  /** Seconds until the sending hours open, or 0 when they are open now. */
  waitSeconds(at: Date = this.now()): number {
    const local = new Date(at.getTime() + VN_OFFSET_MS);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minute >= this.hours.fromMinute && minute < this.hours.toMinute) return 0;
    const wait = minute < this.hours.fromMinute ? this.hours.fromMinute - minute : 24 * 60 - minute + this.hours.fromMinute;
    return wait * 60 - local.getUTCSeconds();
  }

  /** The instant the sending hours open, or undefined when they are open: the engine puts the message back for then before it takes the send up, so it uses no attempt, charges nothing and does not count against the circuit. */
  closedUntil(at: Date): Date | undefined {
    const wait = this.waitSeconds(at);
    return wait > 0 ? new Date(at.getTime() + wait * 1000) : undefined;
  }

  override send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    // The hours are asked before a send is taken up; a send that still comes in the night is refused for good measure, with the wait.
    const wait = this.waitSeconds();
    if (wait > 0) return Promise.resolve({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'OUTSIDE_SENDING_HOURS', retryAfterSeconds: wait });
    return super.send(request);
  }
}
