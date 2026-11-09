import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { fndModule } from '../../src/modules/fnd';
import { EnterpriseSnapshotController } from '../../src/modules/fnd/enterprise-snapshot.controller';
import { FND_CLOCK, FUNDING_PACK_CODE } from '../../src/modules/fnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const BUILDER = 1; // builds and reads
const FREEZER = 2; // freezes and reads
const READER = 3; // reads only
const NOBODY = 4;
const UNIT_READER = 5; // reads the unit tree of the department only
const B_USER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_DEPARTMENT = 3;
const FAMILY = 0x9a;
const NOW = new Date('2026-11-09T03:00:00Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the enterprise period snapshot: build, freeze and read (ENT-3a, DL.03, BC.01)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let periodId = '';
  let openPeriodId = '';
  let snapshotId = '';
  const projects: string[] = [];
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const project = async (unit: number, label: string): Promise<string> => {
    const created = randomUUID();
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, created, `ENTAPI-${label}`, `Enterprise project ${label}`, unitId(unit), unitId(ROOT), id(FAMILY, 90)],
      ],
    ]);
    return created;
  };

  const period = async (code: string, start: string, end: string, locked: boolean): Promise<string> => {
    const created = randomUUID();
    await seed([
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'ENTERPRISE', 'MONTH', 2026, $6, $7, $8, $9, $10, $11, $11)`,
        [TENANT_A, created, code, start, end, locked ? 'LOCKED' : 'OPEN', locked ? `${end}T05:00:00Z` : null, locked ? `${end}T06:00:00Z` : null, locked ? memberId(FREEZER) : null, randomUUID(), memberId(BUILDER)],
      ],
    ]);
    return created;
  };

  const plan = async (projectId: string, amount: string): Promise<void> => {
    const versionId = randomUUID();
    await seed([
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z'::timestamptz)`, [TENANT_A, versionId, projectId, randomUUID()]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack) values ($1, $2, $3, $4, 'EQUITY', 2026, $5::numeric, 0, 'ALL', 'ENTERPRISE')`,
        [TENANT_A, randomUUID(), versionId, randomUUID(), amount],
      ],
    ]);
  };

  /** The accepted actuals up to March (zeros before it, the figure in March), as the figure store leaves them after a preparer and a checker (the batch is covered by the tests of FND-1). */
  const actual = async (projectId: string, amount: string): Promise<void> => {
    await seed([
      [
        `insert into machvon.plan_figure_revision (tenant_id, id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, status, prepared_by, approved_by, approved_at, updated_by)
         select $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, m::smallint, case when m = 3 then $4::numeric else 0 end, 'REPORTED', '2026-04-03'::date, 'ACCEPTED', $5::uuid, $6::uuid, now(), $5::uuid from generate_series(1, 3) as m`,
        [TENANT_A, randomUUID(), projectId, amount, memberId(BUILDER), memberId(FREEZER)],
      ],
    ]);
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: OTHER_DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(OTHER_DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [BUILDER, FREEZER, READER, NOBODY, UNIT_READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_USER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ENT_BUILDER', ['funding.snapshot.build', 'funding.snapshot.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'ENT_FREEZER', ['funding.snapshot.freeze', 'funding.snapshot.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'ENT_READER', ['funding.snapshot.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'ENT_ALL', ['funding.snapshot.build', 'funding.snapshot.freeze', 'funding.snapshot.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: BUILDER, role: 1, kind: 'TENANT' },
      { n: 2, member: FREEZER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_READER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_USER, role: 1, kind: 'TENANT' }]);
    projects.push(await project(DEPARTMENT, 'A'), await project(OTHER_DEPARTMENT, 'B'));
    await plan(projects[0] as string, '1000');
    await plan(projects[1] as string, '3000');
    periodId = await period('ENT-API-2026-03', '2026-03-01', '2026-03-31', true);
    openPeriodId = await period('ENT-API-2026-04', '2026-04-01', '2026-04-30', false);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [EnterpriseSnapshotController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FUNDING_PACK_CODE, useValue: 'ENTERPRISE' },
        { provide: FND_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is a controller of the module of FND', () => {
    expect(fndModule.controllers).toContain(EnterpriseSnapshotController);
  });

  describe('readiness and the refusal to build', () => {
    it('lists the units that have not submitted, for a caller who may build; a reader or a stranger is refused (403)', async () => {
      const answer = await call('GET', `/enterprise-snapshot-readiness?period_id=${periodId}`, { member: BUILDER });
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ complete: false, planned_cells: 2, projects: 2, rebuild_allowed: true, frozen: null, actions: { build: true } });
      expect((answer.json.missing_units as Array<{ unit_id: string }>).map((unit) => unit.unit_id).sort()).toEqual([unitId(DEPARTMENT), unitId(OTHER_DEPARTMENT)].sort());
      expect((await call('GET', `/enterprise-snapshot-readiness?period_id=${periodId}`, { member: READER })).status).toBe(403);
      expect((await call('GET', `/enterprise-snapshot-readiness?period_id=${periodId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/enterprise-snapshot-readiness', { member: BUILDER })).status).toBe(422);
      expect((await call('GET', `/enterprise-snapshot-readiness?period_id=${randomUUID()}`, { member: BUILDER })).status).toBe(404);
    });

    it('refuses to build with 422 ENTERPRISE_SNAPSHOT_INCOMPLETE and the list of the missing units in the problem body; nothing is written', async () => {
      const refused = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } });
      expect([refused.status, refused.json.code]).toEqual([422, 'ENTERPRISE_SNAPSHOT_INCOMPLETE']);
      expect((refused.json.missing_units as unknown[]).length).toBe(2);
      expect(await rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE'`)).toHaveLength(0);
    });

    it('refuses a period that is not locked (409 PERIOD_STATE_INVALID), a caller without the right (403) and a period that does not exist (404)', async () => {
      const open = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: openPeriodId } });
      expect([open.status, open.json.code]).toEqual([409, 'PERIOD_STATE_INVALID']);
      expect((await call('POST', '/enterprise-snapshots', { member: READER, body: { period_id: periodId } })).status).toBe(403);
      expect((await call('POST', '/enterprise-snapshots', { member: FREEZER, body: { period_id: periodId } })).status).toBe(403);
      expect((await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: randomUUID() } })).status).toBe(404);
      expect((await call('POST', '/enterprise-snapshots', { member: BUILDER, body: {} })).status).toBe(422);
    });
  });

  describe('build, review and freeze', () => {
    it('builds a snapshot for review once every input point has submitted, audits it and announces it with ids and counts only', async () => {
      await actual(projects[0] as string, '100');
      await actual(projects[1] as string, '900');
      const key = `key-${randomUUID()}`;
      const built = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId }, key });
      expect(built.status).toBe(200);
      expect(built.json).toMatchObject({ status: 'BUILDING', resource_version: 1 });
      snapshotId = built.json.resource_id as string;
      const [audit] = await audits(snapshotId, 'enterprise.snapshot_built');
      expect(audit?.safe_diff).toMatchObject({ revision: 1, projects: 2, taxonomy_pack: 'ENTERPRISE' });
      expect(JSON.stringify(audit?.safe_diff)).not.toContain('900');
      const [event] = await events(snapshotId, 'enterprise.snapshot_built.v1');
      expect(event?.payload).toMatchObject({ snapshot_id: snapshotId, period_id: periodId, revision: 1 });
      // The same key replays the same answer and writes no second snapshot.
      const again = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId }, key });
      expect(again.json.resource_id).toBe(snapshotId);
      expect(await rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE'`)).toHaveLength(1);
      const other = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: openPeriodId }, key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('is read in review: totals and rates come from the one reader, each rate with its numerator and denominator, and the actions say what the caller may do', async () => {
      const detail = await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: BUILDER });
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ measure: 'DISBURSED', partial: false, hash_verified: null, actions: { build: true, freeze: false }, snapshot: { id: snapshotId, status: 'BUILDING', revision: 1 } });
      const totals = detail.json.totals as { money: Array<{ code: string; value_vnd: string | null }>; rates: Array<{ code: string; numerator_vnd: string | null; denominator_vnd: string; rate_pct: string | null }> };
      expect(totals.money.find((one) => one.code === 'CUMULATIVE_YTD')?.value_vnd).toBe('1000');
      expect(totals.rates.find((one) => one.code === 'RATE_YEAR_IN_FORCE')).toMatchObject({ numerator_vnd: '1000', denominator_vnd: '4000', rate_pct: '25.0000' });
      expect((detail.json.by_unit as Array<{ unit_id: string }>).map((one) => one.unit_id).sort()).toEqual([unitId(DEPARTMENT), unitId(OTHER_DEPARTMENT)].sort());
      expect(detail.json.projects as unknown[]).toHaveLength(2);
      const freezer = await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: FREEZER });
      expect(freezer.json).toMatchObject({ actions: { build: false, freeze: true } });
      expect((await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/enterprise-snapshots/${snapshotId}?measure=NOPE`, { member: BUILDER })).status).toBe(422);
    });

    it('a reader of one unit tree sees that unit alone and the sums of what he sees (partial)', async () => {
      const partial = await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: UNIT_READER });
      expect(partial.status).toBe(200);
      expect(partial.json).toMatchObject({ partial: true });
      expect(partial.json.projects as unknown[]).toHaveLength(1);
      const totals = partial.json.totals as { rates: Array<{ code: string; numerator_vnd: string | null; denominator_vnd: string }> };
      expect(totals.rates.find((one) => one.code === 'RATE_YEAR_IN_FORCE')).toMatchObject({ numerator_vnd: '100', denominator_vnd: '1000' });
    });

    it('is frozen by somebody else (403 SELF_APPROVAL_DENIED for the builder, 403 for a caller who may not freeze), with the version the screen saw', async () => {
      const key = `key-${randomUUID()}`;
      expect((await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: BUILDER, ifMatch: '"1"' })).status).toBe(403);
      expect((await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: READER, ifMatch: '"1"' })).status).toBe(403);
      const stale = await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: FREEZER, ifMatch: '"9"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const frozen = await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: FREEZER, ifMatch: '"1"', key });
      expect(frozen.status).toBe(200);
      expect(frozen.json).toMatchObject({ status: 'FROZEN', resource_version: 2 });
      const [audit] = await audits(snapshotId, 'enterprise.snapshot_frozen');
      expect(audit?.safe_diff).toMatchObject({ revision: 1, supersedes_id: null });
      expect(audit?.safe_diff['payload_sha256']).toMatch(/^[0-9a-f]{64}$/);
      const [event] = await events(snapshotId, 'enterprise.snapshot_frozen.v1');
      expect(event?.payload).toMatchObject({ snapshot_id: snapshotId, revision: 1 });
      const replay = await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: FREEZER, ifMatch: '"1"', key });
      expect(replay.json).toMatchObject({ status: 'FROZEN', resource_version: 2 });
      const again = await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: FREEZER, ifMatch: '"2"' });
      expect([again.status, again.json.code]).toEqual([409, 'SNAPSHOT_FROZEN']);
    });

    it('a frozen snapshot reads with a verified hash and its lineage; a frozen period refuses another build until it is reopened (409 SNAPSHOT_FROZEN)', async () => {
      const detail = await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: READER });
      expect(detail.json).toMatchObject({ hash_verified: true, snapshot: { status: 'FROZEN' }, actions: { build: false, freeze: false } });
      expect((detail.json.lineage as unknown[]).length).toBe(1);
      const refused = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } });
      expect([refused.status, refused.json.code]).toEqual([409, 'SNAPSHOT_FROZEN']);
      expect(refused.json).toMatchObject({ reopen_required: true });
      const ready = await call('GET', `/enterprise-snapshot-readiness?period_id=${periodId}`, { member: BUILDER });
      expect(ready.json).toMatchObject({ rebuild_allowed: false, frozen: { id: snapshotId, revision: 1 } });
    });

    it('lists the snapshots of a period and filters by status; the list is for a caller who may read', async () => {
      const listed = await call('GET', `/enterprise-snapshots?period_id=${periodId}`, { member: READER });
      expect(listed.status).toBe(200);
      expect((listed.json.items as Array<{ id: string }>).map((one) => one.id)).toEqual([snapshotId]);
      expect(((await call('GET', `/enterprise-snapshots?status=BUILDING`, { member: READER })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', '/enterprise-snapshots?status=NOPE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/enterprise-snapshots', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('isolation', () => {
    it('another tenant sees nothing of it: not in the list, not by id, and its own build of this period is not found', async () => {
      expect(((await call('GET', '/enterprise-snapshots', { member: B_USER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', `/enterprise-snapshots/${snapshotId}`, { member: B_USER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', `/enterprise-snapshots/${snapshotId}/freeze`, { member: B_USER, tenantId: TENANT_B, ifMatch: '"2"' })).status).toBe(404);
      expect((await call('POST', '/enterprise-snapshots', { member: B_USER, tenantId: TENANT_B, body: { period_id: periodId } })).status).toBe(404);
    });
  });
});
