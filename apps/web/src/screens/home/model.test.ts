import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { amountTiles, describeCommandCenter, drillPathOf, hasNewSnapshot, ratePair, shortId, toCommandCenter } from './model';

const tile = (code: string, overrides: Record<string, unknown> = {}) => ({ metric_code: code, value: '60.0000', numerator: '1', denominator: '2', null_reason: null, unit: 'PERCENT', formula: 'a / b', definition_status: 'PROPOSED_PENDING_SIGNOFF', context_token: 'x.y', ...overrides });
const body = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: '00000000-0000-4000-8000-0000000000f2',
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: ['CXN-03'],
  scope: { unit_id: null, projects: 2 },
  tiles: [tile('DISBURSEMENT_RATE_PM'), tile('DISBURSEMENT_RATE_TOTAL', { value: '48.0000' }), tile('DISBURSED_TREASURY', { unit: 'VND', value: '600', numerator: null, denominator: null }), tile('PLAN_TOTAL', { unit: 'VND', value: '1250' })],
  projects_without_data: 1,
  open_warnings: 3,
  overdue_explanations: 2,
  pending_reallocations: 1,
  quality_badge: 'NOT_ASSESSED',
  ...overrides,
});

describe('the command center as the screen reads it (ST-HOME-001, BR-HOME-01)', () => {
  it('reads the snapshot, the day, the scope, the tiles and the counts', () => {
    const center = toCommandCenter(body());
    expect(center).toMatchObject({ asOfDate: '2027-10-12', freshness: 'FRESH', legalRefs: ['CXN-03'], scope: { unitId: null, projects: 2 }, projectsWithoutData: 1, openWarnings: 3, overdueExplanations: 2, pendingReallocations: 1, qualityBadge: 'NOT_ASSESSED' });
    expect(center?.tiles.map((each) => each.metricCode)).toEqual(['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY', 'PLAN_TOTAL']);
  });

  it('does not read an answer that lacks what makes a figure citable: the snapshot, the day, the definition or the scope', () => {
    for (const bad of [null, [], {}, body({ snapshot_id: '' }), body({ as_of_date: undefined }), body({ definition_status: '' }), body({ scope: undefined }), body({ freshness: 'SOON' })]) expect(toCommandCenter(bad)).toBeUndefined();
  });

  it('leaves out a tile that has no formula, unit or token, and keeps a quality that is not named as not assessed', () => {
    const center = toCommandCenter(body({ tiles: [tile('A', { formula: '' }), tile('B', { context_token: '' }), tile('C', { unit: 'EUR' }), tile('D')], quality_badge: 'SURPRISE' }));
    expect(center?.tiles.map((each) => each.metricCode)).toEqual(['D']);
    expect(center?.qualityBadge).toBe('NOT_ASSESSED');
  });

  it('gives the two rates as a pair or not at all, and the amounts apart', () => {
    const center = toCommandCenter(body());
    expect(ratePair(center as never)).toMatchObject({ pm: { value: '60.0000' }, total: { value: '48.0000' } });
    expect(ratePair({ tiles: center?.tiles.filter((each) => each.metricCode !== 'DISBURSEMENT_RATE_TOTAL') ?? [] })).toBeUndefined();
    expect(amountTiles(center as never).map((each) => each.metricCode)).toEqual(['DISBURSED_TREASURY', 'PLAN_TOTAL']);
  });

  it('keeps a missing figure null with its reason, and a count that is not a number as nothing', () => {
    const center = toCommandCenter(body({ tiles: [tile('DISBURSED_TREASURY', { unit: 'VND', value: null, null_reason: 'NO_DATA' })], open_warnings: 'many' }));
    expect(center?.tiles[0]).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(center?.openWarnings).toBe(0);
  });
});

describe('what a failure of the command center is', () => {
  const fail = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
  it('names nothing frozen, a snapshot not frozen, a unit that is not the reader\'s, a figure that cannot be given and a bad request, apart from a failure', () => {
    expect([fail(404, 'RESOURCE_NOT_FOUND'), fail(422, 'SNAPSHOT_NOT_FROZEN'), fail(403, 'SCOPE_DENIED'), fail(422, 'METRIC_UNAVAILABLE'), fail(422, 'VALIDATION_FAILED'), fail(500, 'INTERNAL_ERROR'), new Error('x')].map(describeCommandCenter)).toEqual([
      'noSnapshot',
      'notFrozen',
      'unitDenied',
      'unavailable',
      'validation',
      'general',
      'general',
    ]);
  });
});

describe('the helpers of the screen', () => {
  it('offers a refresh only when the latest snapshot is not the one on the screen', () => {
    expect(hasNewSnapshot('a', 'a')).toBe(false);
    expect(hasNewSnapshot('a', 'b')).toBe(true);
    expect(hasNewSnapshot(undefined, 'b')).toBe(false);
    expect(hasNewSnapshot('a', undefined)).toBe(false);
  });

  it('shortens an id to what can be cited and builds the drill path from the token only', () => {
    expect(shortId('00000000-0000-4000-8000-0000000000f2')).toBe('00000000…00f2');
    expect(shortId('abc')).toBe('abc');
    expect(drillPathOf({ contextToken: 'a.b+c' })).toBe('/home/home-10?token=a.b%2Bc');
  });
});
