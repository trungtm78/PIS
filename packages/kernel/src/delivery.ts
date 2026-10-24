import { defineStatusTable } from './provider-status.ts';

/**
 * The rules of the notification delivery engine that need no database (ST-NOT-002, NOT 3.1, BR-NOT-03, BR-NOT-04, BR-NOT-06, BR-NOT-16):
 * the monotonic status graph of one send, the retry schedule with its jitter, the circuit breaker of a channel account and the status a
 * notification takes from its attempts.
 */

/** The statuses a provider reports for one send, in the capitals the generic status tables use. */
export type DeliveryStatus = 'SENDING' | 'UNCERTAIN' | 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED';

/**
 * BR-NOT-06: a status only moves forward. A failure that is reported late loses to a delivery that is reported late (the message that
 * reached the person wins), so FAILED may still move to DELIVERED and READ, and a FAILED that arrives after DELIVERED is a late callback
 * and is ignored.
 */
export const DELIVERY_STATUS_TABLE = defineStatusTable<DeliveryStatus>(
  'delivery_attempt',
  {
    SENDING: ['UNCERTAIN', 'ACCEPTED', 'FAILED'],
    UNCERTAIN: ['ACCEPTED', 'FAILED'],
    ACCEPTED: ['DELIVERED', 'FAILED'],
    FAILED: ['DELIVERED'],
    DELIVERED: ['READ'],
    READ: [],
  },
  ['SENDING'],
);

/** The status column of `delivery_attempt` for each status of the table. */
const ATTEMPT_STATUS: Readonly<Record<DeliveryStatus, string>> = {
  SENDING: 'Sending',
  UNCERTAIN: 'Unknown',
  ACCEPTED: 'ProviderAccepted',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
};

export function attemptStatusOf(status: DeliveryStatus): string {
  return ATTEMPT_STATUS[status];
}

/** The status of the table that a status column holds, or undefined for a status no provider reports (Queued, Suppressed, Cancelled). */
export function deliveryStatusOf(attemptStatus: string): DeliveryStatus | undefined {
  return (Object.keys(ATTEMPT_STATUS) as DeliveryStatus[]).find((status) => ATTEMPT_STATUS[status] === attemptStatus);
}

/** At most five sends per channel: the first and four retries. */
export const MAX_ATTEMPTS_PER_CHANNEL = 5;
/** The waits after the first, second, third and fourth failed send, counted from the failed send. */
export const RETRY_DELAYS_SECONDS: readonly number[] = [30, 120, 600, 1800];
/** Each wait is multiplied by a random factor in this range (plus and minus 20 percent). */
export const RETRY_JITTER_MIN = 0.8;
export const RETRY_JITTER_MAX = 1.2;

export type RetryDecision =
  | { kind: 'RETRY'; at: Date; delaySeconds: number }
  /** The channel has had its five sends: the next channel of the plan takes over. */
  | { kind: 'EXHAUSTED' }
  /** No send may be made at or after the expiry of the notification. */
  | { kind: 'EXPIRED' };

export interface RetryInput {
  /** The number of the send that failed, from 1. */
  attemptNo: number;
  failedAt: Date;
  expiresAt: Date;
  /** The wait the provider asked for; a longer one than the schedule wins. */
  retryAfterSeconds?: number | undefined;
  /** A number in [0, 1); tests inject it. */
  random?: () => number;
}

/** The wait before the next send of a channel after the send numbered `attemptNo` failed, with jitter, or undefined after the last send. */
export function retryDelaySeconds(attemptNo: number, random: () => number = Math.random): number | undefined {
  const base = RETRY_DELAYS_SECONDS[attemptNo - 1];
  if (base === undefined) return undefined;
  return base * (RETRY_JITTER_MIN + (RETRY_JITTER_MAX - RETRY_JITTER_MIN) * random());
}

/**
 * BR-NOT-03: what follows a failed send that may be retried. Nothing is scheduled at or after the expiry (the notification then ends
 * Expired and no further send is made); after the fifth send the channel is exhausted. A `Retry-After` longer than the schedule is used
 * in its place.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  if (input.failedAt.getTime() >= input.expiresAt.getTime()) return { kind: 'EXPIRED' };
  const scheduled = retryDelaySeconds(input.attemptNo, input.random);
  if (scheduled === undefined) return { kind: 'EXHAUSTED' };
  const delaySeconds = Math.max(scheduled, input.retryAfterSeconds ?? 0);
  const at = new Date(input.failedAt.getTime() + delaySeconds * 1000);
  return at.getTime() >= input.expiresAt.getTime() ? { kind: 'EXPIRED' } : { kind: 'RETRY', at, delaySeconds };
}

/** BR-NOT-03: a timeout before the request left, 408, 429 and 5xx may be retried; every other 4xx will fail the same way again. */
export function failureClassOfHttpStatus(status: number): 'RETRYABLE' | 'PERMANENT' {
  return status === 408 || status === 429 || status >= 500 ? 'RETRYABLE' : 'PERMANENT';
}

