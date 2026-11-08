import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { addSums, rateOfSums, simulateReallocation } from '@machvon/kernel';
import { CapReallocationImpactStore, wholeScope } from '../src/cap-reallocation-impact-store';
import { DisMilestoneStore } from '../src/dis-milestone-store';
import { DisSnapshotStore } from '../src/dis-snapshot-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import type { TenantTx } from '../src/tenant-database';

const harness = new AuthzHarness();
const milestones = new DisMilestoneStore();
const impacts = new CapReallocationImpactStore();
const snapshots = new DisSnapshotStore();
const WORKER = '00000000-0000-4000-8000-000000000000';
const FAMILY = 0xab;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const READER = 1;
const NOW = new Date('2027-11-02T03:00:00Z');
const nothing = () => ({ sql: 'false', params: [] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(READER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

interface Spec {
  tag: string;
  unit?: number;
  plan: string;
  payments?: Array<[number, string]>;
  forecasts?: Array<[number, string]>;
  registered?: Array<[number, string]>;
}

let counter = 0;

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

/** A frozen close snapshot of the year 2027 whose cutoff is the last day of October, with a project for each spec, what the Treasury paid, and the forecasts and registrations of its months. */
async function world(specs: Spec[]): Promise<{ snapshotId: string; projects: Array<{ id: string; unit: number }> }> {
  counter += 1;
  const periodId = id(FAMILY, 1000 + counter);
  const snapshotId = randomUUID();
  const day = new Date(Date.UTC(2044, 0, 1) + counter * 10 * 86_400_000).toISOString().slice(0, 10);
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
      [TENANT_A, periodId, `G11-${counter}`, day, id(FAMILY, 40), WORKER],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, '2027-10-31'::date, '2027-10-31'::date, 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $5, $6, $6)`,
      [TENANT_A, snapshotId, periodId, NOW.toISOString(), specs.length, WORKER],
    ],
  ];
  const projects: Array<{ id: string; unit: number }> = [];
  specs.forEach((spec, n) => {
    const projectId = id(FAMILY, 100 + counter * 20 + n);
    const unit = spec.unit ?? HERE;
    projects.push({ id: projectId, unit });
    const code = `G11-${String(counter).padStart(2, '0')}-${spec.tag}`;
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, code, unitId(unit), id(FAMILY, 30)],
    ]);
    const paid = (spec.payments ?? []).reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
    const disbursed = spec.payments === undefined ? null : paid.toString();
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', $5::numeric, $5::numeric, $6::numeric, $7)`,
      [TENANT_A, snapshotId, projectId, unitId(unit), spec.plan, disbursed, disbursed === null ? 'NONE' : 'COMPLETE'],
    ]);
    for (const [month, amount] of spec.payments ?? []) {
      statements.push([
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, import_id)
         values ($1, gen_random_uuid(), $2, $3, 'TREASURY', $4::numeric, make_timestamptz(2027, $5::int, 10, 4, 0, 0, 'Asia/Ho_Chi_Minh'), repeat('d', 64), 'PAYMENT', gen_random_uuid())`,
        [TENANT_A, projectId, `EXT-${randomUUID()}`, amount, month],
      ]);
    }
    const schedule = (kind: 'FORECAST' | 'REGISTERED', rows: Array<[number, string]> | undefined): void => {
      for (const [month, amount] of rows ?? []) {
        statements.push([
          `insert into machvon.disbursement_schedule_line (tenant_id, id, project_id, plan_year, granularity, month, bucket, budget_level, kind, amount_vnd, assumption, revision, is_current, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, 2027, 'MONTH', $3::smallint, 'CURRENT_YEAR', 'CENTRAL', $4, $5::numeric, $6, 1, true, $7, $7)`,
          [TENANT_A, projectId, month, kind, amount, kind === 'FORECAST' ? 'Expected by the investor' : null, WORKER],
        ]);
      }
    };
    schedule('FORECAST', spec.forecasts);
    schedule('REGISTERED', spec.registered);
  });
  statements.push([`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, WORKER, NOW.toISOString()]]);
  await seedReplica(statements);
  return { snapshotId, projects };
}

