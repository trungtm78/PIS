import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { CrossTotalController } from '../../src/modules/dis/cross-total.controller';
import { PeriodSnapshotController } from '../../src/modules/dis/period-snapshot.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { disModule } from '../../src/modules/dis';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const BUILDER = 3; // builds, freezes, reads and writes the control over the whole tenant
const CONTROL_READER = 4; // reads the control over the whole tenant, nothing else
const BRANCH_CONTROL = 5; // reads and writes the control over one branch only
const NOBODY = 8;
const B_BUILDER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa7;
const AREA = id(FAMILY, 30);
const DECISION = id(FAMILY, 32);
const FUND_VERSION = id(FAMILY, 31);

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

type Dim = Record<string, unknown>;
interface Live {
  published: boolean;
  disagreeing: string[];
  unattributed_fund_vnd: string;
  window_from: string;
  treasury_cutoff_date: string;
  project_gaps: Array<Record<string, string>>;
  unit: Dim;
  fund: Dim;
  project: Dim;
}

interface Week {
  id: string;
  start: string;
  end: string;
}

/** The cross-total control of the disbursed money (G4-5): unit = fund = project to the dong, or the indicator is not published and the snapshot is not frozen. */
describe('the cross-total control over HTTP (G4-5)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  const clockNow = new Date('2027-12-15T03:00:00Z');
  let counter = 0;
  /** What the ledger of the Treasury holds up to now (the windows of the weeks run from the first day of the year, so each later snapshot holds the earlier weeks too), and how much of it has no fund. */
  let ledger = 0n;
  let unmatched = 0n;
  let weeks: Week[] = [];
  let nextWeek = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const week = (): Week => {
    const found = weeks[nextWeek];
    nextWeek += 1;
    if (found === undefined) throw new Error('the calendar of 2027 ran out of weeks');
    return found;
  };

  /** A project of the department with a plan version of 2027 in force and 500,000,000 on its year plan. */
  async function seedProject(unit = DEPARTMENT): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    const code = `CT-${counter}`;
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, `Project ${code}`, unitId(unit), AREA],
      ],
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2027, 1, $4, 'PUBLISHED', timestamptz '2026-12-20T01:00:00Z')`, [TENANT_A, planId, projectId, DECISION]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level, origin)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 500000000, 0, $4, 'CENTRAL', 'PM_ASSIGNED')`,
        [TENANT_A, planId, FUND_VERSION, projectId],
      ],
    ]);
    return { projectId, code };
  }

  /** The allocation line (and so the fund) a transaction is attributed to. */
  const lineOf = async (projectId: string): Promise<string> => (await rows<{ id: string }>('select id from machvon.allocation_line where project_id = $1 limit 1', [projectId]))[0]?.id as string;

  const paid = (projectId: string, amount: string, at: string, options: { refundOf?: string | null; line?: string | null; n?: string } = {}): [string, unknown[]] => {
    const n = options.n ?? randomUUID();
    return [
      `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id, allocation_line_id)
       values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, $7, $8, $9, gen_random_uuid(), $10)`,
      [TENANT_A, n, projectId, `EXT-${n}`, amount, at, 'd'.repeat(64), options.refundOf === undefined || options.refundOf === null ? 'PAYMENT' : 'REFUND', options.refundOf ?? null, options.line ?? null],
    ];
  };

  const softClose = (periodId: string): Promise<unknown> => rows("update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 1 where id = $1 and status = 'OPEN'", [periodId]);
  const build = (period: Week, member = BUILDER): Promise<Reply> => call('POST', '/period-snapshots', { member, body: { period_id: period.id, snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: period.end } });
  const freeze = (snapshotId: string, version: number, member = BUILDER, key?: string): Promise<Reply> => call('POST', `/period-snapshots/${snapshotId}/freeze`, { member, body: {}, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }) });
  const control = (snapshotId: string, member = BUILDER, tenantId?: string): Promise<Reply> => call('GET', `/period-snapshots/${snapshotId}/cross-total`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const evaluate = (snapshotId: string, member = BUILDER): Promise<Reply> => call('POST', `/period-snapshots/${snapshotId}/cross-total-checks`, { member, body: {} });
  const checks = (snapshotId: string) => rows<{ published: boolean; origin: string; total_unit_vnd: string; total_fund_vnd: string; total_project_vnd: string; disagreeing: string[]; unattributed_fund_vnd: string }>(
    'select published, origin, total_unit_vnd::text, total_fund_vnd::text, total_project_vnd::text, disagreeing, unattributed_fund_vnd::text from machvon.cross_total_check where snapshot_id = $1 order by created_at, id',
    [snapshotId],
  );

  /** A fresh week with a project that was paid 300,000,000 and then 50,000,000 back, and a snapshot of it that was just built. */
  async function built(options: { fund?: boolean } = {}): Promise<{ period: Week; projectId: string; code: string; snapshotId: string; start: string }> {
    const project = await seedProject();
    const period = week();
    const first = randomUUID();
    const line = options.fund === true ? await lineOf(project.projectId) : null;
    await seedReplica([paid(project.projectId, '300000000', `${period.start}T09:00:00+07:00`, { n: first, line }), paid(project.projectId, '50000000', `${period.start}T10:00:00+07:00`, { refundOf: first, line })]);
    ledger += 250_000_000n;
    if (line === null) unmatched += 250_000_000n;
    await softClose(period.id);
    const snapshot = await build(period);
    expect(snapshot.status).toBe(200);
    return { period, ...project, snapshotId: idOf(snapshot), start: period.start };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [BUILDER, CONTROL_READER, BRANCH_CONTROL, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_BUILDER, ROOT);
    await harness.seedRole(TENANT_A, 3, 'DIS_CONTROL_MANAGER', ['snapshot.build', 'snapshot.freeze', 'disbursement.read', 'disbursement.control.read', 'disbursement.control.evaluate'], 30);
    await harness.seedRole(TENANT_A, 4, 'DIS_CONTROL_READER', ['disbursement.control.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'DIS_CONTROL_BRANCH', ['disbursement.control.read', 'disbursement.control.evaluate'], 25);
    await harness.seedRole(TENANT_B, 1, 'DIS_CONTROL_MANAGER', ['snapshot.build', 'snapshot.freeze', 'disbursement.read', 'disbursement.control.read', 'disbursement.control.evaluate'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 3, member: BUILDER, role: 3, kind: 'TENANT' },
      { n: 4, member: CONTROL_READER, role: 4, kind: 'TENANT' },
      { n: 5, member: BRANCH_CONTROL, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_BUILDER, role: 1, kind: 'TENANT' }]);
    await seedReplica([
      ["insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW', 'EFFECTIVE', $3, $3)", [TENANT_A, id(FAMILY, 33), memberId(BUILDER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'NSTW', 1, 'Central budget', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, FUND_VERSION, id(FAMILY, 33), memberId(BUILDER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, '00000000-0000-4000-8000-000000000000');
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, '00000000-0000-4000-8000-000000000000', new Date('2026-12-15T00:00:00Z'));
    });
    weeks = await rows<Week>("select id, start_date::text as start, end_date::text as end from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and start_date >= date '2027-01-04' order by start_date limit 20");
    root = await mkdtemp(join(tmpdir(), 'machvon-cross-total-'));
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [PeriodSnapshotController, CrossTotalController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => clockNow },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of DIS', () => {
    expect(disModule.controllers).toContain(CrossTotalController);
    expect([...app.implementedOperations]).toEqual(expect.arrayContaining(['getCrossTotalControl', 'evaluateCrossTotal', 'freezePeriodSnapshot']));
  });

  describe('the three totals agree', () => {
    it('shows the control with unit = fund = project to the dong (a refund takes off) and money with no fund under UNMATCHED, and freezes', async () => {
      const world = await built();
      const read = await control(world.snapshotId);
      expect(read.status).toBe(200);
      const live = read.json.live as Live;
      expect(live).toMatchObject({ published: true, disagreeing: [], unattributed_fund_vnd: unmatched.toString(), window_from: '2027-01-01', treasury_cutoff_date: world.period.end });
      expect(live.unit).toMatchObject({ total_vnd: ledger.toString(), disagrees: false, key_count: 1 });
      expect(live.fund).toMatchObject({ total_vnd: ledger.toString(), disagrees: false });
      expect((live.fund.top as Array<{ key: string; vnd: string }>)[0]).toMatchObject({ key: 'UNMATCHED', vnd: unmatched.toString() });
      expect(live.project).toMatchObject({ total_vnd: ledger.toString(), disagrees: false });
      expect(read.json.recorded).toBeNull();
      expect(read.json.formula).toEqual(expect.stringContaining('bằng nhau'));
      // Reading writes nothing.
      expect(await checks(world.snapshotId)).toEqual([]);

      const frozen = await freeze(world.snapshotId, 1);
      expect(frozen).toMatchObject({ status: 200, json: { status: 'FROZEN', resource_version: 2 } });
      const [check] = await checks(world.snapshotId);
      expect(check).toMatchObject({ published: true, origin: 'FREEZE_GATE', total_unit_vnd: ledger.toString(), total_fund_vnd: ledger.toString(), total_project_vnd: ledger.toString(), disagreeing: [] });
      // The freeze names the check that let it through.
      const [audit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.snapshot_frozen' and resource_id::text = $1", [world.snapshotId]);
      expect(audit?.safe_diff).toMatchObject({ cross_total_check_id: expect.any(String) });
      expect(await rows("select 1 from machvon.outbox_event where type = 'dis.cross_total.checked.v1' and payload->>'snapshot_id' = $1", [world.snapshotId])).toHaveLength(1);
    });

    it('attributes the money to a fund through its allocation line, so the fund total is the same number under a fund key', async () => {
      const world = await built({ fund: true });
      const live = (await control(world.snapshotId)).json.live as Live;
      // The money of the first test has no fund; this week's 250,000,000 is attributed to NSTW through the allocation line, and the fund total is still the number of the other two.
      expect(live.unattributed_fund_vnd).toBe(unmatched.toString());
      expect((live.fund.top as Array<{ key: string; vnd: string }>).find((entry) => entry.key === 'NSTW')).toMatchObject({ vnd: '250000000' });
      expect(live.fund.total_vnd).toBe(live.unit.total_vnd);
      expect(live.fund.total_vnd).toBe(ledger.toString());
    });

    it('writes a check on demand and keeps it in the history; the same check is not a freeze', async () => {
      const world = await built();
      const written = await evaluate(world.snapshotId);
      expect(written).toMatchObject({ status: 200, json: { status: 'PUBLISHED', published: true, total_unit_vnd: ledger.toString(), total_fund_vnd: ledger.toString(), total_project_vnd: ledger.toString(), disagreeing: [] } });
      expect(await checks(world.snapshotId)).toMatchObject([{ published: true, origin: 'MANUAL' }]);
      const read = await control(world.snapshotId);
      expect(read.json.recorded as { published: boolean; origin: string }).toMatchObject({ published: true, origin: 'MANUAL' });
      expect((read.json.history as unknown[]).length).toBe(1);
      expect(await rows('select status from machvon.period_snapshot where id = $1', [world.snapshotId])).toEqual([{ status: 'BUILDING' }]);
    });
  });

  describe('a dimension disagrees', () => {
    it('refuses the freeze with CROSS_TOTAL_MISMATCH naming the dimension, keeps the check and the audit row, leaves the snapshot BUILDING, and answers the same on a replay', async () => {
      const world = await built();
      // A late transaction of 40,000,000 confirmed in the window after the snapshot was built: the ledger moved, the snapshot did not.
      const before = ledger;
      const beforeUnmatched = unmatched;
      await seedReplica([paid(world.projectId, '40000000', `${world.start}T14:00:00+07:00`)]);
      ledger += 40_000_000n;
      unmatched += 40_000_000n;
      const key = `key-${randomUUID()}`;
      const refused = await freeze(world.snapshotId, 1, BUILDER, key);
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'CROSS_TOTAL_MISMATCH' });
      expect(refused.json.disagreeing).toEqual(['UNIT']);
      expect(refused.json.agreeing).toEqual(['FUND', 'PROJECT']);
      expect(refused.json.totals).toEqual({ unit: before.toString(), fund: ledger.toString(), project: ledger.toString() });
      expect(refused.json.offset_vnd).toEqual({ UNIT: '-40000000' });
      expect(refused.json.unattributed_fund_vnd).toBe(unmatched.toString());
      expect(beforeUnmatched + 40_000_000n).toBe(unmatched);
      // What the refusal kept: the check (not published, naming UNIT), one audit row, one event; the snapshot is still BUILDING at version 1.
      const [check] = await checks(world.snapshotId);
      expect(check).toMatchObject({ published: false, origin: 'FREEZE_GATE', disagreeing: ['UNIT'], total_unit_vnd: before.toString(), total_fund_vnd: ledger.toString(), total_project_vnd: ledger.toString() });
      expect(await rows('select status, version from machvon.period_snapshot where id = $1', [world.snapshotId])).toEqual([{ status: 'BUILDING', version: '1' }]);
      expect(await rows("select 1 from machvon.audit_event where action = 'dis.cross_total_checked' and safe_diff->>'published' = 'false'")).not.toHaveLength(0);
      const [event] = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'dis.cross_total.checked.v1' and payload->>'snapshot_id' = $1", [world.snapshotId]);
      expect(event?.payload).toMatchObject({ published: false, alert_type: 'CROSS_TOTAL_MISMATCH', disagreeing: ['UNIT'] });
      // The same key gets the same refusal and writes nothing more.
      const again = await freeze(world.snapshotId, 1, BUILDER, key);
      expect(again).toMatchObject({ status: 422, json: { code: 'CROSS_TOTAL_MISMATCH' } });
      expect(await checks(world.snapshotId)).toHaveLength(1);

      // The control reads it too: the unit dimension disagrees by -40,000,000, and the project that differs is named with both figures.
      const read = await control(world.snapshotId);
      const live = read.json.live as Live;
      expect(live.published).toBe(false);
      expect(live.unit).toMatchObject({ disagrees: true, offset_vnd: '-40000000' });
      expect(live.fund.disagrees).toBe(false);
      expect(live.project_gaps).toEqual([{ project_id: world.projectId, project_code: world.code, snapshot_vnd: '250000000', ledger_vnd: '290000000', gap_vnd: '-40000000' }]);

      // Build the snapshot again (it replaces the pending one): the three agree and the freeze goes through.
      const rebuilt = await build(world.period);
      expect(rebuilt.status).toBe(200);
      const second = idOf(rebuilt);
      expect(await freeze(second, 1)).toMatchObject({ status: 200, json: { status: 'FROZEN' } });
    });

    it('a version that is stale or a snapshot that is frozen keeps its own answer: the gate speaks only for a snapshot that can be frozen', async () => {
      const world = await built();
      expect(await freeze(world.snapshotId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await checks(world.snapshotId)).toEqual([]);
      expect((await freeze(world.snapshotId, 1)).status).toBe(200);
      expect(await freeze(world.snapshotId, 2)).toMatchObject({ status: 409, json: { code: 'SNAPSHOT_FROZEN' } });
      expect(await checks(world.snapshotId)).toHaveLength(1);
    });

    it('a payment of another project after the build is seen too, and the gap names that project', async () => {
      const world = await built({ fund: true });
      const before = ledger;
      const other = await seedProject();
      const line = await lineOf(other.projectId);
      await seedReplica([paid(other.projectId, '10000000', `${world.start}T11:00:00+07:00`, { line })]);
      ledger += 10_000_000n;
      const refused = await freeze(world.snapshotId, 1);
      expect(refused).toMatchObject({ status: 422, json: { code: 'CROSS_TOTAL_MISMATCH' } });
      expect(refused.json.disagreeing).toEqual(['UNIT']);
      expect((refused.json.totals as Record<string, string>).unit).toBe(before.toString());
      expect((refused.json.totals as Record<string, string>).fund).toBe(ledger.toString());
      const live = (await control(world.snapshotId)).json.live as { project_gaps: Array<{ project_code: string; gap_vnd: string }> };
      expect(live.project_gaps).toEqual([expect.objectContaining({ project_code: other.code, gap_vnd: '-10000000' })]);
    });
  });

  describe('scope and permission', () => {
    it('is for a caller whose permission covers the whole tenant: a branch caller is refused on read and write, a caller without the permission gets 403, and a snapshot of another tenant is not found', async () => {
      const world = await built();
      expect(await control(world.snapshotId, BRANCH_CONTROL)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await evaluate(world.snapshotId, BRANCH_CONTROL)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await control(world.snapshotId, NOBODY)).status).toBe(403);
      expect((await evaluate(world.snapshotId, NOBODY)).status).toBe(403);
      expect((await evaluate(world.snapshotId, CONTROL_READER)).status).toBe(403);
      expect((await control(world.snapshotId, CONTROL_READER)).status).toBe(200);
      expect((await control(world.snapshotId, B_BUILDER, TENANT_B)).status).toBe(404);
      expect((await control(randomUUID())).status).toBe(404);
      expect(await rows('select count(*)::int as n from machvon.cross_total_check', [], TENANT_B)).toEqual([{ n: 0 }]);
    });

    it('never changes a check after it is written: the database refuses an update and a delete', async () => {
      const world = await built();
      await evaluate(world.snapshotId);
      const client = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await client.connect();
      try {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        await expect(client.query('update machvon.cross_total_check set published = true')).rejects.toMatchObject({ code: '42501' });
        await expect(client.query('delete from machvon.cross_total_check')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    });
  });
});
