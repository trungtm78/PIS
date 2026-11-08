import {
  RANKING_DEFAULTS,
  annotationNext,
  assertAnnotationDecider,
  assertComplaintResolver,
  checkAnnotation,
  checkAnnotationDecision,
  checkComplaint,
  checkComplaintResolution,
  complaintDueDay,
  complaintNext,
  measureValue,
  pairOf,
  rankMultiMetric,
  rankingModelOf,
} from '../src/ana-ranking';
import type { ApprovedAnnotation, OpenComplaint, UnitMeasures } from '../src/ana-ranking';

const model = rankingModelOf(RANKING_DEFAULTS as Record<string, unknown>);
const TODAY = '2027-10-20';
const U1 = '00000000-0000-4000-8000-000000000011';

const unit = (code: string, over: Partial<UnitMeasures> = {}): UnitMeasures => ({
  unitId: `id-${code}`,
  code,
  name: `Unit ${code}`,
  projects: 10,
  projectsWithoutData: 0,
  planPmVnd: '2000000000000',
  treasuryVnd: '1000000000000',
  criticalWarnings: 0,
  overdueExplanations: 0,
  evVnd: null,
  bacVnd: null,
  physicalProjects: 0,
  ...over,
});
/** Three units of the large band; the numbers are worked in the comments below. */
const A = unit('A', { planPmVnd: '2000000000000', treasuryVnd: '1200000000000', projects: 10, projectsWithoutData: 1, overdueExplanations: 2, criticalWarnings: 1, evVnd: '450000000000', bacVnd: '1000000000000', physicalProjects: 4 });
const B = unit('B', { planPmVnd: '1500000000000', treasuryVnd: '1200000000000', projects: 5, projectsWithoutData: 0, overdueExplanations: 0, criticalWarnings: 0, evVnd: '700000000000', bacVnd: '1000000000000', physicalProjects: 3 });
const C = unit('C', { planPmVnd: '3000000000000', treasuryVnd: '1500000000000', projects: 20, projectsWithoutData: 10, overdueExplanations: 10, criticalWarnings: 5 });
const by = (result: ReturnType<typeof rankMultiMetric>, code: string) => result.units.find((one) => one.code === code) as ReturnType<typeof rankMultiMetric>['units'][number];

describe('the model of the multi-measure ranking (G3-8)', () => {
  it('reads the default model and refuses one that is not whole', () => {
    expect(model.metrics.map((one) => one.code)).toEqual(['RATE', 'PHYSICAL', 'COMPLETENESS', 'EXPLANATIONS', 'WARNINGS']);
    expect(model.scaleBands.map((one) => one.code)).toEqual(['SMALL', 'MEDIUM', 'LARGE']);
    expect(() => rankingModelOf({ ...RANKING_DEFAULTS, metrics: [] })).toThrow();
    expect(() => rankingModelOf({ ...RANKING_DEFAULTS, metrics: [{ code: 'RATE', direction: 'HIGHER_IS_BETTER', weight: 0 }] })).toThrow();
    expect(() => rankingModelOf({ ...RANKING_DEFAULTS, scale_bands: [{ code: 'A', min_plan_vnd: '5' }] })).toThrow();
    expect(() => rankingModelOf({ ...RANKING_DEFAULTS, scale_bands: [{ code: 'A', min_plan_vnd: '0' }, { code: 'B', min_plan_vnd: '0' }] })).toThrow();
    expect(() => rankingModelOf({ ...RANKING_DEFAULTS, min_metrics: 5, metrics: [{ code: 'RATE', direction: 'HIGHER_IS_BETTER', weight: 1 }, { code: 'PHYSICAL', direction: 'HIGHER_IS_BETTER', weight: 1 }] })).toThrow();
  });
});

describe('the measures of a unit (G3-8)', () => {
  it('golden: the rate is the Treasury over the plan, the physical progress the earned value over the budget, the counts are per project', () => {
    expect(measureValue('RATE', A)).toEqual({ value: 60, nullReason: null });
    expect(measureValue('PHYSICAL', A)).toEqual({ value: 45, nullReason: null });
    expect(measureValue('COMPLETENESS', A)).toEqual({ value: 90, nullReason: null });
    expect(measureValue('EXPLANATIONS', A)).toEqual({ value: 0.2, nullReason: null });
    expect(measureValue('WARNINGS', C)).toEqual({ value: 0.25, nullReason: null });
  });

  it('says why a measure is missing and never turns it into zero', () => {
    expect(measureValue('RATE', unit('X', { treasuryVnd: null }))).toEqual({ value: null, nullReason: 'NO_FIGURE' });
    expect(measureValue('RATE', unit('X', { planPmVnd: '0' }))).toEqual({ value: null, nullReason: 'NO_PLAN' });
    expect(measureValue('PHYSICAL', C)).toEqual({ value: null, nullReason: 'NO_PHYSICAL_PROGRESS' });
    expect(measureValue('COMPLETENESS', unit('X', { projects: 0 }))).toEqual({ value: null, nullReason: 'NO_PROJECTS' });
    expect(measureValue('EXPLANATIONS', unit('X', { overdueExplanations: null }))).toEqual({ value: null, nullReason: 'NOT_READABLE' });
    expect(measureValue('WARNINGS', unit('X', { criticalWarnings: null }))).toEqual({ value: null, nullReason: 'NOT_READABLE' });
  });
});

