import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { allProblems, blankParams, crossProblems, dayText, daysToReview, describeRefusal, draftOfParams, flattenParams, forceCounts, isReason, isUnverified, momentText, movesOf, paramsOfDraft, periodNotices, problemsOf, sideBySide, toAlertTypes, toCatalogue, toDiff, toVersion, unitOfField, updateAt } from './model';
import type { Draft, FieldSpec, RuleVersion, Schema } from './model';
import { catalogueBody, version } from './test/fixtures';

const schema: Schema = {
  count: { kind: 'int', min: 1, max: 10 },
  share: { kind: 'number', min: 0, max: 100 },
  name: { kind: 'text', max: 5, pattern: '^[A-Z]+$' },
  note: { kind: 'text', max: 20, optional: true, allowEmpty: true },
  day: { kind: 'date' },
  at: { kind: 'time', optional: true },
  mode: { kind: 'enum', values: ['A', 'B'] },
  on: { kind: 'boolean' },
  rows: { kind: 'list', min: 1, max: 2, of: { kind: 'object', fields: { limit_vnd: { kind: 'int', min: 0, max: 1000 } } } },
};

const good = (): Draft => draftOfParams(schema, { count: 3, share: 12.5, name: 'AB', day: '2026-11-08', mode: 'A', on: true, rows: [{ limit_vnd: 5 }] });
const codes = (draft: Draft) => allProblems('OTHER', schema, draft).map((problem) => `${problem.path}:${problem.code}`);

describe('the schema of the params as a form', () => {
  it('turns params into text and back, leaving out what is optional and empty', () => {
    const draft = good();
    expect(codes(draft)).toEqual([]);
    expect(paramsOfDraft(schema, draft)).toEqual({ count: 3, share: 12.5, name: 'AB', day: '2026-11-08', mode: 'A', on: true, rows: [{ limit_vnd: 5 }] });
    expect(paramsOfDraft(schema, updateAt(draft, ['note'], 'có'))).toMatchObject({ note: 'có' });
  });

  it('reads a Vietnamese decimal comma as a point', () => {
    expect(paramsOfDraft(schema, updateAt(good(), ['share'], '12,5'))).toMatchObject({ share: 12.5 });
    expect(codes(updateAt(good(), ['share'], '12,5'))).toEqual([]);
  });

  it('names the problem of each kind of field at the path the server uses', () => {
    let draft = good();
    draft = updateAt(draft, ['count'], '11');
    draft = updateAt(draft, ['share'], 'x');
    draft = updateAt(draft, ['name'], 'abc');
    draft = updateAt(draft, ['day'], '2026-02-30');
    draft = updateAt(draft, ['at'], '25:00');
    draft = updateAt(draft, ['mode'], 'C');
    draft = updateAt(draft, ['rows', 0, 'limit_vnd'], '1001');
    expect(codes(draft)).toEqual(['count:range', 'share:number', 'name:pattern', 'day:date', 'at:time', 'mode:choice', 'rows[0].limit_vnd:range']);
    expect(codes(updateAt(good(), ['count'], '1.5'))).toEqual(['count:integer']);
    expect(codes(updateAt(good(), ['name'], 'ABCDEF'))).toContain('name:length');
    expect(codes(updateAt(good(), ['name'], ' AB'))).toContain('name:trim');
    expect(codes(updateAt(good(), ['rows'], []))).toEqual(['rows:listSize']);
    expect(codes(updateAt(good(), ['rows'], [{ limit_vnd: '1' }, { limit_vnd: '1' }, { limit_vnd: '1' }]))).toEqual(['rows:listSize']);
  });

  it('asks for what is required and allows what is optional to stay empty', () => {
    const blank = blankParams(schema);
    expect(codes(blank)).toEqual(['count:required', 'share:required', 'name:required', 'day:required', 'mode:required', 'rows[0].limit_vnd:required']);
    expect(problemsOf({ kind: 'text', max: 5, allowEmpty: true } as FieldSpec, '', 'x')).toEqual([]);
  });

  it('knows that an alert type with no expected action can only be watched', () => {
    const base: Draft = { expected_action: '', default_severity: 'ACTION' };
    expect(crossProblems('ALERT_TYPE', base)).toEqual([{ path: 'default_severity', code: 'watchOnly' }]);
    expect(crossProblems('ALERT_TYPE', { expected_action: '  ', default_severity: 'WATCH' })).toEqual([]);
    expect(crossProblems('ALERT_TYPE', { expected_action: 'Làm', default_severity: 'URGENT' })).toEqual([]);
    expect(crossProblems('ANY_OTHER', base)).toEqual([]);
  });

  it('reads the unit of a number from the name of its field', () => {
    expect(unitOfField('threshold_vnd')).toBe('VND');
    expect(unitOfField('bands[1].up_to_vnd')).toBe('VND');
    expect(unitOfField('toleranceVnd')).toBe('VND');
    expect(unitOfField('coverAlertBelowPct')).toBe('PCT');
    expect(unitOfField('max_pct_of_contract')).toBe('PCT');
    expect(unitOfField('response_hours')).toBe('HOURS');
    expect(unitOfField('due_days')).toBe('DAYS');
    expect(unitOfField('top_n')).toBeNull();
  });
});

