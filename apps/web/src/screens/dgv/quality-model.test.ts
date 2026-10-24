import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RULE_FORM,
  OPERATORS,
  OPERATORS_BY_DIMENSION,
  WRITABLE_DIMENSIONS,
  ageSecondsOf,
  buildExpression,
  buildRuleBody,
  describeQualityProblem,
  durationOf,
  expressionSummary,
  instantText,
  toRule,
  toScorecard,
  toSummary,
  validateRule,
  validateRunSnapshot,
  withDimension,
} from './quality-model';
import type { RuleForm } from './quality-model';
import { ruleRow, summary, unassessedCard } from './quality-test-support';

const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const form = (overrides: Partial<RuleForm> = {}): RuleForm => ({ ...EMPTY_RULE_FORM, code: 'R-1', field: 'project_id', ...overrides });

describe('the answers of the quality operations', () => {
  it('reads a summary and refuses one that lacks a count', () => {
    expect(toSummary(summary({ total: 3, not_assessed: 1, average_score: '80.00' }))).toMatchObject({ total: 3, notAssessed: 1, averageScore: '80.00', hardFail: 0 });
    expect(toSummary(summary())?.averageScore).toBeNull();
    expect(toSummary({ ...summary(), total: 'x' })).toBeUndefined();
    expect(toSummary(null)).toBeUndefined();
    expect(toSummary([])).toBeUndefined();
  });

  it('reads a rule version and drops what does not have the shape', () => {
    const rule = toRule(ruleRow(1, { threshold_json: { min_pass_rate_pct: '99.500000', warn_pass_rate_pct: '98.000000' }, approved_by_name: 'An' }));
    expect(rule).toMatchObject({ code: 'R-1', minPassRate: '99.500000', warnPassRate: '98.000000', approvedByName: 'An', status: 'DRAFT', action: 'QUARANTINE', weight: 3 });
    expect(toRule(ruleRow(1))?.warnPassRate).toBeNull();
    expect(toRule({ ...ruleRow(1), dimension: 'NOPE' })).toBeUndefined();
    expect(toRule({ ...ruleRow(1), threshold_json: {} })).toBeUndefined();
    expect(toRule({ ...ruleRow(1), expression_ast: 'x' })).toBeUndefined();
    expect(toRule(7)).toBeUndefined();
  });

  it('reads a scorecard of a dataset that was never assessed with no score, and refuses one that lacks its parts', () => {
    const card = toScorecard(unassessedCard());
    expect(card).toMatchObject({ badge: 'NOT_ASSESSED', assessed: false, score: null, hardFail: null, certifiedBlocked: null, ageSeconds: null, latestRun: null, pendingAttempt: null, rules: [], openIncidents: 0 });
    expect(card?.dimensions).toHaveLength(7);
    expect(card?.dimensions.every((dimension) => !dimension.assessed && dimension.score === null)).toBe(true);
    expect(toScorecard({ ...unassessedCard(), badge: 'GREAT' })).toBeUndefined();
    expect(toScorecard({ ...unassessedCard(), dimensions: 'x' })).toBeUndefined();
    expect(toScorecard({ ...unassessedCard(), freshness: {} })).toBeUndefined();
    expect(toScorecard(null)).toBeUndefined();
  });

  it('keeps the dimensions and the rules that have the shape and leaves out those that do not', () => {
    const card = toScorecard(
      unassessedCard({
        dimensions: [{ dimension: 'INTEGRITY', assessed: true, score: '50.00', rules_total: 1, rules_failed: 1 }, { dimension: 'INTEGRITY' }, null],
        rules: [
          {
            rule_version_id: 'a',
            code: 'R',
            revision: 1,
            dimension: 'INTEGRITY',
            severity: 'CRITICAL',
            action_on_fail: 'HARD_BLOCK',
            criticality_weight: 1,
            field_path: null,
            evaluated_count: 4,
            passed_count: 2,
            failed_count: 2,
            quarantined_count: 0,
            measured_value: '50.000000',
            threshold: { min_pass_rate_pct: '100.000000' },
            result: 'FAIL',
            error_code: null,
            incident_id: null,
          },
          { rule_version_id: 'b' },
        ],
        latest_run: { id: 'r', snapshot_id: 's', trigger: 'MANUAL', status: 'COMPLETED', started_at: 'x', rule_count: 1, hard_fail: true, certified_blocked: true },
        pending_attempt: { id: 'r' },
      }),
    );
    expect(card?.dimensions).toEqual([{ dimension: 'INTEGRITY', assessed: true, score: '50.00', rulesTotal: 1, rulesFailed: 1 }]);
    expect(card?.rules).toHaveLength(1);
    expect(card?.rules[0]).toMatchObject({ minPassRate: '100.000000', result: 'FAIL', fieldPath: null });
    expect(card?.latestRun).toMatchObject({ hardFail: true, certifiedBlocked: true, overall: null, quarantined: 0 });
    expect(card?.pendingAttempt).toBeNull();
  });
});

