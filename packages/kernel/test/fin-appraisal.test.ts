import type { DomainError } from '../src/errors';
import { FIN_FORMULA_VERSION } from '../src/fin-analysis';
import type { FinModelInput } from '../src/fin-analysis';
import { appraisalInputsHash, assertApprover, assertAssumptionForm, assertAssumptionsComplete, assertStatus, assertSubmittable, computeAppraisal, requiredAssumptionKeys } from '../src/fin-appraisal';
import type { FinAssumptionInput, SubmitFacts } from '../src/fin-appraisal';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const model: FinModelInput = { periodUnit: 'YEAR', discountRatePct: '10', convention: 'END', lines: [{ period: 0, capex: '100' }, { period: 1, benefit: '60', opex: '0' }, { period: 2, benefit: '60', maintenance: '0.00', residual: '' }] };
const entry = (key: string, overrides: Partial<FinAssumptionInput> = {}): FinAssumptionInput => ({ key, value: '10% mỗi năm', unit: '%', sourceKind: 'DOCUMENT', source: 'Quyết định 123/QĐ-UBND', ownerId: OWNER, ...overrides });

describe('the inputs of an appraisal that a person answers for', () => {
  it('asks for the horizon, the rate, every kind of line with an amount, and every scenario', () => {
    expect(requiredAssumptionKeys(model, [])).toEqual(['HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX']);
    expect(requiredAssumptionKeys(model, [{ code: 'ADVERSE', label: 'x', deltas: {} }])).toEqual(['HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX', 'SCENARIO:ADVERSE']);
    expect(requiredAssumptionKeys({ ...model, lines: [{ period: 0, opex: '0.01', residual: '5' }] }, [])).toEqual(['HORIZON', 'DISCOUNT_RATE', 'OPEX', 'RESIDUAL']);
  });

  it('names the first input nobody answers for, and lists all of them', () => {
    const required = requiredAssumptionKeys(model, []);
    expect(() => assertAssumptionsComplete(required, required.map((key) => entry(key)))).not.toThrow();
    const error = refusal(() => assertAssumptionsComplete(required, [entry('HORIZON'), entry('CAPEX')]));
    expect([error.code, error.status, error.detail]).toEqual(['APPRAISAL_ASSUMPTION_MISSING', 422, 'DISCOUNT_RATE']);
    expect(error.extensions).toEqual({ missing: ['DISCOUNT_RATE', 'BENEFIT'] });
  });

  it('refuses an assumption without a source, an owner, a unit or a value, or for an input that does not exist', () => {
    const reasonOf = (list: FinAssumptionInput[]): unknown => refusal(() => assertAssumptionForm(list)).extensions?.['reason'];
    expect(() => assertAssumptionForm([entry('CAPEX'), entry('SCENARIO:ADVERSE')])).not.toThrow();
    expect(reasonOf([entry('CAPEX', { source: ' ' })])).toBe('EMPTY');
    expect(reasonOf([entry('CAPEX', { unit: '' })])).toBe('EMPTY');
    expect(reasonOf([entry('CAPEX', { value: ' padded ' })])).toBe('EMPTY');
    expect(reasonOf([entry('CAPEX', { ownerId: 'someone' })])).toBe('NOT_AN_ID');
    expect(reasonOf([entry('CAPEX', { sourceKind: 'RUMOUR' })])).toBe('UNKNOWN_SOURCE_KIND');
    expect(reasonOf([entry('REVENUE')])).toBe('NOT_AN_INPUT');
    expect(reasonOf([entry('SCENARIO:low')])).toBe('NOT_AN_INPUT');
    expect(reasonOf([entry('CAPEX'), entry('CAPEX')])).toBe('DUPLICATE_KEY');
  });
});

describe('submitting and approving', () => {
  const fresh: SubmitFacts = { kind: 'FINANCIAL', lineCount: 3, criteriaCategory: null, criteriaScored: false, resultInputsHash: 'h1', currentInputsHash: 'h1', resultFormulaVersion: FIN_FORMULA_VERSION, currentFormulaVersion: FIN_FORMULA_VERSION };

  it('needs something to appraise and a result computed from exactly these inputs under the formula in force', () => {
    expect(() => assertSubmittable(fresh)).not.toThrow();
    expect(refusal(() => assertSubmittable({ ...fresh, lineCount: 0 })).code).toBe('APPRAISAL_INPUT_INCOMPLETE');
    const stale = refusal(() => assertSubmittable({ ...fresh, currentInputsHash: 'h2' }));
    expect([stale.code, stale.status, stale.extensions]).toEqual(['APPRAISAL_RESULTS_STALE', 409, { computed: true }]);
    expect(refusal(() => assertSubmittable({ ...fresh, resultInputsHash: null })).extensions).toEqual({ computed: false });
    expect(refusal(() => assertSubmittable({ ...fresh, resultFormulaVersion: 'fin-analysis/0.9' })).code).toBe('APPRAISAL_RESULTS_STALE');
  });

  it('needs a category and scores for a non-financial appraisal', () => {
    const non: SubmitFacts = { ...fresh, kind: 'NON_FINANCIAL', lineCount: 0 };
    expect(refusal(() => assertSubmittable(non)).extensions).toEqual({ reason: 'NO_CRITERIA_CATEGORY' });
    expect(refusal(() => assertSubmittable({ ...non, criteriaCategory: 'SAFETY' })).extensions).toEqual({ reason: 'NO_SCORES' });
    expect(() => assertSubmittable({ ...non, criteriaCategory: 'SAFETY', criteriaScored: true })).not.toThrow();
  });

  it('keeps the approver apart from whoever made, edited or submitted the appraisal', () => {
    const people = { createdBy: 'c0000000-0000-4000-8000-000000000001', updatedBy: 'e0000000-0000-4000-8000-000000000002', submittedBy: 's0000000-0000-4000-8000-000000000003' };
    expect(() => assertApprover('a0000000-0000-4000-8000-000000000004', people)).not.toThrow();
    for (const who of Object.values(people)) expect(refusal(() => assertApprover(who.toUpperCase(), people)).code).toBe('SELF_APPROVAL_DENIED');
    expect(() => assertApprover('a0000000-0000-4000-8000-000000000004', { ...people, submittedBy: null })).not.toThrow();
  });

  it('starts a command only from the statuses it allows', () => {
    expect(() => assertStatus('DRAFT', ['DRAFT'])).not.toThrow();
    const error = refusal(() => assertStatus('APPROVED', ['DRAFT', 'SUBMITTED']));
    expect([error.code, error.status]).toEqual(['APPRAISAL_STATE_INVALID', 409]);
    expect(error.extensions).toEqual({ appraisal_status: 'APPROVED', allowed: ['DRAFT', 'SUBMITTED'] });
  });
});

