import { DomainError } from '../src/errors';
import {
  answeredSources,
  assertFeedbackInput,
  builtInDefault,
  closedWithoutRecord,
  floodPolicyDefaults,
  floodPolicyOf,
  floodProtects,
  groupForFlood,
  needsRationalisation,
  nextAlertFeedbackStatus,
  observationDecision,
  stormTransition,
  unhelpfulShare,
  validateRuleParams,
} from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('closing and reopening alerts (G2-8)', () => {
  const known = [
    { source: 'ADVANCE', sourceId: 'a', state: 'OPEN' as const },
    { source: 'PERMIT', sourceId: 'p', state: 'OPEN' as const },
    { source: 'ISSUE', sourceId: 'i', state: 'RESOLVED_BY_SYSTEM' as const },
  ];

  it('closes only what its source answered for, and says nothing about the rest', () => {
    const decision = observationDecision({ produced: [], known, answeredSources: new Set(['ADVANCE']), failedSources: new Set(['PERMIT']) });
    expect(decision.close).toEqual([{ source: 'ADVANCE', sourceId: 'a' }]);
    expect(decision.unknown).toEqual([{ source: 'PERMIT', sourceId: 'p' }]);
  });

  it('never closes an item of a source that failed in one list even if it answered in the others', () => {
    const decision = observationDecision({ produced: [], known, answeredSources: new Set(['ADVANCE', 'PERMIT']), failedSources: new Set(['ADVANCE']) });
    expect(decision.close).toEqual([{ source: 'PERMIT', sourceId: 'p' }]);
    expect(decision.unknown).toEqual([{ source: 'ADVANCE', sourceId: 'a' }]);
  });

  it('opens what is new, touches what is still there and reopens what came back', () => {
    const decision = observationDecision({
      produced: [
        { source: 'ADVANCE', sourceId: 'a' },
        { source: 'ISSUE', sourceId: 'i' },
        { source: 'GUARANTEE', sourceId: 'g' },
      ],
      known,
      answeredSources: new Set(['ADVANCE', 'ISSUE', 'GUARANTEE']),
      failedSources: new Set(),
    });
    expect(decision.touch).toEqual([{ source: 'ADVANCE', sourceId: 'a' }]);
    expect(decision.reopen).toEqual([{ source: 'ISSUE', sourceId: 'i' }]);
    expect(decision.open).toEqual([{ source: 'GUARANTEE', sourceId: 'g' }]);
  });

  it('says no source answered when a list was cut at the cap of a source, a list failed or nobody was read (review of GOV-10)', () => {
    const all = ['ADVANCE', 'PERMIT'];
    expect([...answeredSources(all, { members: 3, incomplete: false, failed: new Set(), truncated: false })]).toEqual(all);
    expect([...answeredSources(all, { members: 3, incomplete: false, failed: new Set(['PERMIT']), truncated: false })]).toEqual(['ADVANCE']);
    expect(answeredSources(all, { members: 3, incomplete: false, failed: new Set(), truncated: true }).size).toBe(0);
    expect(answeredSources(all, { members: 3, incomplete: true, failed: new Set(), truncated: false }).size).toBe(0);
    expect(answeredSources(all, { members: 0, incomplete: false, failed: new Set(), truncated: false }).size).toBe(0);
  });

  it('knows an item that closed with no decision of any person', () => {
    expect(closedWithoutRecord(0)).toBe(true);
    expect(closedWithoutRecord(2)).toBe(false);
    expect(closedWithoutRecord(null)).toBe(false);
  });
});

