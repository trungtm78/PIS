import { reduceStatus } from './provider-status.ts';
import {
  CIRCUIT_ERROR_THRESHOLD,
  CIRCUIT_OPEN_SECONDS,
  DELIVERY_STATUS_TABLE,
  MAX_ATTEMPTS_PER_CHANNEL,
  RETRY_DELAYS_SECONDS,
  attemptStatusOf,
  circuitAfterFailure,
  circuitVerdict,
  decideRetry,
  deliveryStatusOf,
  failureClassOfHttpStatus,
  retryDelaySeconds,
  rollupNotificationStatus,
} from './delivery.ts';

const T0 = new Date('2026-10-24T03:00:00.000Z');
const LATER = new Date('2026-10-25T03:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

describe('retry schedule (BR-NOT-03)', () => {
  it('waits 30 s, 2 min, 10 min and 30 min, each within plus and minus 20 percent, then stops after the fifth send', () => {
    for (const [index, base] of RETRY_DELAYS_SECONDS.entries()) {
      expect(retryDelaySeconds(index + 1, () => 0)).toBeCloseTo(base * 0.8, 9);
      expect(retryDelaySeconds(index + 1, () => 0.5)).toBeCloseTo(base, 9);
      expect(retryDelaySeconds(index + 1, () => 0.999999)).toBeLessThanOrEqual(base * 1.2);
    }
    expect(retryDelaySeconds(MAX_ATTEMPTS_PER_CHANNEL)).toBeUndefined();
    expect(MAX_ATTEMPTS_PER_CHANNEL).toBe(5);
  });

  it('uses the system random number by default', () => {
    const delay = retryDelaySeconds(1);
    expect(delay).toBeGreaterThanOrEqual(24);
    expect(delay).toBeLessThanOrEqual(36);
  });

  it('schedules the next send from the failed one and exhausts the channel after the fifth', () => {
    const decision = decideRetry({ attemptNo: 2, failedAt: T0, expiresAt: LATER, random: () => 0.5 });
    expect(decision).toEqual({ kind: 'RETRY', at: at(120), delaySeconds: 120 });
    expect(decideRetry({ attemptNo: 5, failedAt: T0, expiresAt: LATER })).toEqual({ kind: 'EXHAUSTED' });
  });

  it('prefers a Retry-After that is longer than the schedule and ignores a shorter one', () => {
    expect(decideRetry({ attemptNo: 1, failedAt: T0, expiresAt: LATER, retryAfterSeconds: 600, random: () => 0.5 })).toEqual({ kind: 'RETRY', at: at(600), delaySeconds: 600 });
    expect(decideRetry({ attemptNo: 1, failedAt: T0, expiresAt: LATER, retryAfterSeconds: 5, random: () => 0.5 })).toEqual({ kind: 'RETRY', at: at(30), delaySeconds: 30 });
  });

  it('never schedules a send at or after the expiry: the notification ends Expired', () => {
    expect(decideRetry({ attemptNo: 1, failedAt: T0, expiresAt: at(300), retryAfterSeconds: 600 })).toEqual({ kind: 'EXPIRED' });
    expect(decideRetry({ attemptNo: 1, failedAt: T0, expiresAt: at(30), random: () => 0.5 })).toEqual({ kind: 'EXPIRED' });
    expect(decideRetry({ attemptNo: 1, failedAt: at(400), expiresAt: at(300) })).toEqual({ kind: 'EXPIRED' });
    expect(decideRetry({ attemptNo: 5, failedAt: at(400), expiresAt: at(300) })).toEqual({ kind: 'EXPIRED' });
  });
});

describe('failure class of an HTTP status', () => {
  it.each([
    [408, 'RETRYABLE'],
    [429, 'RETRYABLE'],
    [500, 'RETRYABLE'],
    [503, 'RETRYABLE'],
    [400, 'PERMANENT'],
    [401, 'PERMANENT'],
    [404, 'PERMANENT'],
    [422, 'PERMANENT'],
  ])('%s is %s', (status, expected) => {
    expect(failureClassOfHttpStatus(status)).toBe(expected);
  });
});

describe('monotonic delivery status (BR-NOT-06)', () => {
  it('maps the statuses of a provider to the status column and back', () => {
    expect(attemptStatusOf('ACCEPTED')).toBe('ProviderAccepted');
    expect(attemptStatusOf('UNCERTAIN')).toBe('Unknown');
    expect(deliveryStatusOf('ProviderAccepted')).toBe('ACCEPTED');
    expect(deliveryStatusOf('Unknown')).toBe('UNCERTAIN');
    expect(deliveryStatusOf('Queued')).toBeUndefined();
    expect(deliveryStatusOf('Suppressed')).toBeUndefined();
  });

  it('never moves backwards and treats a repeat as a duplicate', () => {
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'ACCEPTED', 'DELIVERED')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'DELIVERED', 'ACCEPTED')).toBe('STALE');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'DELIVERED', 'DELIVERED')).toBe('DUPLICATE');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'READ', 'DELIVERED')).toBe('STALE');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'SENDING', 'READ')).toBe('APPLIED');
  });

  it('lets the message that reached the person win over a failure reported late, and ignores a failure after a delivery', () => {
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'FAILED', 'DELIVERED')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'FAILED', 'READ')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'DELIVERED', 'FAILED')).toBe('STALE');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'ACCEPTED', 'FAILED')).toBe('APPLIED');
  });

  it('resolves an uncertain send by a later callback and ignores an uncertainty after a result', () => {
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'SENDING', 'UNCERTAIN')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'UNCERTAIN', 'DELIVERED')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'UNCERTAIN', 'FAILED')).toBe('APPLIED');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'ACCEPTED', 'UNCERTAIN')).toBe('STALE');
    expect(reduceStatus(DELIVERY_STATUS_TABLE, 'FAILED', 'UNCERTAIN')).toBe('STALE');
  });
});

