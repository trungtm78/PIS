import { TREASURY_GAP_THRESHOLD_PCT, WARNING_CODES, percentOf, reviewReport, treasuryWindow } from '../src/dis-review.ts';
import type { ReviewCell, ReviewInput } from '../src/dis-review.ts';

const cell = (extra: Partial<ReviewCell> = {}): ReviewCell => ({ cumulativeVnd: '0', ctmtqgVnd: null, nextMonthVnd: '0', nextMonthCtmtqgVnd: null, allocatedVnd: '0', deltaVnd: null, ...extra });
const PROGRESS = { constructionVnd: '100', acceptanceVnd: '50', treasurySubmittedVnd: '20', preparingDossierVnd: '10', physicalProgressPct: null };

/** A report with nothing to tell: a draft in an open period, the plan in force, six cells, the volumes entered, and a registration for next month. */
const clean = (extra: Partial<ReviewInput> = {}): ReviewInput => ({
  status: 'DRAFT',
  deleted: false,
  periodClosed: false,
  planInForce: true,
  cells: [cell({ cumulativeVnd: '100', allocatedVnd: '100', nextMonthVnd: '10' }), ...Array.from({ length: 5 }, () => cell())],
  negativeDeltaExplanation: null,
  progress: PROGRESS,
  treasuryVnd: null,
  ...extra,
});

