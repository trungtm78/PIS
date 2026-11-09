import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { BackupRequestCommandsController, BackupRequestReadsController } from '../../src/modules/adm/backup-request.controller';
import { BACKUP_STATE_PORT, FileBackupState, NoBackupState, backupStateFromEnvironment, backupsFromPgbackrestInfo } from '../../src/modules/adm/backup-state.port';
import type { BackupStatePort } from '../../src/modules/adm/backup-state.port';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ASKER = 1; // adm.backup.request and adm.backup.decide on the whole tenant
const DECIDER = 2; // the same: the second person
const READER = 3; // adm.backup.read only
const UNIT_ADMIN = 4; // every backup permission, on the subtree of a unit only
const NOBODY = 5; // no grant
const REASON = 'Before the upgrade of the release on Saturday.';
const NOW_SECONDS = Math.floor(Date.now() / 1000);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const infoJson = (stop: number, label = '20261109-013000F', type = 'full', error?: boolean): string =>
  JSON.stringify([{ name: 'machvon', backup: [{ label, type, timestamp: { start: stop - 60, stop }, ...(error === undefined ? {} : { error }), database: { 'repo-key': 1 } }] }]);

describe('manual backup requests and the state of the backups (INFRA-2, HSKT YCK.06)', () => {
  const harness = new AuthzHarness();
  const folder = mkdtempSync(join(tmpdir(), 'machvon-backup-state-'));
  let app: RunningApp;
  let state: BackupStatePort = new NoBackupState();

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const request = (member: number, body: Record<string, unknown> = { kind: 'full', repository: 1, reason: REASON }) => call('POST', '/backup-requests', { member, body });
  const decide = (member: number, requestId: string, body: Record<string, unknown> = { decision: 'approve', reason: 'Window agreed.' }, ifMatch = '"1"') => call('POST', `/backup-requests/${requestId}/decision`, { member, body, ifMatch });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [ASKER, DECIDER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'BACKUP_ADMIN', ['adm.backup.read', 'adm.backup.request', 'adm.backup.decide', 'adm.backup.record'], 60);
    await harness.seedRole(TENANT_A, 2, 'BACKUP_READER', ['adm.backup.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ASKER, role: 1, kind: 'TENANT' },
      { n: 2, member: DECIDER, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [BackupRequestCommandsController, BackupRequestReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: BACKUP_STATE_PORT, useValue: { read: (now: Date) => state.read(now) } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  afterEach(async () => {
    for (const tenant of [TENANT_A, TENANT_B]) await harness.owner(tenant, [['delete from machvon.backup_request', []], ["delete from machvon.audit_event where resource_type = 'backup_request'", []]]);
  });

  it('records a request, audits it, and the second person approves it; the run is recorded with the pgBackRest label', async () => {
    const asked = await request(ASKER, { kind: 'diff', repository: 1, reason: REASON });
    expect(asked.status).toBe(201);
    expect(asked.json).toMatchObject({ status: 'REQUESTED', resource_version: 1 });
    const id = idOf(asked);
    const approved = await decide(DECIDER, id);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
    const badLabel = await call('POST', `/backup-requests/${id}/outcome`, { member: DECIDER, ifMatch: '"2"', body: { outcome: 'completed', backup_label: '20261109-013000F' } });
    expect(badLabel.status).toBe(422);
    const done = await call('POST', `/backup-requests/${id}/outcome`, { member: DECIDER, ifMatch: '"2"', body: { outcome: 'completed', backup_label: '20261109-013000F_20261109-123000D' } });
    expect(done.json).toMatchObject({ status: 'COMPLETED', resource_version: 3 });
    const actions = await harness.owner<{ action: string }>(TENANT_A, [["select action from machvon.audit_event where resource_type = 'backup_request' and resource_id = $1 order by seq", [id]]]);
    expect(actions.map((row) => row.action)).toEqual(['backup.requested', 'backup.decided', 'backup.recorded']);
  });

  it('the person who asked can neither approve nor reject (403 SELF_APPROVAL_DENIED); a stale version is 409; a decided request is final', async () => {
    const id = idOf(await request(ASKER));
    expect((await decide(ASKER, id)).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect((await decide(ASKER, id, { decision: 'reject', reason: 'Withdrawn by me.' })).status).toBe(403);
    expect((await decide(DECIDER, id, undefined, '"9"')).status).toBe(409);
    expect((await decide(DECIDER, id)).status).toBe(200);
    expect((await decide(DECIDER, id, { decision: 'reject', reason: 'Too late to refuse.' }, '"2"')).json).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
  });

  it('refuses a second open request of the same kind (409 BACKUP_REQUEST_OPEN), an invalid kind and an archive differential (422)', async () => {
    expect((await request(ASKER)).status).toBe(201);
    expect((await request(DECIDER)).json).toMatchObject({ code: 'BACKUP_REQUEST_OPEN' });
    expect((await request(ASKER, { kind: 'weekly', reason: REASON })).status).toBe(422);
    expect((await request(ASKER, { kind: 'diff', repository: 2, reason: REASON })).status).toBe(422);
    expect((await request(ASKER, { kind: 'incr', reason: 'short' })).status).toBe(422);
  });

  it('only the asker cancels, and only while the request waits', async () => {
    const id = idOf(await request(ASKER));
    expect((await call('POST', `/backup-requests/${id}/cancel`, { member: DECIDER, ifMatch: '"1"', body: { reason: 'Not mine to cancel.' } })).status).toBe(403);
    expect((await call('POST', `/backup-requests/${id}/cancel`, { member: ASKER, ifMatch: '"1"', body: { reason: 'Not needed any more.' } })).json).toMatchObject({ status: 'CANCELLED' });
    expect((await call('POST', `/backup-requests/${id}/cancel`, { member: ASKER, ifMatch: '"2"', body: { reason: 'Cancelling a second time.' } })).status).toBe(409);
  });

  it('a caller without the permission, with a grant on a subtree only, or from another tenant changes nothing', async () => {
    expect((await request(NOBODY)).status).toBe(403);
    expect((await request(READER)).status).toBe(403);
    expect((await request(UNIT_ADMIN)).status).toBe(403);
    expect(await harness.owner(TENANT_A, [['select 1 from machvon.backup_request', []]])).toEqual([]);
    const id = idOf(await request(ASKER));
    expect((await call('POST', `/backup-requests/${id}/decision`, { member: ASKER, tenantId: TENANT_B, ifMatch: '"1"', body: { decision: 'approve' } })).status).toBeGreaterThanOrEqual(403);
    expect((await call('GET', '/backup-requests', { member: NOBODY })).status).toBe(403);
  });

  it('lists the requests with the state the port reports: UNKNOWN without a source, the health of the files with one', async () => {
    await request(ASKER);
    state = new NoBackupState();
    const none = await call('GET', '/backup-requests?limit=5', { member: READER });
    expect(none.status).toBe(200);
    expect((none.json.items as unknown[]).length).toBe(1);
    expect(none.json.state).toMatchObject({ source: 'NONE', health: 'UNKNOWN', detail: 'NOT_CONFIGURED', backups: [] });

    const infoFile = join(folder, 'info.json');
    const verifyFile = join(folder, 'verify.json');
    writeFileSync(infoFile, infoJson(NOW_SECONDS - 3600));
    writeFileSync(verifyFile, JSON.stringify({ at: '2026-11-08T03:35:00Z' }));
    state = new FileBackupState({ infoFile, verifyFile });
    const ok = await call('GET', '/backup-requests', { member: READER });
    expect(ok.json.state).toMatchObject({ source: 'FILE', health: 'OK', last_verify_at: '2026-11-08T03:35:00.000Z', detail: null });
    expect((ok.json.state as { backups: Array<{ label: string }> }).backups[0]?.label).toBe('20261109-013000F');
    expect((await call('GET', '/backup-requests?limit=0', { member: READER })).status).toBe(422);
  });
});

describe('the backup state files (no database)', () => {
  const folder = mkdtempSync(join(tmpdir(), 'machvon-backup-files-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const now = new Date();

  it('reads pgBackRest info output newest first, skips entries it cannot use and reports a failed one', () => {
    const text = JSON.stringify([
      { name: 'other', backup: [] },
      { name: 'machvon', backup: [
        { label: 'older', type: 'full', timestamp: { stop: 100 } },
        { label: '20261109-013000F', type: 'full', timestamp: { stop: 2000 }, database: { 'repo-key': 2 } },
        { label: '20261109-013000F_20261109-053000I', type: 'incr', timestamp: { stop: 3000 }, error: true },
        { label: 'no-stop', type: 'full' },
        { label: 'odd', type: 'weird', timestamp: { stop: 5000 } },
      ] },
    ]);
    const entries = backupsFromPgbackrestInfo(text, 'machvon') ?? [];
    expect(entries.map((entry) => [entry.label, entry.kind, entry.repository, entry.failed])).toEqual([
      ['20261109-013000F_20261109-053000I', 'incr', 1, true],
      ['20261109-013000F', 'full', 2, false],
      ['older', 'full', 1, false],
    ]);
    expect(backupsFromPgbackrestInfo('not json', 'machvon')).toBeUndefined();
    expect(backupsFromPgbackrestInfo('{}', 'machvon')).toBeUndefined();
    expect(backupsFromPgbackrestInfo('[]', 'machvon')).toBeUndefined();
  });

  it('is UNKNOWN with the reason when the file is missing, old or malformed, STALE when the newest full backup is old, FAILED when the newest backup failed', async () => {
    const info = join(folder, 'info.json');
    expect(await new FileBackupState({ infoFile: join(folder, 'missing.json') }).read(now)).toMatchObject({ health: 'UNKNOWN', detail: 'STATE_FILE_UNREADABLE' });
    writeFileSync(info, 'garbage');
    expect(await new FileBackupState({ infoFile: info }).read(now)).toMatchObject({ health: 'UNKNOWN', detail: 'STATE_FILE_MALFORMED' });
    writeFileSync(info, infoJson(Math.floor(now.getTime() / 1000) - 40 * 3600));
    expect(await new FileBackupState({ infoFile: info }).read(now)).toMatchObject({ health: 'STALE' });
    writeFileSync(info, infoJson(Math.floor(now.getTime() / 1000) - 60, '20261109-013000F', 'full', true));
    expect(await new FileBackupState({ infoFile: info }).read(now)).toMatchObject({ health: 'FAILED' });
    const old = new Date(now.getTime() - 3 * 3_600_000);
    utimesSync(info, old, old);
    expect(await new FileBackupState({ infoFile: info }).read(now)).toMatchObject({ health: 'UNKNOWN', detail: 'STATE_FILE_OLD' });
  });

  it('the environment selects the file adapter; without an info file there is no state', async () => {
    expect(backupStateFromEnvironment({})).toBeInstanceOf(NoBackupState);
    expect(backupStateFromEnvironment({ MACHVON_BACKUP_INFO_FILE: ' ' })).toBeInstanceOf(NoBackupState);
    expect(backupStateFromEnvironment({ MACHVON_BACKUP_INFO_FILE: join(folder, 'info.json') })).toBeInstanceOf(FileBackupState);
  });
});
