import { describe, expect, it } from '@jest/globals';
import {
  MIGRATION_STATUSES,
  MIGRATION_TRANSITIONS,
  assertCutoverApproved,
  assertSiloPromotable,
  assertStartAccepted,
  freezeEndsAt,
  freezeOver,
  isOpenMigration,
  isReportFresh,
  mayPurgeSource,
  nextMigrationStatus,
  observationEndsAt,
  reconcileCopy,
  reportReference,
  sameAmount,
  sourcePurgeDueAt,
  startDefect,
  verificationReport,
  workerStep,
} from '../src/index.ts';
import type { MigrationStatus, TableMeasure, WorkerFacts } from '../src/index.ts';

const NOW = new Date('2026-11-03T03:00:00Z');
const minutes = (n: number, from = NOW): Date => new Date(from.getTime() + n * 60_000);
const ADMIN = '00000000-0000-4000-8000-0000000000f2';
const OTHER = '00000000-0000-4000-8000-0000000000f3';

const measure = (table: string, rows: number, checksum: string, money: Record<string, string> = {}): TableMeasure => ({ table, rows, checksum, money });
const SOURCE = [measure('invoice', 3, '1000000000000000000000001', { total_vnd: '120000000000000000000000' }), measure('member', 2, '-77')];

describe('the states of a placement migration (ST-SAS-018)', () => {
  it('moves forward Planned, Copying, Verifying, AwaitingCutover, CutoverFrozen, Switched, Completed', () => {
    let status: MigrationStatus = 'Planned';
    for (const action of ['copy', 'copied', 'verified', 'approve', 'switch', 'complete'] as const) status = nextMigrationStatus(status, action);
    expect(status).toBe('Completed');
  });

  it('refuses every move that is not on the way with 409 MIGRATION_STATE_INVALID, naming the status and the action', () => {
    expect(() => nextMigrationStatus('Planned', 'approve')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID', status: 409, detail: 'Planned->approve' }));
    expect(() => nextMigrationStatus('Copying', 'approve')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }));
    expect(() => nextMigrationStatus('Verifying', 'approve')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }));
    expect(() => nextMigrationStatus('CutoverFrozen', 'approve')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }));
    expect(() => nextMigrationStatus('AwaitingCutover', 'switch')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }));
    expect(() => nextMigrationStatus('Switched', 'copy')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }));
  });

  it('AC-ST-SAS-018-2 UAT-AC151: an abort before the cutover is Aborted, once writes were frozen or the routing switched it is RolledBack, and an ended migration cannot be aborted', () => {
    for (const status of ['Planned', 'Copying', 'Verifying', 'AwaitingCutover'] as const) expect(nextMigrationStatus(status, 'abort')).toBe('Aborted');
    for (const status of ['CutoverFrozen', 'Switched'] as const) expect(nextMigrationStatus(status, 'abort')).toBe('RolledBack');
    for (const status of ['Completed', 'Aborted', 'RolledBack'] as const) expect(() => nextMigrationStatus(status, 'abort')).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID', status: 409 }));
  });

  it('lists as transitions for the database exactly the moves the rules allow, and no move out of an ended migration', () => {
    expect(MIGRATION_TRANSITIONS).toContainEqual(['AwaitingCutover', 'CutoverFrozen']);
    expect(MIGRATION_TRANSITIONS).toContainEqual(['CutoverFrozen', 'RolledBack']);
    expect(MIGRATION_TRANSITIONS).toContainEqual(['Planned', 'Aborted']);
    expect(MIGRATION_TRANSITIONS).not.toContainEqual(['Planned', 'RolledBack']);
    expect(MIGRATION_TRANSITIONS.some(([from]) => !isOpenMigration(from))).toBe(false);
    expect(MIGRATION_TRANSITIONS).toHaveLength(6 + 4 + 2);
    expect(new Set(MIGRATION_STATUSES).size).toBe(9);
  });
});

