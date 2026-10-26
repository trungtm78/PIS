import { describe, expect, it } from 'vitest';
import { toDecisions } from './detail-parts';
import { canAskAmendment, canCorrect, canDecide, compareRevisions, correctionBody, decisionBody, emptyDecision, formatMoment, itemsOf, signed, validateDecision, validateReason } from './decision-model';
import { formOf, toReportDetail } from './model';
import type { ReportDetail } from './model';
import { reportRecord } from './test-support';

const TODAY = new Date('2027-01-11T03:00:00.000Z');
const detailOf = (overrides: Record<string, unknown> = {}): ReportDetail => toReportDetail(reportRecord(overrides)) as ReportDetail;

describe('the decisions of a report as the page reads them (ST-DIS-006)', () => {
  it('reads what the server kept of a decision and leaves out an entry that is not one', () => {
    expect(
      toDecisions([
        { id: 'd1', decision: 'RETURNED', reason: 'Wrong cell.', evidence_ids: ['e1'], return_items: ['Fix the cell', 7], due_at: '2027-01-20T16:59:59.000Z', decided_by: 'm1', decided_at: '2027-01-12T03:00:00.000Z' },
        { id: 'd2', decision: 'REJECTED', reason: 'No such decision.', decided_by: 'm1', decided_at: '2027-01-12T03:00:00.000Z' },
        { id: 'd3', decision: 'ACCEPTED' },
        'nothing',
      ]),
    ).toEqual([{ id: 'd1', decision: 'RETURNED', reason: 'Wrong cell.', evidenceIds: ['e1'], returnItems: ['Fix the cell'], dueAt: '2027-01-20T16:59:59.000Z', decidedBy: 'm1', decidedAt: '2027-01-12T03:00:00.000Z' }]);
    expect(toDecisions(undefined)).toEqual([]);
  });

  it('reads the lineage, the current mark and who handed the report in and who accepted it', () => {
    const detail = detailOf({ status: 'ACCEPTED', is_current: true, submitted_by: 'a', accepted_by: 'b', accepted_at: '2027-01-12T03:00:00.000Z', supersedes_id: 'old', amendment_reason: 'The Treasury corrected a payment.', returned_reason: null });
    expect(detail).toMatchObject({ isCurrent: true, submittedBy: 'a', acceptedBy: 'b', acceptedAt: '2027-01-12T03:00:00.000Z', supersedesId: 'old', amendmentReason: 'The Treasury corrected a payment.', returnedReason: null, decisions: [] });
  });
});

describe('who may decide and correct (the server decides again)', () => {
  it('lets a reviewer accept or return what was handed in, in a tenant that is not read only', () => {
    expect(canDecide(['report.review'], 'FULL', 'SUBMITTED')).toBe(true);
    expect(canDecide(['report.review'], undefined, 'UNDER_REVIEW')).toBe(true);
    expect(canDecide(undefined, 'FULL', 'SUBMITTED')).toBe(true);
    expect(canDecide(['report.read'], 'FULL', 'SUBMITTED')).toBe(false);
    expect(canDecide(['report.review'], 'READ_ONLY', 'SUBMITTED')).toBe(false);
    for (const status of ['DRAFT', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) expect(canDecide(['report.review'], 'FULL', status)).toBe(false);
  });

  it('lets a reviewer ask the amendment of the accepted report that is the current one, and no other', () => {
    expect(canAskAmendment(['report.review'], 'FULL', detailOf({ status: 'ACCEPTED', is_current: true }))).toBe(true);
    expect(canAskAmendment(['report.review'], 'FULL', detailOf({ status: 'ACCEPTED', is_current: false }))).toBe(false);
    expect(canAskAmendment(['report.review'], 'FULL', detailOf({ status: 'SUBMITTED', is_current: false }))).toBe(false);
    expect(canAskAmendment(['report.read'], 'FULL', detailOf({ status: 'ACCEPTED', is_current: true }))).toBe(false);
  });

  it('lets a maker correct a report that was accepted, returned, asked to be amended or withdrawn', () => {
    for (const status of ['ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN'] as const) expect(canCorrect(['report.correct'], 'FULL', status)).toBe(true);
    for (const status of ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'SUPERSEDED'] as const) expect(canCorrect(['report.correct'], 'FULL', status)).toBe(false);
    expect(canCorrect(['report.edit'], 'FULL', 'RETURNED')).toBe(false);
    expect(canCorrect(['report.correct'], 'READ_ONLY', 'RETURNED')).toBe(false);
  });
});

