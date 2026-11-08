import { describe, expect, it } from 'vitest';
import { problem } from './test-support';
import { boardQueryOf, camel, describeProblem, formProblems, grainOfKind, money, ordinalsOf, percent, proposalBody, ratesOverall, sharesOf, toBatch, toBatches, toBoard, toHistory, toTaxonomy } from './model';
import type { BatchForm } from './model';

const form = (over: Partial<BatchForm> = {}): BatchForm => ({
  projectId: 'p',
  classCode: 'EQUITY',
  tierCode: 'ALL',
  measure: 'DISBURSED',
  kind: 'ESTIMATE',
  grain: 'MONTH',
  planYear: 2026,
  asOfDate: '2026-03-10',
  amounts: { 3: '100.000.000' },
  explanation: '',
  basis: 'REPORTED',
  adjustsPlanYear: '',
  adjustsOrdinal: '',
  decisionDocumentId: '',
  ...over,
});

describe('writing the numbers of the funding screens', () => {
  it('writes whole dong with a dot every three digits, and a figure nobody has as a dash, never zero', () => {
    expect(money('1250000000')).toBe('1.250.000.000');
    expect(money('-5000')).toBe('-5.000');
    expect(money('0')).toBe('0');
    expect(money(null)).toBe('–');
    expect(money(undefined)).toBe('–');
  });

  it('writes a percent with two decimals from the text the API wrote, rounding half up and never through a float', () => {
    expect(percent('12.5000')).toBe('12,50%');
    expect(percent('0.7813')).toBe('0,78%');
    expect(percent('99.9950')).toBe('100,00%');
    expect(percent('110.0000')).toBe('110,00%');
    expect(percent('33.3333')).toBe('33,33%');
    expect(percent('66.6667')).toBe('66,67%');
    expect(percent(null)).toBe('–');
  });

  it('turns a code of the API into the segment of a translation key', () => {
    expect(camel('PLAN_IN_FORCE')).toBe('planInForce');
    expect(camel('MONTH')).toBe('month');
    expect(camel('asOf')).toBe('asOf');
    expect(camel('afterActual')).toBe('afterActual');
    expect(camel('CUMULATIVE_SINCE_START')).toBe('cumulativeSinceStart');
  });
});

describe('the answers are read with their shape checked', () => {
  it('refuses a wrong shape as an error of the read, not as an empty screen', () => {
    expect(() => toBoard({})).toThrow('unexpected board');
    expect(() => toBoard({ projects: [], totals: { rates: [] }, period: {} })).toThrow('unexpected board');
    expect(() => toTaxonomy({ classes: [] })).toThrow('unexpected taxonomy');
    expect(() => toBatch({ batch_id: 'x' })).toThrow('unexpected batch');
    expect(() => toBatches({})).toThrow('unexpected batches');
    expect(() => toHistory({ history: [] })).toThrow('unexpected history');
    expect(toHistory({ history: [], pending: [] })).toEqual({ history: [], pending: [] });
  });

  it('splits the rates of a scope into those over the whole scope and the shares of the classes', () => {
    const rates = [{ code: 'A', class_code: null }, { code: 'S', class_code: 'EQUITY' }] as never;
    expect(ratesOverall(rates).map((one) => one.code)).toEqual(['A']);
    expect(sharesOf(rates).map((one) => one.code)).toEqual(['S']);
  });
});

describe('the query of the board and the periods', () => {
  it('writes the query of the API in its own words', () => {
    expect(boardQueryOf({ planYear: 2026, grain: 'QUARTER', ordinal: 2, measure: 'DISBURSED', view: 'RESTATED', asOf: '2026-06-30' })).toEqual({ plan_year: '2026', period_grain: 'QUARTER', period_ordinal: '2', measure: 'DISBURSED', view: 'RESTATED', as_of: '2026-06-30' });
    expect(boardQueryOf({ planYear: 2026, grain: 'YEAR', ordinal: 0, measure: 'EXECUTED', view: 'AS_REPORTED', asOf: '2026-12-31', projectId: 'p' }).project_id).toBe('p');
    expect(ordinalsOf('YEAR')).toEqual([0]);
    expect(ordinalsOf('QUARTER')).toEqual([1, 2, 3, 4]);
    expect(ordinalsOf('MONTH')).toHaveLength(12);
  });

  it('enters a phasing in the grain of its kind and an estimate or an actual in the grain the person chooses', () => {
    expect(grainOfKind('PLAN_QUARTER', 'MONTH')).toBe('QUARTER');
    expect(grainOfKind('PLAN_MONTH', 'QUARTER')).toBe('MONTH');
    expect(grainOfKind('PLAN_YEAR', 'MONTH')).toBe('YEAR');
    expect(grainOfKind('ESTIMATE', 'QUARTER')).toBe('QUARTER');
    expect(grainOfKind('ACTUAL', 'MONTH')).toBe('MONTH');
  });
});

