import { DomainError } from '../src/errors.ts';
import {
  BUDGET_LEVELS,
  FUNDING_BUCKETS,
  FUNDING_CELLS,
  REPORTABLE_PROJECT_STATUSES,
  assertReportableStage,
  deltaOf,
  draftHash,
  fundingCells,
  fundingTotals,
  negativeDeltaExplanation,
  periodDeltaOf,
  takesCtmtqg,
} from '../src/dis-report.ts';
import type { RawFundingLine } from '../src/dis-report.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const PROJECT = '00000000-0000-4000-8000-000000000001';
const PERIOD = '00000000-0000-4000-8000-000000000002';
const PLAN = '00000000-0000-4000-8000-000000000003';

const line = (bucket: RawFundingLine['bucket'], budgetLevel: RawFundingLine['budget_level'], cumulative: string, extra: Partial<RawFundingLine> = {}): RawFundingLine => ({
  bucket,
  budget_level: budgetLevel,
  cumulative_vnd: cumulative,
  ...extra,
});

/** FX-DIS-001: six cells 100/200/30/70/0/20 million and CTMTQG 40 million in the year plan of the central budget. */
const FX_DIS_001: RawFundingLine[] = [
  line('CURRENT_YEAR', 'CENTRAL', '100000000', { ctmtqg_subset_vnd: '40000000' }),
  line('CURRENT_YEAR', 'LOCAL', '200000000'),
  line('CARRYOVER', 'CENTRAL', '30000000'),
  line('CARRYOVER', 'LOCAL', '70000000'),
  line('OTHER', 'CENTRAL', '0'),
  line('OTHER', 'LOCAL', '20000000'),
];

