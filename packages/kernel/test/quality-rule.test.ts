import { DomainError } from '../src/errors';
import { FULL_RATE, formatRate, judgeRun, parseQualityThreshold, passRateMicro, ruleVerdict, validateQualityExpression } from '../src/quality-rule';
import type { QualityDimension, QualitySourceShape, RuleOutcome } from '../src/quality-rule';

const SOURCE: QualitySourceShape = {
  fields: { project_id: 'uuid', bucket: 'text', plan_total_vnd: 'numeric', ctmtqg_subset_vnd: 'numeric', rate_total_pct: 'numeric', rate_null_reason: 'text' },
  references: new Set(['project_id']),
};

function refusal(work: () => unknown): { code: string; status: number; detail: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected a refusal');
}

const validate = (dimension: QualityDimension, raw: unknown) => validateQualityExpression(dimension, raw, SOURCE);
const notAllowed = (dimension: QualityDimension, raw: unknown) => expect(refusal(() => validate(dimension, raw))).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', status: 422, detail: 'expression_ast' });

describe('the allowlisted expression of a quality rule', () => {
  it('accepts the completeness operators and reports the fields they read', () => {
    expect(validate('COMPLETENESS', { op: 'not_null', field: 'project_id' })).toEqual({ ast: { op: 'not_null', field: 'project_id' }, fields: ['project_id'] });
    expect(validate('COMPLETENESS', { op: 'and', args: [{ op: 'not_null', field: 'project_id' }, { op: 'not_blank', field: 'bucket' }] }).fields).toEqual(['project_id', 'bucket']);
  });

  it('accepts validity comparisons whose literals have the type of the field, and normalises them', () => {
    const ast = validate('VALIDITY', {
      op: 'or',
      args: [
        { op: 'is_null', field: 'rate_total_pct' },
        { op: 'and', args: [{ op: 'between', field: 'rate_total_pct', min: 0, max: '100.5' }, { op: 'not', arg: { op: 'compare', field: 'bucket', cmp: 'eq', value: 'OTHER' } }] },
      ],
    }).ast;
    expect(ast).toEqual({
      op: 'or',
      args: [
        { op: 'is_null', field: 'rate_total_pct' },
        { op: 'and', args: [{ op: 'between', field: 'rate_total_pct', min: '0', max: '100.5' }, { op: 'not', arg: { op: 'compare', field: 'bucket', cmp: 'eq', value: 'OTHER' } }] },
      ],
    });
    expect(validate('VALIDITY', { op: 'in', field: 'bucket', values: ['A', 'B', 'A'] }).ast).toEqual({ op: 'in', field: 'bucket', values: ['A', 'B'] });
    expect(validate('VALIDITY', { op: 'compare', field: 'project_id', cmp: 'ne', value: '00000000-0000-4000-8000-0000000000AA' }).ast).toEqual({
      op: 'compare',
      field: 'project_id',
      cmp: 'ne',
      value: '00000000-0000-4000-8000-0000000000aa',
    });
  });

  it('accepts a consistency rule only when it compares two fields, and the fields must have one type', () => {
    expect(validate('CONSISTENCY', { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' }).fields).toEqual(['ctmtqg_subset_vnd', 'plan_total_vnd']);
    notAllowed('CONSISTENCY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: '0' });
    notAllowed('CONSISTENCY', { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'bucket' });
    notAllowed('CONSISTENCY', { op: 'compare_fields', left: 'plan_total_vnd', cmp: 'lte', right: 'plan_total_vnd' });
  });

  it('accepts uniqueness, timeliness and integrity as the whole rule of their dimension', () => {
    expect(validate('UNIQUENESS', { op: 'unique', fields: ['project_id', 'bucket', 'project_id'] }).ast).toEqual({ op: 'unique', fields: ['project_id', 'bucket'] });
    expect(validate('TIMELINESS', { op: 'snapshot_age_within', seconds: 86_400 })).toEqual({ ast: { op: 'snapshot_age_within', seconds: 86_400 }, fields: [] });
    expect(validate('INTEGRITY', { op: 'reference_exists', field: 'project_id' }).ast).toEqual({ op: 'reference_exists', field: 'project_id' });
    expect(validate('INTEGRITY', { op: 'and', args: [{ op: 'reference_exists', field: 'project_id' }, { op: 'reference_exists', field: 'project_id' }] }).fields).toEqual(['project_id']);
    notAllowed('UNIQUENESS', { op: 'and', args: [{ op: 'unique', fields: ['bucket'] }, { op: 'unique', fields: ['bucket'] }] });
    notAllowed('TIMELINESS', { op: 'not_null', field: 'bucket' });
  });

  it('refuses a raw SQL node, a function, an unknown operator and an extra key (AC-ST-DGV-002-3)', () => {
    notAllowed('COMPLETENESS', { op: 'raw_sql', sql: 'select 1' });
    notAllowed('COMPLETENESS', { op: 'and', args: [{ op: 'not_null', field: 'project_id' }, { op: 'raw_sql', sql: "1=1; drop table machvon.project" }] });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'eq', value: 'A', sql: '1=1' });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'like', value: 'A' });
    notAllowed('VALIDITY', { op: 'now' });
    notAllowed('COMPLETENESS', { op: 'not_null' });
    notAllowed('COMPLETENESS', { field: 'project_id' });
    notAllowed('COMPLETENESS', 'not_null');
    notAllowed('COMPLETENESS', null);
    notAllowed('COMPLETENESS', [{ op: 'not_null', field: 'project_id' }]);
  });

  it('refuses an operator that belongs to another dimension, and the accuracy dimension altogether', () => {
    notAllowed('COMPLETENESS', { op: 'compare', field: 'bucket', cmp: 'eq', value: 'A' });
    notAllowed('INTEGRITY', { op: 'not_null', field: 'project_id' });
    notAllowed('ACCURACY', { op: 'not_null', field: 'project_id' });
    notAllowed('ACCURACY', { op: 'unique', fields: ['bucket'] });
  });

  it('refuses a field the source does not have, a field that may not be checked as a reference, and a field name that is not a plain name', () => {
    notAllowed('COMPLETENESS', { op: 'not_null', field: 'tenant_id' });
    notAllowed('COMPLETENESS', { op: 'not_null', field: 'project_id; drop' });
    notAllowed('COMPLETENESS', { op: 'not_null', field: 'constructor' });
    notAllowed('COMPLETENESS', { op: 'not_null', field: 7 });
    notAllowed('INTEGRITY', { op: 'reference_exists', field: 'bucket' });
    notAllowed('UNIQUENESS', { op: 'unique', fields: ['nope'] });
    notAllowed('UNIQUENESS', { op: 'unique', fields: [] });
    notAllowed('UNIQUENESS', { op: 'unique', fields: ['a', 'b', 'c', 'd', 'e'] });
    notAllowed('COMPLETENESS', { op: 'not_blank', field: 'plan_total_vnd' });
  });

  it('refuses literals of the wrong type or shape', () => {
    notAllowed('VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: 'abc' });
    notAllowed('VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: 1.5 });
    notAllowed('VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: '1e3' });
    notAllowed('VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: '1234567890123456789' });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'gt', value: 'A' });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'eq', value: '' });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'eq', value: 'a\u0000b' });
    notAllowed('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'eq', value: 'x'.repeat(201) });
    notAllowed('VALIDITY', { op: 'compare', field: 'project_id', cmp: 'eq', value: 'not-a-uuid' });
    notAllowed('VALIDITY', { op: 'between', field: 'bucket', min: 'a', max: 'b' });
    notAllowed('VALIDITY', { op: 'in', field: 'bucket', values: [] });
    notAllowed('VALIDITY', { op: 'in', field: 'bucket', values: 'A' });
    notAllowed('VALIDITY', { op: 'in', field: 'bucket', values: Array.from({ length: 51 }, (_, index) => `v${index}`) });
    notAllowed('TIMELINESS', { op: 'snapshot_age_within', seconds: 0 });
    notAllowed('TIMELINESS', { op: 'snapshot_age_within', seconds: 1.5 });
    notAllowed('TIMELINESS', { op: 'snapshot_age_within', seconds: 31_536_001 });
    notAllowed('TIMELINESS', { op: 'snapshot_age_within', seconds: '60' });
    notAllowed('VALIDITY', { op: 'compare_fields', left: 'a', cmp: 'eq', right: 'b' });
  });

  it('bounds the size of an expression', () => {
    const leaf = { op: 'not_null', field: 'project_id' };
    const wrap = (inner: unknown, levels: number): unknown => (levels === 0 ? inner : wrap({ op: 'and', args: [inner, leaf] }, levels - 1));
    expect(() => validate('COMPLETENESS', wrap(leaf, 3))).not.toThrow();
    notAllowed('COMPLETENESS', wrap(leaf, 4));
    notAllowed('COMPLETENESS', { op: 'and', args: Array.from({ length: 21 }, () => leaf) });
    notAllowed('COMPLETENESS', { op: 'and', args: [leaf] });
    notAllowed('COMPLETENESS', { op: 'and', args: 'x' });
  });
});

describe('the threshold of a quality rule', () => {
  it('stores the rates as decimal strings and keeps the exact value', () => {
    expect(parseQualityThreshold({ min_pass_rate_pct: '99.5' }, 'COMPLETENESS')).toEqual({ json: { min_pass_rate_pct: '99.500000' }, minMicro: 99_500_000, warnMicro: undefined });
    expect(parseQualityThreshold({ min_pass_rate_pct: 100, warn_pass_rate_pct: '98.123456' }, 'VALIDITY')).toEqual({
      json: { min_pass_rate_pct: '100.000000', warn_pass_rate_pct: '98.123456' },
      minMicro: FULL_RATE,
      warnMicro: 98_123_456,
    });
    expect(formatRate(5)).toBe('0.000005');
  });

  it.each([
    [{}],
    [null],
    [[]],
    ['99'],
    [{ min_pass_rate_pct: '0' }],
    [{ min_pass_rate_pct: '100.000001' }],
    [{ min_pass_rate_pct: '-1' }],
    [{ min_pass_rate_pct: '99.1234567' }],
    [{ min_pass_rate_pct: '1e2' }],
    [{ min_pass_rate_pct: 'abc' }],
    [{ min_pass_rate_pct: Number.NaN }],
    [{ min_pass_rate_pct: '99', max: '100' }],
    [{ min_pass_rate_pct: '99', warn_pass_rate_pct: '99' }],
    [{ min_pass_rate_pct: '99', warn_pass_rate_pct: '99.5' }],
    [{ warn_pass_rate_pct: '90' }],
  ])('refuses %j as THRESHOLD_INVALID', (raw) => {
    expect(refusal(() => parseQualityThreshold(raw, 'COMPLETENESS'))).toEqual({ code: 'THRESHOLD_INVALID', status: 422, detail: 'threshold_json' });
  });

  it('leaves an integrity rule no room for a miss', () => {
    expect(parseQualityThreshold({ min_pass_rate_pct: '100' }, 'INTEGRITY').minMicro).toBe(FULL_RATE);
    expect(refusal(() => parseQualityThreshold({ min_pass_rate_pct: '99.9' }, 'INTEGRITY')).code).toBe('THRESHOLD_INVALID');
  });
});

describe('the pass rate and the verdict of one rule', () => {
  it('counts the rate in whole millionths of a percent and rounds it down, so a near miss never reads as a pass', () => {
    expect(passRateMicro(999, 1000)).toBe(99_900_000);
    expect(passRateMicro(1000, 1000)).toBe(FULL_RATE);
    expect(passRateMicro(0, 7)).toBe(0);
    expect(passRateMicro(2, 3)).toBe(66_666_666);
    expect(passRateMicro(999_999_999_999, 1_000_000_000_000)).toBe(99_999_999);
    expect(passRateMicro(0, 0)).toBeUndefined();
    expect(() => passRateMicro(2, 1)).toThrow(RangeError);
    expect(() => passRateMicro(-1, 1)).toThrow(RangeError);
    expect(() => passRateMicro(0.5, 1)).toThrow(RangeError);
  });

  it('is PASS at the minimum, WARN in the warning band and FAIL below it; an action of WARN only softens the failure', () => {
    const threshold = { minMicro: 99_500_000, warnMicro: 98_000_000 };
    expect(ruleVerdict(99_500_000, threshold, 'QUARANTINE')).toBe('PASS');
    expect(ruleVerdict(99_499_999, threshold, 'QUARANTINE')).toBe('WARN');
    expect(ruleVerdict(97_999_999, threshold, 'QUARANTINE')).toBe('FAIL');
    expect(ruleVerdict(97_999_999, threshold, 'HARD_BLOCK')).toBe('FAIL');
    expect(ruleVerdict(97_999_999, threshold, 'WARN')).toBe('WARN');
    expect(ruleVerdict(99_499_999, { minMicro: 99_500_000, warnMicro: undefined }, 'HARD_BLOCK')).toBe('FAIL');
  });
});

const outcome = (overrides: Partial<RuleOutcome>): RuleOutcome => ({ dimension: 'COMPLETENESS', action: 'QUARANTINE', weight: 1, result: 'PASS', rateMicro: FULL_RATE, ...overrides });

describe('the verdict of a run (BR-DGV-03)', () => {
  it('is a hard fail with a score of about 95 when nine rules pass and one integrity rule finds a reference of another tenant (AC-ST-DGV-002-1)', () => {
    const nine = Array.from({ length: 9 }, () => outcome({}));
    const verdict = judgeRun([...nine, outcome({ dimension: 'INTEGRITY', action: 'HARD_BLOCK', result: 'FAIL', rateMicro: 50_000_000 })], false);
    expect(verdict).toEqual({ score: '95.00', hardFail: true, certifiedBlocked: true, overall: 'FAILED', measured: 10, failed: 1 });
  });

  it('weights each rule by its criticality and never rounds the score up', () => {
    const verdict = judgeRun([outcome({ weight: 3, rateMicro: 99_999_999, result: 'WARN' }), outcome({ weight: 1, rateMicro: FULL_RATE })], true);
    expect(verdict.score).toBe('99.99');
    expect(verdict.overall).toBe('WARNING');
    expect(judgeRun([outcome({ weight: 2, rateMicro: 90_000_000, result: 'WARN' }), outcome({ weight: 8, rateMicro: FULL_RATE })], true).score).toBe('98.00');
  });

  it('is PASSED only when every rule passed', () => {
    expect(judgeRun([outcome({}), outcome({ dimension: 'UNIQUENESS' })], true)).toEqual({ score: '100.00', hardFail: false, certifiedBlocked: false, overall: 'PASSED', measured: 2, failed: 0 });
  });

  it('fails the run for a failed rule, blocks certified figures for a failed HARD_BLOCK rule, and makes it a hard fail only on a critical dataset', () => {
    const failedQuarantine = judgeRun([outcome({}), outcome({ result: 'FAIL', rateMicro: 90_000_000 })], true);
    expect(failedQuarantine).toMatchObject({ overall: 'FAILED', hardFail: false, certifiedBlocked: false, failed: 1 });
    const blockOnPlain = judgeRun([outcome({ action: 'HARD_BLOCK', result: 'FAIL', rateMicro: 90_000_000 })], false);
    expect(blockOnPlain).toMatchObject({ overall: 'FAILED', hardFail: false, certifiedBlocked: true });
    const blockOnCritical = judgeRun([outcome({ action: 'HARD_BLOCK', result: 'FAIL', rateMicro: 90_000_000 })], true);
    expect(blockOnCritical).toMatchObject({ overall: 'FAILED', hardFail: true, certifiedBlocked: true });
  });

  it('keeps a warning or a rule that could not be measured from reading PASSED, and leaves the unmeasured rule out of the score', () => {
    const verdict = judgeRun([outcome({}), outcome({ result: 'ERROR', rateMicro: null })], false);
    expect(verdict).toMatchObject({ score: '100.00', overall: 'WARNING', measured: 1, failed: 0 });
  });

  it('has no verdict, no score and no hard fail when no rule could be measured', () => {
    expect(judgeRun([], true)).toEqual({ score: null, hardFail: false, certifiedBlocked: false, overall: undefined, measured: 0, failed: 0 });
    expect(judgeRun([outcome({ result: 'ERROR', rateMicro: null })], true).overall).toBeUndefined();
  });
});
