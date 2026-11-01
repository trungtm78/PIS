import {
  MATURITY_PILLARS,
  assertRubricCode,
  checkMilestone,
  assertTargetAbove,
  checkEvidenceRecord,
  computeScore,
  criterionOf,
  dayAfter,
  effectiveCriterion,
  isDay,
  parseRubricDraft,
  pillarReaches,
  rubricOf,
} from '../src/dgv-maturity.ts';
import type { CriterionRow, EvidenceRecordInput, Rubric } from '../src/dgv-maturity.ts';

const LEVELS = { 1: 'ad hoc', 2: 'repeatable', 3: 'defined', 4: 'managed', 5: 'optimised' };
const criterion = (code: string, weight = 10, extra: Record<string, unknown> = {}) => ({ code, name: `Criterion ${code}`, weight, levels: LEVELS, ...extra });
const pillarJson = (code: string, index: number, weight = 12.5, extra: Record<string, unknown> = {}) => ({
  code,
  name: `Pillar ${code}`,
  weight,
  criteria: [criterion(`C${index}-1`), criterion(`C${index}-2`), criterion(`C${index}-3`)],
  ...extra,
});
const pillarsJson = (mutate: (pillars: Array<Record<string, unknown>>) => void = () => undefined) => {
  const pillars = MATURITY_PILLARS.map((code, index) => pillarJson(code, index + 1));
  mutate(pillars);
  return { pillars };
};
const draft = (pillars: unknown = pillarsJson(), over: Partial<{ frameworkRefs: unknown; minCoveragePct: string; evidenceTtlDays: number }> = {}) =>
  parseRubricDraft({ frameworkRefs: { DCAM: ['1.1', '2.3'], DMM: 'DM-4' }, pillarsJson: pillars, minCoveragePct: '70', evidenceTtlDays: 365, ...over });
const bad = (run: () => unknown, code: string, detail?: string) => {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code, status: 422, ...(detail === undefined ? {} : { detail }) });
    return;
  }
  throw new Error(`accepted: ${code} ${detail ?? ''}`);
};
const RUBRIC: Rubric = draft().rubric;

