import type { DomainError } from '../src/errors';
import {
  DIRECTIVE_POLICY_DEFAULTS,
  addDaysTo,
  assertCloseEvidence,
  assertDirectiveCloser,
  assertExtension,
  assertExtensionDecider,
  daysBetweenDays,
  defaultDirectivePolicy,
  directiveClock,
  directiveStateAt,
  effectiveDirectiveStatus,
  isDay,
  meetingTypeOf,
  nextDirectiveStatus,
  parseDirectivePolicy,
  periodCounts,
  periodFacts,
} from '../src/directive';
import type { DirectiveHistory } from '../src/directive';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const policy = DIRECTIVE_POLICY_DEFAULTS;

describe('days', () => {
  it('knows a real calendar day and counts whole days', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-2-1')).toBe(false);
    expect(isDay(20260101)).toBe(false);
    expect(daysBetweenDays('2026-12-30', '2027-01-02')).toBe(3);
    expect(addDaysTo('2026-02-27', 2)).toBe('2026-03-01');
  });

  it('reads the type of a meeting', () => {
    expect(meetingTypeOf('WEEKLY')).toBe('WEEKLY');
    expect(meetingTypeOf('DAILY')).toBeUndefined();
  });
});

describe('the clock of a directive (BR-DIR-04)', () => {
  it('is OVERDUE only for an open directive past its due day, and never for an ended one', () => {
    expect(effectiveDirectiveStatus('OPEN', '2026-11-07', '2026-11-08')).toBe('OVERDUE');
    expect(effectiveDirectiveStatus('IN_PROGRESS', '2026-11-08', '2026-11-08')).toBe('IN_PROGRESS');
    expect(effectiveDirectiveStatus('DONE', '2026-01-01', '2026-11-08')).toBe('DONE');
    expect(effectiveDirectiveStatus('CANCELLED', '2026-01-01', '2026-11-08')).toBe('CANCELLED');
  });

  it('reminds on T-3, T-1 and the due day, shows the directive from T-3, and says when it goes up', () => {
    const at = (today: string) => directiveClock('OPEN', '2026-11-10', today, policy);
    expect(at('2026-11-06')).toMatchObject({ phase: 'DUE_LATER', daysToDue: 4, reminderToday: false });
    expect(at('2026-11-07')).toMatchObject({ phase: 'DUE_SOON', daysToDue: 3, reminderToday: true });
    expect(at('2026-11-08')).toMatchObject({ phase: 'DUE_SOON', daysToDue: 2, reminderToday: false });
    expect(at('2026-11-09')).toMatchObject({ phase: 'DUE_SOON', daysToDue: 1, reminderToday: true });
    expect(at('2026-11-10')).toMatchObject({ phase: 'DUE_TODAY', daysToDue: 0, reminderToday: true, overdueDays: 0, escalatesOn: '2026-11-17' });
    expect(at('2026-11-11')).toMatchObject({ phase: 'OVERDUE', status: 'OVERDUE', overdueDays: 1, daysToDue: -1 });
    expect(at('2026-11-16')).toMatchObject({ phase: 'OVERDUE', overdueDays: 6 });
    expect(at('2026-11-17')).toMatchObject({ phase: 'ESCALATED', overdueDays: 7, escalatesOn: null });
  });

  it('has no clock once the directive is done or cancelled', () => {
    expect(directiveClock('DONE', '2026-01-01', '2026-11-08', policy)).toEqual({ status: 'DONE', phase: 'ENDED', daysToDue: null, overdueDays: null, reminderToday: false, escalatesOn: null });
    expect(directiveClock('CANCELLED', '2030-01-01', '2026-11-08', policy).phase).toBe('ENDED');
  });

  it('follows a policy that a tenant approved', () => {
    const custom = { ...policy, reminderDaysBefore: [5, 2], escalateAfterOverdueDays: 2 };
    expect(directiveClock('OPEN', '2026-11-10', '2026-11-05', custom)).toMatchObject({ phase: 'DUE_SOON', reminderToday: true });
    expect(directiveClock('OPEN', '2026-11-10', '2026-11-12', custom).phase).toBe('ESCALATED');
  });
});

