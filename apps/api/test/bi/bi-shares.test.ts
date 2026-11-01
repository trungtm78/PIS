import { randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { ANALYST_ALL, ANALYST_BRANCH, ANALYST_NONE, BUILDER, BiApp, DASH_MAKER, DASH_VIEWER, DATASET, NOBODY, PIPELINE, REQUESTER, ROOT, BRANCH, TENANT_A, TENANT_B, UNIT_A, UNIT_OUT, contextFor, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(180_000);

const app = new BiApp();
let sequence = 0;
const BILLION = 1_000_000_000;
const OUTSIDER = 30; // a member of tenant B only
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const sqlAs = (member: number, statement: string, params: unknown[] = []): Promise<unknown> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), (tx) => tx.query(statement, params));
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const audits = (action: string, id: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 and resource_id = $2 order by occurred_at', [action, id]);
const dashboardRow = async (id: string) => (await owner<{ audience: string; status: string; version: string }>('select audience, status, version::text from machvon.dashboard where id = $1', [id]))[0] as { audience: string; status: string; version: string };

const share = (dashboardId: string, body: Record<string, unknown>, member = REQUESTER, version?: number): Promise<Reply> =>
  app.call('POST', `/bi/dashboards/${dashboardId}/shares`, { member, body, ifMatch: `"${version ?? 0}"` });
/** Shares under the version of the dashboard as it is now, as a client that has just read it does. */
async function shareNow(dashboardId: string, body: Record<string, unknown>, member = REQUESTER): Promise<Reply> {
  return share(dashboardId, body, member, Number((await dashboardRow(dashboardId)).version));
}
const revoke = (shareId: string, version: number, member = REQUESTER): Promise<Reply> => app.call('POST', `/bi/dashboard-shares/${shareId}/revocation`, { member, ifMatch: `"${version}"` });
const open = (id: string, member: number): Promise<Reply> => app.call('GET', `/bi/dashboards/${id}`, { member });
const user = (member: number, permission = 'VIEW') => ({ grantee_kind: 'USER', grantee_ref_id: memberId(member), permission });

const widget = (metric: string) => ({ id: 'w1', kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: 0, w: 12, h: 4 } });
async function certified(): Promise<string> {
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.metric_definition (tenant_id, id, code, revision, grain, aggregation_type, expression_ast, unit, owner_id, status, origin, created_by, certified_by, certified_at, version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 1, 'project', 'additive', '{"op":"sum","args":[{"op":"field","name":"GIAI_NGAN"}]}'::jsonb, 'VND', $3::uuid, 'CERTIFIED', 'TENANT_UI', $3::uuid, $4::uuid, now(), 1)`,
    [id, `t_share_${sequence}`, memberId(REQUESTER), memberId(NOBODY)],
  );
  return id;
}
/** A dashboard of the requester with one saved version over a certified metric. */
async function board(code = `D-S-${(sequence += 1)}`): Promise<{ id: string; metric: string }> {
  const made = await app.call('POST', '/bi/dashboards', { member: REQUESTER, body: { code, title: 'Dashboard giải ngân' } });
  const id = made.json.resource_id as string;
  const metric = await certified();
  const saved = await app.call('POST', `/bi/dashboards/${id}/versions`, {
    member: REQUESTER,
    ifMatch: `"${made.json.resource_version as number}"`,
    body: { layout_json: { widgets: [widget(metric)] }, breakpoints: { sm: 640 }, metric_versions: [metric], filter_mappings: { period: 'bucket' }, dataset_version_policy: 'LATEST_FROZEN' },
  });
  expect(saved.status).toBe(200);
  return { id, metric };
}

/** A frozen close snapshot with lines in two units, a dataset version built over it, and the metric of the dashboard synced for the queries. */
async function figures(): Promise<{ version: string; metric: string }> {
  sequence += 1;
  const periodId = randomUUID();
  const snapshot = randomUUID();
  const code = `2032-${String(sequence).padStart(2, '0')}`;
  const lines: Array<{ unit: number; paid: number }> = [
    { unit: UNIT_A, paid: 4 * BILLION },
    { unit: UNIT_OUT, paid: 9 * BILLION },
  ];
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2032-01-01' + $6::int * 40, date '2032-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2032, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, sequence],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2032-10-31', date '2032-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
      [TENANT_A, snapshot, periodId, lines.length, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
    ],
  ];
  for (const line of lines) {
    const project = randomUUID();
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, project, `P-${project.slice(0, 8)}`, unitId(line.unit), randomUUID()],
    ]);
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, null, 'CURRENT_YEAR', 'CENTRAL', 10, 0, 10, $5::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, snapshot, project, unitId(line.unit), line.paid],
    ]);
  }
  await app.seedReplica(statements);
  const built = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: code } });
  expect(built.status).toBe(202);
  const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
  const disbursed = (listed.json.items as Array<{ id: string; code: string }>).find((item) => item.code === 'disbursed_share');
  return { version: built.json.resource_id as string, metric: disbursed?.id as string };
}

describe('sharing a dashboard without data access (ST-BI-007, BI 3 F6)', () => {
  beforeAll(async () => {
    await app.start();
    await app.harness.seedMembership(TENANT_B, OUTSIDER, ROOT);
    const bundle = await app.bundle([{ code: 'disbursed_share', grain: 'project', aggregation_type: 'additive', expression: { op: 'sum', args: [{ op: 'field', name: 'GIAI_NGAN' }] }, unit: 'VND', effective_from: '2026-01-01' }]);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'shares1', bundle_object_key: bundle.key, bundle_sha256: bundle.sha256 } })).status).toBe(200);
    // The policy that opens the dataset to the role of the queries: the rows of the scope of whoever asks.
    await app.seedReplica([
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 1, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)`,
        [TENANT_A, randomUUID(), DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);

  it('AC-ST-BI-007-1: UAT-AC35 shows the layout of D-2 to a staff member of one unit with their own figures and the label of their scope, and is 404 for them once the share is revoked', async () => {
    const world = await figures();
    const d2 = await board('D-2');
    // Nothing is shown before the share.
    expect(await open(d2.id, ANALYST_BRANCH)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });

    const made = await shareNow(d2.id, user(ANALYST_BRANCH));
    expect(made).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 1 } });
    const shareId = made.json.resource_id as string;
    expect((await dashboardRow(d2.id)).audience).toBe('SHARED');

    const seen = await open(d2.id, ANALYST_BRANCH);
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ code: 'D-2', permission: 'VIEW', may_edit: false, mine: false, shares: [] });
    expect((seen.json.versions as Array<{ layout_json: { widgets: unknown[] } }>)[0]?.layout_json.widgets).toHaveLength(1);
    const library = await app.call('GET', '/bi/dashboards', { member: ANALYST_BRANCH });
    expect((library.json.items as Array<{ code: string }>).map((item) => item.code)).toContain('D-2');

    // The figures are the staff member's own, not the leader's, and they are told so.
    const query = (member: number) => app.call('POST', '/dashboard-queries', { member, body: { metric_version_id: world.metric, snapshot_id: world.version, filters: [], dimensions: [] } });
    const staff = await query(ANALYST_BRANCH);
    const leader = await query(ANALYST_ALL);
    expect((staff.json.total as { value: string }).value).toBe('4000000000');
    expect((leader.json.total as { value: string }).value).toBe('13000000000');
    expect(staff.json).toMatchObject({ scope: { label: 'YOUR_SCOPE', full_tenant: false } });
    expect(leader.json).toMatchObject({ scope: { label: 'FULL_TENANT', full_tenant: true } });

    // The revocation is at once.
    expect(await revoke(shareId, 1)).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_version: 2 } });
    expect(await open(d2.id, ANALYST_BRANCH)).toMatchObject({ status: 404 });
    const after = await app.call('GET', '/bi/dashboards', { member: ANALYST_BRANCH });
    expect((after.json.items as Array<{ code: string }>).map((item) => item.code)).not.toContain('D-2');
    expect((await dashboardRow(d2.id)).audience).toBe('PRIVATE');
    expect((await events(shareId, 'bi.dashboard.shared.v1'))[0]?.payload).toMatchObject({ dashboard_id: d2.id, grantee_kind: 'USER', grantee_ref_id: memberId(ANALYST_BRANCH), permission: 'VIEW', actor_id: memberId(REQUESTER) });
    expect((await events(shareId, 'bi.dashboard.share_revoked.v1'))[0]?.payload).toMatchObject({ share_id: shareId });
    expect((await audits('bi.dashboard.share', shareId))[0]?.safe_diff).toMatchObject({ dashboard_id: d2.id, permission: 'VIEW' });
    expect(await audits('bi.dashboard.share_revoke', shareId)).toHaveLength(1);
  });

  it('AC-ST-BI-007-2: UAT-AC35 refuses a share to a person, a role or a unit of another tenant, and to none that exists', async () => {
    const d = await board();
    expect(await shareNow(d.id, user(OUTSIDER))).toMatchObject({ status: 422, json: { code: 'GRANTEE_OUT_OF_TENANT', detail: 'grantee_ref_id' } });
    expect(await shareNow(d.id, { grantee_kind: 'ROLE', grantee_ref_id: randomUUID(), permission: 'VIEW' })).toMatchObject({ status: 422, json: { code: 'GRANTEE_OUT_OF_TENANT' } });
    expect(await shareNow(d.id, { grantee_kind: 'UNIT', grantee_ref_id: randomUUID(), permission: 'VIEW' })).toMatchObject({ status: 422, json: { code: 'GRANTEE_OUT_OF_TENANT' } });
    expect(await shareNow(d.id, { grantee_kind: 'USER', grantee_ref_id: randomUUID(), permission: 'VIEW' })).toMatchObject({ status: 422, json: { code: 'GRANTEE_OUT_OF_TENANT' } });
    expect(await app.count('select count(*)::text as n from machvon.dashboard_share where dashboard_id = $1', [d.id])).toBe(0);
    expect((await dashboardRow(d.id)).audience).toBe('PRIVATE');
  });

  it('reaches a role and a unit (and the units under it), and a person who is out of them still finds nothing', async () => {
    const d = await board();
    // Role 9 is held by the members who query; the unit BRANCH is the unit of ANALYST_BRANCH and above UNIT_A.
    const byRole = await shareNow(d.id, { grantee_kind: 'ROLE', grantee_ref_id: roleId(9), permission: 'VIEW' });
    expect(byRole.status).toBe(200);
    expect((await open(d.id, ANALYST_ALL)).status).toBe(200);
    expect((await open(d.id, ANALYST_BRANCH)).status).toBe(200);
    expect((await open(d.id, DASH_VIEWER)).status).toBe(404);
    expect((await revoke(byRole.json.resource_id as string, 1)).status).toBe(200);
    expect((await open(d.id, ANALYST_ALL)).status).toBe(404);
    const byUnit = await shareNow(d.id, { grantee_kind: 'UNIT', grantee_ref_id: unitId(BRANCH), permission: 'VIEW' });
    expect(byUnit.status).toBe(200);
    expect((await open(d.id, ANALYST_BRANCH)).status).toBe(200);
    expect((await open(d.id, ANALYST_ALL)).status).toBe(404);
    // The tenant as a whole is the root unit: every member is under it.
    expect((await shareNow(d.id, { grantee_kind: 'UNIT', grantee_ref_id: unitId(ROOT), permission: 'VIEW' })).status).toBe(200);
    expect((await open(d.id, ANALYST_ALL)).status).toBe(200);
    expect((await open(d.id, DASH_VIEWER)).status).toBe(200);
    expect((await open(d.id, ANALYST_NONE)).status).toBe(200);
  });

  it('lets a person it is shared with to change it save a version, and one it is shared with to see it only read, and neither share or revoke', async () => {
    const d = await board();
    const edit = await shareNow(d.id, user(DASH_MAKER, 'EDIT'));
    const view = await shareNow(d.id, user(DASH_VIEWER, 'VIEW'));
    expect(edit.status).toBe(200);
    expect(view.status).toBe(200);
    expect((await open(d.id, DASH_MAKER)).json).toMatchObject({ permission: 'EDIT', may_edit: true, shares: [] });
    expect((await open(d.id, DASH_VIEWER)).json).toMatchObject({ permission: 'VIEW', may_edit: false });
    const draft = (metric: string) => ({ layout_json: { widgets: [widget(metric)] }, breakpoints: { sm: 640 }, metric_versions: [metric], filter_mappings: { period: 'bucket' }, dataset_version_policy: 'LATEST_FROZEN' });
    const version = async () => Number((await dashboardRow(d.id)).version);
    expect(await app.call('POST', `/bi/dashboards/${d.id}/versions`, { member: DASH_VIEWER, ifMatch: `"${await version()}"`, body: draft(d.metric) })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await app.call('POST', `/bi/dashboards/${d.id}/versions`, { member: DASH_MAKER, ifMatch: `"${await version()}"`, body: draft(d.metric) })).toMatchObject({ status: 200, json: { revision: 2 } });
    // The owner alone shares and takes a share back.
    expect(await share(d.id, user(NOBODY), DASH_MAKER, await version())).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await revoke(view.json.resource_id as string, 1, DASH_MAKER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    // A share to change does not make them the owner: the dashboard is still the requester's, and an EDIT share ends like any other.
    expect((await dashboardRow(d.id)).audience).toBe('SHARED');
    expect((await revoke(edit.json.resource_id as string, 1)).status).toBe(200);
    expect(await app.call('POST', `/bi/dashboards/${d.id}/versions`, { member: DASH_MAKER, ifMatch: `"${await version()}"`, body: draft(d.metric) })).toMatchObject({ status: 404 });
    // The dashboard stays shared while one share is active, and is private again with none.
    expect((await dashboardRow(d.id)).audience).toBe('SHARED');
    expect((await revoke(view.json.resource_id as string, 1)).status).toBe(200);
    expect((await dashboardRow(d.id)).audience).toBe('PRIVATE');
  });

  it('tells the owner who the dashboard is shared with, with the names, and keeps that from the others', async () => {
    const d = await board();
    const made = await shareNow(d.id, user(DASH_VIEWER));
    await shareNow(d.id, { grantee_kind: 'UNIT', grantee_ref_id: unitId(BRANCH), permission: 'EDIT' });
    const shares = (await open(d.id, REQUESTER)).json.shares as Array<Record<string, unknown>>;
    expect(shares).toHaveLength(2);
    expect(shares.map((item) => item.grantee_kind).sort()).toEqual(['UNIT', 'USER']);
    expect(shares.every((item) => item.status === 'ACTIVE' && typeof item.grantee_name === 'string')).toBe(true);
    expect((await open(d.id, DASH_VIEWER)).json.shares).toEqual([]);
    await revoke(made.json.resource_id as string, 1);
    const listed = (await open(d.id, REQUESTER)).json.shares as Array<{ status: string }>;
    expect(listed.map((item) => item.status)).toEqual(['ACTIVE', 'REVOKED']);
  });

  it('refuses a second active share for one grantee, a share to the owner, a revocation twice, and another that is stale', async () => {
    const d = await board();
    const made = await shareNow(d.id, user(DASH_VIEWER));
    expect(await shareNow(d.id, user(DASH_VIEWER, 'EDIT'))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED', detail: 'grantee_ref_id' } });
    expect(await shareNow(d.id, user(REQUESTER))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'grantee_ref_id' } });
    expect(await shareNow(d.id, { grantee_kind: 'USER', grantee_ref_id: 'nope', permission: 'VIEW' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'grantee_ref_id' } });
    expect(await share(d.id, user(NOBODY), REQUESTER, 999)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await revoke(made.json.resource_id as string, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await revoke(made.json.resource_id as string, 1)).status).toBe(200);
    expect(await revoke(made.json.resource_id as string, 2)).toMatchObject({ status: 409, json: { code: 'SHARE_STATE_INVALID' } });
    // Shared again after it ended: a new share is a new row.
    const again = await shareNow(d.id, user(DASH_VIEWER));
    expect(again.status).toBe(200);
    expect(again.json.resource_id).not.toBe(made.json.resource_id);
    expect(await revoke(randomUUID(), 1)).toMatchObject({ status: 404 });
    expect(await share(randomUUID(), user(NOBODY), REQUESTER, 1)).toMatchObject({ status: 404 });
    // A dashboard that is not the caller's is not found by them, and not theirs to share when they see it in the library.
    expect(await share(d.id, user(NOBODY), NOBODY, 1)).toMatchObject({ status: 403 });
    const other = await app.call('POST', '/bi/dashboards', { member: DASH_MAKER, body: { code: `D-X-${(sequence += 1)}`, title: 'Của người khác' } });
    expect(await share(other.json.resource_id as string, user(NOBODY), REQUESTER, 1)).toMatchObject({ status: 404 });
    expect(await revoke(again.json.resource_id as string, 1, DASH_MAKER)).toMatchObject({ status: 404 });
    await owner("update machvon.dashboard set status = 'ARCHIVED' where id = $1", [d.id]);
    expect(await shareNow(d.id, user(NOBODY))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED', detail: 'status' } });
  });

  it('gives a share nothing but the layout: a person with the share and no right to query still reads no figure', async () => {
    const world = await figures();
    const d = await board();
    expect((await shareNow(d.id, user(NOBODY))).status).toBe(200);
    // NOBODY holds no right at all: the layout is the dashboard's, the figures are not reachable through the share.
    expect(await app.call('POST', '/dashboard-queries', { member: NOBODY, body: { metric_version_id: world.metric, snapshot_id: world.version, filters: [], dimensions: [] } })).toMatchObject({ status: 403 });
  });

  it('keeps the shares as they were made, in the database: who, what and the permission never change, a share ends once, nothing is deleted', async () => {
    const d = await board();
    const made = await shareNow(d.id, user(DASH_VIEWER));
    const id = made.json.resource_id as string;
    await expect(sqlAs(REQUESTER, "update machvon.dashboard_share set permission = 'EDIT' where id = $1", [id])).rejects.toThrow(/never change/);
    await expect(sqlAs(REQUESTER, 'update machvon.dashboard_share set grantee_ref_id = $2::uuid where id = $1', [id, memberId(NOBODY)])).rejects.toThrow(/never change/);
    await expect(sqlAs(REQUESTER, 'update machvon.dashboard_share set dashboard_id = $2::uuid where id = $1', [id, randomUUID()])).rejects.toThrow(/never change|foreign key/);
    await expect(sqlAs(REQUESTER, "update machvon.dashboard_share set status = 'REVOKED' where id = $1", [id])).rejects.toThrow(/dashboard_share_revoked_chk/);
    await expect(sqlAs(REQUESTER, "update machvon.dashboard_share set status = 'REVOKED', revoked_at = now() where id = $1", [id])).resolves.toBeDefined();
    await expect(sqlAs(REQUESTER, "update machvon.dashboard_share set status = 'ACTIVE', revoked_at = null where id = $1", [id])).rejects.toThrow(/cannot move from REVOKED to ACTIVE/);
    await expect(sqlAs(REQUESTER, 'update machvon.dashboard_share set revoked_at = now() + interval \'1 day\' where id = $1', [id])).rejects.toThrow(/written once/);
    await expect(sqlAs(REQUESTER, 'delete from machvon.dashboard_share where id = $1', [id])).rejects.toThrow(/permission denied|never deleted/);
    await expect(sqlAs(REQUESTER, 'truncate machvon.dashboard_share', [])).rejects.toThrow(/permission denied/);
    const privileges = await owner<{ share: boolean }>("select has_table_privilege('machvon_app', 'machvon.dashboard_share', 'DELETE') as share");
    expect(privileges[0]).toEqual({ share: false });
    void TENANT_B;
  });
});
