import type { EffectiveAccess, GrantView } from '../src/effective-access.ts';
import { homeScopeFingerprint, homeScopeHash, homeSnapshotState, homeTiles, signHomeContext, verifyHomeContext } from '../src/home.ts';
import type { RateFigures } from '../src/dis-rates.ts';

const KEY = Buffer.alloc(32, 7);
const TENANT = '00000000-0000-4000-8000-00000000000a';
const SNAPSHOT = '00000000-0000-4000-8000-0000000000f2';

const figures = (overrides: Partial<RateFigures> = {}): RateFigures => ({
  projects: 4,
  numeratorVnd: '600000000000',
  planPmVnd: '1000000000000',
  planLocalVnd: '250000000000',
  planTotalVnd: '1250000000000',
  reportedVnd: '610000000000',
  ctmtqgVnd: null,
  ratePmPct: '60.0000',
  rateTotalPct: '48.0000',
  rateNullReason: null,
  treasuryCoverage: 'COMPLETE',
  ...overrides,
});

describe('the tiles of the command center (ST-HOME-001, BR-HOME-01)', () => {
  it('AC-ST-HOME-001-1: gives the two rates side by side over the same numerator, each with its numerator, denominator, unit, formula and definition status', () => {
    const tiles = homeTiles(figures(), 'PROPOSED_PENDING_SIGNOFF');
    const rates = tiles.filter((tile) => tile.metricCode.startsWith('DISBURSEMENT_RATE'));
    expect(rates.map((tile) => [tile.metricCode, tile.value, tile.numerator, tile.denominator, tile.unit])).toEqual([
      ['DISBURSEMENT_RATE_PM', '60.0000', '600000000000', '1000000000000', 'PERCENT'],
      ['DISBURSEMENT_RATE_TOTAL', '48.0000', '600000000000', '1250000000000', 'PERCENT'],
    ]);
    for (const tile of tiles) {
      expect(tile.formula.length).toBeGreaterThan(5);
      expect(tile.definitionStatus).toBe('PROPOSED_PENDING_SIGNOFF');
      expect(tile.nullReason).toBeNull();
    }
    expect(tiles.map((tile) => tile.metricCode)).toEqual(['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY', 'PLAN_PM_ASSIGNED', 'PLAN_TOTAL']);
  });

  it('AC-ST-HOME-001-3: UAT-AC268 gives no figure, and says why, when the Treasury booked nothing: the disbursed amount and both rates are null with NO_DATA, never 0', () => {
    const tiles = homeTiles(figures({ numeratorVnd: null, ratePmPct: null, rateTotalPct: null, rateNullReason: 'NO_DATA', treasuryCoverage: 'NONE' }), 'SIGNED');
    const byCode = Object.fromEntries(tiles.map((tile) => [tile.metricCode, tile]));
    for (const code of ['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY']) {
      expect(byCode[code]).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    }
    // The plan is a figure of its own: it stays, and a zero is a zero.
    expect(byCode.PLAN_TOTAL).toMatchObject({ value: '1250000000000', nullReason: null });
  });

  it('carries the reason of a rate that cannot be made (a plan of nothing) on both rates, and keeps the amount that exists', () => {
    const tiles = homeTiles(figures({ planPmVnd: '0', planLocalVnd: '0', planTotalVnd: '0', ratePmPct: null, rateTotalPct: null, rateNullReason: 'ZERO_DENOMINATOR' }), 'SIGNED');
    expect(tiles.filter((tile) => tile.unit === 'PERCENT').map((tile) => [tile.value, tile.nullReason])).toEqual([
      [null, 'ZERO_DENOMINATOR'],
      [null, 'ZERO_DENOMINATOR'],
    ]);
    expect(tiles.find((tile) => tile.metricCode === 'DISBURSED_TREASURY')).toMatchObject({ value: '600000000000', nullReason: null });
  });
});

describe('the state of the snapshot a leader is shown (AC-ST-HOME-001-5)', () => {
  it('is empty without a frozen snapshot, stale when it is older than eight days, and fresh otherwise', () => {
    expect(homeSnapshotState(null, '2026-10-28')).toBe('EMPTY');
    expect(homeSnapshotState('2026-10-20', '2026-10-28')).toBe('FRESH');
    expect(homeSnapshotState('2026-10-19', '2026-10-28')).toBe('STALE');
    expect(homeSnapshotState('2026-10-28', '2026-10-28')).toBe('FRESH');
  });
});