describe('time', () => {
  it('cuts a length of time down to the unit it fills, never up', () => {
    expect([172_799, 172_800, 86_400, 7_199, 3_600, 119, 60, 59, 0, -3].map((seconds) => durationOf(seconds))).toEqual([
      { unit: 'days', count: 1 },
      { unit: 'days', count: 2 },
      { unit: 'days', count: 1 },
      { unit: 'hours', count: 1 },
      { unit: 'hours', count: 1 },
      { unit: 'minutes', count: 1 },
      { unit: 'minutes', count: 1 },
      { unit: 'seconds', count: 59 },
      { unit: 'seconds', count: 0 },
      { unit: 'seconds', count: 0 },
    ]);
  });

  it('counts the age of an instant, never negative, and none for no instant or a text that is not a date', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    expect(ageSecondsOf('2026-10-24T09:00:00.000Z', now)).toBe(3_600);
    expect(ageSecondsOf('2026-10-24T11:00:00.000Z', now)).toBe(0);
    expect(ageSecondsOf(null, now)).toBeNull();
    expect(ageSecondsOf('not a date', now)).toBeNull();
  });

  it('writes an instant to the minute in UTC and leaves a text that is not a date as it came', () => {
    expect(instantText('2026-10-24T08:30:45.123456Z')).toBe('2026-10-24 08:30');
    expect(instantText('later')).toBe('later');
  });
});

