import { randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { ANALYST_ALL, BUILDER, BiApp, PIPELINE, TENANT_A, TENANT_B, UNIT_A, UNIT_B, DATASET, memberId, roleId, unitId } from '../bi/bi-app';
import type { Reply } from '../bi/bi-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';

jest.setTimeout(240_000);

const app = new BiApp();
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const METRICS = [
  { code: 'disbursed', grain: 'project', aggregation_type: 'additive', expression: sum('GIAI_NGAN'), unit: 'VND', effective_from: '2026-01-01' },
  { code: 'rate_pm', grain: 'project', aggregation_type: 'ratio', numerator: sum('GIAI_NGAN'), denominator: sum('KE_HOACH_TTG'), unit: 'percent', effective_from: '2026-01-01' },
];
const metricIds: Record<string, string> = {};
const fundX = randomUUID();
const fundY = randomUUID();
let counter = 0;
const projects = new Map<string, string>();

interface LineSeed {
  project: string;
  unit: number;
  fund: string;
  paid: number;
  plan: number;
}

/** A weekly period and the frozen snapshot of its close, with the lines given (money in dong). */
async function weeklySnapshot(lines: LineSeed[]): Promise<{ id: string; code: string; version: string }> {
  counter += 1;
  const code = `2030-W${String(counter).padStart(2, '0')}`;
  const periodId = randomUUID();
  const id = randomUUID();
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2030-01-01' + $6::int * 7, date '2030-01-01' + $6::int * 7 + 6, now(), 'DEFAULT', 'WEEK', 2030, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, counter],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2030-10-31', date '2030-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, $7::timestamptz, $6::uuid, $6::uuid)`,
      [TENANT_A, id, periodId, lines.length, 'c'.repeat(64), WORKER_MEMBERSHIP_ID, new Date().toISOString()],
    ],
  ];
  for (const line of lines) {
    let projectId = projects.get(`${line.project}@${line.unit}`);
    if (projectId === undefined) {
      projectId = randomUUID();
      projects.set(`${line.project}@${line.unit}`, projectId);
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `${line.project}-${line.unit}`, unitId(line.unit), randomUUID()],
      ]);
    }
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', $6::numeric, 0, $6::numeric, $7::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, id, projectId, unitId(line.unit), line.fund, line.plan, line.paid],
    ]);
  }
  await app.seedReplica(statements);
  const built = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: code } });
  assertStatus(built, 202);
  return { id, code, version: built.json.resource_id as string };
}

