import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  BASES,
  BUCKETS,
  CELLS,
  LEVELS,
  NO_FILTER,
  canCreate,
  canEdit,
  cellId,
  createBody,
  deltaOf,
  describeReport,
  fieldId,
  formOf,
  hasFall,
  hasProblems,
  isFiltered,
  queryOf,
  resourceIdOf,
  saveBody,
  takesCtmtqg,
  toReportDetail,
  toReportLine,
  toReportPage,
  totalsOf,
  validateFunding,
} from './model';
import type { FundingForm, ReportDetail } from './model';
import { digitsOf, formatVnd } from './money';
import { PERIOD, PLAN_VERSION, PROJECT, fxCells, kpiRecord, lineRecord, pageRecord, reportRecord } from './test-support';

const detailOf = (overrides: Record<string, unknown> = {}): ReportDetail => toReportDetail(reportRecord(overrides)) as ReportDetail;
const CENTRAL = { bucket: 'CURRENT_YEAR', level: 'CENTRAL' } as const;

describe('money', () => {
  it('writes whole dong with a dot between the thousands, a sign kept', () => {
    expect(formatVnd('0')).toBe('0');
    expect(formatVnd('1250000000')).toBe('1.250.000.000');
    expect(formatVnd('-50000000')).toBe('-50.000.000');
  });

  it('reads an amount typed with dots, commas or spaces, and nothing else', () => {
    expect(digitsOf('1.250.000.000')).toBe('1250000000');
    expect(digitsOf('1,250,000,000')).toBe('1250000000');
    expect(digitsOf(' 1 250 000 ')).toBe('1250000');
    expect(digitsOf('007')).toBe('7');
    for (const bad of ['', 'abc', '-5', '1.5e3', '12x', '9'.repeat(25)]) expect(digitsOf(bad)).toBeUndefined();
  });
});