describe('the form of a rule', () => {
  it('offers the operators of each dimension and never accuracy', () => {
    expect(WRITABLE_DIMENSIONS).toEqual(['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'INTEGRITY']);
    expect(Object.values(OPERATORS_BY_DIMENSION).flat().every((operator) => OPERATORS.includes(operator))).toBe(true);
  });

  it('keeps the operator when the new dimension allows it, otherwise takes the first it allows, and holds an integrity rule to 100 and no warn-only action', () => {
    expect(withDimension(form({ operator: 'not_blank' }), 'VALIDITY').operator).toBe('not_blank');
    expect(withDimension(form({ operator: 'not_blank' }), 'UNIQUENESS').operator).toBe('unique');
    const integrity = withDimension(form({ action: 'WARN', minRate: '90' }), 'INTEGRITY');
    expect(integrity).toMatchObject({ operator: 'reference_exists', action: 'QUARANTINE', minRate: '100' });
    expect(withDimension(form({ action: 'WARN', minRate: '90' }), 'VALIDITY')).toMatchObject({ action: 'WARN', minRate: '90' });
    expect(withDimension(form({ action: 'HARD_BLOCK' }), 'INTEGRITY').action).toBe('HARD_BLOCK');
  });

  it('accepts a complete form of each check', () => {
    const complete: Array<Partial<RuleForm>> = [
      {},
      { operator: 'not_blank' },
      { dimension: 'VALIDITY', operator: 'is_null' },
      { dimension: 'VALIDITY', operator: 'compare', value: '5' },
      { dimension: 'VALIDITY', operator: 'between', min: '-1.5', max: '10' },
      { dimension: 'VALIDITY', operator: 'in', values: 'A, B' },
      { dimension: 'CONSISTENCY', operator: 'compare_fields', otherField: 'plan_total_vnd' },
      { dimension: 'UNIQUENESS', operator: 'unique', field: 'project_id, bucket' },
      { dimension: 'TIMELINESS', operator: 'snapshot_age_within', seconds: '3600', field: '' },
      { dimension: 'INTEGRITY', operator: 'reference_exists', minRate: '100' },
    ];
    for (const overrides of complete) expect(validateRule(form(overrides))).toEqual({});
  });

  it('names each field that is wrong', () => {
    expect(validateRule(form({ code: '' })).code).toBe('required');
    expect(validateRule(form({ code: 'x' })).code).toBe('tooShort');
    expect(validateRule(form({ code: 'x'.repeat(81) })).code).toBe('tooLong');
    expect(validateRule(form({ field: '' })).field).toBe('required');
    expect(validateRule(form({ field: 'Project Id' })).field).toBe('invalidList');
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'compare', value: '' })).value).toBe('required');
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'compare', value: 'x'.repeat(201) })).value).toBe('tooLong');
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'between', min: '', max: 'x' }))).toMatchObject({ min: 'required', max: 'invalidNumber' });
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'in', values: '' })).values).toBe('required');
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'in', values: 'A,,B' })).values).toBe('invalidList');
    expect(validateRule(form({ dimension: 'VALIDITY', operator: 'in', values: Array.from({ length: 51 }, (_, index) => `v${index}`).join(',') })).values).toBe('invalidList');
    expect(validateRule(form({ dimension: 'CONSISTENCY', operator: 'compare_fields', field: '', otherField: '' }))).toMatchObject({ field: 'required', otherField: 'required' });
    expect(validateRule(form({ dimension: 'CONSISTENCY', operator: 'compare_fields', field: 'a b', otherField: 'c d' }))).toMatchObject({ field: 'invalidList', otherField: 'invalidList' });
    expect(validateRule(form({ dimension: 'UNIQUENESS', operator: 'unique', field: '' })).field).toBe('required');
    expect(validateRule(form({ dimension: 'UNIQUENESS', operator: 'unique', field: 'a,b,c,d,e' })).field).toBe('invalidList');
    expect(validateRule(form({ dimension: 'TIMELINESS', operator: 'snapshot_age_within', seconds: '' })).seconds).toBe('required');
    expect(validateRule(form({ dimension: 'TIMELINESS', operator: 'snapshot_age_within', seconds: '0' })).seconds).toBe('invalidNumber');
    expect(validateRule(form({ minRate: '0' })).minRate).toBe('invalidRate');
    expect(validateRule(form({ minRate: '100.1' })).minRate).toBe('invalidRate');
    expect(validateRule(form({ minRate: '' })).minRate).toBe('invalidRate');
    expect(validateRule(form({ dimension: 'INTEGRITY', operator: 'reference_exists', minRate: '99' })).minRate).toBe('invalidRate');
    expect(validateRule(form({ warnRate: 'x' })).warnRate).toBe('invalidRate');
    expect(validateRule(form({ warnRate: '100' })).warnRate).toBe('warnNotBelowMin');
    expect(validateRule(form({ minRate: 'x', warnRate: '50' })).warnRate).toBeUndefined();
    expect(validateRule(form({ weight: '0' })).weight).toBe('invalidNumber');
    expect(validateRule(form({ weight: '11' })).weight).toBe('invalidNumber');
  });

  it('builds the expression of each check as the allowlisted node', () => {
    expect(buildExpression(form({ operator: 'not_null' }))).toEqual({ op: 'not_null', field: 'project_id' });
    expect(buildExpression(form({ operator: 'not_blank', field: ' bucket ' }))).toEqual({ op: 'not_blank', field: 'bucket' });
    expect(buildExpression(form({ operator: 'is_null' }))).toEqual({ op: 'is_null', field: 'project_id' });
    expect(buildExpression(form({ operator: 'reference_exists' }))).toEqual({ op: 'reference_exists', field: 'project_id' });
    expect(buildExpression(form({ operator: 'compare', comparator: 'gte', value: ' 5 ' }))).toEqual({ op: 'compare', field: 'project_id', cmp: 'gte', value: '5' });
    expect(buildExpression(form({ operator: 'between', min: ' 0 ', max: '10' }))).toEqual({ op: 'between', field: 'project_id', min: '0', max: '10' });
    expect(buildExpression(form({ operator: 'in', values: 'A, B ,C' }))).toEqual({ op: 'in', field: 'project_id', values: ['A', 'B', 'C'] });
    expect(buildExpression(form({ operator: 'compare_fields', comparator: 'lte', otherField: ' plan_total_vnd ' }))).toEqual({ op: 'compare_fields', left: 'project_id', cmp: 'lte', right: 'plan_total_vnd' });
    expect(buildExpression(form({ operator: 'unique', field: 'project_id, bucket, project_id' }))).toEqual({ op: 'unique', fields: ['project_id', 'bucket'] });
    expect(buildExpression(form({ operator: 'unique', field: 'Bad Name' }))).toEqual({ op: 'unique', fields: [] });
    expect(buildExpression(form({ operator: 'snapshot_age_within', seconds: ' 3600 ' }))).toEqual({ op: 'snapshot_age_within', seconds: 3600 });
  });

  it('builds the body of a draft with the contract, the stored code and the threshold as typed', () => {
    expect(buildRuleBody('c-1', form({ code: ' R-1 ', minRate: '99.5', warnRate: ' 98 ', weight: '7', severity: 'HIGH', action: 'HARD_BLOCK' }))).toEqual({
      contract_id: 'c-1',
      code: 'R-1',
      dimension: 'COMPLETENESS',
      expression_ast: { op: 'not_null', field: 'project_id' },
      severity: 'HIGH',
      threshold_json: { min_pass_rate_pct: '99.5', warn_pass_rate_pct: '98' },
      action_on_fail: 'HARD_BLOCK',
      criticality_weight: 7,
    });
    expect(buildRuleBody('c-1', form()).threshold_json).toEqual({ min_pass_rate_pct: '100' });
  });

  it('summarises a stored expression by its operator and fields, and a compound one by its parts', () => {
    expect(expressionSummary({ op: 'compare', field: 'a', cmp: 'gte', value: '5' })).toBe('compare a gte');
    expect(expressionSummary({ op: 'unique', fields: ['a', 'b'] })).toBe('unique a, b');
    expect(expressionSummary({ op: 'snapshot_age_within', seconds: 60 })).toBe('snapshot_age_within 60');
    expect(expressionSummary({ op: 'and', args: [{ op: 'not_null', field: 'a' }, { op: 'is_null', field: 'b' }, 'x'] })).toBe('(not_null a) and (is_null b) and ()');
    expect(expressionSummary({ op: 'not', arg: { op: 'is_null', field: 'a' } })).toBe('not (is_null a)');
    expect(expressionSummary({})).toBe('');
  });
});