describe('the start of a promotion', () => {
  const ok = { writeFreezeMaxMinutes: 30, plannedWindowStart: minutes(60), reason: 'The tenant asked for a database of its own.' };

  it('accepts a freeze of 5 to 240 minutes, a window that is not far past or ahead, and a reason of 10 to 2000 characters', () => {
    expect(startDefect(ok, NOW)).toBeUndefined();
    expect(() => assertStartAccepted(ok, NOW)).not.toThrow();
    expect(startDefect({ ...ok, writeFreezeMaxMinutes: 5 }, NOW)).toBeUndefined();
    expect(startDefect({ ...ok, writeFreezeMaxMinutes: 240 }, NOW)).toBeUndefined();
    expect(startDefect({ ...ok, plannedWindowStart: minutes(-5) }, NOW)).toBeUndefined();
    expect(startDefect({ ...ok, reason: '0123456789' }, NOW)).toBeUndefined();
    expect(startDefect({ ...ok, reason: 'x'.repeat(2000) }, NOW)).toBeUndefined();
  });

  it('names the first field that cannot be accepted, with 422 VALIDATION_FAILED', () => {
    for (const bad of [4, 241, 30.5, Number.NaN]) expect(startDefect({ ...ok, writeFreezeMaxMinutes: bad }, NOW)).toBe('write_freeze_max_minutes');
    expect(startDefect({ ...ok, plannedWindowStart: minutes(-6) }, NOW)).toBe('planned_window_start');
    expect(startDefect({ ...ok, plannedWindowStart: new Date(NOW.getTime() + 91 * 86_400_000) }, NOW)).toBe('planned_window_start');
    expect(startDefect({ ...ok, plannedWindowStart: undefined }, NOW)).toBe('planned_window_start');
    expect(startDefect({ ...ok, plannedWindowStart: new Date('nope') }, NOW)).toBe('planned_window_start');
    expect(startDefect({ ...ok, reason: '   short   ' }, NOW)).toBe('reason');
    expect(startDefect({ ...ok, reason: 'x'.repeat(2001) }, NOW)).toBe('reason');
    expect(() => assertStartAccepted({ ...ok, writeFreezeMaxMinutes: 3 }, NOW)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: 'write_freeze_max_minutes' }));
  });
});

describe('where a tenant may be promoted', () => {
  const tenant = { status: 'Active', isolationMode: 'POOL', region: 'vn-south', placementId: 'pool-1' };
  const silo = { id: 'silo-1', kind: 'SILO', status: 'Active', region: 'vn-south', hasRoom: true };
  const refusal = (target: Partial<typeof silo>) => {
    try {
      assertSiloPromotable(tenant, { ...silo, ...target });
    } catch (error) {
      return error as { code: string; status: number; extensions?: { reason?: string } };
    }
    return undefined;
  };

  it('accepts an Active tenant on the pool and an Active free silo of its own region', () => {
    expect(refusal({})).toBeUndefined();
  });

  it('refuses a tenant that is not Active or is already on a silo with 409 TENANT_STATE_INVALID', () => {
    for (const status of ['Requested', 'Provisioning', 'Suspended', 'Offboarding', 'Archived', 'Failed']) {
      expect(() => assertSiloPromotable({ ...tenant, status }, silo)).toThrow(expect.objectContaining({ code: 'TENANT_STATE_INVALID', status: 409 }));
    }
    expect(() => assertSiloPromotable({ ...tenant, isolationMode: 'SILO' }, silo)).toThrow(expect.objectContaining({ code: 'TENANT_STATE_INVALID', detail: 'ALREADY_SILO' }));
  });

  it('refuses a target that is not a free Active silo of the region of the tenant, with 422 PLACEMENT_UNAVAILABLE naming why', () => {
    expect(refusal({ id: 'pool-1' })).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', status: 422, extensions: { reason: 'SAME_PLACEMENT' } });
    expect(refusal({ kind: 'POOL' })).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', extensions: { reason: 'NOT_SILO' } });
    expect(refusal({ status: 'Draining' })).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', extensions: { reason: 'NOT_ACTIVE' } });
    expect(refusal({ region: 'vn-north' })).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', extensions: { reason: 'OTHER_REGION' } });
    expect(refusal({ hasRoom: false })).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', extensions: { reason: 'NO_ROOM' } });
  });
});

