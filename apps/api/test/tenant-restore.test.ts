import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, RestoreEngineUnbound, UnboundRestoreEngine, defaultRestoreEngine, sharedMockRestoreEngine } from '@machvon/db';
import { canonicalJson, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { TenantRestoreJob } from '../src/modules/sas/tenant-restore.job';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const ASKER = '00000000-0000-4000-8000-0000000000f2';
const DECIDER = '00000000-0000-4000-8000-0000000000f3';
const WORKER = '00000000-0000-4000-8000-000000000000';
const REASON = 'A wrong import at noon must be undone for the province.';
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Restore = Record<string, unknown>;

describe('the restore of one tenant over HTTP (ST-SAS-019, SAS-21)', () => {
  const harness = new ProvisioningHarness();
  const engine = sharedMockRestoreEngine();
  let app: RunningApp;
  let previousEnvironment: string | undefined;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function send(actor: string, roles: string[] | undefined, method: string, path: string, options: { payload?: unknown; ifMatch?: number; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: actor, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify({ aud: 'control', roles: roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const pointAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
  const asking = (tenantId: string, payload: Record<string, unknown> = {}, key?: string, roles?: string[]) =>
    send(ASKER, roles, 'POST', `/system/tenants/${tenantId}/restore-requests`, { payload: { recovery_point: pointAgo(2), target: 'SANDBOX', reason: REASON, ...payload }, key });
  const deciding = (restoreId: string, version: number, payload: Record<string, unknown> = {}, actor = DECIDER, roles?: string[]) =>
    send(actor, roles, 'POST', `/system/restore-requests/${restoreId}/decision`, { payload: { decision: 'approve', reason: 'The incident is confirmed by the owner.', evidence_ids: [], ...payload }, ifMatch: version });
  const listed = async (tenantId: string, query = ''): Promise<Reply> => send(ASKER, undefined, 'GET', `/system/tenants/${tenantId}/restore-requests${query}`);
  const itemsOf = async (tenantId: string): Promise<Restore[]> => (await listed(tenantId)).json.items as Restore[];
  const one = async (tenantId: string, restoreId: string): Promise<Restore> => {
    const found = (await itemsOf(tenantId)).find((item) => item.id === restoreId);
    if (found === undefined) throw new Error('the restore is not listed');
    return found;
  };
  /** The worker's pass for the tenant, as the job `tenant-restore` runs it. */
  const pass = (tenantId: string, now = new Date()) => new TenantRestoreJob(harness.tenants, new AuditWriter(harness.tenants), engine).run({ tenantId, membershipId: WORKER, scopeVersion: 1 }, now);

  async function tenant(status: 'Active' | 'Suspended' = 'Active'): Promise<string> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    if (status === 'Suspended') await suspend(created.tenantId);
    return created.tenantId;
  }
  const suspend = (tenantId: string) =>
    admin("update machvon.tenant set status = 'Suspended', lifecycle_reason = 'NON_PAYMENT', suspended_at = now(), version = version + 1 where id = $1", [tenantId]);
  const resume = (tenantId: string) => admin("update machvon.tenant set status = 'Active', lifecycle_reason = null, suspended_at = null, version = version + 1 where id = $1", [tenantId]);
  const putProbe = (tenantId: string, label: string, amount: string) => admin('insert into machvon.restore_probe (tenant_id, id, label, amount_vnd) values ($1, $2, $3, $4)', [tenantId, randomUUID(), label, amount]);

  /** A request approved by a second administrator, waiting for the worker. */
  async function approved(tenantId: string, payload: Record<string, unknown> = {}): Promise<string> {
    const asked = await asking(tenantId, payload);
    expect(asked.status).toBe(201);
    const decided = await deciding(asked.json.resource_id as string, asked.json.resource_version as number);
    expect(decided.status).toBe(202);
    return asked.json.resource_id as string;
  }

  beforeAll(async () => {
    previousEnvironment = process.env.MACHVON_ENVIRONMENT;
    process.env.MACHVON_ENVIRONMENT = 'test';
    await harness.start();
    // A table of the tenant plane with money in it, to be measured as the business tables are.
    await harness.admin(async (client) => {
      await client.query('create table machvon.restore_probe (tenant_id uuid not null, id uuid not null, label text not null, amount_vnd numeric(24,0) not null default 0, primary key (tenant_id, id))');
      await client.query('alter table machvon.restore_probe enable row level security');
      await client.query('alter table machvon.restore_probe force row level security');
      await client.query("create policy tenant_boundary on machvon.restore_probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)");
      await client.query('grant select, insert, update, delete on machvon.restore_probe to machvon_app');
    });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  beforeEach(() => engine.reset());

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    if (previousEnvironment === undefined) delete process.env.MACHVON_ENVIRONMENT;
    else process.env.MACHVON_ENVIRONMENT = previousEnvironment;
  }, 60_000);

  it('AC-ST-SAS-019-1 UAT-AC171: a sandbox restore is requested by one System Admin, approved by another and Completed with its verification report; an in-place request on an Active tenant is 409 TENANT_STATE_INVALID', async () => {
    const tenantId = await tenant();
    await putProbe(tenantId, 'contract', '1000000');
    await putProbe(tenantId, 'payment', '250000');
    const asked = await asking(tenantId);
    expect(asked.status).toBe(201);
    expect(asked.json).toMatchObject({ status: 'PENDING_APPROVAL', resource_version: 1 });
    const restoreId = asked.json.resource_id as string;
    expect(await one(tenantId, restoreId)).toMatchObject({ status: 'Requested', target: 'SANDBOX', requested_by: ASKER, reason: REASON, approved_by: null, verification_report: null });

    const decided = await deciding(restoreId, 1);
    expect(decided.status).toBe(202);
    expect(decided.json).toMatchObject({ status: 'APPROVED', resource_id: restoreId, resource_version: 2 });
    expect(await one(tenantId, restoreId)).toMatchObject({ status: 'Approved', decided_by: DECIDER, approved_by: DECIDER });
    // The work is the worker's: nothing was restored by the request or the decision.
    expect(engine.restored).toEqual([]);

    expect(await pass(tenantId)).toEqual({ pending: 0, failed: 0 });
    expect(engine.restored).toHaveLength(1);
    const done = await one(tenantId, restoreId);
    expect(done).toMatchObject({ status: 'Completed', sandbox_ref: `mock-sandbox/${restoreId}`, error_code: null });
    expect(done.verification_report).toMatchObject({ matched: true, mismatches: [], foreign_rows: 0 });

    // The same recovery point asked in place, while the tenant is Active.
    const inPlace = await asking(tenantId, { target: 'IN_PLACE' });
    expect([inPlace.status, inPlace.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
    expect((await itemsOf(tenantId)).filter((item) => item.target === 'IN_PLACE')).toEqual([]);
  });

  it('AC-ST-SAS-019-2 OPS01: the drill measures rows, checksums and money totals against the backup, RPO and RTO against the targets, and leaves a record: the report, its sha256, the audit rows and the event', async () => {
    const [tenantId, other] = [await tenant(), await tenant()];
    for (const [label, amount] of [['contract', '1000000'], ['payment', '250000'], ['advance', '12345']] as const) await putProbe(tenantId, label, amount);
    await putProbe(other, 'decoy-of-another-tenant', '999999999');
    const restoreId = await approved(tenantId);
    await pass(tenantId);

    const done = await one(tenantId, restoreId);
    const report = done.verification_report as Record<string, unknown> & { tables: Array<Record<string, unknown>>; totals: Record<string, unknown> };
    expect(done.status).toBe('Completed');
    expect(report).toMatchObject({ schema_version: 1, matched: true, foreign_rows: 0, rpo_seconds: 0, rpo_target_seconds: 900, rto_target_seconds: 14_400, within_targets: true, mismatches: [] });
    expect(report.rto_seconds as number).toBeLessThan(60);
    const probe = report.tables.find((table) => table.table === 'restore_probe');
    expect(probe).toMatchObject({ expected_rows: 3, restored_rows: 3, rows_match: true, checksum_match: true, money: [{ column: 'amount_vnd', expected: '1262345', restored: '1262345', match: true }] });
    expect(report.totals).toMatchObject({ rows_expected: report.totals.rows_restored });
    expect(Number((report.totals as { tables: number }).tables)).toBeGreaterThan(5);
    // Nothing of the other tenant is in the report, and the figures are only the tenant's.
    expect(JSON.stringify(report)).not.toContain('999999999');
    expect(JSON.stringify(done)).not.toContain('decoy');

    // The drill record: the report as stored, with the sha256 that names it.
    const [stored] = await admin<{ verification_report: unknown; verification_report_ref: string; status: string }>('select verification_report, verification_report_ref, status from machvon.tenant_restore_request where id = $1', [restoreId]);
    expect(stored?.verification_report_ref).toBe(`sha256:${createHash('sha256').update(canonicalJson(stored?.verification_report)).digest('hex')}`);
    expect(done.verification_report_ref).toBe(stored?.verification_report_ref);
    const audits = await admin<{ action: string; tenant_id: string; actor_id: string }>('select action, tenant_id, actor_id from machvon.audit_event where resource_id = $1 order by occurred_at', [restoreId]);
    expect(audits.map((row) => row.action)).toEqual(['tenant.restore_requested', 'tenant.restore_decided', 'tenant.restore_completed']);
    expect(new Set(audits.map((row) => row.tenant_id))).toEqual(new Set([tenantId]));
    expect(audits.map((row) => row.actor_id)).toEqual([ASKER, DECIDER, WORKER]);
    const events = await admin<{ type: string; tenant_id: string; payload: Record<string, unknown> }>('select type, tenant_id, payload from machvon.outbox_event where aggregate_id = $1', [restoreId]);
    expect(events).toEqual([{ type: 'sas.tenant_restore.completed.v1', tenant_id: tenantId, payload: { restore_id: restoreId, target: 'SANDBOX', within_targets: true } }]);
    // No personal data and no figures of the tenant in the event or in the audit trail.
    expect(JSON.stringify(events)).not.toContain('1262345');
  });

  it('AC-ST-SAS-019-2 OPS01: a copy that differs from the backup (a missing row, another money total, a row of another tenant) is not Completed: it is Failed with the report that names each difference, and no event tells the platform it is done', async () => {
    const tenantId = await tenant();
    await putProbe(tenantId, 'contract', '1000000');
    await putProbe(tenantId, 'payment', '250000');
    engine.tamperWith((copy) => ({
      ...copy,
      foreignRows: 3,
      tables: { ...copy.tables, restore_probe: { rows: 1, checksum: 'f'.repeat(32), money: { amount_vnd: '1000000' } } },
    }));
    const restoreId = await approved(tenantId);
    expect(await pass(tenantId)).toEqual({ pending: 0, failed: 1 });
    const failed = await one(tenantId, restoreId);
    expect(failed).toMatchObject({ status: 'Failed', error_code: 'VERIFICATION_MISMATCH' });
    expect(failed.verification_report).toMatchObject({ matched: false, foreign_rows: 3, mismatches: expect.arrayContaining(['rows:restore_probe', 'checksum:restore_probe', 'money:restore_probe.amount_vnd', 'foreign_rows']) });
    expect(failed.verification_report_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await admin('select 1 from machvon.outbox_event where aggregate_id = $1', [restoreId])).toEqual([]);
    expect((await admin<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at', [restoreId])).map((row) => row.action)).toEqual(['tenant.restore_requested', 'tenant.restore_decided', 'tenant.restore_failed']);
    // A failed restore is final: a new attempt is a new request.
    expect((await deciding(restoreId, failed.version as number)).status).toBe(409);
  });

  it('AC-ST-SAS-019-2 OPS01: a copy that stops before the recovery point asked for measures RPO, and a miss of the target of 15 minutes is flagged without failing a copy that matches', async () => {
    const tenantId = await tenant();
    engine.stopBefore(1200);
    const restoreId = await approved(tenantId);
    await pass(tenantId);
    const done = await one(tenantId, restoreId);
    expect(done.status).toBe('Completed');
    expect(done.verification_report).toMatchObject({ matched: true, rpo_seconds: 1200, within_targets: false });
    expect(new Date(done.restored_to as string).getTime()).toBe(new Date(done.recovery_point as string).getTime() - 1_200_000);
  });

  it('an engine that is down ends the restore as Failed with the class of the failure and never its message; the next request is a new one', async () => {
    const tenantId = await tenant();
    engine.failNext(1);
    const restoreId = await approved(tenantId);
    await pass(tenantId);
    const failed = await one(tenantId, restoreId);
    expect(failed).toMatchObject({ status: 'Failed', error_code: 'RestoreEngineUnreachable', verification_report: null, sandbox_ref: null });
    expect(JSON.stringify(failed)).not.toContain('not reachable');
    const again = await approved(tenantId);
    await pass(tenantId);
    expect((await one(tenantId, again)).status).toBe('Completed');
  });

  it('AC-ST-SAS-019-1: an in-place restore of a Suspended tenant is made and verified, and the tenant stays Suspended (reopening it is a decision of its own); one at a time (409 RESTORE_IN_PROGRESS)', async () => {
    const tenantId = await tenant('Suspended');
    const before = (await admin<{ version: string }>('select version::text from machvon.tenant where id = $1', [tenantId]))[0]?.version;
    const restoreId = await approved(tenantId, { target: 'IN_PLACE' });
    const second = await asking(tenantId, { target: 'IN_PLACE' });
    expect([second.status, second.json.code]).toEqual([409, 'RESTORE_IN_PROGRESS']);
    await pass(tenantId);
    expect(await one(tenantId, restoreId)).toMatchObject({ status: 'Completed', target: 'IN_PLACE', sandbox_ref: null });
    expect(engine.restored.map((job) => job.target)).toEqual(['IN_PLACE']);
    expect((await admin<{ status: string; version: string }>('select status, version::text from machvon.tenant where id = $1', [tenantId]))[0]).toEqual({ status: 'Suspended', version: before });
    // The restore has ended, so the next one may be asked for.
    expect((await asking(tenantId, { target: 'IN_PLACE' })).status).toBe(201);
  });

  it('AC-ST-SAS-019-1: an in-place restore of a tenant that was resumed between the approval and the worker is not made (Failed, TENANT_STATE_INVALID); a decision after the resumption is 409 too', async () => {
    const tenantId = await tenant('Suspended');
    const asked = await asking(tenantId, { target: 'IN_PLACE' });
    await resume(tenantId);
    const refused = await deciding(asked.json.resource_id as string, 1);
    expect([refused.status, refused.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
    expect((await one(tenantId, asked.json.resource_id as string)).status).toBe('Requested');
    await suspend(tenantId);
    // The first request still holds the in-place slot; turn it down, and the next is approved while the tenant is Suspended.
    expect((await deciding(asked.json.resource_id as string, 1, { decision: 'reject', reason: 'Asked for the wrong point.' })).status).toBe(202);
    const second = await approved(tenantId, { target: 'IN_PLACE' });
    await resume(tenantId);
    await pass(tenantId);
    expect(await one(tenantId, second)).toMatchObject({ status: 'Failed', error_code: 'TENANT_STATE_INVALID', sandbox_ref: null });
    expect(engine.restored).toEqual([]);
  });

  it('AC-ST-SAS-019-1: the person who asked cannot decide, either way (403 SELF_APPROVAL_DENIED); a stale version is 409 VERSION_CONFLICT; a decided request is 409; "return" is not offered', async () => {
    const tenantId = await tenant();
    const asked = await asking(tenantId);
    const restoreId = asked.json.resource_id as string;
    for (const decision of ['approve', 'reject']) {
      const self = await deciding(restoreId, 1, { decision }, ASKER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    }
    const stale = await deciding(restoreId, 9);
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    const returned = await deciding(restoreId, 1, { decision: 'return' });
    expect([returned.status, returned.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(await one(tenantId, restoreId)).toMatchObject({ status: 'Requested', version: 1, decided_by: null });
    expect((await deciding(restoreId, 1, { decision: 'reject', reason: 'The point was not the right one.' })).json).toMatchObject({ status: 'REJECTED' });
    const again = await deciding(restoreId, 2);
    expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
    expect(await one(tenantId, restoreId)).toMatchObject({ status: 'Rejected', approved_by: null, decision_reason: 'The point was not the right one.' });
    expect(await pass(tenantId)).toEqual({ pending: 0, failed: 0 });
    expect(engine.restored).toEqual([]);
  });

  it('refuses a recovery point the backups do not hold (422 RECOVERY_POINT_UNAVAILABLE), also when the engine holds none, and a request that is not valid; an unknown tenant or restore is 404', async () => {
    const tenantId = await tenant();
    for (const recovery_point of [pointAgo(36), new Date(Date.now() + DAY).toISOString()]) {
      const reply = await asking(tenantId, { recovery_point });
      expect([reply.status, reply.json.code]).toEqual([422, 'RECOVERY_POINT_UNAVAILABLE']);
    }
    const short = await asking(tenantId, { reason: 'short' });
    expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect([400, 422]).toContain((await asking(tenantId, { target: 'ELSEWHERE' })).status);
    expect([400, 422]).toContain((await asking(tenantId, { recovery_point: 'yesterday' })).status);
    engine.holdOnly(() => undefined);
    const none = await asking(tenantId);
    expect([none.status, none.json.code]).toEqual([422, 'RECOVERY_POINT_UNAVAILABLE']);
    expect((await listed(tenantId)).json).toMatchObject({ recovery_window: null, rpo_target_seconds: 900, rto_target_seconds: 14_400 });
    engine.holdOnly(undefined);
    expect((await asking(randomUUID())).status).toBe(404);
    expect((await listed(randomUUID())).status).toBe(404);
    expect((await deciding(randomUUID(), 1)).status).toBe(404);
    expect(await itemsOf(tenantId)).toEqual([]);

    // A request that waited until its point left the window is refused at the decision.
    const old = await asking(tenantId, { recovery_point: pointAgo(34.99) });
    engine.holdOnly((_tenant, now) => ({ earliest: new Date(now.getTime() - DAY), latest: now }));
    const late = await deciding(old.json.resource_id as string, 1);
    expect([late.status, late.json.code]).toEqual([422, 'RECOVERY_POINT_UNAVAILABLE']);
  });

  it('answers the same Idempotency-Key with the same result and writes one request; a different body under it is 409', async () => {
    const tenantId = await tenant();
    const key = `key-${randomUUID()}`;
    const body = { recovery_point: pointAgo(2) };
    const first = await asking(tenantId, body, key);
    const replay = await asking(tenantId, body, key);
    expect([replay.status, replay.json]).toEqual([201, first.json]);
    expect((await itemsOf(tenantId)).length).toBe(1);
    const different = await asking(tenantId, { ...body, reason: 'A different reason that is long enough.' }, key);
    expect([different.status, different.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
  });

  it('lists the restores of the tenant, the newest first, a page at a time, with the state of the tenant and the window of the backups; another tenant sees none of them', async () => {
    const [tenantId, other] = [await tenant(), await tenant()];
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) ids.push((await asking(tenantId)).json.resource_id as string);
    const firstPage = await listed(tenantId, '?limit=2');
    expect(firstPage.status).toBe(200);
    expect(firstPage.json).toMatchObject({ tenant_status: 'Active', rpo_target_seconds: 900, rto_target_seconds: 14_400 });
    const window = firstPage.json.recovery_window as { earliest: string; latest: string };
    expect(new Date(window.latest).getTime() - new Date(window.earliest).getTime()).toBe(35 * DAY);
    expect((firstPage.json.items as Restore[]).map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const cursor = firstPage.json.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    const secondPage = await listed(tenantId, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect((secondPage.json.items as Restore[]).map((item) => item.id)).toEqual([ids[0]]);
    expect(secondPage.json.next_cursor).toBeNull();
    expect((await listed(other)).json.items).toEqual([]);
    expect([(await listed(tenantId, '?cursor=not-a-cursor')).status]).toEqual([422]);
  });

  it('is judged by the environment: where real data is held no engine is bound, no recovery point is offered and a restore is never claimed; elsewhere it is the MOCK of the process', async () => {
    for (const environment of ['production', undefined, 'unknown']) {
      const unbound = defaultRestoreEngine(harness.tenants, environment);
      expect(unbound).toBeInstanceOf(UnboundRestoreEngine);
      expect(await unbound.window('t', new Date())).toBeUndefined();
      await expect(unbound.restore({ tenantId: 't', restoreId: 'r', recoveryPoint: new Date(), target: 'SANDBOX' })).rejects.toBeInstanceOf(RestoreEngineUnbound);
    }
    expect(defaultRestoreEngine(harness.tenants, 'test')).toBe(engine);
    expect(defaultRestoreEngine(harness.tenants, 'staging')).toBe(engine);
  });

  describe('generated matrix: every restore operation against every realm role', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('restore-requests'));
    const cases = controlCasesFor(operations);

    it('lists the three operations', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual(['decideTenantRestore', 'listTenantRestoreRequests', 'requestTenantRestore']);
    });

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
      if (operation === undefined) throw new Error('operation of the case is not listed');
      const tenantId = await tenant();
      const waiting = (await asking(tenantId)).json;
      const path = operation.path.replace('{tenantId}', tenantId).replace('{restoreId}', waiting.resource_id as string);
      const deniedBefore = Number((await admin<{ n: string }>("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]))[0]?.n);
      const payload = operation.operationId === 'decideTenantRestore' ? { decision: 'approve', reason: 'The incident is confirmed by the owner.', evidence_ids: [] } : { recovery_point: pointAgo(3), target: 'SANDBOX', reason: REASON };
      const reply = await send(DECIDER, [matrixCase.role], operation.method, path, { payload, ifMatch: operation.operationId === 'decideTenantRestore' ? 1 : undefined });
      if (matrixCase.expected === 'allow') {
        expect(reply.status).toBeLessThan(300);
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      if (operation.method === 'POST') {
        expect(Number((await admin<{ n: string }>("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]))[0]?.n)).toBe(deniedBefore + 1);
      }
      // Nothing was written by the refusal: the request still waits, and no other was made.
      expect(await itemsOf(tenantId)).toHaveLength(1);
      expect((await one(tenantId, waiting.resource_id as string)).status).toBe('Requested');
    });
  });
});