describe('the ranking over the size bands (G3-8)', () => {
  it('golden: scores among the large units, the weighted composite and the positions', () => {
    // RATE 60, 80, 50 -> 33.33, 100, 0; COMPLETENESS 90, 100, 50 -> 80, 100, 0; EXPLANATIONS 0.2, 0, 0.5 (lower is better) -> 60, 100, 0; WARNINGS 0.1, 0, 0.25 -> 60, 100, 0; PHYSICAL 45, 70, none -> 0, 100, none.
    const result = rankMultiMetric(model, [A, B, C], [], [], TODAY);
    expect(by(result, 'A').metrics.map((one) => one.score)).toEqual([33.33, 0, 80, 60, 60]);
    // A: (40*33.33 + 20*0 + 15*80 + 15*60 + 10*60) / 100 = 40.332.
    expect(by(result, 'A')).toMatchObject({ composite: 40.33, rank: 2, band: 'LARGE', standing: 5 });
    expect(by(result, 'B')).toMatchObject({ composite: 100, rank: 1 });
    // C has no physical progress: it stands on four measures (weight 80), all at the bottom.
    expect(by(result, 'C')).toMatchObject({ composite: 0, rank: 3, standing: 4 });
    expect(by(result, 'C').metrics[1]).toMatchObject({ value: null, score: null, nullReason: 'NO_PHYSICAL_PROGRESS' });
    expect(result.units.map((one) => one.code)).toEqual(['B', 'A', 'C']);
    expect(result.bands).toEqual([{ code: 'SMALL', units: 0, thin: true }, { code: 'MEDIUM', units: 0, thin: true }, { code: 'LARGE', units: 3, thin: false }]);
  });

  it('compares a unit only with units of its size and flags a band that is too small to compare', () => {
    const small = unit('S', { planPmVnd: '50000000000', treasuryVnd: '10000000000', evVnd: '1', bacVnd: '4', physicalProjects: 1 });
    const result = rankMultiMetric(model, [A, B, C, small], [], [], TODAY);
    expect(by(result, 'S')).toMatchObject({ band: 'SMALL', rank: 1, ofBand: 1, bandThin: true });
    expect(by(result, 'B').rank).toBe(1);
    expect(by(result, 'S').composite).toBe(100);
  });

  it('gives no composite and no position when fewer than the minimum number of measures stand', () => {
    const thin = unit('T', { projects: 0, treasuryVnd: '1', planPmVnd: '100' });
    const result = rankMultiMetric(model, [A, B, thin], [], [], TODAY);
    expect(by(result, 'T')).toMatchObject({ composite: null, rank: null, nullReason: 'TOO_FEW_METRICS', standing: 1 });
    // The units of its own (small) band come first, as the bands do; the two large units keep their positions.
    expect([by(result, 'A').rank, by(result, 'B').rank]).toEqual([2, 1]);
  });

  it('breaks a tie by the code of the unit and is the same whatever the order it is given', () => {
    const left = unit('Q', { treasuryVnd: '1000000000000' });
    const right = unit('P', { treasuryVnd: '1000000000000' });
    const one = rankMultiMetric(model, [left, right], [], [], TODAY);
    const two = rankMultiMetric(model, [right, left], [], [], TODAY);
    expect(one.units.map((each) => [each.code, each.rank])).toEqual([['P', 1], ['Q', 2]]);
    expect(two).toEqual(one);
  });

  it('shows a note for a unit held back by something outside its control, and takes the measure out only when the rule says so', () => {
    const note: ApprovedAnnotation = { id: 'n1', unitId: 'id-A', reasonCode: 'LAND_CLEARANCE', metricCodes: ['RATE'], validFrom: '2027-10-01', validTo: '2027-12-31' };
    const shown = rankMultiMetric(model, [A, B, C], [note], [], TODAY);
    expect(by(shown, 'A')).toMatchObject({ composite: 40.33, annotation: { id: 'n1', reasonCode: 'LAND_CLEARANCE', validTo: '2027-12-31' } });
    expect(by(shown, 'A').metrics[0]).toMatchObject({ value: 60, excluded: null });
    const excluding = rankingModelOf({ ...RANKING_DEFAULTS, annotation_effect: 'EXCLUDE_METRIC' });
    const taken = rankMultiMetric(excluding, [A, B, C], [note], [], TODAY);
    // Without RATE: (20*0 + 15*80 + 15*60 + 10*60) / 60 = 45; the figure itself is still shown.
    expect(by(taken, 'A')).toMatchObject({ composite: 45, standing: 4 });
    expect(by(taken, 'A').metrics[0]).toMatchObject({ value: 60, score: null, excluded: 'ANNOTATION' });
    // The line of the band no longer holds the unit that was taken out: B and C are judged on 80 and 50 alone.
    expect(by(taken, 'B').metrics[0]?.score).toBe(100);
    expect(by(taken, 'C').metrics[0]?.score).toBe(0);
    // A note out of its days is no note.
    expect(by(rankMultiMetric(excluding, [A, B, C], [{ ...note, validTo: '2027-10-19' }], [], TODAY), 'A').annotation).toBeNull();
  });

  it('marks the figure a unit disputes until the complaint is answered, without changing the score', () => {
    const open: OpenComplaint = { id: 'c1', unitId: 'id-C', metricCode: 'RATE', status: 'FILED' };
    const result = rankMultiMetric(model, [A, B, C], [], [open, { id: 'c2', unitId: 'id-C', metricCode: 'WARNINGS', status: 'UPHELD' }], TODAY);
    expect(by(result, 'C').metrics.map((one) => one.underComplaint)).toEqual([true, false, false, false, false]);
    expect(by(result, 'C').composite).toBe(0);
  });

  it('shows the rate beside the physical progress: money ahead of work, work ahead of money, both high, both low, or N/A', () => {
    expect(pairOf(80, null, 55, null, model).quadrant).toBe('MONEY_AHEAD_OF_WORK');
    expect(pairOf(40, null, 70, null, model).quadrant).toBe('WORK_AHEAD_OF_MONEY');
    expect(pairOf(80, null, 75, null, model).quadrant).toBe('FAST_BOTH');
    expect(pairOf(30, null, 25, null, model).quadrant).toBe('SLOW_BOTH');
    // Exactly at the gap is not ahead: 60 against 45 is 15.
    expect(pairOf(60, null, 45, null, model).quadrant).toBe('SLOW_BOTH');
    expect(pairOf(60, null, null, 'NO_PHYSICAL_PROGRESS', model)).toEqual({ quadrant: null, ratePct: 60, physicalPct: null, nullReason: 'NO_PHYSICAL_PROGRESS' });
    expect(pairOf(null, 'NO_FIGURE', 50, null, model).nullReason).toBe('NO_FIGURE');
    const result = rankMultiMetric(model, [A, B, C], [], [], TODAY);
    expect([by(result, 'A').pair.quadrant, by(result, 'B').pair.quadrant, by(result, 'C').pair.nullReason]).toEqual(['SLOW_BOTH', 'FAST_BOTH', 'NO_PHYSICAL_PROGRESS']);
  });

  it('an invariant over seeded units: composites are between 0 and 100, positions are 1..n in each band, and the order never depends on the input order', () => {
    let seed = 11;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 40; round += 1) {
      const units = Array.from({ length: 6 }, (_, index) => unit(`U${index}`, { planPmVnd: String((1 + (next() % 3)) * 600_000_000_000), treasuryVnd: String((next() % 100) * 10_000_000_000), projects: 1 + (next() % 9), projectsWithoutData: next() % 2, overdueExplanations: next() % 4, criticalWarnings: next() % 3, evVnd: String((next() % 90) * 1_000_000_000), bacVnd: '100000000000', physicalProjects: 1 }));
      const result = rankMultiMetric(model, units, [], [], TODAY);
      for (const band of result.bands) {
        const ranks = result.units.filter((one) => one.band === band.code && one.rank !== null).map((one) => one.rank as number).sort((x, y) => x - y);
        expect(ranks).toEqual(ranks.map((_, index) => index + 1));
      }
      expect(result.units.every((one) => one.composite === null || (one.composite >= 0 && one.composite <= 100))).toBe(true);
      expect(rankMultiMetric(model, [...units].reverse(), [], [], TODAY)).toEqual(result);
    }
  });
});