describe('what the reads answer', () => {
  it('names the six cells in the order of the form, and the CTMTQG only in the year plan and the carried-over plan', () => {
    expect(CELLS.map(cellId)).toEqual(['CURRENT_YEAR:CENTRAL', 'CURRENT_YEAR:LOCAL', 'CARRYOVER:CENTRAL', 'CARRYOVER:LOCAL', 'OTHER:CENTRAL', 'OTHER:LOCAL']);
    expect([...BUCKETS, ...LEVELS, ...BASES]).toHaveLength(8);
    expect(BUCKETS.map(takesCtmtqg)).toEqual([true, true, false]);
  });

  it('reads a line of the list, and drops one that is not whole', () => {
    expect(toReportLine(lineRecord(1))).toEqual({
      id: lineRecord(1).id,
      project: { id: PROJECT, code: 'DA-2027-001', name: 'Cầu số 1' },
      period: { id: PERIOD, code: '2027-W01', endDate: '2027-01-10', fiscalYear: 2027 },
      revision: 1,
      status: 'DRAFT',
      reportType: 'WEEKLY',
      isLate: false,
      version: 1,
      cumulativeVnd: '420000000',
      ctmtqgVnd: '40000000',
      updatedAt: '2027-01-05T03:00:00.000Z',
    });
    expect(toReportLine(lineRecord(2, { is_late: true }))?.isLate).toBe(true);
    for (const broken of [{ id: undefined }, { status: 'SENT' }, { report_type: 'DAILY' }, { cumulative_vnd: '12.5' }, { project: null }, { period: { id: PERIOD } }, { version: -1 }, { updated_at: 5 }]) {
      expect(toReportLine(lineRecord(3, broken))).toBeUndefined();
    }
    expect(toReportLine(null)).toBeUndefined();
  });

  it('reads a page with the figures of the filter and of the whole scope, and a page without them', () => {
    const page = toReportPage(pageRecord([lineRecord(1), { id: 'broken' }], { next_cursor: 'abc' }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('abc');
    expect(page.summary).toEqual({ filtered: { reports: 2, projects: 1, cumulativeVnd: '840000000', ctmtqgVnd: '80000000' }, scope: { reports: 2, projects: 1, cumulativeVnd: '840000000', ctmtqgVnd: '80000000' }, isFiltered: false });
    const filtered = toReportPage({ items: [], next_cursor: null, summary: { filtered: kpiRecord(1, 1, '5', '1'), scope: kpiRecord(9, 3, '50', '10'), is_filtered: true } });
    expect(filtered.summary).toMatchObject({ isFiltered: true, scope: { reports: 9 } });
    expect(toReportPage({ items: 'x' })).toEqual({ items: [], nextCursor: null, summary: undefined });
    expect(toReportPage({ items: [], summary: { filtered: kpiRecord(1, 1, 'x', '1'), scope: kpiRecord(1, 1, '5', '1') } }).summary).toBeUndefined();
  });

  it('AC-ST-DIS-003-1: reads a report with its six cells, what the plan allocated and the total of 420 million with the CTMTQG of 40 million apart', () => {
    const detail = detailOf();
    expect(detail).toMatchObject({
      id: reportRecord().id,
      revision: 1,
      status: 'DRAFT',
      version: 3,
      reportType: 'WEEKLY',
      measurementBasis: 'YTD',
      negativeDeltaExplanation: null,
      project: { id: PROJECT, code: 'DA-2027-001', status: 'IMPLEMENTATION' },
      period: { id: PERIOD, code: '2027-W01', periodType: 'WEEK', fiscalYear: 2027, startDate: '2027-01-04', endDate: '2027-01-10' },
      planVersion: { id: PLAN_VERSION, fiscalYear: 2027, revision: 2 },
      totals: { allocatedVnd: '850000000', cumulativeVnd: '420000000', ctmtqgVnd: '40000000' },
    });
    expect(detail.cells.map((cell) => [cell.bucket, cell.level, cell.cumulativeVnd, cell.ctmtqgVnd, cell.allocatedVnd, cell.nextMonthVnd])).toEqual([
      ['CURRENT_YEAR', 'CENTRAL', '100000000', '40000000', '500000000', '0'],
      ['CURRENT_YEAR', 'LOCAL', '200000000', null, '300000000', '5000000'],
      ['CARRYOVER', 'CENTRAL', '30000000', null, '0', '0'],
      ['CARRYOVER', 'LOCAL', '70000000', null, '50000000', '0'],
      ['OTHER', 'CENTRAL', '0', null, '0', '0'],
      ['OTHER', 'LOCAL', '20000000', null, '0', '0'],
    ]);
    expect(detail.cells[0]?.sourceYear).toBe(2027);
  });

  it('reads the comparison with the period before as it is, a fall included, and drops a cell that is not whole', () => {
    const cells = fxCells();
    cells[0] = { ...(cells[0] as Record<string, unknown>), previous_cumulative_vnd: '150000000', delta_vnd: '-50000000' };
    cells[1] = { ...(cells[1] as Record<string, unknown>), cumulative_vnd: '12.5' };
    const detail = detailOf({ funding_lines: cells });
    expect(detail.cells).toHaveLength(5);
    expect(detail.cells[0]).toMatchObject({ previousCumulativeVnd: '150000000', deltaVnd: '-50000000' });
    for (const broken of [{ id: undefined }, { status: 'NOPE' }, { version: 'x' }, { measurement_basis: 'DAILY' }, { project: {} }, { plan_version: null }, { totals: { allocated_vnd: '1' } }, { period: { id: PERIOD } }]) {
      expect(toReportDetail(reportRecord(broken))).toBeUndefined();
    }
    expect(toReportDetail(null)).toBeUndefined();
  });
});

describe('the buttons', () => {
  it('shows the start of a report to a holder of the permission to create, not in a tenant that is read only', () => {
    expect(canCreate(['report.create'], 'FULL')).toBe(true);
    expect(canCreate(undefined, undefined)).toBe(true);
    expect(canCreate(['report.read'], 'FULL')).toBe(false);
    expect(canCreate(['report.create'], 'READ_ONLY')).toBe(false);
  });

  it('lets a holder of the permission to edit change a draft, and nobody change a report that was handed in', () => {
    expect(canEdit(['report.edit'], 'FULL', 'DRAFT')).toBe(true);
    expect(canEdit(['report.read'], 'FULL', 'DRAFT')).toBe(false);
    expect(canEdit(['report.edit'], 'READ_ONLY', 'DRAFT')).toBe(false);
    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) expect(canEdit(['report.edit'], 'FULL', status)).toBe(false);
  });
});

describe('the form of the six cells', () => {
  const formWith = (cells: Record<string, { cumulative: string; ctmtqg: string }>, extra: Partial<FundingForm> = {}): FundingForm => ({ basis: 'YTD', explanation: '', cells, ...extra });
  const zero = (): Record<string, { cumulative: string; ctmtqg: string }> => Object.fromEntries(CELLS.map((cell) => [cellId(cell), { cumulative: '0', ctmtqg: '' }]));

  it('starts from the report: the cells as they were saved, the basis, the explanation', () => {
    const form = formOf(detailOf({ negative_delta_explanation: 'The Treasury returned a payment.', measurement_basis: 'PERIOD' }));
    expect(form.basis).toBe('PERIOD');
    expect(form.explanation).toBe('The Treasury returned a payment.');
    expect(form.cells['CURRENT_YEAR:CENTRAL']).toEqual({ cumulative: '100000000', ctmtqg: '40000000' });
    expect(form.cells['OTHER:CENTRAL']).toEqual({ cumulative: '0', ctmtqg: '' });
    expect(formOf(detailOf({ funding_lines: [] })).cells['OTHER:LOCAL']).toEqual({ cumulative: '0', ctmtqg: '' });
  });

  it('AC-ST-DIS-003-1 / FX-DIS-001: adds the six cells to 420 million, not 460 million, and gives the CTMTQG of 40 million apart', () => {
    expect(totalsOf(formOf(detailOf()))).toEqual({ cumulativeVnd: '420000000', ctmtqgVnd: '40000000' });
    const typed = zero();
    typed['CURRENT_YEAR:CENTRAL'] = { cumulative: '1.000', ctmtqg: '250' };
    typed['CARRYOVER:LOCAL'] = { cumulative: 'abc', ctmtqg: '' };
    expect(totalsOf(formWith(typed))).toEqual({ cumulativeVnd: '1000', ctmtqgVnd: '250' });
  });

  it('accepts a form of whole amounts with the CTMTQG inside its cell', () => {
    expect(validateFunding(formOf(detailOf()))).toEqual({ cells: {} });
    expect(hasProblems(validateFunding(formOf(detailOf())))).toBe(false);
  });

  it('AC-ST-DIS-003-2 / FX-DIS-006: a CTMTQG of 120 million against a cell of 100 million is refused on the CTMTQG field', () => {
    const typed = zero();
    typed['CURRENT_YEAR:CENTRAL'] = { cumulative: '100.000.000', ctmtqg: '120.000.000' };
    const problems = validateFunding(formWith(typed));
    expect(problems.cells).toEqual({ [fieldId(CENTRAL, 'ctmtqg')]: 'exceeds' });
    expect(hasProblems(problems)).toBe(true);
  });

  it('says what is wrong with each cell: nothing entered, not an amount, a CTMTQG that is not one or in a source that has none', () => {
    const typed = zero();
    typed['CURRENT_YEAR:CENTRAL'] = { cumulative: '', ctmtqg: '' };
    typed['CURRENT_YEAR:LOCAL'] = { cumulative: '-5', ctmtqg: 'x' };
    typed['CARRYOVER:CENTRAL'] = { cumulative: '10', ctmtqg: '1,5x' };
    typed['OTHER:LOCAL'] = { cumulative: '10', ctmtqg: '1' };
    expect(validateFunding(formWith(typed)).cells).toEqual({
      'CURRENT_YEAR:CENTRAL.cumulative': 'required',
      'CURRENT_YEAR:LOCAL.cumulative': 'invalid',
      'CURRENT_YEAR:LOCAL.ctmtqg': 'invalid',
      'CARRYOVER:CENTRAL.ctmtqg': 'invalid',
      'OTHER:LOCAL.ctmtqg': 'notAllowed',
    });
    // A cell missing from the form reads as nothing entered.
    expect(validateFunding(formWith({})).cells['CURRENT_YEAR:CENTRAL.cumulative']).toBe('required');
  });

  it('asks for an explanation of 10 to 2000 characters when one is given', () => {
    const base = zero();
    expect(validateFunding(formWith(base, { explanation: '' })).explanation).toBeUndefined();
    expect(validateFunding(formWith(base, { explanation: 'The Treasury returned a payment.' })).explanation).toBeUndefined();
    expect(validateFunding(formWith(base, { explanation: ' short ' })).explanation).toBe('tooShort');
    expect(validateFunding(formWith(base, { explanation: 'x'.repeat(2001) })).explanation).toBe('tooLong');
    expect(validateFunding(formWith(base, { explanation: 'bad\u0007control character' })).explanation).toBe('invalid');
  });

  it('shows what a cell added since the period before, and a fall as a negative number (BR-DIS-03)', () => {
    expect(deltaOf('100', '150')).toBe('50');
    expect(deltaOf('150', '1.000')).toBe('850');
    expect(deltaOf('150', '100')).toBe('-50');
    expect(deltaOf(null, '100')).toBeNull();
    expect(deltaOf('100', 'abc')).toBeNull();
    const cells = fxCells();
    cells[0] = { ...(cells[0] as Record<string, unknown>), previous_cumulative_vnd: '150000000', delta_vnd: '-50000000' };
    const detail = detailOf({ funding_lines: cells });
    expect(hasFall(detail, formOf(detail))).toBe(true);
    const raised = formOf(detail);
    raised.cells['CURRENT_YEAR:CENTRAL'] = { cumulative: '150.000.000', ctmtqg: '' };
    expect(hasFall(detail, raised)).toBe(false);
    expect(hasFall(detailOf(), formOf(detailOf()))).toBe(false);
  });
});

describe('what is sent', () => {
  it('starts a draft with the project, the period and the basis, and no cell: the server finds the plan version', () => {
    expect(createBody({ projectId: PROJECT, periodId: PERIOD, basis: 'YTD' })).toEqual({ project_id: PROJECT, period_id: PERIOD, measurement_basis: 'YTD', report_type: 'WEEKLY', funding_lines: [] });
  });

  it('saves all six cells as whole dong, the plan version of the report, the CTMTQG only where it is given, and the next month as the report holds it', () => {
    const detail = detailOf();
    const form = formOf(detail);
    form.cells['CURRENT_YEAR:LOCAL'] = { cumulative: '250.000.000', ctmtqg: '' };
    form.basis = 'PERIOD';
    form.explanation = '  The Treasury returned a payment.  ';
    const body = saveBody(detail, form);
    expect(body).toMatchObject({ project_id: PROJECT, period_id: PERIOD, plan_version_id: PLAN_VERSION, report_type: 'WEEKLY', measurement_basis: 'PERIOD', negative_delta_explanation: 'The Treasury returned a payment.' });
    expect(body.funding_lines).toHaveLength(6);
    expect(body.funding_lines[0]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '0' });
    expect(body.funding_lines[1]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '250000000', next_month_vnd: '5000000' });
    const kept = detailOf({ funding_lines: [{ ...(fxCells()[0] as Record<string, unknown>), next_month_vnd: '10', next_month_ctmtqg_subset_vnd: '4' }] });
    const sent = saveBody(kept, formOf(kept));
    expect(sent.funding_lines[0]).toMatchObject({ next_month_vnd: '10', next_month_ctmtqg_subset_vnd: '4' });
    expect(sent.funding_lines[5]).toEqual({ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '0', next_month_vnd: '0' });
    expect('negative_delta_explanation' in saveBody(detail, formOf(detail))).toBe(false);
    const missing = { ...formOf(detail), cells: {} } as FundingForm;
    expect(saveBody(detail, missing).funding_lines[0]).toMatchObject({ cumulative_vnd: '0' });
  });

  it('asks the list for the filters that are set, and nothing for the ones that are not', () => {
    expect(queryOf(NO_FILTER, undefined)).toEqual({});
    expect(queryOf({ year: '2027', periodId: PERIOD, planId: 'p', projectId: PROJECT, status: 'RETURNED' }, 'c1')).toEqual({ fiscal_year: '2027', period_id: PERIOD, plan_id: 'p', project_id: PROJECT, status: 'RETURNED', cursor: 'c1' });
    expect(isFiltered(NO_FILTER)).toBe(false);
    for (const filter of [{ ...NO_FILTER, year: '2027' }, { ...NO_FILTER, periodId: 'x' }, { ...NO_FILTER, planId: 'x' }, { ...NO_FILTER, projectId: 'x' }, { ...NO_FILTER, status: 'DRAFT' as const }]) expect(isFiltered(filter)).toBe(true);
  });

  it('reads the id of the report a command made', () => {
    expect(resourceIdOf({ resource_id: PROJECT, status: 'DRAFT' })).toBe(PROJECT);
    expect(resourceIdOf({})).toBeUndefined();
    expect(resourceIdOf(null)).toBeUndefined();
  });
});

