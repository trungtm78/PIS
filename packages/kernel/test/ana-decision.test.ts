import { DECISION_DEFAULTS, checkDecision, checkOutcome, compareFigure, decisionPolicyOf, figuresDigest, followUpState } from '../src/ana-decision';
import type { DecisionPolicy } from '../src/ana-decision';

const policy: DecisionPolicy = decisionPolicyOf(DECISION_DEFAULTS as Record<string, unknown>);
const TODAY = '2027-10-15';
const UNIT = '00000000-0000-4000-8000-000000000012';
const tile = { kind: 'KPI_TILE', metric_code: 'DISBURSEMENT_RATE_PM', unit_id: UNIT };

describe('the decision log rules (G3-6)', () => {
  it('reads the default policy and refuses a policy that is not whole', () => {
    expect(policy).toMatchObject({ reasonMin: 10, reasonMax: 1000, followUpMaxDays: 180, outcomeNoteMin: 5 });
    expect(policy.kinds).toContain('ACCEPT_RISK');
    expect(() => decisionPolicyOf({ ...DECISION_DEFAULTS, kinds: [] })).toThrow();
    expect(() => decisionPolicyOf({ ...DECISION_DEFAULTS, kinds: ['A_B', 'A_B'] })).toThrow();
    expect(() => decisionPolicyOf({ ...DECISION_DEFAULTS, reason_min: 2000 })).toThrow();
  });

  it('accepts a decision on a tile with a reason and a follow-up and normalises the words', () => {
    const draft = checkDecision({ subject: tile, kind: 'DIRECT_ACTION', reason: '  Ask the north unit to catch up before the end of the month.  ', follow_up: { due_on: '2027-11-01' } }, policy, TODAY);
    expect(draft).toMatchObject({ kind: 'DIRECT_ACTION', followUpDue: '2027-11-01', followUpOwnerId: null });
    expect(draft.reason).toBe('Ask the north unit to catch up before the end of the month.');
    expect(draft.subject).toEqual({ kind: 'KPI_TILE', metricCode: 'DISBURSEMENT_RATE_PM', unitId: UNIT, source: null, sourceId: null, title: null });
  });

  it('accepts an urgent alert subject and a free subject, and refuses the fields that do not belong to them', () => {
    const alert = checkDecision({ subject: { kind: 'URGENT_ALERT', source: 'EARLY_WARNING', source_id: 'w-1' }, kind: 'ESCALATE', reason: 'Raise it with the chair of the board.' }, policy, TODAY);
    expect(alert.subject).toMatchObject({ kind: 'URGENT_ALERT', source: 'EARLY_WARNING', sourceId: 'w-1', unitId: null });
    expect(() => checkDecision({ subject: { kind: 'URGENT_ALERT', source: 'EARLY_WARNING', source_id: 'w-1', unit_id: UNIT }, kind: 'ESCALATE', reason: 'Raise it with the chair.' }, policy, TODAY)).toThrow();
    const free = checkDecision({ subject: { kind: 'FREE', title: 'Weekly meeting 42' }, kind: 'DEFER', reason: 'Wait for the Treasury figures.' }, policy, TODAY);
    expect(free.subject.title).toBe('Weekly meeting 42');
  });

  it.each([
    ['an unknown subject kind', { subject: { kind: 'OTHER' }, kind: 'DEFER', reason: 'A long enough reason.' }],
    ['a tile without a metric code', { subject: { kind: 'KPI_TILE' }, kind: 'DEFER', reason: 'A long enough reason.' }],
    ['a kind outside the closed list', { subject: tile, kind: 'WHATEVER', reason: 'A long enough reason.' }],
    ['a reason that is too short', { subject: tile, kind: 'DEFER', reason: 'short' }],
    ['a reason that is only spaces', { subject: tile, kind: 'DEFER', reason: '              ' }],
    ['a follow-up in the past', { subject: tile, kind: 'DEFER', reason: 'A long enough reason.', follow_up: { due_on: '2027-10-15' } }],
    ['a follow-up too far away', { subject: tile, kind: 'DEFER', reason: 'A long enough reason.', follow_up: { due_on: '2028-12-01' } }],
    ['a follow-up that is not a day', { subject: tile, kind: 'DEFER', reason: 'A long enough reason.', follow_up: { due_on: '2027-02-30' } }],
    ['an owner that is not an id', { subject: tile, kind: 'DEFER', reason: 'A long enough reason.', follow_up: { due_on: '2027-11-01', owner_id: 'me' } }],
  ])('refuses %s', (_name, input) => {
    expect(() => checkDecision(input, policy, TODAY)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('checks an outcome: a note, and the decision that replaces it for SUPERSEDED', () => {
    expect(checkOutcome({ outcome: 'RESOLVED', note: ' Done and checked. ' }, policy)).toEqual({ outcome: 'RESOLVED', note: 'Done and checked.', supersededBy: null });
    const replacement = '00000000-0000-4000-8000-0000000000aa';
    expect(checkOutcome({ outcome: 'SUPERSEDED', note: 'Replaced by a newer one', superseded_by: replacement }, policy).supersededBy).toBe(replacement);
    expect(() => checkOutcome({ outcome: 'SUPERSEDED', note: 'Replaced by a newer one' }, policy)).toThrow();
    expect(() => checkOutcome({ outcome: 'RESOLVED', note: 'Done and checked.', superseded_by: replacement }, policy)).toThrow();
    expect(() => checkOutcome({ outcome: 'RESOLVED', note: 'ok' }, policy)).toThrow();
    expect(() => checkOutcome({ outcome: 'DONE', note: 'Done and checked.' }, policy)).toThrow();
  });

  it('gives the same digest for the same facts whatever the order of the keys, and another for a changed figure', () => {
    const one = { figure: { metric_code: 'A', value: '60.0000' }, snapshot_id: 's1', tiles: [{ metric_code: 'A', display_value: '60,00' }] };
    const reordered = { tiles: [{ display_value: '60,00', metric_code: 'A' }], snapshot_id: 's1', figure: { value: '60.0000', metric_code: 'A' } };
    expect(figuresDigest(one)).toBe(figuresDigest(reordered));
    expect(figuresDigest(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(figuresDigest(one)).not.toBe(figuresDigest({ ...one, figure: { metric_code: 'A', value: '60.0001' } }));
  });

  it('golden: compares the figure then with the figure now, exactly', () => {
    expect(compareFigure({ metric_code: 'R', value: '60.0000' }, { value: '63.2500' })).toEqual({ metricCode: 'R', then: '60.0000', now: '63.2500', delta: '3.2500', direction: 'UP', nullReason: null });
    expect(compareFigure({ metric_code: 'R', value: '60.0000' }, { value: '58.0000' })).toMatchObject({ delta: '-2.0000', direction: 'DOWN' });
    expect(compareFigure({ metric_code: 'R', value: '60' }, { value: '60.0000' })).toMatchObject({ delta: '0.0000', direction: 'SAME' });
  });

  it('never makes a delta against a figure that was not there', () => {
    expect(compareFigure({ metric_code: 'R', value: null }, { value: '5' })).toMatchObject({ delta: null, nullReason: 'NO_VALUE_THEN' });
    expect(compareFigure({ metric_code: 'R', value: '5' }, { value: null })).toMatchObject({ delta: null, nullReason: 'NO_VALUE_NOW' });
    expect(compareFigure({ metric_code: 'R', value: '5' }, null)).toMatchObject({ delta: null, nullReason: 'NOT_READABLE_NOW' });
  });

  it('judges the follow-up: closed by the latest outcome, else by the day', () => {
    expect(followUpState(null, null, TODAY)).toBe('NONE');
    expect(followUpState('2027-10-14', null, TODAY)).toBe('OVERDUE');
    expect(followUpState('2027-10-15', null, TODAY)).toBe('DUE_SOON');
    expect(followUpState('2027-10-18', null, TODAY)).toBe('DUE_SOON');
    expect(followUpState('2027-10-19', null, TODAY)).toBe('OPEN');
    expect(followUpState('2027-10-14', 'RESOLVED', TODAY)).toBe('RESOLVED');
    expect(followUpState('2027-10-14', 'SUPERSEDED', TODAY)).toBe('SUPERSEDED');
    expect(followUpState('2027-10-14', 'STILL_OPEN', TODAY)).toBe('OVERDUE');
  });
});
