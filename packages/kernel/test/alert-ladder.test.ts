import { DomainError } from '../src/errors';
import { assertLadderPayload, rungMayMove, carriesNoFinancialFigure, ladderDefaults, ladderEventType, ladderPolicyOf, nextLadderMove, receiptStateOf, validateRuleParams } from '../src/index';
import type { LadderInput, RungRecord } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const T0 = '2026-11-08T01:00:00.000Z';
const at = (minutes: number): Date => new Date(Date.parse(T0) + minutes * 60_000);
const urgent = ladderDefaults().URGENT;
const input = (rungs: RungRecord[], minutes: number, more: Partial<LadderInput> = {}): LadderInput => ({ policy: urgent, rungs, now: at(minutes), startedAt: T0, acted: false, cleared: false, escalated: false, ...more });
const rung = (index: number, state: RungRecord['state'], sentMinute: number): RungRecord => ({ index, channel: urgent.rungs[index]?.channel ?? 'IN_APP', state, sentAt: at(sentMinute).toISOString() });

describe('the channel ladder (G2-6)', () => {
  it('starts with the inbox, waits for a receipt, and goes up the rungs when nobody has seen the alert', () => {
    expect(nextLadderMove(input([], 0))).toEqual({ kind: 'SEND_RUNG', index: 0 });
    // The inbox has no wait: the push goes at once.
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0)], 0))).toEqual({ kind: 'SEND_RUNG', index: 1 });
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0), rung(1, 'SENT', 0)], 10))).toEqual({ kind: 'WAIT', until: at(15).toISOString() });
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0), rung(1, 'DELIVERED', 0)], 15))).toEqual({ kind: 'SEND_RUNG', index: 2 });
  });

  it('does not wait for a channel that failed or was not sent', () => {
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0), rung(1, 'FAILED', 1)], 2))).toEqual({ kind: 'SEND_RUNG', index: 2 });
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0), rung(1, 'SUPPRESSED', 1)], 2))).toEqual({ kind: 'SEND_RUNG', index: 2 });
  });

  it('is done by a receipt of the kind the policy wants, by a person acting, and by the condition clearing', () => {
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0)], 1)).kind).toBe('SEND_RUNG');
    expect(nextLadderMove(input([rung(0, 'SEEN', 0)], 1))).toEqual({ kind: 'DONE', by: 'RECEIPT' });
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0)], 1, { acted: true }))).toEqual({ kind: 'DONE', by: 'ACTED' });
    expect(nextLadderMove(input([rung(0, 'DELIVERED', 0)], 1, { cleared: true, acted: true }))).toEqual({ kind: 'DONE', by: 'CLEARED' });
    // For an action-level alert a delivery is enough.
    const action = { ...input([rung(0, 'DELIVERED', 0)], 1), policy: ladderDefaults().ACTION };
    expect(nextLadderMove(action)).toEqual({ kind: 'DONE', by: 'RECEIPT' });
  });

  it('hands the alert to the escalation after the last rung, once, and expires an old ladder', () => {
    const all = [rung(0, 'DELIVERED', 0), rung(1, 'DELIVERED', 0), rung(2, 'DELIVERED', 15), rung(3, 'DELIVERED', 45)];
    expect(nextLadderMove(input(all, 60))).toEqual({ kind: 'WAIT', until: at(75).toISOString() });
    expect(nextLadderMove(input(all, 75))).toEqual({ kind: 'ESCALATE' });
    expect(nextLadderMove(input(all, 76, { escalated: true }))).toEqual({ kind: 'EXHAUSTED' });
    expect(nextLadderMove(input(all.slice(0, 2), 1441))).toEqual({ kind: 'EXPIRED' });
    const watch = { ...input([rung(0, 'DELIVERED', 0)], 1), policy: ladderDefaults().WATCH };
    expect(nextLadderMove({ ...watch, now: at(0) })).toEqual({ kind: 'DONE', by: 'RECEIPT' });
  });

  it('judges the policy: the inbox first, a channel once, whole minutes', () => {
    expect(ladderPolicyOf(urgent)).toEqual(urgent);
    expect(refusal(() => ladderPolicyOf({ ...urgent, rungs: [{ channel: 'PUSH', wait_minutes: 1 }] })).detail).toBe('rungs[0].channel');
    expect(refusal(() => ladderPolicyOf({ ...urgent, rungs: [{ channel: 'IN_APP', wait_minutes: 0 }, { channel: 'PUSH', wait_minutes: 1 }, { channel: 'PUSH', wait_minutes: 1 }] })).detail).toBe('rungs');
    expect(refusal(() => ladderPolicyOf({ ...urgent, stop_when: 'SENT' })).detail).toBe('stop_when');
    for (const code of ['URGENT', 'ACTION', 'WATCH'] as const) expect(() => validateRuleParams('ALERT_CHANNEL_LADDER', ladderDefaults()[code])).not.toThrow();
  });
});