describe('what a refusal of the server is told as', () => {
  const refusal = (code: string, extra: { detail?: string; extensions?: Record<string, unknown> } = {}) => describeReport(new ApiError({ status: 409, code, correlationId: 'c', ...extra }));

  it('names each refusal of the two commands', () => {
    const expected: Array<[string, string]> = [
      ['DRAFT_EXISTS', 'draftExists'],
      ['REPORT_STATE_INVALID', 'reportExists'],
      ['PERIOD_LOCKED', 'periodLocked'],
      ['PLAN_VERSION_NOT_EFFECTIVE', 'planNotEffective'],
      ['PROJECT_STAGE_INVALID', 'stageInvalid'],
      ['SUBSET_EXCEEDS_PARENT', 'subsetExceeds'],
      ['REVISION_IMMUTABLE', 'immutable'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SOMETHING_NEW', 'general'],
    ];
    for (const [code, problem] of expected) expect(refusal(code).problem).toBe(problem);
    expect(describeReport(new Error('offline'))).toEqual({ problem: 'general', existingId: undefined, field: undefined });
  });

  it('leads to the draft that is in the way, and marks the cell the server named', () => {
    expect(refusal('DRAFT_EXISTS', { extensions: { report_id: REPORT_ID } })).toMatchObject({ problem: 'draftExists', existingId: REPORT_ID });
    expect(refusal('DRAFT_EXISTS', { extensions: { report_id: 5 } }).existingId).toBeUndefined();
    expect(refusal('SUBSET_EXCEEDS_PARENT', { detail: 'funding_lines[0].ctmtqg_subset_vnd' }).field).toBe('CURRENT_YEAR:CENTRAL.ctmtqg');
    expect(refusal('VALIDATION_FAILED', { detail: 'funding_lines[3].cumulative_vnd' }).field).toBe('CARRYOVER:LOCAL.cumulative');
    expect(refusal('VALIDATION_FAILED', { detail: 'project_id' }).field).toBeUndefined();
    expect(refusal('VALIDATION_FAILED', { detail: 'funding_lines[9].cumulative_vnd' }).field).toBeUndefined();
  });
});

const REPORT_ID = reportRecord().id as string;