describe('the review of a report (BR-DIS-07, AC-ST-DIS-004-2)', () => {
  it('has nothing to tell about a report that is in order, and does not block', () => {
    expect(reviewReport(clean())).toEqual({ errors: [], warnings: [], blocking: false });
  });

  it('tells every error at once, each with the code the server answers, and blocks', () => {
    const review = reviewReport(
      clean({
        status: 'SUBMITTED',
        periodClosed: true,
        planInForce: false,
        progress: null,
        cells: [cell({ cumulativeVnd: '100', ctmtqgVnd: '120', nextMonthVnd: '5', nextMonthCtmtqgVnd: '9', deltaVnd: '-30' }), ...Array.from({ length: 5 }, () => cell())],
      }),
    );
    expect(review.blocking).toBe(true);
    expect(review.warnings.map((finding) => finding.code)).toEqual([]);
    expect(review.errors.map((finding) => [finding.code, finding.field])).toEqual([
      ['REVISION_IMMUTABLE', 'status'],
      ['PERIOD_LOCKED', 'period'],
      ['PLAN_VERSION_NOT_EFFECTIVE', 'plan_version'],
      ['SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd'],
      ['SUBSET_EXCEEDS_PARENT', 'funding_lines[0].next_month_ctmtqg_subset_vnd'],
      ['NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation'],
      ['VALIDATION_FAILED', 'progress'],
    ]);
    expect(review.errors.every((finding) => finding.severity === 'ERROR')).toBe(true);
    expect(review.errors[0]?.values).toEqual({ report_status: 'SUBMITTED' });
    expect(review.errors[3]?.values).toEqual({ parent_vnd: '100', subset_vnd: '120' });
    expect(review.errors[4]?.values).toEqual({ parent_vnd: '5', subset_vnd: '9' });
  });

  it('counts a deleted draft as one that cannot be edited, and a fall that is explained as no error', () => {
    expect(reviewReport(clean({ deleted: true })).errors.map((finding) => finding.code)).toEqual(['REVISION_IMMUTABLE']);
    const fall = clean({ cells: [cell({ cumulativeVnd: '100', allocatedVnd: '100', nextMonthVnd: '10', deltaVnd: '-30' }), ...Array.from({ length: 5 }, () => cell())] });
    expect(reviewReport(fall).errors.map((finding) => finding.code)).toEqual(['NEGATIVE_DELTA_EXPLANATION_REQUIRED']);
    expect(reviewReport({ ...fall, negativeDeltaExplanation: 'The Treasury returned a payment.' }).blocking).toBe(false);
  });

  it('does not take a subset that is equal to its parent or a delta of zero for an error', () => {
    const review = reviewReport(clean({ cells: [cell({ cumulativeVnd: '100', ctmtqgVnd: '100', allocatedVnd: '100', nextMonthVnd: '10', nextMonthCtmtqgVnd: '10', deltaVnd: '0' }), ...Array.from({ length: 5 }, () => cell())] }));
    expect(review.errors).toEqual([]);
  });

  it('warns, without blocking, of a volume above the capital allocated (203.8%)', () => {
    const review = reviewReport(clean({ cells: [cell({ cumulativeVnd: '100', allocatedVnd: '1000000000', nextMonthVnd: '10' }), ...Array.from({ length: 5 }, () => cell())], progress: { ...PROGRESS, constructionVnd: '2038000000' } }));
    expect(review.blocking).toBe(false);
    expect(review.warnings).toEqual([
      { code: WARNING_CODES.volumeExceedsAllocation, severity: 'WARNING', field: 'progress.construction_vnd', values: { construction_vnd: '2038000000', allocated_vnd: '1000000000', ratio_pct: '203.8' } },
    ]);
  });

  it('warns of a volume when nothing was allocated, with no ratio, and not of a volume equal to the capital', () => {
    const none = reviewReport(clean({ cells: Array.from({ length: 6 }, () => cell({ nextMonthVnd: '1' })), progress: { ...PROGRESS, constructionVnd: '1' } }));
    expect(none.warnings).toEqual([{ code: WARNING_CODES.volumeExceedsAllocation, severity: 'WARNING', field: 'progress.construction_vnd', values: { construction_vnd: '1', allocated_vnd: '0', ratio_pct: null } }]);
    expect(reviewReport(clean({ progress: { ...PROGRESS, constructionVnd: '100' } })).warnings).toEqual([]);
  });

  it('warns of a gap with the Treasury above 5%, either way, and not of one at 5% or of no Treasury data', () => {
    const reported = (cumulative: string): ReviewInput => clean({ cells: [cell({ cumulativeVnd: cumulative, allocatedVnd: cumulative, nextMonthVnd: '1' }), ...Array.from({ length: 5 }, () => cell())], progress: { ...PROGRESS, constructionVnd: '1' } });
    expect(TREASURY_GAP_THRESHOLD_PCT).toBe(5n);
    expect(reviewReport({ ...reported('1000'), treasuryVnd: '900' }).warnings).toEqual([
      { code: WARNING_CODES.treasuryGap, severity: 'WARNING', field: 'funding_lines', values: { reported_vnd: '1000', treasury_vnd: '900', gap_pct: '11.1' } },
    ]);
    expect(reviewReport({ ...reported('800'), treasuryVnd: '900' }).warnings.map((finding) => finding.values.gap_pct)).toEqual(['11.1']);
    expect(reviewReport({ ...reported('1050'), treasuryVnd: '1000' }).warnings).toEqual([]);
    expect(reviewReport({ ...reported('1051'), treasuryVnd: '1000' }).warnings.map((finding) => finding.code)).toEqual([WARNING_CODES.treasuryGap]);
    expect(reviewReport({ ...reported('1000'), treasuryVnd: null }).warnings).toEqual([]);
    expect(reviewReport({ ...reported('1000'), treasuryVnd: '1000' }).warnings).toEqual([]);
    // Nothing paid and something reported is a gap with no percent; nothing on either side is none.
    expect(reviewReport({ ...reported('1000'), treasuryVnd: '0' }).warnings.map((finding) => finding.values.gap_pct)).toEqual([null]);
    expect(reviewReport({ ...reported('0'), treasuryVnd: '0' }).warnings.filter((finding) => finding.code === WARNING_CODES.treasuryGap)).toEqual([]);
  });

  it('warns of no registration for next month while capital is left, and not when it is registered or nothing is left', () => {
    const base = clean({ cells: [cell({ cumulativeVnd: '60', allocatedVnd: '100' }), ...Array.from({ length: 5 }, () => cell())], progress: { ...PROGRESS, constructionVnd: '1' } });
    expect(reviewReport(base).warnings).toEqual([{ code: WARNING_CODES.nextMonthEmptyWithCapitalLeft, severity: 'WARNING', field: 'funding_lines', values: { remaining_vnd: '40' } }]);
    expect(reviewReport({ ...base, cells: [cell({ cumulativeVnd: '60', allocatedVnd: '100', nextMonthVnd: '40' }), ...Array.from({ length: 5 }, () => cell())] }).warnings).toEqual([]);
    expect(reviewReport({ ...base, cells: [cell({ cumulativeVnd: '100', allocatedVnd: '100' }), ...Array.from({ length: 5 }, () => cell())] }).warnings).toEqual([]);
  });

  it('orders the warnings as the catalogue does and lets a report with warnings go', () => {
    const all = reviewReport(clean({ cells: [cell({ cumulativeVnd: '60', allocatedVnd: '100' }), ...Array.from({ length: 5 }, () => cell())], progress: { ...PROGRESS, constructionVnd: '500' }, treasuryVnd: '10' }));
    expect(all.warnings.map((finding) => finding.code)).toEqual([WARNING_CODES.volumeExceedsAllocation, WARNING_CODES.treasuryGap, WARNING_CODES.nextMonthEmptyWithCapitalLeft]);
    expect(all.blocking).toBe(false);
  });
});

describe('the percent and the window of the Treasury', () => {
  it('writes a percent with one decimal rounded half up, and none for a denominator of zero', () => {
    expect(percentOf(1n, 3n)).toBe('33.3');
    expect(percentOf(2n, 3n)).toBe('66.7');
    expect(percentOf(1n, 8n)).toBe('12.5');
    expect(percentOf(1n, 2000n)).toBe('0.1');
    expect(percentOf(1n, 4000n)).toBe('0.0');
    expect(percentOf(5n, 1n)).toBe('500.0');
    expect(percentOf(1n, 0n)).toBeNull();
  });

  it('counts the payments of the period, of the year up to the period, or of all time up to it, as the basis says', () => {
    const period = { startDate: '2027-01-04', endDate: '2027-01-10', fiscalYear: 2027 };
    expect(treasuryWindow('PERIOD', period)).toEqual({ from: '2027-01-04', to: '2027-01-10' });
    expect(treasuryWindow('YTD', period)).toEqual({ from: '2027-01-01', to: '2027-01-10' });
    expect(treasuryWindow('PROJECT_TO_DATE', period)).toEqual({ from: null, to: '2027-01-10' });
  });
});
