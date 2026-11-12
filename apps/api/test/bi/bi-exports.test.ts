import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, WORKER_MEMBERSHIP_ID, loadAccessIn } from '@machvon/db';
import { BiExportController } from '../../src/modules/bi/export.controller';
import type { CommandScope } from '../../src/command-scope';
import { expireExports, runExportSchedules, runExportSchedulesIn } from '../../src/modules/bi/export-jobs';
import type { ExportJobDeps } from '../../src/modules/bi/export-jobs';
import { ANALYST_ALL, ANALYST_BRANCH, ANALYST_NONE, BUILDER, BiApp, CLOCK, DATASET, NOBODY, PIPELINE, TENANT_A, TENANT_B, UNIT_A, UNIT_OUT, contextFor, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(300_000);

const app = new BiApp();
let sequence = 0;
const BILLION = 1_000_000_000;
const OUTSIDER = 30; // a member of tenant B only
const LEADER = ANALYST_ALL; // the whole tenant
const STAFF = ANALYST_BRANCH; // the units under the branch
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const sqlAs = (member: number, statement: string, params: unknown[] = []): Promise<unknown> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), (tx) => tx.query(statement, params));
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const audits = (action: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]);
const jobRow = async (id: string) =>
  (await owner<{ status: string; denied_reason: string | null; file_object_key: string | null; file_sha256: string | null; row_count: number | null; truncated: boolean; subject_user_id: string; schedule_id: string | null; expires_at: string | null; scope_description: string }>(
    'select status, denied_reason, file_object_key, file_sha256, row_count, truncated, subject_user_id, schedule_id, expires_at, scope_description from machvon.bi_export_job where id = $1',
    [id],
  ))[0];

interface World {
  /** The id the version of the dataset has, and the period: what an export names. */
  version: string;
  period: string;
}
let metric = '';

/** A frozen close snapshot (lines of `units`, or `projects` lines of one unit each) and the version of the dataset built over it. */
async function figures(options: { units?: Array<{ unit: number; paid: number }>; projects?: number } = {}): Promise<World> {
  sequence += 1;
  const periodId = randomUUID();
  const snapshot = randomUUID();
  const code = `2033-${String(sequence).padStart(2, '0')}`;
  const units = options.units ?? [
    { unit: UNIT_A, paid: 4 * BILLION },
    { unit: UNIT_OUT, paid: 9 * BILLION },
  ];
  const count = options.projects ?? units.length;
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2033-01-01' + $6::int * 40, date '2033-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2033, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, sequence],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2033-10-31', date '2033-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
      [TENANT_A, snapshot, periodId, count, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
    ],
  ];
  if (options.projects === undefined) {
    for (const line of units) {
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
  } else {
    const id = "('00000000-0000-4000-9' || lpad($5::text, 3, '0') || '-' || lpad(g::text, 12, '0'))::uuid";
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       select $1, ${id}, 'PX' || $3::text || '-' || g, 'PX' || g, $2, gen_random_uuid(), 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B' from generate_series(1, $4::int) g`,
      [TENANT_A, unitId(UNIT_A), sequence, options.projects, sequence],
    ]);
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       select $1, gen_random_uuid(), $2, ${id}, $3, null, 'CURRENT_YEAR', 'CENTRAL', 10, 0, 10, 1, 'NO_DATA', 'COMPLETE' from generate_series(1, $4::int) g`,
      [TENANT_A, snapshot, unitId(UNIT_A), options.projects, sequence],
    ]);
  }
  await app.seedReplica(statements);
  const built = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: code } });
  expect(built.status).toBe(202);
  return { version: built.json.resource_id as string, period: code };
}

const spec = (dimensions: string[] = ['unit'], extra: Record<string, unknown> = {}) => ({ metric_version_id: metric, dimensions, ...extra });
const request = (world: World, format: string, member = LEADER, query: Record<string, unknown> = spec(), snapshot = false, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/bi/exports', { member, body: { query_spec: query, as_of_period: world.period, format, ...(snapshot ? { snapshot_id: world.version } : {}) }, ...(tenantId === undefined ? {} : { tenantId }) });
const show = (id: string, member = LEADER, tenantId?: string): Promise<Reply> => app.call('GET', `/bi/exports/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const fetchFile = async (url: string): Promise<{ status: number; bytes: Buffer }> => {
  const response = await fetch(`${app.app.baseUrl}${url}`);
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
};
const createSchedule = (member: number, body: Record<string, unknown>): Promise<Reply> => app.call('POST', '/bi/export-schedules', { member, body });
const WEEKLY = '0 8 * * 1';

/** The runner of the schedules, as the job calls it, at a given moment. */
const runSchedules = (now: Date, files: ExportJobDeps['files'] = app.objects) =>
  app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => runExportSchedules(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), now, { files, audit: new AuditWriter(app.harness.tenants) }));
const later = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/** The version of the scope of a member only goes up (what the service caches is keyed by it), so a revocation and a restoration each move it. */
async function bumpScope(member: number): Promise<void> {
  const rows = await app.harness.owner<{ scope_version: string }>(TENANT_A, [['update machvon.membership set scope_version = scope_version + 1 where id = $1 returning scope_version::text', [memberId(member)]]]);
  app.scopeVersions.set(member, Number(rows[0]?.scope_version));
}

async function revokeScope(member: number, units: number[]): Promise<void> {
  for (const unit of units) await app.seedReplica([["update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1 and scope_ref_ids = array[$2]::uuid[]", [memberId(member), unitId(unit)]]]);
  await bumpScope(member);
}