describe('computing an appraisal', () => {
  const lines = [{ period: 0, capex: '1000' }, { period: 1, benefit: '600' }, { period: 2, benefit: '600' }];
  const input: FinModelInput = { periodUnit: 'YEAR', discountRatePct: '10', convention: 'END', lines };
  const set = { category: 'SAFETY' as const, criteria: [{ key: 'one_a', label: 'Một', weightPct: '60' }, { key: 'two_b', label: 'Hai', weightPct: '40' }] };
  const scores = [{ key: 'one_a', score: 4, evidence: 'Biên bản' }, { key: 'two_b', score: 5, evidence: 'Báo cáo' }];

  it('runs the formula module and the scoring, and fingerprints both with the formula version', () => {
    const done = computeAppraisal({ kind: 'FINANCIAL', model: input, scenarios: [], sensitivity: null, criteria: { set, scores } });
    expect(done.report?.analysis.npv.value).toBe('41.32');
    expect(done.criteria?.weightedScore).toBe('4.40');
    expect(done.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.formulaVersion).toBe(FIN_FORMULA_VERSION);
    const again = computeAppraisal({ kind: 'FINANCIAL', model: { ...input, lines: [...lines].reverse() }, scenarios: [], sensitivity: null, criteria: { set, scores: [...scores].reverse() } });
    expect(again.resultHash).toBe(done.resultHash);
    const other = computeAppraisal({ kind: 'FINANCIAL', model: { ...input, discountRatePct: '11' }, scenarios: [], sensitivity: null, criteria: { set, scores } });
    expect(other.resultHash).not.toBe(done.resultHash);
    const rescored = computeAppraisal({ kind: 'FINANCIAL', model: input, scenarios: [], sensitivity: null, criteria: { set, scores: [{ key: 'one_a', score: 3, evidence: 'Biên bản' }, scores[1] as (typeof scores)[number]] } });
    expect(rescored.resultHash).not.toBe(done.resultHash);
  });

  it('wants a cash flow for a financial appraisal and scores for a non-financial one, and lets the latter have no cash flow', () => {
    expect(refusal(() => computeAppraisal({ kind: 'FINANCIAL', model: null, scenarios: [], sensitivity: null, criteria: null })).extensions).toEqual({ reason: 'NO_CASH_FLOW' });
    expect(refusal(() => computeAppraisal({ kind: 'FINANCIAL', model: { ...input, lines: [] }, scenarios: [], sensitivity: null, criteria: null })).code).toBe('APPRAISAL_INPUT_INCOMPLETE');
    expect(refusal(() => computeAppraisal({ kind: 'NON_FINANCIAL', model: null, scenarios: [], sensitivity: null, criteria: null })).extensions).toEqual({ reason: 'NO_SCORES' });
    const only = computeAppraisal({ kind: 'NON_FINANCIAL', model: null, scenarios: [], sensitivity: null, criteria: { set, scores } });
    expect(only.report).toBeNull();
    expect(only.criteria?.indexPct).toBe('88.00');
  });

  it('hashes the inputs apart from the weights, and in any order', () => {
    const base = { model: input, scenarios: [], sensitivity: null, category: 'SAFETY', scores };
    const hash = appraisalInputsHash(base);
    expect(appraisalInputsHash({ ...base, scores: [...scores].reverse(), model: { ...input, lines: [...lines].reverse() } })).toBe(hash);
    expect(appraisalInputsHash({ ...base, category: 'COMPLIANCE' })).not.toBe(hash);
    expect(appraisalInputsHash({ ...base, model: null })).not.toBe(hash);
    expect(appraisalInputsHash({ ...base, scores: [{ key: 'one_a', score: 5, evidence: 'Biên bản' }, scores[1] as (typeof scores)[number]] })).not.toBe(hash);
  });
});
