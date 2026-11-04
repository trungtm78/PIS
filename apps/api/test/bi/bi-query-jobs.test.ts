import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AuditWriter, BiQueryJobStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { expireQueryAnswers, runQueryJobs, runQueryJobsIn } from '../../src/modules/bi/query-jobs';
import {
  ANALYST_ALL,
  ANALYST_BRANCH,
  BUILDER,
  BiApp,
  CLOCK,
  DASH_MAKER,
  DATASET,
  LINEAGE_ALL,
  LINEAGE_NO_METRICS,
  LINEAGE_NO_PROJECTS,
  LINEAGE_UNIT,
  LOG_ADMIN,
  LOG_SCOPED,
  NOBODY,
  PIPELINE,
  TENANT_A,
  TENANT_B,
  UNIT_A,
  UNIT_OUT,
  contextFor,
  memberId,
  unitId,
} from './bi-app';
import type { Reply } from './bi-app';
import { asNumber } from '../support/json';

jest.setTimeout(300_000);

/** What a query may cost and still be answered in the request: the snapshots of these tests are small, so a few lines are heavy. */
const COST_LIMIT = 50;
const app = new BiApp();
let sequence = 0;
const BILLION = 1_000_000_000;
const OUTSIDER = 30; // a member of tenant B only
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const events = (id: string, type: string) =>
  owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const audits = (action: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]);
const runRow = async (id: string) =>
  (
    await owner<{
      status: string;
      mode: string;
      error_code: string | null;
      duration_ms: number | null;
      row_count: number | null;
      estimated_cost: string | null;
      served_from_cache: boolean;
      result: unknown;
      requested_by: string;
      query_spec: Record<string, unknown> | null;
      finished_at: string | null;
    }>('select status, mode, error_code, duration_ms, row_count, estimated_cost::text, served_from_cache, result, requested_by, query_spec, finished_at from machvon.bi_query_run where id = $1', [id])
  )[0];
const WORKER = contextFor(TENANT_A, WORKER_MEMBERSHIP_ID);
/** The pass of the worker over the tenant, as the job calls it. */
const runJobs = (deps: Parameters<typeof runQueryJobsIn>[3] = {}, now = new Date(CLOCK.now)) =>
  runQueryJobsIn(app.harness.tenants, WORKER, now, { audit: new AuditWriter(app.harness.tenants), syncCostLimit: COST_LIMIT, ...deps });

interface World {
  version: string;
  period: string;
  snapshot: string;
  projects: string[];
}
let metric = '';
let probe = '';
let lonely = '';

/** A frozen close snapshot with `projects` lines (one project of unit A for each, and one of the unit outside the branch) and the version of the dataset built over it. */
async function figures(options: { projects?: number } = {}): Promise<World> {
  sequence += 1;
  const periodId = randomUUID();
  const snapshot = randomUUID();
  const code = `2034-${String(sequence).padStart(2, '0')}`;
  const count = options.projects ?? 2;
  const ids = Array.from({ length: count }, () => randomUUID());
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2034-01-01' + $6::int * 40, date '2034-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2034, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, sequence],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2034-10-31', date '2034-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
      [TENANT_A, snapshot, periodId, count, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
    ],
  ];
  // The last project is of the unit outside the branch: the people who read one unit only never see it.
  ids.forEach((project, index) => {
    const unit = index === count - 1 ? UNIT_OUT : UNIT_A;
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, project, `Q${sequence}-${index}`, unitId(unit), randomUUID()],
    ]);
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, null, 'CURRENT_YEAR', 'CENTRAL', 10, 0, 10, $5::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, snapshot, project, unitId(unit), BILLION],
    ]);
  });
  await app.seedReplica(statements);
  const built = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: code } });
  expect(built.status).toBe(202);
  return { version: built.json.resource_id as string, period: code, snapshot, projects: ids };
}