describe('receipts of a rung', () => {
  const none = { notificationExists: true, readAt: null, attemptStatuses: [], suppressionReason: null };

  it('is queued without a notification, sent after a send, delivered or seen on evidence', () => {
    expect(receiptStateOf({ ...none, notificationExists: false })).toBe('QUEUED');
    expect(receiptStateOf({ ...none, attemptStatuses: ['ProviderAccepted'] })).toBe('SENT');
    expect(receiptStateOf({ ...none, attemptStatuses: ['ProviderAccepted', 'Delivered'] })).toBe('DELIVERED');
    expect(receiptStateOf({ ...none, attemptStatuses: ['Delivered', 'Read'] })).toBe('SEEN');
    expect(receiptStateOf({ ...none, readAt: '2026-11-08T01:02:00Z' })).toBe('SEEN');
  });

  it('lets a late delivery win over a failure and counts failure only when nothing better happened', () => {
    expect(receiptStateOf({ ...none, attemptStatuses: ['Failed', 'Delivered'] })).toBe('DELIVERED');
    expect(receiptStateOf({ ...none, attemptStatuses: ['Failed'] })).toBe('FAILED');
    expect(receiptStateOf({ ...none, attemptStatuses: ['Suppressed'] })).toBe('SUPPRESSED');
    expect(receiptStateOf({ ...none, suppressionReason: 'NO_CONSENT' })).toBe('SUPPRESSED');
  });
});

describe('the moves of a receipt (review of GOV-10)', () => {
  it('lets a rung that was only sent turn out failed or suppressed, and never moves a delivered or seen rung back', () => {
    expect(rungMayMove('SENT', null, 'FAILED')).toBe(true);
    expect(rungMayMove('SENT', null, 'SUPPRESSED')).toBe(true);
    expect(rungMayMove('QUEUED', null, 'SENT')).toBe(true);
    expect(rungMayMove('DELIVERED', null, 'FAILED')).toBe(false);
    expect(rungMayMove('SEEN', null, 'DELIVERED')).toBe(false);
    expect(rungMayMove('SENT', null, 'QUEUED')).toBe(false);
    expect(rungMayMove('SENT', null, 'SENT')).toBe(false);
  });

  it('lifts a failure by a late delivery, and the verdict "no workflow" by anything that happened', () => {
    expect(rungMayMove('FAILED', null, 'DELIVERED')).toBe(true);
    expect(rungMayMove('SUPPRESSED', 'NO_WORKFLOW', 'SENT')).toBe(true);
    expect(rungMayMove('SUPPRESSED', 'NO_CONSENT', 'SENT')).toBe(false);
  });
});