describe('the run form and the refusals', () => {
  it('accepts a snapshot id in either case and says what is wrong with anything else', () => {
    expect(validateRunSnapshot('00000000-0000-4000-8000-00000000000A')).toBeUndefined();
    expect(validateRunSnapshot(' 00000000-0000-4000-8000-00000000000a ')).toBeUndefined();
    expect(validateRunSnapshot('  ')).toBe('required');
    expect(validateRunSnapshot('abc')).toBe('invalidId');
  });

  it('tells a conflict of state by the field it names and maps the codes the commands answer', () => {
    expect(describeQualityProblem(problem('STAGE_TRANSITION_DENIED', 'snapshot_id'))).toEqual({ reason: 'snapshotNotFrozen', field: 'snapshot_id' });
    expect(describeQualityProblem(problem('STAGE_TRANSITION_DENIED', 'status'))).toEqual({ reason: 'notDraft', field: 'status' });
    expect(describeQualityProblem(problem('EXPRESSION_NOT_ALLOWED', 'expression_ast'))).toEqual({ reason: 'expressionNotAllowed', field: 'expression_ast' });
    expect(describeQualityProblem(problem('THRESHOLD_INVALID')).reason).toBe('thresholdInvalid');
    expect(describeQualityProblem(problem('SELF_APPROVAL_DENIED')).reason).toBe('selfApproval');
    expect(describeQualityProblem(problem('RUN_ALREADY_RUNNING')).reason).toBe('alreadyRunning');
    expect(describeQualityProblem(problem('SNAPSHOT_NOT_FOUND')).reason).toBe('snapshotNotFound');
    expect(describeQualityProblem(problem('VERSION_CONFLICT')).reason).toBe('versionConflict');
    expect(describeQualityProblem(problem('FIELD_NOT_ALLOWED')).reason).toBe('validation');
    expect(describeQualityProblem(problem('SOMETHING_NEW')).reason).toBe('general');
    expect(describeQualityProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
