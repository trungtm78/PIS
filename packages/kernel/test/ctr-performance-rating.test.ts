import { RATING_CRITERIA, adoptionScores, assertRatingAdoption, assertRatingProposal, assertRatingResponse, moveRating, proposeRating, ratingDefaults, ratingDigest, ratingKindOf, ratingParams, ratingResponseClock, ratingRow } from '../src/ctr-performance-rating.ts';
import type { RatingInputs } from '../src/ctr-performance-rating.ts';
import { registerTotals } from '../src/ctr-register-reports.ts';
import type { RegisterContract } from '../src/ctr-register-reports.ts';

const AS_OF = '2026-11-08';
const base = (patch: Partial<RatingInputs> = {}): RatingInputs => ({
  asOf: AS_OF,
  contractStatus: 'ACTIVE',
  signedOn: '2026-01-01',
  endedOn: null,
  acceptedVnd: '1000',
  requestedVnd: '1000',
  paidVnd: '1000',
  daysLate: 0,
  daysLateReason: null,
  guaranteeRequiredVnd: '100',
  guaranteeValidVnd: '100',
  defects: [],
  obstacles: [],
  violations: [],
  auditRecommendedVnd: '0',
  auditRecoveredVnd: '0',
  auditFinancialCount: 0,
  ...patch,
});
const contract: RegisterContract = { id: 'c1', code: 'HD-1', title: null, projectCode: 'P', contractorName: 'K', unitName: 'U', status: 'ACTIVE', ledgerOk: true };

describe('the rating rule', () => {
  it('has defaults that the parser accepts and that add up to 100', () => {
    const params = ratingParams(ratingDefaults());
    expect(params.weight_quality_pct + params.weight_schedule_pct + params.weight_safety_env_pct + params.weight_cooperation_pct + params.weight_financial_pct).toBe(100);
  });

  it('refuses a rule that does not add up, an unknown key, a missing key and lines that go up', () => {
    expect(() => ratingParams({ ...ratingDefaults(), weight_quality_pct: 31 })).toThrow();
    expect(() => ratingParams({ ...ratingDefaults(), extra: 1 })).toThrow();
    const { min_criteria: _removed, ...rest } = ratingDefaults();
    expect(() => ratingParams(rest)).toThrow();
    expect(() => ratingParams({ ...ratingDefaults(), good_min: 95 })).toThrow();
    expect(() => ratingParams({ ...ratingDefaults(), min_criteria: 6 })).toThrow();
  });
});

describe('the proposal from the data', () => {
  const params = ratingDefaults();

  it('gives a perfect contract 100 on every criterion and an excellent rating', () => {
    const proposal = proposeRating(base(), params);
    expect(RATING_CRITERIA.map((criterion) => proposal.criteria[criterion].score)).toEqual([100, 100, 100, 100, 100]);
    expect(proposal.overall).toBe('100.00');
    expect(proposal.rating).toBe('EXCELLENT');
    expect(proposal.covered).toBe(5);
  });

  it('takes penalties from the data: defects by severity (closed ones count less), days late, violations, obstacles, money', () => {
    const proposal = proposeRating(
      base({
        defects: [
          { severity: 'CRITICAL', status: 'OPEN', reopenCount: 0 },
          { severity: 'MAJOR', status: 'CLOSED', reopenCount: 1 },
        ],
        daysLate: 45,
        violations: [{ kind: 'SAFETY', severity: 'MAJOR' }, { kind: 'DELAY', severity: 'MAJOR' }],
        obstacles: [{ open: true, overdue: true, escalated: true }, { open: false, overdue: true, escalated: true }],
        guaranteeValidVnd: '50',
        paidVnd: '1100',
      }),
      params,
    );
    // quality: 25 (open critical) + 10 x 30% (closed major) + 5 (reopen) = 33
    expect(proposal.criteria.quality).toMatchObject({ score: 67, readings: { open_defects: 1, closed_defects: 1, penalty: 33 } });
    expect(proposal.criteria.schedule.score).toBe(50);
    // only the safety violation counts for safety
    expect(proposal.criteria.safety_env.score).toBe(85);
    expect(proposal.criteria.cooperation.score).toBe(85);
    // guarantee half missing: 15; paid 10 percent over accepted: 3
    expect(proposal.criteria.financial).toMatchObject({ score: 82, readings: { guarantee_penalty: 15, overpaid_penalty: 3 } });
  });

  it('gives a criterion with no data NO score and a reason, never zero, and renormalises the weights of the others', () => {
    const proposal = proposeRating(base({ signedOn: '2026-10-20', acceptedVnd: '0', requestedVnd: '0', paidVnd: '0', guaranteeRequiredVnd: null, guaranteeValidVnd: null }), params);
    expect(proposal.criteria.quality).toMatchObject({ score: null, reason: 'NO_QUALITY_EVIDENCE' });
    expect(proposal.criteria.safety_env).toMatchObject({ score: null, reason: 'NOT_ENOUGH_OBSERVATION' });
    expect(proposal.criteria.cooperation.score).toBeNull();
    expect(proposal.criteria.financial).toMatchObject({ score: null, reason: 'NO_FINANCIAL_EVIDENCE' });
    expect(proposal.covered).toBe(1);
    expect(proposal.overall).toBeNull();
    expect(proposal.overallReason).toBe('NOT_ENOUGH_CRITERIA');
    expect(proposal.rating).toBeNull();
  });

  it('weights only the criteria that have data', () => {
    // schedule 0 (weight 25) and quality 100 (weight 30), the third criterion safety 100 (weight 20): (0x25 + 100x30 + 100x20) / 75
    const proposal = proposeRating(base({ daysLate: 90, guaranteeRequiredVnd: null, guaranteeValidVnd: null, acceptedVnd: '1000', requestedVnd: '0', paidVnd: '0', signedOn: '2026-01-01' }), { ...params, min_criteria: 3 });
    expect(proposal.criteria.schedule.score).toBe(0);
    expect(proposal.criteria.cooperation.score).toBe(100);
    expect(proposal.criteria.financial.score).toBeNull();
    expect(proposal.overall).toBe('66.67');
    expect(proposal.rating).toBe('FAIR');
  });

  it('says why a schedule has no score when there is no due day', () => {
    expect(proposeRating(base({ daysLate: null, daysLateReason: 'NO_ORIGINAL_DUE_DATE' }), params).criteria.schedule).toMatchObject({ score: null, reason: 'NO_ORIGINAL_DUE_DATE' });
  });

  it('digests the same inputs to the same value and a change to another', () => {
    expect(ratingDigest(base(), ratingDefaults())).toBe(ratingDigest(base(), ratingDefaults()));
    expect(ratingDigest(base(), ratingDefaults())).not.toBe(ratingDigest(base({ daysLate: 1 }), ratingDefaults()));
  });

  it('suggests the kind of evaluation from the status', () => {
    expect([ratingKindOf('ACTIVE'), ratingKindOf('COMPLETED'), ratingKindOf('CLOSED'), ratingKindOf('TERMINATED')]).toEqual(['PERIODIC', 'COMPLETION', 'COMPLETION', 'TERMINATION']);
  });
});

