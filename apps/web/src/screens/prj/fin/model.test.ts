import { FIN_DEFAULT_SCENARIOS } from '@machvon/kernel/src/fin-defaults.ts';
import { buildReport } from '@machvon/kernel/src/fin-analysis.ts';
import { describe, expect, it } from 'vitest';
import { blankAssumption, decimalText, draftOf, draftProblems, idFrom, inputsBody, sameDraft, startScenarios, toAppraisal, toList } from './model';
import type { Draft } from './model';
import { OWNER, raw } from './fixtures';

describe('the figures are read digit for digit, never as floats', () => {
  it('groups and points the way the reader of the locale writes, and leaves what is not a decimal as it came', () => {
    expect(decimalText('388.77', 'vi')).toBe('388,77');
    expect(decimalText('388.77', 'en')).toBe('388.77');
    expect(decimalText('10000000.50', 'vi')).toBe('10.000.000,50');
    expect(decimalText('-1413.22', 'en')).toBe('-1,413.22');
    expect(decimalText('123456789012345678.99', 'vi')).toBe('123.456.789.012.345.678,99');
    expect(decimalText('0.1', 'vi')).toBe('0,1');
    expect(decimalText('abc', 'vi')).toBe('abc');
    expect(decimalText(null, 'vi')).toBe('');
    expect(decimalText('', 'vi')).toBe('');
  });

  it('reads an id from the address only when it is one', () => {
    expect(idFrom(OWNER.toUpperCase())).toBe(OWNER);
    expect(idFrom('x')).toBeUndefined();
    expect(idFrom(null)).toBeUndefined();
  });
});

describe('reading an appraisal of the server', () => {
  it('reads the inputs, the buttons and the report of the formula module (the same structure the kernel makes)', () => {
    const view = toAppraisal(raw());
    expect(view).toMatchObject({ code: 'FIN-2026-0001', status: 'DRAFT', version: 3, kind: 'FINANCIAL', resultsFresh: true, frozen: false, ownerUnit: { code: 'BQL1' } });
    expect(view?.actions).toEqual({ updateInputs: true, run: true, submit: true, approve: false, return: false, export: true, revise: false });
    const analysis = view?.results?.report;
    expect(analysis?.npv).toMatchObject({ status: 'OK', value: '388.77', code: 'NPV' });
    expect(analysis?.irr.value).toBe('24.888336');
    expect(analysis?.payback.value).toBe('2.6000');
    expect(analysis?.tcoValue).toMatchObject({ nominalTotal: '1000.00', presentValueTotal: '1000.00' });
    expect(analysis?.tcoValue?.byKind.map((entry) => entry.kind)).toEqual(['capex', 'opex', 'maintenance', 'residual']);
    expect(analysis?.table).toHaveLength(5);
    expect(analysis?.table[1]).toMatchObject({ period: 1, net: '300.00', factor: '0.90909091', presentValue: '272.73', cumulativeNet: '-700.00' });
    expect(analysis?.scenarios.map((scenario) => scenario.code)).toEqual(['BASE', 'FAVOURABLE', 'ADVERSE']);
    expect(analysis?.tornado).toHaveLength(7);
    expect(analysis?.tornado[0]?.parameter).toBe('benefitDelayPeriods');
    expect(analysis?.twoWay.npv[2]?.[2]).toBe('388.77');
    expect(analysis?.switching[0]).toMatchObject({ parameter: 'benefitPct', pct: '-27.99' });
    expect(analysis?.oneWay.map((table) => table.parameter)).toContain('discountRatePp');
    expect(analysis?.npv.assumptions[0]?.code).toBe('END_PERIOD');
    expect(analysis?.npv.inputs.discount_rate_pct).toBe('10.0000');
  });

  it('keeps a measure that does not apply as such, with its reason', () => {
    const none = buildReport({ model: { periodUnit: 'YEAR', discountRatePct: '10', convention: 'END', lines: [{ period: 0, capex: '100' }, { period: 1, opex: '50' }] }, scenarios: [] });
    const view = toAppraisal(raw({ results: { report: JSON.parse(JSON.stringify(none)) as unknown, criteria: null } }));
    expect(view?.results?.report?.irr).toMatchObject({ status: 'NOT_APPLICABLE', value: null, reason: 'NO_SIGN_CHANGE' });
    expect(view?.results?.report?.payback.reason).toBe('NOT_RECOVERED');
  });

  it('reads an appraisal with no result, a frozen one, and refuses what is not an appraisal', () => {
    expect(toAppraisal(raw({ results: null, results_fresh: false }))?.results).toBeNull();
    expect(toAppraisal(raw({ status: 'APPROVED', frozen: true, approved_by: { id: OWNER, name: 'B' }, approved_at: '2026-11-08T04:00:00.000Z' }))).toMatchObject({ status: 'APPROVED', frozen: true, approvedBy: { name: 'B' } });
    expect(toAppraisal(undefined)).toBeUndefined();
    expect(toAppraisal({})).toBeUndefined();
    expect(toAppraisal({ id: 'x' })).toBeUndefined();
  });

  it('reads the list with what the viewer may do and the state of the figures', () => {
    const list = toList({
      items: [{ id: 'a', code: 'FIN-2026-0001', revision: 2, title: 'T', kind: 'NON_FINANCIAL', status: 'APPROVED', version: 5, owner_unit: { id: 'u', code: 'U', name: 'N' }, project: { id: 'p', code: 'DA-1' }, package: null, contract: null, result_state: 'FROZEN', npv: '1.00', irr_pct: null, payback_periods: '2.5000', index_pct: '70.00', created_by_name: 'A', approved_by_name: 'B', updated_at: '2026-11-08T02:00:00.000Z' }],
      total: 1,
      actions: { create: true },
      as_of: '2026-11-08T03:00:00.000Z',
    });
    expect(list).toMatchObject({ total: 1, canCreate: true });
    expect(list?.items[0]).toMatchObject({ kind: 'NON_FINANCIAL', status: 'APPROVED', resultState: 'FROZEN', npv: '1.00', irrPct: null, indexPct: '70.00', project: { code: 'DA-1' } });
    expect(toList({})).toBeUndefined();
  });
});

