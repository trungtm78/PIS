import { describe, expect, it } from '@jest/globals';
import {
  MAX_RESTORE_REASON,
  RECOVERY_WINDOW_DAYS,
  RESTORE_REPORT_SCHEMA_VERSION,
  RESTORE_RPO_TARGET_SECONDS,
  RESTORE_RTO_TARGET_SECONDS,
  assertRecoveryPointHeld,
  assertRestorable,
  normalizeMoney,
  recoveryWindowEndingAt,
  restoreReportReference,
  restoreRequestDefects,
  verifyRestore,
} from '../src/sas-restore.ts';
import type { Measurement, RestoredCopy } from '../src/sas-restore.ts';

const NOW = new Date('2026-11-03T03:00:00Z');
const at = (seconds: number, from = NOW): Date => new Date(from.getTime() + seconds * 1000);

describe('the request for a restore (ST-SAS-019)', () => {
  it('AC-ST-SAS-019-1 UAT-AC171: a reason of 10 to 2000 characters and a real instant are asked for', () => {
    const good = { recoveryPoint: NOW, reason: 'A wrong import at noon must be undone.' };
    expect(restoreRequestDefects(good)).toEqual([]);
    expect(restoreRequestDefects({ ...good, reason: '   short   ' })).toEqual(['reason']);
    expect(restoreRequestDefects({ ...good, reason: 'x'.repeat(MAX_RESTORE_REASON) })).toEqual([]);
    expect(restoreRequestDefects({ ...good, reason: 'x'.repeat(MAX_RESTORE_REASON + 1) })).toEqual(['reason']);
    expect(restoreRequestDefects({ ...good, recoveryPoint: new Date('not a date') })).toEqual(['recovery_point']);
    expect(restoreRequestDefects({ recoveryPoint: new Date(Number.NaN), reason: '' })).toEqual(['recovery_point', 'reason']);
  });

  it('AC-ST-SAS-019-1 UAT-AC171: a sandbox is made for a tenant that has data, an in-place restore only while the tenant is Suspended (409 TENANT_STATE_INVALID)', () => {
    for (const status of ['Active', 'Suspended', 'Offboarding']) expect(() => assertRestorable('SANDBOX', status)).not.toThrow();
    expect(() => assertRestorable('IN_PLACE', 'Suspended')).not.toThrow();
    for (const status of ['Active', 'Offboarding', 'Requested', 'Provisioning', 'Failed', 'Archived']) {
      expect(() => assertRestorable('IN_PLACE', status)).toThrow(expect.objectContaining({ code: 'TENANT_STATE_INVALID', status: 409, detail: status }));
    }
    for (const status of ['Requested', 'Provisioning', 'Failed', 'Archived']) expect(() => assertRestorable('SANDBOX', status)).toThrow(expect.objectContaining({ code: 'TENANT_STATE_INVALID', status: 409 }));
  });

  it('holds a recovery point only inside the window of the backups, ends included (422 RECOVERY_POINT_UNAVAILABLE)', () => {
    const window = recoveryWindowEndingAt(NOW);
    expect(window.latest).toEqual(NOW);
    expect(window.earliest.getTime()).toBe(NOW.getTime() - RECOVERY_WINDOW_DAYS * 86_400_000);
    expect(RECOVERY_WINDOW_DAYS).toBe(35);
    expect(() => assertRecoveryPointHeld(window.earliest, window)).not.toThrow();
    expect(() => assertRecoveryPointHeld(window.latest, window)).not.toThrow();
    expect(() => assertRecoveryPointHeld(at(-1, window.earliest), window)).toThrow(expect.objectContaining({ code: 'RECOVERY_POINT_UNAVAILABLE', status: 422 }));
    expect(() => assertRecoveryPointHeld(at(1, window.latest), window)).toThrow(expect.objectContaining({ code: 'RECOVERY_POINT_UNAVAILABLE', status: 422 }));
    expect(() => assertRecoveryPointHeld(NOW, undefined)).toThrow(expect.objectContaining({ code: 'RECOVERY_POINT_UNAVAILABLE' }));
  });
});

const backup: Measurement = {
  tables: {
    contract: { rows: 3, checksum: 'aaa', money: { amount_vnd: '1000000', retention_vnd: '50000' } },
    note: { rows: 10, checksum: 'bbb', money: {} },
  },
};
const copy = (patch: Partial<RestoredCopy> = {}): RestoredCopy => ({ ...backup, foreignRows: 0, ...patch });
const timings = { recoveryPoint: NOW, restoredTo: NOW, approvedAt: NOW, verifiedAt: at(600) };

