import { CLAIM_POLICY_DEFAULTS, assertBarDeclarable, assertBarDecider, assertSettlementDecider, assertSettlementWithinClaim, claimAllowedSteps, claimAlerts, claimDeadlines, claimDueOn, claimKindAllowed, claimLimitation, claimNextStatus, claimRegisterReport, claimTermParams, isClaimOpen, limitationHorizon, parseClaimPolicy, validateClaimTerm, validateNewClaim, validateRecordedStep } from '../src/ctr-claim';
import type { ClaimFacts, ClaimReportInput, ContractClaimStatus, ClaimTerm } from '../src/ctr-claim';
import type { DomainError } from '../src/errors';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const calendar = (year: number, holidays: string[] = []): WorkCalendarContent => ({
  calendar_code: 'WORKDAY_VN',
  year,
  working_days: [1, 2, 3, 4, 5],
  holidays: holidays.map((date) => ({ date, name: 'Holiday' })),
  legal_basis_ref: 'test calendar',
});
const sourceOf = (...contents: WorkCalendarContent[]): WorkCalendarSource => {
  const byYear = new Map(contents.map((content) => [content.year, content]));
  return { forYear: (year) => byYear.get(year) };
};

const TERM: ClaimTerm = { claimantSide: 'CONTRACTOR', noticeDays: 28, particularsDays: 42, responseDays: 14, settlementDays: 30, basis: 'CALENDAR_DAYS', particularsFrom: 'NOTICE', barEffect: 'BARS_CLAIM', clauseReference: 'Clause 20.1' };

const facts = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  claimantSide: 'CONTRACTOR',
  status: 'EVENT_RECORDED',
  awarenessOn: '2026-03-01',
  noticeOn: null,
  particularsOn: null,
  lastParticularsOn: null,
  responseOn: null,
  responseDecision: null,
  acceptedOn: null,
  settledOn: null,
  ...over,
});

