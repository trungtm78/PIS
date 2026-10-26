import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { buildRequest, canBuild, canFreeze, describeSnapshot, isFreezable, shortHash, snapshotIdOf, toLinesPage, toSnapshot, toSnapshotLine, toSnapshotList } from './model';

const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  period_id: 'p1',
  snapshot_kind: 'PERIOD_CLOSE',
  status: 'BUILDING',
  as_of_date: '2027-01-10',
  treasury_cutoff_date: '2027-01-10',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 6,
  payload_sha256: null,
  version: 1,
  ...over,
});

describe('the snapshot of a period (DIS-21)', () => {
  it('reads a snapshot, and refuses one that lacks what the screen needs or carries a kind, a status or a definition it does not know', () => {
    expect(toSnapshot(snapshot())).toMatchObject({ id: 's1', kind: 'PERIOD_CLOSE', status: 'BUILDING', cutoffDate: '2027-01-10', definitionStatus: 'PROPOSED_PENDING_SIGNOFF', rowCount: 6, payloadSha256: null, frozenAt: null, version: 1 });
    for (const bad of [{ id: undefined }, { snapshot_kind: 'WEEKLY' }, { status: 'DONE' }, { definition_status: 'MAYBE' }, { row_count: -1 }, { version: 1.5 }, { treasury_cutoff_date: undefined }]) {
      expect(toSnapshot(snapshot(bad))).toBeUndefined();
    }
    expect(toSnapshot(null)).toBeUndefined();
    expect(toSnapshot([])).toBeUndefined();
  });

  it('reads the list with the reports waiting for review, and drops what is not well formed', () => {
    const list = toSnapshotList({ items: [snapshot(), { id: 'broken' }], pending_reports: [{ report_id: 'r1', project_code: 'DA-1', revision: 2, status: 'SUBMITTED' }, { report_id: 'r2' }] });
    expect(list.items.map((item) => item.id)).toEqual(['s1']);
    expect(list.pending).toEqual([{ reportId: 'r1', projectCode: 'DA-1', revision: 2, status: 'SUBMITTED' }]);
    expect(toSnapshotList(undefined)).toEqual({ items: [], pending: [] });
  });

  it('reads a line with the figures nobody has as null and never as zero', () => {
    const line = toSnapshotLine({
      id: 'l1',
      project_code: 'DA-1',
      bucket: 'OTHER',
      budget_level: 'LOCAL',
      plan_pm_assigned_vnd: '0',
      plan_local_added_vnd: '0',
      plan_total_vnd: '0',
      disbursed_treasury_vnd: null,
      treasury_coverage: 'NONE',
      rate_null_reason: 'NO_DATA',
    });
    expect(line).toMatchObject({ treasuryVnd: null, reportedVnd: null, deltaVnd: null, ratePmPct: null, rateTotalPct: null, rateNullReason: 'NO_DATA', coverage: 'NONE' });
    expect(toSnapshotLine({ id: 'l1' })).toBeUndefined();
  });

  it('reads a page of lines with the cursor of the next one', () => {
    expect(toLinesPage({ snapshot: snapshot(), items: [], next_cursor: 'c' })).toMatchObject({ items: [], nextCursor: 'c' });
    expect(toLinesPage({ items: [], next_cursor: null }).nextCursor).toBeUndefined();
  });

  it('lets a person build or freeze only with the permission of it, and never in a read-only session', () => {
    expect(canBuild(['snapshot.build'], 'FULL')).toBe(true);
    expect(canBuild(['snapshot.freeze'], 'FULL')).toBe(false);
    expect(canFreeze(['snapshot.freeze'], undefined)).toBe(true);
    expect(canFreeze(['snapshot.build'], 'FULL')).toBe(false);
    expect(canBuild(['snapshot.build'], 'READ_ONLY')).toBe(false);
    expect(canFreeze(['snapshot.freeze'], 'READ_ONLY')).toBe(false);
    // The server judges when the session does not know its permissions.
    expect(canBuild(undefined, 'FULL')).toBe(true);
  });

  it('freezes only what was built and not frozen, and shows eight characters of the hash', () => {
    expect(isFreezable(toSnapshot(snapshot()) as NonNullable<ReturnType<typeof toSnapshot>>)).toBe(true);
    for (const status of ['FROZEN', 'SUPERSEDED', 'FAILED']) expect(isFreezable(toSnapshot(snapshot({ status })) as NonNullable<ReturnType<typeof toSnapshot>>)).toBe(false);
    expect(shortHash('0123456789abcdef')).toBe('01234567');
    expect(shortHash(null)).toBe('');
  });

  it('builds the request in the words of the contract', () => {
    expect(buildRequest('p1', 'ADHOC', '2027-01-12')).toEqual({ period_id: 'p1', snapshot_kind: 'ADHOC', treasury_cutoff_date: '2027-01-12' });
    expect(snapshotIdOf({ resource_id: 's9' })).toBe('s9');
    expect(snapshotIdOf({})).toBeUndefined();
  });

  it('puts a refusal of the server into the sentence of the screen, and anything else into the general one', () => {
    const refuse = (code: string) => describeSnapshot(new ApiError({ status: 409, code, correlationId: 'c' }));
    expect([refuse('SNAPSHOT_FROZEN'), refuse('SNAPSHOT_NOT_BUILT'), refuse('SNAPSHOT_BUILD_IN_PROGRESS'), refuse('PERIOD_STATE_INVALID'), refuse('VERSION_CONFLICT'), refuse('SCOPE_DENIED'), refuse('RESOURCE_NOT_FOUND'), refuse('VALIDATION_FAILED')]).toEqual([
      'frozen',
      'notBuilt',
      'inProgress',
      'periodOpen',
      'versionConflict',
      'scopeDenied',
      'notFound',
      'validation',
    ]);
    expect(refuse('SOMETHING_ELSE')).toBe('general');
    expect(describeSnapshot(new Error('x'))).toBe('general');
  });
});
