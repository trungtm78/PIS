import { DATASET_VERSION_STATUSES, QUALITY_BADGES, certifiedRows, feedsCertified, isSameBuild, qualityOfVersion, versionChecksum } from '../src/bi-dataset.ts';
import type { QualityRunFacts, VersionContent } from '../src/bi-dataset.ts';

const SHA = 'a'.repeat(64);
const run = (overrides: Partial<QualityRunFacts> = {}): QualityRunFacts => ({ id: 'run-1', status: 'COMPLETED', overallResult: 'PASSED', certifiedBlocked: false, quarantinedCount: 0, snapshotSha256: SHA, ...overrides });
const content = (overrides: Partial<VersionContent> = {}): VersionContent => ({ datasetCode: 'DS-DISB', asOfPeriod: '2026-10', sourceSnapshotId: 's1', snapshotSha256: SHA, rowCount: 100, qualityRunId: null, excludedQuarantineRows: 0, ...overrides });

describe('the quality of a dataset version (BI 3 F2)', () => {
  it('AC-ST-BI-002-1: UAT-AC478 is NOT_ASSESSED with nothing linked and no row excluded while DGV has not run, is still running or could not measure', () => {
    const expected = { badge: 'NOT_ASSESSED', runId: null, excludedQuarantineRows: 0 };
    expect(qualityOfVersion(undefined, SHA)).toEqual(expected);
    expect(qualityOfVersion(run({ status: 'RUNNING', overallResult: null, quarantinedCount: 5 }), SHA)).toEqual(expected);
    expect(qualityOfVersion(run({ status: 'FAILED', overallResult: null }), SHA)).toEqual(expected);
    expect(qualityOfVersion(run({ overallResult: null }), SHA)).toEqual(expected);
  });

  it('AC-ST-BI-002-1: UAT-AC478 links the run and counts the 12 rows its rules quarantined, with the verdict of the run as the badge', () => {
    expect(qualityOfVersion(run({ overallResult: 'WARNING', quarantinedCount: 12 }), SHA)).toEqual({ badge: 'WARNING', runId: 'run-1', excludedQuarantineRows: 12 });
    expect(qualityOfVersion(run({ overallResult: 'PASSED' }), SHA)).toEqual({ badge: 'PASSED', runId: 'run-1', excludedQuarantineRows: 0 });
    expect(qualityOfVersion(run({ overallResult: 'FAILED', quarantinedCount: 3 }), SHA)).toEqual({ badge: 'FAILED', runId: 'run-1', excludedQuarantineRows: 3 });
  });

  it('is FAILED when the run blocks certified figures, whatever its verdict says, and FAILED for a verdict it does not know', () => {
    expect(qualityOfVersion(run({ overallResult: 'WARNING', certifiedBlocked: true }), SHA).badge).toBe('FAILED');
    expect(qualityOfVersion(run({ overallResult: 'SURPRISE' }), SHA).badge).toBe('FAILED');
  });

  it('is STALE, linked and with no row excluded, when the run measured another payload than this snapshot has', () => {
    expect(qualityOfVersion(run({ quarantinedCount: 12, snapshotSha256: 'b'.repeat(64) }), SHA)).toEqual({ badge: 'STALE', runId: 'run-1', excludedQuarantineRows: 0 });
    // A run or a snapshot with no digest cannot be told apart from the one measured: the run stands.
    expect(qualityOfVersion(run({ snapshotSha256: null }), SHA).badge).toBe('PASSED');
    expect(qualityOfVersion(run(), null).badge).toBe('PASSED');
  });

  it('lists the badges and statuses the table allows, and says which badges feed certified figures', () => {
    expect([...QUALITY_BADGES]).toEqual(['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE']);
    expect([...DATASET_VERSION_STATUSES]).toEqual(['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED']);
    expect(QUALITY_BADGES.filter(feedsCertified)).toEqual(['NOT_ASSESSED', 'PASSED', 'WARNING']);
  });
});

describe('what a version is made of', () => {
  it('AC-ST-BI-002-1: UAT-AC478 leaves the certified rows without the 12 that were quarantined, and never below zero', () => {
    expect(certifiedRows(100, 12)).toBe(88);
    expect(certifiedRows(100, 0)).toBe(100);
    expect(certifiedRows(5, 12)).toBe(0);
  });

  it('AC-ST-BI-002-2: UAT-AC482 gives the same checksum to the same content, whatever the order of its keys, and another to any change of it', () => {
    const base = content();
    expect(versionChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(versionChecksum({ rowCount: 100, excludedQuarantineRows: 0, qualityRunId: null, snapshotSha256: SHA, sourceSnapshotId: 's1', asOfPeriod: '2026-10', datasetCode: 'DS-DISB' })).toBe(versionChecksum(base));
    for (const change of [{ qualityRunId: 'run-1' }, { excludedQuarantineRows: 12 }, { sourceSnapshotId: 's2' }, { snapshotSha256: 'c'.repeat(64) }, { rowCount: 101 }, { asOfPeriod: '2026-11' }]) {
      expect(versionChecksum(content(change))).not.toBe(versionChecksum(base));
    }
  });

  it('AC-ST-BI-002-2: UAT-AC482 takes a build of the same content as the version that stands, and a build with a run linked as another', () => {
    const standing = { checksumSha256: versionChecksum(content()) };
    expect(isSameBuild(standing, content())).toBe(true);
    expect(isSameBuild(standing, content({ qualityRunId: 'run-1', excludedQuarantineRows: 12 }))).toBe(false);
  });
});