/** BR-NOT-16: the circuit of a channel account opens after this many failures within the window and tries again after the open period. */
export const CIRCUIT_ERROR_THRESHOLD = 20;
export const CIRCUIT_WINDOW_SECONDS = 60;
export const CIRCUIT_OPEN_SECONDS = 120;
/** An alert is raised when a circuit has stayed open this long (NOT 9). */
export const CIRCUIT_ALERT_SECONDS = 600;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Whether a send on the account may go: ADMIT (closed), PROBE (open for long enough: one send tests the provider) or REJECT. */
export type CircuitVerdict = 'ADMIT' | 'PROBE' | 'REJECT';

export function circuitVerdict(state: CircuitState, openedAt: Date | undefined, now: Date): CircuitVerdict {
  if (state === 'CLOSED') return 'ADMIT';
  // A probe already in flight holds the others back until it reports.
  if (state === 'HALF_OPEN') return 'REJECT';
  if (openedAt === undefined) return 'PROBE';
  return now.getTime() - openedAt.getTime() >= CIRCUIT_OPEN_SECONDS * 1000 ? 'PROBE' : 'REJECT';
}

/** The state after a failed send: a failed probe reopens the circuit; a closed one opens when the window holds enough failures. */
export function circuitAfterFailure(state: CircuitState, failuresInWindow: number): CircuitState {
  if (state === 'HALF_OPEN') return 'OPEN';
  return state === 'CLOSED' && failuresInWindow >= CIRCUIT_ERROR_THRESHOLD ? 'OPEN' : state;
}

/** A send that was taken up and never reported back for this long is treated as a result that was lost (Unknown). */
export const SENDING_STALE_SECONDS = 300;
/** BR-NOT-04: an Unknown send is asked about every five minutes for a day. */
export const RECONCILE_INTERVAL_SECONDS = 300;
export const RECONCILE_WINDOW_SECONDS = 86_400;

/** The statuses of `notification_instance` that follow one another as a message makes progress, lowest first. */
const PROGRESS: readonly string[] = ['Created', 'Scheduled', 'Queued', 'Sending', 'ProviderAccepted', 'Delivered', 'Read'];

const ATTEMPT_PROGRESS: Readonly<Record<string, string>> = {
  Queued: 'Queued',
  Sending: 'Sending',
  ProviderAccepted: 'ProviderAccepted',
  Delivered: 'Delivered',
  // A read reported by a provider is not the reading of the person in the application (BR-NOT-05): the notification stays Delivered.
  Read: 'Delivered',
};

const rankOf = (status: string): number => PROGRESS.indexOf(status);

export interface RollupInput {
  /** The status the notification has now. */
  current: string;
  /** The status of every attempt of the notification. */
  attempts: readonly string[];
}

/**
 * The status a notification takes from its attempts (BR-NOT-06). Progress only moves forward, and a delivery that is reported late lifts a
 * notification out of Failed or Unknown. When nothing is moving any more: an Unknown send keeps the notification Unknown (it may have
 * been sent), otherwise a notification whose every attempt failed is Failed. Cancelled, Suppressed and Expired are decided by the commands
 * and the dispatcher, never by this function.
 */
export function rollupNotificationStatus(input: RollupInput): string {
  const { current, attempts } = input;
  if (current === 'Cancelled' || current === 'Suppressed' || current === 'Expired') return current;
  const progress = attempts.flatMap((status) => ATTEMPT_PROGRESS[status] ?? []);
  const best = progress.reduce<string | undefined>((top, status) => (top === undefined || rankOf(status) > rankOf(top) ? status : top), undefined);
  const moving = attempts.some((status) => status === 'Queued' || status === 'Sending');
  if (current === 'Failed' || current === 'Unknown') {
    // Only a delivery lifts a terminal state; nothing else moves it.
    if (best === 'Delivered' || best === 'ProviderAccepted') return best;
    if (moving) return 'Queued';
    return attempts.includes('Unknown') ? 'Unknown' : current;
  }
  if (best !== undefined && rankOf(best) > rankOf(current)) return best;
  if (moving) return current;
  // A message that the person has received stays received; one that a provider only accepted can still bounce.
  if (rankOf(current) > rankOf('ProviderAccepted')) return current;
  if (attempts.includes('Unknown')) return 'Unknown';
  return attempts.includes('Failed') ? 'Failed' : current;
}