describe('circuit breaker (BR-NOT-16)', () => {
  it('admits a closed circuit, rejects an open one for two minutes and then lets one probe through', () => {
    expect(circuitVerdict('CLOSED', undefined, T0)).toBe('ADMIT');
    expect(circuitVerdict('OPEN', T0, at(CIRCUIT_OPEN_SECONDS - 1))).toBe('REJECT');
    expect(circuitVerdict('OPEN', T0, at(CIRCUIT_OPEN_SECONDS))).toBe('PROBE');
    expect(circuitVerdict('OPEN', undefined, T0)).toBe('PROBE');
    expect(circuitVerdict('HALF_OPEN', T0, at(10_000))).toBe('REJECT');
  });

  it('opens after twenty failures in the window and reopens after a failed probe', () => {
    expect(circuitAfterFailure('CLOSED', CIRCUIT_ERROR_THRESHOLD - 1)).toBe('CLOSED');
    expect(circuitAfterFailure('CLOSED', CIRCUIT_ERROR_THRESHOLD)).toBe('OPEN');
    expect(circuitAfterFailure('HALF_OPEN', 1)).toBe('OPEN');
    expect(circuitAfterFailure('OPEN', 99)).toBe('OPEN');
  });
});

describe('status of a notification from its attempts', () => {
  const roll = (current: string, ...attempts: string[]): string => rollupNotificationStatus({ current, attempts });

  it('moves forward with the best attempt and never backwards', () => {
    expect(roll('Queued', 'Sending')).toBe('Sending');
    expect(roll('Sending', 'ProviderAccepted')).toBe('ProviderAccepted');
    expect(roll('ProviderAccepted', 'Delivered')).toBe('Delivered');
    expect(roll('Delivered', 'ProviderAccepted')).toBe('Delivered');
    expect(roll('Read', 'Delivered')).toBe('Read');
  });

  it('keeps a notification delivered in the application when an external channel fails', () => {
    expect(roll('Delivered', 'Failed', 'Failed')).toBe('Delivered');
    expect(roll('Delivered', 'Unknown')).toBe('Delivered');
  });

  it('does not take a provider read for the reading of the person', () => {
    expect(roll('Sending', 'Read')).toBe('Delivered');
  });

  it('stays in progress while an attempt is waiting or in flight', () => {
    expect(roll('Queued', 'Failed', 'Queued')).toBe('Queued');
    expect(roll('Sending', 'Failed', 'Sending')).toBe('Sending');
  });

  it('is Failed when every attempt failed and Unknown when one may have been sent', () => {
    expect(roll('Sending', 'Failed')).toBe('Failed');
    expect(roll('Sending', 'Failed', 'Failed')).toBe('Failed');
    expect(roll('Sending', 'Unknown')).toBe('Unknown');
    expect(roll('Sending', 'Failed', 'Unknown')).toBe('Unknown');
    expect(roll('Queued', 'Cancelled')).toBe('Queued');
  });

  it('lifts Failed and Unknown by a delivery that is reported late and by a new attempt of a replay', () => {
    expect(roll('Failed', 'Failed', 'Delivered')).toBe('Delivered');
    expect(roll('Unknown', 'Unknown', 'ProviderAccepted')).toBe('ProviderAccepted');
    expect(roll('Failed', 'Failed', 'Queued')).toBe('Queued');
    expect(roll('Unknown', 'Unknown')).toBe('Unknown');
    expect(roll('Failed', 'Failed')).toBe('Failed');
  });

  it('lets a message that a provider accepted fail when it bounces, but not one that was delivered', () => {
    expect(roll('ProviderAccepted', 'Failed')).toBe('Failed');
    expect(roll('ProviderAccepted', 'ProviderAccepted')).toBe('ProviderAccepted');
    expect(roll('Delivered', 'Failed')).toBe('Delivered');
  });

  it('leaves the states a command decided alone', () => {
    expect(roll('Cancelled', 'Delivered')).toBe('Cancelled');
    expect(roll('Expired', 'Delivered')).toBe('Expired');
    expect(roll('Suppressed', 'Queued')).toBe('Suppressed');
  });
});