const ask = (world: World, dimensions: string[], member = ANALYST_ALL, key?: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
  app.call('POST', '/dashboard-queries', { member, body: { metric_version_id: metric, snapshot_id: world.version, dimensions, filters: [], ...extra }, ...(key === undefined ? {} : { key }) });
const lineage = (member: number, id: string, query = ''): Promise<Reply> => app.call('GET', `/bi/metric-definitions/${id}/lineage${query}`, { member });
const log = (member: number, query = ''): Promise<Reply> => app.call('GET', `/bi/query-runs${query}`, { member });

async function bumpScope(member: number): Promise<void> {
  const rows = await app.harness.owner<{ scope_version: string }>(TENANT_A, [
    ['update machvon.membership set scope_version = scope_version + 1 where id = $1 returning scope_version::text', [memberId(member)]],
  ]);
  app.scopeVersions.set(member, Number(rows[0]?.scope_version));
}

describe('the log of the queries, the jobs the heavy ones become and the lineage of a metric (ST-BI-009, BI 3 F3 and F5, BI-13, BI-14)', () => {
  beforeAll(async () => {
    await app.start({ costLimit: COST_LIMIT });
    await app.harness.seedMembership(TENANT_B, OUTSIDER, 1);
    // One sync gives the registry all its metrics (a sync replaces the registry of the platform: a metric left out of it is retired). `lineage_probe` is read by the lineage tests alone, so its graph is the one of one version.
    const metricOf = (code: string) => ({
      code,
      grain: 'project',
      aggregation_type: 'additive',
      expression: { op: 'sum', args: [{ op: 'field', name: 'GIAI_NGAN' }] },
      unit: 'VND',
      effective_from: '2026-01-01',
    });
    const bundle = await app.bundle([metricOf('disbursed_log'), metricOf('lineage_probe'), metricOf('never_read')]);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'logsync1', bundle_object_key: bundle.key, bundle_sha256: bundle.sha256 } })).status).toBe(
      200,
    );
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    const idOf = (code: string) => (listed.json.items as Array<{ id: string; code: string }>).find((item) => item.code === code)?.id as string;
    metric = idOf('disbursed_log');
    probe = idOf('lineage_probe');
    lonely = idOf('never_read');
    // A policy opens the dataset to the roles that read the lineage and to those that query: no policy, no node of a dataset version.
    await app.seedReplica([
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         select $1, gen_random_uuid(), $2, 1, 'ROLE', r.id, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $3, $4, $3 from machvon.role_definition r where r.code in ('BI_ANALYST_QUERY', 'BI_LINEAGE', 'BI_LINEAGE_NO_PROJECTS')`,
        [TENANT_A, DATASET, memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);

  describe('a query that is not heavy', () => {
    it('is answered in the request and is one line of the log: SYNC, COMPLETED, how long it took and not what it answered', async () => {
      const world = await figures();
      const reply = await ask(world, ['unit']);
      expect(reply.status).toBe(200);
      const run = (await owner<{ id: string }>("select id from machvon.bi_query_run where dataset_version_id = $1 and mode = 'SYNC'", [world.version]))[0];
      expect(await runRow(run?.id as string)).toMatchObject({ status: 'COMPLETED', mode: 'SYNC', served_from_cache: false, row_count: 2, estimated_cost: null, result: null });
    });
  });

  describe('a query too heavy to wait for', () => {
    it('is answered 202 ASYNC_JOB and is a QUEUED run of the log, with what was asked and what it costs', async () => {
      const world = await figures({ projects: 30 });
      const reply = await ask(world, ['project']);
      expect(reply.status).toBe(202);
      expect(reply.json).toMatchObject({ status: 'ASYNC_JOB', mode: 'ASYNC_JOB', estimated_cost: 240, as_of_period: world.period, snapshot_id: world.version });
      const run = await runRow(reply.json.run_id as string);
      expect(run).toMatchObject({ status: 'QUEUED', mode: 'ASYNC_JOB', estimated_cost: '240', result: null, requested_by: memberId(ANALYST_ALL) });
      expect(run?.query_spec).toEqual({ metric_version_id: metric, snapshot_id: world.version, dimension: 'project', filters: [], pinned: false });
      expect((await audits('bi.query_queued')).some((audit) => audit.safe_diff.estimated_cost === 240 && audit.safe_diff.new_job === true)).toBe(true);
    });

    it('is not a job when the same snapshot is read without a dimension: the cost is the lines read once', async () => {
      const world = await figures({ projects: 30 });
      expect((await ask(world, [])).status).toBe(200);
      expect((await ask(world, ['project'])).status).toBe(202);
    });

    it('is one job for the same question of the same reader, whatever the number of requests, and another for another reader', async () => {
      const world = await figures({ projects: 30 });
      const first = await ask(world, ['project']);
      const again = await ask(world, ['project']);
      expect([first.status, again.status]).toEqual([202, 202]);
      expect(again.json.run_id).toBe(first.json.run_id);
      expect(await app.count("select count(*) as n from machvon.bi_query_run where dataset_version_id = $1 and mode = 'ASYNC_JOB'", [world.version])).toBe(1);
      const other = await ask(world, ['project'], ANALYST_BRANCH);
      expect(other.status).toBe(202);
      expect(other.json.run_id).not.toBe(first.json.run_id);
    });

    it('is one job when the same question comes from two requests at the same time (the unique index, not the check before it)', async () => {
      const world = await figures({ projects: 30 });
      const [one, two] = await Promise.all([ask(world, ['project']), ask(world, ['project'])]);
      expect([one.status, two.status]).toEqual([202, 202]);
      expect(one.json.run_id).toBe(two.json.run_id);
      expect(await app.count("select count(*) as n from machvon.bi_query_run where dataset_version_id = $1 and mode = 'ASYNC_JOB'", [world.version])).toBe(1);
    });

    it('is answered 202 again, with the same body, for the same idempotency key', async () => {
      const world = await figures({ projects: 30 });
      const first = await ask(world, ['project'], ANALYST_ALL, 'heavy-key-0000001');
      const replay = await ask(world, ['project'], ANALYST_ALL, 'heavy-key-0000001');
      expect(replay.status).toBe(202);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(replay.json).toEqual(first.json);
    });

    it('is run by the worker for the person who asked: COMPLETED with its duration and rows, the answer kept, the reader told', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      expect(await runJobs()).toBeGreaterThanOrEqual(1);
      const done = await runRow(id);
      expect(done).toMatchObject({ status: 'COMPLETED', error_code: null, row_count: 30, served_from_cache: false });
      expect(done?.duration_ms).toBeGreaterThanOrEqual(0);
      expect(done?.finished_at).not.toBeNull();
      expect((done?.result as { rows: unknown[] }).rows).toHaveLength(30);
      expect((await events(id, 'bi.query.completed.v1'))[0]?.payload).toMatchObject({ requested_by: memberId(ANALYST_ALL), status: 'COMPLETED', code: null });
      expect((await audits('bi.query_job_completed')).some((audit) => audit.safe_diff.rows === 30)).toBe(true);
    });

    it('is answered from what the job kept when it is asked again: 200, served from the cache, the same figures as asked in the request', async () => {
      const world = await figures({ projects: 30 });
      const sync = await ask(world, []);
      expect(sync.status).toBe(200);
      const queued = await ask(world, ['project']);
      await runJobs();
      const answered = await ask(world, ['project']);
      expect(answered.status).toBe(200);
      expect(answered.json).toMatchObject({ served_from_cache: true });
      const rows = answered.json.children as unknown[];
      expect(rows).toHaveLength(30);
      // The figures are what the snapshot says: one billion for each project, and the total is thirty billion.
      expect(JSON.stringify(answered.json)).toContain('30000000000');
      // The job is not run twice for a question that has its answer, and the answer is the job's own.
      expect(await app.count("select count(*) as n from machvon.bi_query_run where dataset_version_id = $1 and mode = 'ASYNC_JOB'", [world.version])).toBe(1);
      expect((await runRow(queued.json.run_id as string))?.status).toBe('COMPLETED');
    });

    it('is not answered to another reader from what a job kept for someone else (the scope is part of the key)', async () => {
      const world = await figures({ projects: 30 });
      await ask(world, ['project']);
      await runJobs();
      const other = await ask(world, ['project'], ANALYST_BRANCH);
      expect(other.status).toBe(202);
    });

    it('is not answered from what a job kept before a policy was tightened: the key has the predicates of the policies that apply, so the same question under the new policy is a job of its own', async () => {
      const world = await figures({ projects: 30 });
      expect((await ask(world, ['project'])).status).toBe(202);
      await runJobs();
      expect((await ask(world, ['project'])).status).toBe(200);
      const policy = (
        await owner<{ id: string; row_predicate_ast: unknown }>(
          "select p.id, p.row_predicate_ast from machvon.bi_access_policy p join machvon.role_definition r on r.id = p.grantee_ref_id where r.code = 'BI_ANALYST_QUERY' and p.dataset_id = $1",
          [DATASET],
        )
      )[0];
      try {
        // The administrator narrows the rows the role sees (the data owner is exempt from the guard, as the policy store is when it replaces a revision).
        await owner('update machvon.bi_access_policy set row_predicate_ast = \'{"op":"ne","field":"unit","value":"00000000-0000-4000-8000-0000000000ff"}\'::jsonb where id = $1', [policy?.id]);
        const again = await ask(world, ['project']);
        expect(again.status).toBe(202);
      } finally {
        await owner('update machvon.bi_access_policy set row_predicate_ast = $2::jsonb where id = $1', [policy?.id, JSON.stringify(policy?.row_predicate_ast)]);
      }
    });

    it('answers 202 at once to a person who asks again while a worker is on the job: the poll does not wait for the transaction of the worker', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      // A worker that took the job and has not ended its transaction.
      const worker = new Client({ connectionString: app.harness.database.adminUrl });
      await worker.connect();
      try {
        await worker.query('begin');
        await worker.query("update machvon.bi_query_run set status = 'RUNNING', started_at = now() where id = $1", [id]);
        const waited = await Promise.race([ask(world, ['project']), new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 8000))]);
        expect(waited).not.toBe('blocked');
        expect((waited as Reply).status).toBe(202);
        expect((waited as Reply).json.run_id).toBe(id);
      } finally {
        await worker.query('rollback');
        await worker.end();
      }
      expect(await app.count("select count(*) as n from machvon.bi_query_run where dataset_version_id = $1 and mode = 'ASYNC_JOB'", [world.version])).toBe(1);
    });

    it('makes no job for a question whose job ended a moment ago and whose answer is kept: the store tells there is nothing to queue', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      await runJobs();
      const done = (
        await owner<{ cache_key: string; requested_by: string; scope_hash: string; dataset_version_id: string }>(
          'select cache_key, requested_by, scope_hash, dataset_version_id from machvon.bi_query_run where id = $1',
          [queued.json.run_id],
        )
      )[0];
      const made = await app.harness.tenants.withTenant(WORKER, (tx) =>
        new BiQueryJobStore().enqueue(
          tx,
          {
            requestedBy: done?.requested_by as string,
            metricVersionIds: [metric],
            asOfPeriod: world.period,
            datasetVersionId: done?.dataset_version_id as string,
            scopeHash: done?.scope_hash as string,
            cacheKey: done?.cache_key as string,
            spec: { x: 1 },
            estimatedCost: 1,
          },
          new Date(CLOCK.now),
        ),
      );
      expect(made).toBeUndefined();
      expect(await app.count('select count(*) as n from machvon.bi_query_run where cache_key = $1', [done?.cache_key])).toBe(1);
    });

    it('ends each job in a transaction of its own: a failure after the first job has ended undoes the second alone, and the first stays COMPLETED for whoever waits for it', async () => {
      // The jobs that earlier tests left waiting are run first (a pass takes a batch at a time), so the two of this test are the only ones in the queue.
      while ((await runJobs()) > 0);
      const world = await figures({ projects: 30 });
      const first = await ask(world, ['project']);
      const second = await ask(world, ['project'], ANALYST_BRANCH);
      const real = new AuditWriter(app.harness.tenants);
      let calls = 0;
      const audit = {
        recordInTx: (...input: Parameters<AuditWriter['recordInTx']>) => {
          calls += 1;
          if (calls === 2) throw new Error('the audit trail is down');
          return real.recordInTx(...input);
        },
      } as unknown as AuditWriter;
      await expect(runJobs({ audit })).rejects.toThrow('the audit trail is down');
      expect((await runRow(first.json.run_id as string))?.status).toBe('COMPLETED');
      expect(await runRow(second.json.run_id as string)).toMatchObject({ status: 'QUEUED', result: null, duration_ms: null });
      // The job that was undone is taken again by the next pass.
      await runJobs();
      expect((await runRow(second.json.run_id as string))?.status).toBe('COMPLETED');
    });

    it('judges a job at the time it runs and keeps its answer from the time it ended, not from the time the pass began', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      while ((await runJobs()) > 0);
      // A job that was queued and ran in the same pass as others: the pass began long before this one began and ended.
      const again = await figures({ projects: 30 });
      const slow = await ask(again, ['project']);
      const base = new Date(CLOCK.now);
      const minutes = (count: number) => new Date(base.getTime() + count * 60_000);
      const times = [minutes(0), minutes(10), minutes(30)];
      let at = 0;
      await runJobs({ clock: () => times[Math.min(at++, times.length - 1)] as Date }, minutes(-120));
      const row = (
        await owner<{ started_at: string; finished_at: string; result_expires_at: string }>('select started_at, finished_at, result_expires_at from machvon.bi_query_run where id = $1', [
          slow.json.run_id,
        ])
      )[0];
      expect(new Date(row?.started_at as string).getTime()).toBe(minutes(0).getTime());
      expect(new Date(row?.finished_at as string).getTime()).toBe(minutes(30).getTime());
      expect(new Date(row?.result_expires_at as string).getTime()).toBe(minutes(30 + 60).getTime());
      expect((await runRow(queued.json.run_id as string))?.status).toBe('COMPLETED');
    });

    it('is DENIED by the worker when the person lost the right after asking: no answer is made and nothing of the old scope is kept', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project'], ANALYST_BRANCH);
      expect(queued.status).toBe(202);
      await app.seedReplica([["update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1", [memberId(ANALYST_BRANCH)]]]);
      await bumpScope(ANALYST_BRANCH);
      await runJobs();
      expect(await runRow(queued.json.run_id as string)).toMatchObject({ status: 'DENIED', error_code: 'SCOPE_DENIED', result: null, row_count: null });
      expect((await events(queued.json.run_id as string, 'bi.query.refused.v1'))[0]?.payload).toMatchObject({ status: 'DENIED', code: 'SCOPE_DENIED' });
      await app.seedReplica([["update machvon.role_grant set status = 'Active', revoked_at = null where membership_id = $1", [memberId(ANALYST_BRANCH)]]]);
      await bumpScope(ANALYST_BRANCH);
    });

    it('is DENIED with SCOPE_CHANGED when the scope moved after the question and the right is still held: the answer would be of another scope than the one asked under', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project'], ANALYST_ALL);
      await bumpScope(ANALYST_ALL);
      await runJobs();
      expect(await runRow(queued.json.run_id as string)).toMatchObject({ status: 'DENIED', error_code: 'SCOPE_CHANGED', result: null });
      // Asked again under the new scope, it is a job of its own and it is answered.
      const again = await ask(world, ['project'], ANALYST_ALL);
      expect(again.status).toBe(202);
      expect(again.json.run_id).not.toBe(queued.json.run_id);
      await runJobs();
      expect((await ask(world, ['project'], ANALYST_ALL)).status).toBe(200);
    });

    it('ends FAILED, with the reason, when what was kept cannot be run (the job is the record and the others still run)', async () => {
      const world = await figures({ projects: 30 });
      const broken = await ask(world, ['project']);
      const fine = await ask(world, ['project'], ANALYST_BRANCH);
      await owner('update machvon.bi_query_run set query_spec = jsonb_set(query_spec, \'{filters}\', \'[{"field":"no_such_field","operator":"eq","value":"x"}]\'::jsonb) where id = $1', [
        broken.json.run_id,
      ]);
      await runJobs();
      expect(await runRow(broken.json.run_id as string)).toMatchObject({ status: 'FAILED', error_code: 'DIMENSION_NOT_IN_DATASET', result: null });
      expect((await runRow(fine.json.run_id as string))?.status).toBe('COMPLETED');
      expect((await events(broken.json.run_id as string, 'bi.query.refused.v1'))[0]?.payload).toMatchObject({ status: 'FAILED' });
    });

    it('ends TIMEOUT when the database stops it', async () => {
      const world = await figures({ projects: 30 });
      const slow = await ask(world, ['project']);
      // Another transaction holds the write lock of the lineage of the tenant: the job waits for it and the database stops the statement.
      const holder = new Client({ connectionString: app.harness.database.adminUrl });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query("select pg_advisory_xact_lock(hashtextextended('lineage:' || $1::text, 0))", [TENANT_A]);
        await runJobs({ timeoutMs: 300 });
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
      expect(await runRow(slow.json.run_id as string)).toMatchObject({ status: 'TIMEOUT', error_code: 'QUERY_TIMEOUT', result: null });
      expect((await events(slow.json.run_id as string, 'bi.query.refused.v1'))[0]?.payload).toMatchObject({ status: 'TIMEOUT', code: 'QUERY_TIMEOUT' });
    });

    it('takes the answers away after their hour and keeps the runs in the log; the same question then makes a new job', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      await runJobs();
      const id = queued.json.run_id as string;
      expect((await runRow(id))?.result).not.toBeNull();
      const taken = await app.harness.tenants.withTenant(WORKER, (tx) => expireQueryAnswers(tx, new Date(CLOCK.now.getTime() + 2 * 3600 * 1000), { batchSize: 1 }));
      expect(taken).toBeGreaterThanOrEqual(1);
      expect(await runRow(id)).toMatchObject({ status: 'COMPLETED', result: null, row_count: 30 });
      const again = await ask(world, ['project']);
      expect(again.status).toBe(202);
      expect(again.json.run_id).not.toBe(id);
    });

    it('is not read as an answer once its hour has gone, even before the job that takes it away has run', async () => {
      const world = await figures({ projects: 30 });
      await ask(world, ['project']);
      await runJobs();
      const before = CLOCK.now;
      try {
        CLOCK.now = new Date(before.getTime() + 2 * 3600 * 1000);
        expect((await ask(world, ['project'])).status).toBe(202);
      } finally {
        CLOCK.now = before;
      }
    });

    it('passes by a job that another pass holds, and runs it when that pass has ended', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      // A pass that holds the job (a transaction that took it and has not ended) is passed by.
      const holder = new Client({ connectionString: app.harness.database.adminUrl });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from machvon.bi_query_run where id = $1 for update', [id]);
        await runJobs();
        expect((await runRow(id))?.status).toBe('QUEUED');
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
      await runJobs();
      expect((await runRow(id))?.status).toBe('COMPLETED');
    });
  });

  describe('a query that continues a drill whose metric was replaced', () => {
    it('is a job that reads the revision the drill was begun with, as the query in the request does (the job is pinned like the question)', async () => {
      const world = await figures({ projects: 30 });
      const first = await ask(world, []);
      expect(first.status).toBe(200);
      const token = first.json.drill_token as string;
      try {
        // A newer revision replaced the metric the drill was begun with.
        await owner("update machvon.metric_definition set status = 'SUPERSEDED' where id = $1", [metric]);
        const heavy = await ask(world, ['project'], ANALYST_ALL, undefined, { context_token: token });
        expect(heavy.status).toBe(202);
        expect((await runRow(heavy.json.run_id as string))?.query_spec).toMatchObject({ pinned: true });
        await runJobs();
        expect(await runRow(heavy.json.run_id as string)).toMatchObject({ status: 'COMPLETED', error_code: null, row_count: 30 });
        // A question that does not continue a drill is not pinned, and a replaced metric is not read.
        expect((await ask(world, ['project'])).status).toBe(422);
      } finally {
        await owner("update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metric]);
      }
    });
  });

  describe('the run of a person, which a screen asks while it waits', () => {
    const run = (member: number, id: string, tenantId?: string) => app.call('GET', `/bi/query-runs/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

    it('tells how the job stands, then how it ended, and nothing of the figures', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      expect(await run(ANALYST_ALL, id)).toMatchObject({ status: 200, json: { id, mode: 'ASYNC_JOB', status: 'QUEUED', row_count: null, error_code: null, estimated_cost: 240 } });
      await runJobs();
      const done = await run(ANALYST_ALL, id);
      expect(done.json).toMatchObject({ status: 'COMPLETED', row_count: 30, error_code: null });
      expect(typeof done.json.duration_ms).toBe('number');
      expect(JSON.stringify(done.json)).not.toContain('1000000000');
    });

    it('tells why a job failed, so a screen does not ask the same question again and again', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      await owner('update machvon.bi_query_run set query_spec = jsonb_set(query_spec, \'{filters}\', \'[{"field":"no_such_field","operator":"eq","value":"x"}]\'::jsonb) where id = $1', [
        queued.json.run_id,
      ]);
      await runJobs();
      expect((await run(ANALYST_ALL, queued.json.run_id as string)).json).toMatchObject({ status: 'FAILED', error_code: 'DIMENSION_NOT_IN_DATASET' });
    });

    it('is the person’s own: the run of another is as good as none, and so is one that is not there or of another tenant', async () => {
      const world = await figures({ projects: 30 });
      const id = (await ask(world, ['project'])).json.run_id as string;
      expect((await run(ANALYST_BRANCH, id)).status).toBe(404);
      expect((await run(ANALYST_ALL, randomUUID())).status).toBe(404);
      expect((await run(NOBODY, id)).status).toBe(403);
      expect((await run(BUILDER, id, TENANT_B)).status).toBe(404);
    });
  });

  describe('the log of the database', () => {
    it('is never deleted, and what a run asks, for whom and under which scope never changes', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      const asApp = (statement: string, params: unknown[] = []) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(PIPELINE)), (tx) => tx.query(statement, params));
      await expect(asApp('delete from machvon.bi_query_run where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp('truncate machvon.bi_query_run')).rejects.toMatchObject({ code: '42501' });
      await expect(asApp('update machvon.bi_query_run set requested_by = $2 where id = $1', [id, memberId(PIPELINE)])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp("update machvon.bi_query_run set query_spec = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp("update machvon.bi_query_run set status = 'COMPLETED' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    });

    it('moves forward only and writes how it ended once: the answer is written with the end and is never replaced', async () => {
      const world = await figures({ projects: 30 });
      const queued = await ask(world, ['project']);
      const id = queued.json.run_id as string;
      await runJobs();
      const asApp = (statement: string, params: unknown[] = []) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(PIPELINE)), (tx) => tx.query(statement, params));
      await expect(asApp("update machvon.bi_query_run set status = 'RUNNING' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp('update machvon.bi_query_run set duration_ms = 1 where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp("update machvon.bi_query_run set result = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp("update machvon.bi_query_run set result_expires_at = now() + interval '9 days' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    });

    it('does not hold a refusal without its reason, a job without what it was asked, or a queued run that is a sync run', async () => {
      const insert = (mode: string, status: string, spec: string | null, error: string | null, key: string | null, cost: number | null) =>
        owner(
          `insert into machvon.bi_query_run (tenant_id, id, requested_by, metric_version_ids, as_of_period, dataset_version_id, scope_hash, mode, status, error_code, query_spec, cache_key, estimated_cost)
           values ($1, gen_random_uuid(), $2, '[]'::jsonb, '2034-01', $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
          [TENANT_A, memberId(PIPELINE), randomUUID(), 'a'.repeat(64), mode, status, error, spec, key, cost],
        );
      await expect(insert('SYNC', 'DENIED', null, null, null, null)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('ASYNC_JOB', 'QUEUED', null, null, null, null)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('SYNC', 'QUEUED', null, null, null, null)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('SYNC', 'COMPLETED', null, null, null, -1)).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('BI-13, the log of the queries', () => {
    it('lists the runs newest first with their timing and cache flags and never what they asked or answered', async () => {
      const world = await figures({ projects: 30 });
      await ask(world, ['project']);
      await runJobs();
      await ask(world, ['project']);
      const reply = await log(LOG_ADMIN, '?limit=200');
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(3);
      const keys = new Set(items.flatMap((item) => Object.keys(item)));
      expect([...keys].sort()).toEqual(
        [
          'as_of_period',
          'cost_units',
          'created_at',
          'dataset_version_id',
          'duration_ms',
          'error_code',
          'estimated_cost',
          'finished_at',
          'id',
          'metric_version_ids',
          'mode',
          'requested_by',
          'row_count',
          'served_from_cache',
          'status',
        ].sort(),
      );
      expect(JSON.stringify(reply.json)).not.toContain('30000000000');
      expect(items.map((item) => item.created_at)).toEqual([...items.map((item) => item.created_at as string)].sort().reverse());
      const job = items.find((item) => item.mode === 'ASYNC_JOB' && item.dataset_version_id === world.version);
      expect(job).toMatchObject({ status: 'COMPLETED', row_count: 30, error_code: null, served_from_cache: false });
    });

    it('is filtered by status, by the person and by the period, and a page ends with the cursor of the next', async () => {
      const world = await figures({ projects: 30 });
      await ask(world, ['project']);
      const queued = await log(LOG_ADMIN, `?status=QUEUED&as_of_period=${world.period}`);
      expect((queued.json.items as unknown[]).length).toBe(1);
      const mine = await log(LOG_ADMIN, `?requested_by=${memberId(ANALYST_ALL)}&as_of_period=${world.period}`);
      expect((mine.json.items as unknown[]).length).toBe(1);
      const nobody = await log(LOG_ADMIN, `?requested_by=${memberId(NOBODY)}&as_of_period=${world.period}`);
      expect(nobody.json.items).toEqual([]);
      const first = await log(LOG_ADMIN, '?limit=2');
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await log(LOG_ADMIN, `?limit=2&cursor=${first.json.next_cursor as string}`);
      const ids = [...(first.json.items as Array<{ id: string }>), ...(second.json.items as Array<{ id: string }>)].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('is refused without the right, over one unit only, or with a filter that is not one', async () => {
      expect((await log(NOBODY)).status).toBe(403);
      expect((await log(LOG_SCOPED)).status).toBe(403);
      for (const query of ['?status=LOST', '?requested_by=nobody', '?as_of_period=x', '?limit=0', '?limit=201', '?limit=abc', '?cursor=not-a-cursor']) {
        expect((await log(LOG_ADMIN, query)).status).toBe(422);
      }
    });

    it('is the tenant’s own: the runs of another tenant are not in it', async () => {
      // A member of the other tenant who holds no right to read the log is refused there too.
      expect((await app.call('GET', '/bi/query-runs', { member: PIPELINE, tenantId: TENANT_B })).status).toBe(403);
      await app.harness.seedRole(TENANT_B, 3, 'BI_LOG_ADMIN', ['bi.admin.read'], 30);
      await app.harness.seedGrants(TENANT_B, [{ n: 3, member: OUTSIDER, role: 3, kind: 'TENANT' }]);
      const own = await app.call('GET', '/bi/query-runs', { member: OUTSIDER, tenantId: TENANT_B });
      expect(own.status).toBe(200);
      expect(own.json.items).toEqual([]);
    });
  });

  describe('BI-14, the lineage of a metric', () => {
    let world: World;
    beforeAll(async () => {
      world = await figures({ projects: 3 });
      expect((await ask(world, ['unit'], ANALYST_ALL, undefined, { metric_version_id: probe })).status).toBe(200);
    });

    it('shows whoever reads it the metric, the version of the dataset, the snapshot, the transform of each step and the records, level by level', async () => {
      const reply = await lineage(LINEAGE_ALL, probe, '?depth=6');
      expect(reply.status).toBe(200);
      const nodes = reply.json.nodes as Array<Record<string, unknown>>;
      const kinds = (level: number) => nodes.filter((node) => node.level === level).map((node) => node.node_kind);
      expect(kinds(0)).toEqual(['METRIC_VERSION']);
      expect(kinds(1)).toContain('DATASET_VERSION');
      expect(kinds(2)).toContain('TABLE');
      expect(kinds(3)).toEqual(['RECORD', 'RECORD', 'RECORD']);
      expect(nodes.every((node) => node.restricted === false)).toBe(true);
      const transforms = (reply.json.edges as Array<{ transform_version: string }>).map((edge) => edge.transform_version);
      expect(transforms).toEqual(expect.arrayContaining(['metric:lineage_probe@1', 'bi-dataset-build-v1', 'dis-snapshot-close-v1']));
      expect(reply.json.direction).toBe('upstream');
    });

    it('tells the quality of the version of the dataset on the way, never a value of the data', async () => {
      const reply = await lineage(LINEAGE_ALL, probe, '?depth=2');
      const version = (reply.json.nodes as Array<Record<string, unknown>>).find((node) => node.node_kind === 'DATASET_VERSION');
      expect((reply.json.quality as Record<string, unknown>)[version?.key as string]).toMatchObject({ quality_badge: 'NOT_ASSESSED', excluded_quarantine_rows: 0 });
      expect(JSON.stringify(reply.json)).not.toContain('1000000000');
    });

    it('shows the person without rights over a source unit only that a node is restricted, in its place and its level, with no name, no id and no kind', async () => {
      const reply = await lineage(LINEAGE_UNIT, probe, '?depth=6');
      expect(reply.status).toBe(200);
      const nodes = reply.json.nodes as Array<Record<string, unknown>>;
      const records = nodes.filter((node) => node.level === 3);
      expect(records).toHaveLength(3);
      const shown = records.filter((node) => node.restricted === false);
      const hidden = records.filter((node) => node.restricted === true);
      expect(shown).toHaveLength(2);
      expect(hidden).toHaveLength(1);
      expect(Object.keys(hidden[0] as object).sort()).toEqual(['key', 'level', 'restricted']);
      // The project of the unit outside is named nowhere in the answer, nor is its id.
      const outside = await owner<{ ref_id: string; display_name: string }>("select ref_id, display_name from machvon.lineage_node where node_kind = 'RECORD' and ref_id = $1", [world.projects[2]]);
      expect(JSON.stringify(reply.json)).not.toContain(outside[0]?.ref_id as string);
      expect(JSON.stringify(reply.json)).not.toContain(outside[0]?.display_name as string);
      // The steps that touch it say nothing of their transform.
      const touching = (reply.json.edges as Array<Record<string, unknown>>).filter((edge) => hidden.some((node) => node.key === edge.from || node.key === edge.to));
      expect(touching.length).toBe(1);
      expect(touching[0]).toMatchObject({ run_id: null, transform_version: null, observed_at: null });
    });

    it('tells no record to a person who reads the lineage over the whole tenant and cannot read the projects: the lineage never tells what the source would refuse', async () => {
      const reply = await lineage(LINEAGE_NO_PROJECTS, probe, '?depth=6');
      expect(reply.status).toBe(200);
      const nodes = reply.json.nodes as Array<Record<string, unknown>>;
      expect(nodes.filter((node) => node.level === 3)).toEqual(expect.arrayContaining([expect.objectContaining({ restricted: true })]));
      expect(nodes.filter((node) => node.level === 3 && node.restricted === false)).toEqual([]);
      expect(nodes.filter((node) => asNumber(node.level) < 3).every((node) => node.restricted === false)).toBe(true);
    });

    it('reads the metric of another tenant as no metric, and the person without the right as refused', async () => {
      expect((await lineage(NOBODY, metric)).status).toBe(403);
      expect((await lineage(LINEAGE_ALL, randomUUID())).status).toBe(404);
      const foreign = await app.call('GET', `/bi/metric-definitions/${metric}/lineage`, { member: OUTSIDER, tenantId: TENANT_B });
      expect([403, 404]).toContain(foreign.status);
    });

    it('is an empty graph for a metric nobody has read yet, not an error', async () => {
      const reply = await lineage(LINEAGE_ALL, lonely);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ start: null, nodes: [], edges: [], truncated: false });
    });

    it('does not tell a person who may not read the metrics that one exists: not with a lineage recorded about it, and not without', async () => {
      expect((await lineage(LINEAGE_NO_METRICS, probe)).status).toBe(404);
      expect((await lineage(LINEAGE_NO_METRICS, lonely)).status).toBe(404);
      expect((await lineage(LINEAGE_NO_METRICS, randomUUID())).status).toBe(404);
    });

    it('gives a version that was built before the lineage was kept its source when the same build is asked for again, and writes nothing twice', async () => {
      const early = await figures({ projects: 3 });
      const edges = () => app.count("select count(*) as n from machvon.lineage_edge where run_id = $1 and transform_version in ('bi-dataset-build-v1', 'dis-snapshot-close-v1')", [early.version]);
      expect(await edges()).toBe(4);
      await owner("delete from machvon.lineage_edge where run_id = $1 and transform_version in ('bi-dataset-build-v1', 'dis-snapshot-close-v1')", [early.version]);
      expect(await edges()).toBe(0);
      const again = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: early.period } });
      expect(again.status).toBe(202);
      expect(again.json).toMatchObject({ outcome: 'UNCHANGED', resource_id: early.version });
      expect(await edges()).toBe(4);
      expect((await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: early.period } })).json).toMatchObject({ outcome: 'UNCHANGED' });
      expect(await edges()).toBe(4);
    });

    it('takes a direction and a depth, and refuses what is neither', async () => {
      expect((await lineage(LINEAGE_ALL, metric, '?direction=sideways')).status).toBe(422);
      expect((await lineage(LINEAGE_ALL, metric, '?depth=0')).status).toBe(422);
      expect((await lineage(LINEAGE_ALL, metric, '?depth=7')).status).toBe(422);
      const down = await lineage(LINEAGE_ALL, metric, '?direction=downstream&depth=1');
      expect(down.status).toBe(200);
      expect(down.json.direction).toBe('downstream');
      expect((down.json.nodes as unknown[]).length).toBe(1);
    });

    it('is written when a version of a dataset is built and when a metric is read, once for each: the same read again adds nothing', async () => {
      const before = await app.count("select count(*) as n from machvon.lineage_edge where transform_version = 'metric:lineage_probe@1'");
      expect(before).toBe(1);
      expect((await ask(world, ['unit'], ANALYST_BRANCH, undefined, { metric_version_id: probe })).status).toBe(200);
      expect(await app.count("select count(*) as n from machvon.lineage_edge where transform_version = 'metric:lineage_probe@1'")).toBe(before);
    });

    it('is written when a job reads a metric too, under the run of the job', async () => {
      const heavy = await figures({ projects: 30 });
      const queued = await ask(heavy, ['project']);
      await runJobs();
      const edge = await owner<{ run_id: string }>(
        "select e.run_id from machvon.lineage_edge e join machvon.lineage_node n on n.id = e.from_node_id where n.ref_id = $1 and e.transform_version = 'metric:disbursed_log@1'",
        [heavy.version],
      );
      expect(edge.map((row) => row.run_id)).toHaveLength(1);
      expect((await runRow(queued.json.run_id as string))?.status).toBe('COMPLETED');
    });
  });

  it('tells the lineage which metrics a version of a dashboard shows when the version is saved, once for each metric', async () => {
    const dashboard = await app.call('POST', '/bi/dashboards', { member: DASH_MAKER, body: { code: 'LIN-DASH', title: 'Dashboard' } });
    expect(dashboard.status).toBeLessThan(300);
    const id = dashboard.json.resource_id as string;
    const draft = {
      layout_json: { widgets: [{ id: 'w1', kind: 'BAR', metric_version_id: probe, dimension_code: 'unit', grid: { x: 0, y: 0, w: 12, h: 4 } }] },
      breakpoints: { sm: 640, md: 1024 },
      metric_versions: [probe],
      filter_mappings: { period: 'bucket' },
      dataset_version_policy: 'LATEST_FROZEN',
    };
    const saved = await app.call('POST', `/bi/dashboards/${id}/versions`, { member: DASH_MAKER, ifMatch: '"1"', body: draft });
    expect(saved.status).toBeLessThan(300);
    const edges = await owner<{ transform_version: string; to_name: string }>(
      'select e.transform_version, t.display_name as to_name from machvon.lineage_edge e join machvon.lineage_node t on t.id = e.to_node_id where t.ref_id = $1',
      [saved.json.version_id],
    );
    expect(edges).toEqual([{ transform_version: 'bi-dashboard-version-v1', to_name: 'LIN-DASH #1' }]);
  });

  it('the pass of the worker over a transaction runs the jobs it holds and reports how many', async () => {
    const world = await figures({ projects: 30 });
    await ask(world, ['project']);
    const ran = await app.harness.tenants.withTenant(WORKER, (tx) => runQueryJobs(tx, WORKER, new Date(CLOCK.now), { syncCostLimit: COST_LIMIT, batchSize: 1 }));
    expect(ran).toBe(1);
  });
});