describe('the comparison of the copy with the original (BR-SAS-05)', () => {
  it('compares decimal sums as numbers, never as text, and never accepts a missing or malformed one', () => {
    expect(sameAmount('120000000000000000000000', '120000000000000000000000')).toBe(true);
    expect(sameAmount('-0', '0')).toBe(true);
    expect(sameAmount('12000000000000000000000001', '12000000000000000000000000')).toBe(false);
    expect(sameAmount(null, '0')).toBe(false);
    expect(sameAmount('0', undefined)).toBe(false);
    expect(sameAmount('1.5', '1.5')).toBe(false);
    expect(sameAmount('', '')).toBe(false);
  });

  it('AC-ST-SAS-018-1 UAT-AC150: agrees when every table has the same rows, the same content checksum and the same money sums', () => {
    const result = reconcileCopy(SOURCE, [...SOURCE].reverse());
    expect(result.match).toBe(true);
    expect(result.mismatchedTables).toEqual([]);
    expect(result.sourceRows).toBe(5);
    expect(result.targetRows).toBe(5);
    expect(result.tables.map((entry) => entry.table)).toEqual(['invoice', 'member']);
    expect(result.tables[0]).toMatchObject({ rowsMatch: true, checksumMatch: true, moneyMatch: true, match: true, money: [{ column: 'total_vnd', source: '120000000000000000000000', target: '120000000000000000000000', match: true }] });
  });

  it('AC-ST-SAS-018-1 UAT-AC150: one row different in the copy is a difference in the table: one money sum, one key, or a row less', () => {
    const money = reconcileCopy(SOURCE, [measure('invoice', 3, '1000000000000000000000001', { total_vnd: '120000000000000000000001' }), SOURCE[1] as TableMeasure]);
    expect(money.match).toBe(false);
    expect(money.mismatchedTables).toEqual(['invoice']);
    expect(money.tables[0]).toMatchObject({ rowsMatch: true, checksumMatch: true, moneyMatch: false, match: false });
    const key = reconcileCopy(SOURCE, [measure('invoice', 3, '1000000000000000000000002', { total_vnd: '120000000000000000000000' }), SOURCE[1] as TableMeasure]);
    expect(key.tables[0]).toMatchObject({ rowsMatch: true, checksumMatch: false, moneyMatch: true, match: false });
    const rows = reconcileCopy(SOURCE, [measure('invoice', 2, '1000000000000000000000001', { total_vnd: '120000000000000000000000' }), SOURCE[1] as TableMeasure]);
    expect(rows.tables[0]).toMatchObject({ rowsMatch: false, checksumMatch: true, moneyMatch: true, match: false });
    expect(rows.sourceRows).toBe(5);
    expect(rows.targetRows).toBe(4);
    // A row more in the copy is as much a difference as a row less.
    const more = reconcileCopy(SOURCE, [measure('invoice', 4, '1000000000000000000000001', { total_vnd: '120000000000000000000000' }), SOURCE[1] as TableMeasure]);
    expect(more.tables[0]).toMatchObject({ rowsMatch: false, checksumMatch: true, moneyMatch: true, match: false });
  });

  it('is a difference when a table is on one side only, or a money column is', () => {
    const missing = reconcileCopy(SOURCE, [SOURCE[0] as TableMeasure]);
    expect(missing.mismatchedTables).toEqual(['member']);
    expect(missing.tables[1]).toMatchObject({ table: 'member', sourceRows: 2, targetRows: null, targetChecksum: null, match: false });
    const extra = reconcileCopy([SOURCE[0] as TableMeasure], SOURCE);
    expect(extra.mismatchedTables).toEqual(['member']);
    expect(extra.tables[1]).toMatchObject({ sourceRows: null, targetRows: 2, match: false });
    const column = reconcileCopy(SOURCE, [measure('invoice', 3, '1000000000000000000000001', {}), SOURCE[1] as TableMeasure]);
    expect(column.tables[0]?.money).toEqual([{ column: 'total_vnd', source: '120000000000000000000000', target: null, match: false }]);
    expect(column.match).toBe(false);
    // A money column that only the copy has is a difference too.
    const extraColumn = reconcileCopy(SOURCE, [measure('invoice', 3, '1000000000000000000000001', { total_vnd: '120000000000000000000000', tax_vnd: '0' }), SOURCE[1] as TableMeasure]);
    expect(extraColumn.tables[0]?.money).toEqual([{ column: 'tax_vnd', source: null, target: '0', match: false }, { column: 'total_vnd', source: '120000000000000000000000', target: '120000000000000000000000', match: true }]);
    expect(extraColumn.match).toBe(false);
    expect(reconcileCopy([], []).match).toBe(true);
  });

  it('keeps the comparison with a reference that changes when anything compared changes', () => {
    const report = verificationReport(SOURCE, SOURCE, NOW);
    expect(report).toMatchObject({ match: true, mismatchedTables: [], measuredAt: NOW });
    const reference = reportReference(report);
    expect(reference).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reportReference(verificationReport([...SOURCE].reverse(), [...SOURCE].reverse(), NOW))).toBe(reference);
    expect(reportReference(verificationReport(SOURCE, SOURCE, minutes(1)))).not.toBe(reference);
    expect(reportReference(verificationReport(SOURCE, [SOURCE[0] as TableMeasure, measure('member', 2, '-78')], NOW))).not.toBe(reference);
    const different = verificationReport(SOURCE, [measure('invoice', 3, '1000000000000000000000001', { total_vnd: '1' }), SOURCE[1] as TableMeasure], NOW);
    expect(different).toMatchObject({ match: false, mismatchedTables: ['invoice'] });
    expect(reportReference(different)).not.toBe(reference);
  });

  it('calls a comparison recent for 10 minutes, and not one from the future', () => {
    expect(isReportFresh(minutes(-10), NOW)).toBe(true);
    expect(isReportFresh(minutes(-11), NOW)).toBe(false);
    expect(isReportFresh(minutes(1), NOW)).toBe(true);
    expect(isReportFresh(minutes(2), NOW)).toBe(false);
  });
});

