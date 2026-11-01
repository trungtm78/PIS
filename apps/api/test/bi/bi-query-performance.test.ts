import { randomUUID } from 'node:crypto';
import { AuditWriter, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { runQueryJobsIn } from '../../src/modules/bi/query-jobs';
import { ANALYST_ALL, BUILDER, BiApp, CLOCK, DATASET, LOG_ADMIN, PIPELINE, TENANT_A, UNIT_A, contextFor, memberId, unitId } from './bi-app';

jest.setTimeout(600_000);

/** UAT-AC477 and NFR-PERFORMANCE-03: a tenant of 5,000 projects with a snapshot of its period, a province-wide query of 12 metrics run 20 times, and a heavy query run once. */
const PROJECTS = 5000;
const METRICS = 12;
const RUNS = 20;
const P95_BUDGET_MS = 2000;
/** A query over the lines of the snapshot grouped by project costs more than this; one grouped by unit or not at all costs less. */
const COST_LIMIT = 30_000;
const app = new BiApp();
const metrics: string[] = [];
let snapshotVersion = '';
let period = '';

const percentile95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1] as number;

describe('the performance of the queries over a tenant of 5,000 projects (ST-BI-009, UAT-AC477, NFR-PERFORMANCE-03)', () => {
  beforeAll(async () => {
    await app.start({ costLimit: COST_LIMIT });
    const names = Array.from({ length: METRICS }, (_, index) => `perf_metric_${index + 1}`);
    const bundle = await app.bundle(
      names.map((code) => ({ code, grain: 'project', aggregation_type: 'additive', expression: { op: 'sum', args: [{ op: 'field', name: 'GIAI_NGAN' }] }, unit: 'VND', effective_from: '2026-01-01' })),
    );
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'perfsync1', bundle_object_key: bundle.key, bundle_sha256: bundle.sha256 } })).status).toBe(
      200,
    );
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    for (const code of names) metrics.push((listed.json.items as Array<{ id: string; code: string }>).find((item) => item.code === code)?.id as string);
    period = '2035-01';
    const periodId = randomUUID();
    const snapshot = randomUUID();
    const id = "('00000000-0000-4000-95' || lpad(g::text, 2, '0') || '-' || lpad(g::text, 12, '0'))::uuid";
    void id;
    const projectId = "('00000000-0000-4000-9500-' || lpad(g::text, 12, '0'))::uuid";
    await app.seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2035-01-01', date '2035-01-31', now(), 'DEFAULT', 'MONTH', 2035, 'OPEN', $4, $5, $5)`,
        [TENANT_A, periodId, period, randomUUID(), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2035-01-31', date '2035-01-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
        [TENANT_A, snapshot, periodId, PROJECTS, 'c'.repeat(64), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         select $1, ${projectId}, 'PERF-' || g, 'PERF-' || g, $2, gen_random_uuid(), 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B' from generate_series(1, $3::int) g`,
        [TENANT_A, unitId(UNIT_A), PROJECTS],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
         select $1, gen_random_uuid(), $2, ${projectId}, $3, null, 'CURRENT_YEAR', 'CENTRAL', 10, 0, 10, 1000000, 'NO_DATA', 'COMPLETE' from generate_series(1, $4::int) g`,
        [TENANT_A, snapshot, unitId(UNIT_A), PROJECTS],
      ],
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         select $1, gen_random_uuid(), $2, 1, 'ROLE', r.id, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $3, $4, $3 from machvon.role_definition r where r.code = 'BI_ANALYST_QUERY'`,
        [TENANT_A, DATASET, memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
    // A snapshot is a bulk load: the planner knows the size of what was loaded once the tables are analysed, as autovacuum does after a load of this size.
    await app.harness.owner(TENANT_A, [
      ['analyze machvon.period_snapshot_line', []],
      ['analyze machvon.project', []],
    ]);
    const built = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: period } });
    expect(built.status).toBe(202);
    snapshotVersion = built.json.resource_id as string;
  }, 600_000);
  afterAll(() => app.stop(), 60_000);

  it('answers a province-wide query of 12 metrics in 2 seconds or less at the 95th percentile of 20 runs', async () => {
    const durations: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      // Each run asks a question of its own (the filter names another unit as well), so none of them is answered from the cache of the run before.
      const filters = [{ field: 'unit', operator: 'in', value: [unitId(UNIT_A), randomUUID()] }];
      const started = Date.now();
      for (const metric of metrics) {
        const reply = await app.call('POST', '/dashboard-queries', { member: ANALYST_ALL, body: { metric_version_id: metric, snapshot_id: snapshotVersion, dimensions: ['unit'], filters } });
        expect(reply.status).toBe(200);
        expect(reply.json).toMatchObject({ served_from_cache: false });
      }
      durations.push(Date.now() - started);
    }
    expect(durations).toHaveLength(RUNS);
    expect(percentile95(durations)).toBeLessThanOrEqual(P95_BUDGET_MS);
  });

  it('answers the same question again from the cache, much faster than it was first computed', async () => {
    const filters = [{ field: 'unit', operator: 'in', value: [unitId(UNIT_A), randomUUID()] }];
    const ask = () => app.call('POST', '/dashboard-queries', { member: ANALYST_ALL, body: { metric_version_id: metrics[0], snapshot_id: snapshotVersion, dimensions: ['unit'], filters } });
    const first = await ask();
    const second = await ask();
    expect([first.json.served_from_cache, second.json.served_from_cache]).toEqual([false, true]);
  });

  it('answers a heavy query 202 ASYNC_JOB, runs it as a job, and shows its duration and rows in the log without any value of the data (UAT-AC477)', async () => {
    const queued = await app.call('POST', '/dashboard-queries', { member: ANALYST_ALL, body: { metric_version_id: metrics[0], snapshot_id: snapshotVersion, dimensions: ['project'], filters: [] } });
    expect(queued.status).toBe(202);
    expect(queued.json).toMatchObject({ status: 'ASYNC_JOB', mode: 'ASYNC_JOB', estimated_cost: PROJECTS * 8 });
    const ran = await runQueryJobsIn(app.harness.tenants, contextFor(TENANT_A, WORKER_MEMBERSHIP_ID), new Date(CLOCK.now), { audit: new AuditWriter(app.harness.tenants), syncCostLimit: COST_LIMIT });
    expect(ran).toBeGreaterThanOrEqual(1);
    const log = await app.call('GET', `/bi/query-runs?status=COMPLETED&as_of_period=${period}&limit=200`, { member: LOG_ADMIN });
    expect(log.status).toBe(200);
    const job = (log.json.items as Array<Record<string, unknown>>).find((item) => item.id === queued.json.run_id);
    expect(job).toMatchObject({ mode: 'ASYNC_JOB', status: 'COMPLETED', served_from_cache: false, estimated_cost: PROJECTS * 8 });
    expect(typeof job?.duration_ms).toBe('number');
    // The page of a screen is cut at its cap; the job's answer is the whole group list, up to the same cap.
    expect(job?.row_count).toBe(500);
    expect(JSON.stringify(log.json)).not.toContain('5000000000');
    // The run of the 12 metrics are in the log as sync runs with the same flags.
    const sync = (log.json.items as Array<Record<string, unknown>>).filter((item) => item.mode === 'SYNC');
    expect(sync.length).toBeGreaterThanOrEqual(METRICS);
    expect(sync.every((item) => item.served_from_cache === false || item.served_from_cache === true)).toBe(true);
  });
});
