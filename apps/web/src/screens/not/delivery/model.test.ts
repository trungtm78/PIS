import { describe, expect, it } from 'vitest';
import { failure, rawAttempt } from './test-support';
import { describeProblem, mayCancel, mayReplay, milestonesOf, reasonIsValid, risksDoubleSend, toAttempt, toDetail } from './model';
import type { AttemptView } from './model';

const attempt = (overrides: Record<string, unknown> = {}): AttemptView => {
  const view = toAttempt(rawAttempt(overrides));
  if (view === undefined) throw new Error('not an attempt');
  return view;
};

describe('toAttempt', () => {
  it('reads the allowlisted fields of a send and nothing else', () => {
    const view = attempt({ status: 'Failed', failure_class: 'RETRYABLE', error_code: 'HTTP_503', recipient: 'a@b.test', address: 'x', body: 'secret text' });
    expect(view).toMatchObject({ id: 'a-1', channel: 'EMAIL', attemptNo: 1, status: 'Failed', failureClass: 'RETRYABLE', errorCode: 'HTTP_503', fallbackChannel: 'SMS', notificationVersion: 3 });
    expect(JSON.stringify(view)).not.toMatch(/a@b\.test|secret text/);
  });

  it('refuses what is not a send: a missing field, a status it does not know, a version that is not a whole number', () => {
    expect(toAttempt(null)).toBeUndefined();
    expect(toAttempt([])).toBeUndefined();
    expect(toAttempt({})).toBeUndefined();
    expect(toAttempt(rawAttempt({ status: 'Teleported' }))).toBeUndefined();
    expect(toAttempt(rawAttempt({ status: undefined }))).toBeUndefined();
    expect(toAttempt(rawAttempt({ notification_version: 1.5 }))).toBeUndefined();
    expect(toAttempt(rawAttempt({ id: '' }))).toBeUndefined();
    expect(toAttempt(rawAttempt({ attempt_no: -1 }))).toBeUndefined();
  });

  it('keeps no failure class it does not know and takes empty strings for nothing', () => {
    expect(attempt({ failure_class: 'WEIRD' }).failureClass).toBeNull();
    expect(attempt({ error_code: '' }).errorCode).toBeNull();
    expect(attempt({ ack_required: 'yes' }).ackRequired).toBe(false);
    expect(attempt({ notification_status: undefined }).notificationStatus).toBe('');
  });
});

describe('toDetail', () => {
  it('reads the journey of the notification and the history of the attempt, leaving out what is not readable', () => {
    const detail = toDetail({
      ...rawAttempt(),
      journey: [rawAttempt(), { nonsense: true }, rawAttempt({ id: 'a-2', attempt_no: 2 })],
      history: [{ from_status: null, to_status: 'SENDING', cause: 'CREATED', occurred_at: '2026-10-24T03:00:00.000Z' }, { to_status: 'X' }, 'text', { from_status: 'SENDING', to_status: 'FAILED', cause: 'RESPONSE', occurred_at: '2026-10-24T03:00:01.000Z' }],
    });
    expect(detail?.journey.map((item) => item.id)).toEqual(['a-1', 'a-2']);
    expect(detail?.history.map((item) => [item.fromStatus, item.toStatus])).toEqual([[null, 'SENDING'], ['SENDING', 'FAILED']]);
    expect(toDetail({ ...rawAttempt(), journey: 'x', history: 4 })).toMatchObject({ journey: [], history: [] });
    expect(toDetail({})).toBeUndefined();
    expect(toDetail(null)).toBeUndefined();
  });
});