describe('the context token of a tile (BR-HOME-02, AC-ST-HOME-002-3)', () => {
  const context = { tenantId: TENANT, snapshotId: SNAPSHOT, scopeHash: homeScopeHash({ membershipId: 'm1', scopeVersion: 3, unitId: null, grants: 'TENANT::' }), metricCode: 'DISBURSEMENT_RATE_PM', unitId: null };

  it('names the tenant, the snapshot, the scope and the metric, and is good for 30 minutes', () => {
    const token = signHomeContext(context, KEY, () => 1000);
    expect(verifyHomeContext(token, KEY, () => 1000 + 1799)).toEqual({ ...context, exp: 1000 + 1800 });
    expect(() => verifyHomeContext(token, KEY, () => 1000 + 1800)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED', status: 409 }));
  });

  it('refuses a token that was altered, signed with another key, or is not one, without saying which', () => {
    const token = signHomeContext(context, KEY, () => 1000);
    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), tenantId: '00000000-0000-4000-8000-00000000000b' })).toString('base64url');
    for (const bad of [`${forged}.${signature}`, token.slice(0, -2), 'x', '', `${payload}.`, signHomeContext(context, Buffer.alloc(32, 9), () => 1000)]) {
      expect(() => verifyHomeContext(bad, KEY, () => 1000)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }));
    }
  });

  it('is not a tenant context: a token of the workers is refused, and the purpose is part of what is signed', () => {
    // The same key signs the contexts of background work; a token of one kind never passes for the other.
    const worker = Buffer.from(JSON.stringify({ tenantId: TENANT, membershipId: 'm', scopeVersion: 0, exp: 9999999999 })).toString('base64url');
    expect(() => verifyHomeContext(`${worker}.AAAA`, KEY, () => 1000)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('hashes the scope of the person, so that a token cannot be used by another scope', () => {
    const base = { membershipId: 'm1', scopeVersion: 3, unitId: null, grants: 'TENANT::' };
    expect(homeScopeHash(base)).toBe(homeScopeHash({ ...base }));
    expect(homeScopeHash(base)).not.toBe(homeScopeHash({ ...base, membershipId: 'm2' }));
    expect(homeScopeHash(base)).not.toBe(homeScopeHash({ ...base, scopeVersion: 4 }));
    expect(homeScopeHash(base)).not.toBe(homeScopeHash({ ...base, unitId: '00000000-0000-4000-8000-000000000501' }));
    expect(homeScopeHash(base)).not.toBe(homeScopeHash({ ...base, grants: 'UNIT_SUBTREE:u1:/a/' }));
  });
});

describe('what the grants let a person read now (the scope fingerprint)', () => {
  const NOW = new Date('2027-10-15T03:00:00Z');
  const grant = (kind: string, refIds: string[], overrides: Partial<GrantView> = {}): GrantView => ({ roleCode: 'R', rank: 1, permissions: ['home.read'], scope: { kind, refIds, paths: kind === 'UNIT_SUBTREE' ? refIds.map((id) => `/${id}/`) : undefined } as GrantView['scope'], status: 'Active', effectiveFrom: new Date('2027-01-01T00:00:00Z'), effectiveUntil: null, ...overrides });
  const access = (grants: GrantView[]): EffectiveAccess => ({ membershipId: 'm1', scopeVersion: 3, membershipActive: true, grants });

  it('changes when a grant that counted stops counting or one that did not begins to, although the version of the grants stays', () => {
    const broad = grant('TENANT', [], { effectiveUntil: new Date('2027-10-15T00:00:00Z') });
    const narrow = grant('UNIT_SUBTREE', ['u1']);
    const before = homeScopeFingerprint(access([broad, narrow]), 'home.read', new Date('2027-10-14T03:00:00Z'));
    const after = homeScopeFingerprint(access([broad, narrow]), 'home.read', NOW);
    expect(before).not.toBe(after);
    expect(after).toBe(homeScopeFingerprint(access([narrow]), 'home.read', NOW));
    const later = grant('UNIT_ONLY', ['u2'], { effectiveFrom: new Date('2027-10-16T00:00:00Z') });
    expect(homeScopeFingerprint(access([narrow, later]), 'home.read', NOW)).not.toBe(homeScopeFingerprint(access([narrow, later]), 'home.read', new Date('2027-10-17T00:00:00Z')));
  });

  it('counts only the grants that carry the permission, the active ones, the same whatever the order they are listed in', () => {
    const other = grant('TENANT', [], { permissions: ['dis.read'] });
    const revoked = grant('TENANT', [], { status: 'Revoked' });
    const one = grant('UNIT_SUBTREE', ['u1']);
    const two = grant('UNIT_ONLY', ['u2']);
    expect(homeScopeFingerprint(access([one, two, other, revoked]), 'home.read', NOW)).toBe(homeScopeFingerprint(access([two, one]), 'home.read', NOW));
    expect(homeScopeFingerprint({ ...access([one]), membershipActive: false }, 'home.read', NOW)).toBe('');
  });
});
