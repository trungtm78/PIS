import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DisRankingStore } from '../src/dis-ranking-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new DisRankingStore();
const WORKER = 9;
const ROOT = 1;
const FAMILY = 0xa3;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(WORKER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

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

let counter = 0;
const units = new Map<string, number>();
/** A unit of its own, of the type that makes its comparison group, with a code that says which it is. */
async function unitOf(code: string, type: string): Promise<number> {
  const known = units.get(code);
  if (known !== undefined) return known;
  counter += 1;
  const n = 20 + counter;
  units.set(code, n);
  await harness.seedUnits(TENANT_A, [{ n, path: `/u1/u${n}/`, parent: ROOT }]);
  await owner('update machvon.organization_unit set code = $2, unit_type = $3 where id = $1', [unitId(n), code, type]);
  return n;
}

interface UnitLine {
  code: string;
  type?: string;
  pm: string;
  local?: string;
  /** What the Treasury paid; null when nobody has the figure. */
  paid: string | null;
}

/** A frozen close snapshot with a carrier line for each unit (one project each). */
async function frozen(lines: UnitLine[], kind: 'PERIOD_CLOSE' | 'ADHOC' = 'PERIOD_CLOSE', status: 'FROZEN' | 'BUILDING' = 'FROZEN'): Promise<string> {
  counter += 1;
  const periodId = id(FAMILY, 1000 + counter);
  const snapshotId = randomUUID();
  await seedReplica([
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
      [TENANT_A, periodId, `RK-${counter}`, new Date(Date.UTC(2040, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), id(FAMILY, 40), memberId(WORKER)],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
       values ($1, $2, $3, $4, now(), date '2027-06-13', date '2027-06-13', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $5, $6, $6)`,
      [TENANT_A, snapshotId, periodId, kind, lines.length, memberId(WORKER)],
    ],
  ]);
  for (const line of lines) {
    const n = await unitOf(line.code, line.type ?? 'PROJECT_MANAGEMENT_BOARD');
    await seedReplica([
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, 'CURRENT_YEAR', 'CENTRAL', $4::numeric, $5::numeric, $4::numeric + $5::numeric, $6::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, unitId(n), line.pm, line.local ?? '0', line.paid],
      ],
    ]);
  }
  if (status === 'FROZEN') await seedReplica([[`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = now() where id = $1`, [snapshotId, memberId(WORKER)]]]);
  return snapshotId;
}

const compute = (snapshotId: string, minimum?: string) => as((tx) => store.compute(tx, snapshotId, minimum));
const table = async (snapshotId: string, group: string, kind: string) =>
  (await as((tx) => store.list(tx, snapshotId, { comparisonGroup: group, denominatorKind: kind }))).map((row) => ({ code: row.unitCode, rank: row.rank, rate: row.ratePct, plan: row.planVnd, paid: row.disbursedVnd, reason: row.excludedReason }));

describe('DisRankingStore (the ranking of the units of a comparison group, ST-DIS-013)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: '/u1/' }]);
    await harness.seedMembership(TENANT_A, WORKER, ROOT);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('AC-ST-DIS-013-1 / UAT-AC254 / FX-DIS-007: ranks a group by rate, breaks the tie by the larger disbursement, leaves out the unit below the minimum plan with its reason, and keeps a table for each denominator', async () => {
    const snapshotId = await frozen([
      { code: 'U-A', pm: '2000000000', local: '0', paid: '1200000000' },
      { code: 'U-B', pm: '1000000000', local: '1000000000', paid: '600000000' },
      { code: 'U-C', pm: '500000000', local: '0', paid: '400000000' },
    ]);
    expect(await compute(snapshotId)).toEqual({ skipped: undefined, groups: 1, ranked: 4, excluded: 2 });
    // On the plan the Prime Minister gave: 60% and 60%, the tie goes to the larger disbursement.
    expect(await table(snapshotId, 'PROJECT_MANAGEMENT_BOARD', 'PM_ASSIGNED')).toEqual([
      { code: 'U-A', rank: 1, rate: '60.0000', plan: '2000000000', paid: '1200000000', reason: null },
      { code: 'U-B', rank: 2, rate: '60.0000', plan: '1000000000', paid: '600000000', reason: null },
      { code: 'U-C', rank: null, rate: null, plan: '500000000', paid: '400000000', reason: 'PLAN_BELOW_MINIMUM' },
    ]);
    // On the plan with the local addition, B has a plan of 2 billion and its rate is 30%: its own table.
    expect(await table(snapshotId, 'PROJECT_MANAGEMENT_BOARD', 'TOTAL_INCL_LOCAL')).toEqual([
      { code: 'U-A', rank: 1, rate: '60.0000', plan: '2000000000', paid: '1200000000', reason: null },
      { code: 'U-B', rank: 2, rate: '30.0000', plan: '2000000000', paid: '600000000', reason: null },
      { code: 'U-C', rank: null, rate: null, plan: '500000000', paid: '400000000', reason: 'PLAN_BELOW_MINIMUM' },
    ]);
  });

  it('AC-ST-DIS-013-2 / UAT-AC04: a unit with a zero denominator is excluded with ZERO_DENOMINATOR and listed with the others that were left out, in both tables', async () => {
    const snapshotId = await frozen([
      { code: 'Z-1', pm: '0', local: '0', paid: '5000' },
      { code: 'Z-2', pm: '3000000000', paid: '300000000' },
      { code: 'Z-3', pm: '0', local: '2000000000', paid: '1000000000' },
    ]);
    await compute(snapshotId);
    expect(await table(snapshotId, 'PROJECT_MANAGEMENT_BOARD', 'PM_ASSIGNED')).toEqual([
      { code: 'Z-2', rank: 1, rate: '10.0000', plan: '3000000000', paid: '300000000', reason: null },
      { code: 'Z-1', rank: null, rate: null, plan: '0', paid: '5000', reason: 'ZERO_DENOMINATOR' },
      { code: 'Z-3', rank: null, rate: null, plan: '0', paid: '1000000000', reason: 'ZERO_DENOMINATOR' },
    ]);
    // The unit with only a local plan has a denominator on the whole plan.
    expect((await table(snapshotId, 'PROJECT_MANAGEMENT_BOARD', 'TOTAL_INCL_LOCAL')).map((row) => [row.code, row.rank, row.reason])).toEqual([
      ['Z-3', 1, null],
      ['Z-2', 2, null],
      ['Z-1', null, 'ZERO_DENOMINATOR'],
    ]);
  });

  it('ranks each group of units apart (a department is not ranked against a commune) and starts each table at 1', async () => {
    const snapshotId = await frozen([
      { code: 'D-1', type: 'DEPARTMENT', pm: '2000000000', paid: '200000000' },
      { code: 'D-2', type: 'DEPARTMENT', pm: '2000000000', paid: '400000000' },
      { code: 'C-1', type: 'COMMUNE', pm: '2000000000', paid: '1800000000' },
    ]);
    expect(await compute(snapshotId)).toMatchObject({ groups: 2, ranked: 6, excluded: 0 });
    expect((await table(snapshotId, 'DEPARTMENT', 'PM_ASSIGNED')).map((row) => [row.code, row.rank])).toEqual([
      ['D-2', 1],
      ['D-1', 2],
    ]);
    expect((await table(snapshotId, 'COMMUNE', 'PM_ASSIGNED')).map((row) => [row.code, row.rank, row.rate])).toEqual([['C-1', 1, '90.0000']]);
  });

  it('leaves out a unit that has a plan and no figure from the Treasury as NO_DATA, never as a rate of zero', async () => {
    const snapshotId = await frozen([
      { code: 'N-1', pm: '2000000000', paid: null },
      { code: 'N-2', pm: '2000000000', paid: '0' },
    ]);
    await compute(snapshotId);
    expect(await table(snapshotId, 'PROJECT_MANAGEMENT_BOARD', 'PM_ASSIGNED')).toEqual([
      { code: 'N-2', rank: 1, rate: '0.0000', plan: '2000000000', paid: '0', reason: null },
      { code: 'N-1', rank: null, rate: null, plan: '2000000000', paid: null, reason: 'NO_DATA' },
    ]);
  });

  it('keeps two units that share a code apart (a unit that was dissolved and the one that took its place): both are ranked, each as itself', async () => {
    const first = await unitOf('SH-1', 'PROJECT_MANAGEMENT_BOARD');
    const second = await unitOf('SH-2', 'PROJECT_MANAGEMENT_BOARD');
    await owner("update machvon.organization_unit set status = 'Dissolved', valid_until = date '2026-12-31' where id = $1", [unitId(first)]);
    await owner('update machvon.organization_unit set code = $2 where id = $1', [unitId(second), 'SH-1']);
    const snapshotId = await frozen([
      { code: 'SH-1', pm: '2000000000', paid: '1000000000' },
      { code: 'SH-2', pm: '2000000000', paid: '500000000' },
    ]);
    expect(await compute(snapshotId)).toMatchObject({ ranked: 4, excluded: 0 });
    const rows = await as((tx) => store.list(tx, snapshotId, { denominatorKind: 'PM_ASSIGNED' }));
    expect(rows.map((row) => [row.unitId, row.rank])).toEqual([
      [unitId(first), 1],
      [unitId(second), 2],
    ]);
  });

  it('takes the minimum plan of the call, computes a frozen close snapshot once, and leaves alone one that is not frozen, is not a close figure or is not there', async () => {
    const snapshotId = await frozen([{ code: 'M-1', pm: '600', paid: '300' }]);
    expect(await compute(snapshotId, '500')).toMatchObject({ ranked: 2, excluded: 0 });
    expect(await compute(snapshotId, '500')).toEqual({ skipped: 'ALREADY_COMPUTED', groups: 0, ranked: 0, excluded: 0 });
    expect(await owner('select count(*)::int as n from machvon.disbursement_ranking where snapshot_id = $1', [snapshotId])).toEqual([{ n: 2 }]);
    expect(await compute(await frozen([{ code: 'M-2', pm: '1', paid: '1' }], 'ADHOC'))).toMatchObject({ skipped: 'NOT_CLOSE' });
    expect(await compute(await frozen([{ code: 'M-3', pm: '1', paid: '1' }], 'PERIOD_CLOSE', 'BUILDING'))).toMatchObject({ skipped: 'NOT_FROZEN' });
    expect(await refusal(compute(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(as((tx) => store.compute(tx, snapshotId), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await as((tx) => store.list(tx, snapshotId), TENANT_B)).toEqual([]);
  });

  it('what the table refuses: a change or a delete of a ranking, a unit twice in a table, a position that is not the absence of a reason, a rate for a unit left out', async () => {
    const snapshotId = await frozen([{ code: 'T-1', pm: '2000000000', paid: '100' }]);
    await compute(snapshotId);
    const [row] = await owner<{ id: string; unit_id: string }>("select id, unit_id from machvon.disbursement_ranking where snapshot_id = $1 and denominator_kind = 'PM_ASSIGNED'", [snapshotId]);
    const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
    expect(await guard('update machvon.disbursement_ranking set rank = 5 where id = $1', [row?.id])).toMatchObject({ code: '23514' });
    expect(await guard('delete from machvon.disbursement_ranking where id = $1', [row?.id])).toMatchObject({ code: '23514' });
    const insert = (rank: string, reason: string, rate: string, kind = 'PM_ASSIGNED', unit = row?.unit_id) =>
      guard(
        `insert into machvon.disbursement_ranking (tenant_id, id, snapshot_id, comparison_group, unit_id, denominator_kind, plan_vnd, disbursed_vnd, rate_pct, rank, excluded_reason)
         values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, 'PROJECT_MANAGEMENT_BOARD', $2, $3, 10, 1, ${rate}, ${rank}, ${reason})`,
        [snapshotId, unit, kind],
      );
    expect(await insert('2', 'null', '1')).toMatchObject({ code: '23505' });
    expect(await insert('null', 'null', '1', 'TOTAL_INCL_LOCAL', randomUUID())).toMatchObject({ code: '23514' });
    expect(await insert('3', "'NO_DATA'", 'null', 'TOTAL_INCL_LOCAL', randomUUID())).toMatchObject({ code: '23514' });
    expect(await insert('null', "'NO_DATA'", '5', 'TOTAL_INCL_LOCAL', randomUUID())).toMatchObject({ code: '23514' });
    expect(await insert('null', "'WHATEVER'", 'null', 'TOTAL_INCL_LOCAL', randomUUID())).toMatchObject({ code: '23514' });
    expect(await insert('0', 'null', '1', 'TOTAL_INCL_LOCAL', randomUUID())).toMatchObject({ code: '23514' });
  });
});