describe('the "this alert is wrong" report (G2-9)', () => {
  it('takes a reason from the catalogue, and OTHER only with a note', () => {
    expect(assertFeedbackInput({ reason: 'WRONG_DATA', note: undefined })).toEqual({ reason: 'WRONG_DATA', note: null });
    expect(assertFeedbackInput({ reason: 'DUPLICATE', note: '  same as the other  ' })).toEqual({ reason: 'DUPLICATE', note: 'same as the other' });
    expect(refusal(() => assertFeedbackInput({ reason: 'OTHER', note: 'x' })).detail).toBe('note');
    expect(refusal(() => assertFeedbackInput({ reason: 'MADE_UP', note: null })).detail).toBe('reason');
    expect(refusal(() => assertFeedbackInput({ reason: 'WRONG_DATA', note: 'x'.repeat(501) })).detail).toBe('note');
  });

  it('lets only the reporter withdraw and never lets the reporter review their own report', () => {
    expect(nextAlertFeedbackStatus('PENDING', 'WITHDRAW', { actor: 'a', reporter: 'a' })).toBe('WITHDRAWN');
    expect(refusal(() => nextAlertFeedbackStatus('PENDING', 'WITHDRAW', { actor: 'b', reporter: 'a' })).status).toBe(403);
    expect(refusal(() => nextAlertFeedbackStatus('PENDING', 'ACCEPT_FOR_TUNING', { actor: 'a', reporter: 'a' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(nextAlertFeedbackStatus('PENDING', 'ACCEPT_FOR_TUNING', { actor: 'b', reporter: 'a' })).toBe('ACCEPTED_FOR_TUNING');
    expect(nextAlertFeedbackStatus('PENDING', 'MARK_DUPLICATE', { actor: 'b', reporter: 'a' })).toBe('DUPLICATE_OF');
  });

  it('needs the reason of a rejection and moves only a pending report', () => {
    expect(refusal(() => nextAlertFeedbackStatus('PENDING', 'REJECT', { actor: 'b', reporter: 'a', reviewNote: ' ' })).detail).toBe('review_note');
    expect(nextAlertFeedbackStatus('PENDING', 'REJECT', { actor: 'b', reporter: 'a', reviewNote: 'the data is right' })).toBe('REJECTED');
    expect(refusal(() => nextAlertFeedbackStatus('REJECTED', 'ACCEPT_FOR_TUNING', { actor: 'b', reporter: 'a' })).code).toBe('ALERT_FEEDBACK_STATE_INVALID');
  });

  it('measures the unhelpful share of a type, and has none when nothing was shown', () => {
    expect(unhelpfulShare(3, 10)).toBe(30);
    expect(unhelpfulShare(0, 0)).toBeNull();
    expect(needsRationalisation(30, 30)).toBe(true);
    expect(needsRationalisation(29.9, 30)).toBe(false);
    expect(needsRationalisation(null, 30)).toBe(false);
    expect(builtInDefault('ALERT_FEEDBACK_POLICY', 'DEFAULT')?.unverified).toBe(true);
  });
});

describe('flood protection (G2-11)', () => {
  it('starts a storm above the start number, ends it below the end number and does not flap in between', () => {
    const policy = floodPolicyDefaults();
    const now = new Date('2026-11-08T03:00:00Z');
    const started = stormTransition({ active: false, since: null }, 11, policy, now);
    expect(started.change).toBe('STARTED');
    expect(stormTransition({ active: false, since: null }, 10, policy, now).change).toBe('NONE');
    expect(stormTransition(started.next, 7, policy, now).change).toBe('NONE');
    expect(stormTransition(started.next, 7, policy, now).next.active).toBe(true);
    expect(stormTransition(started.next, 4, policy, now).change).toBe('ENDED');
  });

  it('groups new alerts below the urgent level by cause then by source, and never an urgent one', () => {
    const items = [
      ...[1, 2, 3].map((n) => ({ source: 'GUARANTEE', id: `g${n}`, severity: 'WATCH' as const, causeKey: 'contract:c1', projectCode: 'P1', isNew: true })),
      ...[1, 2, 3].map((n) => ({ source: 'PERMIT', id: `p${n}`, severity: 'ACTION' as const, causeKey: null, projectCode: 'P2', isNew: true })),
      { source: 'PERMIT', id: 'urgent', severity: 'URGENT' as const, causeKey: null, projectCode: 'P2', isNew: true },
      { source: 'PERMIT', id: 'old', severity: 'WATCH' as const, causeKey: null, projectCode: 'P2', isNew: false },
    ];
    const policy = floodPolicyDefaults();
    const result = groupForFlood(items, policy, true);
    expect(result.groups.map((group) => [group.key, group.count])).toEqual([
      ['CAUSE:contract:c1', 3],
      ['SOURCE:PERMIT', 3],
    ]);
    expect(result.singles.map((entry) => entry.id).sort()).toEqual(['old', 'urgent']);
    // Outside a storm only items of one cause collapse.
    const calm = groupForFlood(items, policy, false);
    expect(calm.groups.map((group) => group.key)).toEqual(['CAUSE:contract:c1']);
    expect(calm.singles).toHaveLength(items.length - 3);
    expect(floodProtects({ active: false, since: null }, 31, policy)).toBe(true);
    expect(floodProtects({ active: false, since: null }, 30, policy)).toBe(false);
  });

  it('checks the policy: the end of a storm is not above its start, a group has at least two members', () => {
    expect(floodPolicyOf(floodPolicyDefaults())).toEqual(floodPolicyDefaults());
    expect(refusal(() => floodPolicyOf({ ...floodPolicyDefaults(), end_below: 50 })).detail).toBe('end_below');
    expect(refusal(() => floodPolicyOf({ ...floodPolicyDefaults(), min_group_size: 1 })).detail).toBe('min_group_size');
    expect(refusal(() => floodPolicyOf({ ...floodPolicyDefaults(), group_by: ['CAUSE', 'CAUSE'] })).detail).toBe('group_by');
    expect(() => validateRuleParams('ALERT_FLOOD_POLICY', floodPolicyDefaults())).not.toThrow();
  });
});
