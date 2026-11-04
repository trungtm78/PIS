import { randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { signBiDrill } from '@machvon/kernel';
import { ANALYST_ALL, ANALYST_BRANCH, ANALYST_NONE, BUILDER, BiApp, CLOCK, DATASET, DRILL_KEY, PIPELINE, POLICY_ADMIN, TENANT_A, TENANT_B, UNIT_A, UNIT_B, UNIT_C, UNIT_OUT, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(180_000);

const app = new BiApp();
const BILLION = 1_000_000_000;
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const METRICS = [
  { code: 'disbursed', grain: 'project', aggregation_type: 'additive', expression: sum('GIAI_NGAN'), unit: 'VND', effective_from: '2026-01-01' },
  { code: 'rate_pm', grain: 'project', aggregation_type: 'ratio', numerator: sum('GIAI_NGAN'), denominator: sum('KE_HOACH_TTG'), unit: 'percent', effective_from: '2026-01-01' },
  { code: 'disbursed_zero', grain: 'project', aggregation_type: 'additive', expression: sum('GIAI_NGAN'), unit: 'VND', null_policy: 'ZERO_IF_NO_ROWS', effective_from: '2026-01-01' },
  { code: 'reported_values', grain: 'project', aggregation_type: 'distinct', expression: { op: 'count_distinct', args: [field('GIAI_NGAN_BAO_CAO')] }, unit: 'count', effective_from: '2026-01-01' },
  { code: 'project_count', grain: 'project', aggregation_type: 'distinct', expression: { op: 'count_distinct', args: [field('DU_AN')] }, unit: 'count', effective_from: '2026-01-01' },
];
const metricIds: Record<string, string> = {};
let counter = 0;
const fundX = randomUUID();
const fundY = randomUUID();

interface LineSeed {
  project: string;
  unit: number;
  fund: string | null;
  paid: number | null;
  plan: number;
  bucket?: string;
  level?: string;
}
const projects = new Map<string, string>();

/** A reporting period and a frozen close snapshot of it with the lines given (money in dong); projects are made once per key. */
async function snapshot(lines: LineSeed[], options: { code?: string; periodId?: string; status?: string } = {}): Promise<{ id: string; periodId: string; code: string; version: string }> {
  counter += 1;
  const code = options.code ?? `2030-${String(counter).padStart(2, '0')}`;
  const periodId = options.periodId ?? randomUUID();
  const id = randomUUID();
  const statements: Array<[string, unknown[]]> = [];
  if (options.periodId === undefined) {
    statements.push([
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2030-01-01' + $6::int * 40, date '2030-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2030, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, counter],
    ]);
  }
  const status = options.status ?? 'FROZEN';
  statements.push([
    `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
     values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2030-10-31', date '2030-10-31', $4, 'DIS-METRICS-R1', 'SIGNED', $5, $6, $7::uuid, $8::timestamptz, $9::uuid, $9::uuid)`,
    [TENANT_A, id, periodId, status, lines.length, 'c'.repeat(64), WORKER_MEMBERSHIP_ID, new Date().toISOString(), WORKER_MEMBERSHIP_ID],
  ]);
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
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8::numeric, 0, $8::numeric, $9::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, id, projectId, unitId(line.unit), line.fund, line.bucket ?? 'CURRENT_YEAR', line.level ?? 'CENTRAL', line.plan, line.paid],
    ]);
  }
  await app.seedReplica(statements);
  return { id, periodId, code, version: '' };
}

/** The version of the dataset of the period: what a query is pinned to. */
async function built(snap: { code: string; version: string }): Promise<void> {
  const reply = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: snap.code } });
  expect(reply.status).toBe(202);
  snap.version = reply.json.resource_id as string;
}