describe('the message of a rung', () => {
  it('carries no financial figure', () => {
    expect(carriesNoFinancialFigure('Mo ung dung de xem viec khan')).toBe(true);
    expect(carriesNoFinancialFigure('Thanh toan 2.500.000.000 dong')).toBe(false);
    expect(carriesNoFinancialFigure('chiem 45%')).toBe(false);
    expect(carriesNoFinancialFigure('10 ty')).toBe(true);
    expect(carriesNoFinancialFigure('500 VND')).toBe(false);
  });

  it('accepts only the type, the severity and an in-app link', () => {
    const ok = { alertType: 'ADVANCE', severity: 'URGENT', deepLink: '/home/work/4a1c2a0e-1111-4222-8333-444455556666' };
    expect(assertLadderPayload(ok)).toEqual(ok);
    expect(refusal(() => assertLadderPayload({ ...ok, amount: 5 })).detail).toBe('payload.amount');
    expect(refusal(() => assertLadderPayload({ ...ok, deepLink: 'https://x.test/a?amount=1234567' })).detail).toBe('payload.deepLink');
    expect(refusal(() => assertLadderPayload({ ...ok, deepLink: '/pay/2500000000' })).detail).toBe('payload.deepLink');
    expect(ladderEventType('ZALO')).toBe('home.alert_ladder_zalo.v1');
  });
});

describe('the ladder with e-mail and Teams after an unacknowledged push (YCK.01)', () => {
  const policy = ladderPolicyOf({
    rungs: [
      { channel: 'IN_APP', wait_minutes: 0 },
      { channel: 'PUSH', wait_minutes: 20 },
      { channel: 'EMAIL', wait_minutes: 30 },
      { channel: 'TEAMS', wait_minutes: 30 },
    ],
    stop_when: 'SEEN',
    hand_off: 'ESCALATE',
    hand_off_after_minutes: 30,
    expires_after_minutes: 1440,
  });
  const record = (index: number, state: RungRecord['state'], sentMinute: number): RungRecord => ({ index, channel: policy.rungs[index]?.channel ?? 'IN_APP', state, sentAt: at(sentMinute).toISOString() });
  const run = (rungs: RungRecord[], minutes: number): LadderInput => ({ policy, rungs, now: at(minutes), startedAt: T0, acted: false, cleared: false, escalated: false });

  it('accepts TEAMS as a rung and names its engine channel and its event', () => {
    expect(policy.rungs.map((rungOfPolicy) => rungOfPolicy.channel)).toEqual(['IN_APP', 'PUSH', 'EMAIL', 'TEAMS']);
    expect(ladderEventType('TEAMS')).toBe('home.alert_ladder_teams.v1');
  });

  it('waits the configured time for the push, then sends the e-mail, then Teams, then hands the alert on', () => {
    // The push was shown on the device (a receipt of DELIVERED) but not opened: the policy wants it SEEN, so the wait runs out and the e-mail goes.
    expect(nextLadderMove(run([record(0, 'DELIVERED', 0), record(1, 'DELIVERED', 0)], 19))).toEqual({ kind: 'WAIT', until: at(20).toISOString() });
    expect(nextLadderMove(run([record(0, 'DELIVERED', 0), record(1, 'DELIVERED', 0)], 20))).toEqual({ kind: 'SEND_RUNG', index: 2 });
    expect(nextLadderMove(run([record(0, 'DELIVERED', 0), record(1, 'SENT', 0), record(2, 'SENT', 20)], 50))).toEqual({ kind: 'SEND_RUNG', index: 3 });
    expect(nextLadderMove(run([record(0, 'DELIVERED', 0), record(1, 'SENT', 0), record(2, 'SENT', 20), record(3, 'SENT', 50)], 110))).toEqual({ kind: 'ESCALATE' });
  });

  it('ends the ladder as soon as the person taps the push (a receipt of SEEN), without e-mail or Teams', () => {
    expect(nextLadderMove(run([record(0, 'DELIVERED', 0), record(1, 'SEEN', 0)], 5))).toEqual({ kind: 'DONE', by: 'RECEIPT' });
  });
});