describe('milestonesOf: the five sends of a channel', () => {
  it('shows each send as it stands: went through, failed, in flight, waiting for its time, not reached', () => {
    const journey = [
      attempt({ id: 'a1', attempt_no: 1, status: 'Failed', failed_at: '2026-10-24T03:00:01.000Z' }),
      attempt({ id: 'a2', attempt_no: 2, status: 'Unknown', failed_at: '2026-10-24T03:00:40.000Z' }),
      attempt({ id: 'a3', attempt_no: 3, status: 'Cancelled', queued_at: '2026-10-24T03:03:00.000Z' }),
      attempt({ id: 'a4', attempt_no: 4, status: 'Sending', sending_at: '2026-10-24T03:12:00.000Z' }),
      attempt({ id: 'a5', attempt_no: 5, status: 'Queued', next_retry_at: '2026-10-24T03:42:00.000Z' }),
      attempt({ id: 's1', channel: 'SMS', attempt_no: 1, status: 'Delivered', accepted_at: '2026-10-24T03:43:00.000Z' }),
    ];
    expect(milestonesOf(journey, 'EMAIL').map((milestone) => [milestone.attemptNo, milestone.offsetSeconds, milestone.state])).toEqual([
      [1, 0, 'failed'],
      [2, 30, 'failed'],
      [3, 120, 'failed'],
      [4, 600, 'sending'],
      [5, 1800, 'waiting'],
    ]);
    expect(milestonesOf(journey, 'EMAIL').map((milestone) => milestone.at)).toEqual([
      '2026-10-24T03:00:01.000Z',
      '2026-10-24T03:00:40.000Z',
      '2026-10-24T03:03:00.000Z',
      '2026-10-24T03:12:00.000Z',
      '2026-10-24T03:42:00.000Z',
    ]);
    expect(milestonesOf(journey, 'SMS').map((milestone) => milestone.state)).toEqual(['delivered', 'unreached', 'unreached', 'unreached', 'unreached']);
    expect(milestonesOf(journey, 'SMS')[0]?.at).toBe('2026-10-24T03:43:00.000Z');
    expect(milestonesOf([], 'EMAIL').every((milestone) => milestone.state === 'unreached' && milestone.at === null)).toBe(true);
  });

  it('falls back on the earlier moment of a send that has no time of its own', () => {
    const journey = [
      attempt({ attempt_no: 1, status: 'Suppressed', failed_at: null, sending_at: null, queued_at: '2026-10-24T03:00:00.000Z' }),
      attempt({ id: 'a2', attempt_no: 2, status: 'Queued', next_retry_at: null, queued_at: '2026-10-24T03:01:00.000Z' }),
      attempt({ id: 'a3', attempt_no: 3, status: 'Read', accepted_at: null, sending_at: '2026-10-24T03:02:00.000Z' }),
    ];
    expect(milestonesOf(journey, 'EMAIL').slice(0, 3).map((milestone) => milestone.at)).toEqual(['2026-10-24T03:00:00.000Z', '2026-10-24T03:01:00.000Z', '2026-10-24T03:02:00.000Z']);
  });
});

describe('what the operator may do with a send', () => {
  it('replays a failed notification, and an Unknown one only once its day of reconciliation is over, with a warning', () => {
    expect(mayReplay(attempt({ notification_status: 'Failed', status: 'Failed' }))).toBe(true);
    expect(mayReplay(attempt({ notification_status: 'Unknown', status: 'Unknown', needs_reconcile: true }))).toBe(false);
    expect(mayReplay(attempt({ notification_status: 'Unknown', status: 'Unknown', needs_reconcile: false }))).toBe(true);
    expect(mayReplay(attempt({ notification_status: 'Delivered' }))).toBe(false);
    expect(risksDoubleSend(attempt({ notification_status: 'Unknown', needs_reconcile: false }))).toBe(true);
    expect(risksDoubleSend(attempt({ notification_status: 'Failed' }))).toBe(false);
    expect(risksDoubleSend(attempt({ notification_status: 'Unknown', needs_reconcile: true }))).toBe(false);
  });

  it('cancels a send that is waiting, unless its notification is already over', () => {
    expect(mayCancel(attempt({ status: 'Queued', notification_status: 'Queued' }))).toBe(true);
    expect(mayCancel(attempt({ status: 'Queued', notification_status: 'Delivered' }))).toBe(true);
    expect(mayCancel(attempt({ status: 'Sending' }))).toBe(false);
    for (const over of ['Failed', 'Unknown', 'Expired', 'Cancelled', 'Suppressed']) expect(mayCancel(attempt({ status: 'Queued', notification_status: over }))).toBe(false);
  });

  it('accepts a reason of 10 to 2000 characters once trimmed', () => {
    expect(reasonIsValid('too short')).toBe(false);
    expect(reasonIsValid('   ten chars  ')).toBe(false);
    expect(reasonIsValid('exactly ten')).toBe(true);
    expect(reasonIsValid('x'.repeat(2000))).toBe(true);
    expect(reasonIsValid('x'.repeat(2001))).toBe(false);
  });
});

describe('describeProblem', () => {
  it.each([
    ['RECONCILE_REQUIRED', 'reconcile'],
    ['NOTIFICATION_EXPIRED', 'expired'],
    ['NOTIFICATION_STATE_INVALID', 'stateInvalid'],
    ['VERSION_CONFLICT', 'conflict'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['VALIDATION_FAILED', 'invalid'],
    ['SESSION_EXPIRED', 'session'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(failure(409, code))).toBe(reason);
  });

  it('calls a failure that is not an API answer general', () => {
    expect(describeProblem(new Error('boom'))).toBe('general');
  });
});
