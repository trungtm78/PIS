import { describe, expect, it } from '@jest/globals';
import { BACKUP_MAX_AGE_HOURS, backupHealthOf, backupKindOfLabel, backupRequestDefects } from '../src/index.ts';
import type { BackupStateEntry } from '../src/index.ts';

const entry = (over: Partial<BackupStateEntry>): BackupStateEntry => ({ label: '20261109-013000F', kind: 'full', finishedAt: '2026-11-09T02:00:00Z', repository: 1, failed: false, ...over });

describe('backup request rules (INFRA-2, YCK.06)', () => {
  it('accepts full, differential and incremental on the operational repository and full only on the archive', () => {
    for (const kind of ['full', 'diff', 'incr']) expect(backupRequestDefects({ kind, repository: 1, reason: 'before the upgrade of the release' })).toEqual([]);
    expect(backupRequestDefects({ kind: 'full', repository: 2, reason: 'extra copy for the audit' })).toEqual([]);
    expect(backupRequestDefects({ kind: 'diff', repository: 2, reason: 'extra copy for the audit' })).toEqual(['repository']);
    expect(backupRequestDefects({ kind: 'weekly', repository: 1, reason: 'before the upgrade of the release' })).toEqual(['kind']);
    expect(backupRequestDefects({ kind: 'full', repository: 3, reason: 'before the upgrade of the release' })).toEqual(['repository']);
  });

  it('needs a reason of 10 to 2000 characters after trimming', () => {
    expect(backupRequestDefects({ kind: 'full', repository: 1, reason: '   short   ' })).toEqual(['reason']);
    expect(backupRequestDefects({ kind: 'full', repository: 1, reason: 'x'.repeat(2001) })).toEqual(['reason']);
    expect(backupRequestDefects({ kind: 'full', repository: 1, reason: 'x'.repeat(2000) })).toEqual([]);
  });

  it('reads the kind from a pgBackRest label and refuses anything else', () => {
    expect(backupKindOfLabel('20261109-013000F')).toBe('full');
    expect(backupKindOfLabel('20261109-013000F_20261115-123000D')).toBe('diff');
    expect(backupKindOfLabel('20261109-013000F_20261110-053000I')).toBe('incr');
    expect(backupKindOfLabel('latest')).toBeUndefined();
    expect(backupKindOfLabel('20261109-013000X')).toBeUndefined();
  });

  it('judges the health of the repository from the newest backups and the clock', () => {
    const now = new Date('2026-11-09T10:00:00Z');
    expect(backupHealthOf([], now)).toBe('UNKNOWN');
    expect(backupHealthOf([entry({})], now)).toBe('OK');
    expect(backupHealthOf([entry({ label: '20261109-053000F_20261109-093000I', kind: 'incr', failed: true }), entry({})], now)).toBe('FAILED');
    expect(backupHealthOf([entry({ finishedAt: new Date(now.getTime() - (BACKUP_MAX_AGE_HOURS + 1) * 3_600_000).toISOString() })], now)).toBe('STALE');
    expect(backupHealthOf([entry({ kind: 'incr', label: '20261109-013000F_20261109-053000I' })], now)).toBe('STALE');
  });
});