describe('the form of a decision', () => {
  const form = (overrides: Partial<ReturnType<typeof emptyDecision>> = {}) => ({ ...emptyDecision('return'), reason: 'The CTMTQG cell is wrong.', items: 'Fix the CTMTQG cell', dueOn: '2027-01-20', ...overrides });

  it('asks an approval for words only, and a return for items and a day after today', () => {
    expect(validateDecision({ ...emptyDecision('approve'), reason: 'Agrees with the Treasury.' }, TODAY)).toEqual({});
    expect(validateDecision(emptyDecision('approve'), TODAY)).toEqual({ reason: 'required' });
    expect(validateDecision(form(), TODAY)).toEqual({});
    expect(validateDecision(form({ reason: ' ', items: '', dueOn: '' }), TODAY)).toEqual({ reason: 'required', items: 'required', dueOn: 'dueRequired' });
    expect(validateDecision(form({ reason: 'x'.repeat(2001) }), TODAY)).toEqual({ reason: 'tooLong' });
  });

  it('judges each line of the items and the number of them', () => {
    expect(validateDecision(form({ items: 'ab' }), TODAY)).toEqual({ items: 'itemTooShort' });
    expect(validateDecision(form({ items: `Fine item\n${'x'.repeat(2001)}` }), TODAY)).toEqual({ items: 'itemTooLong' });
    expect(validateDecision(form({ items: Array.from({ length: 21 }, (_, n) => `Item number ${n}`).join('\n') }), TODAY)).toEqual({ items: 'tooMany' });
    expect(itemsOf('  First item \n\n Second item  \n')).toEqual(['First item', 'Second item']);
  });

  it('wants a day that is a date and has not passed: today is still open until its end, yesterday is not', () => {
    expect(validateDecision(form({ dueOn: '2027-01-11' }), TODAY)).toEqual({});
    expect(validateDecision(form({ dueOn: '2027-01-10' }), TODAY)).toEqual({ dueOn: 'dueInvalid' });
    expect(validateDecision(form({ dueOn: '11/01/2027' }), TODAY)).toEqual({ dueOn: 'dueInvalid' });
    expect(validateDecision(form({ dueOn: '2027-02-30' }), TODAY)).toEqual({ dueOn: 'dueInvalid' });
  });

  it('lets a request for an amendment name items and a day, or none', () => {
    const asked = { ...emptyDecision('request_amendment'), reason: 'The Treasury corrected a payment.' };
    expect(validateDecision(asked, TODAY)).toEqual({});
    expect(validateDecision({ ...asked, items: 'ab' }, TODAY)).toEqual({ items: 'itemTooShort' });
    expect(validateDecision({ ...asked, dueOn: 'soon' }, TODAY)).toEqual({ dueOn: 'dueInvalid' });
  });

  it('sends what the server asks for: the evidence is an empty list, the items and the end of the day only when they are there', () => {
    expect(decisionBody({ ...emptyDecision('approve'), reason: ' Agrees. ', items: 'ignored', dueOn: '2027-01-20' })).toEqual({ decision: 'approve', reason: 'Agrees.', evidence_ids: [] });
    expect(decisionBody(form())).toEqual({ decision: 'return', reason: 'The CTMTQG cell is wrong.', evidence_ids: [], return_items: ['Fix the CTMTQG cell'], due_at: '2027-01-20T16:59:59.000Z' });
    expect(decisionBody({ ...emptyDecision('request_amendment'), reason: 'The Treasury corrected a payment.' })).toEqual({ decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
  });
});

describe('the correction', () => {
  it('asks for the reason in words: at least 10 characters, at most 2000', () => {
    expect(validateReason('')).toBe('required');
    expect(validateReason('too short')).toBe('tooShort');
    expect(validateReason('x'.repeat(2001))).toBe('tooLong');
    expect(validateReason('  The Treasury corrected a payment.  ')).toBeUndefined();
  });

  it('sends the reason and only the cells that changed, with the year of their source and the registration for next month as they were', () => {
    const detail = detailOf({ status: 'RETURNED' });
    const form = formOf(detail);
    expect(correctionBody(detail, { reason: ' The Treasury corrected a payment of March. ', funding: form })).toEqual({ amendment_reason: 'The Treasury corrected a payment of March.' });
    form.cells['CURRENT_YEAR:LOCAL'] = { cumulative: '250.000.000', ctmtqg: '' };
    form.cells['CURRENT_YEAR:CENTRAL'] = { cumulative: '100.000.000', ctmtqg: '45.000.000' };
    form.explanation = ' The payment was returned. ';
    expect(correctionBody(detail, { reason: 'The Treasury corrected a payment of March.', funding: form })).toEqual({
      amendment_reason: 'The Treasury corrected a payment of March.',
      funding_lines: [
        { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '45000000', source_year: 2027, next_month_vnd: '0' },
        { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '250000000', next_month_vnd: '5000000' },
      ],
      negative_delta_explanation: 'The payment was returned.',
    });
  });

  it('compares two revisions cell by cell, a fall negative and never zero', () => {
    const first = detailOf();
    const cells = (first.cells ?? []).map((cell) => (cell.bucket === 'CURRENT_YEAR' && cell.level === 'LOCAL' ? { ...cell, cumulativeVnd: '150000000' } : cell));
    const second = { ...first, cells };
    const rows = compareRevisions(first, second);
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.bucket === 'CURRENT_YEAR' && row.level === 'LOCAL')).toEqual({ bucket: 'CURRENT_YEAR', level: 'LOCAL', firstVnd: '200000000', secondVnd: '150000000', changeVnd: '-50000000' });
    expect(rows.filter((row) => row.changeVnd !== '0')).toHaveLength(1);
    expect([signed('50'), signed('-50'), signed('0')]).toEqual(['+50', '-50', '0']);
  });

  it('writes a moment in Vietnam time, and a text that is not a moment as it was', () => {
    expect(formatMoment('2027-01-12T03:05:00.000Z')).toBe('12/01/2027 10:05');
    expect(formatMoment('soon')).toBe('soon');
  });
});