const query = (body: Record<string, unknown>, member = ANALYST_ALL, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/dashboard-queries', { member, body: { filters: [], dimensions: [], ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
const explain = (token: string, dimension: string): Promise<Reply> => app.call('GET', `/bi/drill?drill_token=${encodeURIComponent(token)}&child_dimension=${dimension}`, { member: ANALYST_ALL });
const children = (reply: Reply): Array<Record<string, unknown>> => reply.json.children as Array<Record<string, unknown>>;
const total = (reply: Reply): Record<string, unknown> => reply.json.total as Record<string, unknown>;

/** NFR-PERFORMANCE-03 and FR-BI-06: the figures of BI come from the frozen snapshot of the period, the rate is the sum of the numerators over the sum of the denominators, and a drill stays on the snapshot. */
describe('the figures of BI from the snapshot of a period (UAT cases of BI)', () => {
  beforeAll(async () => {
    await app.start();
    const { key, sha256 } = await app.bundle(METRICS);
    assertStatus(await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'uatcase-bi', bundle_object_key: key, bundle_sha256: sha256 } }), 200);
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    for (const item of listed.json.items as Array<{ id: string; code: string }>) metricIds[item.code] = item.id;
    // The policy that opens the dataset to the analysts of the tenant (closed by default).
    await app.seedReplica([
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 1, 'ROLE', $4, $5::jsonb, '{}'::jsonb, 'ACTIVE', $6, $7, $6)`,
        [TENANT_A, randomUUID(), DATASET, roleId(9), JSON.stringify({ op: 'unit_in_scope' }), memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);

  it('UAT-BI01: 140 of 1,000 is 14 percent, the end of the period is 150 and not 250, and the drill goes down to the source on the same snapshot with the tenant of nobody else in it', async () => {
    // The week before the close: 100 disbursed. The close of the week: the cumulative is 150 (not 100 and 150 added), against a plan of 1,000 of which a unit of 140 gives the 14 percent.
    const week1 = await weeklySnapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: 100, plan: 1000 }]);
    const week2 = await weeklySnapshot([
      { project: 'P1', unit: UNIT_A, fund: fundX, paid: 90, plan: 600 },
      { project: 'P2', unit: UNIT_A, fund: fundY, paid: 50, plan: 400 },
      { project: 'P3', unit: UNIT_B, fund: fundX, paid: 10, plan: 0 },
    ]);
    expect(week1.version).not.toBe(week2.version);

    const ofWeek1 = await query({ metric_version_id: metricIds.disbursed, snapshot_id: week1.version, dimensions: ['unit'] });
    assertStatus(ofWeek1, 200);
    expect(total(ofWeek1).value).toBe('100');
    const endOfPeriod = await query({ metric_version_id: metricIds.disbursed, snapshot_id: week2.version, dimensions: ['unit'] });
    assertStatus(endOfPeriod, 200);
    expect(endOfPeriod.json).toMatchObject({ snapshot_id: week2.version, as_of_period: week2.code, reconciles_to_parent: true });
    expect(total(endOfPeriod).value).toBe('150');
    expect(total(endOfPeriod).value).not.toBe('250');
    expect(children(endOfPeriod).reduce((acc, row) => acc + Number(row.value), 0)).toBe(150);

    // The rate of the unit holding 140 of the 1,000 of plan: the sums over the sums, 14.00 (a mean of the rates of its projects would say 15.00 and 12.50 apart).
    const rate = await query({ metric_version_id: metricIds.rate_pm, snapshot_id: week2.version, dimensions: ['unit'], filters: [{ field: 'unit', operator: 'eq', value: unitId(UNIT_A) }] });
    assertStatus(rate, 200);
    expect(total(rate)).toMatchObject({ value: '14.00', numerator: '140', denominator: '1000', null_reason: null });
    expect(JSON.stringify(rate.json)).not.toContain('"30.00"');

    // The drill from the unit goes down to the funding sources and the projects, on the snapshot the figure came from, and the children add up to the unit.
    const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: week2.version, dimensions: ['unit'] });
    const unitToken = children(units).find((row) => row.key === unitId(UNIT_A))?.drill_token as string;
    const byFund = await explain(unitToken, 'fund_source');
    assertStatus(byFund, 200);
    expect(byFund.json).toMatchObject({ snapshot_id: week2.version, dimension: 'fund_source', reconciles_to_parent: true });
    expect(total(byFund).value).toBe('140');
    expect(children(byFund).map((row) => [row.key, row.value]).sort()).toEqual([[fundX, '90'], [fundY, '50']].sort());
    const byProject = await explain(children(byFund).find((row) => row.key === fundX)?.drill_token as string, 'project');
    expect([byProject.status, byProject.json.snapshot_id, total(byProject).value]).toEqual([200, week2.version, '90']);

    // Every query left a run that names the snapshot of its version; the other tenant has nothing of this one.
    const runs = await app.harness.owner<{ as_of_period: string; status: string }>(TENANT_A, [['select as_of_period, status from machvon.bi_query_run order by created_at', []]]);
    expect(new Set(runs.map((run) => run.as_of_period))).toEqual(new Set([week1.code, week2.code]));
    expect(runs.every((run) => run.status === 'COMPLETED')).toBe(true);
    expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: week2.version }, PIPELINE, TENANT_B)).status).toBe(403);
  });

  it('negative control of the BI cases: a total that is the sum of two periods, or a rate that is not the sums over the sums, makes the check throw', () => {
    expectCheckFails(() => expect('250').toBe('150'));
    expectCheckFails(() => expect({ value: '15.00', numerator: '90', denominator: '600' }).toMatchObject({ value: '14.00' }));
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403));
  });
});