describe('adoption', () => {
  const params = ratingDefaults();
  it('fills only a missing criterion, with an override that has its reason, and refuses an incomplete one', () => {
    const proposal = proposeRating(base({ guaranteeRequiredVnd: null, guaranteeValidVnd: null, acceptedVnd: '1000', requestedVnd: '0', paidVnd: '0' }), params);
    expect(() => adoptionScores(proposal, {})).toThrow(expect.objectContaining({ code: 'RATING_INCOMPLETE' }));
    expect(adoptionScores(proposal, { financial: { score: 70, reason: 'Scored from the financial statements on file.' } }).financial).toBe(70);
    expect(() => adoptionScores(proposal, { quality: { score: 10, reason: 'Trying to replace a score of the data.' }, financial: { score: 70, reason: 'Scored from the financial statements on file.' } })).toThrow();
    expect(() => assertRatingAdoption({ overrides: { financial: { score: 70, reason: 'short' } } })).toThrow();
    expect(() => assertRatingAdoption({ overrides: { bogus: { score: 70, reason: 'x'.repeat(30) } } })).toThrow();
    expect(assertRatingAdoption({ overrides: { financial: { score: 70, reason: 'x'.repeat(30) } } }).overrides.financial?.score).toBe(70);
  });
});

describe('the life of a proposal', () => {
  const now = new Date('2026-11-08T05:00:00Z');
  const context = { actor: 'second', proposedBy: 'first', now, dueAt: null as Date | null };

  it('is told to the contractor by a second person, once', () => {
    expect(moveRating('PROPOSED', 'NOTIFY', context)).toBe('NOTIFIED');
    expect(() => moveRating('PROPOSED', 'NOTIFY', { ...context, actor: 'first' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => moveRating('NOTIFIED', 'NOTIFY', context)).toThrow(expect.objectContaining({ code: 'RATING_STATE_INVALID' }));
  });

  it('takes the answer only while notified', () => {
    expect(moveRating('NOTIFIED', 'RESPOND', context)).toBe('RESPONDED');
    expect(() => moveRating('PROPOSED', 'RESPOND', context)).toThrow(expect.objectContaining({ code: 'RATING_STATE_INVALID' }));
    expect(() => moveRating('RESPONDED', 'RESPOND', context)).toThrow(expect.objectContaining({ code: 'RATING_STATE_INVALID' }));
  });

  it('is adopted after the answer, or after the window ended with none, never by the proposer', () => {
    expect(moveRating('RESPONDED', 'ADOPT', context)).toBe('ADOPTED');
    expect(() => moveRating('RESPONDED', 'ADOPT', { ...context, actor: 'first' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => moveRating('NOTIFIED', 'ADOPT', { ...context, dueAt: new Date('2026-11-20T00:00:00Z') })).toThrow(expect.objectContaining({ code: 'RATING_RESPONSE_WINDOW_OPEN' }));
    expect(moveRating('NOTIFIED', 'ADOPT', { ...context, dueAt: new Date('2026-11-01T00:00:00Z') })).toBe('ADOPTED');
    expect(() => moveRating('PROPOSED', 'ADOPT', context)).toThrow(expect.objectContaining({ code: 'RATING_STATE_INVALID' }));
  });

  it('is withdrawn only before the contractor is told', () => {
    expect(moveRating('PROPOSED', 'WITHDRAW', context)).toBe('WITHDRAWN');
    expect(() => moveRating('NOTIFIED', 'WITHDRAW', context)).toThrow(expect.objectContaining({ code: 'RATING_STATE_INVALID' }));
  });
});

describe('the response window', () => {
  const notifiedAt = new Date('2026-11-01T00:00:00Z');
  const dueAt = new Date('2026-11-21T10:00:00Z');
  it('is answered in time, late, running, near or lapsed', () => {
    expect(ratingResponseClock({ notifiedAt, dueAt, respondedAt: new Date('2026-11-10T00:00:00Z'), now: new Date('2026-11-30T00:00:00Z'), calendars: undefined }).status).toBe('ANSWERED_IN_TIME');
    expect(ratingResponseClock({ notifiedAt, dueAt, respondedAt: new Date('2026-11-25T00:00:00Z'), now: new Date('2026-11-30T00:00:00Z'), calendars: undefined }).status).toBe('ANSWERED_LATE');
    expect(ratingResponseClock({ notifiedAt, dueAt, respondedAt: null, now: new Date('2026-11-05T00:00:00Z'), calendars: undefined })).toMatchObject({ status: 'RUNNING', basis: 'CALENDAR_UNAVAILABLE' });
    expect(ratingResponseClock({ notifiedAt, dueAt, respondedAt: null, now: new Date('2026-11-21T08:00:00Z'), calendars: undefined }).status).toBe('NEAR');
    expect(ratingResponseClock({ notifiedAt, dueAt, respondedAt: null, now: new Date('2026-11-22T00:00:00Z'), calendars: undefined }).status).toBe('LAPSED');
  });
});

describe('what a command carries', () => {
  it('checks the proposal, the answer and the day', () => {
    expect(assertRatingProposal({ period_label: '2026-Q4' })).toMatchObject({ periodLabel: '2026-Q4', kind: undefined });
    expect(() => assertRatingProposal({ period_label: '' })).toThrow();
    expect(() => assertRatingProposal({ period_label: 'x', evaluation_kind: 'BOGUS' })).toThrow();
    expect(assertRatingResponse({ response_kind: 'ACCEPT', received_on: '2026-11-05' }, '2026-11-08').kind).toBe('ACCEPT');
    expect(() => assertRatingResponse({ response_kind: 'DISPUTE', received_on: '2026-11-05', response_text: 'too short' }, '2026-11-08')).toThrow();
    expect(() => assertRatingResponse({ response_kind: 'ACCEPT', received_on: '2026-11-09' }, '2026-11-08')).toThrow();
    expect(() => assertRatingResponse({ response_kind: 'WHATEVER', received_on: '2026-11-05' }, '2026-11-08')).toThrow();
  });
});

describe('the row of the report', () => {
  const now = new Date('2026-11-08T05:00:00Z');
  it('shows the live proposal, the status of the stored one and the official rating, and counts coverage over the rows', () => {
    const scored = ratingRow(contract, base(), ratingDefaults(), { id: 'p1', state: 'NOTIFIED', kind: 'PERIODIC', periodLabel: 'Q4', responseDueAt: '2026-11-21T10:00:00.000Z', respondedAt: null }, { rating: 'GOOD', overallScore: '80.00' }, now);
    expect(scored.cells.overall_score).toBe('100.00');
    expect(scored.cells.score_quality).toBe('100.00');
    expect(scored.cells.rating_status).toBe('NOTIFIED');
    expect(scored.cells.response_days_left).toBe(13);
    expect(scored.cells.official_rating).toBe('GOOD');
    expect(scored.cells.responded_in_time).toBeNull();
    expect(scored.na.responded_in_time).toBe('WINDOW_RUNNING');
    const bare = ratingRow({ ...contract, id: 'c2' }, base({ acceptedVnd: '0', requestedVnd: '0', paidVnd: '0', guaranteeRequiredVnd: null, signedOn: null, daysLate: null }), ratingDefaults(), null, null, now);
    expect(bare.cells.overall_score).toBeNull();
    expect(bare.na.overall_score).toBe('NOT_ENOUGH_CRITERIA');
    expect(bare.cells.score_quality).toBeNull();
    expect(bare.cells.rating_status).toBe('NONE');
    const late = ratingRow({ ...contract, id: 'c3' }, base(), ratingDefaults(), { id: 'p3', state: 'NOTIFIED', kind: 'PERIODIC', periodLabel: 'Q3', responseDueAt: '2026-11-01T10:00:00.000Z', respondedAt: null }, null, now);
    expect(late.cells.responded_in_time).toBe(0);
    const totals = registerTotals('performance-rating', [scored, bare, late]);
    expect(totals.cells.scored).toBe('66.67');
    expect(totals.cells.responded_in_time).toBe('0.00');
    expect(totals.cells.response_days_left).toBe(13);
  });
});
