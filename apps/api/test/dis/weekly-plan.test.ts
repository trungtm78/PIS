import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { WeeklyPlanController } from '../../src/modules/dis/weekly-plan.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // the leader in charge of the projects
const READER = 2; // reads the figures over the whole tenant
const ELSEWHERE_READER = 3; // reads the figures of another branch
const NOBODY = 4;
const B_READER = 1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa5;
const NOW = new Date('2027-10-15T03:00:00Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The weekly commitment against what the Treasury paid, over HTTP (ST-DIS-014, DIS-24, Directive 162). */
describe('the weekly plan against the Treasury actuals over HTTP (ST-DIS-014)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(query: string, member = READER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/weekly-disbursement-plans${query}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
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
  const day = (offset: number): string => new Date(Date.UTC(2040, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  /** Two weeks of a plan year (their own dates), and a project of a unit led by a member, with the commitments of the weeks. */
  async function world(options: { unit?: number; commitments: Array<{ week: 0 | 1 | 2; amount: string; current?: boolean; bucket?: string; level?: string }>; year?: number; periodYear?: number; leader?: boolean }) {
    counter += 1;
    const year = options.year ?? 2027;
    const projectId = id(FAMILY, 100 + counter);
    const code = `WK-${counter}`;
    const periods = [0, 1, 2].map((week) => ({ id: id(FAMILY, 1000 + counter * 10 + week), code: `W${40 + week}-${counter}`, start: day(counter * 21 + week * 7), end: day(counter * 21 + week * 7 + 6) }));
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(options.unit ?? HERE), id(FAMILY, 30)],
      ],
      ...periods.map(
        (period): [string, unknown[]] => [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'DEFAULT', 'WEEK', $6, 'OPEN', $7, $8, $8)`,
          [TENANT_A, period.id, period.code, period.start, period.end, options.periodYear ?? year, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
        ],
      ),
      ...(options.leader === false
        ? []
        : ([
            [
              `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
               values ($1, gen_random_uuid(), $2, $3, 'LEADER_IN_CHARGE', date '2027-01-01', 'ACTIVE', $4, $4)`,
              [TENANT_A, projectId, memberId(LEADER), WORKER_MEMBERSHIP_ID],
            ],
          ] as Array<[string, unknown[]]>)),
      ...options.commitments.map(
        (line): [string, unknown[]] => [
          `insert into machvon.disbursement_schedule_line (tenant_id, id, project_id, plan_year, granularity, period_id, bucket, budget_level, kind, amount_vnd, revision, is_current, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'WEEK', $4, $5, $6, 'WEEKLY_COMMITMENT', $7::numeric, 1, $8, $9, $9)`,
          [TENANT_A, projectId, year, periods[line.week]?.id, line.bucket ?? 'CURRENT_YEAR', line.level ?? 'CENTRAL', line.amount, line.current ?? true, WORKER_MEMBERSHIP_ID],
        ],
      ),
    ]);
    return { projectId, code, periods };
  }
  /** A frozen close snapshot of a period in which the project has paid `cumulative` to date. */
  async function freeze(periodId: string, projectId: string, cumulative: string | null, unit = HERE): Promise<void> {
    const snapshotId = randomUUID();
    await seedReplica([
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, date '2027-10-11', date '2027-10-11', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, $5, $5)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000, 1000000000, $5::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(unit), cumulative],
      ],
      [`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID, NOW.toISOString()]],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [LEADER, READER, ELSEWHERE_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_READER', ['disbursement.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DIS_READER', ['disbursement.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 1, kind: 'TENANT' },
      { n: 2, member: ELSEWHERE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [WeeklyPlanController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the controller of the weekly plan in the module of DIS', () => {
    expect(disModule.controllers).toContain(WeeklyPlanController);
  });

  it('AC-ST-DIS-014-1 / UAT-AC256: shows the commitments of 200 and 250 million against the Treasury actuals of 120 and 100 million, the differences -80 and -150 million, the plan not added to the disbursed, and the leader in charge', async () => {
    const w = await world({ commitments: [{ week: 0, amount: '200000000' }, { week: 1, amount: '250000000' }] });
    await freeze(w.periods[0]?.id as string, w.projectId, '120000000');
    await freeze(w.periods[1]?.id as string, w.projectId, '220000000');
    const reply = await get(`?project_id=${w.projectId}`);
    expect(reply.status).toBe(200);
    expect(reply.json.plan_year).toBe(2027);
    expect(items(reply)).toEqual([
      {
        project: { id: w.projectId, code: w.code, name: w.code },
        leader: { membership_id: memberId(LEADER), display_name: expect.any(String) },
        period: { id: w.periods[0]?.id, code: w.periods[0]?.code, start_date: w.periods[0]?.start, end_date: w.periods[0]?.end },
        commitment_vnd: '200000000',
        actual_vnd: '120000000',
        difference_vnd: '-80000000',
        actual_from_year_start: true,
      },
      {
        project: { id: w.projectId, code: w.code, name: w.code },
        leader: { membership_id: memberId(LEADER), display_name: expect.any(String) },
        period: { id: w.periods[1]?.id, code: w.periods[1]?.code, start_date: w.periods[1]?.start, end_date: w.periods[1]?.end },
        commitment_vnd: '250000000',
        actual_vnd: '100000000',
        difference_vnd: '-150000000',
        actual_from_year_start: false,
      },
    ]);
    expect((items(reply)[0]?.leader as { display_name: string }).display_name.length).toBeGreaterThan(0);
  });

  it('says nothing is known for a week that is not frozen (not zero), counts a frozen week with no figure as nothing paid, and shows a project with no leader', async () => {
    const w = await world({ commitments: [{ week: 0, amount: '10' }, { week: 1, amount: '20' }, { week: 2, amount: '30' }], leader: false });
    await freeze(w.periods[0]?.id as string, w.projectId, '7');
    await freeze(w.periods[1]?.id as string, w.projectId, null);
    const rows = items(await get(`?project_id=${w.projectId}`));
    expect(rows.map((row) => [row.actual_vnd, row.difference_vnd])).toEqual([
      ['7', '-3'],
      ['-7', '-27'],
      [null, null],
    ]);
    expect(rows.every((row) => row.leader === null)).toBe(true);
  });

  it('adds up the cells of a week and leaves out a commitment that was replaced (the current ones only)', async () => {
    const w = await world({
      commitments: [
        { week: 0, amount: '100', bucket: 'CURRENT_YEAR', level: 'CENTRAL' },
        { week: 0, amount: '50', bucket: 'CURRENT_YEAR', level: 'LOCAL' },
        { week: 0, amount: '999', bucket: 'CARRYOVER', level: 'CENTRAL', current: false },
      ],
    });
    expect(items(await get(`?project_id=${w.projectId}`)).map((row) => row.commitment_vnd)).toEqual(['150']);
  });

  it('reads only the projects in the scope of the caller, by plan year, project and unit, and a person of another tenant reads nothing', async () => {
    const here = await world({ commitments: [{ week: 0, amount: '5' }] });
    const there = await world({ unit: ELSEWHERE, commitments: [{ week: 0, amount: '6' }] });
    const other = await world({ commitments: [{ week: 0, amount: '7' }], year: 2028 });
    const all = items(await get('?limit=200'));
    expect(all.map((row) => (row.project as { id: string }).id)).toEqual(expect.arrayContaining([here.projectId, there.projectId]));
    expect(all.map((row) => (row.project as { id: string }).id)).not.toContain(other.projectId);
    expect(items(await get('?plan_year=2028&limit=200')).map((row) => (row.project as { id: string }).id)).toEqual([other.projectId]);
    expect(items(await get('', ELSEWHERE_READER)).map((row) => (row.project as { id: string }).id)).toEqual([there.projectId]);
    expect(items(await get(`?unit_id=${unitId(ELSEWHERE)}`)).map((row) => (row.project as { id: string }).id)).toEqual([there.projectId]);
    expect(items(await get(`?project_id=${here.projectId}`, ELSEWHERE_READER))).toEqual([]);
    expect(items(await get('', B_READER, TENANT_B))).toEqual([]);
    expect(await get('', NOBODY)).toMatchObject({ status: 403 });
  });

  it('pages by cursor in the order of project code and week, without a row twice or missing, and judges the query: the year, the ids, the cursor and the limit', async () => {
    const w = await world({ commitments: [{ week: 0, amount: '1' }, { week: 1, amount: '2' }, { week: 2, amount: '3' }] });
    const first = await get(`?project_id=${w.projectId}&limit=2`);
    expect(items(first)).toHaveLength(2);
    expect(typeof first.json.next_cursor).toBe('string');
    const rest = await get(`?project_id=${w.projectId}&limit=2&cursor=${first.json.next_cursor as string}`);
    expect(items(rest)).toHaveLength(1);
    expect(rest.json.next_cursor).toBeNull();
    expect([...items(first), ...items(rest)].map((row) => row.commitment_vnd)).toEqual(['1', '2', '3']);
    for (const [query, detail] of [['?plan_year=1999', 'plan_year'], ['?plan_year=abc', 'plan_year'], ['?project_id=nope', 'project_id'], ['?unit_id=nope', 'unit_id'], ['?limit=0', 'limit'], ['?cursor=nope', 'cursor']] as const) {
      expect(await get(query)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail } });
    }
  });

  it('finds the frozen week of a commitment whose plan year is not the fiscal year of its period (the year of the period holds the cumulative)', async () => {
    const w = await world({ commitments: [{ week: 0, amount: '200' }], year: 2027, periodYear: 2026 });
    await freeze(w.periods[0]?.id as string, w.projectId, '120');
    expect(items(await get(`?project_id=${w.projectId}`)).map((row) => [row.actual_vnd, row.difference_vnd])).toEqual([['120', '-80']]);
  });

  it('opens on the year of today when no year is asked for', async () => {
    const w = await world({ commitments: [{ week: 0, amount: '4' }], year: 2027 });
    const reply = await get(`?project_id=${w.projectId}`);
    expect(reply.json.plan_year).toBe(2027);
    expect(items(reply)).toHaveLength(1);
  });
});