describe('the six cells of a report (DIS 3 F1, BR-DIS-01)', () => {
  it('names three sources by two budgets, in the order of the paper form', () => {
    expect([...FUNDING_BUCKETS]).toEqual(['CURRENT_YEAR', 'CARRYOVER', 'OTHER']);
    expect([...BUDGET_LEVELS]).toEqual(['CENTRAL', 'LOCAL']);
    expect(FUNDING_CELLS.map((cell) => `${cell.bucket}/${cell.budgetLevel}`)).toEqual([
      'CURRENT_YEAR/CENTRAL',
      'CURRENT_YEAR/LOCAL',
      'CARRYOVER/CENTRAL',
      'CARRYOVER/LOCAL',
      'OTHER/CENTRAL',
      'OTHER/LOCAL',
    ]);
    expect(FUNDING_BUCKETS.map(takesCtmtqg)).toEqual([true, true, false]);
  });

  it('AC-ST-DIS-003-1 / FX-DIS-001: 100 + 200 + 30 + 70 + 0 + 20 million is 420 million, not 460 million, and the CTMTQG of 40 million is shown apart', () => {
    const cells = fundingCells(FX_DIS_001);
    expect(cells).toHaveLength(6);
    expect(fundingTotals(cells)).toEqual({ cumulativeVnd: '420000000', ctmtqgVnd: '40000000', nextMonthVnd: '0', nextMonthCtmtqgVnd: '0' });
  });

  it('gives six cells whatever was entered, in the order of the form, a cell left out reading zero', () => {
    const cells = fundingCells([line('OTHER', 'LOCAL', '5'), line('CURRENT_YEAR', 'LOCAL', '7', { source_year: 2026 })]);
    expect(cells.map((cell) => [cell.bucket, cell.budgetLevel, cell.cumulativeVnd, cell.sourceYear])).toEqual([
      ['CURRENT_YEAR', 'CENTRAL', '0', null],
      ['CURRENT_YEAR', 'LOCAL', '7', 2026],
      ['CARRYOVER', 'CENTRAL', '0', null],
      ['CARRYOVER', 'LOCAL', '0', null],
      ['OTHER', 'CENTRAL', '0', null],
      ['OTHER', 'LOCAL', '5', null],
    ]);
    expect(fundingCells([])).toHaveLength(6);
    expect(fundingTotals(fundingCells([])).cumulativeVnd).toBe('0');
  });

  it('keeps the next month registered per cell, with its own CTMTQG subset, and adds them as it adds the cumulative cells', () => {
    const cells = fundingCells([
      line('CURRENT_YEAR', 'CENTRAL', '100', { next_month_vnd: '30', next_month_ctmtqg_subset_vnd: '10' }),
      line('CARRYOVER', 'LOCAL', '50', { next_month_vnd: '20' }),
    ]);
    expect(fundingTotals(cells)).toEqual({ cumulativeVnd: '150', ctmtqgVnd: '0', nextMonthVnd: '50', nextMonthCtmtqgVnd: '10' });
  });

  it('AC-ST-DIS-003-2 / FX-DIS-006: a CTMTQG of 120 million against a cell of 100 million is 422 SUBSET_EXCEEDS_PARENT on the CTMTQG field', () => {
    const error = refusal(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', '100000000', { ctmtqg_subset_vnd: '120000000' })]));
    expect([error.status, error.code, error.detail, error.extensions]).toEqual([422, 'SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd', { parent_vnd: '100000000', subset_vnd: '120000000' }]);
    const next = refusal(() => fundingCells([line('CARRYOVER', 'LOCAL', '5', { next_month_vnd: '10', next_month_ctmtqg_subset_vnd: '11' })]));
    expect([next.code, next.detail]).toEqual(['SUBSET_EXCEEDS_PARENT', 'funding_lines[0].next_month_ctmtqg_subset_vnd']);
    expect(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', '100', { ctmtqg_subset_vnd: '100' })])).not.toThrow();
  });

  it('refuses a CTMTQG in the other sources, which have none', () => {
    for (const member of ['ctmtqg_subset_vnd', 'next_month_ctmtqg_subset_vnd'] as const) {
      const error = refusal(() => fundingCells([line('OTHER', 'LOCAL', '10', { next_month_vnd: '10', [member]: '1' })]));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', `funding_lines[0].${member}`]);
    }
  });

  it('refuses money that is not whole dong, and a cell named twice or not at all, naming the field', () => {
    for (const bad of ['-1', '1.5', '1e3', '', ' 10', 'x']) {
      expect(refusal(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', bad)])).detail).toBe('funding_lines[0].cumulative_vnd');
    }
    expect(refusal(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', '1', { ctmtqg_subset_vnd: '-1' })])).detail).toBe('funding_lines[0].ctmtqg_subset_vnd');
    expect(refusal(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', '1', { next_month_vnd: '2.5' })])).detail).toBe('funding_lines[0].next_month_vnd');
    expect(refusal(() => fundingCells([line('CURRENT_YEAR', 'CENTRAL', '1'), line('CURRENT_YEAR', 'CENTRAL', '2')])).detail).toBe('funding_lines[1].bucket');
    expect(refusal(() => fundingCells([line('NOWHERE' as never, 'CENTRAL', '1')])).detail).toBe('funding_lines[0].bucket');
    expect(refusal(() => fundingCells([line('OTHER', 'REGIONAL' as never, '1')])).detail).toBe('funding_lines[0].budget_level');
    for (const year of [1989, 2101, 2026.5]) expect(refusal(() => fundingCells([line('OTHER', 'LOCAL', '1', { source_year: year })])).detail).toBe('funding_lines[0].source_year');
  });

  it('adds very large amounts without losing a dong', () => {
    const cells = fundingCells([line('CURRENT_YEAR', 'CENTRAL', '9007199254740993'), line('CARRYOVER', 'LOCAL', '1')]);
    expect(fundingTotals(cells).cumulativeVnd).toBe('9007199254740994');
  });
});

describe('what a period added (BR-DIS-03)', () => {
  it('is the cumulative less the one before, a fall is negative and kept, and a cell with nothing before it has none', () => {
    expect(deltaOf('100000000', '150000000')).toBe('50000000');
    expect(deltaOf('150000000', '100000000')).toBe('-50000000');
    expect(deltaOf('0', '0')).toBe('0');
    expect(deltaOf(null, '100')).toBeNull();
  });
});

describe('the stage of the project (DIS 3 F1)', () => {
  it('reports from the year the money is allocated to the completion', () => {
    expect([...REPORTABLE_PROJECT_STATUSES]).toEqual(['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED']);
    for (const status of REPORTABLE_PROJECT_STATUSES) expect(() => assertReportableStage(status)).not.toThrow();
  });

  it('refuses every other stage with 422 PROJECT_STAGE_INVALID naming it', () => {
    for (const status of ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED']) {
      const error = refusal(() => assertReportableStage(status));
      expect([error.status, error.code, error.detail, error.extensions]).toEqual([422, 'PROJECT_STAGE_INVALID', 'project_id', { project_status: status }]);
    }
  });
});

describe('the hash of a draft', () => {
  const content = { projectId: PROJECT, periodId: PERIOD, planVersionId: PLAN, reportType: 'WEEKLY' as const, measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null, progress: null, narrative: null, attachments: [] };

  it('is the same for the same entries in any order and in any case of the ids, and changes with any figure', () => {
    const reversed = fundingCells([...FX_DIS_001].reverse());
    expect(draftHash({ ...content, cells: reversed, projectId: PROJECT.toUpperCase() })).toBe(draftHash(content));
    expect(draftHash(content)).toMatch(/^[0-9a-f]{64}$/);
    const changed = fundingCells(FX_DIS_001.map((entry, index) => (index === 5 ? { ...entry, cumulative_vnd: '20000001' } : entry)));
    expect(draftHash({ ...content, cells: changed })).not.toBe(draftHash(content));
    expect(draftHash({ ...content, measurementBasis: 'PERIOD' })).not.toBe(draftHash(content));
    expect(draftHash({ ...content, reportType: 'MONTHLY' })).not.toBe(draftHash(content));
    expect(draftHash({ ...content, negativeDeltaExplanation: 'The Treasury returned a payment.' })).not.toBe(draftHash(content));
    const progress = { constructionVnd: '1', acceptanceVnd: '0', treasurySubmittedVnd: '0', preparingDossierVnd: '0', physicalProgressPct: null };
    expect(draftHash({ ...content, progress })).not.toBe(draftHash(content));
    expect(draftHash({ ...content, progress: { ...progress, physicalProgressPct: '10.00' } })).not.toBe(draftHash({ ...content, progress }));
    const narrative = { resultsText: 'Done', causesText: null, solutionsText: null, proposalsText: null, linkedIssueIds: [] };
    expect(draftHash({ ...content, narrative })).not.toBe(draftHash(content));
    const file = { fileObjectId: PROJECT, fileSha256: 'a'.repeat(64), fileName: 'voucher.pdf' };
    expect(draftHash({ ...content, attachments: [file] })).not.toBe(draftHash(content));
    expect(draftHash({ ...content, attachments: [{ ...file, fileName: 'other.pdf' }] })).not.toBe(draftHash({ ...content, attachments: [file] }));
  });
});

describe('what a period added in all', () => {
  it('AC-ST-DIS-005-5: is the sum of the changes of the cells that have a period before, a fall kept as it is, and none when no cell has one', () => {
    expect(periodDeltaOf(['-30000000', null, '0'])).toBe('-30000000');
    expect(periodDeltaOf(['50000000', '-20000000'])).toBe('30000000');
    expect(periodDeltaOf([null, null])).toBeNull();
    expect(periodDeltaOf([])).toBeNull();
  });
});

describe('the explanation of a fall', () => {
  it('is words of 10 to 2000 characters, trimmed, or none', () => {
    expect(negativeDeltaExplanation(undefined)).toBeNull();
    expect(negativeDeltaExplanation('  The Treasury returned a payment.  ')).toBe('The Treasury returned a payment.');
    for (const bad of ['short', ' '.repeat(20), 'x'.repeat(2001)]) {
      const error = refusal(() => negativeDeltaExplanation(bad));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', 'negative_delta_explanation']);
    }
  });
});