describe('the verification of a restore (ST-SAS-019, NFR-AVAILABILITY-03)', () => {
  it('AC-ST-SAS-019-2 OPS01: a copy that holds what the backup recorded matches, table by table, with the totals and the targets', () => {
    const report = verifyRestore(backup, copy(), timings);
    expect(report).toMatchObject({
      schema_version: RESTORE_REPORT_SCHEMA_VERSION,
      matched: true,
      mismatches: [],
      foreign_rows: 0,
      totals: { tables: 2, rows_expected: 13, rows_restored: 13, money_expected_vnd: '1050000', money_restored_vnd: '1050000' },
      rpo_seconds: 0,
      rto_seconds: 600,
      rpo_target_seconds: 900,
      rto_target_seconds: 14_400,
      within_targets: true,
    });
    expect(report.tables.map((table) => table.table)).toEqual(['contract', 'note']);
    expect(report.tables[0]).toEqual({
      table: 'contract',
      expected_rows: 3,
      restored_rows: 3,
      rows_match: true,
      expected_checksum: 'aaa',
      restored_checksum: 'aaa',
      checksum_match: true,
      money: [
        { column: 'amount_vnd', expected: '1000000', restored: '1000000', match: true },
        { column: 'retention_vnd', expected: '50000', restored: '50000', match: true },
      ],
    });
    expect(RESTORE_RPO_TARGET_SECONDS).toBe(900);
    expect(RESTORE_RTO_TARGET_SECONDS).toBe(14_400);
  });

  it('AC-ST-SAS-019-2: a different row count, checksum or money total, a missing or an extra table, or a row of another tenant each stop the match and are named', () => {
    const cases: Array<[string, RestoredCopy, string]> = [
      ['rows', copy({ tables: { ...backup.tables, note: { rows: 9, checksum: 'bbb', money: {} } } }), 'rows:note'],
      ['checksum', copy({ tables: { ...backup.tables, note: { rows: 10, checksum: 'zzz', money: {} } } }), 'checksum:note'],
      ['money', copy({ tables: { ...backup.tables, contract: { rows: 3, checksum: 'aaa', money: { amount_vnd: '1000001', retention_vnd: '50000' } } } }), 'money:contract.amount_vnd'],
      ['money column gone', copy({ tables: { ...backup.tables, contract: { rows: 3, checksum: 'aaa', money: { amount_vnd: '1000000' } } } }), 'money:contract.retention_vnd'],
      ['money column added', copy({ tables: { ...backup.tables, note: { rows: 10, checksum: 'bbb', money: { extra_vnd: '1' } } } }), 'money:note.extra_vnd'],
      ['missing table', copy({ tables: { contract: backup.tables.contract as never } }), 'missing_table:note'],
      ['extra table', copy({ tables: { ...backup.tables, extra: { rows: 1, checksum: 'c', money: {} } } }), 'unexpected_table:extra'],
      ['foreign rows', copy({ foreignRows: 2 }), 'foreign_rows'],
    ];
    for (const [, restored, mismatch] of cases) {
      const report = verifyRestore(backup, restored, timings);
      expect(report.matched).toBe(false);
      expect(report.mismatches).toContain(mismatch);
    }
    const lone = verifyRestore(backup, copy({ tables: { contract: backup.tables.contract as never } }), timings);
    expect(lone.tables.find((table) => table.table === 'note')).toMatchObject({ expected_rows: 10, restored_rows: 0, rows_match: false, checksum_match: false, restored_checksum: '' });
    const extra = verifyRestore(backup, copy({ tables: { ...backup.tables, extra: { rows: 1, checksum: 'c', money: {} } } }), timings);
    expect(extra.tables.find((table) => table.table === 'extra')).toMatchObject({ expected_rows: 0, restored_rows: 1, rows_match: false });
    // A money total that differs by a unit is a different total, however the text is written.
    expect(verifyRestore(backup, copy({ tables: { ...backup.tables, contract: { rows: 3, checksum: 'aaa', money: { amount_vnd: '1000000.0', retention_vnd: '50000.00' } } } }), timings).matched).toBe(true);
  });

  it('AC-ST-SAS-019-2 OPS01: RPO is how far the copy stops before the recovery point (never negative), RTO runs from the approval to the verification, and a miss of either is flagged', () => {
    expect(verifyRestore(backup, copy(), { ...timings, restoredTo: at(-900) })).toMatchObject({ rpo_seconds: 900, within_targets: true });
    expect(verifyRestore(backup, copy(), { ...timings, restoredTo: at(-901) })).toMatchObject({ rpo_seconds: 901, within_targets: false, matched: true });
    expect(verifyRestore(backup, copy(), { ...timings, restoredTo: at(120) })).toMatchObject({ rpo_seconds: 0 });
    expect(verifyRestore(backup, copy(), { ...timings, verifiedAt: at(14_400) })).toMatchObject({ rto_seconds: 14_400, within_targets: true });
    expect(verifyRestore(backup, copy(), { ...timings, verifiedAt: at(14_400.4) })).toMatchObject({ rto_seconds: 14_401, within_targets: false });
    expect(verifyRestore(backup, copy(), { ...timings, verifiedAt: at(-5) })).toMatchObject({ rto_seconds: 0 });
  });

  it('adds the money of every column of every table, exactly, whatever the size', () => {
    const big: Measurement = { tables: { a: { rows: 1, checksum: 'x', money: { x_vnd: '99999999999999999999999' } }, b: { rows: 1, checksum: 'y', money: { y_vnd: '1', z_vnd: '-0.5' } } } };
    expect(verifyRestore(big, { ...big, foreignRows: 0 }, timings).totals).toMatchObject({ money_expected_vnd: '99999999999999999999999.5', money_restored_vnd: '99999999999999999999999.5' });
    expect(normalizeMoney('-0.50')).toBe('-0.5');
    expect(normalizeMoney('007')).toBe('7');
    expect(() => normalizeMoney('1e5')).toThrow();
    expect(() => normalizeMoney('1.1234567')).toThrow();
  });
});

describe('the reference of a verification report (ST-SAS-019, the drill record)', () => {
  it('AC-ST-SAS-019-2 OPS01: is the same for the same report in any key order and changes with any figure', () => {
    const report = verifyRestore(backup, copy(), timings);
    const reference = restoreReportReference(report);
    expect(reference).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(report).reverse()))) as typeof report;
    expect(restoreReportReference(reordered)).toBe(reference);
    expect(restoreReportReference({ ...report, rto_seconds: report.rto_seconds + 1 })).not.toBe(reference);
    expect(restoreReportReference(verifyRestore(backup, copy({ foreignRows: 1 }), timings))).not.toBe(reference);
  });
});