describe('what the server sends', () => {
  it('reads the catalogue, the schema and the counts of codes in force and on the default', () => {
    const parsed = toCatalogue(catalogueBody()) ?? [];
    expect(parsed.map((entry) => entry.ruleType)).toEqual(['ALERT_TYPE', 'CHANGE_ORDER_TIER', 'RAG_THRESHOLDS']);
    expect(parsed[0]?.schema?.response_hours).toEqual({ kind: 'int', min: 1, max: 8760 });
    expect(forceCounts(parsed[0] as never)).toEqual({ rules: 1, defaults: 1, none: 0 });
    expect(isUnverified(parsed[0] as never)).toBe(false);
    expect(isUnverified(parsed[1] as never)).toBe(true);
  });

  it('refuses a schema it does not understand instead of guessing one', () => {
    const body = catalogueBody();
    (body.items[0] as { schema: unknown }).schema = { odd: { kind: 'matrix' } };
    expect(toCatalogue(body)?.[0]?.schema).toBeUndefined();
    expect(toCatalogue({ nothing: true })).toBeUndefined();
  });

  it('keeps only versions that have what a version has', () => {
    expect(toVersion(version(1))?.status).toBe('DRAFT');
    expect(toVersion({ ...version(1), status: 'WEIRD' })).toBeUndefined();
    expect(toVersion(null)).toBeUndefined();
  });

  it('tells added, removed and changed apart', () => {
    const diff = toDiff({ from: { id: null, rule_type: 'T', code: 'C', version: 0, source: 'DEFAULT' }, to: { id: 'x', rule_type: 'T', code: 'C', version: 1 }, changes: [{ path: 'a', before: null, after: 1 }, { path: 'b', before: 1, after: null }, { path: 'c', before: 1, after: 2 }] });
    expect(diff?.changes.map((change) => change.kind)).toEqual(['added', 'removed', 'changed']);
    expect(diff?.from.source).toBe('DEFAULT');
  });

  it('reads an alert type with no expected action as having none (empty text counts as none)', () => {
    const parsed = toAlertTypes({ as_of: '2026-11-08', items: [{ code: 'A', expected_action: '  ', default_severity: 'WATCH', rule_source: 'DEFAULT' }, { code: 'B', expected_action: 'Làm', default_severity: 'ACTION', rule_source: 'RULE', version: 2 }] });
    expect(parsed?.items.map((item) => item.expectedAction)).toEqual([null, 'Làm']);
    expect(parsed?.items[1]?.ruleSource).toBe('RULE');
  });

  it('counts the days to a review day, negative when it has passed', () => {
    expect(daysToReview('2026-11-20', '2026-11-08')).toBe(12);
    expect(daysToReview('2026-10-30', '2026-11-08')).toBe(-9);
    expect(daysToReview(null, '2026-11-08')).toBeNull();
    expect(daysToReview('nope', '2026-11-08')).toBeNull();
  });

  it('writes days the Vietnamese way and instants in the time of Vietnam', () => {
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText(null)).toBe('');
    // 20:00 UTC is 03:00 the next day in Vietnam.
    expect(momentText('2026-11-08T20:00:00.000Z', 'vi')).toMatch(/03:00.*9\/11/);
    expect(isReason('abcd')).toBe(false);
    expect(isReason('abcde')).toBe(true);
    expect(isReason(`  ${'x'.repeat(501)}  `)).toBe(false);
  });

  it('puts the rule in force and the default on the same rows', () => {
    expect(flattenParams({ a: 1, b: { c: [1, 2], d: {} }, e: [] })).toEqual([{ path: 'a', value: 1 }, { path: 'b.c[0]', value: 1 }, { path: 'b.c[1]', value: 2 }, { path: 'b.d', value: {} }, { path: 'e', value: [] }]);
    const rows = sideBySide({ a: 1, only: 1 }, { a: 1, b: 2 });
    expect(rows.map((row) => `${row.path}:${row.same}`)).toEqual(['a:true', 'only:false', 'b:false']);
    expect(rows[1]?.hasRight).toBe(false);
  });
});

