import type { ApprovalEffects } from '../src/approval-store';
import { BackupRequestStore } from '../src/backup-request-store';
import type { BackupRequestRow } from '../src/backup-request-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const store = new BackupRequestStore();
const ASKER = memberId(1);
const DECIDER = memberId(2);
const NOW = new Date('2026-11-09T03:00:00Z');
const REASON = 'Before the upgrade of the release on Saturday.';

function recorder(actor = ASKER): ApprovalEffects & { audits: Array<{ action: string; resourceId: string; diff: unknown }> } {
  const audits: Array<{ action: string; resourceId: string; diff: unknown }> = [];
  return { actor, audits, audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff }), emit: async () => undefined };
}

describe('the manual backup request (INFRA-2, HSKT YCK.06)', () => {
  const harness = new AuthzHarness();
  const asTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: ASKER, scopeVersion: 0 }, work);
  const sqlError = async (tenant: string, text: string, params: unknown[] = []): Promise<string | undefined> => {
    try {
      await asTenant(tenant, (tx) => tx.query(text, params));
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  const request = (overrides: Partial<{ kind: string; repository: number; reason: string; requestedBy: string }> = {}, effects = recorder(), tenant = TENANT_A) =>
    asTenant(tenant, (tx) => store.request(tx, effects, { kind: 'full', repository: 1, reason: REASON, requestedBy: ASKER, now: NOW, ...overrides }));
  const decide = (row: BackupRequestRow, overrides: Partial<Parameters<BackupRequestStore['decide']>[2]> = {}, effects = recorder(DECIDER), tenant = TENANT_A) =>
    asTenant(tenant, (tx) => store.decide(tx, effects, { id: row.id, decision: 'approve', decidedBy: DECIDER, reason: 'Window agreed with operations.', expectedVersion: row.version, now: new Date(NOW.getTime() + 3_600_000), ...overrides }));
  const record = (row: BackupRequestRow, overrides: Partial<Parameters<BackupRequestStore['record']>[2]> = {}) =>
    asTenant(TENANT_A, (tx) => store.record(tx, recorder(DECIDER), { id: row.id, outcome: 'completed', backupLabel: '20261109-043000F', recordedBy: DECIDER, expectedVersion: row.version, now: new Date(NOW.getTime() + 7_200_000), ...overrides }));

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
    for (const member of [1, 2]) {
      await harness.seedMembership(TENANT_A, member, 1);
      await harness.seedMembership(TENANT_B, member, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    for (const tenant of [TENANT_A, TENANT_B]) await harness.owner(tenant, [['delete from machvon.backup_request']]);
  });

  it('records the request, audits it and keeps what was asked for', async () => {
    const effects = recorder();
    const row = await request({ kind: 'diff', reason: `  ${REASON}  ` }, effects);
    expect(row).toMatchObject({ kind: 'diff', repository: 1, reason: REASON, status: 'Requested', requestedBy: ASKER, requestedAt: NOW, version: 1, decidedBy: null, backupLabel: null });
    expect(effects.audits).toEqual([{ action: 'backup.requested', resourceId: row.id, diff: { kind: 'diff', repository: 1 } }]);
  });

  it('refuses an invalid request (422), the archive with a kind other than full, and a second open request of the same kind and repository (409 BACKUP_REQUEST_OPEN)', async () => {
    await expect(request({ kind: 'monthly' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(request({ reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(request({ kind: 'incr', repository: 2 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await request({ kind: 'full' });
    await expect(request({ kind: 'full' })).rejects.toMatchObject({ code: 'BACKUP_REQUEST_OPEN', status: 409 });
    await expect(request({ kind: 'full', repository: 2 })).resolves.toMatchObject({ repository: 2 });
    await expect(request({ kind: 'diff' })).resolves.toMatchObject({ kind: 'diff' });
  });

  it('is decided by somebody else: the asker is refused whichever way they decide (403 SELF_APPROVAL_DENIED), a stale version is 409, and a decided request is final', async () => {
    const row = await request();
    await expect(decide(row, { decidedBy: ASKER })).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    await expect(decide(row, { decidedBy: ASKER, decision: 'reject' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    await expect(decide(row, { expectedVersion: 7 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    const effects = recorder(DECIDER);
    const approved = await decide(row, {}, effects);
    expect(approved).toMatchObject({ status: 'Approved', decidedBy: DECIDER, version: 2 });
    expect(effects.audits[0]).toMatchObject({ action: 'backup.decided', diff: { decision: 'approve', kind: 'full', requested_by: ASKER } });
    await expect(decide(approved, { decision: 'reject', reason: 'Changed my mind.' })).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
  });

  it('a rejection needs a reason, and a rejected request frees the slot for a new one', async () => {
    const row = await request();
    await expect(decide(row, { decision: 'reject', reason: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await decide(row, { decision: 'reject', reason: 'Not in the maintenance window.' })).toMatchObject({ status: 'Rejected', decisionReason: 'Not in the maintenance window.' });
    await expect(request()).resolves.toMatchObject({ status: 'Requested' });
  });

  it('the asker may cancel a waiting request, nobody else may', async () => {
    const row = await request();
    await expect(asTenant(TENANT_A, (tx) => store.cancel(tx, recorder(DECIDER), { id: row.id, by: DECIDER, reason: '', expectedVersion: 1, now: NOW }))).rejects.toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    expect(await asTenant(TENANT_A, (tx) => store.cancel(tx, recorder(), { id: row.id, by: ASKER, reason: 'Not needed any more.', expectedVersion: 1, now: NOW }))).toMatchObject({ status: 'Cancelled' });
  });

  it('records the outcome of an approved request: the label of the kind asked for, or the failure; nothing else', async () => {
    const row = await decide(await request({ kind: 'diff' }));
    await expect(record(row, { backupLabel: '20261109-043000F' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(record(row, { backupLabel: 'latest' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const done = await record(row, { backupLabel: '20261109-013000F_20261109-043000D' });
    expect(done).toMatchObject({ status: 'Completed', backupLabel: '20261109-013000F_20261109-043000D', recordedBy: DECIDER });
    await expect(record(done)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    const failed = await decide(await request({ kind: 'incr' }));
    await expect(record(failed, { outcome: 'failed', note: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await record(failed, { outcome: 'failed', note: 'pgBackRest stopped: lock held.' })).toMatchObject({ status: 'Failed', outcomeNote: 'pgBackRest stopped: lock held.', backupLabel: null });
    const waiting = await request({ kind: 'full' });
    await expect(record(waiting)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
  });

  it('lists the newest first, a page at a time, and a tenant sees only its own requests', async () => {
    const first = await request({ kind: 'full' });
    await request({ kind: 'diff' }, recorder(), TENANT_A);
    await request({ kind: 'incr' }, recorder(), TENANT_B);
    const page = await asTenant(TENANT_A, (tx) => store.list(tx, { limit: 1 }));
    expect(page).toHaveLength(1);
    const all = await asTenant(TENANT_A, (tx) => store.list(tx, { limit: 10 }));
    expect(all.map((row) => row.kind).sort()).toEqual(['diff', 'full']);
    expect(await asTenant(TENANT_B, (tx) => store.find(tx, first.id))).toBeUndefined();
    await expect(asTenant(TENANT_B, (tx) => store.cancel(tx, recorder(), { id: first.id, by: ASKER, reason: '', expectedVersion: 1, now: NOW }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('the table guards itself: no delete, no change of what was asked, no skipped state, no self approval', async () => {
    const row = await request();
    expect(await sqlError(TENANT_A, 'delete from machvon.backup_request where id = $1::uuid', [row.id])).toBeDefined();
    expect(await sqlError(TENANT_A, "update machvon.backup_request set reason = 'a different reason entirely' where id = $1::uuid", [row.id])).toBe('42501');
    expect(await sqlError(TENANT_A, "update machvon.backup_request set status = 'Completed' where id = $1::uuid", [row.id])).toBeDefined();
    expect(await sqlError(TENANT_A, "update machvon.backup_request set status = 'Approved', decided_by = requested_by, decided_at = now() where id = $1::uuid", [row.id])).toBe('23514');
  });
});