describe('annotations and complaints (G3-8)', () => {
  const proposal = { unit_id: U1, reason_code: 'LAND_CLEARANCE', metric_codes: ['RATE', 'PHYSICAL'], evidence: 'The compensation of 12 households is not paid yet.', valid_to: '2027-12-31' };

  it('checks a proposal of an annotation against the closed lists, the evidence and the longest period', () => {
    expect(checkAnnotation(proposal, model, TODAY)).toEqual({ unitId: U1, reasonCode: 'LAND_CLEARANCE', metricCodes: ['RATE', 'PHYSICAL'], evidence: 'The compensation of 12 households is not paid yet.', validFrom: TODAY, validTo: '2027-12-31' });
    for (const bad of [
      { ...proposal, unit_id: 'x' },
      { ...proposal, reason_code: 'BECAUSE' },
      { ...proposal, metric_codes: [] },
      { ...proposal, metric_codes: ['RATE', 'RATE'] },
      { ...proposal, metric_codes: ['NOPE'] },
      { ...proposal, evidence: 'short' },
      { ...proposal, valid_from: '2027-10-01' },
      { ...proposal, valid_to: '2027-10-19' },
      { ...proposal, valid_to: '2028-12-01' },
    ]) expect(() => checkAnnotation(bad, model, TODAY)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('moves an annotation by the allowed decisions only, and keeps maker apart from checker', () => {
    expect(annotationNext('PROPOSED', 'APPROVE')).toBe('APPROVED');
    expect(annotationNext('PROPOSED', 'REJECT')).toBe('REJECTED');
    expect(annotationNext('PROPOSED', 'WITHDRAW')).toBe('WITHDRAWN');
    expect(annotationNext('APPROVED', 'WITHDRAW')).toBe('WITHDRAWN');
    expect(annotationNext('APPROVED', 'APPROVE')).toBeNull();
    expect(annotationNext('REJECTED', 'APPROVE')).toBeNull();
    expect(() => assertAnnotationDecider('APPROVE', 'me', 'me')).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertAnnotationDecider('REJECT', 'me', 'me')).toThrow();
    expect(() => assertAnnotationDecider('WITHDRAW', 'me', 'me')).not.toThrow();
    expect(() => assertAnnotationDecider('APPROVE', 'me', 'you')).not.toThrow();
    expect(checkAnnotationDecision({ decision: 'APPROVE', note: ' Evidence seen. ' })).toEqual({ decision: 'APPROVE', note: 'Evidence seen.' });
    expect(() => checkAnnotationDecision({ decision: 'APPROVE', note: 'no' })).toThrow();
    expect(() => checkAnnotationDecision({ decision: 'MAYBE', note: 'Evidence seen.' })).toThrow();
  });

  it('checks a complaint and moves it through its states', () => {
    const complaint = { unit_id: U1, metric_code: 'RATE', as_of_date: '2027-10-12', claim: 'The Treasury paid 3 billion more on 9 October.', claimed_value: '62.5' };
    expect(checkComplaint(complaint, model, TODAY)).toEqual({ unitId: U1, metricCode: 'RATE', asOfDate: '2027-10-12', claim: 'The Treasury paid 3 billion more on 9 October.', claimedValue: '62.5' });
    expect(checkComplaint({ ...complaint, claimed_value: undefined }, model, TODAY).claimedValue).toBeNull();
    for (const bad of [{ ...complaint, metric_code: 'NOPE' }, { ...complaint, as_of_date: '2027-12-01' }, { ...complaint, claim: 'wrong' }, { ...complaint, claimed_value: 'abc' }, { ...complaint, unit_id: 'u' }]) {
      expect(() => checkComplaint(bad, model, TODAY)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    expect(complaintNext('FILED', 'START_REVIEW')).toBe('UNDER_REVIEW');
    expect(complaintNext('UNDER_REVIEW', 'START_REVIEW')).toBeNull();
    expect(complaintNext('FILED', 'UPHOLD')).toBe('UPHELD');
    expect(complaintNext('UNDER_REVIEW', 'REJECT')).toBe('REJECTED');
    expect(complaintNext('UNDER_REVIEW', 'CORRECT')).toBe('CORRECTED');
    expect(complaintNext('UPHELD', 'REJECT')).toBeNull();
    expect(complaintNext('CORRECTED', 'START_REVIEW')).toBeNull();
    expect(complaintDueDay('2027-10-20', model)).toBe('2027-10-30');
  });

  it('asks for the answer in words, and for a different person to answer', () => {
    expect(checkComplaintResolution({ action: 'START_REVIEW' })).toEqual({ action: 'START_REVIEW', resolution: null });
    expect(checkComplaintResolution({ action: 'REJECT', resolution: ' The figure is the Treasury one. ' })).toEqual({ action: 'REJECT', resolution: 'The figure is the Treasury one.' });
    expect(() => checkComplaintResolution({ action: 'REJECT', resolution: 'no' })).toThrow();
    expect(() => checkComplaintResolution({ action: 'OTHER' })).toThrow();
    expect(() => assertComplaintResolver('me', 'me')).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertComplaintResolver('me', 'you')).not.toThrow();
  });
});
