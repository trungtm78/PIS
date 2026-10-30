import { assertRevisionDecision, assertRevisionProposal } from '../src/prj-revision';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const UNIT = '00000000-0000-4000-8000-0000000000a1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const BASE = { totalInvestmentVnd: '45000000000', startYear: 2026 as number | null, endYear: 2028 as number | null, investorUnitId: null as string | null };
const REASON = 'The cost of the site clearance went up';

describe('the revision of a project (ST-PRJ-008, PRJ 3.1 F6)', () => {
  it('proposes a new investment total once, at the top, and keeps the total of the project for every other kind', () => {
    const proposal = assertRevisionProposal({ change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: ' 55000000000.00 ', reason: ` ${REASON} ` }, BASE);
    expect(proposal).toEqual({ kind: 'ADJUST_INVESTMENT', reason: REASON, before: { total_investment_vnd: '45000000000' }, after: { total_investment_vnd: '55000000000' }, totalInvestmentVnd: '55000000000' });
    expect(assertRevisionProposal({ change_kind: 'ADJUST_INVESTMENT', after: { total_investment_vnd: '55000000000' }, total_investment_vnd: '55000000000', reason: REASON }, BASE).totalInvestmentVnd).toBe('55000000000');
    expect(assertRevisionProposal({ change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'Add a pedestrian bridge on the north bank' }, reason: REASON }, BASE).totalInvestmentVnd).toBe('45000000000');
  });

  it('refuses an investment change that names no total, the same total, a total that is not money, another total in after, or a field that is not its own', () => {
    const detail = (extra: Record<string, unknown>) => refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '55000000000', reason: REASON, ...extra }, BASE));
    expect(detail({ total_investment_vnd: undefined }).detail).toBe('total_investment_vnd');
    expect(detail({ total_investment_vnd: '45000000000' }).detail).toBe('total_investment_vnd');
    for (const bad of ['-1', '1.5', '01', 'abc', '1'.repeat(25), 5]) expect(detail({ total_investment_vnd: bad }).detail).toBe('total_investment_vnd');
    expect(detail({ after: { total_investment_vnd: '60000000000' } })).toEqual({ code: 'VALIDATION_FAILED', detail: 'after.total_investment_vnd', status: 422 });
    expect(detail({ after: { start_year: 2027 } }).detail).toBe('after.start_year');
  });

  it('moves the schedule: a start year, an end year or both, each a year that really changes, the end not before the start', () => {
    expect(assertRevisionProposal({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, reason: REASON }, BASE)).toMatchObject({ before: { end_year: 2028 }, after: { end_year: 2030 }, totalInvestmentVnd: '45000000000' });
    expect(assertRevisionProposal({ change_kind: 'ADJUST_SCHEDULE', after: { start_year: 2027, end_year: 2028 }, reason: REASON }, BASE)).toMatchObject({ before: { start_year: 2026 }, after: { start_year: 2027 } });
    expect(assertRevisionProposal({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, reason: REASON }, { ...BASE, endYear: null })).toMatchObject({ before: { end_year: null }, after: { end_year: 2030 } });
    const detail = (after: Record<string, unknown>, base = BASE) => refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_SCHEDULE', after, reason: REASON }, base)).detail;
    expect(detail({})).toBe('after');
    expect(detail({ end_year: 2028 })).toBe('after');
    expect(detail({ end_year: 2025 })).toBe('after.end_year');
    expect(detail({ start_year: 2029 })).toBe('after.end_year');
    expect([detail({ start_year: 1989 }), detail({ end_year: 2101 }), detail({ start_year: 2026.5 }), detail({ end_year: '2030' })]).toEqual(['after.start_year', 'after.end_year', 'after.start_year', 'after.end_year']);
    expect(detail({ end_year: 2030, unknown: 1 })).toBe('after.unknown');
    expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, total_investment_vnd: '1', reason: REASON }, BASE)).detail).toBe('total_investment_vnd');
  });

  it('changes the scope with a summary and the investor with a unit that is not the one it has', () => {
    expect(assertRevisionProposal({ change_kind: 'ADJUST_SCOPE', after: { scope_summary: '  Add a pedestrian bridge on the north bank ' }, reason: REASON }, BASE)).toMatchObject({ before: {}, after: { scope_summary: 'Add a pedestrian bridge on the north bank' } });
    expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'short' }, reason: REASON }, BASE)).detail).toBe('after.scope_summary');
    expect(assertRevisionProposal({ change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: UNIT.toUpperCase() }, reason: REASON }, BASE)).toMatchObject({ before: { investor_unit_id: null }, after: { investor_unit_id: UNIT } });
    expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: UNIT }, reason: REASON }, { ...BASE, investorUnitId: UNIT })).detail).toBe('after.investor_unit_id');
    expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: 'x' }, reason: REASON }, BASE)).detail).toBe('after.investor_unit_id');
  });

  it('refuses a kind that is not one, a reason that is too short, and an after that is not an object', () => {
    expect(refusal(() => assertRevisionProposal({ change_kind: 'INITIAL', after: {}, reason: REASON }, BASE)).detail).toBe('change_kind');
    expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'Add a pedestrian bridge' }, reason: 'short' }, BASE)).detail).toBe('reason');
    for (const after of [undefined, null, [], 'x']) expect(refusal(() => assertRevisionProposal({ change_kind: 'ADJUST_SCOPE', after, reason: REASON }, BASE)).detail).toBe('after');
  });

  it('UAT-AC214: approving needs the decision document (422 DECISION_REQUIRED) and the day it takes effect, which is a real day that has come', () => {
    const today = '2026-10-31';
    expect(refusal(() => assertRevisionDecision({ decision: 'approve', reason: 'Approved by the people committee', effective_from: today }, today))).toEqual({ code: 'DECISION_REQUIRED', detail: 'decision_document_id', status: 422 });
    expect(assertRevisionDecision({ decision: 'approve', reason: ' Approved by the people committee ', decision_document_id: DOCUMENT.toUpperCase(), effective_from: '2026-10-01' }, today)).toEqual({
      decision: 'approve',
      reason: 'Approved by the people committee',
      decisionDocumentId: DOCUMENT,
      effectiveFrom: '2026-10-01',
    });
    for (const bad of [undefined, '2026-02-30', '31/10/2026', '2026-11-01', 5]) expect(refusal(() => assertRevisionDecision({ decision: 'approve', reason: 'Approved by the committee', decision_document_id: DOCUMENT, effective_from: bad }, today)).detail).toBe('effective_from');
    expect(refusal(() => assertRevisionDecision({ decision: 'approve', reason: 'Approved by the committee', decision_document_id: 'x', effective_from: today }, today)).detail).toBe('decision_document_id');
  });

  it('rejects with a reason, with or without a document, and never with a day; refuses a decision that is neither', () => {
    expect(refusal(() => assertRevisionDecision({ decision: 'reject', reason: 'No' }, '2026-10-31')).detail).toBe('reason');
    expect(assertRevisionDecision({ decision: 'reject', reason: 'Not justified enough' }, '2026-10-31')).toEqual({ decision: 'reject', reason: 'Not justified enough', decisionDocumentId: undefined, effectiveFrom: undefined });
    expect(assertRevisionDecision({ decision: 'reject', reason: 'Not justified enough', decision_document_id: DOCUMENT }, '2026-10-31').decisionDocumentId).toBe(DOCUMENT);
    expect(refusal(() => assertRevisionDecision({ decision: 'reject', reason: 'Not justified enough', effective_from: '2026-10-01' }, '2026-10-31')).detail).toBe('effective_from');
    expect(refusal(() => assertRevisionDecision({ decision: 'return', reason: 'Not justified enough' }, '2026-10-31')).detail).toBe('decision');
  });
});
