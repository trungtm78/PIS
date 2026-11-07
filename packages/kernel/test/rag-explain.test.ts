import type { DomainError } from '../src/errors';
import { EWS_FACTOR_CODES, EWS_SCORE_CODE } from '../src/analytics-rule-defaults';
import type { GovernanceRuleVersion } from '../src/governance-rules';
import {
  RAG_COLORS,
  RAG_OVERRIDE_MAX_DAYS,
  checkRagOverride,
  evaluateRag,
  previousWeekOf,
  ragModelOf,
  shownBand,
  weekStartOf,
} from '../src/rag-explain';
import type { RagModel } from '../src/rag-explain';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

// A model written out in full, so these tests do not move when a default is re-confirmed.
const model: RagModel = {
  factors: [
    { code: 'RATE', direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, weight: 40 },
    { code: 'CRIT', direction: 'LOWER_IS_BETTER', green: 0, amber: 2, weight: 30 },
    { code: 'OVERDUE', direction: 'LOWER_IS_BETTER', green: 0, amber: 2, weight: 20 },
    { code: 'NODATA', direction: 'LOWER_IS_BETTER', green: 10, amber: 30, weight: 10 },
  ],
  score: { direction: 'LOWER_IS_BETTER', green: 25, amber: 45 },
  minCoveragePct: 60,
  versions: {},
  unverified: false,
};