describe('the period of a version', () => {
  const approved = (n: number, from: string, to: string | null, over: Partial<RuleVersion> = {}): RuleVersion => ({ ...(toVersion(version(n, { status: 'APPROVED', phase: 'IN_FORCE', approved_at: '2026-10-01T00:00:00Z', effective_from: from, effective_to: to })) as RuleVersion), ...over });
  const TODAY = '2026-11-08';

  it('takes over from a version that began earlier and is covered', () => {
    expect(periodNotices([approved(2, '2026-10-05', null)], '2026-12-01', null, TODAY)).toEqual([{ kind: 'takeover', version: 2, endsOn: '2026-12-01' }]);
    expect(periodNotices([approved(2, '2026-10-05', '2027-01-01')], '2026-12-01', '2027-02-01', TODAY)).toEqual([{ kind: 'takeover', version: 2, endsOn: '2026-12-01' }]);
  });

  it('warns of an overlap that is not a takeover', () => {
    expect(periodNotices([approved(3, '2027-01-01', null)], '2026-12-01', null, TODAY)).toEqual([{ kind: 'conflict', version: 3, from: '2027-01-01', to: null }]);
    expect(periodNotices([approved(2, '2026-10-05', null)], '2026-12-01', '2027-01-01', TODAY)).toEqual([{ kind: 'conflict', version: 2, from: '2026-10-05', to: null }]);
  });

  it('says nothing about a version that ended before, a draft, or one that never governed', () => {
    expect(periodNotices([approved(2, '2026-10-05', '2026-12-01')], '2026-12-01', null, TODAY)).toEqual([]);
    expect(periodNotices([{ ...approved(2, '2026-10-05', null), approvedAt: null }], '2026-12-01', null, TODAY)).toEqual([]);
    expect(periodNotices([approved(2, '2026-12-05', '2026-12-05')], '2026-12-01', null, TODAY)).toEqual([]);
  });

  it('warns of a first day in the past and an end that does not follow the start', () => {
    expect(periodNotices([], '2026-11-01', null, TODAY)).toEqual([{ kind: 'startPast' }]);
    expect(periodNotices([], '2026-12-01', '2026-12-01', TODAY)).toEqual([{ kind: 'endBeforeStart' }]);
  });
});

describe('who can make which move', () => {
  const draft = { status: 'DRAFT', phase: 'DRAFT', createdBy: 'maker', submittedBy: null, effectiveFrom: '2026-12-01' } as const;
  const submitted = { ...draft, status: 'SUBMITTED', phase: 'SUBMITTED', submittedBy: 'submitter' } as const;
  const context = { me: 'third', canManage: true, canApprove: true, today: '2026-11-08' };
  const names = (options: ReturnType<typeof movesOf>) => options.map((option) => `${option.move}:${option.allowed ? 'yes' : (option.block ?? 'no')}`);

  it('submits or discards a draft and needs the permission to write', () => {
    expect(names(movesOf(draft, context))).toEqual(['submit:yes', 'retire:yes']);
    expect(names(movesOf(draft, { ...context, canManage: false }))).toEqual(['submit:no', 'retire:no']);
  });

  it('lets only a third person approve a submitted version', () => {
    expect(names(movesOf(submitted, context))).toEqual(['withdraw:yes', 'approve:yes', 'retire:yes']);
    expect(names(movesOf(submitted, { ...context, me: 'maker' })).includes('approve:selfApproval')).toBe(true);
    expect(names(movesOf(submitted, { ...context, me: 'submitter' })).includes('approve:selfApproval')).toBe(true);
    expect(names(movesOf(submitted, { ...context, canApprove: false })).includes('approve:no')).toBe(true);
  });

  it('does not approve a version whose first day has passed', () => {
    expect(names(movesOf({ ...submitted, effectiveFrom: '2026-11-01' }, context)).includes('approve:startPassed')).toBe(true);
  });

  it('retires a version in force only for a person who can both write and approve, and has no move for one that ended', () => {
    const inForce = { ...draft, status: 'APPROVED', phase: 'IN_FORCE' } as const;
    expect(names(movesOf(inForce, context))).toEqual(['retire:yes']);
    expect(names(movesOf(inForce, { ...context, canApprove: false }))).toEqual(['retire:needsBoth']);
    expect(names(movesOf({ ...inForce, phase: 'ENDED' }, context))).toEqual([]);
    expect(names(movesOf({ ...draft, status: 'RETIRED', phase: 'ENDED' }, context))).toEqual([]);
  });
});

describe('what a refusal of the server means', () => {
  const refusal = (code: string, detail?: string) => describeRefusal(new ApiError({ status: 422, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) }));

  it('maps each code of the rule store to a refusal', () => {
    expect(refusal('SELF_APPROVAL_DENIED')).toEqual({ kind: 'selfApproval' });
    expect(refusal('GOVERNANCE_RULE_STATE_INVALID')).toEqual({ kind: 'state' });
    expect(refusal('GOVERNANCE_RULE_PERIOD_OVERLAP')).toEqual({ kind: 'overlap' });
    expect(refusal('GOVERNANCE_RULE_PARAMS_INVALID', 'bands[1].min')).toEqual({ kind: 'params', path: 'bands[1].min' });
    expect(refusal('VERSION_CONFLICT')).toEqual({ kind: 'conflict' });
    expect(refusal('GOVERNANCE_RULE_NOT_FOUND')).toEqual({ kind: 'notFound' });
    expect(refusal('VALIDATION_FAILED', 'reason')).toEqual({ kind: 'validation', field: 'reason' });
    expect(refusal('SCOPE_DENIED')).toEqual({ kind: 'denied' });
    expect(refusal('SESSION_EXPIRED')).toEqual({ kind: 'session' });
    expect(refusal('SOMETHING_ELSE')).toEqual({ kind: 'general' });
    expect(describeRefusal(new Error('x'))).toEqual({ kind: 'general' });
  });
});