describe('the policy as data', () => {
  it('has built-in defaults that are not an approved rule', () => {
    expect(defaultDirectivePolicy()).toMatchObject({ type: 'DIRECTIVE_POLICY', code: 'DEFAULT', version: null, source: 'DEFAULT', params: { reminderDaysBefore: [3, 1, 0], escalateAfterOverdueDays: 7, maxExtensions: 3, maxExtensionDays: 60, closeRequiresEvidence: true } });
  });

  it('judges the parameters of an approved rule again and refuses what it cannot understand', () => {
    const good = { reminder_days_before: [1, 3, 0], escalate_after_overdue_days: 5, max_extensions: 2, max_extension_days: 30, close_requires_evidence: false };
    expect(parseDirectivePolicy(good)).toEqual({ reminderDaysBefore: [3, 1, 0], escalateAfterOverdueDays: 5, maxExtensions: 2, maxExtensionDays: 30, closeRequiresEvidence: false });
    for (const [field, value] of [
      ['reminder_days_before', []],
      ['reminder_days_before', [3, 3]],
      ['reminder_days_before', [-1]],
      ['escalate_after_overdue_days', 0],
      ['max_extensions', 1.5],
      ['max_extension_days', 400],
      ['close_requires_evidence', 'yes'],
    ] as const) {
      expect(refusal(() => parseDirectivePolicy({ ...good, [field]: value }))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: field });
    }
    expect(refusal(() => parseDirectivePolicy({ ...good, extra: 1 }))).toMatchObject({ detail: 'extra' });
    expect(refusal(() => parseDirectivePolicy(null))).toMatchObject({ detail: 'params' });
    expect(refusal(() => parseDirectivePolicy([]))).toMatchObject({ detail: 'params' });
  });
});

