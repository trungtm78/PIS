import { randomBytes } from 'node:crypto';
import { DomainError } from '../src/errors.ts';
import { BI_DRILL_TTL_SECONDS, biScopeHash, expiredBiDrill, figureOf, measurePlanOf, parseBiDrill, queryCacheKey, reconcile, signBiDrill } from '../src/bi-query.ts';
import type { MeasurePlan } from '../src/bi-query.ts';
import type { MetricNode } from '../src/bi-metric.ts';

const field = (name: string): MetricNode => ({ op: 'field', name });
const call = (op: string, name: string): MetricNode => ({ op, args: [field(name)] });
const RATIO = { aggregationType: 'ratio' as const, expressionAst: { op: 'div', args: [] } as MetricNode, numeratorAst: call('sum', 'GIAI_NGAN'), denominatorAst: call('sum', 'KE_HOACH_TTG') };
const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const sums = (numerator: string | null, denominator: string | null = null, distinctCount: string | null = null) => ({ numerator, denominator, distinct: distinctCount });

describe('what a metric needs of the snapshot lines (ST-BI-004, BI F3)', () => {
  it('AC-ST-BI-004-2: UAT-AC32 reads a ratio as the sum of one field over the sum of another, an additive metric as a sum and a distinct one as a count apart', () => {
    expect(measurePlanOf(RATIO)).toEqual({ kind: 'RATIO', numeratorColumn: 'disbursed_treasury_vnd', denominatorColumn: 'plan_pm_assigned_vnd', nullPolicy: 'NULL_NOT_ZERO' });
    expect(measurePlanOf({ ...RATIO, aggregationType: 'additive', expressionAst: call('sum', 'GIAI_NGAN'), numeratorAst: null, denominatorAst: null })).toEqual({ kind: 'ADDITIVE', numeratorColumn: 'disbursed_treasury_vnd', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' });
    expect(measurePlanOf({ ...RATIO, aggregationType: 'semi_additive', expressionAst: call('sum', 'KE_HOACH_TONG'), numeratorAst: null, denominatorAst: null }).kind).toBe('ADDITIVE');
    expect(measurePlanOf({ ...RATIO, aggregationType: 'distinct', expressionAst: call('count_distinct', 'DU_AN'), numeratorAst: null, denominatorAst: null })).toEqual({ kind: 'DISTINCT', numeratorColumn: 'project_id', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' });
  });

  it('refuses a metric that reads a field the dataset does not have or is built another way', () => {
    for (const metric of [
      { ...RATIO, numeratorAst: call('sum', 'ACCOUNT_NO') },
      { ...RATIO, denominatorAst: call('count', 'GIAI_NGAN') },
      { ...RATIO, numeratorAst: null },
      { ...RATIO, aggregationType: 'additive' as const, expressionAst: call('count_distinct', 'DU_AN') },
      { ...RATIO, aggregationType: 'distinct' as const, expressionAst: call('sum', 'GIAI_NGAN') },
      // An identifier is counted, never added: sum(uuid) would be an error of the database.
      { ...RATIO, aggregationType: 'additive' as const, expressionAst: call('sum', 'DU_AN'), numeratorAst: null, denominatorAst: null },
      { ...RATIO, numeratorAst: call('sum', 'DON_VI') },
    ]) {
      expect(thrown(() => measurePlanOf(metric))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'metric_version_id' });
    }
  });
});

describe('the figure of a group', () => {
  const ratio: MeasurePlan = { kind: 'RATIO', numeratorColumn: 'a', denominatorColumn: 'b', nullPolicy: 'NULL_NOT_ZERO' };
  const additive: MeasurePlan = { kind: 'ADDITIVE', numeratorColumn: 'a', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' };
  const distinct: MeasurePlan = { kind: 'DISTINCT', numeratorColumn: 'a', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' };

  it('AC-ST-BI-004-2: UAT-AC32 makes the ratio from the sums (10.5 over 30 is 35.00%), is NOT_APPLICABLE over a denominator of zero and NO_DATA without a figure, never 0', () => {
    expect(figureOf(ratio, sums('10500000000', '30000000000'))).toEqual({ value: '35.00', numerator: '10500000000', denominator: '30000000000', nullReason: null });
    expect(figureOf(ratio, sums('0', '0'))).toMatchObject({ value: null, nullReason: 'NOT_APPLICABLE' });
    expect(figureOf(ratio, sums(null, null))).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(figureOf(ratio, sums('5', null))).toMatchObject({ value: null, nullReason: 'NO_DATA' });
  });

  it('takes the null policy of the metric: no line at all is zero when the metric says so, and lines with no figure are still no data', () => {
    const zero = (kind: MeasurePlan['kind']): MeasurePlan => ({ kind, numeratorColumn: 'a', denominatorColumn: kind === 'RATIO' ? 'b' : null, nullPolicy: 'ZERO_IF_NO_ROWS' });
    expect(figureOf(zero('ADDITIVE'), { ...sums(null), lines: '0' })).toEqual({ value: '0', numerator: null, denominator: null, nullReason: null });
    expect(figureOf(zero('DISTINCT'), { ...sums(null, null, null), lines: '0' }).value).toBe('0');
    expect(figureOf(zero('RATIO'), { ...sums(null, null), lines: '0' })).toEqual({ value: '0.00', numerator: '0', denominator: '0', nullReason: null });
    expect(figureOf(zero('ADDITIVE'), { ...sums(null), lines: '3' })).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(figureOf({ ...zero('ADDITIVE'), nullPolicy: 'NULL_NOT_ZERO' }, { ...sums(null), lines: '0' })).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(measurePlanOf({ ...RATIO, nullPolicy: 'ZERO_IF_NO_ROWS' }).nullPolicy).toBe('ZERO_IF_NO_ROWS');
    expect(measurePlanOf(RATIO).nullPolicy).toBe('NULL_NOT_ZERO');
  });

  it('gives an additive figure and a distinct count as they are, and no data as null', () => {
    expect(figureOf(additive, sums('4')).value).toBe('4');
    expect(figureOf(additive, sums(null))).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(figureOf(distinct, sums(null, null, '3')).value).toBe('3');
    expect(figureOf(distinct, sums(null, null, null))).toMatchObject({ value: null, nullReason: 'NO_DATA' });
  });

  it('AC-ST-BI-004-2 and -6: reconciles additive children (with Unclassified) and the sums of a ratio, and not a distinct count that one thing is in two groups of', () => {
    expect(reconcile(additive, [sums('4'), sums('6'), sums('0'), sums('1')], sums('11'))).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcile(additive, [sums('4'), sums('6')], sums('11'))).toEqual({ reconcilesToParent: false, nonAdditiveReason: 'CHILDREN_DO_NOT_ADD_UP' });
    expect(reconcile(ratio, [sums('4', '10'), sums('6', '20')], sums('10', '30'))).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcile(ratio, [sums('4', '10'), sums('6', '20')], sums('10', '31')).reconcilesToParent).toBe(false);
    expect(reconcile(distinct, [sums(null, null, '1'), sums(null, null, '1')], sums(null, null, '1'))).toEqual({ reconcilesToParent: false, nonAdditiveReason: 'DISTINCT_NOT_ADDITIVE' });
    expect(reconcile(distinct, [sums(null, null, '1'), sums(null, null, '2')], sums(null, null, '3')).reconcilesToParent).toBe(true);
  });
});

describe('the token of a drill (BI BR-BI-06)', () => {
  const root = randomBytes(32);
  const claims = { tid: 'tenant-a', ctx_id: 'ctx-1', scope_hash: 'h'.repeat(64), metric_version_id: 'm-1', snapshot_id: 's-1', as_of_period: '2026-10' };

  it('AC-ST-BI-004-3: UAT-AC33 carries ids only, is good for 30 minutes and is read back under the key of the tenant it names', () => {
    const token = signBiDrill(claims, root, '1', () => 1000);
    const read = parseBiDrill(token, root);
    expect(read).toEqual({ v: 1, ...claims, iat: 1000, exp: 1000 + BI_DRILL_TTL_SECONDS, kid: '1' });
    expect(JSON.stringify(read)).not.toMatch(/name|vnd/i);
    expect(expiredBiDrill(read)).toMatchObject({ code: 'SNAPSHOT_EXPIRED', status: 409, extensions: { snapshot_id: 's-1', as_of_period: '2026-10' } });
  });

  it('AC-ST-BI-004-3: UAT-AC33 refuses with 400 DRILL_TOKEN_INVALID a token that was altered, signed with another key or for another tenant, and what is not a token', () => {
    const token = signBiDrill(claims, root, '1');
    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), tid: 'tenant-b' })).toString('base64url');
    const otherKey = signBiDrill(claims, randomBytes(32), '1');
    const otherKid = signBiDrill(claims, root, '2').split('.');
    const bad = [
      `${forged}.${signature}`,
      otherKey,
      `${otherKid[0]}.${signature}`,
      `${payload}.${signature.slice(0, -2)}AA`,
      payload,
      'x.y',
      '',
      `${payload}.${signature}.extra`,
      'a'.repeat(2001),
      `${Buffer.from('{"v":2}').toString('base64url')}.${signature}`,
      `${Buffer.from('null').toString('base64url')}.${signature}`,
      `${Buffer.from('not json').toString('base64url')}.${signature}`,
    ];
    for (const candidate of bad) expect(thrown(() => parseBiDrill(candidate, root))).toMatchObject({ code: 'DRILL_TOKEN_INVALID', status: 400 });
  });

  it('refuses a key that is too short', () => {
    expect(() => signBiDrill(claims, randomBytes(8), '1')).toThrow('key too short');
  });
});

describe('what a cached answer is shared by (BI BR-BI-07)', () => {
  it('AC-ST-BI-004-5: UAT-AC479 differs by tenant and by scope, and by snapshot, filters and metric', () => {
    const scope = (membershipId: string, scopeVersion: number, grants: string) => biScopeHash({ membershipId, scopeVersion, grants });
    const base = { tenantId: 'a', metricVersionIds: ['m2', 'm1'], filtersHash: 'f', snapshotId: 's', scopeHash: scope('u', 1, 'TENANT') };
    const key = queryCacheKey(base);
    expect(key).toBe(queryCacheKey({ ...base, metricVersionIds: ['m1', 'm2'] }));
    for (const change of [{ tenantId: 'b' }, { filtersHash: 'g' }, { snapshotId: 't' }, { metricVersionIds: ['m1'] }, { scopeHash: scope('u', 1, 'UNIT:u1') }, { scopeHash: scope('v', 1, 'TENANT') }, { scopeHash: scope('u', 2, 'TENANT') }]) {
      expect(queryCacheKey({ ...base, ...change })).not.toBe(key);
    }
    expect(key.startsWith('t:a:bi:')).toBe(true);
  });
});