describe('the reading of a unit (G3-2)', () => {
  it('scores the weighted share of the factors that are off their line: a red factor counts all its weight, an amber one half', () => {
    // RATE 0.8 is red (40), CRIT 1 amber (15), OVERDUE 0 green (0), NODATA 20 amber (5): 60 of 100
    const result = evaluateRag(model, [
      { code: 'RATE', value: 0.8 },
      { code: 'CRIT', value: 1 },
      { code: 'OVERDUE', value: 0 },
      { code: 'NODATA', value: 20 },
    ]);
    expect(result).toMatchObject({ score: 60, band: 'RED', coveragePct: 100 });
    expect(result.factors.map((factor) => [factor.code, factor.band, factor.points])).toEqual([
      ['RATE', 'RED', 40],
      ['CRIT', 'AMBER', 15],
      ['OVERDUE', 'GREEN', 0],
      ['NODATA', 'AMBER', 5],
    ]);
  });

  it('gives the one to three factors that moved the colour, the most points first, and none that added nothing', () => {
    const result = evaluateRag(model, [
      { code: 'RATE', value: 0.8 },
      { code: 'CRIT', value: 1 },
      { code: 'OVERDUE', value: 0 },
      { code: 'NODATA', value: 20 },
    ]);
    expect(result.reasons.map((reason) => reason.code)).toEqual(['RATE', 'CRIT', 'NODATA']);
    const four = evaluateRag(model, [
      { code: 'RATE', value: 0.9 },
      { code: 'CRIT', value: 1 },
      { code: 'OVERDUE', value: 1 },
      { code: 'NODATA', value: 20 },
    ]);
    expect(four.reasons).toHaveLength(3);
    expect(four.reasons.map((reason) => reason.code)).toEqual(['RATE', 'CRIT', 'OVERDUE']);
  });

  it('breaks a tie of points by the code of the factor, whatever the order the inputs came in', () => {
    const tied: RagModel = { ...model, factors: [{ code: 'A', direction: 'LOWER_IS_BETTER', green: 0, amber: 1, weight: 50 }, { code: 'B', direction: 'LOWER_IS_BETTER', green: 0, amber: 1, weight: 50 }] };
    const result = evaluateRag(tied, [{ code: 'B', value: 5 }, { code: 'A', value: 5 }]);
    expect(result.reasons.map((reason) => [reason.code, reason.points])).toEqual([['A', 50], ['B', 50]]);
  });

  it('is green with no reason when every factor is on its line', () => {
    const result = evaluateRag(model, [
      { code: 'RATE', value: 0.96 },
      { code: 'CRIT', value: 0 },
      { code: 'OVERDUE', value: 0 },
      { code: 'NODATA', value: 0 },
    ]);
    expect(result).toMatchObject({ score: 0, band: 'GREEN', reasons: [] });
  });

  it('reads the line of the score as lower is better, at the line itself as the better colour: 25 is green, 45 is amber, above is red', () => {
    // RATE amber (20) + NODATA amber (5) = 25
    expect(evaluateRag(model, [{ code: 'RATE', value: 0.9 }, { code: 'CRIT', value: 0 }, { code: 'OVERDUE', value: 0 }, { code: 'NODATA', value: 20 }])).toMatchObject({ score: 25, band: 'GREEN' });
    // RATE amber (20) + CRIT amber (15) = 35
    expect(evaluateRag(model, [{ code: 'RATE', value: 0.9 }, { code: 'CRIT', value: 1 }, { code: 'OVERDUE', value: 0 }, { code: 'NODATA', value: 0 }])).toMatchObject({ score: 35, band: 'AMBER' });
    // RATE red (40) + NODATA amber (5) = 45
    expect(evaluateRag(model, [{ code: 'RATE', value: 0.5 }, { code: 'CRIT', value: 0 }, { code: 'OVERDUE', value: 0 }, { code: 'NODATA', value: 20 }])).toMatchObject({ score: 45, band: 'AMBER' });
    // RATE red (40) + OVERDUE amber (10) = 50
    expect(evaluateRag(model, [{ code: 'RATE', value: 0.5 }, { code: 'CRIT', value: 0 }, { code: 'OVERDUE', value: 1 }, { code: 'NODATA', value: 0 }])).toMatchObject({ score: 50, band: 'RED' });
  });

  describe('chưa đủ dữ liệu: a lack of data is never read as green and never as zero', () => {
    it('gives no score and no colour when the factors that have values carry less of the weight than the model asks', () => {
      // CRIT and OVERDUE are missing: 50 of 100 is below the 60 asked
      const result = evaluateRag(model, [{ code: 'RATE', value: 0.99 }, { code: 'NODATA', value: 0 }]);
      expect(result).toMatchObject({ score: null, band: 'NO_DATA', coveragePct: 50, reasons: [] });
      expect(result.factors.filter((factor) => factor.band === 'NO_DATA').map((factor) => factor.code)).toEqual(['CRIT', 'OVERDUE']);
    });
    it('scores over the weight that was there when enough of it was: the missing factor takes no part, not even as zero points', () => {
      const result = evaluateRag(model, [{ code: 'RATE', value: 0.8 }, { code: 'CRIT', value: 1 }, { code: 'OVERDUE', value: 0 }]);
      // 90 of the weight: 40 / 90 and 15 / 90 of 100
      expect(result.coveragePct).toBe(90);
      expect(result.factors.map((factor) => factor.points)).toEqual([44.44, 16.67, 0, 0]);
      expect(result.score).toBe(61.11);
      expect(result.band).toBe('RED');
    });
    it('treats an explicit null and a value that is not a number as missing', () => {
      const result = evaluateRag(model, [{ code: 'RATE', value: null }, { code: 'CRIT', value: Number.NaN }, { code: 'OVERDUE', value: 0 }, { code: 'NODATA', value: 0 }]);
      expect(result.factors.map((factor) => factor.band)).toEqual(['NO_DATA', 'NO_DATA', 'GREEN', 'GREEN']);
      expect(result.score).toBeNull();
    });
    it('has no data for a model with no weight and for no input', () => {
      expect(evaluateRag({ ...model, factors: [] }, [])).toMatchObject({ score: null, band: 'NO_DATA', coveragePct: 0 });
      expect(evaluateRag(model, [])).toMatchObject({ score: null, band: 'NO_DATA', coveragePct: 0 });
    });
    it('asks the coverage of the model, not a constant', () => {
      const inputs = [{ code: 'RATE', value: 0.99 }, { code: 'NODATA', value: 0 }];
      expect(evaluateRag({ ...model, minCoveragePct: 50 }, inputs).band).toBe('GREEN');
      expect(evaluateRag({ ...model, minCoveragePct: 50.01 }, inputs).band).toBe('NO_DATA');
    });
  });

  it('does not change the model it reads', () => {
    const before = JSON.stringify(model);
    evaluateRag(model, [{ code: 'RATE', value: 0.1 }, { code: 'CRIT', value: 9 }, { code: 'OVERDUE', value: 9 }, { code: 'NODATA', value: 99 }]);
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe('the model in force', () => {
  const rule = (code: string, params: Record<string, unknown>, over: Partial<GovernanceRuleVersion> = {}): GovernanceRuleVersion => ({
    id: `r-${code}-${String(over.version ?? 1)}`,
    type: 'RAG_THRESHOLDS',
    code,
    version: 1,
    status: 'APPROVED',
    params,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    unitId: null,
    ...over,
  });

  it('is made of the factor rules and the score rule, each from the built-in default when the tenant approved none', () => {
    const result = ragModelOf([], '2026-06-01');
    expect(result.factors.map((factor) => factor.code)).toEqual([...EWS_FACTOR_CODES]);
    expect(result.versions).toEqual(Object.fromEntries([...EWS_FACTOR_CODES, EWS_SCORE_CODE].map((code) => [code, 0])));
    // the default is a starting value nobody confirmed, and the screen must say so
    expect(result.unverified).toBe(true);
    expect(result.score.direction).toBe('LOWER_IS_BETTER');
    expect(result.factors.every((factor) => factor.weight > 0)).toBe(true);
  });

  it('prefers the approved rule of the tenant, with its version, and reads direction, lines and weight from it', () => {
    const rules = [
      rule(EWS_FACTOR_CODES[1], { direction: 'LOWER_IS_BETTER', green: 1, amber: 4, weight: 55 }, { version: 3 }),
      rule(EWS_SCORE_CODE, { green: 20, amber: 50, min_coverage_pct: 75 }, { version: 2 }),
    ];
    const result = ragModelOf(rules, '2026-06-01');
    expect(result.factors[1]).toEqual({ code: EWS_FACTOR_CODES[1], direction: 'LOWER_IS_BETTER', green: 1, amber: 4, weight: 55 });
    expect(result.score).toEqual({ direction: 'LOWER_IS_BETTER', green: 20, amber: 50 });
    expect(result.minCoveragePct).toBe(75);
    expect(result.versions[EWS_FACTOR_CODES[1]]).toBe(3);
    expect(result.versions[EWS_SCORE_CODE]).toBe(2);
    expect(result.versions[EWS_FACTOR_CODES[0]]).toBe(0);
  });

  it('does not use a rule that is not approved or not yet in force on the day', () => {
    const code = EWS_FACTOR_CODES[0];
    const draft = rule(code, { direction: 'HIGHER_IS_BETTER', green: 9, amber: 8, weight: 99 }, { status: 'DRAFT', version: 5 });
    const future = rule(code, { direction: 'HIGHER_IS_BETTER', green: 9, amber: 8, weight: 99 }, { effectiveFrom: '2027-01-01', version: 6 });
    const result = ragModelOf([draft, future], '2026-06-01');
    expect(result.versions[code]).toBe(0);
    expect(result.factors[0]?.weight).not.toBe(99);
  });

  it('falls back to safe members for a rule that lacks them and reads an unknown direction as higher is better', () => {
    const result = ragModelOf([rule(EWS_FACTOR_CODES[0], { direction: 'SIDEWAYS' }), rule(EWS_SCORE_CODE, {})], '2026-06-01');
    expect(result.factors[0]).toEqual({ code: EWS_FACTOR_CODES[0], direction: 'HIGHER_IS_BETTER', green: 0, amber: 0, weight: 0 });
    expect(result.score).toEqual({ direction: 'LOWER_IS_BETTER', green: 25, amber: 45 });
    expect(result.minCoveragePct).toBe(60);
  });

  it('refuses a day that is not a day', () => {
    expect(refusal(() => ragModelOf([], '2026-02-30')).code).toBe('VALIDATION_FAILED');
  });
});

describe('overriding a colour', () => {
  const today = '2026-11-08';
  const ok = { band: 'RED', reason: 'Chờ số của Kho bạc về', until: '2026-12-01' };

  it('is a colour other than the rules gave, with a reason in words, kept trimmed, and a last day', () => {
    expect(checkRagOverride({ ...ok, reason: '   Chờ số của Kho bạc về  ' }, 'GREEN', today)).toEqual({ band: 'RED', reason: 'Chờ số của Kho bạc về', until: '2026-12-01' });
    expect(RAG_COLORS).toEqual(['GREEN', 'AMBER', 'RED']);
  });
  it('may override a unit that has no colour yet with a colour', () => {
    expect(checkRagOverride(ok, 'NO_DATA', today).band).toBe('RED');
  });
  it('refuses the colour the rules already gave, and a colour that is not one', () => {
    expect(refusal(() => checkRagOverride({ ...ok, band: 'RED' }, 'RED', today)).detail).toBe('band');
    for (const band of ['BLUE', 'NO_DATA', undefined, null, 3]) expect(refusal(() => checkRagOverride({ ...ok, band }, 'GREEN', today)).detail).toBe('band');
  });
  it('needs a reason of at least ten characters and at most five hundred, counted after trimming', () => {
    const refused = (reason: unknown) => refusal(() => checkRagOverride({ ...ok, reason }, 'GREEN', today));
    expect(refused('123456789').detail).toBe('reason');
    expect(refused('   123456789   ').detail).toBe('reason');
    expect(refused('          ').detail).toBe('reason');
    expect(refused(undefined).detail).toBe('reason');
    expect(refused(12345678901).detail).toBe('reason');
    expect(refused('x'.repeat(501)).detail).toBe('reason');
    expect(() => checkRagOverride({ ...ok, reason: '1234567890' }, 'GREEN', today)).not.toThrow();
    expect(() => checkRagOverride({ ...ok, reason: 'x'.repeat(500) }, 'GREEN', today)).not.toThrow();
  });
  it('keeps the reason in the composed form, so the same words compare the same', () => {
    const decomposed = 'Chầ số của Kho bạc';
    const result = checkRagOverride({ ...ok, reason: decomposed }, 'GREEN', today);
    expect(result.reason).toBe(decomposed.normalize('NFC'));
    expect(result.reason).not.toBe(decomposed);
  });
  it('ends at the latest 90 days from today, after today, on a real day', () => {
    expect(RAG_OVERRIDE_MAX_DAYS).toBe(90);
    expect(checkRagOverride({ ...ok, until: '2026-11-09' }, 'GREEN', today).until).toBe('2026-11-09');
    expect(checkRagOverride({ ...ok, until: '2027-02-06' }, 'GREEN', today).until).toBe('2027-02-06');
    for (const until of ['2026-11-08', '2026-11-01', '2027-02-07', '2026-02-30', 'tomorrow', undefined, null, 20261201]) expect(refusal(() => checkRagOverride({ ...ok, until }, 'GREEN', today)).detail).toBe('until');
  });
  it('counts the 90 days across a leap year', () => {
    // 2028-01-01 + 90 days is 2028-03-31 because February has 29 days
    expect(checkRagOverride({ ...ok, until: '2028-03-31' }, 'GREEN', '2028-01-01').until).toBe('2028-03-31');
    expect(refusal(() => checkRagOverride({ ...ok, until: '2028-04-01' }, 'GREEN', '2028-01-01')).detail).toBe('until');
  });
});

describe('the colour a reader is shown', () => {
  const override = { band: 'GREEN' as const, reason: 'Đã có cam kết bằng văn bản', until: '2026-11-20', by: 'u1', at: '2026-11-01' };
  it('is the override while it lasts, with the colour of the rules beside it so the two are never confused', () => {
    expect(shownBand('RED', override, '2026-11-08')).toEqual({ band: 'GREEN', overridden: true, ruleBand: 'RED' });
    expect(shownBand('RED', override, '2026-11-20')).toEqual({ band: 'GREEN', overridden: true, ruleBand: 'RED' });
  });
  it('is the colour of the rules from the day after the override ended, or with no override', () => {
    expect(shownBand('RED', override, '2026-11-21')).toEqual({ band: 'RED', overridden: false, ruleBand: 'RED' });
    expect(shownBand('AMBER', null, '2026-11-08')).toEqual({ band: 'AMBER', overridden: false, ruleBand: 'AMBER' });
    expect(shownBand('NO_DATA', null, '2026-11-08').band).toBe('NO_DATA');
  });
});

describe('the week of a reading', () => {
  it('runs Monday to Sunday: every day of a week has the Monday of that week as its key', () => {
    // 2026-11-02 is a Monday
    for (const day of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) expect(weekStartOf(day)).toBe('2026-11-02');
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
  });
  it('crosses a month, a year and a leap day', () => {
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28');
    expect(weekStartOf('2026-03-01')).toBe('2026-02-23');
    expect(weekStartOf('2028-03-01')).toBe('2028-02-28');
  });
  it('refuses a day that is not a day', () => {
    expect(refusal(() => weekStartOf('2026-02-30')).detail).toBe('as_of');
  });
  it('has the week before as seven days back', () => {
    expect(previousWeekOf('2026-11-02')).toBe('2026-10-26');
    expect(previousWeekOf('2026-01-05')).toBe('2025-12-29');
  });
});