describe('the rubric of maturity (ST-DGV-008, DGV 3.1 F8, UAT-AC493)', () => {
  it('reads eight pillars with three to five criteria that have a weight and a description for each level', () => {
    const read = draft();
    expect(read.rubric.pillars.map((pillar) => pillar.code)).toEqual([...MATURITY_PILLARS]);
    expect(read.rubric.pillars.every((pillar) => pillar.weight === 1250 && pillar.criteria.length === 3)).toBe(true);
    expect(read.rubric.pillars[0]?.criteria[0]).toMatchObject({ code: 'C1-1', weight: 1000, levels: { 1: 'ad hoc', 5: 'optimised' }, refs: [] });
    expect(read.frameworkRefs).toEqual({ DCAM: ['1.1', '2.3'], DMM: ['DM-4'] });
    expect(read.minCoveragePct).toBe('70.00');
    expect(read.evidenceTtlDays).toBe(365);
  });

  it('refuses weights of the pillars that do not add up to 100 (UAT-AC493: 90), naming where', () => {
    bad(() => draft(pillarsJson((pillars) => ((pillars[0] as { weight: number }).weight = 2.5))), 'RUBRIC_WEIGHTS_INVALID', 'pillars_json.pillars');
    bad(() => draft(pillarsJson((pillars) => ((pillars[0] as { weight: number }).weight = 22.5))), 'RUBRIC_WEIGHTS_INVALID', 'pillars_json.pillars');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['over a hundred', 101],
    ['three decimals', 12.505],
    ['not a number', '12.5'],
  ])('refuses a weight that is %s', (_name, weight) => {
    bad(() => draft(pillarsJson((pillars) => ((pillars[0] as { weight: unknown }).weight = weight))), 'RUBRIC_WEIGHTS_INVALID', 'pillars_json.pillars[0].weight');
    bad(
      () => draft(pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ weight: unknown }> }).criteria[1]!.weight = weight))),
      'RUBRIC_WEIGHTS_INVALID',
      'pillars_json.pillars[0].criteria[1].weight',
    );
  });

  it('adds up the weights exactly, however they are written', () => {
    const odd = pillarsJson((pillars) => {
      pillars.forEach((pillar, index) => (pillar.weight = index === 0 ? 12.71 : 12.47));
    });
    // 12.71 + 7 x 12.47 = 100 exactly in hundredths (in floating point it is not)
    expect(draft(odd).rubric.pillars.reduce((sum, pillar) => sum + pillar.weight, 0)).toBe(10_000);
  });

  it.each([
    ['no pillars object', { nope: [] }, 'pillars_json'],
    ['seven pillars', { pillars: pillarsJson().pillars.slice(1) }, 'pillars_json.pillars'],
    ['a pillar that is not one', pillarsJson((pillars) => ((pillars[0] as { code: string }).code = 'MONEY')), 'pillars_json.pillars[0].code'],
    ['a pillar twice', pillarsJson((pillars) => ((pillars[1] as { code: string }).code = 'GOVERNANCE')), 'pillars_json.pillars[1].code'],
    ['a pillar that is not an object', pillarsJson((pillars) => (pillars[2] = 3 as never)), 'pillars_json.pillars[2]'],
    ['two criteria', pillarsJson((pillars) => ((pillars[0] as { criteria: unknown[] }).criteria.length = 2)), 'pillars_json.pillars[0].criteria'],
    ['six criteria', pillarsJson((pillars) => ((pillars[0] as { criteria: unknown[] }).criteria = [1, 2, 3, 4, 5, 6].map((n) => criterion(`X${n}`)))), 'pillars_json.pillars[0].criteria'],
    ['a criterion code with a bad shape', pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ code: string }> }).criteria[0]!.code = 'low')), 'pillars_json.pillars[0].criteria[0].code'],
    ['a criterion code twice', pillarsJson((pillars) => ((pillars[1] as { criteria: Array<{ code: string }> }).criteria[0]!.code = 'C1-1')), 'pillars_json.pillars[1].criteria[0].code'],
    ['a criterion that is not an object', pillarsJson((pillars) => ((pillars[0] as { criteria: unknown[] }).criteria[0] = 'x')), 'pillars_json.pillars[0].criteria[0]'],
    ['levels that are not an object', pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ levels: unknown }> }).criteria[0]!.levels = [])), 'pillars_json.pillars[0].criteria[0].levels'],
    [
      'a level without a description',
      pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ levels: Record<string, unknown> }> }).criteria[0]!.levels = { ...LEVELS, 3: ' ' })),
      'pillars_json.pillars[0].criteria[0].levels.3',
    ],
    ['a name that is empty', pillarsJson((pillars) => ((pillars[0] as { name: string }).name = '')), 'pillars_json.pillars[0].name'],
    ['refs that are not a list', pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ refs: unknown }> }).criteria[0]!.refs = 'x')), 'pillars_json.pillars[0].criteria[0].refs'],
    ['a ref that is empty', pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ refs: unknown }> }).criteria[0]!.refs = [''])), 'pillars_json.pillars[0].criteria[0].refs[0]'],
  ])('refuses %s', (_name, json, path) => {
    bad(() => draft(json), 'VALIDATION_FAILED', path);
  });

  it('keeps the references of a criterion to the frameworks', () => {
    const withRefs = pillarsJson((pillars) => ((pillars[0] as { criteria: Array<{ refs: unknown }> }).criteria[0]!.refs = ['DCAM 1.1', 'DMM DM-2']));
    expect(draft(withRefs).rubric.pillars[0]?.criteria[0]?.refs).toEqual(['DCAM 1.1', 'DMM DM-2']);
  });

  it.each([
    ['not an object', 'DCAM'],
    ['a name with nothing in it', { DCAM: [] }],
    ['a name with a place that is empty', { DCAM: [''] }],
    ['a list that is too long', { DCAM: Array.from({ length: 101 }, (_, n) => `r${n}`) }],
    ['too many frameworks', Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`F${n}`, ['x']]))],
  ])('refuses framework references that are %s', (_name, refs) => {
    bad(() => draft(pillarsJson(), { frameworkRefs: refs }), 'VALIDATION_FAILED');
  });

  it.each([
    ['0', 'min_coverage_pct'],
    ['0.5', 'min_coverage_pct'],
    ['100.01', 'min_coverage_pct'],
    ['1000', 'min_coverage_pct'],
    ['seventy', 'min_coverage_pct'],
    ['70.123', 'min_coverage_pct'],
    ['-5', 'min_coverage_pct'],
  ])('refuses the share %s of criteria that must be assessed', (value, path) => {
    bad(() => draft(pillarsJson(), { minCoveragePct: value }), 'VALIDATION_FAILED', path);
  });

  it.each([
    ['1', '1.00'],
    ['70', '70.00'],
    ['70.5', '70.50'],
    ['100', '100.00'],
    ['99.99', '99.99'],
  ])('writes the share %s as %s', (value, written) => {
    expect(draft(pillarsJson(), { minCoveragePct: value }).minCoveragePct).toBe(written);
  });

  it.each([0, -1, 3651, 1.5])('refuses %s days of life for evidence', (days) => {
    bad(() => draft(pillarsJson(), { evidenceTtlDays: days }), 'VALIDATION_FAILED', 'evidence_ttl_days');
  });

  it('finds a criterion of the rubric by the pillar it is in, and reads a stored rubric back', () => {
    expect(criterionOf(RUBRIC, 'QUALITY', 'C3-2')?.criterion.code).toBe('C3-2');
    expect(criterionOf(RUBRIC, 'QUALITY', 'C1-1')).toBeUndefined();
    expect(criterionOf(RUBRIC, 'NOPE', 'C3-2')).toBeUndefined();
    expect(rubricOf({ pillars: [] }).pillars).toEqual([]);
    bad(() => rubricOf({}), 'VALIDATION_FAILED', 'pillars_json');
    bad(() => rubricOf([]), 'VALIDATION_FAILED', 'pillars_json');
  });

  it('knows a day when it is one, and adds days to it', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-2-3')).toBe(false);
    expect(dayAfter('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('what an assessor records for a criterion (UAT-AC492)', () => {
  const TODAY = '2026-11-01';
  const record = (over: Partial<EvidenceRecordInput> = {}): EvidenceRecordInput => ({
    pillarCode: 'QUALITY',
    criterionCode: 'C3-2',
    state: 'ASSESSED',
    level: 4,
    evidenceRefs: [{ kind: 'TEST', ref: 'run-2026-10-30' }],
    sampleSize: undefined,
    confidence: undefined,
    naReason: undefined,
    expiresOn: undefined,
    ...over,
  });
  const check = (over: Partial<EvidenceRecordInput> = {}) => checkEvidenceRecord(record(over), RUBRIC, 365, TODAY);

  it('takes a level with evidence, and gives the evidence the days the rubric allows when no day is given', () => {
    expect(check({ sampleSize: 30, confidence: 'HIGH' })).toEqual({
      state: 'ASSESSED',
      level: 4,
      evidenceRefs: [{ kind: 'TEST', ref: 'run-2026-10-30' }],
      sampleSize: 30,
      confidence: 'HIGH',
      naReason: null,
      expiresOn: '2027-11-01',
    });
    expect(check({ expiresOn: '2027-01-31' }).expiresOn).toBe('2027-01-31');
    expect(check({ expiresOn: TODAY }).expiresOn).toBe(TODAY);
    expect(check({ evidenceRefs: [{ kind: 'LOG', ref: 'l', note: 'a note' }] }).evidenceRefs).toEqual([{ kind: 'LOG', ref: 'l', note: 'a note' }]);
  });

  it('refuses ASSESSED without evidence (422 EVIDENCE_REQUIRED)', () => {
    bad(() => check({ evidenceRefs: [] }), 'EVIDENCE_REQUIRED', 'evidence_refs');
  });

  it('refuses evidence that has run out (422 EVIDENCE_EXPIRED) and a day later than the rubric allows', () => {
    bad(() => check({ expiresOn: '2026-06-30' }), 'EVIDENCE_EXPIRED', 'evidence_expires_on');
    bad(() => check({ expiresOn: '2027-11-02' }), 'VALIDATION_FAILED', 'evidence_expires_on');
    bad(() => check({ expiresOn: '2027-02-30' }), 'VALIDATION_FAILED', 'evidence_expires_on');
  });

  it.each([0, 6, -1, 2.5, Number.NaN])('refuses the level %s (422 LEVEL_OUT_OF_RANGE)', (level) => {
    bad(() => check({ level }), 'LEVEL_OUT_OF_RANGE', 'level');
  });

  it('refuses ASSESSED without a level and a reason for not applying', () => {
    bad(() => check({ level: undefined }), 'VALIDATION_FAILED', 'level');
    bad(() => check({ naReason: 'does not apply here' }), 'VALIDATION_FAILED', 'na_reason');
  });

  it.each([
    ['a criterion that is not in the rubric', { criterionCode: 'NOPE' }, 'criterion_code'],
    ['a criterion in another pillar', { pillarCode: 'GOVERNANCE' }, 'criterion_code'],
    ['evidence that is not an object', { evidenceRefs: ['x'] }, 'evidence_refs[0].kind'],
    ['evidence of a kind that is none', { evidenceRefs: [{ kind: 'HEARSAY', ref: 'x' }] }, 'evidence_refs[0].kind'],
    ['evidence that refers to nothing', { evidenceRefs: [{ kind: 'LOG', ref: ' ' }] }, 'evidence_refs[0].ref'],
    ['a note that is empty', { evidenceRefs: [{ kind: 'LOG', ref: 'x', note: '' }] }, 'evidence_refs[0].note'],
    ['too much evidence', { evidenceRefs: Array.from({ length: 501 }, () => ({ kind: 'LOG', ref: 'x' })) }, 'evidence_refs'],
    ['a sample of none', { sampleSize: 0 }, 'sample_size'],
    ['a sample that is not whole', { sampleSize: 1.5 }, 'sample_size'],
    ['a confidence that is none', { confidence: 'CERTAIN' }, 'confidence'],
    ['a state that is none', { state: 'PROBABLY' as never }, 'assessment_state'],
  ])('refuses %s', (_name, over, path) => {
    bad(() => check(over as Partial<EvidenceRecordInput>), 'VALIDATION_FAILED', path);
  });

  it('records NOT_APPLICABLE with its reason and nothing that would make it count as assessed', () => {
    expect(check({ state: 'NOT_APPLICABLE', level: undefined, evidenceRefs: [], naReason: '  the platform has no such data  ' })).toEqual({
      state: 'NOT_APPLICABLE',
      level: null,
      evidenceRefs: [],
      sampleSize: null,
      confidence: null,
      naReason: 'the platform has no such data',
      expiresOn: null,
    });
    const na = (over: Partial<EvidenceRecordInput>) => check({ state: 'NOT_APPLICABLE', level: undefined, evidenceRefs: [], naReason: 'the platform has no such data', ...over });
    bad(() => na({ naReason: undefined }), 'VALIDATION_FAILED', 'na_reason');
    bad(() => na({ naReason: 'short' }), 'VALIDATION_FAILED', 'na_reason');
    bad(() => na({ level: 3 }), 'VALIDATION_FAILED', 'level');
    bad(() => na({ expiresOn: '2027-01-01' }), 'VALIDATION_FAILED', 'evidence_expires_on');
  });

  it('records NOT_ASSESSED as nothing at all, and refuses a level there (422, as the database says)', () => {
    expect(check({ state: 'NOT_ASSESSED', level: undefined, evidenceRefs: [] })).toEqual({
      state: 'NOT_ASSESSED',
      level: null,
      evidenceRefs: [],
      sampleSize: null,
      confidence: null,
      naReason: null,
      expiresOn: null,
    });
    bad(() => check({ state: 'NOT_ASSESSED', level: 1, evidenceRefs: [] }), 'VALIDATION_FAILED', 'level');
    bad(() => check({ state: 'NOT_ASSESSED', level: undefined }), 'VALIDATION_FAILED', 'assessment_state');
  });
});

describe('the score of BR-DGV-08 (UAT-AC53)', () => {
  const ASOF = '2026-11-01';
  const all = RUBRIC.pillars.flatMap((pillar) => pillar.criteria.map((c) => ({ pillar: pillar.code, code: c.code })));
  const row = (index: number, over: Partial<CriterionRow> = {}): CriterionRow => {
    const target = all[index] as { pillar: string; code: string };
    return { pillarCode: target.pillar, criterionCode: target.code, state: 'ASSESSED', level: 3, reviewStatus: 'ACCEPTED', expiresOn: '2027-01-01', ...over };
  };
  const notAssessed = (index: number): CriterionRow => row(index, { state: 'NOT_ASSESSED', level: null, reviewStatus: 'PENDING', expiresOn: null });
  const notApplicable = (index: number): CriterionRow => row(index, { state: 'NOT_APPLICABLE', level: null, expiresOn: null });
  /** 14 assessed with levels 2 to 4, 8 not assessed and 2 not applicable: 24 criteria. */
  const world = (assessedCount: number, levelOf: (index: number) => number = (index) => 2 + (index % 3)): CriterionRow[] =>
    all.map((_, index) => (index >= 22 ? notApplicable(index) : index < assessedCount ? row(index, { level: levelOf(index) }) : notAssessed(index)));

  it('gives no total when less than the share of criteria asked for is assessed: 14 of 22 is 63.64%', () => {
    const score = computeScore(RUBRIC, '70.00', world(14), ASOF);
    expect(score).toMatchObject({ coveragePercent: '63.64', overallState: 'NOT_COMPUTED', overallLevel: null, assessedCount: 14, notAssessedCount: 8, notApplicableCount: 2 });
  });

  it('computes the total over the assessed criteria alone once 17 of 22 (77.27%) are assessed', () => {
    const score = computeScore(RUBRIC, '70.00', world(17), ASOF);
    expect(score).toMatchObject({ coveragePercent: '77.27', overallState: 'COMPUTED', assessedCount: 17, notAssessedCount: 5, notApplicableCount: 2 });
    expect(score.overallLevel).toMatch(/^\d\.\d{2}$/);
    // The criteria that are not assessed are in no average: nothing of them is a 0 or a 1.
    expect(Number(score.overallLevel)).toBeGreaterThanOrEqual(2);
    expect(Number(score.overallLevel)).toBeLessThanOrEqual(4);
  });

  it('shows a pillar with no assessed criterion as NOT_ASSESSED, with no level - not 0 and not 1', () => {
    const score = computeScore(RUBRIC, '70.00', world(17), ASOF);
    const empty = score.pillars.filter((pillar) => pillar.state === 'NOT_ASSESSED');
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((pillar) => pillar.level === null && pillar.assessedCount === 0)).toBe(true);
  });

  it('weights the criteria of a pillar and the pillars of the total', () => {
    const weighted = draft(
      pillarsJson((pillars) => {
        pillars.forEach((pillar, index) => {
          pillar.weight = index === 0 ? 40 : index === 1 ? 20 : index === 2 ? 10 : index === 3 ? 10 : index === 4 ? 10 : index === 5 ? 5 : index === 6 ? 3 : 2;
        });
        (pillars[0] as { criteria: Array<{ weight: number }> }).criteria[0]!.weight = 30;
        (pillars[0] as { criteria: Array<{ weight: number }> }).criteria[1]!.weight = 10;
        (pillars[0] as { criteria: Array<{ weight: number }> }).criteria[2]!.weight = 10;
      }),
    ).rubric;
    const rows: CriterionRow[] = [
      { pillarCode: 'GOVERNANCE', criterionCode: 'C1-1', state: 'ASSESSED', level: 5, reviewStatus: 'ACCEPTED', expiresOn: '2027-01-01' },
      { pillarCode: 'GOVERNANCE', criterionCode: 'C1-2', state: 'ASSESSED', level: 1, reviewStatus: 'ACCEPTED', expiresOn: '2027-01-01' },
      { pillarCode: 'METADATA', criterionCode: 'C2-1', state: 'ASSESSED', level: 2, reviewStatus: 'ACCEPTED', expiresOn: '2027-01-01' },
    ];
    const score = computeScore(weighted, '1.00', rows, ASOF);
    // GOVERNANCE (5 x 30 + 1 x 10) / 40 = 4.00, over its assessed criteria only; METADATA 2.00; total (40 x 4 + 20 x 2) / 60 = 3.33
    expect(score.pillars[0]).toMatchObject({ code: 'GOVERNANCE', level: '4.00', assessedCount: 2, notAssessedCount: 1 });
    expect(score.pillars[1]?.level).toBe('2.00');
    expect(score.overallLevel).toBe('3.33');
  });

  it('rounds half up to two decimals', () => {
    const thirds = [row(0, { level: 4 }), row(1, { level: 3 }), row(2, { level: 3 })];
    expect(computeScore(RUBRIC, '1.00', thirds, ASOF).pillars[0]?.level).toBe('3.33');
    expect(computeScore(RUBRIC, '1.00', [row(0, { level: 1 }), row(1, { level: 2 }), row(2, { level: 2 })], ASOF).pillars[0]?.level).toBe('1.67');
    expect(computeScore(RUBRIC, '1.00', [row(0, { level: 2 }), row(1, { level: 3 }), notAssessed(2)], ASOF).pillars[0]?.level).toBe('2.50');
    // weights 1, 2 and 5 with levels 3, 1 and 2: 15 / 8 = 1.875, which is 1.88 rounded half up
    const eighths = draft(
      pillarsJson((pillars) => {
        const criteria = (pillars[0] as { criteria: Array<{ weight: number }> }).criteria;
        criteria[0]!.weight = 1;
        criteria[1]!.weight = 2;
        criteria[2]!.weight = 5;
      }),
    ).rubric;
    expect(computeScore(eighths, '1.00', [row(0, { level: 3 }), row(1, { level: 1 }), row(2, { level: 2 })], ASOF).pillars[0]?.level).toBe('1.88');
  });

  it('asks for the share exactly: 17 of 24 criteria is 70.83%, enough for 70.83 and not for 70.84', () => {
    const rows = all.map((_, index) => (index < 17 ? row(index) : notAssessed(index)));
    expect(computeScore(RUBRIC, '70.83', rows, ASOF)).toMatchObject({ coveragePercent: '70.83', overallState: 'COMPUTED' });
    expect(computeScore(RUBRIC, '70.84', rows, ASOF)).toMatchObject({ coveragePercent: '70.83', overallState: 'NOT_COMPUTED', overallLevel: null });
  });

  it('counts a criterion as assessed only when a reviewer accepted it and its evidence has not run out', () => {
    const base = row(0);
    expect(effectiveCriterion(base, ASOF)).toEqual({ state: 'ASSESSED', level: 3 });
    expect(effectiveCriterion({ ...base, reviewStatus: 'PENDING' }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion({ ...base, reviewStatus: 'REJECTED' }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion({ ...base, reviewStatus: 'EXPIRED' }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion({ ...base, expiresOn: '2026-10-31' }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion({ ...base, expiresOn: ASOF }, ASOF)).toEqual({ state: 'ASSESSED', level: 3 });
    expect(effectiveCriterion({ ...base, expiresOn: null }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion({ ...base, level: null }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
    expect(effectiveCriterion(notApplicable(0), ASOF)).toEqual({ state: 'NOT_APPLICABLE', level: null });
    expect(effectiveCriterion({ ...notApplicable(0), reviewStatus: 'PENDING' }, ASOF)).toEqual({ state: 'NOT_ASSESSED', level: null });
  });

  it('does not let evidence that expired after the assessment was published change its score', () => {
    const rows = world(17);
    const before = computeScore(RUBRIC, '70.00', rows, '2026-12-31');
    const after = computeScore(RUBRIC, '70.00', rows, '2027-02-01');
    expect(before.overallState).toBe('COMPUTED');
    expect(after).toMatchObject({ overallState: 'NOT_COMPUTED', overallLevel: null, assessedCount: 0 });
  });

  it('has no total, and a coverage of 0, when nothing is asked of any criterion', () => {
    const none = computeScore(
      RUBRIC,
      '70.00',
      all.map((_, index) => notApplicable(index)),
      ASOF,
    );
    expect(none).toMatchObject({ coveragePercent: '0.00', overallState: 'NOT_COMPUTED', overallLevel: null, notApplicableCount: 24 });
    expect(computeScore(RUBRIC, '70.00', [], ASOF)).toMatchObject({ coveragePercent: '0.00', overallState: 'NOT_COMPUTED', notAssessedCount: 24 });
  });

  it('knows whether a pillar reaches a level exactly, and that a target must lie above where it stands', () => {
    const rows = [row(6, { level: 3 }), row(7, { level: 3 }), row(8, { level: 2 })];
    const pillar = computeScore(RUBRIC, '1.00', rows, ASOF).pillars[2] as ReturnType<typeof computeScore>['pillars'][number];
    // (3 + 3 + 2) / 3 = 2.67
    expect(pillar.level).toBe('2.67');
    expect(pillarReaches(pillar, 2)).toBe(true);
    expect(pillarReaches(pillar, 3)).toBe(false);
    const almost = { state: 'ASSESSED' as const, levelNumerator: 2996, levelDenominator: 1000 };
    expect(pillarReaches(almost, 3)).toBe(false);
    expect(pillarReaches({ state: 'NOT_ASSESSED', levelNumerator: 0, levelDenominator: 0 }, 1)).toBe(false);
    expect(() => assertTargetAbove(pillar, 3)).not.toThrow();
    expect(() => assertTargetAbove(undefined, 1)).not.toThrow();
    expect(() => assertTargetAbove({ state: 'NOT_ASSESSED', levelNumerator: 0, levelDenominator: 0 }, 1)).not.toThrow();
    bad(() => assertTargetAbove(pillar, 2), 'TARGET_BELOW_CURRENT', 'target_level');
    bad(() => assertTargetAbove(pillar, 0), 'LEVEL_OUT_OF_RANGE', 'target_level');
    bad(() => assertTargetAbove(pillar, 6), 'LEVEL_OUT_OF_RANGE', 'target_level');
    bad(() => assertTargetAbove(pillar, 2.5), 'LEVEL_OUT_OF_RANGE', 'target_level');
  });
});

describe('the code of a rubric and what a milestone asks for (UAT-AC493, UAT-AC494)', () => {
  it('takes a code of capitals, digits, hyphen and underscore, and trims it', () => {
    expect(assertRubricCode(' RB-1 ')).toBe('RB-1');
    for (const code of ['', 'r', 'rb-1', '1RB', 'RB 1', 'R'.repeat(61)]) bad(() => assertRubricCode(code), 'VALIDATION_FAILED', 'rubric_code');
  });

  const milestone = (over: Partial<Parameters<typeof checkMilestone>[0]> = {}) => ({
    pillarCode: 'QUALITY',
    dueOn: '2026-12-31',
    exitCriteria: '  the quality score is published  ',
    evidenceRequired: ['a scorecard'],
    ...over,
  });

  it('takes a pillar, a last day that is not past, the criteria to leave by and the evidence needed', () => {
    expect(checkMilestone(milestone(), '2026-11-01')).toEqual({ exitCriteria: 'the quality score is published', evidenceRequired: ['a scorecard'] });
    expect(checkMilestone(milestone({ dueOn: '2026-11-01', evidenceRequired: [] }), '2026-11-01').evidenceRequired).toEqual([]);
  });

  it.each([
    ['a pillar that is none', { pillarCode: 'MONEY' }, 'pillar_code'],
    ['a last day in the past', { dueOn: '2026-10-31' }, 'due_on'],
    ['a last day that is none', { dueOn: '2026-02-30' }, 'due_on'],
    ['criteria that are too short', { exitCriteria: 'done' }, 'exit_criteria'],
    ['criteria that are too long', { exitCriteria: 'x'.repeat(2001) }, 'exit_criteria'],
    ['criteria with a NUL', { exitCriteria: 'the quality   score' }, 'exit_criteria'],
    ['too much evidence', { evidenceRequired: Array.from({ length: 501 }, () => 'x') }, 'evidence_required'],
    ['evidence that is empty', { evidenceRequired: [' '] }, 'evidence_required[0]'],
    ['evidence that is not a text', { evidenceRequired: [3] }, 'evidence_required[0]'],
  ])('refuses %s', (_name, over, path) => {
    bad(() => checkMilestone(milestone(over as never), '2026-11-01'), 'VALIDATION_FAILED', path);
  });
});
