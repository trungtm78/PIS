import { DECLARED_FLAGS, FLAG_STATUSES, assertFlagChangeable, assertFlagUpdate, flagEnabled, rolloutBucket, rolloutNamesAnyone } from '../src/feature-flag';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const REASON = 'Staged rollout to the pilot cohort';

describe('the release flags (ST-SAS-020, SAS 3.11)', () => {
  it('declares flags with a key the code owns', () => {
    expect(DECLARED_FLAGS.map((flag) => flag.key)).toEqual(['sas.silo_promotion', 'sas.tenant_restore_in_place']);
    expect(new Set(DECLARED_FLAGS.map((flag) => flag.key)).size).toBe(DECLARED_FLAGS.length);
    expect(FLAG_STATUSES).toEqual(['Off', 'Rollout', 'On', 'Retired']);
  });

  it('takes a rollout that names a cohort, tenants or a share, and keeps it in order without repeats', () => {
    expect(assertFlagUpdate({ status: 'Rollout', rollout: { tenant_cohorts: ['pilot', 'vn-south', 'pilot'], tenant_ids: [B, A.toUpperCase(), A], percentage: 10 }, reason: ` ${REASON} ` })).toEqual({
      status: 'Rollout',
      rollout: { cohorts: ['pilot', 'vn-south'], tenantIds: [A, B], percentage: 10 },
      reason: REASON,
    });
    expect(assertFlagUpdate({ status: 'Rollout', rollout: { percentage: 5 }, reason: REASON }).rollout).toEqual({ cohorts: [], tenantIds: [], percentage: 5 });
    expect(rolloutNamesAnyone({ cohorts: [], tenantIds: [], percentage: 0 })).toBe(false);
    expect(rolloutNamesAnyone({ cohorts: ['pilot'], tenantIds: [], percentage: 0 })).toBe(true);
  });

  it('refuses a rollout that names no one, a status that carries one, and a body that is not a rollout (422 FLAG_RULE_INVALID)', () => {
    const detail = (raw: Record<string, unknown>) => refusal(() => assertFlagUpdate({ reason: REASON, ...raw }));
    expect(detail({ status: 'Rollout' })).toEqual({ code: 'FLAG_RULE_INVALID', detail: 'rollout', status: 422 });
    expect(detail({ status: 'Rollout', rollout: { percentage: 0 } }).detail).toBe('rollout');
    expect(detail({ status: 'Rollout', rollout: {} }).detail).toBe('rollout');
    for (const status of ['Off', 'On', 'Retired']) {
      expect(detail({ status, rollout: { tenant_cohorts: ['pilot'] } }).detail).toBe('rollout');
      expect(detail({ status, rollout: { percentage: 50 } }).detail).toBe('rollout');
      expect(assertFlagUpdate({ status, reason: REASON }).rollout).toEqual({ cohorts: [], tenantIds: [], percentage: 0 });
      expect(assertFlagUpdate({ status, rollout: {}, reason: REASON }).status).toBe(status);
    }
    expect(detail({ status: 'Sometimes' }).detail).toBe('status');
    expect(detail({ status: 'Rollout', rollout: 'all' }).detail).toBe('rollout');
    expect(detail({ status: 'Rollout', rollout: [] }).detail).toBe('rollout');
    expect(detail({ status: 'Rollout', rollout: { unknown: 1, percentage: 5 } }).detail).toBe('rollout.unknown');
    for (const cohorts of ['pilot', ['Pilot'], ['p'], [5], Array.from({ length: 21 }, (_, n) => `c${n}x`)]) expect(detail({ status: 'Rollout', rollout: { tenant_cohorts: cohorts } }).detail).toBe('rollout.tenant_cohorts');
    for (const ids of ['x', ['x'], [5], Array.from({ length: 501 }, () => A)]) expect(detail({ status: 'Rollout', rollout: { tenant_ids: ids } }).detail).toBe('rollout.tenant_ids');
    for (const percentage of [-1, 101, 5.5, '5']) expect(detail({ status: 'Rollout', rollout: { percentage } }).detail).toBe('rollout.percentage');
    for (const reason of [undefined, 'short', 'x'.repeat(2001), 5]) expect(detail({ status: 'On', reason }).detail).toBe('reason');
  });

  it('changes a flag that is not retired and no flag that is', () => {
    for (const status of ['Off', 'Rollout', 'On'] as const) expect(() => assertFlagChangeable(status)).not.toThrow();
    expect(refusal(() => assertFlagChangeable('Retired'))).toEqual({ code: 'FLAG_RULE_INVALID', detail: 'status', status: 422 });
  });

  it('UAT-AC170: a flag in rollout is on for a tenant named, a cohort named and a share, and off for the others; Off and Retired are off, On is on', () => {
    const rollout = { cohorts: ['pilot'], tenantIds: [A], percentage: 0 };
    const flag = { key: 'sas.silo_promotion', status: 'Rollout' as const, rollout };
    expect(flagEnabled(flag, { id: A, region: 'vn-south' })).toBe(true);
    expect(flagEnabled(flag, { id: A.toUpperCase(), region: 'vn-south' })).toBe(true);
    expect(flagEnabled(flag, { id: B, region: 'pilot' })).toBe(true);
    expect(flagEnabled(flag, { id: B, region: 'vn-south' })).toBe(false);
    expect(flagEnabled({ ...flag, status: 'Off' }, { id: A, region: 'pilot' })).toBe(false);
    expect(flagEnabled({ ...flag, status: 'Retired' }, { id: A, region: 'pilot' })).toBe(false);
    expect(flagEnabled({ ...flag, status: 'On', rollout: { cohorts: [], tenantIds: [], percentage: 0 } }, { id: B, region: 'vn-south' })).toBe(true);
  });

  it('puts a tenant in a share by a stable bucket: the same tenant stays in as the share grows, none at 0 and all at 100', () => {
    const bucket = rolloutBucket('sas.silo_promotion', A);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(rolloutBucket('sas.silo_promotion', A)).toBe(bucket);
    expect(rolloutBucket('sas.silo_promotion', A.toUpperCase())).toBe(bucket);
    const state = (percentage: number) => ({ key: 'sas.silo_promotion', status: 'Rollout' as const, rollout: { cohorts: [], tenantIds: [], percentage } });
    expect(flagEnabled(state(0), { id: A, region: 'x' })).toBe(false);
    expect(flagEnabled(state(100), { id: A, region: 'x' })).toBe(true);
    expect(flagEnabled(state(bucket), { id: A, region: 'x' })).toBe(false);
    expect(flagEnabled(state(bucket + 1), { id: A, region: 'x' })).toBe(true);
    const tenants = Array.from({ length: 2000 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    const share = tenants.filter((id) => flagEnabled(state(30), { id, region: 'x' })).length / tenants.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.35);
    // A different flag draws its own tenants.
    expect(tenants.filter((id) => rolloutBucket('a.flag', id) !== rolloutBucket('b.flag', id)).length).toBeGreaterThan(1500);
  });
});