describe('exports and the per-recipient schedules (ST-BI-008, BI 3 F7)', () => {
  beforeAll(async () => {
    await app.start();
    await app.harness.seedMembership(TENANT_B, OUTSIDER, 1);
    const bundle = await app.bundle([{ code: 'disbursed_exp', grain: 'project', aggregation_type: 'additive', expression: { op: 'sum', args: [{ op: 'field', name: 'GIAI_NGAN' }] }, unit: 'VND', effective_from: '2026-01-01' }]);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'exports1', bundle_object_key: bundle.key, bundle_sha256: bundle.sha256 } })).status).toBe(200);
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    metric = (listed.json.items as Array<{ id: string; code: string }>).find((item) => item.code === 'disbursed_exp')?.id as string;
    await app.seedReplica([
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 1, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)`,
        [TENANT_A, randomUUID(), DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);
  // A test that revokes the scope of the staff member leaves the next one the scope it began with.
  beforeEach(async () => {
    await app.seedReplica([["update machvon.role_grant set status = 'Active', revoked_at = null where membership_id = $1", [memberId(STAFF)]]]);
    await bumpScope(STAFF);
  });

  it('AC-ST-BI-008-1: UAT-AC475 makes two separate jobs for a weekly schedule, the leader\'s with a header that states scope, period and snapshot, the staff member\'s DENIED with no file once their scope is revoked', async () => {
    const world = await figures();
    const made = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: WEEKLY, format: 'CSV', recipients: [memberId(LEADER), memberId(STAFF)] });
    expect(made).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 1 } });
    const scheduleId = made.json.resource_id as string;
    await revokeScope(STAFF, [UNIT_A, 4, 6]);

    // Before its time the schedule makes nothing; at its time it makes a job for each recipient.
    expect(await runSchedules(later(0.001))).toEqual([]);
    const ran = await runSchedules(later(8));
    expect(ran).toHaveLength(1);
    const jobs = ran[0]?.jobs ?? [];
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.subjectUserId))).toEqual(new Set([memberId(LEADER), memberId(STAFF)]));
    const leader = jobs.find((job) => job.subjectUserId === memberId(LEADER));
    const staff = jobs.find((job) => job.subjectUserId === memberId(STAFF));
    expect(leader).toMatchObject({ status: 'READY', scheduleId, requestedBy: memberId(LEADER), asOfPeriod: world.period, datasetVersionId: world.version, scopeDescription: 'Toàn tỉnh' });
    expect(staff).toMatchObject({ status: 'DENIED', deniedReason: 'SCOPE_DENIED', fileObjectKey: null, fileSha256: null });
    // The file of the leader says what the figures are, and has all the units.
    const stored = await app.objects.readStored(contextFor(TENANT_A, memberId(LEADER)), leader?.fileObjectKey as string);
    const text = Buffer.from(stored.bytes).toString('utf8');
    expect(text).toContain('Phạm vi,Toàn tỉnh');
    expect(text).toContain(`Kỳ,${world.period}`);
    expect(text).toContain(`Snapshot,${world.version}`);
    expect(text).toContain('disbursed_exp (bản 1, VND)');
    expect(text).toContain(',13000000000,,,');
    // BC.02: the file carries the three signatures; the person it is made for prepared it, and a certification nobody checked says so instead of naming somebody.
    expect(text).toMatch(/Người lập,.+, \d{4}-\d{2}-\d{2}/);
    expect(text).toContain('Người kiểm tra,chưa có');
    expect(text).toContain('Người phê duyệt,');
    expect(createHash('sha256').update(stored.bytes).digest('hex')).toBe(leader?.fileSha256);
    // No file was made for the staff member, and the denial is a record with an event.
    expect(await app.count("select count(*)::text as n from machvon.bi_export_job where schedule_id = $1 and file_object_key is not null", [scheduleId])).toBe(1);
    expect((await events(staff?.id as string, 'bi.export.denied.v1'))[0]?.payload).toMatchObject({ subject_user_id: memberId(STAFF), code: 'SCOPE_DENIED', schedule_id: scheduleId });
    expect((await events(leader?.id as string, 'bi.export.ready.v1'))[0]?.payload).toMatchObject({ subject_user_id: memberId(LEADER), link_only: false });
    // The run is written: the same moment makes nothing twice.
    expect(await runSchedules(later(8))).toEqual([]);
    expect(await app.count('select count(*)::text as n from machvon.bi_export_job where schedule_id = $1', [scheduleId])).toBe(2);
    // The leader reads the job and gets a link; the staff member does not see the job of another.
    expect((await show(leader?.id as string)).status).toBe(200);
    expect(await show(leader?.id as string, STAFF)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
  });

  it('AC-ST-BI-008-1: UAT-AC475 refuses 150,000 rows with 422 EXPORT_ROW_CAP_EXCEEDED, keeps the refusal as a DENIED job, and exports 100,000', async () => {
    const world = await figures({ projects: 150_000 });
    const refused = await request(world, 'CSV', LEADER, spec(['project']));
    expect(refused).toMatchObject({ status: 422, json: { code: 'EXPORT_ROW_CAP_EXCEEDED' } });
    const denied = await owner<{ id: string; status: string; denied_reason: string; row_count: number | null; truncated: boolean; file_object_key: string | null }>(
      "select id, status, denied_reason, row_count, truncated, file_object_key from machvon.bi_export_job where dataset_version_id = $1 and denied_reason = 'EXPORT_ROW_CAP_EXCEEDED'",
      [world.version],
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ status: 'DENIED', row_count: null, truncated: false, file_object_key: null });
    // The same answer is a figure with no groups, and a smaller cut of it is not over the cap.
    expect((await request(world, 'CSV', LEADER, spec([]))).status).toBe(200);
    // A PDF is a page to read: its cap is lower, and a larger answer is refused the same way.
    const small = await figures({ projects: 5_001 });
    expect(await request(small, 'PDF', LEADER, spec(['project']))).toMatchObject({ status: 422, json: { code: 'EXPORT_ROW_CAP_EXCEEDED' } });
    expect((await request(small, 'CSV', LEADER, spec(['project']))).status).toBe(200);
  });

  it('AC-ST-BI-008-2: UAT-AC479 is 404 for a user of another tenant, and the list is the person\'s own', async () => {
    const world = await figures();
    const made = await request(world, 'CSV');
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    expect(await show(id, BUILDER, TENANT_B)).toMatchObject({ status: 404 });
    expect(await app.call('GET', '/bi/exports', { member: BUILDER, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { items: [] } });
    const mine = await app.call('GET', '/bi/exports?limit=1', { member: LEADER });
    expect((mine.json.items as Array<{ id: string; status: string; subject: { id: string } }>)[0]).toMatchObject({ id, status: 'READY', subject: { id: memberId(LEADER) } });
    // The list of another person holds nothing of the leader's.
    const others = (await app.call('GET', '/bi/exports', { member: STAFF })).json.items as Array<{ subject: { id: string } }>;
    expect(others.every((item) => item.subject.id === memberId(STAFF))).toBe(true);
    expect(await show(randomUUID())).toMatchObject({ status: 404 });
    expect(await app.call('GET', '/bi/exports?cursor=zzz', { member: LEADER })).toMatchObject({ status: 422 });
  });

  it('AC-ST-BI-008-3: BI02 judges the right again when the file is asked for: a person whose scope changed gets no link to data they may no longer read, and a new export is cut to the scope they have now', async () => {
    const world = await figures();
    const first = await request(world, 'CSV', STAFF);
    expect(first.status).toBe(200);
    const before = await show(first.json.resource_id as string, STAFF);
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ scope_description: 'Theo phạm vi được cấp của người nhận' });
    const link = (before.json.download as { url: string; expires_at: string }).url;
    expect(new Date((before.json.download as { expires_at: string }).expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(link).toMatch(/^\/bi\/exports\/[0-9a-f-]+\/file\?tenant=.*&expires=\d+&signature=[0-9a-f]{64}$/);
    const file = await fetchFile(link);
    expect(file.status).toBe(200);
    expect(file.bytes.toString('utf8')).toContain(',4000000000,,,');
    expect(file.bytes.toString('utf8')).not.toContain('13000000000');
    // A link that is altered, or taken for another job, is nothing.
    expect((await fetchFile(link.replace(/signature=([0-9a-f])/, (_whole, digit: string) => `signature=${digit === '0' ? '1' : '0'}`))).status).toBe(401);
    expect((await fetchFile(link.replace(first.json.resource_id as string, randomUUID()))).status).toBe(401);
    expect((await fetchFile(`/bi/exports/${first.json.resource_id as string}/file?tenant=nope&expires=1&signature=x`)).status).toBe(401);
    // The scope changes (the branch is narrowed to one unit): the file made before is not given again, and a new export is cut to the new scope.
    await revokeScope(STAFF, [4, 6]);
    expect(await show(first.json.resource_id as string, STAFF)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    const again = await request(world, 'CSV', STAFF);
    expect(again.status).toBe(200);
    const bytes = (await app.objects.readStored(contextFor(TENANT_A, memberId(STAFF)), (await jobRow(again.json.resource_id as string))?.file_object_key as string)).bytes;
    expect(Buffer.from(bytes).toString('utf8')).toContain(',4000000000,,,');
    // A person who lost the whole right is refused before anything is made (the guard of the operation): no job, no file.
    await revokeScope(STAFF, [UNIT_A]);
    expect(await request(world, 'CSV', STAFF)).toMatchObject({ status: 403 });
  });

  it('does not give the file of a policy that was replaced: a policy that is tightened (or that hides the dimension) after the file was made is not served the old file, and a new export is cut under the new one', async () => {
    const world = await figures();
    const made = await request(world, 'CSV', STAFF);
    expect(made.status).toBe(200);
    expect((await show(made.json.resource_id as string, STAFF)).status).toBe(200);
    // The policy of the role is replaced by one that hides the unit: the same grants, another policy.
    const replace = (masks: string) =>
      owner(
        "with retired as (update machvon.bi_access_policy set status = 'RETIRED' where dataset_id = $1 and grantee_ref_id = $2 and status = 'ACTIVE') insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by) select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, coalesce(max(revision), 0) + 1, 'ROLE', $2, '{\"op\":\"unit_in_scope\"}'::jsonb, $3::jsonb, 'ACTIVE', $4, $5, $4 from machvon.bi_access_policy where dataset_id = $1 and grantee_ref_id = $2",
        [DATASET, roleId(9), masks, memberId(BUILDER), memberId(PIPELINE)],
      );
    await replace('{"unit":"HIDE"}');
    expect(await show(made.json.resource_id as string, STAFF)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    // The dimension the policy hides is refused in a new export, and one that does not read it is made under the new policy.
    expect(await request(world, 'CSV', STAFF)).toMatchObject({ status: 422, json: { code: 'DIMENSION_NOT_IN_DATASET' } });
    const fresh = await request(world, 'CSV', STAFF, spec([]));
    expect(fresh.status).toBe(200);
    expect((await show(fresh.json.resource_id as string, STAFF)).status).toBe(200);
    // The policy as it was is back: the file made under the policy in between is not the one to give.
    await replace('{}');
    expect(await show(fresh.json.resource_id as string, STAFF)).toMatchObject({ status: 403 });
    expect((await request(world, 'CSV', STAFF)).status).toBe(200);
  });

  it('makes a file in each format with the header of what the figures are, from the latest frozen version of the period or the one named, and tells it on the audit trail and as events', async () => {
    const world = await figures();
    const csv = await request(world, 'CSV', LEADER, spec(['unit', 'bucket'].slice(0, 1)), true);
    expect(csv.status).toBe(200);
    const id = csv.json.resource_id as string;
    expect(csv.json).toMatchObject({ status: 'READY', row_count: 2 });
    const job = await jobRow(id);
    expect(job).toMatchObject({ status: 'READY', schedule_id: null, subject_user_id: memberId(LEADER), scope_description: 'Toàn tỉnh', truncated: false });
    expect(new Date(job?.expires_at as string).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    const text = Buffer.from((await app.objects.readStored(contextFor(TENANT_A, memberId(LEADER)), job?.file_object_key as string)).bytes).toString('utf8');
    expect(text).toContain('Chiều,Đơn vị');
    expect(text).toContain(`${unitId(UNIT_A)},`);
    expect(text).toContain(',Tổng,13000000000,,,');
    const xlsx = await request(world, 'XLSX');
    const pdf = await request(world, 'PDF');
    expect([xlsx.status, pdf.status]).toEqual([200, 200]);
    const bytesOf = async (reply: Reply) => Buffer.from((await app.objects.readStored(contextFor(TENANT_A, memberId(LEADER)), (await jobRow(reply.json.resource_id as string))?.file_object_key as string)).bytes);
    expect((await bytesOf(xlsx)).subarray(0, 2).toString()).toBe('PK');
    expect((await bytesOf(pdf)).subarray(0, 4).toString()).toBe('%PDF');
    expect((await events(id, 'bi.export.requested.v1'))[0]?.payload).toMatchObject({ job_id: id, subject_user_id: memberId(LEADER), format: 'CSV' });
    expect(await events(id, 'bi.export.ready.v1')).toHaveLength(1);
    const logged = (await audits('bi.export_request')).find((row) => row.safe_diff.snapshot_id === world.version && row.safe_diff.format === 'CSV');
    expect(logged?.safe_diff).toMatchObject({ rows: 2, as_of_period: world.period, file_sha256: job?.file_sha256 });
    // The figure alone is one row, the total.
    const total = await request(world, 'CSV', LEADER, spec([]));
    expect(total.json).toMatchObject({ row_count: 0 });
  });

  it('refuses what cannot be exported and says why: an unknown field, a metric that is not certified, a period with no frozen version, no policy, a dataset that may not be exported', async () => {
    const world = await figures();
    expect(await request(world, 'CSV', LEADER, { metric_version_id: metric, dimensions: ['unit'], sql: 'select 1' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'query_spec.sql' } });
    expect(await request(world, 'CSV', LEADER, { metric_version_id: 'nope' })).toMatchObject({ status: 422, json: { detail: 'query_spec.metric_version_id' } });
    expect(await request(world, 'CSV', LEADER, spec(['unit', 'project']))).toMatchObject({ status: 422, json: { detail: 'query_spec.dimensions' } });
    expect(await request(world, 'CSV', LEADER, spec(['nope']))).toMatchObject({ status: 422, json: { detail: 'query_spec.dimensions' } });
    expect(await request(world, 'CSV', LEADER, spec([], { filters: [{ field: 'nope', operator: 'eq', value: 1 }] }))).toMatchObject({ status: 422, json: { detail: 'query_spec.filters[0]' } });
    expect(await request(world, 'CSV', LEADER, 'x' as never)).toMatchObject({ status: 400 });
    expect(await app.call('POST', '/bi/exports', { member: LEADER, body: { query_spec: spec(), as_of_period: '2099-01', format: 'CSV' } })).toMatchObject({ status: 422, json: { code: 'SNAPSHOT_NOT_FOUND' } });
    expect(await app.call('POST', '/bi/exports', { member: LEADER, body: { query_spec: spec(), as_of_period: '1999-12', snapshot_id: world.version, format: 'CSV' } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'as_of_period' } });
    expect(await app.call('POST', '/bi/exports', { member: LEADER, body: { query_spec: spec(), as_of_period: world.period, format: 'ODT' } })).toMatchObject({ status: 422 });
    expect(await request(world, 'CSV', NOBODY)).toMatchObject({ status: 403 });
    // No policy opens the dataset to the role: the refusal is a DENIED job.
    expect(await request(world, 'CSV', ANALYST_NONE)).toMatchObject({ status: 403 });
    // A metric that is not certified is not exported.
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [metric]);
    expect(await request(world, 'CSV')).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED' } });
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
    // A confidential dataset is exported only where a policy allows it; none says so yet.
    await owner("update machvon.bi_dataset set classification = 'CONFIDENTIAL' where id = $1", [DATASET]);
    expect(await request(world, 'CSV')).toMatchObject({ status: 403, json: { code: 'CLASSIFICATION_EXPORT_DENIED' } });
    await owner("update machvon.bi_dataset set classification = 'PERSONAL' where id = $1", [DATASET]);
    expect(await request(world, 'CSV')).toMatchObject({ status: 403, json: { code: 'CLASSIFICATION_EXPORT_DENIED' } });
    await owner("update machvon.bi_dataset set classification = 'INTERNAL' where id = $1", [DATASET]);
    expect((await request(world, 'CSV')).status).toBe(200);
    const kept = await owner<{ denied_reason: string }>("select denied_reason from machvon.bi_export_job where status = 'DENIED' and denied_reason in ('CLASSIFICATION_EXPORT_DENIED', 'ACCESS_POLICY_MISSING') order by created_at");
    expect(kept.map((row) => row.denied_reason)).toEqual(expect.arrayContaining(['CLASSIFICATION_EXPORT_DENIED', 'ACCESS_POLICY_MISSING']));
    expect((await audits('bi.export_denied')).map((row) => row.safe_diff.code)).toEqual(expect.arrayContaining(['CLASSIFICATION_EXPORT_DENIED', 'ACCESS_POLICY_MISSING']));
  });

  it('gives a file for seven days: after them the job is EXPIRED, the file is gone and the link is 422 EXPORT_EXPIRED', async () => {
    const world = await figures();
    const made = await request(world, 'CSV');
    const id = made.json.resource_id as string;
    const key = (await jobRow(id))?.file_object_key as string;
    const tenant = contextFor(TENANT_A, memberId(LEADER));
    await expect(app.objects.readStored(tenant, key)).resolves.toBeDefined();
    // Not yet: nothing is taken away before its time.
    expect(await app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => expireExports(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), new Date(), { files: app.objects }))).toEqual([]);
    const expired = await app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => expireExports(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), later(8), { files: app.objects }));
    expect(expired).toContain(id);
    expect((await jobRow(id))?.status).toBe('EXPIRED');
    await expect(app.objects.readStored(tenant, key)).rejects.toBeDefined();
    expect(await show(id)).toMatchObject({ status: 422, json: { code: 'EXPORT_EXPIRED' } });
    // Once, and a job that is READY with its days gone is told expired before the job has run.
    const second = await request(world, 'CSV');
    // The days are gone by the clock of the app, which began with the suite: a minute before the database's own now() would be after it when the suite has run for a while.
    await owner('update machvon.bi_export_job set expires_at = $2::timestamptz where id = $1', [second.json.resource_id as string, new Date(CLOCK.now.getTime() - 60_000).toISOString()]);
    expect(await show(second.json.resource_id as string)).toMatchObject({ status: 422, json: { code: 'EXPORT_EXPIRED' } });
    expect(await app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => expireExports(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), later(8), { files: app.objects }))).not.toContain(id);
  });

  it('makes a schedule with the checks of the contract: the cron, the recipients of the tenant, a certified metric, a dashboard the owner sees', async () => {
    const world = await figures();
    const base = { query_spec: spec(['unit'], { as_of_period: world.period }), cron: WEEKLY, format: 'XLSX', recipients: [memberId(LEADER)] };
    expect(await createSchedule(LEADER, { ...base, cron: '61 8 * * 1' })).toMatchObject({ status: 409, json: { code: 'CRON_INVALID', detail: 'minute' } });
    expect(await createSchedule(LEADER, { ...base, cron: 'every monday' })).toMatchObject({ status: 409, json: { code: 'CRON_INVALID' } });
    expect(await createSchedule(LEADER, { ...base, recipients: [memberId(LEADER), memberId(OUTSIDER)] })).toMatchObject({ status: 422, json: { code: 'RECIPIENT_OUT_OF_TENANT', detail: 'recipients' } });
    expect(await createSchedule(LEADER, { ...base, recipients: [randomUUID()] })).toMatchObject({ status: 422, json: { code: 'RECIPIENT_OUT_OF_TENANT' } });
    expect(await createSchedule(LEADER, { ...base, recipients: [] })).toMatchObject({ status: 422, json: { detail: 'recipients' } });
    expect(await createSchedule(LEADER, { ...base, query_spec: { metric_version_id: randomUUID() } })).toMatchObject({ status: 422, json: { detail: 'query_spec.metric_version_id' } });
    expect(await createSchedule(LEADER, { ...base, query_spec: { ...spec(), sql: 'x' } })).toMatchObject({ status: 422, json: { detail: 'query_spec.sql' } });
    expect(await createSchedule(LEADER, { ...base, dashboard_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'dashboard_id' } });
    expect(await createSchedule(LEADER, { ...base, format: 'ODT' })).toMatchObject({ status: 422 });
    expect(await createSchedule(NOBODY, base)).toMatchObject({ status: 403 });
    await owner("update machvon.metric_definition set status = 'DRAFT' where id = $1", [metric]);
    expect(await createSchedule(LEADER, base)).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED' } });
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
    const made = await createSchedule(LEADER, { ...base, recipients: [memberId(LEADER), memberId(LEADER)] });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    expect((await owner<{ recipients: string[]; timezone: string; owner_user_id: string; status: string }>('select recipients, timezone, owner_user_id, status from machvon.bi_export_schedule where id = $1', [id]))[0]).toEqual({ recipients: [memberId(LEADER)], timezone: 'Asia/Ho_Chi_Minh', owner_user_id: memberId(LEADER), status: 'ACTIVE' });
    expect((await events(id, 'bi.export_schedule.created.v1'))[0]?.payload).toMatchObject({ schedule_id: id, cron: WEEKLY, recipients: 1 });
    expect(await app.count("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'bi.export_schedule.create'", [id])).toBe(1);
    const mine = await app.call('GET', '/bi/export-schedules', { member: LEADER });
    expect((mine.json.items as Array<{ id: string }>).map((item) => item.id)).toContain(id);
    expect((await app.call('GET', '/bi/export-schedules', { member: STAFF })).json.items).toEqual([]);
    expect(await app.call('GET', '/bi/export-schedules?cursor=zzz', { member: LEADER })).toMatchObject({ status: 422 });
  });

  it('refuses a filter the query could never run, when the schedule or the export is made and not when it is run', async () => {
    const world = await figures();
    const base = { cron: WEEKLY, format: 'CSV', recipients: [memberId(LEADER)] };
    const filtered = (filter: Record<string, unknown>) => ({ metric_version_id: metric, dimensions: ['unit'], as_of_period: world.period, filters: [filter] });
    for (const filter of [
      { field: 'project', operator: 'in', value: 'invalid' },
      { field: 'project', operator: 'in', value: [] },
      { field: 'project', operator: 'eq', value: 'not-an-id' },
      { field: 'project', operator: 'gte', value: randomUUID() },
      { field: 'bucket', operator: 'eq', value: 5 },
      { field: 'bucket', operator: 'in', value: ['CURRENT_YEAR', ''] },
    ]) {
      expect(await createSchedule(LEADER, { ...base, query_spec: filtered(filter) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: `filters.${filter.field}` } });
      expect(await request(world, 'CSV', LEADER, filtered(filter))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    }
    const unit = unitId(UNIT_A);
    for (const filter of [
      { field: 'unit', operator: 'eq', value: unit.toUpperCase() },
      { field: 'unit', operator: 'in', value: [unit] },
      { field: 'bucket', operator: 'gte', value: 'CURRENT_YEAR' },
    ]) {
      expect((await createSchedule(LEADER, { ...base, query_spec: filtered(filter) })).status).toBe(200);
      expect((await request(world, 'CSV', LEADER, filtered(filter))).status).toBe(200);
    }
  });

  it('keeps a schedule going across a revision of its metric (it asks for the revision it was made with), and stops it when the metric is withdrawn', async () => {
    const world = await figures();
    const made = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: '0 8 * * *', format: 'CSV', recipients: [memberId(LEADER)] });
    await owner("update machvon.metric_definition set status = 'SUPERSEDED' where id = $1", [metric]);
    const ran = await runSchedules(later(2));
    expect((ran.find((run) => run.scheduleId === made.json.resource_id)?.jobs ?? []).map((job) => job.status)).toEqual(['READY']);
    // A request that someone makes now is for a certified revision.
    expect(await request(world, 'CSV')).toMatchObject({ status: 422, json: { code: 'METRIC_NOT_CERTIFIED' } });
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [metric]);
    const stopped = await runSchedules(later(4));
    expect((stopped.find((run) => run.scheduleId === made.json.resource_id)?.jobs ?? []).map((job) => [job.status, job.deniedReason])).toEqual([['FAILED', 'METRIC_NOT_CERTIFIED']]);
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
  });

  it('keeps going when one recipient fails: a LINK_ONLY schedule makes the same file and says the link is behind the sign-in, a retired metric ends the jobs as FAILED, and a schedule with nothing to read is skipped', async () => {
    const world = await figures();
    const link = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: '0 8 * * *', format: 'LINK_ONLY', recipients: [memberId(LEADER), memberId(ANALYST_NONE)] });
    expect(link.status).toBe(200);
    const ran = await runSchedules(later(2));
    const mine = (ran.find((run) => run.scheduleId === link.json.resource_id)?.jobs ?? []).sort((a, b) => a.status.localeCompare(b.status));
    expect(mine.map((job) => [job.status, job.format, job.deniedReason])).toEqual([
      ['DENIED', 'CSV', 'ACCESS_POLICY_MISSING'],
      ['READY', 'CSV', null],
    ]);
    const ready = mine.find((job) => job.status === 'READY');
    expect((await events(ready?.id as string, 'bi.export.ready.v1'))[0]?.payload).toMatchObject({ link_only: true });
    // The metric is withdrawn after the schedule was made: the jobs fail, the run goes on to the next recipient and the schedule keeps its run.
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [metric]);
    const failing = await runSchedules(later(4));
    const failed = failing.find((run) => run.scheduleId === link.json.resource_id)?.jobs ?? [];
    expect(failed.map((job) => [job.status, job.deniedReason])).toEqual([
      ['FAILED', 'METRIC_NOT_CERTIFIED'],
      ['FAILED', 'METRIC_NOT_CERTIFIED'],
    ]);
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
    // A schedule with no frozen version to read is skipped (and told on the audit trail), not failed.
    await app.seedReplica([["update machvon.bi_dataset_version set status = 'SUPERSEDED' where status = 'FROZEN'", []]]);
    const skipped = await runSchedules(later(6));
    expect(skipped.flatMap((run) => run.jobs)).toEqual([]);
    expect((await audits('bi.export_schedule_skipped')).length).toBeGreaterThan(0);
  });

  it('isolates the failure of one recipient: a failure of the platform ends their job as FAILED, a failure of the database undoes what was done for them, and the others still receive their file', async () => {
    const world = await figures();
    const made = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: '0 8 * * *', format: 'CSV', recipients: [memberId(LEADER), memberId(STAFF)] });
    expect(made.status).toBe(200);
    const failing = (error: unknown): ExportJobDeps['files'] => {
      let calls = 0;
      return {
        storeGenerated: (...input: Parameters<typeof app.objects.storeGenerated>) => (calls++ === 0 ? Promise.reject(error) : app.objects.storeGenerated(...input)),
        remove: (tenant, key) => app.objects.remove(tenant, key),
      };
    };
    // The renderer or the store fails for the first recipient: that job is FAILED, the other is READY, and the run is written.
    const first = await runSchedules(later(2), failing(new Error('disk full')));
    const jobs = first.find((run) => run.scheduleId === made.json.resource_id)?.jobs ?? [];
    expect(jobs.map((job) => [job.status, job.deniedReason]).sort()).toEqual([
      ['FAILED', 'EXPORT_FAILED'],
      ['READY', null],
    ]);
    expect(await app.count('select count(*)::text as n from machvon.bi_export_job where schedule_id = $1', [made.json.resource_id])).toBe(2);
    // The database fails for the first recipient (a SQLSTATE): what was done for them is rolled back to the savepoint, the other is made, and the skip is told.
    const second = await runSchedules(later(4), failing(Object.assign(new Error('boom'), { code: 'XX000' })));
    const again = second.find((run) => run.scheduleId === made.json.resource_id)?.jobs ?? [];
    expect(again.map((job) => job.status)).toEqual(['READY']);
    expect(await app.count('select count(*)::text as n from machvon.bi_export_job where schedule_id = $1', [made.json.resource_id])).toBe(3);
    expect((await audits('bi.export_schedule_skipped')).map((row) => row.safe_diff.code)).toContain('EXPORT_FAILED');
    expect(await owner<{ last_run_at: string | null }>('select last_run_at from machvon.bi_export_schedule where id = $1', [made.json.resource_id as string])).toEqual([{ last_run_at: expect.anything() }]);
  });

  it('still gives the file of a metric whose revision was replaced after it was made, and not one whose metric was withdrawn', async () => {
    const world = await figures();
    const made = await request(world, 'CSV');
    const id = made.json.resource_id as string;
    await owner("update machvon.metric_definition set status = 'SUPERSEDED' where id = $1", [metric]);
    expect((await show(id)).status).toBe(200);
    await owner("update machvon.metric_definition set status = 'RETIRED' where id = $1", [metric]);
    expect(await show(id)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
    expect((await show(id)).status).toBe(200);
  });

  it('cuts an export to the projects the person may query and may export, both: a right to export over one unit does not export what the right to query reaches elsewhere', async () => {
    const world = await figures();
    await app.harness.seedMembership(TENANT_A, 31, 1);
    await app.harness.seedRole(TENANT_A, 16, 'BI_QUERY_ONLY', ['bi.query'], 30);
    await app.harness.seedRole(TENANT_A, 17, 'BI_EXPORT_ONE_UNIT', ['bi.export'], 30);
    await app.harness.seedGrants(TENANT_A, [
      { n: 51, member: 31, role: 16, kind: 'TENANT' },
      { n: 52, member: 31, role: 17, kind: 'UNIT_SUBTREE', refs: [unitId(UNIT_A)] },
    ]);
    await app.seedReplica([
      [
        "insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by) values ($1, $2, $3, 1, 'ROLE', $4, '{\"op\":\"unit_in_scope\"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)",
        [TENANT_A, randomUUID(), DATASET, roleId(16), memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
    const made = await request(world, 'CSV', 31);
    expect(made.status).toBe(200);
    const job = await jobRow(made.json.resource_id as string);
    const text = Buffer.from((await app.objects.readStored(contextFor(TENANT_A, memberId(31)), job?.file_object_key as string)).bytes).toString('utf8');
    // Over the whole tenant they may query 13 billion; they may export the one unit's 4 billion.
    expect(text).toContain(',Tổng,4000000000,,,');
    expect(text).not.toContain('13000000000');
    expect(text).not.toContain(unitId(UNIT_OUT));
    expect(job?.scope_description).toBe('Theo phạm vi được cấp của người nhận');
    expect((await show(made.json.resource_id as string, 31)).status).toBe(200);
    // The scope they export under is part of what the file is given under: the right to export over the unit ends, and the file is not given.
    await app.seedReplica([["update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1 and role_id = $2", [memberId(31), roleId(17)]]]);
    await bumpScope(31);
    expect(await show(made.json.resource_id as string, 31)).toMatchObject({ status: 403 });
  });

  it('removes the file made for a recipient whose job is rolled back, and does not count the job', async () => {
    const world = await figures();
    const made = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: '0 8 * * *', format: 'CSV', recipients: [memberId(LEADER)] });
    const kept = async () => (await app.objects.listKind(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), 'bi_export')).length;
    const before = await kept();
    // The audit of the job fails with a failure of the database after the file was stored: the savepoint is rolled back, so the job is gone, and the file must not stay.
    let audits = 0;
    const failing = { recordInTx: () => (audits++ === 0 ? Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' })) : Promise.resolve()) } as unknown as AuditWriter;
    const ran = await app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => runExportSchedules(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), later(2), { files: app.objects, audit: failing }));
    expect(ran.find((run) => run.scheduleId === made.json.resource_id)?.jobs).toEqual([]);
    expect(await app.count('select count(*)::text as n from machvon.bi_export_job where schedule_id = $1', [made.json.resource_id])).toBe(0);
    expect(await kept()).toBe(before);
  });

  it('removes every file of a run whose transaction is undone, whatever recipient it was made for', async () => {
    const world = await figures();
    const made = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: '0 8 * * *', format: 'CSV', recipients: [memberId(LEADER), memberId(STAFF)] });
    expect(made.status).toBe(200);
    const tenant = contextFor(TENANT_A, WORKER_MEMBERSHIP_ID);
    const kept = async () => (await app.objects.listKind(tenant, 'bi_export')).length;
    const before = await kept();
    // The first recipient is made and told; the second meets a failure that is not the database's and not the domain's, so it goes out of the run and the whole transaction is undone.
    let told = 0;
    const audit = { recordInTx: () => (told++ === 1 ? Promise.reject(new Error('audit down')) : Promise.resolve()) } as unknown as AuditWriter;
    await expect(runExportSchedulesIn(app.harness.tenants, tenant, later(2), { files: app.objects, audit })).rejects.toThrow('audit down');
    expect(await app.count('select count(*)::text as n from machvon.bi_export_job where schedule_id = $1', [made.json.resource_id])).toBe(0);
    expect(await kept()).toBe(before);
    // A run that goes through keeps what it made.
    const ran = await runExportSchedulesIn(app.harness.tenants, tenant, later(2), { files: app.objects, audit: new AuditWriter(app.harness.tenants) });
    expect(ran.find((run) => run.scheduleId === made.json.resource_id)?.jobs.filter((job) => job.status === 'READY')).toHaveLength(2);
    expect(await kept()).toBe(before + 2);
  });

  it('takes the files whose days are over a batch at a time until none is left, not the first batch only', async () => {
    const world = await figures();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push((await request(world, 'CSV', LEADER, spec([]))).json.resource_id as string);
    const horizon = later(8);
    const expired = await app.harness.tenants.withTenant(contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), (tx) => expireExports(tx, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), horizon, { files: app.objects, batchSize: 2 }));
    for (const id of ids) expect(expired).toContain(id);
    expect(await app.count("select count(*)::text as n from machvon.bi_export_job where status = 'READY' and expires_at <= $1::timestamptz", [horizon.toISOString()])).toBe(0);
  });

  it('removes the file of an export whose command does not commit: the job is gone, and the file goes with it', async () => {
    const world = await figures();
    const controller = new BiExportController(app.harness.tenants, app.objects);
    const tenant = contextFor(TENANT_A, memberId(LEADER));
    const undo: Array<() => void | Promise<void>> = [];
    await expect(
      app.harness.tenants.withTenant(tenant, async (tx) => {
        const access = await loadAccessIn(tx, memberId(LEADER));
        const scope = { tx, tenant, requestId: 'r', correlationId: 'c', expectedVersion: null, audit: () => Promise.reject(new Error('audit down')), emit: () => Promise.resolve({ id: 'e', duplicate: false }), afterCommit: () => undefined, afterRollback: (callback: () => void | Promise<void>) => undo.push(callback), refuseAfterCommit: () => undefined } as unknown as CommandScope;
        await controller.request(scope, access, { query_spec: spec(), as_of_period: world.period, format: 'CSV' } as never);
      }),
    ).rejects.toThrow('audit down');
    expect(undo).toHaveLength(1);
    const kept = async () => (await app.objects.listKind(tenant, 'bi_export')).length;
    const before = await kept();
    for (const callback of undo) await callback();
    expect(await kept()).toBe(before - 1);
  });

  it('keeps the jobs and the schedules as they were made, in the database: who, what and the scope never change, a job moves forward only, the file is written once, nothing is deleted', async () => {
    const world = await figures();
    const made = await request(world, 'CSV');
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    await expect(sqlAs(LEADER, 'update machvon.bi_export_job set subject_user_id = $2::uuid where id = $1', [id, memberId(STAFF)])).rejects.toThrow(/never changes/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_job set scope_description = 'x' where id = $1", [id])).rejects.toThrow(/never changes/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_job set query_spec = '{}'::jsonb where id = $1", [id])).rejects.toThrow(/never changes/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_job set file_sha256 = repeat('a', 64) where id = $1", [id])).rejects.toThrow(/written once/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_job set status = 'QUEUED' where id = $1", [id])).rejects.toThrow(/cannot move from READY to QUEUED/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_job set status = 'DENIED' where id = $1", [id])).rejects.toThrow(/cannot move from READY to DENIED/);
    await expect(sqlAs(LEADER, 'delete from machvon.bi_export_job where id = $1', [id])).rejects.toThrow(/permission denied|never deleted/);
    await expect(sqlAs(LEADER, 'truncate machvon.bi_export_job', [])).rejects.toThrow(/permission denied/);
    const insert = (status: string, extra: string, rowCount: number | null = null, cap = 100000) =>
      owner(
        `insert into machvon.bi_export_job (tenant_id, id, requested_by, subject_user_id, query_spec, as_of_period, dataset_version_id, scope_hash, scope_description, format, row_count, row_cap, status, denied_reason, expires_at, file_object_key, file_sha256, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $1::uuid, '{}'::jsonb, 'p', $2::uuid, repeat('a', 64), 's', 'CSV', $3, $4, $5, ${extra}, $1::uuid, $1::uuid)`,
        [memberId(LEADER), world.version, rowCount, cap, status],
      );
    await expect(insert('READY', "null, null, 'k', repeat('a', 64)")).rejects.toThrow(/bi_export_job_expiry_chk/);
    await expect(insert('DENIED', "'why', null, 'k', null")).rejects.toThrow(/bi_export_job_refused_chk/);
    await expect(insert('DENIED', 'null, null, null, null')).rejects.toThrow(/bi_export_job_denied_chk/);
    await expect(insert('READY', "null, now(), 'k', repeat('a', 64)", 100_001)).rejects.toThrow(/bi_export_job_rows_chk/);
    await expect(insert('QUEUED', 'null, null, null, null', 5, 0)).rejects.toThrow(/bi_export_job_rows_chk/);
    // The schedules: what they ask and who receives never change, the last run only moves forward, retired is final.
    const schedule = await createSchedule(LEADER, { query_spec: spec(['unit'], { as_of_period: world.period }), cron: WEEKLY, format: 'CSV', recipients: [memberId(LEADER)] });
    const sid = schedule.json.resource_id as string;
    await expect(sqlAs(LEADER, "update machvon.bi_export_schedule set cron = '0 9 * * 1' where id = $1", [sid])).rejects.toThrow(/never change/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_schedule set recipients = '[]'::jsonb where id = $1", [sid])).rejects.toThrow(/never change/);
    await expect(sqlAs(LEADER, 'update machvon.bi_export_schedule set last_run_at = now() where id = $1', [sid])).resolves.toBeDefined();
    await expect(sqlAs(LEADER, "update machvon.bi_export_schedule set last_run_at = now() - interval '1 day' where id = $1", [sid])).rejects.toThrow(/only moves forward/);
    await expect(sqlAs(LEADER, "update machvon.bi_export_schedule set status = 'RETIRED' where id = $1", [sid])).resolves.toBeDefined();
    await expect(sqlAs(LEADER, "update machvon.bi_export_schedule set status = 'ACTIVE' where id = $1", [sid])).rejects.toThrow(/final/);
    await expect(sqlAs(LEADER, 'delete from machvon.bi_export_schedule where id = $1', [sid])).rejects.toThrow(/permission denied|never deleted/);
    const privileges = await owner<{ job: boolean; schedule: boolean }>("select has_table_privilege('machvon_app', 'machvon.bi_export_job', 'DELETE') as job, has_table_privilege('machvon_app', 'machvon.bi_export_schedule', 'DELETE') as schedule");
    expect(privileges[0]).toEqual({ job: false, schedule: false });
  });
});