const query = (body: Record<string, unknown>, member = ANALYST_ALL, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/dashboard-queries', { member, body: { filters: [], dimensions: [], ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
const explain = (token: string, dimension: string, member = ANALYST_ALL, tenantId?: string, limit?: number): Promise<Reply> =>
  app.call('GET', `/bi/drill?drill_token=${encodeURIComponent(token)}&child_dimension=${dimension}${limit === undefined ? '' : `&limit=${limit}`}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const rows = (reply: Reply): Array<Record<string, unknown>> => reply.json.children as Array<Record<string, unknown>>;
const total = (reply: Reply): Record<string, unknown> => reply.json.total as Record<string, unknown>;
const audits = (action: string) => app.harness.owner<{ outcome: string; safe_diff: Record<string, unknown> }>(TENANT_A, [['select outcome, safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]]]);

/** An ACTIVE policy for a role, put in as the decision on a request will (ST-BI-006); made by one member and approved by another. */
async function open(roleNumber: number, predicate: unknown = { op: 'unit_in_scope' }, masks: unknown = {}): Promise<void> {
  await app.seedReplica([
    [
      `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, (select coalesce(max(revision), 0) + 1 from machvon.bi_access_policy where dataset_id = $3 and grantee_ref_id = $4), 'ROLE', $4, $5::jsonb, $6::jsonb, 'ACTIVE', $7, $8, $7)`,
      [TENANT_A, randomUUID(), DATASET, roleId(roleNumber), JSON.stringify(predicate), JSON.stringify(masks), memberId(BUILDER), memberId(PIPELINE)],
    ],
  ]);
}

describe('the queries of BI and the drill under them (ST-BI-004, BI F3, F4)', () => {
  beforeAll(async () => {
    await app.start();
    const { key, sha256 } = await app.bundle(METRICS);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'queries1', bundle_object_key: key, bundle_sha256: sha256 } })).status).toBe(200);
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    for (const item of listed.json.items as Array<{ id: string; code: string }>) metricIds[item.code] = item.id;
    await open(9);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(async () => {
    CLOCK.now = new Date();
    await app.seedReplica([['delete from machvon.bi_query_run', []], ['delete from machvon.drill_context', []], ['delete from machvon.bi_dataset_version', []], ['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.reporting_period', []]]);
  });

  describe('a query over a snapshot', () => {
    it('AC-ST-BI-004-1: UAT-AC31 keeps the snapshot SV-10a through unit, funding source and project with the same total of 12,450,000,000 dong, and raises the banner because SV-10b came after', async () => {
      const a = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 5_450_000_000, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_B, fund: fundY, paid: 7 * BILLION, plan: 10 * BILLION },
      ]);
      await built(a);
      await app.seedReplica([["update machvon.period_snapshot set status = 'SUPERSEDED' where id = '" + a.id + "'", []]]);
      const b = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: 9 * BILLION, plan: 10 * BILLION }], { code: a.code, periodId: a.periodId });
      await built(b);
      const seen: string[] = [];
      for (const dimension of ['unit', 'fund_source', 'project']) {
        const reply = await query({ metric_version_id: metricIds.disbursed, snapshot_id: a.version, dimensions: [dimension] });
        expect(reply.status).toBe(200);
        seen.push(reply.json.snapshot_id as string);
        expect(total(reply).value).toBe('12450000000');
        expect(rows(reply).reduce((acc, row) => acc + Number(row.value), 0)).toBe(12_450_000_000);
        expect(reply.json).toMatchObject({ as_of_period: a.code, new_data_available: true, newer_snapshot_id: b.version, reconciles_to_parent: true, served_from_cache: false });
      }
      expect(seen).toEqual([a.version, a.version, a.version]);
      // The newer snapshot serves its own figures, without the banner.
      const newer = await query({ metric_version_id: metricIds.disbursed, snapshot_id: b.version, dimensions: ['unit'] });
      expect([total(newer).value, newer.json.new_data_available]).toEqual(['9000000000', false]);
    });

    it('AC-ST-BI-004-2: UAT-AC32 adds the children and Unclassified to 10.5 billion, makes the ratio 10.5/30 = 35.00% from the sums, is NOT_APPLICABLE over a plan of zero, and leaves the unit out of the scope out with the label of the scope', async () => {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_B, fund: fundX, paid: 6 * BILLION, plan: 20 * BILLION },
        { project: 'P3', unit: UNIT_C, fund: fundY, paid: 0, plan: 0 },
        { project: 'P1', unit: UNIT_A, fund: null, paid: 500_000_000, plan: 0, bucket: 'CARRYOVER' },
        { project: 'P4', unit: UNIT_OUT, fund: fundX, paid: 3 * BILLION, plan: 5 * BILLION },
      ]);
      await built(snap);
      const byFund = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['fund_source'] }, ANALYST_BRANCH);
      const values = Object.fromEntries(rows(byFund).map((row) => [row.key ?? 'UNCLASSIFIED', row.value]));
      expect(values).toEqual({ [fundX]: '10000000000', [fundY]: '0', UNCLASSIFIED: '500000000' });
      expect(rows(byFund).find((row) => row.unclassified)).toMatchObject({ key: null, drill_token: null });
      expect(total(byFund).value).toBe('10500000000');
      expect(byFund.json).toMatchObject({ reconciles_to_parent: true, scope: { label: 'YOUR_SCOPE', full_tenant: false } });
      const ratio = await query({ metric_version_id: metricIds.rate_pm, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_BRANCH);
      expect(total(ratio)).toMatchObject({ value: '35.00', numerator: '10500000000', denominator: '30000000000', null_reason: null });
      const byUnit = Object.fromEntries(rows(ratio).map((row) => [row.key, row]));
      expect(byUnit[unitId(UNIT_A)]).toMatchObject({ value: '45.00', numerator: '4500000000', denominator: '10000000000' });
      expect(byUnit[unitId(UNIT_C)]).toMatchObject({ value: null, null_reason: 'NOT_APPLICABLE' });
      expect(byUnit[unitId(UNIT_OUT)]).toBeUndefined();
      expect(JSON.stringify(ratio.json)).not.toContain(unitId(UNIT_OUT));
      // Whoever reads the whole tenant sees the unit and the label of the whole tenant.
      const whole = await query({ metric_version_id: metricIds.rate_pm, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_ALL);
      expect(rows(whole).map((row) => row.key)).toContain(unitId(UNIT_OUT));
      expect(whole.json).toMatchObject({ scope: { label: 'FULL_TENANT', full_tenant: true } });
      // 10.5 + 3 over 30 + 5 billion: the unit outside the branch counts for the reader of the whole tenant.
      expect(total(whole).value).toBe('38.57');
    });

    it('AC-ST-BI-004-6: UAT-AC480 counts a project of two units in each of them and once in the total, and says the children do not add up and why', async () => {
      const snap = await snapshot([
        { project: 'P9', unit: UNIT_A, fund: fundX, paid: BILLION, plan: BILLION },
        { project: 'P9', unit: UNIT_B, fund: fundX, paid: BILLION, plan: BILLION, bucket: 'CARRYOVER' },
      ]);
      // The same project in two units: one project row, two lines.
      await app.seedReplica([["update machvon.period_snapshot_line set project_id = (select project_id from machvon.period_snapshot_line where snapshot_id = '" + snap.id + "' limit 1) where snapshot_id = '" + snap.id + "'", []]]);
      await built(snap);
      const reply = await query({ metric_version_id: metricIds.project_count, snapshot_id: snap.version, dimensions: ['unit'] });
      expect(rows(reply).map((row) => row.value)).toEqual(['1', '1']);
      expect(total(reply).value).toBe('1');
      expect(reply.json).toMatchObject({ reconciles_to_parent: false, non_additive_reason: 'DISTINCT_NOT_ADDITIVE' });
    });

    it('answers from the cache the second time for the same reader, not for a reader of another scope, and never carries the figures of one tenant to another', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      const ask = (member: number, tenantId?: string) => query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] }, member, tenantId);
      const first = await ask(ANALYST_ALL);
      const second = await ask(ANALYST_ALL);
      expect([first.json.served_from_cache, second.json.served_from_cache]).toEqual([false, true]);
      expect(second.json.built_at).toBe(first.json.built_at);
      expect(second.json.scope_hash).toBe(first.json.scope_hash);
      const other = await ask(ANALYST_BRANCH);
      expect(other.json.served_from_cache).toBe(false);
      expect(other.json.scope_hash).not.toBe(first.json.scope_hash);
      // Tenant B has nothing of A: the snapshot is not found there, whatever A has cached.
      expect((await ask(PIPELINE, TENANT_B)).status).toBe(403);
    });

    it('writes a run for each query, with the scope, the snapshot of the version and whether it came from the cache', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const runs = await app.harness.owner<{ status: string; served_from_cache: boolean; as_of_period: string; row_count: number }>(TENANT_A, [['select status, served_from_cache, as_of_period, row_count from machvon.bi_query_run order by created_at', []]]);
      expect(runs).toEqual([
        { status: 'COMPLETED', served_from_cache: false, as_of_period: snap.code, row_count: 1 },
        { status: 'COMPLETED', served_from_cache: true, as_of_period: snap.code, row_count: 1 },
      ]);
    });
  });

  describe('closed by default, and what a policy hides', () => {
    it('AC-ST-BI-003-1: UAT-AC473 refuses (403 ACCESS_POLICY_MISSING) a reader no active policy covers, keeps the refusal as a record and gives it again to the same key', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      const body = { metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'], filters: [] };
      const first = await app.call('POST', '/dashboard-queries', { member: ANALYST_NONE, body, key: 'denied-query-0001' });
      const again = await app.call('POST', '/dashboard-queries', { member: ANALYST_NONE, body, key: 'denied-query-0001' });
      expect([first.status, first.json.code]).toEqual([403, 'ACCESS_POLICY_MISSING']);
      expect([again.status, again.json.code]).toEqual([403, 'ACCESS_POLICY_MISSING']);
      expect(JSON.stringify(first.json)).not.toContain('children');
      expect((await audits('bi.query_denied')).length).toBe(1);
    });

    it('AC-ST-BI-003-1: UAT-AC473 answers only the rows a policy allows, and does not offer a dimension it hides', async () => {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_B, fund: fundY, paid: 6 * BILLION, plan: 10 * BILLION },
      ]);
      await built(snap);
      await open(10, { op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund_source', values: [fundX] }] }, { project: 'HIDE' });
      const only = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_NONE);
      expect(only.status).toBe(200);
      expect(total(only).value).toBe('4000000000');
      expect(rows(only).map((row) => row.key)).toEqual([unitId(UNIT_A)]);
      // The column a policy hides is not a dimension for that reader: not to group by, not to filter by.
      const hidden = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['project'] }, ANALYST_NONE);
      expect([hidden.status, hidden.json.code, hidden.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'project']);
      const filtered = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: [{ field: 'project', operator: 'eq', value: randomUUID() }] }, ANALYST_NONE);
      expect([filtered.status, filtered.json.code]).toEqual([422, 'DIMENSION_NOT_IN_DATASET']);
    });

    it('does not open a dataset through a grant that has expired or not begun, though another grant of the reader carries the right to query', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      // The member holds bi.query through their own role (no policy opens the dataset for it), and a grant of the role that has the policy, already over.
      await app.harness.seedGrants(TENANT_A, [{ n: 15, member: POLICY_ADMIN, role: 9, kind: 'TENANT', until: '2026-01-02T00:00:00Z' }]);
      const expired = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version }, POLICY_ADMIN);
      expect([expired.status, expired.json.code]).toEqual([403, 'ACCESS_POLICY_MISSING']);
      await app.harness.seedGrants(TENANT_A, [{ n: 16, member: POLICY_ADMIN, role: 9, kind: 'UNIT_SUBTREE', refs: [unitId(1)], from: '2090-01-01T00:00:00Z' }]);
      const future = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version }, POLICY_ADMIN);
      expect([future.status, future.json.code]).toEqual([403, 'ACCESS_POLICY_MISSING']);
    });

    it('counts the distinct values of a nullable field as no data, not as 0, when every line has none', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      const reply = await query({ metric_version_id: metricIds.reported_values, snapshot_id: snap.version }, ANALYST_ALL);
      expect([reply.status, reply.json.total]).toEqual([200, expect.objectContaining({ value: null, null_reason: 'NO_DATA' })]);
    });

    it('counts no distinct things, as no data and not as 0, when the filters and the scope leave no line, and refuses a metric over a column a policy hides', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      const none = await query({ metric_version_id: metricIds.project_count, snapshot_id: snap.version, filters: [{ field: 'unit', operator: 'eq', value: unitId(UNIT_OUT) }] }, ANALYST_ALL);
      expect(none.json.total).toMatchObject({ value: null, null_reason: 'NO_DATA' });
      // A metric that says that no line is zero gives zero, and only for no line at all.
      const emptyFilter = [{ field: 'unit', operator: 'eq', value: unitId(UNIT_OUT) }];
      const zero = await query({ metric_version_id: metricIds.disbursed_zero, snapshot_id: snap.version, filters: emptyFilter }, ANALYST_ALL);
      expect(zero.json.total).toMatchObject({ value: '0', null_reason: null });
      expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: emptyFilter }, ANALYST_ALL)).json.total).toMatchObject({ value: null, null_reason: 'NO_DATA' });
      // The column of the plan a policy hides, by its name in the table or by the name of the field, is not summed.
      const hider = randomUUID();
      await app.seedReplica([
        [
          `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
           values ($1, $2, $3, 98, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{"disbursed_treasury_vnd":"HIDE"}'::jsonb, 'ACTIVE', $5, $6, $5)`,
          [TENANT_A, hider, DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
        ],
      ]);
      for (const metric of [metricIds.disbursed, metricIds.rate_pm]) {
        const hidden = await query({ metric_version_id: metric, snapshot_id: snap.version, filters: [{ field: 'project', operator: 'eq', value: randomUUID() }] }, ANALYST_ALL);
        expect([hidden.status, hidden.json.code, hidden.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'disbursed_treasury_vnd']);
      }
      expect((await query({ metric_version_id: metricIds.project_count, snapshot_id: snap.version }, ANALYST_ALL)).status).toBe(200);
      await app.seedReplica([["update machvon.bi_access_policy set status = 'RETIRED' where id = $1", [hider]]]);
    });

    it('closes a dimension a policy hides by the name of its column too (unit_id, project_id, fund_source_version_id)', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: 2 * BILLION }]);
      await built(snap);
      const hider = randomUUID();
      await app.seedReplica([
        [
          `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
           values ($1, $2, $3, 97, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{"unit_id":"HIDE","project_id":"MASK","fund_source_version_id":"HIDE"}'::jsonb, 'ACTIVE', $5, $6, $5)`,
          [TENANT_A, hider, DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
        ],
      ]);
      for (const dimension of ['unit', 'project', 'fund_source']) {
        const grouped = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: [dimension] }, ANALYST_ALL);
        expect([grouped.status, grouped.json.code, grouped.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', dimension]);
        const filtered = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: [{ field: dimension, operator: 'eq', value: randomUUID() }] }, ANALYST_ALL);
        expect(filtered.status).toBe(422);
      }
      expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['bucket'] }, ANALYST_ALL)).status).toBe(200);
      await app.seedReplica([["update machvon.bi_access_policy set status = 'RETIRED' where id = $1", [hider]]]);
      // A policy that hides a dimension by its name closes the metric that counts it as well.
      const byName = randomUUID();
      await app.seedReplica([
        [
          `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
           values ($1, $2, $3, 96, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{"project":"HIDE"}'::jsonb, 'ACTIVE', $5, $6, $5)`,
          [TENANT_A, byName, DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
        ],
      ]);
      const counted = await query({ metric_version_id: metricIds.project_count, snapshot_id: snap.version }, ANALYST_ALL);
      expect([counted.status, counted.json.code, counted.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'project']);
      expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version }, ANALYST_ALL)).status).toBe(200);
      await app.seedReplica([["update machvon.bi_access_policy set status = 'RETIRED' where id = $1", [byName]]]);
    });

    it('AC-ST-BI-003-2: UAT-AC476 refuses a query with a sql field (400 FIELD_NOT_ALLOWED) and a dimension the dataset does not offer (422 DIMENSION_NOT_IN_DATASET)', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: BILLION }]);
      await built(snap);
      const sql = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, sql: 'select * from payment_request' });
      expect([sql.status, sql.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const foreign = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['contractor_tax_id'] });
      expect([foreign.status, foreign.json.code, foreign.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'contractor_tax_id']);
      const badFilter = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: [{ field: 'contractor_tax_id', operator: 'eq', value: 'x' }] });
      expect([badFilter.status, badFilter.json.code]).toEqual([422, 'DIMENSION_NOT_IN_DATASET']);
    });

    it('refuses what a query cannot be: a metric that is not certified, a snapshot with no version, two dimensions, and a filter value of the wrong shape', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: BILLION }]);
      await built(snap);
      const draft = await app.call('POST', '/bi/metric-definitions', { member: 2, body: { code: 't_draft', grain: 'project', aggregation_type: 'additive', expression_ast: sum('GIAI_NGAN'), unit: 'VND', null_policy: 'NULL_NOT_ZERO', dimension_codes: [], dataset_id: DATASET, effective_from: '2026-01-01' } });
      const notCertified = await query({ metric_version_id: draft.json.resource_id, snapshot_id: snap.version });
      expect([notCertified.status, notCertified.json.code]).toEqual([422, 'METRIC_NOT_CERTIFIED']);
      expect((await query({ metric_version_id: randomUUID(), snapshot_id: snap.version })).status).toBe(422);
      const noSnapshot = await query({ metric_version_id: metricIds.disbursed, snapshot_id: randomUUID() });
      expect([noSnapshot.status, noSnapshot.json.code]).toEqual([422, 'SNAPSHOT_NOT_FOUND']);
      expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit', 'project'] })).status).toBe(422);
      for (const filter of [{ field: 'unit', operator: 'eq', value: 'not-a-uuid' }, { field: 'unit', operator: 'in', value: [] }, { field: 'unit', operator: 'gte', value: unitId(UNIT_A) }, { field: 'bucket', operator: 'lte', value: 5 }]) {
        expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: [filter] })).status).toBe(422);
      }
      const ok = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['bucket'], filters: [{ field: 'bucket', operator: 'gte', value: 'A' }, { field: 'budget_level', operator: 'in', value: ['CENTRAL'] }, { field: 'unit', operator: 'eq', value: unitId(UNIT_A) }] });
      expect([ok.status, rows(ok).map((row) => row.key)]).toEqual([200, ['CURRENT_YEAR']]);
    });
  });

  describe('the drill', () => {
    async function world() {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_A, fund: fundY, paid: 2 * BILLION, plan: 5 * BILLION },
        { project: 'P3', unit: UNIT_B, fund: fundX, paid: 6 * BILLION, plan: 20 * BILLION },
      ]);
      await built(snap);
      return snap;
    }
    const tokenOf = (reply: Reply, unit: number): string => rows(reply).find((row) => row.key === unitId(unit))?.drill_token as string;

    it('goes down a unit to its funding sources on the same snapshot, with children that add up to the unit', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const down = await explain(tokenOf(units, UNIT_A), 'fund_source');
      expect(down.status).toBe(200);
      expect(down.json).toMatchObject({ snapshot_id: snap.version, dimension: 'fund_source', reconciles_to_parent: true, parent_context_id: expect.any(String) });
      expect(total(down).value).toBe('6000000000');
      expect(rows(down).map((row) => [row.key, row.value]).sort()).toEqual([[fundX, '4000000000'], [fundY, '2000000000']].sort());
      // And once more, to the project, still on the snapshot; a dimension already on the path is refused.
      const project = await explain(rows(down).find((row) => row.key === fundX)?.drill_token as string, 'project');
      expect([project.status, project.json.snapshot_id, total(project).value]).toEqual([200, snap.version, '4000000000']);
      const again = await explain(rows(down)[0]?.drill_token as string, 'fund_source');
      expect(again.status).toBe(422);
    });

    it('AC-ST-BI-004-3: UAT-AC33 refuses with 400 DRILL_TOKEN_INVALID, and records it as denied, a token that was altered, one of another tenant, one of another member and one that is gone, saying nothing of what exists', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const token = tokenOf(units, UNIT_A);
      const [payload, signature] = token.split('.') as [string, string];
      const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ctx_id: randomUUID() })).toString('base64url')}.${signature}`;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { ctx_id: string; scope_hash: string; metric_version_id: string; snapshot_id: string; as_of_period: string };
      const ofTenantB = signBiDrill({ tid: TENANT_B, ctx_id: claims.ctx_id, scope_hash: claims.scope_hash, metric_version_id: claims.metric_version_id, snapshot_id: claims.snapshot_id, as_of_period: claims.as_of_period }, DRILL_KEY, '1');
      const gone = signBiDrill({ tid: TENANT_A, ctx_id: randomUUID(), scope_hash: claims.scope_hash, metric_version_id: claims.metric_version_id, snapshot_id: claims.snapshot_id, as_of_period: claims.as_of_period }, DRILL_KEY, '1');
      const before = (await audits('bi.drill_denied')).length;
      for (const bad of [tampered, ofTenantB, `${payload}.AAAA`, 'nonsense', gone]) {
        const reply = await explain(bad, 'fund_source');
        expect([reply.status, reply.json.code]).toEqual([400, 'DRILL_TOKEN_INVALID']);
        expect(JSON.stringify(reply.json)).not.toContain(unitId(UNIT_A));
      }
      // The token of another member of the same tenant is not valid for this one.
      const alien = await explain(token, 'fund_source', ANALYST_BRANCH);
      expect([alien.status, alien.json.code]).toEqual([400, 'DRILL_TOKEN_INVALID']);
      const recorded = await audits('bi.drill_denied');
      // Each of the six, the token of the other member and the context that is gone as well, is recorded.
      expect(recorded.length - before).toBe(6);
      expect(recorded.every((entry) => entry.outcome === 'DENIED')).toBe(true);
      expect((await explain('', 'fund_source')).status).toBe(400);
      expect((await explain(token, 'contractor')).status).toBe(422);
    });

    it('goes on with a drill, and renews it, when a sync has put a newer revision of the metric in place of the one it began with, and asks a new query for the newer one', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const token = tokenOf(units, UNIT_A);
      await app.harness.owner(TENANT_A, [["update machvon.metric_definition set status = 'SUPERSEDED' where id = $1", [metricIds.disbursed]]]);
      expect((await explain(token, 'fund_source')).status).toBe(200);
      expect((await app.call('POST', '/bi/query-contexts/refresh', { member: ANALYST_ALL, body: { drill_token: units.json.drill_token } })).status).toBe(200);
      const fresh = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      expect([fresh.status, fresh.json.code]).toEqual([422, 'METRIC_NOT_CERTIFIED']);
      await app.harness.owner(TENANT_A, [["update machvon.metric_definition set status = 'RETIRED' where id = $1", [metricIds.disbursed]]]);
      expect((await explain(token, 'fund_source')).status).toBe(422);
      await app.harness.owner(TENANT_A, [["update machvon.metric_definition set status = 'CERTIFIED' where id = $1", [metricIds.disbursed]]]);
    });

    it('closes the way down through a dimension a policy hides since the token was made', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const token = tokenOf(units, UNIT_A);
      const hider = randomUUID();
      await app.seedReplica([
        [
          `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
           values ($1, $2, $3, 99, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{"unit":"HIDE"}'::jsonb, 'ACTIVE', $5, $6, $5)`,
          [TENANT_A, hider, DATASET, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
        ],
      ]);
      const closed = await explain(token, 'fund_source');
      expect([closed.status, closed.json.code, closed.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'unit']);
      expect((await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, filters: [{ field: 'unit', operator: 'eq', value: unitId(UNIT_A) }] })).status).toBe(422);
      await app.seedReplica([["update machvon.bi_access_policy set status = 'RETIRED' where id = $1", [hider]]]);
      expect((await explain(token, 'fund_source')).status).toBe(200);
    });

    it('AC-ST-BI-004-4: UAT-AC481 refuses a unit whose scope was revoked mid-session (403 SCOPE_DENIED, no name) and still serves the other unit on the same snapshot', async () => {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_B, fund: fundY, paid: 6 * BILLION, plan: 20 * BILLION },
      ]);
      await built(snap);
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_BRANCH);
      expect(rows(units).map((row) => row.key).sort()).toEqual([unitId(UNIT_A), unitId(UNIT_B)].sort());
      const [revokedToken, keptToken] = [tokenOf(units, UNIT_A), tokenOf(units, UNIT_B)];
      // The unit A is taken away from the reader while the page is open: a change of the grants moves the version of the scope.
      await app.seedReplica([["update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1 and scope_ref_ids = array[$2]::uuid[]", [memberId(ANALYST_BRANCH), unitId(UNIT_A)]], ['update machvon.membership set scope_version = scope_version + 1 where id = $1', [memberId(ANALYST_BRANCH)]]]);
      const version = Number((await app.harness.owner<{ v: string }>(TENANT_A, [['select scope_version::text as v from machvon.membership where id = $1', [memberId(ANALYST_BRANCH)]]]))[0]?.v);
      app.scopeVersions.set(ANALYST_BRANCH, version);
      const denied = await explain(revokedToken, 'fund_source', ANALYST_BRANCH);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(JSON.stringify(denied.json)).not.toMatch(/P1|P2/);
      expect(JSON.stringify(denied.json)).not.toContain(unitId(UNIT_A));
      // A query that continues the context of the revoked unit is refused the same way, not served as an empty figure.
      const continued = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['fund_source'], context_token: revokedToken }, ANALYST_BRANCH);
      expect([continued.status, continued.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(JSON.stringify(continued.json)).not.toContain(unitId(UNIT_A));
      const continuedKept = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['fund_source'], context_token: keptToken }, ANALYST_BRANCH);
      expect([continuedKept.status, total(continuedKept).value]).toEqual([200, '6000000000']);
      const kept = await explain(keptToken, 'fund_source', ANALYST_BRANCH);
      expect(kept.status).toBe(200);
      expect(kept.json).toMatchObject({ snapshot_id: snap.version, scope_changed: true });
      expect(total(kept).value).toBe('6000000000');
      const recorded = await audits('bi.drill_denied');
      expect(recorded.at(-1)).toMatchObject({ outcome: 'DENIED', safe_diff: { code: 'SCOPE_DENIED' } });
      expect(JSON.stringify(recorded.at(-1))).not.toContain(unitId(UNIT_A));
      // The same query now leaves the unit out.
      const now = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_BRANCH);
      expect(rows(now).map((row) => row.key)).toEqual([unitId(UNIT_B)]);
    });

    it('answers 409 SNAPSHOT_EXPIRED, naming the snapshot to ask again for, once the 30 minutes of a token have gone', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const token = tokenOf(units, UNIT_A);
      CLOCK.now = new Date(Date.now() + 31 * 60_000);
      const expired = await explain(token, 'fund_source');
      expect([expired.status, expired.json.code]).toEqual([409, 'SNAPSHOT_EXPIRED']);
      expect(expired.json).toMatchObject({ snapshot_id: snap.version });
    });

    it('AC-ST-BI-004-1: UAT-AC34 refreshes a context onto the newest snapshot of the period with the old one as its parent, and keeps serving the old token until it expires', async () => {
      const a = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION }]);
      await built(a);
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: a.version, dimensions: ['unit'] });
      await app.seedReplica([["update machvon.period_snapshot set status = 'SUPERSEDED' where id = '" + a.id + "'", []]]);
      const b = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: 9 * BILLION, plan: 10 * BILLION }], { code: a.code, periodId: a.periodId });
      await built(b);
      const refreshed = await app.call('POST', '/bi/query-contexts/refresh', { member: ANALYST_ALL, body: { drill_token: units.json.drill_token } });
      expect(refreshed.status).toBe(200);
      expect(refreshed.json).toMatchObject({ snapshot_id: b.version, as_of_period: a.code, parent_context_id: units.json.resource_id });
      const onNew = await explain(refreshed.json.drill_token as string, 'fund_source');
      expect([onNew.status, onNew.json.snapshot_id, total(onNew).value]).toEqual([200, b.version, '9000000000']);
      const onOld = await explain(units.json.drill_token as string, 'fund_source');
      expect([onOld.status, onOld.json.snapshot_id, total(onOld).value]).toEqual([200, a.version, '4000000000']);
      const bad = await app.call('POST', '/bi/query-contexts/refresh', { member: ANALYST_ALL, body: { drill_token: 'x'.repeat(40) } });
      expect([bad.status, bad.json.code]).toEqual([400, 'DRILL_TOKEN_INVALID']);
      expect((await audits('bi.drill_refresh_denied')).length).toBe(1);
    });

    it('records as denied the context token of a query and the token of a refresh that is not the own of the reader (another member, another tenant, unreadable), with the same 400', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const token = units.json.drill_token as string;
      const claims = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString()) as { ctx_id: string; scope_hash: string; metric_version_id: string; snapshot_id: string; as_of_period: string };
      const ofTenantB = signBiDrill({ tid: TENANT_B, ctx_id: claims.ctx_id, scope_hash: claims.scope_hash, metric_version_id: claims.metric_version_id, snapshot_id: claims.snapshot_id, as_of_period: claims.as_of_period }, DRILL_KEY, '1');
      const queries = await audits('bi.query_denied');
      const refreshes = await audits('bi.drill_refresh_denied');
      const body = { metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['fund_source'], filters: [] };
      for (const [bad, member] of [['x'.repeat(40), ANALYST_ALL], [ofTenantB, ANALYST_ALL], [token, ANALYST_BRANCH]] as const) {
        const reply = await app.call('POST', '/dashboard-queries', { member, body: { ...body, context_token: bad } });
        expect([reply.status, reply.json.code]).toEqual([400, 'DRILL_TOKEN_INVALID']);
      }
      const recorded = await audits('bi.query_denied');
      expect(recorded.length - queries.length).toBe(3);
      expect(recorded.slice(queries.length).every((entry) => entry.safe_diff.code === 'DRILL_TOKEN_INVALID')).toBe(true);
      for (const [bad, member] of [[ofTenantB, ANALYST_ALL], [token, ANALYST_BRANCH]] as const) {
        const reply = await app.call('POST', '/bi/query-contexts/refresh', { member, body: { drill_token: bad } });
        expect([reply.status, reply.json.code]).toEqual([400, 'DRILL_TOKEN_INVALID']);
      }
      const refused = await audits('bi.drill_refresh_denied');
      expect(refused.length - refreshes.length).toBe(2);
      expect(refused.slice(refreshes.length).every((entry) => entry.safe_diff.code === 'DRILL_TOKEN_INVALID')).toBe(true);
    });

    it('cuts the children of a drill at the limit asked, says so, and keeps the reconciliation of the whole', async () => {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 4 * BILLION, plan: 10 * BILLION },
        { project: 'P2', unit: UNIT_A, fund: fundY, paid: 6 * BILLION, plan: 20 * BILLION },
      ]);
      await built(snap);
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const whole = await explain(tokenOf(units, UNIT_A), 'fund_source');
      expect(rows(whole).length).toBe(2);
      expect(whole.json.truncated).toBe(false);
      const cut = await explain(tokenOf(units, UNIT_A), 'fund_source', ANALYST_ALL, undefined, 1);
      expect(rows(cut).length).toBe(1);
      expect(rows(cut)[0]?.drill_token).not.toBeNull();
      expect(cut.json.truncated).toBe(true);
      expect(cut.json.reconciles_to_parent).toBe(true);
      expect(total(cut).value).toBe('10000000000');
    });

    it('lists the contexts of the reader and opens one, and not the context of another member', async () => {
      const snap = await world();
      const units = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      const own = await app.call('GET', '/resources/drill_context', { member: ANALYST_ALL });
      expect((own.json.items as unknown[]).length).toBeGreaterThanOrEqual(3);
      const id = units.json.resource_id as string;
      const one = await app.call('GET', `/resources/drill_context/${id}`, { member: ANALYST_ALL });
      expect(one.json).toMatchObject({ id, snapshot_id: snap.version, as_of_period: snap.code, dimension_path: ['unit'] });
      expect((await app.call('GET', `/resources/drill_context/${id}`, { member: ANALYST_BRANCH })).status).toBe(404);
      expect((await app.call('GET', '/resources/drill_context', { member: ANALYST_BRANCH })).json.items).toEqual([]);
    });
  });
});
