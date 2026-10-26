import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import { RankingComputeConsumer } from '../../src/modules/dis/ranking-compute.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, id, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import type { TenantDatabase } from '@machvon/db';

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const FAMILY = 0xa4;

/** The ranking of the units after a close snapshot is frozen (ST-DIS-013, the job dis.ranking-compute). */
describe('the ranking job over the outbox (ST-DIS-013)', () => {
  const harness = new AuthzHarness();
  let consumer: RankingComputeConsumer;
  let counter = 0;
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
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
  const delivery = (snapshotId: string, over: Record<string, unknown> = {}, eventId = randomUUID(), type = 'snapshot.frozen.v1') => ({
    id: eventId,
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    payload: { snapshot_id: snapshotId, ...over },
  });

  /** A frozen close snapshot with three units of one type: two with a plan above the minimum (a tie of rates) and one below it. */
  async function frozen(tag: string): Promise<{ snapshotId: string; units: string[] }> {
    counter += 1;
    const periodId = id(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    const made: Array<{ n: number; code: string; pm: string; paid: string }> = [
      { n: 40 + counter * 3, code: `${tag}-A`, pm: '2000000000', paid: '1200000000' },
      { n: 41 + counter * 3, code: `${tag}-B`, pm: '1000000000', paid: '600000000' },
      { n: 42 + counter * 3, code: `${tag}-C`, pm: '500000000', paid: '400000000' },
    ];
    for (const unit of made) {
      await harness.seedUnits(TENANT_A, [{ n: unit.n, path: `/u1/u${unit.n}/`, parent: ROOT }]);
      await rows('update machvon.organization_unit set code = $2, unit_type = $3 where id = $1', [unitId(unit.n), unit.code, 'PROJECT_MANAGEMENT_BOARD']);
    }
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `RJ-${counter}`, new Date(Date.UTC(2040, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2027-06-13', date '2027-06-13', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 3, $4, $4)`,
        [TENANT_A, snapshotId, periodId, WORKER_MEMBERSHIP_ID],
      ],
      ...made.map(
        (unit): [string, unknown[]] => [
          `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
           values ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, 'CURRENT_YEAR', 'CENTRAL', $4::numeric, 0, $4::numeric, $5::numeric, 'COMPLETE')`,
          [TENANT_A, snapshotId, unitId(unit.n), unit.pm, unit.paid],
        ],
      ),
      [`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = now() where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID]],
    ]);
    return { snapshotId, units: made.map((unit) => unit.code) };
  }
  const table = (snapshotId: string, kind: string) =>
    rows<{ code: string; rank: number | null; rate_pct: string | null; excluded_reason: string | null }>(
      `select u.code, r.rank, r.rate_pct::text as rate_pct, r.excluded_reason from machvon.disbursement_ranking r join machvon.organization_unit u on u.id = r.unit_id
        where r.snapshot_id = $1 and r.denominator_kind = $2 order by r.rank nulls last, u.code`,
      [snapshotId, kind],
    );

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: '/u1/' }]);
    consumer = new RankingComputeConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: SIGNING_KEY } });
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('AC-ST-DIS-013-1 / UAT-AC254: ranks the units of the group when the snapshot is frozen, once however often the event is delivered, with one audit row without any amount', async () => {
    const world = await frozen('RK1');
    const eventId = randomUUID();
    expect(await consumer.handle(delivery(world.snapshotId, {}, eventId))).toBe('processed');
    expect(await consumer.handle(delivery(world.snapshotId, {}, eventId))).toBe('duplicate');
    expect(await consumer.handle(delivery(world.snapshotId.toUpperCase(), { tenant_id: TENANT_A }))).toBe('processed');
    expect(await table(world.snapshotId, 'PM_ASSIGNED')).toEqual([
      { code: 'RK1-A', rank: 1, rate_pct: '60.0000', excluded_reason: null },
      { code: 'RK1-B', rank: 2, rate_pct: '60.0000', excluded_reason: null },
      { code: 'RK1-C', rank: null, rate_pct: null, excluded_reason: 'PLAN_BELOW_MINIMUM' },
    ]);
    expect(await table(world.snapshotId, 'TOTAL_INCL_LOCAL')).toHaveLength(3);
    expect(await rows('select count(*)::int as n from machvon.disbursement_ranking where snapshot_id = $1', [world.snapshotId])).toEqual([{ n: 6 }]);
    const audit = await rows<{ actor_id: string; safe_diff: Record<string, unknown> }>("select actor_id, safe_diff from machvon.audit_event where action = 'dis.ranking_computed' and resource_id::text = $1", [world.snapshotId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: WORKER_MEMBERSHIP_ID, safe_diff: { groups: 1, ranked: 4, excluded: 2 } });
    expect(JSON.stringify(audit)).not.toContain('1200000000');
  });

  it('leaves alone what is not ours to act on: another event, another tenant, no snapshot in the payload, a forged context, a snapshot that is not there', async () => {
    const world = await frozen('RK2');
    expect(await consumer.handle(delivery(world.snapshotId, {}, randomUUID(), 'report.accepted.v1'))).toBe('ignored');
    expect(await consumer.handle(delivery(world.snapshotId, { tenant_id: TENANT_B }))).toBe('ignored');
    await expect(consumer.handle(delivery(world.snapshotId, { snapshot_id: 'nope' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(consumer.handle({ ...delivery(world.snapshotId), tenantContext: 'forged' })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    await expect(consumer.handle(delivery(randomUUID()))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await rows('select count(*)::int as n from machvon.disbursement_ranking where snapshot_id = $1', [world.snapshotId])).toEqual([{ n: 0 }]);
    expect(await rows("select count(*)::int as n from machvon.audit_event where action = 'dis.ranking_computed' and resource_id::text = $1", [world.snapshotId])).toEqual([{ n: 0 }]);
  });

  it('writes nothing for a snapshot that is not frozen, and no audit row for it', async () => {
    const world = await frozen('RK3');
    await seedReplica([["update machvon.period_snapshot set status = 'BUILDING', payload_sha256 = null, frozen_by = null, frozen_at = null where id = $1", [world.snapshotId]]]);
    expect(await consumer.handle(delivery(world.snapshotId))).toBe('processed');
    expect(await rows('select count(*)::int as n from machvon.disbursement_ranking where snapshot_id = $1', [world.snapshotId])).toEqual([{ n: 0 }]);
    expect(await rows("select count(*)::int as n from machvon.audit_event where action = 'dis.ranking_computed' and resource_id::text = $1", [world.snapshotId])).toEqual([{ n: 0 }]);
  });
});
