import { randomUUID } from 'node:crypto';
import { BiDatasetStore, BiQueryStore, WORKER_MEMBERSHIP_ID, loadAccessIn } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { stageTwoSums } from '@machvon/kernel';
import { BiQueryEngine } from '../../src/modules/bi/query-engine';
import { parseExportSpec } from '../../src/modules/bi/export-runner';
import { ANALYST_ALL, ANALYST_BRANCH, BUILDER, BiApp, CLOCK, DATASET, PIPELINE, TENANT_A, UNIT_A, UNIT_B, UNIT_C, UNIT_OUT, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(240_000);

/**
 * CA-1, part 1: the query engine reads a dataset through its adapter, a measure of two stages (group, then aggregate: shares, squared shares, top N) and a series over periods. DS-DISB is the dataset it all runs on
 * here, through the same door a contract dataset will use; the contract dataset DS-CTR has its source since part 2 (the contract fact frozen with a period: see ctr/contract-analytics.test.ts and bi-contract-dataset.test.ts). The agreement tests recompute every figure from the raw
 * lines (the concentration metrics are not additive, so "the total is the sum of the rows" is not the check: the second stage is recomputed from the groups of the first).
 */

const app = new BiApp();
const BILLION = 1_000_000_000;
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const num = (value: number) => ({ op: 'const', value });
const METRICS = [
  { code: 'disbursed', grain: 'project', aggregation_type: 'additive', expression: sum('GIAI_NGAN'), unit: 'VND', effective_from: '2026-01-01' },
  {
    code: 'top2_share',
    grain: 'project',
    aggregation_type: 'ratio',
    numerator: { op: 'top_n_sum', args: [sum('GIAI_NGAN'), num(2)] },
    denominator: sum('GIAI_NGAN'),
    unit: 'percent',
    effective_from: '2026-01-01',
  },
  {
    code: 'hhi',
    grain: 'project',
    aggregation_type: 'ratio',
    numerator: { op: 'mul', args: [num(100), { op: 'sum_of_squares', args: [sum('GIAI_NGAN')] }] },
    denominator: { op: 'mul', args: [sum('GIAI_NGAN'), sum('GIAI_NGAN')] },
    unit: 'index',
    effective_from: '2026-01-01',
  },
  { code: 'ctr_paid_rate', grain: 'contract', aggregation_type: 'ratio', numerator: sum('PAID'), denominator: sum('ACCEPTED'), unit: 'percent', effective_from: '2026-01-01' },
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
}
const projects = new Map<string, string>();

/** A reporting period and a frozen close snapshot of it with the lines given (money in dong). */
async function snapshot(lines: LineSeed[], options: { code?: string } = {}): Promise<{ id: string; code: string; version: string }> {
  counter += 1;
  const code = options.code ?? `2030-${String(counter).padStart(2, '0')}`;
  const periodId = randomUUID();
  const id = randomUUID();
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2030-01-01' + $6::int * 40, date '2030-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2030, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, counter],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2030-10-31', date '2030-10-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', $4, $5, $6::uuid, $7::timestamptz, $8::uuid, $8::uuid)`,
      [TENANT_A, id, periodId, lines.length, 'c'.repeat(64), WORKER_MEMBERSHIP_ID, new Date().toISOString(), WORKER_MEMBERSHIP_ID],
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
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, 'CENTRAL', $7::numeric, 0, $7::numeric, $8::numeric, 'NO_DATA', 'COMPLETE')`,
      [TENANT_A, id, projectId, unitId(line.unit), line.fund, line.bucket ?? 'CURRENT_YEAR', line.plan, line.paid],
    ]);
  }
  await app.seedReplica(statements);
  const reply = await app.call('POST', `/bi/datasets/${DATASET}/versions`, { member: BUILDER, body: { as_of_period: code } });
  expect(reply.status).toBe(202);
  return { id, code, version: reply.json.resource_id as string };
}

const query = (body: Record<string, unknown>, member = ANALYST_ALL): Promise<Reply> => app.call('POST', '/dashboard-queries', { member, body: { filters: [], dimensions: [], ...body } });
const rows = (reply: Reply): Array<Record<string, unknown>> => reply.json.children as Array<Record<string, unknown>>;
const total = (reply: Reply): Record<string, unknown> => reply.json.total as Record<string, unknown>;

async function open(roleNumber: number): Promise<void> {
  await app.seedReplica([
    [
      `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, 1, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)`,
      [TENANT_A, randomUUID(), DATASET, roleId(roleNumber), memberId(BUILDER), memberId(PIPELINE)],
    ],
  ]);
}

/** The engine, as the controller drives it, for the member and the metric. */
async function engineRead(tx: TenantTx, member: number, metric: string, snapshotId: string) {
  const access = await loadAccessIn(tx, memberId(member));
  const engine = new BiQueryEngine();
  const reading = await engine.read(tx, memberId(member), access, metricIds[metric] as string, snapshotId, new Date());
  if (reading.denied !== undefined) throw new Error(reading.denied);
  return { engine, access, read: reading.value };
}

describe('CA-1 part 1: the engine reads datasets through adapters, two-stage measures and series', () => {
  beforeAll(async () => {
    await app.start();
    const { key, sha256 } = await app.bundle(METRICS);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'two-stage1', bundle_object_key: key, bundle_sha256: sha256 } })).status).toBe(200);
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    for (const item of listed.json.items as Array<{ id: string; code: string }>) metricIds[item.code] = item.id;
    await open(9);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(async () => {
    CLOCK.now = new Date();
    await app.seedReplica([['delete from machvon.bi_query_run', []], ['delete from machvon.drill_context', []], ['delete from machvon.bi_dataset_version', []], ['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.reporting_period', []]]);
  });

  describe('a measure of two stages', () => {
    const lines: LineSeed[] = [
      { project: 'P1', unit: UNIT_A, fund: fundX, paid: 600 * BILLION, plan: 700 * BILLION },
      { project: 'P2', unit: UNIT_B, fund: fundX, paid: 200 * BILLION, plan: 300 * BILLION },
      { project: 'P3', unit: UNIT_B, fund: fundY, paid: 100 * BILLION, plan: 100 * BILLION },
      { project: 'P4', unit: UNIT_C, fund: null, paid: 100 * BILLION, plan: 100 * BILLION },
    ];

    it('the HHI by unit is the sum of the squared shares: 60, 30 and 10 percent are 4600.00, and the top 2 hold 90.00 percent; each group is shown as its share', async () => {
      const snap = await snapshot(lines);
      const hhi = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['unit'] });
      expect(hhi.status).toBe(200);
      // (600^2 + 300^2 + 100^2) x 100 over 1000^2, in dong: the second stage is one sum of squares over the square of the total.
      const squares = BigInt(600 * BILLION) ** 2n + BigInt(300 * BILLION) ** 2n + BigInt(100 * BILLION) ** 2n;
      expect(total(hhi)).toMatchObject({ value: '4600.00', numerator: (squares * 100n).toString(), denominator: (BigInt(1000 * BILLION) ** 2n).toString(), null_reason: null });
      const byUnit = Object.fromEntries(rows(hhi).map((row) => [row.key, row]));
      expect(byUnit[unitId(UNIT_A)]).toMatchObject({ value: '60.00', numerator: String(600 * BILLION), denominator: String(1000 * BILLION) });
      expect(byUnit[unitId(UNIT_B)]).toMatchObject({ value: '30.00' });
      expect(byUnit[unitId(UNIT_C)]).toMatchObject({ value: '10.00' });
      expect(hhi.json).toMatchObject({ reconciles_to_parent: true, non_additive_reason: null });
      const top = await query({ metric_version_id: metricIds.top2_share, snapshot_id: snap.version, dimensions: ['unit'] });
      expect(total(top)).toMatchObject({ value: '90.00', numerator: String(900 * BILLION), denominator: String(1000 * BILLION) });
      expect(top.json).toMatchObject({ reconciles_to_parent: true });
    });

    it('agrees with the recomputation from the raw lines under every dimension, the groups of the first stage added up and squared by the kernel (R16)', async () => {
      const snap = await snapshot(lines);
      const raw: Record<string, Map<string | null, bigint>> = { unit: new Map(), project: new Map(), fund_source: new Map() };
      for (const line of lines) {
        const keys: Record<string, string | null> = { unit: unitId(line.unit), project: projects.get(`${line.project}@${line.unit}`) as string, fund_source: line.fund };
        for (const dimension of Object.keys(raw)) (raw[dimension] as Map<string | null, bigint>).set(keys[dimension] as string | null, ((raw[dimension] as Map<string | null, bigint>).get(keys[dimension] as string | null) ?? 0n) + BigInt(line.paid ?? 0));
      }
      for (const dimension of ['unit', 'project', 'fund_source']) {
        for (const metric of ['hhi', 'top2_share']) {
          const reply = await query({ metric_version_id: metricIds[metric], snapshot_id: snap.version, dimensions: [dimension] });
          expect(reply.status).toBe(200);
          const values = [...(raw[dimension] as Map<string | null, bigint>).values()].map((value) => value.toString());
          const plan = metric === 'hhi' ? { numeratorColumn: 'x', denominatorColumn: 'x', kind: 'RATIO' as const, nullPolicy: 'NULL_NOT_ZERO' as const, twoStage: { numerator: { op: 'SUM_OF_SQUARES' as const, n: null, multiplier: '100' }, denominator: { op: 'TOTAL_SQUARED' as const, n: null, multiplier: '1' } } } : { numeratorColumn: 'x', denominatorColumn: 'x', kind: 'RATIO' as const, nullPolicy: 'NULL_NOT_ZERO' as const, twoStage: { numerator: { op: 'TOP_N_SUM' as const, n: 2, multiplier: '1' }, denominator: { op: 'SUM' as const, n: null, multiplier: '1' } } };
          const again = stageTwoSums(plan, values);
          expect(total(reply)).toMatchObject({ numerator: again.numerator, denominator: again.denominator });
          // The rows are the groups: their values are the raw sums, a group with no unit or fund is shown under no key.
          expect(rows(reply).map((row) => BigInt(row.numerator as string)).sort()).toEqual([...(raw[dimension] as Map<string | null, bigint>).values()].sort());
          expect(reply.json).toMatchObject({ reconciles_to_parent: true });
        }
      }
    });

    it('counts the group with no value in the dimension as a group of the second stage (800, 100 and 100 of the funding sources are 6600.00), and narrows by a filter before the first stage', async () => {
      const snap = await snapshot([...lines, { project: 'P5', unit: UNIT_A, fund: fundY, paid: 50 * BILLION, plan: 0, bucket: 'CARRYOVER' }]);
      const hhi = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['fund_source'], filters: [{ field: 'bucket', operator: 'eq', value: 'CURRENT_YEAR' }] });
      expect(total(hhi).value).toBe('6600.00');
      expect(rows(hhi).find((row) => row.unclassified)).toMatchObject({ key: null, value: '10.00' });
      const all = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['fund_source'] });
      // 800, 150 and 100 of 1050 once the carry-over line is in: (800^2 + 150^2 + 100^2) / 1050^2 = 0.60997...
      expect(total(all).value).toBe('6099.77');
    });

    it('is cut by the scope of the reader before the first stage: the branch sees 4600.00 and the whole tenant, with a unit outside the branch, 3650.00', async () => {
      const snap = await snapshot([...lines, { project: 'P9', unit: UNIT_OUT, fund: fundX, paid: 1000 * BILLION, plan: 1000 * BILLION }]);
      const branch = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_BRANCH);
      expect(total(branch).value).toBe('4600.00');
      expect(rows(branch).map((row) => row.key)).not.toContain(unitId(UNIT_OUT));
      expect(JSON.stringify(branch.json)).not.toContain(unitId(UNIT_OUT));
      const whole = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['unit'] }, ANALYST_ALL);
      expect(total(whole).value).toBe('3650.00');
    });

    it('is NOT_APPLICABLE over a total of zero, never 0, and asks for a dimension: the groups are what it is made of', async () => {
      const snap = await snapshot([
        { project: 'P1', unit: UNIT_A, fund: fundX, paid: 0, plan: 5 },
        { project: 'P2', unit: UNIT_B, fund: fundX, paid: 0, plan: 5 },
      ]);
      const zero = await query({ metric_version_id: metricIds.hhi, snapshot_id: snap.version, dimensions: ['unit'] });
      expect(total(zero)).toMatchObject({ value: null, null_reason: 'NOT_APPLICABLE' });
      const none = await query({ metric_version_id: metricIds.top2_share, snapshot_id: snap.version });
      expect([none.status, none.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('is the same plain figure as before for the plain metrics of the same snapshot: a plain query is untouched by the second stage', async () => {
      const snap = await snapshot(lines);
      const plain = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['unit'] });
      expect(total(plain).value).toBe(String(1000 * BILLION));
      expect(rows(plain).map((row) => row.value).sort()).toEqual([String(100 * BILLION), String(300 * BILLION), String(600 * BILLION)].sort());
    });
  });

  describe('a series over periods', () => {
    const jan: LineSeed[] = [
      { project: 'P1', unit: UNIT_A, fund: fundX, paid: 600 * BILLION, plan: 1 },
      { project: 'P2', unit: UNIT_B, fund: fundX, paid: 400 * BILLION, plan: 1 },
    ];
    const feb: LineSeed[] = [
      { project: 'P1', unit: UNIT_A, fund: fundX, paid: 500 * BILLION, plan: 1 },
      { project: 'P2', unit: UNIT_B, fund: fundX, paid: 500 * BILLION, plan: 1 },
      { project: 'P3', unit: UNIT_C, fund: fundX, paid: 0, plan: 1 },
    ];

    it('gives one point per period with the same figure as the period asked alone, a gap for a period with no frozen version, and the change between points', async () => {
      const first = await snapshot(jan, { code: '2031-01' });
      const second = await snapshot(feb, { code: '2031-02' });
      const periods = ['2031-01', '2031-02', '2031-03'];
      await app.harness.tenants.withTenant(app.contextOf(ANALYST_ALL), async (tx: TenantTx) => {
        const additive = await engineRead(tx, ANALYST_ALL, 'disbursed', first.version);
        const series = await additive.engine.series(tx, additive.read, periods, undefined, [], additive.access, new Date());
        expect(series.points.map((point) => [point.period, point.figure.value, point.missing, point.changeFromPrevious])).toEqual([
          ['2031-01', String(1000 * BILLION), false, null],
          ['2031-02', String(1000 * BILLION), false, '0'],
          ['2031-03', null, true, null],
        ]);
        expect(series.points[2]).toMatchObject({ versionId: null, figure: { nullReason: 'NO_DATA' } });
        expect(series.points[0]?.versionId).toBe(first.version);
        expect(series.points[1]?.versionId).toBe(second.version);

        // HHI by unit per period: 60/40 then 50/50 (the unit of the third line has nothing), 5200.00 then 5000.00, and each point is the figure of that period asked alone.
        const index = await engineRead(tx, ANALYST_ALL, 'hhi', first.version);
        const hhi = await index.engine.series(tx, index.read, periods, 'unit', [], index.access, new Date());
        expect(hhi.points.map((point) => point.figure.value)).toEqual(['5200.00', '5000.00', null]);
        expect(hhi.points[1]?.changeFromPrevious).toBe('-200.00');
        const alone = await engineRead(tx, ANALYST_ALL, 'hhi', second.version);
        const single = await alone.engine.compute(tx, alone.read, 'unit', [], alone.access, new Date());
        expect(single.total.numerator).toBe(hhi.points[1]?.sums?.numerator);
        expect(single.total.denominator).toBe(hhi.points[1]?.sums?.denominator);
        // A measure of two stages in a series needs its dimension.
        await expect(index.engine.series(tx, index.read, periods, undefined, [], index.access, new Date())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    });

    it('adds the groups of each period for a plain metric cut by a dimension, and the groups add up to the point', async () => {
      const first = await snapshot(jan, { code: '2031-01' });
      await snapshot(feb, { code: '2031-02' });
      await app.harness.tenants.withTenant(app.contextOf(ANALYST_ALL), async (tx: TenantTx) => {
        const additive = await engineRead(tx, ANALYST_ALL, 'disbursed', first.version);
        const series = await additive.engine.series(tx, additive.read, ['2031-02', '2031-01'], 'unit', [], additive.access, new Date());
        // The periods come back in the order they were given, whatever it was: the caller sorts them (seriesPeriods); the engine keeps the order of its input.
        expect(series.points.map((point) => point.period)).toEqual(['2031-02', '2031-01']);
        for (const group of series.groups) {
          const point = series.points.find((candidate) => candidate.period === group.period);
          expect(group.rows.reduce((acc, row) => acc + BigInt(row.numerator ?? '0'), 0n).toString()).toBe(point?.figure.value);
        }
        expect(series.groups.find((group) => group.period === '2031-02')?.rows).toHaveLength(3);
      });
    });

    it('reads a period under the scope of the reader, not the whole tenant', async () => {
      const first = await snapshot([...jan, { project: 'P9', unit: UNIT_OUT, fund: fundX, paid: 1000 * BILLION, plan: 1 }], { code: '2031-01' });
      await app.harness.tenants.withTenant(app.contextOf(ANALYST_BRANCH), async (tx: TenantTx) => {
        const branch = await engineRead(tx, ANALYST_BRANCH, 'disbursed', first.version);
        const series = await branch.engine.series(tx, branch.read, ['2031-01'], undefined, [], branch.access, new Date());
        expect(series.points[0]?.figure.value).toBe(String(1000 * BILLION));
      });
      await app.harness.tenants.withTenant(app.contextOf(ANALYST_ALL), async (tx: TenantTx) => {
        const whole = await engineRead(tx, ANALYST_ALL, 'disbursed', first.version);
        const series = await whole.engine.series(tx, whole.read, ['2031-01'], undefined, [], whole.access, new Date());
        expect(series.points[0]?.figure.value).toBe(String(2000 * BILLION));
      });
    });

    it('finds the frozen version of each period and leaves out the periods that have none', async () => {
      await snapshot(jan, { code: '2031-01' });
      const second = await snapshot(feb, { code: '2031-02' });
      await app.harness.tenants.withTenant(app.contextOf(ANALYST_ALL), async (tx: TenantTx) => {
        const found = await new BiQueryStore().frozenVersionsOfPeriods(tx, 'DS-DISB', ['2031-02', '2031-04']);
        expect(found).toEqual([{ period: '2031-02', versionId: second.version, sourceSnapshotId: expect.any(String), qualityBadge: 'NOT_ASSESSED' }]);
        expect(await new BiQueryStore().frozenVersionsOfPeriods(tx, 'DS-CTR', ['2031-02'])).toEqual([]);
        const named = await new BiQueryStore().versionOfSnapshotAny(tx, second.version);
        expect(named).toMatchObject({ datasetCode: 'DS-DISB', periodCode: '2031-02', versionStatus: 'FROZEN' });
        expect(await new BiQueryStore().versionOfSnapshotAny(tx, randomUUID())).toBeUndefined();
      });
    });
  });

  describe('the contract dataset is registered and has its source (the contract fact of part 2)', () => {
    it('answers 422 for a metric of the contract fields over a snapshot that is not there, and that a snapshot of another dataset cannot compute it', async () => {
      const snap = await snapshot([{ project: 'P1', unit: UNIT_A, fund: fundX, paid: BILLION, plan: BILLION }]);
      const unreadable = await query({ metric_version_id: metricIds.ctr_paid_rate, snapshot_id: randomUUID(), dimensions: ['unit'] });
      // There is no snapshot to say which dataset the metric is of: it is planned over the default one, whose fields it does not read.
      expect([unreadable.status, unreadable.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      // Over a snapshot of the disbursement dataset the metric reads fields that dataset does not have, as before.
      const wrong = await query({ metric_version_id: metricIds.ctr_paid_rate, snapshot_id: snap.version, dimensions: ['unit'] });
      expect([wrong.status, wrong.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      // A dimension only the contract dataset offers is not in the disbursement dataset.
      const dimension = await query({ metric_version_id: metricIds.disbursed, snapshot_id: snap.version, dimensions: ['investor'] });
      expect([dimension.status, dimension.json.code]).toEqual([422, 'DIMENSION_NOT_IN_DATASET']);
    });

    it('makes the contract dataset of the tenant once, finds the disbursement one, and knows no other', async () => {
      await app.harness.tenants.withTenant(app.contextOf(BUILDER), async (tx: TenantTx) => {
        const datasets = new BiDatasetStore();
        const contractId = await datasets.ensureDataset(tx, 'DS-CTR', memberId(BUILDER));
        expect(await datasets.ensureContractDataset(tx, memberId(BUILDER))).toBe(contractId);
        expect(await datasets.find(tx, contractId)).toMatchObject({ datasetCode: 'DS-CTR', sourceKind: 'CONTRACT_FACT', grain: 'contract_party', latest: null });
        await expect(datasets.ensureDataset(tx, 'DS-NOPE', memberId(BUILDER))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
        expect(await datasets.ensureDataset(tx, 'DS-DISB', memberId(BUILDER))).toBe(DATASET);
        expect(await datasets.ensureDisbursementDataset(tx, memberId(BUILDER))).toBe(DATASET);
      });
    });

    it('an export spec names a dataset that exists, or none', () => {
      const spec = { metric_version_id: randomUUID(), dimensions: ['unit'] };
      expect(parseExportSpec({ ...spec, dataset_code: 'DS-CTR' }, '2031-01', undefined)).toMatchObject({ datasetCode: 'DS-CTR', asOfPeriod: '2031-01' });
      expect(parseExportSpec(spec, '2031-01', undefined).datasetCode).toBeUndefined();
      expect(() => parseExportSpec({ ...spec, dataset_code: 'DS-NOPE' }, undefined, undefined)).toThrow();
      expect(() => parseExportSpec({ ...spec, dataset_code: 5 }, undefined, undefined)).toThrow();
      // A dimension of the contract dataset passes the first filter; the dataset of the snapshot has the last word.
      expect(parseExportSpec({ ...spec, dimensions: ['investor'] }, '2031-01', undefined).dimension).toBe('investor');
      expect(() => parseExportSpec({ ...spec, dimensions: ['nothing'] }, '2031-01', undefined)).toThrow();
    });
  });
});