describe('the moves of a directive (BR-DIR-02)', () => {
  it('works on a live directive, takes it to in progress on the first note, ends it by closing or cancelling and reopens it', () => {
    expect(nextDirectiveStatus('OPEN', 'ASSIGN')).toBe('OPEN');
    expect(nextDirectiveStatus('IN_PROGRESS', 'ASSIGN')).toBe('IN_PROGRESS');
    expect(nextDirectiveStatus('OPEN', 'PROGRESS')).toBe('IN_PROGRESS');
    expect(nextDirectiveStatus('IN_PROGRESS', 'REQUEST_EXTENSION')).toBe('IN_PROGRESS');
    expect(nextDirectiveStatus('OPEN', 'DECIDE_EXTENSION')).toBe('OPEN');
    expect(nextDirectiveStatus('OPEN', 'CLOSE')).toBe('DONE');
    expect(nextDirectiveStatus('IN_PROGRESS', 'CANCEL')).toBe('CANCELLED');
    expect(nextDirectiveStatus('DONE', 'REOPEN')).toBe('IN_PROGRESS');
    expect(nextDirectiveStatus('CANCELLED', 'REOPEN')).toBe('OPEN');
  });

  it('refuses every other move with 409 DIRECTIVE_STATE_INVALID naming the state', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      for (const move of ['ASSIGN', 'PROGRESS', 'REQUEST_EXTENSION', 'DECIDE_EXTENSION', 'CLOSE', 'CANCEL'] as const) {
        expect(refusal(() => nextDirectiveStatus(status, move))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID', status: 409, extensions: { status, move } });
      }
    }
    expect(refusal(() => nextDirectiveStatus('OPEN', 'REOPEN'))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID' });
    expect(refusal(() => nextDirectiveStatus('IN_PROGRESS', 'REOPEN'))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID' });
  });
});

describe('who may close and decide', () => {
  const parties = { createdBy: 'AAAA0000-0000-4000-8000-000000000001', assigneeMembershipId: 'aaaa0000-0000-4000-8000-000000000002' };

  it('refuses the person who recorded the directive and the person who must do it (case-insensitively), and lets a third person close', () => {
    expect(refusal(() => assertDirectiveCloser('aaaa0000-0000-4000-8000-000000000001', parties))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(refusal(() => assertDirectiveCloser('AAAA0000-0000-4000-8000-000000000002', parties))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect(() => assertDirectiveCloser('aaaa0000-0000-4000-8000-000000000003', parties)).not.toThrow();
    expect(() => assertDirectiveCloser('aaaa0000-0000-4000-8000-000000000002', { ...parties, assigneeMembershipId: null })).not.toThrow();
  });

  it('refuses the person who asked for an extension as its decider', () => {
    expect(refusal(() => assertExtensionDecider('AB', 'ab'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect(() => assertExtensionDecider('ab', 'cd')).not.toThrow();
  });

  it('needs evidence to close where the policy says so', () => {
    expect(refusal(() => assertCloseEvidence(policy, 0))).toMatchObject({ code: 'DIRECTIVE_EVIDENCE_REQUIRED', status: 422 });
    expect(() => assertCloseEvidence(policy, 1)).not.toThrow();
    expect(() => assertCloseEvidence({ ...policy, closeRequiresEvidence: false }, 0)).not.toThrow();
  });
});

describe('an extension', () => {
  const ask = (proposedDueOn: string, extensionCount = 0) => () => assertExtension(policy, { currentDueOn: '2026-11-10', proposedDueOn, extensionCount });

  it('moves the due day forward by no more than the policy allows, and not more often than it allows', () => {
    expect(ask('2026-11-11')).not.toThrow();
    expect(ask('2027-01-09')).not.toThrow();
    expect(refusal(ask('2026-11-10'))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID', detail: 'proposed_due_on' });
    expect(refusal(ask('2026-11-09'))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID' });
    expect(refusal(ask('2027-01-10'))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID', extensions: { max_extension_days: 60 } });
    expect(refusal(ask('2026-13-01'))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID' });
    expect(refusal(ask('2026-11-11', 3))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_LIMIT', status: 422, extensions: { max_extensions: 3 } });
    expect(ask('2026-11-11', 2)).not.toThrow();
  });
});

const history = (overrides: Partial<DirectiveHistory> = {}): DirectiveHistory => ({ raisedOn: '2026-10-05', originalDueOn: '2026-10-20', events: [], ...overrides });

describe('the state of a directive on a day, from its history (BR-DIR-07)', () => {
  const closed = history({
    events: [
      { type: 'CREATED', day: '2026-10-05', toDueOn: null },
      { type: 'PROGRESS', day: '2026-10-08', toDueOn: null },
      { type: 'EXTENSION_REQUESTED', day: '2026-10-18', toDueOn: '2026-11-05' },
      { type: 'EXTENSION_APPROVED', day: '2026-10-19', toDueOn: '2026-11-05' },
      { type: 'CLOSED', day: '2026-11-02', toDueOn: null },
      { type: 'REOPENED', day: '2026-11-04', toDueOn: null },
    ],
  });

  it('replays the events up to the day', () => {
    expect(directiveStateAt(closed, '2026-10-04')).toMatchObject({ existed: false });
    expect(directiveStateAt(closed, '2026-10-05')).toEqual({ existed: true, status: 'OPEN', dueOn: '2026-10-20' });
    expect(directiveStateAt(closed, '2026-10-10')).toEqual({ existed: true, status: 'IN_PROGRESS', dueOn: '2026-10-20' });
    expect(directiveStateAt(closed, '2026-10-19')).toEqual({ existed: true, status: 'IN_PROGRESS', dueOn: '2026-11-05' });
    expect(directiveStateAt(closed, '2026-11-03')).toEqual({ existed: true, status: 'DONE', dueOn: '2026-11-05' });
    expect(directiveStateAt(closed, '2026-11-04')).toEqual({ existed: true, status: 'IN_PROGRESS', dueOn: '2026-11-05' });
  });

  it('reopens a cancelled directive to open and ignores a note of progress on one that is already in progress', () => {
    const cancelled = history({
      events: [
        { type: 'CANCELLED', day: '2026-10-06', toDueOn: null },
        { type: 'REOPENED', day: '2026-10-07', toDueOn: null },
        { type: 'PROGRESS', day: '2026-10-08', toDueOn: null },
        { type: 'PROGRESS', day: '2026-10-09', toDueOn: null },
        { type: 'ASSIGNED', day: '2026-10-09', toDueOn: null },
      ],
    });
    expect(directiveStateAt(cancelled, '2026-10-06').status).toBe('CANCELLED');
    expect(directiveStateAt(cancelled, '2026-10-07').status).toBe('OPEN');
    expect(directiveStateAt(cancelled, '2026-10-09').status).toBe('IN_PROGRESS');
  });
});

describe('the directives of a period (BR-DIR-07)', () => {
  const from = '2026-11-01';
  const to = '2026-11-30';

  it('counts a directive raised in the period that is still open and late at its end as overdue', () => {
    const facts = periodFacts(history({ raisedOn: '2026-11-03', originalDueOn: '2026-11-20' }), from, to);
    expect(facts).toEqual({ raisedInPeriod: true, closedInPeriod: false, extendedInPeriod: false, statusAtEnd: 'OVERDUE', openAtEnd: true });
  });

  it('counts the due day of the last day as late at the end of that day', () => {
    expect(periodFacts(history({ raisedOn: '2026-11-03', originalDueOn: '2026-11-30' }), from, to)?.statusAtEnd).toBe('OVERDUE');
    expect(periodFacts(history({ raisedOn: '2026-11-03', originalDueOn: '2026-12-01' }), from, to)?.statusAtEnd).toBe('OPEN');
  });

  it('counts one that was closed and one that was extended in the period', () => {
    const one = history({
      raisedOn: '2026-10-05',
      originalDueOn: '2026-11-10',
      events: [
        { type: 'EXTENSION_APPROVED', day: '2026-11-08', toDueOn: '2026-12-20' },
        { type: 'CLOSED', day: '2026-11-25', toDueOn: null },
      ],
    });
    expect(periodFacts(one, from, to)).toEqual({ raisedInPeriod: false, closedInPeriod: true, extendedInPeriod: true, statusAtEnd: 'DONE', openAtEnd: false });
  });

  it('leaves out one that did not exist yet, and one that ended before the period and was not touched in it', () => {
    expect(periodFacts(history({ raisedOn: '2026-12-02' }), from, to)).toBeUndefined();
    const ended = history({ raisedOn: '2026-09-01', originalDueOn: '2026-09-30', events: [{ type: 'CLOSED', day: '2026-09-20', toDueOn: null }] });
    expect(periodFacts(ended, from, to)).toBeUndefined();
    const reopened = history({ raisedOn: '2026-09-01', originalDueOn: '2026-12-30', events: [{ type: 'CLOSED', day: '2026-09-20', toDueOn: null }, { type: 'REOPENED', day: '2026-11-05', toDueOn: null }] });
    expect(periodFacts(reopened, from, to)).toMatchObject({ statusAtEnd: 'IN_PROGRESS', openAtEnd: true });
  });

  it('adds the facts up: the counts are those of the list', () => {
    const list = [
      periodFacts(history({ raisedOn: '2026-11-03', originalDueOn: '2026-11-20' }), from, to),
      periodFacts(history({ raisedOn: '2026-11-04', originalDueOn: '2026-12-20', events: [{ type: 'PROGRESS', day: '2026-11-06', toDueOn: null }] }), from, to),
      periodFacts(history({ raisedOn: '2026-10-05', originalDueOn: '2026-11-10', events: [{ type: 'CLOSED', day: '2026-11-25', toDueOn: null }] }), from, to),
      periodFacts(history({ raisedOn: '2026-11-05', originalDueOn: '2026-12-20', events: [{ type: 'CANCELLED', day: '2026-11-06', toDueOn: null }] }), from, to),
    ].flatMap((fact) => (fact === undefined ? [] : [fact]));
    expect(periodCounts(list)).toEqual({ total: 4, raised: 3, closed: 1, extended: 0, openAtEnd: 2, overdueAtEnd: 1, byStatus: { OPEN: 0, IN_PROGRESS: 1, DONE: 1, OVERDUE: 1, CANCELLED: 1 } });
    expect(periodCounts([])).toMatchObject({ total: 0, overdueAtEnd: 0 });
  });
});