describe('the approval of the cutover (four eyes, BR-SAS-05)', () => {
  const matching = { measuredAt: minutes(-1), match: true, mismatchedTables: [] as string[] };
  const facts = { status: 'AwaitingCutover' as MigrationStatus, requestedBy: ADMIN, report: matching };

  it('AC-ST-SAS-018-1 UAT-AC150: lets another System Admin approve a migration that waits and whose copy agrees', () => {
    expect(() => assertCutoverApproved(facts, OTHER, NOW)).not.toThrow();
  });

  it('AC-ST-SAS-018-1 UAT-AC150: refuses the one who started it with 403 SELF_APPROVAL_DENIED, whatever the letter case', () => {
    expect(() => assertCutoverApproved(facts, ADMIN, NOW)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    expect(() => assertCutoverApproved(facts, ADMIN.toUpperCase(), NOW)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    expect(() => assertCutoverApproved(facts, '', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }));
  });

  it('AC-ST-SAS-018-1 UAT-AC150: refuses a copy that differs with 422 MIGRATION_VERIFICATION_FAILED naming the tables', () => {
    const differing = { ...facts, report: { measuredAt: minutes(-1), match: false, mismatchedTables: ['invoice'] } };
    expect(() => assertCutoverApproved(differing, OTHER, NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_VERIFICATION_FAILED', status: 422, extensions: { reason: 'MISMATCH', tables: ['invoice'] } }));
  });

  it('refuses a migration that was never compared, and a comparison too old to rely on, with 422 MIGRATION_VERIFICATION_FAILED', () => {
    expect(() => assertCutoverApproved({ ...facts, report: undefined }, OTHER, NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_VERIFICATION_FAILED', extensions: { reason: 'NOT_VERIFIED', tables: [] } }));
    expect(() => assertCutoverApproved({ ...facts, report: { ...matching, measuredAt: minutes(-11) } }, OTHER, NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_VERIFICATION_FAILED', extensions: { reason: 'STALE', tables: [] } }));
  });

  it('judges the state first: a migration that does not wait for approval is 409 MIGRATION_STATE_INVALID, even for the one who started it', () => {
    for (const status of ['Planned', 'Copying', 'Verifying', 'CutoverFrozen', 'Switched', 'Completed', 'Aborted', 'RolledBack'] as const) {
      expect(() => assertCutoverApproved({ ...facts, status }, ADMIN, NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID', status: 409 }));
    }
  });

  it('judges the person before the copy, so the one who started it is told so even while the copy differs', () => {
    const differing = { ...facts, report: { measuredAt: minutes(-1), match: false, mismatchedTables: ['invoice'] } };
    expect(() => assertCutoverApproved(differing, ADMIN, NOW)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
  });
});

describe('the time limits of a migration', () => {
  it('freezes writes for at most the minutes asked for: the routing may be switched only before the freeze is over', () => {
    expect(freezeEndsAt(NOW, 30)).toEqual(minutes(30));
    expect(freezeOver(NOW, 30, minutes(29))).toBe(false);
    expect(freezeOver(NOW, 30, minutes(30))).toBe(true);
    expect(freezeOver(NOW, 30, minutes(31))).toBe(true);
  });

  it('watches the tenant for 24 hours after the switch and deletes the old copy 30 days after Completed', () => {
    expect(observationEndsAt(NOW).getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    expect(sourcePurgeDueAt(NOW).getTime() - NOW.getTime()).toBe(30 * 86_400_000);
  });

  it('keeps the old copy while any legal hold is in force', () => {
    expect(mayPurgeSource(0)).toBe(true);
    expect(mayPurgeSource(1)).toBe(false);
  });
});

describe('what the worker does next', () => {
  const base: WorkerFacts = { status: 'Planned', plannedWindowStart: NOW, writeFreezeStartedAt: null, writeFreezeMaxMinutes: 30, switchedAt: null, targetDiscarded: false, sourcePurgeDueAt: null, sourcePurged: false };
  const step = (patch: Partial<WorkerFacts>, now = NOW) => workerStep({ ...base, ...patch }, now);

  it('starts the copy when the planned window has come, not before', () => {
    expect(step({ plannedWindowStart: minutes(1) })).toBe('wait');
    expect(step({ plannedWindowStart: NOW })).toBe('start');
    expect(step({ plannedWindowStart: minutes(-1) })).toBe('start');
  });

  it('carries the copy on, compares it, and keeps comparing while the cutover waits for approval', () => {
    expect(step({ status: 'Copying' })).toBe('copy');
    expect(step({ status: 'Verifying' })).toBe('verify');
    expect(step({ status: 'AwaitingCutover' })).toBe('refresh');
  });

  it('finalizes a frozen migration inside its freeze, and rolls it back once the freeze is over', () => {
    const frozen = { status: 'CutoverFrozen' as const, writeFreezeStartedAt: NOW };
    expect(step(frozen, new Date(NOW.getTime() + 4_999))).toBe('wait');
    expect(step(frozen, new Date(NOW.getTime() + 5_000))).toBe('finalize');
    expect(step(frozen, minutes(29))).toBe('finalize');
    expect(step(frozen, minutes(30))).toBe('freeze-expired');
    expect(step({ status: 'CutoverFrozen', writeFreezeStartedAt: null })).toBe('freeze-expired');
  });

  it('completes a switched migration after 24 hours of observation', () => {
    const switched = { status: 'Switched' as const, switchedAt: NOW };
    expect(step(switched, minutes(24 * 60 - 1))).toBe('wait');
    expect(step(switched, minutes(24 * 60))).toBe('complete');
    expect(step({ status: 'Switched', switchedAt: null })).toBe('wait');
  });

  it('destroys the copy of a migration that ended without a switch, once', () => {
    for (const status of ['Aborted', 'RolledBack'] as const) {
      expect(step({ status })).toBe('discard-target');
      expect(step({ status, targetDiscarded: true })).toBe('wait');
    }
  });

  it('deletes the old copy of a completed migration after its 30 days, once', () => {
    const done = { status: 'Completed' as const, sourcePurgeDueAt: minutes(60) };
    expect(step(done, minutes(59))).toBe('wait');
    expect(step(done, minutes(60))).toBe('purge-source');
    expect(step({ ...done, sourcePurged: true }, minutes(61))).toBe('wait');
    expect(step({ status: 'Completed' })).toBe('wait');
  });
});
