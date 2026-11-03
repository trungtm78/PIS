import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, PlacementMigrationRunner, sharedMockPlacementMover } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { TableMeasure } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
// Two different System Admins: the one who starts the promotion and the one who approves the cutover (four eyes).
const STARTER = '00000000-0000-4000-8000-0000000000f2';
const APPROVER = '00000000-0000-4000-8000-0000000000f3';
const REASON = 'The tenant asked for a database of its own.';
const WHY = 'The comparison agrees and the window is agreed with the customer.';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WORKER = '00000000-0000-4000-8000-0000000000f9';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Call {
  admin?: string;
  roles?: string[];
  payload?: unknown;
  ifMatch?: number;
  key?: string;
}

describe('the promotion of a tenant to a silo over HTTP (ST-SAS-018)', () => {
  const harness = new ProvisioningHarness();
  const mover = sharedMockPlacementMover();
  let app: RunningApp;
  let previousEnvironment: string | undefined;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function call(method: string, path: string, options: Call = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: options.admin ?? STARTER, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify({ aud: 'control', roles: options.roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  /** An Active tenant with two budgets (money in a table of its own) on the shared pool. */
  async function tenant(): Promise<string> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    for (const [period, amount] of [['MONTH', '123456789012345678901234'], ['QUARTER', '1000']] as const) {
      await admin("insert into machvon.ai_budget (tenant_id, id, scope_kind, period, limit_vnd, effective_from, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, '2026-01-01', $5, $5)", [created.tenantId, randomUUID(), period, amount, STARTER]);
    }
    return created.tenantId;
  }

  /** A silo of the region of the tenants the harness makes. */
  async function silo(): Promise<string> {
    const id = randomUUID();
    const [region] = await admin<{ region: string }>('select region from machvon.placement limit 1');
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status, max_tenants) values ($1, 'SILO', $2, $3, $4, 'Active', 1)", [id, region?.region ?? 'vn-north', `cluster-${id.slice(0, 8)}`, `kms-${id.slice(0, 8)}`]);
    return id;
  }

  const start = (tenantId: string, siloId: string, options: Call & { minutes?: number; window?: Date } = {}) =>
    call('POST', `/system/tenants/${tenantId}/placement-migrations`, {
      ...options,
      payload: options.payload ?? { to_placement_id: siloId, write_freeze_max_minutes: options.minutes ?? 30, planned_window_start: (options.window ?? new Date(Date.now() + MINUTE)).toISOString(), reason: REASON },
    });
  const detail = (id: string, options: Call = {}) => call('GET', `/system/placement-migrations/${id}`, options);
  const migrationOf = async (id: string) => ((await detail(id)).json.migration ?? {}) as Record<string, unknown>;
  const approve = (id: string, version: number, options: Call = {}) => call('POST', `/system/placement-migrations/${id}/cutover`, { admin: APPROVER, payload: { reason: WHY }, ifMatch: version, ...options });
  const abort = (id: string, version: number, options: Call = {}) => call('POST', `/system/placement-migrations/${id}/abort`, { admin: APPROVER, payload: { reason: 'The customer asked to stop the promotion.' }, ifMatch: version, ...options });
  const tenantRow = async (id: string) => (await admin<{ placement_id: string; isolation_mode: string; write_frozen_until: Date | null }>('select placement_id, isolation_mode, write_frozen_until from machvon.tenant where id = $1', [id]))[0];
  /** One pass of the worker for the tenant, at a moment. */
  const pass = (tenantId: string, at: Date = new Date()) =>
    new PlacementMigrationRunner({ control: harness.control, tenants: harness.tenants, mover, audit: new AuditWriter(harness.tenants) }).run({ tenantId, membershipId: WORKER, scopeVersion: 0 }, at);
  /** A moment later than now: the worker is run as if that time had come. */
  const ahead = (offsetMs: number): Date => new Date(Date.now() + offsetMs);
  const oneRowOff = (tables: TableMeasure[]): void => {
    const line = tables.find((entry) => entry.table === 'ai_budget') as TableMeasure;
    line.money = { ...line.money, limit_vnd: '1' };
  };

  beforeAll(async () => {
    previousEnvironment = process.env.MACHVON_ENVIRONMENT;
    process.env.MACHVON_ENVIRONMENT = 'test';
    await harness.start();
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

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    if (previousEnvironment === undefined) delete process.env.MACHVON_ENVIRONMENT;
    else process.env.MACHVON_ENVIRONMENT = previousEnvironment;
  }, 60_000);

  it('AC-ST-SAS-018-1 UAT-AC150: a copy with one row different is 422 MIGRATION_VERIFICATION_FAILED, the one who started is 403 SELF_APPROVAL_DENIED, and once the copy agrees the cutover is approved and the migration Completed with matching totals', async () => {
    const tenantId = await tenant();
    const siloId = await silo();
    const started = await start(tenantId, siloId, { window: new Date() });
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ status: 'PLANNED', resource_version: 1 });
    const id = started.json.resource_id as string;

    // The worker copies the data, and the copy has one row different.
    mover.tamperAfterNext(oneRowOff);
    expect(await pass(tenantId)).toMatchObject({ open: 1, mismatch: 1, failing: 0 });
    const waiting = await detail(id);
    expect(waiting.json.migration).toMatchObject({ status: 'AwaitingCutover', checksum_match: false, requested_by: STARTER, cutover_approved_by: null });
    const off = waiting.json.reconciliation as { match: boolean; mismatched_tables: string[]; tables: Array<{ table: string; money: Array<{ column: string; source: string; target: string; match: boolean }> }> };
    expect(off.match).toBe(false);
    expect(off.mismatched_tables).toEqual(['ai_budget']);
    const line = off.tables.find((entry) => entry.table === 'ai_budget');
    expect(line?.money.find((entry) => entry.column === 'limit_vnd')).toMatchObject({ source: '123456789012345678902234', target: '1', match: false });

    // Another System Admin approves: the copy differs.
    const version = (waiting.json.migration as { version: number }).version;
    const refused = await approve(id, version);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', reason: 'MISMATCH', tables: ['ai_budget'] });
    expect(refused.json.correlationId).toBeDefined();
    // The one who started: not allowed, whatever the copy.
    const self = await approve(id, version, { admin: STARTER });
    expect(self.status).toBe(403);
    expect(self.json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await migrationOf(id)).status).toBe('AwaitingCutover');
    expect((await tenantRow(tenantId))?.write_frozen_until).toBeNull();

    // The copy catches up: the next pass finds every table in agreement, and the cutover is approved by the other System Admin.
    expect(await pass(tenantId)).toMatchObject({ mismatch: 0 });
    const agreed = await detail(id);
    expect((agreed.json.reconciliation as { match: boolean }).match).toBe(true);
    const agreedVersion = (agreed.json.migration as { version: number }).version;
    const again = await approve(id, agreedVersion);
    expect(again.status).toBe(202);
    expect(again.json).toMatchObject({ status: 'CUTOVER_FROZEN', resource_id: id });
    const frozen = await tenantRow(tenantId);
    expect(frozen?.write_frozen_until).not.toBeNull();
    expect(frozen?.isolation_mode).toBe('POOL');
    expect(await migrationOf(id)).toMatchObject({ status: 'CutoverFrozen', cutover_approved_by: APPROVER, write_frozen_until: frozen?.write_frozen_until?.toISOString() });

    // Inside the freeze the worker sends the last difference, compares again and switches the routing; not in the first seconds of the freeze, while a write accepted just before it may still be coming in.
    await pass(tenantId);
    expect(await migrationOf(id)).toMatchObject({ status: 'CutoverFrozen' });
    await pass(tenantId, ahead(10_000));
    expect(await tenantRow(tenantId)).toMatchObject({ placement_id: siloId, isolation_mode: 'SILO', write_frozen_until: null });
    const tenantDetail = await call('GET', `/system/tenants/${tenantId}`);
    expect(tenantDetail.json).toMatchObject({ isolation_mode: 'SILO', placement_id: siloId });
    expect(await migrationOf(id)).toMatchObject({ status: 'Switched' });

    // Watched for 24 hours, then Completed, with the totals of the copy equal to those of the original.
    await pass(tenantId, ahead(23 * HOUR));
    expect(await migrationOf(id)).toMatchObject({ status: 'Switched' });
    await pass(tenantId, ahead(24 * HOUR + MINUTE));
    const done = await detail(id);
    expect(done.json.migration).toMatchObject({ status: 'Completed', checksum_match: true });
    const totals = done.json.reconciliation as { match: boolean; source_rows: number; target_rows: number; tables: Array<{ table: string; source_rows: number; target_rows: number; money: Array<{ column: string; source: string; target: string }> }> };
    expect(totals.match).toBe(true);
    expect(totals.source_rows).toBe(totals.target_rows);
    const allocation = totals.tables.find((entry) => entry.table === 'ai_budget');
    expect([allocation?.source_rows, allocation?.target_rows]).toEqual([2, 2]);
    expect(allocation?.money.find((entry) => entry.column === 'limit_vnd')).toMatchObject({ source: '123456789012345678902234', target: '123456789012345678902234' });
    // The old data is kept for 30 days.
    expect(Date.parse((done.json.migration as { source_purge_due_at: string }).source_purge_due_at) - Date.parse((done.json.migration as { completed_at: string }).completed_at)).toBe(30 * DAY);
  }, 180_000);

  it('AC-ST-SAS-018-2 UAT-AC151: a migration in CutoverFrozen that is aborted is RolledBack, and writes work again', async () => {
    const tenantId = await tenant();
    const siloId = await silo();
    const id = (await start(tenantId, siloId, { window: new Date() })).json.resource_id as string;
    await pass(tenantId);
    const waiting = await migrationOf(id);
    expect(waiting.status).toBe('AwaitingCutover');
    expect((await approve(id, waiting.version as number)).status).toBe(202);
    const frozen = await tenantRow(tenantId);
    expect(frozen?.write_frozen_until).not.toBeNull();
    // The runtime the guard of the API reads says writes are refused until then.
    const runtime = async () => (await admin<{ write_frozen_until: Date | null }>('select write_frozen_until from machvon.tenant_runtime($1::uuid)', [tenantId]))[0]?.write_frozen_until;
    expect(await runtime()).not.toBeNull();

    const current = await migrationOf(id);
    const aborted = await abort(id, current.version as number);
    expect(aborted.status).toBe(202);
    expect(aborted.json).toMatchObject({ status: 'ROLLED_BACK', resource_id: id });
    expect(await migrationOf(id)).toMatchObject({ status: 'RolledBack', ended_by: APPROVER, end_reason: 'The customer asked to stop the promotion.' });
    expect(await tenantRow(tenantId)).toMatchObject({ isolation_mode: 'POOL', write_frozen_until: null });
    expect(await runtime()).toBeNull();
    // The copy is destroyed by the next pass.
    expect(mover.holds({ tenantId, toPlacementId: siloId })).toBe(true);
    await pass(tenantId);
    expect(mover.holds({ tenantId, toPlacementId: siloId })).toBe(false);
    expect(await migrationOf(id)).toMatchObject({ target_discarded_at: expect.any(String) });
    // It is over: no second abort, no approval.
    expect((await abort(id, (await migrationOf(id)).version as number)).json.code).toBe('MIGRATION_STATE_INVALID');
  }, 180_000);

  it('rolls a switched migration back while the silo holds what the comparison saw, and refuses once it holds something else', async () => {
    const tenantId = await tenant();
    const id = (await start(tenantId, await silo(), { window: new Date() })).json.resource_id as string;
    const siloId = (await migrationOf(id)).to_placement_id as string;
    await pass(tenantId);
    await approve(id, (await migrationOf(id)).version as number);
    await pass(tenantId, ahead(10_000));
    expect(await migrationOf(id)).toMatchObject({ status: 'Switched' });
    expect(await tenantRow(tenantId)).toMatchObject({ isolation_mode: 'SILO', placement_id: siloId });
    // The silo took a row since the switch: there is no way back without losing it.
    mover.tamper({ tenantId, toPlacementId: siloId }, (tables) => void ((tables.find((entry) => entry.table === 'ai_budget') as TableMeasure).rows += 1));
    const refused = await abort(id, (await migrationOf(id)).version as number);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    expect(await migrationOf(id)).toMatchObject({ status: 'Switched' });
    // Put back as it was, the way back is open.
    mover.tamper({ tenantId, toPlacementId: siloId }, (tables) => void ((tables.find((entry) => entry.table === 'ai_budget') as TableMeasure).rows -= 1));
    expect((await abort(id, (await migrationOf(id)).version as number)).json.status).toBe('ROLLED_BACK');
    expect(await tenantRow(tenantId)).toMatchObject({ isolation_mode: 'POOL' });
  }, 180_000);

  it('rolls the migration back by itself when the freeze runs out before the switch: nobody ended it, and writes work again', async () => {
    const tenantId = await tenant();
    const id = (await start(tenantId, await silo(), { window: new Date(), minutes: 5 })).json.resource_id as string;
    await pass(tenantId);
    await approve(id, (await migrationOf(id)).version as number);
    await pass(tenantId, ahead(6 * MINUTE));
    expect(await migrationOf(id)).toMatchObject({ status: 'RolledBack', ended_by: null, end_reason: 'FREEZE_EXPIRED' });
    expect(await tenantRow(tenantId)).toMatchObject({ isolation_mode: 'POOL', write_frozen_until: null });
  }, 180_000);

  it('plans a promotion once for an idempotency key, and refuses a second open one, an unknown silo and a tenant that is not Active', async () => {
    const tenantId = await tenant();
    const siloId = await silo();
    const key = `key-${randomUUID()}`;
    const payload = { to_placement_id: siloId, write_freeze_max_minutes: 30, planned_window_start: new Date(Date.now() + MINUTE).toISOString(), reason: REASON };
    const first = await start(tenantId, siloId, { key, payload });
    const replay = await start(tenantId, siloId, { key, payload });
    // The same key with another body is another request: 409 IDEMPOTENCY_CONFLICT.
    expect((await start(tenantId, siloId, { key, payload: { ...payload, write_freeze_max_minutes: 31 } })).json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect([first.status, replay.status]).toEqual([202, 202]);
    expect(replay.json.resource_id).toBe(first.json.resource_id);
    expect(await admin('select 1 from machvon.tenant_placement_migration where tenant_id = $1', [tenantId])).toHaveLength(1);
    const second = await start(tenantId, await silo());
    expect([second.status, second.json.code]).toEqual([409, 'MIGRATION_ALREADY_OPEN']);
    const other = await tenant();
    expect(await start(other, randomUUID())).toMatchObject({ status: 422, json: { code: 'PLACEMENT_UNAVAILABLE', reason: 'NOT_FOUND' } });
    expect(await start(other, (await admin<{ id: string }>("select id from machvon.placement where kind = 'POOL' limit 1"))[0]?.id as string)).toMatchObject({ status: 422, json: { code: 'PLACEMENT_UNAVAILABLE' } });
    await admin("update machvon.tenant set status = 'Suspended' where id = $1", [other]);
    expect(await start(other, await silo())).toMatchObject({ status: 409, json: { code: 'TENANT_STATE_INVALID' } });
    expect((await start(randomUUID(), siloId)).status).toBe(404);
  }, 120_000);

  it('refuses what the contract refuses: a freeze outside 5 to 240 minutes, a short reason, an unknown field, and an approval without a version', async () => {
    const tenantId = await tenant();
    const siloId = await silo();
    for (const bad of [{ minutes: 4 }, { minutes: 241 }]) expect((await start(tenantId, siloId, bad)).status).toBeGreaterThanOrEqual(400);
    const body = { to_placement_id: siloId, write_freeze_max_minutes: 30, planned_window_start: new Date(Date.now() + MINUTE).toISOString(), reason: REASON };
    for (const payload of [{ ...body, reason: 'short' }, { ...body, extra: true }, { ...body, planned_window_start: 'tomorrow' }, { ...body, to_placement_id: 'not-a-uuid' }]) {
      const reply = await start(tenantId, siloId, { payload });
      expect([400, 422]).toContain(reply.status);
    }
    expect(await admin('select 1 from machvon.tenant_placement_migration where tenant_id = $1', [tenantId])).toHaveLength(0);
    const id = (await start(tenantId, siloId)).json.resource_id as string;
    const missing = await call('POST', `/system/placement-migrations/${id}/cutover`, { admin: APPROVER, payload: { reason: WHY } });
    expect(missing.status).toBe(428);
    const stale = await approve(id, 99);
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    const planned = await approve(id, 1);
    expect([planned.status, planned.json.code]).toEqual([409, 'MIGRATION_STATE_INVALID']);
    expect((await approve(randomUUID(), 1)).status).toBe(404);
    expect((await abort(randomUUID(), 1)).status).toBe(404);
    expect((await detail(randomUUID())).status).toBe(404);
  }, 120_000);

  it('lists the promotions of a tenant, the newest first, and the placements with the room each has, without the references of the infrastructure', async () => {
    const tenantId = await tenant();
    const first = (await start(tenantId, await silo())).json.resource_id as string;
    await abort(first, 1);
    const second = (await start(tenantId, await silo())).json.resource_id as string;
    const listed = await call('GET', `/system/tenants/${tenantId}/placement-migrations?limit=1`);
    expect(listed.status).toBe(200);
    expect((listed.json.items as Array<{ id: string }>).map((entry) => entry.id)).toEqual([second]);
    expect(listed.json.next_cursor).toEqual(expect.any(String));
    const next = await call('GET', `/system/tenants/${tenantId}/placement-migrations?limit=1&cursor=${listed.json.next_cursor as string}`);
    expect((next.json.items as Array<{ id: string; status: string }>).map((entry) => [entry.id, entry.status])).toEqual([[first, 'Aborted']]);
    expect((await call('GET', `/system/tenants/${randomUUID()}/placement-migrations`)).status).toBe(404);
    expect((await call('GET', `/system/tenants/${tenantId}/placement-migrations?limit=0`)).status).toBe(422);
    const placements = await call('GET', '/system/placements');
    expect(placements.status).toBe(200);
    const items = placements.json.items as Array<{ id: string; kind: string; available: boolean; incoming_migrations: number }>;
    expect(items.some((entry) => entry.kind === 'POOL' && !entry.available)).toBe(true);
    expect(items.find((entry) => entry.id === ((listed.json.items as Array<{ to_placement_id: string }>)[0] as { to_placement_id: string }).to_placement_id)).toMatchObject({ kind: 'SILO', available: false, incoming_migrations: 1 });
    expect(JSON.stringify(placements.json)).not.toMatch(/cluster-|kms-/);
  }, 120_000);

  it('never shows the data of a tenant in a comparison: only table names, counts, checksums and sums', async () => {
    const tenantId = await tenant();
    const id = (await start(tenantId, await silo(), { window: new Date() })).json.resource_id as string;
    await pass(tenantId);
    const text = JSON.stringify((await detail(id)).json);
    expect(text).not.toContain('TENANT');
    expect(text).not.toContain(tenantId.replaceAll('-', '').slice(0, 12) + 'x');
    const ids = await admin<{ id: string }>('select id from machvon.ai_budget where tenant_id = $1', [tenantId]);
    for (const row of ids) expect(text).not.toContain(row.id);
  }, 120_000);

  it('writes an audit entry and an event for each change, in the name of the tenant', async () => {
    const tenantId = await tenant();
    const id = (await start(tenantId, await silo(), { window: new Date() })).json.resource_id as string;
    await pass(tenantId);
    await approve(id, (await migrationOf(id)).version as number);
    await pass(tenantId, ahead(10_000));
    const audits = await admin<{ action: string; actor_id: string }>('select action, actor_id from machvon.audit_event where tenant_id = $1 and resource_id = $2 order by occurred_at', [tenantId, id]);
    expect(audits.map((row) => row.action)).toEqual(['tenant.placement_migration_started', 'tenant.placement_migration_copy_started', 'tenant.placement_migration_verified', 'tenant.placement_cutover_approved', 'tenant.placement_switched']);
    expect(audits.map((row) => row.actor_id)).toEqual([STARTER, WORKER, WORKER, APPROVER, WORKER]);
    const events = await admin<{ type: string }>('select type from machvon.outbox_event where tenant_id = $1 and aggregate_id = $2 order by created_at', [tenantId, id]);
    expect(events.map((row) => row.type)).toEqual(['sas.placement_migration.started.v1', 'sas.placement_migration.switched.v1']);
  }, 120_000);

  describe('generated matrix: every promotion operation against every realm role', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('placement-migrations') || operation.path === '/system/placements');
    const cases = controlCasesFor(operations);

    it('lists the six promotion operations of the registry', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual(['abortPlacementMigration', 'approvePlacementCutover', 'getPlacementMigration', 'listPlacementMigrations', 'listPlacements', 'startSiloPromotion']);
    });

    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const tenantId = await tenant();
      const siloId = await silo();
      const id = (await start(tenantId, siloId)).json.resource_id as string;
      const roles = [matrixCase.role];
      const replies: Record<string, () => Promise<Reply>> = {
        listPlacements: () => call('GET', '/system/placements', { roles }),
        listPlacementMigrations: () => call('GET', `/system/tenants/${tenantId}/placement-migrations`, { roles }),
        getPlacementMigration: () => detail(id, { roles }),
        startSiloPromotion: async () => start(await tenant(), siloId, { roles }),
        approvePlacementCutover: () => approve(id, 1, { roles }),
        abortPlacementMigration: () => abort(id, 1, { roles }),
      };
      const reply = await (replies[matrixCase.operationId] as () => Promise<Reply>)();
      if (matrixCase.expected === 'allow') {
        // Allowed by the guard: whatever the command then says, it is not the refusal of the plane or the permission.
        expect(reply.json.code).not.toBe('SCOPE_DENIED');
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await migrationOf(id)).toMatchObject({ status: 'Planned', version: 1 });
    });
  });
});
