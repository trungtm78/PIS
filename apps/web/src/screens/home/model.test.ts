import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { amountTiles, countTileOf, describeCommandCenter, drillPathOf, figureReason, figureText, hasNewSnapshot, ratePair, shortId, toCommandCenter } from './model';

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

describe('the text of a figure is the text of the server (G0-4)', () => {
  const kpi = { code: 'DISBURSEMENT_RATE_PM', name: 'Tỷ lệ giải ngân', formula: 'a / b', numerator: 'a', denominator: 'b', exclusions: ['x'], unit: 'PERCENT', period: 'YEAR', source: 'Kho bạc', owner: 'Vụ KH', allowedLagDays: 8, version: 0, effectiveFrom: null, effectiveTo: null, origin: 'DEFAULT', unverified: true, asOf: '2027-10-12', snapshotId: null };
  const certification = { status: 'CERTIFIED', version: 2, origin: 'TENANT', certified_by: 'Lan', at: '2027-10-01T00:00:00Z' };

  it('agrees with display_value for every tile, whatever value says: the web never re-formats value', () => {
    const center = toCommandCenter(
      body({
        tiles: [tile('DISBURSEMENT_RATE_PM', { value: '60.0000', display_value: '60.00' }), tile('DISBURSED_TREASURY', { unit: 'VND', value: '600000000000', display_value: '600000000000' }), tile('PLAN_TOTAL', { unit: 'VND', value: '1250.5', display_value: '1251' })],
      }),
    );
    for (const each of center?.tiles ?? []) expect(figureText(each)).toBe(each.displayValue);
    expect(center?.tiles.map((each) => figureText(each))).toEqual(['60.00', '600000000000', '1251']);
  });

  it('never turns a missing display value into 0: an explicit null stays null and says why in the words it is given', () => {
    const center = toCommandCenter(body({ tiles: [tile('DISBURSEMENT_RATE_PM', { value: null, display_value: null, null_reason: 'NOT_CERTIFIED', flags: ['NOT_CERTIFIED'] })] }));
    const held = center?.tiles[0];
    expect(held?.displayValue).toBeNull();
    expect(figureText(held as never)).not.toBe('0');
    expect(figureText(held as never, 'Chưa chứng nhận')).toBe('Chưa chứng nhận');
    expect(figureReason(held as never)).toBe('NOT_CERTIFIED');
    // Even when the server still sent a value beside a null text, the text stays null.
    expect(toCommandCenter(body({ tiles: [tile('DISBURSEMENT_RATE_PM', { value: '60.0000', display_value: null })] }))?.tiles[0]?.displayValue).toBeNull();
  });

  it('falls back to value only for an answer that has no display_value at all (an older server)', () => {
    expect(toCommandCenter(body())?.tiles[0]?.displayValue).toBe('60.0000');
  });

  it('gives the reason from the flags when the server named none, and no data at last', () => {
    expect(figureReason({ nullReason: null, flags: ['STALE', 'OBSOLETE'] })).toBe('OBSOLETE');
    expect(figureReason({ nullReason: null, flags: [] })).toBe('NO_DATA');
  });

  it('reads the flags (those it knows, in the order given), the certification and the definition behind the "i"', () => {
    const read = toCommandCenter(body({ tiles: [tile('DISBURSEMENT_RATE_PM', { display_value: '60.00', flags: ['STALE', 'MYSTERY', 'UNVERIFIED_DEFINITION'], certification, kpi })] }))?.tiles[0];
    expect(read?.flags).toEqual(['STALE', 'UNVERIFIED_DEFINITION']);
    expect(read?.certification).toEqual({ status: 'CERTIFIED', version: 2, origin: 'TENANT', certifiedBy: 'Lan', at: '2027-10-01T00:00:00Z' });
    expect(read?.kpi).toMatchObject({ code: 'DISBURSEMENT_RATE_PM', name: 'Tỷ lệ giải ngân', origin: 'DEFAULT', version: 0, unverified: true, asOf: '2027-10-12', exclusions: ['x'] });
    expect(toCommandCenter(body())?.tiles[0]).toMatchObject({ flags: [], certification: null, kpi: null });
  });

  it('reads the three waiting counts as figures, and builds them from the numbers when the server sent none', () => {
    const counted = toCommandCenter(body({ count_tiles: [{ metric_code: 'OPEN_WARNINGS', value: '3', display_value: '3', unit: 'COUNT', formula: 'n', flags: [], kpi }, { metric_code: 'OVERDUE_EXPLANATIONS', value: null, display_value: null, null_reason: 'NOT_CERTIFIED', unit: 'COUNT', formula: 'n', flags: ['NOT_CERTIFIED'] }] }));
    expect(counted?.countTiles.map((each) => each.metricCode)).toEqual(['OPEN_WARNINGS', 'OVERDUE_EXPLANATIONS', 'PENDING_REALLOCATIONS']);
    expect(counted?.countTiles[0]).toMatchObject({ displayValue: '3', unit: 'COUNT', contextToken: '' });
    expect(counted?.countTiles[0]?.kpi?.code).toBe('DISBURSEMENT_RATE_PM');
    expect(counted?.countTiles[1]?.displayValue).toBeNull();
    // The third was not sent: it is the number counted, with nothing behind it.
    expect(counted?.countTiles[2]).toMatchObject({ displayValue: '1', kpi: null });
    expect(toCommandCenter(body())?.countTiles.map((each) => each.displayValue)).toEqual(['3', '2', '1']);
    expect(countTileOf(counted?.countTiles ?? [], 'PENDING_REALLOCATIONS')?.metricCode).toBe('PENDING_REALLOCATIONS');
  });
});
