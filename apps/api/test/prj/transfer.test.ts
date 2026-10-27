import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PrjTransferApplyJob, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { TransferController } from '../../src/modules/prj/transfer.controller';
import { applyDueTransfers } from '../../src/modules/prj/transfer-apply';
import { PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const REQUESTER = 1; // project.read and project.transfer.request over the whole tenant
const APPROVER = 2; // project.read and project.transfer.approve over the whole tenant
const BOTH = 3; // asks and decides
const HERE_READER = 4; // project.read over the department the project leaves
const THERE_READER = 5; // project.read over the department the project goes to
const ROOT_READER = 6; // project.read over the root: sees the project before and after
const STRANGER = 7; // project.read only, over the whole tenant
const UNIT_REQUESTER = 8; // project.transfer.request over the department HERE only
const B_ADMIN = 1;
const ROOT = 1;
const HERE = 2;
const THERE = 3;
const ELSEWHERE = 4;
const RETIRED = 5; // a unit that stopped existing
const FUTURE = 6; // a unit that does not exist yet
const DISSOLVED = 7; // a unit that was dissolved
const LATE_UNIT = 8; // a unit that is dissolved after a request was made for it
const ENDING_UNIT = 9; // a unit whose validity ends after a request was made for it
const FAMILY = 0xac;
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The transfer of a project between units over HTTP, and the job that makes it on its day (ST-PRJ-007, PRJ-20, PRJ 3.1 F10). */
describe('the transfer of a project between units (ST-PRJ-007)', () => {
  const harness = new AuthzHarness();
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let counter = 0;
  const today = vietnamDateOf(new Date());
  const tomorrow = vietnamDateOf(new Date(Date.now() + DAY));
  const yesterday = vietnamDateOf(new Date(Date.now() - DAY));

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
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
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function project(unit = HERE, investor: number | null = null): Promise<string> {
    counter += 1;
    const projectId = id(FAMILY, 100 + counter);
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `TR-${counter}`, unitId(unit), investor === null ? null : unitId(investor), id(FAMILY, 30)],
      ],
    ]);
    return projectId;
  }
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const ask = (projectId: string, extra: Record<string, unknown> = {}, member = REQUESTER, version: number | string = 1): Promise<Reply> =>
    call('POST', `/projects/${projectId}/transfers`, {
      member,
      ifMatch: version,
      body: { to_unit_id: unitId(THERE), transfer_scope: 'OWNER_UNIT', effective_date: tomorrow, reason: 'The department takes over the construction of this bridge', ...extra },
    });
  const decide = (transferId: string, version: number, decision: string, member = APPROVER, reason = 'Decision of the people committee'): Promise<Reply> =>
    call('POST', `/project-transfers/${transferId}/decision`, { member, ifMatch: version, body: { decision, reason } });
  const projectRow = async (projectId: string) =>
    (await rows<{ owner_unit_id: string; investor_unit_id: string | null; version: string }>('select owner_unit_id, investor_unit_id, version::text as version from machvon.project where id = $1::uuid', [projectId]))[0]!;
  const transferRow = async (transferId: string) =>
    (await rows<{ status: string; approved_by: string | null; applied_at: string | null; decision_reason: string | null; version: string; from_unit_id: string; to_unit_id: string }>(
      'select status, approved_by, applied_at::text as applied_at, decision_reason, version::text as version, from_unit_id, to_unit_id from machvon.project_transfer where id = $1::uuid',
      [transferId],
    ))[0]!;
  const scopeVersion = async (member: number): Promise<number> => Number((await rows<{ scope_version: string }>('select scope_version::text as scope_version from machvon.membership where id = $1::uuid', [memberId(member)]))[0]?.scope_version ?? 0);
  const job = (): PrjTransferApplyJob => new PrjTransferApplyJob(new AuditWriter(harness.tenants as TenantDatabase));
  const runJob = (now: Date): Promise<{ applied: number; closed: number }> =>
    (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => job().run(tx, TENANT_A, WORKER_MEMBERSHIP_ID, now));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: THERE, path: `/${unitId(ROOT)}/${unitId(THERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
        { n: RETIRED, path: `/${unitId(RETIRED)}/` },
        { n: FUTURE, path: `/${unitId(FUTURE)}/` },
        { n: DISSOLVED, path: `/${unitId(DISSOLVED)}/` },
        { n: LATE_UNIT, path: `/${unitId(LATE_UNIT)}/` },
        { n: ENDING_UNIT, path: `/${unitId(ENDING_UNIT)}/` },
      ]);
    }
    for (const n of [REQUESTER, APPROVER, BOTH, HERE_READER, THERE_READER, ROOT_READER, STRANGER, UNIT_REQUESTER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'TRANSFER_ASKER', ['project.read', 'project.transfer.request'], 30);
    await harness.seedRole(TENANT_A, 2, 'TRANSFER_APPROVER', ['project.read', 'project.transfer.approve'], 30);
    await harness.seedRole(TENANT_A, 3, 'TRANSFER_BOTH', ['project.read', 'project.transfer.request', 'project.transfer.approve'], 30);
    await harness.seedRole(TENANT_A, 4, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'TRANSFER_ASKER_ONLY', ['project.transfer.request'], 20);
    await harness.seedRole(TENANT_B, 1, 'TRANSFER_BOTH', ['project.read', 'project.transfer.request', 'project.transfer.approve'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REQUESTER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: BOTH, role: 3, kind: 'TENANT' },
      { n: 4, member: HERE_READER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(HERE)] },
      { n: 5, member: THERE_READER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(THERE)] },
      { n: 6, member: ROOT_READER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 7, member: STRANGER, role: 4, kind: 'TENANT' },
      { n: 8, member: UNIT_REQUESTER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(HERE)] },
      { n: 9, member: UNIT_REQUESTER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [TransferController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: PRJ_PIPELINE_CACHE, useValue: cache }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toContain(TransferController);
  });

  describe('AC-ST-PRJ-007-1 / UAT-AC213: asking, deciding and the day', () => {
    it('AC-ST-PRJ-007-1: P-A-003 is owned by the department, a report was accepted before; the request is made, the one who asked cannot approve it (403 SELF_APPROVAL_DENIED), another person approves it for the first of next month, the job makes it on the day, and a unit of tenant B is 404', async () => {
      const projectId = await project(HERE);
      await seed([
        [
          `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, submitted_at, submitted_by, accepted_at, accepted_by, created_by, updated_by)
           values ($1, $2, $3, $4, $5, 1, 'ACCEPTED', true, 1, repeat('a', 64), 'WEEKLY', 'YTD', now(), $6, now(), $7, $6, $6)`,
          [TENANT_A, randomUUID(), projectId, randomUUID(), randomUUID(), WORKER_MEMBERSHIP_ID, memberId(APPROVER)],
        ],
      ]);
      // A unit of another tenant does not exist for the asker.
      expect(await ask(projectId, { to_unit_id: unitId(THERE), transfer_scope: 'OWNER_UNIT' }, REQUESTER).then((reply) => reply.status)).toBe(200);
      const foreign = await call('POST', `/projects/${await project(HERE)}/transfers`, { member: REQUESTER, ifMatch: 1, body: { to_unit_id: randomUUID(), transfer_scope: 'OWNER_UNIT', effective_date: tomorrow, reason: 'A unit that is not of this tenant' } });
      expect(foreign.status).toBe(404);
      const first = await rows<{ id: string; version: string; status: string }>('select id, version::text as version, status from machvon.project_transfer where project_id = $1::uuid', [projectId]);
      const requestId = first[0]!.id;
      expect(first[0]).toMatchObject({ status: 'REQUESTED', version: '1' });
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.transfer_requested'`, [requestId])).toHaveLength(1);

      // The one who asked cannot decide, whoever they are and whatever version they name.
      const own = await call('POST', `/projects/${await project(HERE)}/transfers`, { member: BOTH, ifMatch: 1, body: { to_unit_id: unitId(THERE), transfer_scope: 'OWNER_UNIT', effective_date: tomorrow, reason: 'The department takes over the construction' } });
      const ownId = idOf(own);
      expect(await decide(ownId, 1, 'approve', BOTH)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decide(ownId, 9, 'approve', BOTH)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await transferRow(ownId)).status).toBe('REQUESTED');

      // Another person approves for tomorrow: nothing moves yet.
      expect(await decide(requestId, 7, 'approve')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const approved = await decide(requestId, 1, 'approve');
      expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      expect(await transferRow(requestId)).toMatchObject({ status: 'APPROVED', approved_by: memberId(APPROVER), decision_reason: 'Decision of the people committee', applied_at: null });
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(HERE));
      expect(await runJob(new Date())).toEqual({ applied: 0, closed: 0 });

      // On the day the job makes it, once.
      const before = await scopeVersion(HERE_READER);
      const onTheDay = new Date(Date.now() + DAY + 3_600_000);
      // The pass that the worker runs makes it and clears the pages of the project bank of the tenant after it commits; a pass that makes nothing leaves them.
      await cache.set(TENANT_A, 'all', 'probe', 'cached');
      const tenants = harness.tenants as TenantDatabase;
      const ctx = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
      expect(await applyDueTransfers(tenants, job(), ctx, new Date(), cache)).toEqual({ applied: 0, closed: 0 });
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBe('cached');
      expect(await applyDueTransfers(tenants, job(), ctx, onTheDay, cache)).toEqual({ applied: 1, closed: 0 });
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect(await runJob(onTheDay)).toEqual({ applied: 0, closed: 0 });
      expect(await projectRow(projectId)).toMatchObject({ owner_unit_id: unitId(THERE), version: '2' });
      expect(await transferRow(requestId)).toMatchObject({ status: 'APPLIED' });
      expect((await transferRow(requestId)).applied_at).not.toBeNull();
      expect(await scopeVersion(HERE_READER)).toBeGreaterThan(before);
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.transferred.v1' and aggregate_id = $1`, [projectId]);
      expect(events).toHaveLength(1);
      // The event is the event of the project: it carries the version the project reached, not the version of the request.
      expect(events[0]?.payload).toMatchObject({ version: 2, project_id: projectId, transfer_id: requestId, transfer_scope: 'OWNER_UNIT', from_unit_id: unitId(HERE), to_unit_id: unitId(THERE), effective_date: tomorrow });
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.transfer_applied'`, [requestId])).toHaveLength(1);
      // The report that was accepted before stays what it was: it carries the project, and the unit of its day is the one the snapshot lines kept.
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.report_revision where project_id = $1::uuid and status = $2', [projectId, 'ACCEPTED']))[0]?.n).toBe('1');
    });

    it('keeps the unit of a snapshot that was built before the day, and the project now answers to its new unit in the scope of whoever reads it', async () => {
      const projectId = await project(HERE);
      const periodId = id(FAMILY, 3000 + counter);
      const snapshotId = randomUUID();
      await seed([
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, '2027-03-01', '2027-03-07', now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $4, $5, $5)`,
          [TENANT_A, periodId, `TRP-${counter}`, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
        ],
        [
          `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
           values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2027-03-07', '2027-03-07', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, $4, $4)`,
          [TENANT_A, snapshotId, periodId, WORKER_MEMBERSHIP_ID],
        ],
        [
          `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, treasury_coverage)
           values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1, 1, 'NONE')`,
          [TENANT_A, snapshotId, projectId, unitId(HERE)],
        ],
      ]);
      const requestId = idOf(await ask(projectId, { effective_date: today }));
      await cache.set(TENANT_A, 'all', 'probe', 'cached');
      expect(await decide(requestId, 1, 'approve')).toMatchObject({ status: 200, json: { status: 'APPLIED', resource_version: 3 } });
      // The pages of the project bank that listed the project under its old unit are read again.
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(THERE));
      expect(await rows<{ unit_id: string }>('select unit_id from machvon.period_snapshot_line where snapshot_id = $1::uuid', [snapshotId])).toEqual([{ unit_id: unitId(HERE) }]);
      // The reader of the old department no longer finds it, the reader of the new one does, the reader of the root finds it throughout.
      expect(await call('GET', `/project-transfers?project_id=${projectId}`, { member: HERE_READER })).toMatchObject({ status: 200, json: { items: [] } });
      expect(((await call('GET', `/project-transfers?project_id=${projectId}`, { member: THERE_READER })).json.items as unknown[]).length).toBe(1);
      expect(((await call('GET', `/project-transfers?project_id=${projectId}`, { member: ROOT_READER })).json.items as unknown[]).length).toBe(1);
    });

    it('makes the transfer at once when the day has come with the approval, and tells approve, reject and return apart: a rejected or returned request frees the project for another', async () => {
      const projectId = await project(HERE);
      const rejected = idOf(await ask(projectId, { effective_date: today }));
      expect(await decide(rejected, 1, 'reject', APPROVER, 'No')).toMatchObject({ status: 422, json: { detail: 'reason' } });
      expect(await decide(rejected, 1, 'reject')).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect(await transferRow(rejected)).toMatchObject({ status: 'REJECTED', approved_by: null, decision_reason: 'Decision of the people committee' });
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(HERE));
      const returned = idOf(await ask(projectId, { effective_date: tomorrow }));
      expect(await decide(returned, 1, 'return')).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect(await decide(returned, 2, 'approve')).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await decide(returned, 2, 'maybe')).toMatchObject({ status: 422 });
      const last = await ask(projectId, { effective_date: today });
      expect(last.status).toBe(200);
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action in ('prj.transfer_rejected', 'prj.transfer_returned')`, [rejected])).toHaveLength(1);
    });

    it('closes an approved transfer whose project changed unit meanwhile, and changes nothing; a reason of the longest length still closes it, and the transfers that are due beside it are made', async () => {
      const projectId = await project(HERE);
      const requestId = idOf(await ask(projectId));
      await decide(requestId, 1, 'approve', APPROVER, 'x'.repeat(2000));
      const fine = await project(HERE);
      const fineId = idOf(await ask(fine));
      await decide(fineId, 1, 'approve');
      await rows('update machvon.project set owner_unit_id = $2::uuid, version = version + 1 where id = $1::uuid', [projectId, unitId(ELSEWHERE)]);
      expect(await runJob(new Date(Date.now() + 2 * DAY))).toEqual({ applied: 1, closed: 1 });
      expect(await transferRow(requestId)).toMatchObject({ status: 'CANCELLED' });
      expect((await transferRow(requestId)).decision_reason).toContain('changed before the day');
      expect((await transferRow(requestId)).decision_reason?.length).toBeLessThanOrEqual(2000);
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(ELSEWHERE));
      expect((await projectRow(fine)).owner_unit_id).toBe(unitId(THERE));
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.transfer_closed_stale'`, [requestId])).toHaveLength(1);
    });

    it('closes an approved transfer whose project was settled before the day, and refuses a receiving unit that is not in force on the effective day (not yet created, or ended before it)', async () => {
      const projectId = await project(HERE);
      const requestId = idOf(await ask(projectId));
      await decide(requestId, 1, 'approve');
      await rows("update machvon.project set status = 'SETTLED' where id = $1::uuid", [projectId]);
      expect(await runJob(new Date(Date.now() + 2 * DAY))).toEqual({ applied: 0, closed: 1 });
      expect(await transferRow(requestId)).toMatchObject({ status: 'CANCELLED' });
      expect((await transferRow(requestId)).decision_reason).toContain('closed before the day');
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(HERE));
      await rows("update machvon.organization_unit set valid_from = '2099-06-01' where id = $1::uuid", [unitId(FUTURE)]);
      expect(await ask(await project(HERE), { to_unit_id: unitId(FUTURE), effective_date: today })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
      expect((await ask(await project(HERE), { to_unit_id: unitId(FUTURE), effective_date: '2099-06-01' })).status).toBe(200);
    });

    it('records an approval that finds the project changed as a closing, not as a return, and refuses a receiving unit that is dissolved', async () => {
      const projectId = await project(HERE);
      const requestId = idOf(await ask(projectId, { effective_date: today }));
      await rows('update machvon.project set owner_unit_id = $2::uuid, version = version + 1 where id = $1::uuid', [projectId, unitId(ELSEWHERE)]);
      expect(await decide(requestId, 1, 'approve', APPROVER)).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.transfer_closed_stale'`, [requestId])).toHaveLength(1);
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action in ('prj.transfer_returned', 'prj.transfer_approved')`, [requestId])).toHaveLength(0);
      await rows("update machvon.organization_unit set status = 'Dissolved' where id = $1::uuid", [unitId(DISSOLVED)]);
      expect(await ask(await project(HERE), { to_unit_id: unitId(DISSOLVED) })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
    });

    it('closes an approved transfer whose receiving unit stopped being usable before the day, at the job as at an approval that comes on the day', async () => {
      const later = await project(HERE);
      const laterId = idOf(await ask(later, { to_unit_id: unitId(LATE_UNIT) }));
      await decide(laterId, 1, 'approve');
      await rows("update machvon.organization_unit set status = 'Dissolved' where id = $1::uuid", [unitId(LATE_UNIT)]);
      expect(await runJob(new Date(Date.now() + 2 * DAY))).toEqual({ applied: 0, closed: 1 });
      expect(await transferRow(laterId)).toMatchObject({ status: 'CANCELLED' });
      expect((await transferRow(laterId)).decision_reason).toContain('receiving unit was no longer in force');
      expect((await projectRow(later)).owner_unit_id).toBe(unitId(HERE));
      const sameDay = await project(HERE);
      const sameDayId = idOf(await ask(sameDay, { to_unit_id: unitId(ENDING_UNIT), effective_date: today }));
      await rows("update machvon.organization_unit set valid_from = '2019-01-01', valid_until = '2020-01-01' where id = $1::uuid", [unitId(ENDING_UNIT)]);
      expect(await decide(sameDayId, 1, 'approve')).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect((await projectRow(sameDay)).owner_unit_id).toBe(unitId(HERE));
    });

    it('transfers the investor unit as well as the owner unit, and a project with no investor unit has none to transfer', async () => {
      const withInvestor = await project(HERE, ELSEWHERE);
      const requestId = idOf(await ask(withInvestor, { transfer_scope: 'INVESTOR_UNIT', effective_date: today }));
      expect(await decide(requestId, 1, 'approve')).toMatchObject({ status: 200, json: { status: 'APPLIED' } });
      expect(await projectRow(withInvestor)).toMatchObject({ owner_unit_id: unitId(HERE), investor_unit_id: unitId(THERE) });
      expect(await ask(await project(HERE), { transfer_scope: 'INVESTOR_UNIT' })).toMatchObject({ status: 422, json: { detail: 'transfer_scope' } });
    });
  });

  describe('asking: the project, the unit, the day', () => {
    it('refuses a second open request for the same project and scope (409 TRANSFER_PENDING_EXISTS) and allows one for the other scope', async () => {
      const projectId = await project(HERE, ELSEWHERE);
      expect((await ask(projectId)).status).toBe(200);
      expect(await ask(projectId)).toMatchObject({ status: 409, json: { code: 'TRANSFER_PENDING_EXISTS' } });
      expect((await ask(projectId, { transfer_scope: 'INVESTOR_UNIT', to_unit_id: unitId(THERE) })).status).toBe(200);
    });

    it('judges the request: the unit that is not the unit the project has, a day that is not past, a reason of ten characters, a scope that is one of the two, a project that is not settled', async () => {
      const projectId = await project(HERE);
      expect(await ask(projectId, { to_unit_id: unitId(HERE) })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
      expect(await ask(projectId, { effective_date: yesterday })).toMatchObject({ status: 422, json: { detail: 'effective_date' } });
      expect(await ask(projectId, { effective_date: '2027-02-30' })).toMatchObject({ status: 422 });
      expect(await ask(projectId, { reason: 'short' })).toMatchObject({ status: 422 });
      expect(await ask(projectId, { transfer_scope: 'EVERYTHING' })).toMatchObject({ status: 422 });
      expect(await ask(projectId, { decision_document_id: randomUUID() })).toMatchObject({ status: 422 });
      await rows(`update machvon.project set status = 'SETTLED' where id = $1::uuid`, [projectId]);
      expect(await ask(projectId)).toMatchObject({ status: 422, json: { code: 'PROJECT_STAGE_INVALID' } });
      await rows(`update machvon.organization_unit set valid_from = '2019-01-01', valid_until = '2020-01-01' where id = $1::uuid`, [unitId(RETIRED)]);
      expect(await ask(await project(HERE), { to_unit_id: unitId(RETIRED) })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
    });

    it('asks only for the projects in the scope of the caller: another branch is 403 for the caller who sees it but may not transfer it, a stranger without the permission is 403, a project that does not exist is 404, another tenant has none', async () => {
      const there = await project(ELSEWHERE);
      const here = await project(HERE);
      expect((await ask(here, {}, UNIT_REQUESTER)).status).toBe(200);
      expect(await ask(there, {}, UNIT_REQUESTER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await ask(there, {}, STRANGER)).toMatchObject({ status: 403 });
      expect(await ask(here, {}, STRANGER)).toMatchObject({ status: 403 });
      expect(await ask(id(FAMILY, 9999))).toMatchObject({ status: 404 });
      expect(await call('POST', `/projects/${here}/transfers`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 1, body: { to_unit_id: unitId(THERE), transfer_scope: 'OWNER_UNIT', effective_date: tomorrow, reason: 'Another tenant tries a project that is not theirs' } })).toMatchObject({ status: 404 });
    });

    it('decides only the requests of the projects in scope: a request that does not exist is 404, a stranger without the right is 403, and another tenant does not see it', async () => {
      const requestId = idOf(await ask(await project(HERE)));
      expect(await decide(randomUUID(), 1, 'approve')).toMatchObject({ status: 404 });
      expect(await decide(requestId, 1, 'approve', STRANGER)).toMatchObject({ status: 403 });
      expect(await call('POST', `/project-transfers/${requestId}/decision`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 1, body: { decision: 'approve', reason: 'Another tenant tries a request' } })).toMatchObject({ status: 404 });
    });
  });

  describe('the preview (PRJ-20)', () => {
    it('AC-ST-PRJ-007-2 / UI-PRJ-20: counts the reports, the lines of snapshots and the plan lines of the project and the members who gain or lose sight of it, and the counts are what the data holds before the transfer', async () => {
      const projectId = await project(HERE);
      const periodId = randomUUID();
      await seed([
        ...[1, 2].map((revision): [string, unknown[]] => [
          `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, submitted_at, submitted_by, accepted_at, accepted_by, amendment_reason, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $9, $7, 1, repeat('b', 64), 'WEEKLY', 'YTD', now(), $8, now(), $10, $11, $8, $8)`,
          [TENANT_A, randomUUID(), projectId, periodId, randomUUID(), revision, revision === 2, WORKER_MEMBERSHIP_ID, revision === 2 ? 'ACCEPTED' : 'SUPERSEDED', memberId(APPROVER), revision === 2 ? 'Corrected after the review of the unit' : null],
        ]),
        [
          `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level, origin, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 10, 0, $4, 'LOCAL', 'LOCAL_ADDED', $5, $5)`,
          [TENANT_A, randomUUID(), randomUUID(), projectId, WORKER_MEMBERSHIP_ID],
        ],
      ]);
      const reply = await call('GET', `/projects/${projectId}/transfer-impact?to_unit_id=${unitId(THERE)}&transfer_scope=OWNER_UNIT`, { member: REQUESTER });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        project_id: projectId,
        transfer_scope: 'OWNER_UNIT',
        from_unit: { id: unitId(HERE) },
        to_unit: { id: unitId(THERE) },
        reports: 2,
        snapshot_lines: 0,
        plan_lines: 1,
        users_gaining: 1,
        users_losing: 1,
        partial: false,
      });
      expect(Object.keys(reply.json).sort()).toEqual(['as_of', 'from_unit', 'members_checked', 'partial', 'plan_lines', 'project_id', 'reports', 'snapshot_lines', 'to_unit', 'transfer_scope', 'users_gaining', 'users_losing']);
      // The preview changes nothing, and asks nothing the caller may not.
      expect((await projectRow(projectId)).owner_unit_id).toBe(unitId(HERE));
      expect(await call('GET', `/projects/${projectId}/transfer-impact?to_unit_id=${unitId(THERE)}&transfer_scope=OWNER_UNIT`, { member: STRANGER })).toMatchObject({ status: 403 });
      expect(await call('GET', `/projects/${projectId}/transfer-impact?to_unit_id=${unitId(HERE)}&transfer_scope=OWNER_UNIT`, { member: REQUESTER })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
      expect(await call('GET', `/projects/${projectId}/transfer-impact?to_unit_id=${randomUUID()}&transfer_scope=OWNER_UNIT`, { member: REQUESTER })).toMatchObject({ status: 404 });
      expect(await call('GET', `/projects/${projectId}/transfer-impact?transfer_scope=OWNER_UNIT`, { member: REQUESTER })).toMatchObject({ status: 422, json: { detail: 'to_unit_id' } });
      expect(await call('GET', `/projects/${projectId}/transfer-impact?to_unit_id=${unitId(THERE)}&transfer_scope=ALL`, { member: REQUESTER })).toMatchObject({ status: 422 });
    });
  });

  describe('the list', () => {
    it('lists the requests of the projects in scope, newest first, by project and status, a page at a time; judges the query; shows nothing of another tenant', async () => {
      const projectId = await project(HERE, ELSEWHERE);
      const a = idOf(await ask(projectId));
      const b = idOf(await ask(projectId, { transfer_scope: 'INVESTOR_UNIT' }));
      const reply = await call('GET', `/project-transfers?project_id=${projectId}`, { member: REQUESTER });
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([b, a]);
      expect(items[0]).toMatchObject({ transfer_scope: 'INVESTOR_UNIT', status: 'REQUESTED', version: 1, project: { id: projectId }, from_unit: { id: unitId(ELSEWHERE) }, to_unit: { id: unitId(THERE) }, effective_date: tomorrow, approved_by: null });
      expect(Object.keys(items[0]!).sort()).toEqual(['applied_at', 'approved_by', 'created_at', 'created_by', 'decided_at', 'decision_document_id', 'decision_reason', 'effective_date', 'from_unit', 'id', 'project', 'reason', 'status', 'to_unit', 'transfer_scope', 'version']);
      const paged = await call('GET', `/project-transfers?project_id=${projectId}&limit=1`, { member: REQUESTER });
      expect((paged.json.items as unknown[]).length).toBe(1);
      const next = await call('GET', `/project-transfers?project_id=${projectId}&limit=1&cursor=${paged.json.next_cursor as string}`, { member: REQUESTER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).toBe(a);
      expect(next.json.next_cursor).toBeNull();
      expect(((await call('GET', `/project-transfers?project_id=${projectId}&status=APPLIED`, { member: REQUESTER })).json.items as unknown[]).length).toBe(0);
      expect(await call('GET', '/project-transfers?project_id=nope', { member: REQUESTER })).toMatchObject({ status: 422, json: { detail: 'project_id' } });
      const badCursor = Buffer.from(JSON.stringify(['not a time', randomUUID()])).toString('base64url');
      expect(await call('GET', `/project-transfers?cursor=${badCursor}`, { member: REQUESTER })).toMatchObject({ status: 422, json: { detail: 'cursor' } });
      expect((await call('GET', '/project-transfers?limit=200', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    });
  });
});