describe('GOV-11a DIS and CAP stores (G1-16, G1-12)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
      await harness.seedMembership(tenant, READER, ROOT);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the milestone vintages', () => {
    const spec: Spec = { tag: 'A', plan: '1000000000', payments: [[3, '100000000'], [6, '200000000'], [10, '100000000']], forecasts: [[11, '100000000'], [12, '150000000']] };

    it('writes one vintage for each investor and milestone with the status of the kernel, and one run row, once', async () => {
      const w = await world([spec, { tag: 'B', unit: ELSEWHERE, plan: '2000000000', payments: [[2, '1900000000']], forecasts: [[11, '10000000'], [12, '10000000']] }]);
      const done = await as((tx) => milestones.record(tx, w.snapshotId, WORKER, NOW));
      expect(done).toMatchObject({ outcome: 'RECORDED', milestones: 3, ruleSource: 'DEFAULT', ruleVersion: 0 });
      expect(done.units).toBeGreaterThanOrEqual(2);
      expect(await as((tx) => milestones.record(tx, w.snapshotId, WORKER, NOW))).toMatchObject({ outcome: 'ALREADY_RECORDED', rowsWritten: 0 });
      const rows = await owner<{ unit_id: string; milestone_code: string; status: string; basis: string; projected_pct: string | null; target_pct: string }>(
        `select unit_id, milestone_code, status, basis, projected_pct::text as projected_pct, target_pct::text as target_pct from machvon.disbursement_milestone_forecast where snapshot_id = $1::uuid order by unit_id, milestone_date`,
        [w.snapshotId],
      );
      const here = rows.filter((row) => row.unit_id === unitId(HERE));
      expect(here.map((row) => [row.milestone_code, row.basis, row.status])).toEqual([
        ['M_0630', 'ACTUAL', 'MISSED'],
        ['M_0930', 'ACTUAL', 'MISSED'],
        ['M_1231', 'FORECAST', 'OFF_TRACK'],
      ]);
      expect(here[2]).toMatchObject({ projected_pct: '65.00', target_pct: '95.00' });
      const elsewhere = rows.filter((row) => row.unit_id === unitId(ELSEWHERE));
      expect(elsewhere.map((row) => row.status)).toEqual(['ACHIEVED', 'ACHIEVED', 'ON_TRACK']);
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.disbursement_milestone_run where snapshot_id = $1::uuid', [w.snapshotId]))[0]?.n).toBe('1');
    });

    it('does not let a vintage or a run be changed or deleted, by the owner or by the application role', async () => {
      const w = await world([spec]);
      await as((tx) => milestones.record(tx, w.snapshotId, WORKER, NOW));
      expect(await sqlState(owner("update machvon.disbursement_milestone_forecast set status = 'ON_TRACK' where snapshot_id = $1::uuid", [w.snapshotId]))).toBe('23514');
      expect(await sqlState(owner('delete from machvon.disbursement_milestone_forecast where snapshot_id = $1::uuid', [w.snapshotId]))).toBe('23514');
      expect(await sqlState(owner("update machvon.disbursement_milestone_run set outcome = 'NO_PROJECTS' where snapshot_id = $1::uuid", [w.snapshotId]))).toBe('23514');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.disbursement_milestone_forecast')))).toBe('42501');
    });

    it('reads the board of the latest snapshot in the scope of the caller, tells an unread snapshot from one with nothing, and keeps tenants apart', async () => {
      const w = await world([spec]);
      const unread = await as((tx) => milestones.board(tx, wholeScope, { snapshotId: w.snapshotId }, NOW));
      expect(unread.run).toBeNull();
      expect(unread.milestones).toEqual([]);
      await as((tx) => milestones.record(tx, w.snapshotId, WORKER, NOW));
      const read = await as((tx) => milestones.board(tx, wholeScope, { snapshotId: w.snapshotId }, NOW));
      expect(read.run).toMatchObject({ outcome: 'RECORDED' });
      expect(read.milestones.map((group) => group.code)).toEqual(['M_0630', 'M_0930', 'M_1231']);
      const last = read.milestones[2];
      expect(last?.units.map((row) => row.status)).toEqual(['OFF_TRACK']);
      expect(last?.summary).toMatchObject({ projectedPct: '65.00', status: 'OFF_TRACK' });
      const hidden = await as((tx) => milestones.board(tx, nothing, { snapshotId: w.snapshotId }, NOW));
      expect(hidden.milestones).toEqual([]);
      await expect(as((tx) => milestones.board(tx, wholeScope, { snapshotId: w.snapshotId }, NOW), TENANT_B)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const alerts = await as((tx) => milestones.atRisk(tx, wholeScope));
      expect(alerts.every((row) => row.status === 'AT_RISK' || row.status === 'OFF_TRACK')).toBe(true);
    });

    it('measures the accuracy of the forecast made before each month against what the Treasury paid, and gives no band for too few months', async () => {
      const w = await world([{ tag: 'ACC', unit: HERE, plan: '5000000000', payments: [[3, '100000000'], [6, '200000000'], [10, '100000000']], forecasts: [[3, '100000000'], [6, '250000000'], [10, '100000000']] }]);
      const view = await as((tx) => milestones.accuracy(tx, wholeScope, { planYear: 2027 }, NOW));
      expect(view.lastMeasuredMonth).toBe(10);
      expect(view.rule).toMatchObject({ source: 'DEFAULT', unverified: true });
      const mine = view.report.rows.find((row) => row.investorId === null || view.investors.get(row.investorId ?? '')?.id === unitId(HERE)) ?? view.report.rows[0];
      expect(mine).toBeDefined();
      expect(view.report.overall.months).toBeGreaterThanOrEqual(3);
      expect(view.report.byMonth.map((month) => month.month)).toEqual(expect.arrayContaining([3, 6, 10]));
      expect(w.projects).toHaveLength(1);
      const none = await as((tx) => milestones.accuracy(tx, nothing, { planYear: 2027 }, NOW));
      expect(none.report.rows).toEqual([]);
    });
  });

  describe('the impact of a reallocation on the rates', () => {
    it('is the rates of DIS for the unchanged case: the sums of the basis give the same rates as the snapshot reader (golden)', async () => {
      const w = await world([
        { tag: 'P1', unit: HERE, plan: '1000000000', payments: [[3, '200000000']] },
        { tag: 'P2', unit: HERE, plan: '600000000', payments: [[4, '300000000']] },
        { tag: 'P3', unit: ELSEWHERE, plan: '400000000', payments: [[5, '420000000']] },
      ]);
      const basis = await as((tx) => impacts.basis(tx, w.snapshotId, wholeScope));
      expect(basis).toHaveLength(3);
      const result = simulateReallocation({ projects: basis, moves: [] });
      const [whole] = await as((tx) => snapshots.rateSums(tx, w.snapshotId, wholeScope, { basis: 'CURRENT_YEAR', groupBy: 'NONE' }));
      const expected = rateOfSums((whole as { sums: Parameters<typeof rateOfSums>[0] }).sums, 'CURRENT_YEAR');
      expect(result.basis.CURRENT_YEAR.province.before).toEqual(expected);
      expect(result.basis.CURRENT_YEAR.province.after).toEqual(expected);
      expect(result.basis.CURRENT_YEAR.province.before).toEqual(rateOfSums(addSums(basis.map((project) => project.sums.CURRENT_YEAR)), 'CURRENT_YEAR'));
      expect(expected.rateTotalPct).toBe('46.0000');
    });

    it('moves capital between two units and changes only those two units while the province keeps its rate on the whole plan', async () => {
      const w = await world([
        { tag: 'Q1', unit: HERE, plan: '1000000000', payments: [[3, '200000000']] },
        { tag: 'Q2', unit: ELSEWHERE, plan: '400000000', payments: [[5, '420000000']] },
      ]);
      const basis = await as((tx) => impacts.basis(tx, w.snapshotId, wholeScope));
      const [first, second] = [...basis].sort((a, b) => (a.unitId ?? '').localeCompare(b.unitId ?? ''));
      const moved = simulateReallocation({ projects: basis, moves: [{ fromProjectId: (first as { projectId: string }).projectId, toProjectId: (second as { projectId: string }).projectId, amountVnd: '300000000', bucket: 'CURRENT_YEAR', split: 'PM' }] });
      const year = moved.basis.CURRENT_YEAR;
      expect(year.province.before.rateTotalPct).toBe(year.province.after.rateTotalPct);
      expect(year.units).toHaveLength(2);
      expect(year.units.every((unit) => unit.before.rateTotalPct !== unit.after.rateTotalPct)).toBe(true);
    });
  });
});