describe('the draft of the inputs', () => {
  const view = toAppraisal(raw()) as NonNullable<ReturnType<typeof toAppraisal>>;

  it('shows zero amounts blank and sends back only what was entered, with no result in the body', () => {
    const draft = draftOf(view);
    expect(draft.lines[0]).toEqual({ period: '0', benefit: '', capex: '1000', opex: '', maintenance: '', residual: '' });
    const body = inputsBody(draft);
    expect(body).toMatchObject({ title: 'Cải tạo chiếu sáng', period_unit: 'YEAR', discount_rate_pct: '10', convention: 'END', criteria_category: null, scores: [], scenarios: [] });
    expect(body.lines).toEqual([{ period: 0, capex: '1000' }, { period: 1, benefit: '300' }]);
    expect(Object.keys(body).sort()).toEqual(['assumptions', 'convention', 'criteria_category', 'discount_rate_pct', 'lines', 'period_unit', 'scenarios', 'scores', 'title']);
    expect((body.assumptions as Array<Record<string, unknown>>)[0]).toEqual({ key: 'CAPEX', value: 'Theo dự toán', unit: 'đồng', source_kind: 'DOCUMENT', source: 'Quyết định 1', owner_id: OWNER });
    expect(sameDraft(draft, draftOf(view))).toBe(true);
    expect(sameDraft({ ...draft, discountRatePct: '11' }, draftOf(view))).toBe(false);
  });

  it('finds what is wrong before it is sent, naming the field and never turning a bad figure into a number', () => {
    const draft = draftOf(view);
    expect(draftProblems(draft)).toEqual(['assumption.0'].filter(() => false));
    const bad: Draft = {
      ...draft,
      title: ' ',
      discountRatePct: '1e1',
      lines: [{ period: '0', benefit: '1,5', capex: '10.123', opex: '', maintenance: '', residual: '' }, { period: '0', benefit: '', capex: '', opex: '', maintenance: '', residual: '' }, { period: '101', benefit: '', capex: '', opex: '', maintenance: '', residual: '' }],
      scenarios: [{ code: 'base', label: '', deltas: { benefitPct: '1.234', benefitDelayPeriods: '-1', discountRatePp: '2' } }, { code: 'OK_1', label: 'x', deltas: {} }, { code: 'OK_1', label: 'y', deltas: {} }],
      assumptions: [{ key: 'CAPEX', value: '', unit: 'đồng', sourceKind: 'DOCUMENT', source: 'x', ownerId: 'nobody' }],
      scores: [{ key: 'urgency', score: '6', evidence: 'x' }, { key: 'other', score: '3', evidence: '' }, { key: 'blank', score: '', evidence: '' }],
    };
    expect(draftProblems(bad)).toEqual([
      'title',
      'rate',
      'line.0.benefit',
      'line.0.capex',
      'line.1.period',
      'line.2.period',
      'scenario.0.code',
      'scenario.0.label',
      'scenario.0.benefitPct',
      'scenario.0.benefitDelayPeriods',
      'scenario.2.code',
      'assumption.0',
      'score.0',
      'score.1',
    ]);
  });

  it('starts the scenarios from the defaults of the platform, once, and offers a blank assumption owned by the person who opens it', () => {
    expect(startScenarios(FIN_DEFAULT_SCENARIOS, []).map((scenario) => scenario.code)).toEqual(['FAVOURABLE', 'ADVERSE']);
    expect(startScenarios(FIN_DEFAULT_SCENARIOS, ['ADVERSE']).map((scenario) => scenario.code)).toEqual(['FAVOURABLE']);
    expect(startScenarios(FIN_DEFAULT_SCENARIOS, [])[1]?.deltas).toMatchObject({ benefitPct: '-15', benefitDelayPeriods: '1' });
    expect(blankAssumption('CAPEX', OWNER)).toEqual({ key: 'CAPEX', value: '', unit: '', sourceKind: 'DOCUMENT', source: '', ownerId: OWNER });
  });

  it('sends the scores only of a category and only the ones that were scored', () => {
    const draft: Draft = { ...draftOf(view), criteriaCategory: 'SAFETY', scores: [{ key: 'urgency', score: '4', evidence: ' Biên bản ' }, { key: 'incident_history', score: '', evidence: '' }] };
    expect(inputsBody(draft)).toMatchObject({ criteria_category: 'SAFETY', scores: [{ key: 'urgency', score: 4, evidence: 'Biên bản' }] });
    expect(draftProblems(draft)).toEqual([]);
    expect(inputsBody({ ...draft, criteriaCategory: '' })).toMatchObject({ criteria_category: null, scores: [] });
  });
});