describe('the term of a contract (G1-9: the periods come from the contract, never from the code)', () => {
  it('judges a proposal and keeps the periods the contract does not give as null', () => {
    const term = validateClaimTerm({ claimant_side: 'OWNER', notice_days: 21, basis: 'WORKING_DAYS', bar_effect: 'NOT_STATED', clause_reference: ' Clause 8.2 ' });
    expect(term).toEqual({ claimantSide: 'OWNER', noticeDays: 21, particularsDays: null, responseDays: null, settlementDays: null, basis: 'WORKING_DAYS', particularsFrom: 'NOTICE', barEffect: 'NOT_STATED', clauseReference: 'Clause 8.2' });
    expect(claimTermParams(term)).toEqual({ basis: 'WORKING_DAYS', particulars_from: 'NOTICE', bar_effect: 'NOT_STATED', notice_days: 21 });
  });

  it('refuses a term that gives no period, a period that is not whole days, a bar without a period and a missing clause', () => {
    const ok = { claimant_side: 'CONTRACTOR', notice_days: 28, clause_reference: 'Clause 20.1' };
    expect(refusal(() => validateClaimTerm({ ...ok, notice_days: undefined })).detail).toBe('notice_days');
    expect(refusal(() => validateClaimTerm({ ...ok, notice_days: 0 })).detail).toBe('notice_days');
    expect(refusal(() => validateClaimTerm({ ...ok, notice_days: 28.5 })).detail).toBe('notice_days');
    expect(refusal(() => validateClaimTerm({ ...ok, notice_days: '28' })).detail).toBe('notice_days');
    expect(refusal(() => validateClaimTerm({ claimant_side: 'CONTRACTOR', response_days: 14, bar_effect: 'BARS_CLAIM', clause_reference: 'Clause 20.1' })).detail).toBe('bar_effect');
    expect(refusal(() => validateClaimTerm({ ...ok, clause_reference: 'ab' })).detail).toBe('clause_reference');
    expect(refusal(() => validateClaimTerm({ ...ok, claimant_side: 'BOTH' })).detail).toBe('claimant_side');
    expect(refusal(() => validateClaimTerm({ ...ok, basis: 'HOURS' })).detail).toBe('basis');
    expect(refusal(() => validateClaimTerm({ claimant_side: 'CONTRACTOR', particulars_days: 42, particulars_from: 'NOTICE', clause_reference: 'Clause 20.1' })).detail).toBe('particulars_from');
  });

  it('reads the working numbers of the register from the rule and refuses a rule it cannot understand', () => {
    expect(parseClaimPolicy({ approach_days: 7, response_approach_days: 3 })).toEqual(CLAIM_POLICY_DEFAULTS);
    expect(refusal(() => parseClaimPolicy({ approach_days: 0, response_approach_days: 3 })).detail).toBe('approach_days');
    expect(refusal(() => parseClaimPolicy({ approach_days: 7, response_approach_days: 3, other: 1 })).detail).toBe('other');
    expect(refusal(() => parseClaimPolicy(null)).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
  });
});

describe('the deadlines of a claim', () => {
  it('counts the day of awareness as day 0 and misses a notice only after its day has ended', () => {
    expect(claimDueOn(undefined, '2026-03-01', 28, 'CALENDAR_DAYS')).toBe('2026-03-29');
    const open = claimDeadlines(facts(), TERM, '2026-03-29', 7, undefined);
    expect(open.NOTICE).toMatchObject({ state: 'APPROACHING', dueOn: '2026-03-29', daysLeft: 0, owedByOwner: false });
    expect(claimDeadlines(facts(), TERM, '2026-03-30', 7, undefined).NOTICE).toMatchObject({ state: 'MISSED', daysLeft: -1 });
    expect(claimDeadlines(facts(), TERM, '2026-03-10', 7, undefined).NOTICE).toMatchObject({ state: 'RUNNING', daysLeft: 19 });
  });

  it('says the notice was met or met late by the day it was served, not by the day it was recorded', () => {
    expect(claimDeadlines(facts({ status: 'NOTICE_SERVED', noticeOn: '2026-03-29' }), TERM, '2026-06-01', 7, undefined).NOTICE).toMatchObject({ state: 'MET', daysLeft: null });
    expect(claimDeadlines(facts({ status: 'NOTICE_SERVED', noticeOn: '2026-03-30' }), TERM, '2026-06-01', 7, undefined).NOTICE).toMatchObject({ state: 'MET_LATE' });
  });

  it('starts the particulars from the notice (or from awareness, as the term says) and not before', () => {
    expect(claimDeadlines(facts(), TERM, '2026-03-05', 7, undefined).PARTICULARS).toMatchObject({ state: 'NOT_STARTED', dueOn: null });
    const noticed = claimDeadlines(facts({ status: 'NOTICE_SERVED', noticeOn: '2026-03-10' }), TERM, '2026-03-11', 7, undefined);
    expect(noticed.PARTICULARS).toMatchObject({ state: 'RUNNING', startedOn: '2026-03-10', dueOn: '2026-04-21' });
    const fromAwareness = claimDeadlines(facts({ status: 'NOTICE_SERVED', noticeOn: '2026-03-10' }), { ...TERM, particularsFrom: 'AWARENESS' }, '2026-03-11', 7, undefined);
    expect(fromAwareness.PARTICULARS).toMatchObject({ startedOn: '2026-03-01', dueOn: '2026-04-12' });
  });

  it('starts the response from the latest detailed submission, restarts it after a request for more information, and owes it to the owner for a contractor claim', () => {
    const detailed = facts({ status: 'PARTICULARS_SUBMITTED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01' });
    expect(claimDeadlines(detailed, TERM, '2026-04-05', 7, undefined).RESPONSE).toMatchObject({ state: 'RUNNING', startedOn: '2026-04-01', dueOn: '2026-04-15', owedByOwner: true, owedBy: 'RECEIVER' });
    const answered = facts({ ...detailed, status: 'RESPONDED', responseOn: '2026-04-10', responseDecision: 'MORE_INFORMATION_REQUESTED' });
    expect(claimDeadlines(answered, TERM, '2026-04-30', 7, undefined).RESPONSE).toMatchObject({ state: 'MET', doneOn: '2026-04-10' });
    const again = facts({ ...answered, status: 'PARTICULARS_SUBMITTED', lastParticularsOn: '2026-04-20' });
    expect(claimDeadlines(again, TERM, '2026-04-21', 7, undefined).RESPONSE).toMatchObject({ state: 'RUNNING', startedOn: '2026-04-20', doneOn: null, dueOn: '2026-05-04' });
  });

  it('starts the response from the notice when the term gives no particulars period', () => {
    const term: ClaimTerm = { ...TERM, particularsDays: null, noticeDays: 56 };
    const noticed = facts({ status: 'NOTICE_SERVED', noticeOn: '2026-03-10' });
    expect(claimDeadlines(noticed, term, '2026-03-12', 7, undefined).RESPONSE).toMatchObject({ startedOn: '2026-03-10', dueOn: '2026-03-24' });
    expect(claimDeadlines(noticed, term, '2026-03-12', 7, undefined).PARTICULARS.state).toBe('NOT_DEFINED');
  });

  it('starts the settlement from the response that accepted the claim', () => {
    const accepted = facts({ status: 'RESPONDED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01', responseOn: '2026-04-10', responseDecision: 'ACCEPTED', acceptedOn: '2026-04-10' });
    expect(claimDeadlines(accepted, TERM, '2026-05-01', 7, undefined).SETTLEMENT).toMatchObject({ state: 'RUNNING', dueOn: '2026-05-10' });
    expect(claimDeadlines(accepted, TERM, '2026-05-11', 7, undefined).SETTLEMENT).toMatchObject({ state: 'MISSED' });
    expect(claimDeadlines({ ...accepted, status: 'SETTLED', settledOn: '2026-05-08' }, TERM, '2026-06-01', 7, undefined).SETTLEMENT).toMatchObject({ state: 'MET' });
  });

  it('gives a contract without a term no clock at all, rather than a default', () => {
    const none = claimDeadlines(facts(), null, '2030-01-01', 7, undefined);
    expect(Object.values(none).map((deadline) => deadline.state)).toEqual(['NOT_DEFINED', 'NOT_DEFINED', 'NOT_DEFINED', 'NOT_DEFINED']);
    expect(Object.values(none).every((deadline) => deadline.dueOn === null && deadline.daysLeft === null)).toBe(true);
    expect(claimLimitation('EVENT_RECORDED', null, none)).toMatchObject({ status: 'NO_TERM', dueOn: null, missed: [] });
  });

  it('counts working days on the published calendar and never guesses a year that is not published', () => {
    const term: ClaimTerm = { ...TERM, basis: 'WORKING_DAYS', noticeDays: 5 };
    // 2026-03-02 is a Monday: five working days later is the next Monday, 2026-03-09; a holiday on the 5th pushes it to the 10th.
    expect(claimDueOn(sourceOf(calendar(2026)), '2026-03-02', 5, 'WORKING_DAYS')).toBe('2026-03-09');
    expect(claimDueOn(sourceOf(calendar(2026, ['2026-03-05'])), '2026-03-02', 5, 'WORKING_DAYS')).toBe('2026-03-10');
    const started = facts({ awarenessOn: '2026-03-02' });
    expect(claimDeadlines(started, term, '2026-03-04', 7, sourceOf(calendar(2026, ['2026-03-05']))).NOTICE).toMatchObject({ state: 'APPROACHING', dueOn: '2026-03-10', basis: 'WORKING_DAYS' });
    const unavailable = claimDeadlines(started, term, '2026-03-04', 7, undefined).NOTICE;
    expect(unavailable).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', dueOn: null, daysLeft: null });
    expect(claimLimitation('EVENT_RECORDED', term, claimDeadlines(started, term, '2026-03-04', 7, undefined)).status).toBe('CALENDAR_UNAVAILABLE');
    // A count that runs into a year without a calendar is unavailable too.
    expect(claimDueOn(sourceOf(calendar(2026)), '2026-12-30', 5, 'WORKING_DAYS')).toBeUndefined();
  });

  it('does not apply a deadline to a claim that ended without it', () => {
    const withdrawn = facts({ status: 'WITHDRAWN' });
    const deadlines = claimDeadlines(withdrawn, TERM, '2030-01-01', 7, undefined);
    expect(deadlines.NOTICE.state).toBe('NOT_APPLICABLE');
    expect(deadlines.PARTICULARS.state).toBe('NOT_APPLICABLE');
    expect(claimLimitation('WITHDRAWN', TERM, deadlines).status).toBe('CLOSED');
  });
});

describe('the limitation of a claim', () => {
  it('reports the earliest limitation day ahead and whether it is approaching', () => {
    const running = claimDeadlines(facts(), TERM, '2026-03-05', 7, undefined);
    expect(claimLimitation('EVENT_RECORDED', TERM, running)).toMatchObject({ status: 'RUNNING', code: 'NOTICE', dueOn: '2026-03-29', daysLeft: 24 });
    const near = claimDeadlines(facts(), TERM, '2026-03-25', 7, undefined);
    expect(claimLimitation('EVENT_RECORDED', TERM, near)).toMatchObject({ status: 'APPROACHING', daysLeft: 4 });
  });

  it('says MISSED once a notice or particulars day has passed, whatever the effect says, and keeps the effect beside it', () => {
    const missed = claimDeadlines(facts(), { ...TERM, barEffect: 'NOT_STATED' }, '2026-04-01', 7, undefined);
    expect(claimLimitation('EVENT_RECORDED', { ...TERM, barEffect: 'NOT_STATED' }, missed)).toMatchObject({ status: 'MISSED', missed: ['NOTICE'], barEffect: 'NOT_STATED' });
  });

  it('is MET when every limitation step was taken in time, MET_LATE when one was late, and BARRED once declared', () => {
    const inTime = facts({ status: 'PARTICULARS_SUBMITTED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01' });
    expect(claimLimitation('PARTICULARS_SUBMITTED', TERM, claimDeadlines(inTime, TERM, '2026-04-02', 7, undefined)).status).toBe('MET');
    const late = facts({ status: 'PARTICULARS_SUBMITTED', noticeOn: '2026-04-02', particularsOn: '2026-04-03', lastParticularsOn: '2026-04-03' });
    expect(claimLimitation('PARTICULARS_SUBMITTED', TERM, claimDeadlines(late, TERM, '2026-04-04', 7, undefined)).status).toBe('MET_LATE');
    const barred = facts({ status: 'TIME_BARRED' });
    expect(claimLimitation('TIME_BARRED', TERM, claimDeadlines(barred, TERM, '2026-06-01', 7, undefined))).toMatchObject({ status: 'BARRED', barEffect: 'BARS_CLAIM' });
  });

  it('says NOT_DEFINED when the term gives neither a notice nor a particulars period', () => {
    const term: ClaimTerm = { ...TERM, noticeDays: null, particularsDays: null, barEffect: 'NONE', responseDays: 14 };
    expect(claimLimitation('EVENT_RECORDED', term, claimDeadlines(facts(), term, '2026-03-05', 7, undefined)).status).toBe('NOT_DEFINED');
  });
});

describe('the alerts of a claim', () => {
  const policy = { responseApproachDays: 3 };

  it('warns the owner before its own notice day, and only tells it about a missed notice of the contractor after the day', () => {
    const own = facts({ claimantSide: 'OWNER' });
    const ownTerm: ClaimTerm = { ...TERM, claimantSide: 'OWNER' };
    expect(claimAlerts('EVENT_RECORDED', claimDeadlines(own, ownTerm, '2026-03-25', 7, undefined), policy)).toEqual([{ kind: 'CLAIM_LIMITATION_APPROACHING', facet: 'APPROACHING', code: 'NOTICE', dueOn: '2026-03-29', owedByOwner: true }]);
    expect(claimAlerts('EVENT_RECORDED', claimDeadlines(own, ownTerm, '2026-04-01', 7, undefined), policy)[0]).toMatchObject({ kind: 'CLAIM_LIMITATION_MISSED', owedByOwner: true });
    // The notice is the contractor's: no early warning to the owner, a missed one is shown for a decision.
    expect(claimAlerts('EVENT_RECORDED', claimDeadlines(facts(), TERM, '2026-03-25', 7, undefined), policy)).toEqual([]);
    expect(claimAlerts('EVENT_RECORDED', claimDeadlines(facts(), TERM, '2026-04-01', 7, undefined), policy)[0]).toMatchObject({ kind: 'CLAIM_LIMITATION_MISSED', owedByOwner: false });
  });

  it('shows the response the owner owes from the days before it, and as overdue after', () => {
    const detailed = facts({ status: 'PARTICULARS_SUBMITTED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01' });
    expect(claimAlerts('PARTICULARS_SUBMITTED', claimDeadlines(detailed, TERM, '2026-04-05', 7, undefined), policy)).toEqual([]);
    expect(claimAlerts('PARTICULARS_SUBMITTED', claimDeadlines(detailed, TERM, '2026-04-13', 7, undefined), policy)).toEqual([{ kind: 'CLAIM_RESPONSE_DUE', facet: 'DUE_SOON', code: 'RESPONSE', dueOn: '2026-04-15', owedByOwner: true }]);
    expect(claimAlerts('PARTICULARS_SUBMITTED', claimDeadlines(detailed, TERM, '2026-04-16', 7, undefined), policy)[0]).toMatchObject({ kind: 'CLAIM_RESPONSE_DUE', facet: 'OVERDUE' });
    // The owner's own claim waits for the contractor: the owner is not told it owes a response.
    const own = facts({ claimantSide: 'OWNER', status: 'PARTICULARS_SUBMITTED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01' });
    expect(claimAlerts('PARTICULARS_SUBMITTED', claimDeadlines(own, { ...TERM, claimantSide: 'OWNER' }, '2026-04-16', 7, undefined), policy)).toEqual([]);
  });

  it('shows a settlement past its day, and nothing for a claim that ended or has no term', () => {
    const accepted = facts({ status: 'RESPONDED', noticeOn: '2026-03-10', particularsOn: '2026-04-01', lastParticularsOn: '2026-04-01', responseOn: '2026-04-10', responseDecision: 'ACCEPTED', acceptedOn: '2026-04-10' });
    expect(claimAlerts('RESPONDED', claimDeadlines(accepted, TERM, '2026-05-11', 7, undefined), policy)[0]).toMatchObject({ kind: 'CLAIM_SETTLEMENT_OVERDUE', facet: 'OVERDUE', dueOn: '2026-05-10' });
    expect(claimAlerts('SETTLED', claimDeadlines({ ...accepted, status: 'SETTLED' }, TERM, '2026-05-11', 7, undefined), policy)).toEqual([]);
    expect(claimAlerts('EVENT_RECORDED', claimDeadlines(facts(), null, '2030-01-01', 7, undefined), policy)).toEqual([]);
  });
});

describe('the state machine of a claim', () => {
  it('walks notice, particulars, response, settlement proposal and approval', () => {
    let status: ContractClaimStatus = 'EVENT_RECORDED';
    status = claimNextStatus(status, 'NOTICE', null);
    expect(status).toBe('NOTICE_SERVED');
    status = claimNextStatus(status, 'PARTICULARS', null);
    expect(status).toBe('PARTICULARS_SUBMITTED');
    status = claimNextStatus(status, 'RESPONSE', null);
    expect(status).toBe('RESPONDED');
    status = claimNextStatus(status, 'SETTLEMENT_PROPOSAL', 'PARTLY_ACCEPTED');
    expect(status).toBe('SETTLEMENT_PROPOSED');
    expect(claimNextStatus(status, 'SETTLEMENT_APPROVED', null)).toBe('SETTLED');
    expect(claimNextStatus(status, 'SETTLEMENT_REJECTED', null)).toBe('RESPONDED');
  });

  it('lets a response that asked for more information be answered with new particulars, and only that response', () => {
    expect(claimNextStatus('RESPONDED', 'PARTICULARS', 'MORE_INFORMATION_REQUESTED')).toBe('PARTICULARS_SUBMITTED');
    expect(refusal(() => claimNextStatus('RESPONDED', 'PARTICULARS', 'REJECTED')).code).toBe('CTR_CLAIM_STATE_INVALID');
    expect(refusal(() => claimNextStatus('RESPONDED', 'SETTLEMENT_PROPOSAL', 'REJECTED')).code).toBe('CTR_CLAIM_STATE_INVALID');
    expect(refusal(() => claimNextStatus('RESPONDED', 'SETTLEMENT_PROPOSAL', 'MORE_INFORMATION_REQUESTED')).code).toBe('CTR_CLAIM_STATE_INVALID');
    expect(claimNextStatus('RESPONDED', 'REFERRAL', 'REJECTED')).toBe('REFERRED');
    expect(refusal(() => claimNextStatus('RESPONDED', 'REFERRAL', 'ACCEPTED')).code).toBe('CTR_CLAIM_STATE_INVALID');
  });

  it('refuses every step on a claim that ended and a step out of order', () => {
    for (const status of ['SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED'] as const) {
      expect(isClaimOpen(status)).toBe(false);
      expect(refusal(() => claimNextStatus(status, 'WITHDRAWAL', null)).code).toBe('CTR_CLAIM_STATE_INVALID');
    }
    expect(refusal(() => claimNextStatus('EVENT_RECORDED', 'PARTICULARS', null)).code).toBe('CTR_CLAIM_STATE_INVALID');
    expect(refusal(() => claimNextStatus('EVENT_RECORDED', 'SETTLEMENT_APPROVED', null)).code).toBe('CTR_CLAIM_STATE_INVALID');
  });

  it('offers a screen only the steps that would be accepted', () => {
    expect(claimAllowedSteps('EVENT_RECORDED', null)).toEqual(['NOTICE', 'WITHDRAWAL', 'BAR_DECLARED']);
    expect(claimAllowedSteps('RESPONDED', 'ACCEPTED')).toEqual(['SETTLEMENT_PROPOSAL', 'WITHDRAWAL', 'BAR_DECLARED']);
    expect(claimAllowedSteps('SETTLEMENT_PROPOSED', 'ACCEPTED')).toEqual(['SETTLEMENT_APPROVED', 'SETTLEMENT_REJECTED', 'WITHDRAWAL']);
    expect(claimAllowedSteps('SETTLED', null)).toEqual([]);
  });
});

describe('what a person records', () => {
  const today = '2026-05-01';
  const before = { awarenessOn: '2026-03-01', lastStepOn: '2026-03-10', claimedAmountVnd: '1000000', claimedDays: 10 };

  it('judges a new claim: a side and a kind that go together, an event that happened and awareness that follows it', () => {
    const base = { claimantSide: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: 'Late handover of the site', eventDescription: 'The site was handed over 20 days late.', eventOn: '2026-02-20', awarenessOn: '2026-02-25', claimedDays: 20 };
    expect(validateNewClaim(base, today)).toMatchObject({ claimantSide: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', claimedAmountVnd: null, claimedDays: 20 });
    expect(refusal(() => validateNewClaim({ ...base, kind: 'DELAY_DAMAGES' }, today)).detail).toBe('kind');
    expect(claimKindAllowed('OWNER', 'DELAY_DAMAGES')).toBe(true);
    expect(refusal(() => validateNewClaim({ ...base, eventOn: '2026-06-01' }, today)).detail).toBe('event_on');
    expect(refusal(() => validateNewClaim({ ...base, awarenessOn: '2026-02-10' }, today)).detail).toBe('awareness_on');
    expect(refusal(() => validateNewClaim({ ...base, awarenessOn: '2026-05-02' }, today)).detail).toBe('awareness_on');
    expect(refusal(() => validateNewClaim({ ...base, claimedAmountVnd: '12.5' }, today)).detail).toBe('claimed_amount_vnd');
    expect(refusal(() => validateNewClaim({ ...base, title: 'abc' }, today)).detail).toBe('title');
  });

  it('judges a step: a real day that is not in the future, not before awareness and not before the latest step', () => {
    const base = { kind: 'RESPONSE', occurredOn: '2026-03-12', note: 'The engineer answered in writing.', decision: 'ACCEPTED' };
    expect(validateRecordedStep(base, before, today)).toMatchObject({ kind: 'RESPONSE', decision: 'ACCEPTED' });
    expect(refusal(() => validateRecordedStep({ ...base, occurredOn: '2026-03-09' }, before, today)).detail).toBe('occurred_on');
    expect(refusal(() => validateRecordedStep({ ...base, occurredOn: '2026-02-28' }, { ...before, lastStepOn: '2026-02-01' }, today)).detail).toBe('occurred_on');
    expect(refusal(() => validateRecordedStep({ ...base, occurredOn: '2026-05-02' }, before, today)).detail).toBe('occurred_on');
    expect(refusal(() => validateRecordedStep({ ...base, occurredOn: '2026-02-30' }, before, today)).detail).toBe('occurred_on');
    expect(refusal(() => validateRecordedStep({ ...base, decision: undefined }, before, today)).detail).toBe('decision');
    expect(refusal(() => validateRecordedStep({ ...base, decision: 'MAYBE' }, before, today)).detail).toBe('decision');
    expect(refusal(() => validateRecordedStep({ ...base, note: 'no' }, before, today)).detail).toBe('note');
    expect(refusal(() => validateRecordedStep({ ...base, kind: 'BAR_DECLARED' }, before, today)).detail).toBe('kind');
    expect(refusal(() => validateRecordedStep({ kind: 'NOTICE', occurredOn: '2026-03-12', note: 'Notice served by letter.', decision: 'ACCEPTED' }, before, today)).detail).toBe('decision');
  });

  it('takes the figures only from the steps that carry them, and a settlement never grants more than was asked', () => {
    const particulars = { kind: 'PARTICULARS', occurredOn: '2026-03-12', note: 'Fully detailed claim.', claimedAmountVnd: '2500000', claimedDays: 12 };
    expect(validateRecordedStep(particulars, before, today).figures).toEqual({ claimedAmountVnd: '2500000', claimedDays: 12, settledAmountVnd: null, grantedDays: null });
    expect(refusal(() => validateRecordedStep({ kind: 'NOTICE', occurredOn: '2026-03-12', note: 'Notice served by letter.', claimedAmountVnd: '5' }, before, today)).detail).toBe('claimed_amount_vnd');
    const settlement = { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-03-12', note: 'Agreed in the meeting.', settledAmountVnd: '800000', grantedDays: 8 };
    expect(validateRecordedStep(settlement, before, today).figures).toMatchObject({ settledAmountVnd: '800000', grantedDays: 8 });
    expect(refusal(() => validateRecordedStep({ ...settlement, settledAmountVnd: '1000001' }, before, today)).code).toBe('CLAIM_SETTLEMENT_EXCEEDS_CLAIM');
    expect(refusal(() => validateRecordedStep({ ...settlement, grantedDays: 11 }, before, today)).code).toBe('CLAIM_SETTLEMENT_EXCEEDS_CLAIM');
    expect(refusal(() => validateRecordedStep({ ...settlement, settledAmountVnd: undefined, grantedDays: undefined }, before, today)).detail).toBe('settled_amount_vnd');
    // A figure the claim never stated is not a limit.
    expect(() => assertSettlementWithinClaim({ settledAmountVnd: '999999999999', grantedDays: 400 }, null, null)).not.toThrow();
  });

  it('keeps the checker apart from the maker: a settlement is approved, and a bar declared, by somebody else', () => {
    expect(refusal(() => assertSettlementDecider('0000-aaaa', '0000-AAAA')).code).toBe('SELF_APPROVAL_DENIED');
    expect(() => assertSettlementDecider('0000-aaaa', '0000-bbbb')).not.toThrow();
    expect(refusal(() => assertBarDecider('0000-aaaa', '0000-aaaa')).code).toBe('SELF_APPROVAL_DENIED');
  });

  it('declares a bar only when a limitation day has really passed', () => {
    const missed = claimLimitation('EVENT_RECORDED', TERM, claimDeadlines(facts(), TERM, '2026-04-01', 7, undefined));
    expect(() => assertBarDeclarable(missed)).not.toThrow();
    const running = claimLimitation('EVENT_RECORDED', TERM, claimDeadlines(facts(), TERM, '2026-03-05', 7, undefined));
    expect(refusal(() => assertBarDeclarable(running)).code).toBe('CLAIM_BAR_NOT_DUE');
    expect(refusal(() => assertBarDeclarable(claimLimitation('EVENT_RECORDED', null, claimDeadlines(facts(), null, '2026-04-01', 7, undefined)))).code).toBe('CLAIM_BAR_NOT_DUE');
    // The clause gives a day but does not say the claim is lost (or says only that the relief is reduced): no ground for a bar.
    for (const barEffect of ['NOT_STATED', 'REDUCES_RELIEF', 'NONE'] as const) {
      const term = { ...TERM, barEffect };
      expect(refusal(() => assertBarDeclarable(claimLimitation('EVENT_RECORDED', term, claimDeadlines(facts(), term, '2026-04-01', 7, undefined)))).detail).toBe('bar_effect');
    }
  });
});

describe('the report hooks (claims and limitation)', () => {
  const input = (over: Partial<ClaimReportInput> & { facts: ClaimFacts }): ClaimReportInput => ({ id: 'c1', code: 'CLM-001', contractId: 'k1', contractCode: 'HD-01', title: 'Late handover', kind: 'EXTENSION_OF_TIME', term: TERM, claimedAmountVnd: null, settledAmountVnd: null, claimedDays: null, grantedDays: null, ...over });
  const today = '2026-04-10';

  const rows: ClaimReportInput[] = [
    input({ id: 'c1', code: 'CLM-001', facts: facts({ awarenessOn: '2026-04-01' }), claimedAmountVnd: '1000000', claimedDays: 10 }),
    input({ id: 'c2', code: 'CLM-002', contractId: 'k2', contractCode: 'HD-02', facts: facts({ awarenessOn: '2026-01-01' }), claimedAmountVnd: '500000' }),
    input({ id: 'c3', code: 'CLM-003', kind: 'DELAY_DAMAGES', facts: facts({ status: 'SETTLED', claimantSide: 'OWNER', awarenessOn: '2026-02-01', noticeOn: '2026-02-05', settledOn: '2026-03-30' }), term: { ...TERM, claimantSide: 'OWNER' }, claimedAmountVnd: '300000', settledAmountVnd: '250000', claimedDays: 5, grantedDays: 4 }),
    input({ id: 'c4', code: 'CLM-004', contractId: 'k3', contractCode: 'HD-03', facts: facts({ awarenessOn: '2026-04-01' }), term: null, claimedAmountVnd: '700000' }),
  ];

  it('reads every claim against its term and adds the register up in exact decimals', () => {
    const report = claimRegisterReport(rows, today, { approachDays: 7 }, undefined);
    expect(report.rows.map((row) => row.limitation.status)).toEqual(['RUNNING', 'MISSED', 'CLOSED', 'NO_TERM']);
    expect(report.totals).toMatchObject({
      count: 4,
      open: 3,
      claimedVnd: '2500000',
      settledVnd: '250000',
      openClaimedVnd: '2200000',
      claimedDays: 15,
      grantedDays: 4,
      withoutTerm: 1,
      bySide: { CONTRACTOR: 3, OWNER: 1 },
      byStatus: { EVENT_RECORDED: 3, SETTLED: 1 },
      byLimitation: { RUNNING: 1, MISSED: 1, CLOSED: 1, NO_TERM: 1, BARRED: 0 },
    });
  });

  it('lists the time-barred dates ahead, earliest first, with the missed ones always in and the claims without a term left to the totals', () => {
    const report = claimRegisterReport(rows, today, { approachDays: 7 }, undefined);
    const horizon = limitationHorizon(report.rows, today, 30);
    expect(horizon.map((item) => [item.claimCode, item.code, item.dueOn, item.daysLeft, item.state])).toEqual([
      ['CLM-002', 'NOTICE', '2026-01-29', -71, 'MISSED'],
      ['CLM-001', 'NOTICE', '2026-04-29', 19, 'RUNNING'],
    ]);
    expect(limitationHorizon(report.rows, today, 3).map((item) => item.claimCode)).toEqual(['CLM-002']);
    expect(horizon.every((item) => item.claimCode !== 'CLM-004')).toBe(true);
  });

  it('adds nothing for a register with no claims', () => {
    const report = claimRegisterReport([], today, { approachDays: 7 }, undefined);
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ count: 0, open: 0, claimedVnd: '0', settledVnd: '0', openClaimedVnd: '0', withoutTerm: 0 });
    expect(limitationHorizon([], today, 30)).toEqual([]);
  });
});