describe('the form of a batch says what is wrong before it sends', () => {
  it('accepts a complete estimate and names the field of an incomplete one', () => {
    expect(formProblems(form(), false)).toEqual([]);
    expect(formProblems(form({ projectId: '' }), false)).toEqual(['project']);
    expect(formProblems(form({ classCode: '' }), false)).toEqual(['class']);
    expect(formProblems(form({ asOfDate: '10/03/2026' }), false)).toEqual(['asOf']);
    expect(formProblems(form({ amounts: {} }), false)).toEqual(['amounts']);
    expect(formProblems(form({ amounts: { 3: '1,5' } }), false)).toEqual(['amounts']);
  });

  it('asks for the whole set of a phasing when the pack says it must add up, and for the explanation of a negative actual or an adjustment', () => {
    const quarters = form({ kind: 'PLAN_QUARTER', grain: 'QUARTER', amounts: { 1: '10', 2: '10', 3: '10' } });
    expect(formProblems(quarters, true)).toEqual(['amounts']);
    expect(formProblems(quarters, false)).toEqual([]);
    expect(formProblems({ ...quarters, amounts: { 1: '10', 2: '10', 3: '10', 4: '10' } }, true)).toEqual([]);
    expect(formProblems(form({ kind: 'ACTUAL', amounts: { 3: '-5' } }), false)).toEqual(['explanation']);
    expect(formProblems(form({ kind: 'ACTUAL', amounts: { 3: '-5' }, explanation: 'a reversal booked by the accounting division' }), false)).toEqual([]);
    expect(formProblems(form({ kind: 'ACTUAL', basis: 'ADJUSTMENT', explanation: 'x'.repeat(20) }), false)).toEqual(['adjusts']);
    expect(formProblems(form({ kind: 'PLAN_ADJUSTED', measure: 'EXECUTED' }), false)).toEqual(['decision']);
  });

  it('writes the body of the command: amounts as whole dong text without dots, in order of period, with the adjustment and the decision when the kind has them', () => {
    expect(proposalBody(form({ amounts: { 4: '2.000', 3: '100.000.000' } }))).toEqual({
      project_id: 'p',
      class_code: 'EQUITY',
      tier_code: 'ALL',
      measure: 'DISBURSED',
      figure_kind: 'ESTIMATE',
      period_grain: 'MONTH',
      plan_year: 2026,
      as_of_date: '2026-03-10',
      entries: [{ period_ordinal: 3, amount_vnd: '100000000' }, { period_ordinal: 4, amount_vnd: '2000' }],
    });
    const adjustment = proposalBody(form({ kind: 'ACTUAL', basis: 'ADJUSTMENT', adjustsPlanYear: '2026', adjustsOrdinal: '1', explanation: 'an invoice of January booked in March' }));
    expect(adjustment).toMatchObject({ basis: 'ADJUSTMENT', adjusts_plan_year: 2026, adjusts_period_ordinal: 1, explanation: 'an invoice of January booked in March' });
    expect(proposalBody(form({ kind: 'PLAN_ADJUSTED', decisionDocumentId: ' d1 ' }))).toMatchObject({ decision_document_id: 'd1' });
  });

  it('turns a refusal of the server into the kind of problem the screen says in words', () => {
    expect(describeProblem(problem('FIGURE_PERIOD_LOCKED', 409))).toBe('locked');
    expect(describeProblem(problem('ESTIMATE_AFTER_ACTUAL'))).toBe('afterActual');
    expect(describeProblem(problem('PHASING_SUM_MISMATCH'))).toBe('phasing');
    expect(describeProblem(problem('GRAIN_SUM_MISMATCH'))).toBe('grain');
    expect(describeProblem(problem('FUNDING_CLASS_UNKNOWN'))).toBe('class');
    expect(describeProblem(problem('VERSION_CONFLICT', 409))).toBe('conflict');
    expect(describeProblem(problem('FIGURE_STATE_INVALID', 409))).toBe('state');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403))).toBe('self');
    expect(describeProblem(problem('NEGATIVE_DELTA_EXPLANATION_REQUIRED'))).toBe('explanation');
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
