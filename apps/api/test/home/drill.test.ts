import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, verifyHomeContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { CommandCenterController } from '../../src/modules/home/command-center.controller';
import { HomeDrillController } from '../../src/modules/home/drill.controller';
import { homeModule } from '../../src/modules/home';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from '../../src/modules/home/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const CONTEXT_KEY = randomBytes(32);
const LEADER = 1; // reads the whole tenant
const BRANCH = 2; // reads the north only
const REVOKED = 3; // reads the north and the south, until the south is taken away
const PROJECT_READER = 4; // holds a grant of one project, and none of units
const B_LEADER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const SUB = 4; // a unit under the north that owns lines of its own
const FAMILY = 0xa7;
const NOW = new Date('2027-10-15T03:00:00Z');
const BN = 1_000_000_000;
const dong = (billions: number): string => String(billions * BN);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
interface Child {
  dimension: string;
  id: string;
  code: string;
  name: string;
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  null_reason: string | null;
  context_token: string;
}
interface Tile {
  metric_code: string;
  value: string | null;
  context_token: string;
}

/** The drill of a figure of the command center over HTTP (ST-HOME-002, HOME-10, BR-HOME-03, BR-HOME-08). */
describe('the drill of a figure over HTTP (ST-HOME-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let clock = NOW;
  let counter = 0;
  const versions = new Map<number, number>();
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: versions.get(member) ?? 1 }, SIGNING_KEY);
  async function call(path: string, member = LEADER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const center = (query = '', member = LEADER, tenantId?: string): Promise<Reply> => call(`/home/command-center${query}`, member, tenantId);
  const drill = (token: string, extra = '', member = LEADER, tenantId?: string): Promise<Reply> => call(`/home/drill?context_token=${encodeURIComponent(token)}${extra}`, member, tenantId);
  const tileToken = (reply: Reply, metric: string): string => ((reply.json.tiles as Tile[]).find((tile) => tile.metric_code === metric) as Tile).context_token;
  const childrenOf = (reply: Reply): Child[] => reply.json.children as Child[];
  const sources = (reply: Reply): Array<Record<string, unknown>> => reply.json.source_records as Array<Record<string, unknown>>;
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
  const day = (offset: number): string => new Date(Date.UTC(2047, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  async function snapshot(options: { frozen?: boolean; frozenAt?: string; cutoff?: string; tenant?: string } = {}): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const frozen = options.frozen !== false;
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [options.tenant ?? TENANT_A, periodId, `DP-${counter}`, day(counter * 7), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by, created_at)
         values ($1, $2, $3, 'PERIOD_CLOSE', '2027-10-01T03:00:00Z', '2027-10-12', $5::date, $6, 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, case when $6 = 'FROZEN' then repeat('a', 64) end, case when $6 = 'FROZEN' then $7::uuid end, $8::timestamptz, $7, $7, $4::timestamptz)`,
        [options.tenant ?? TENANT_A, snapshotId, periodId, NOW.toISOString(), options.cutoff ?? '2027-10-12', frozen ? 'FROZEN' : 'BUILDING', WORKER_MEMBERSHIP_ID, frozen ? (options.frozenAt ?? NOW.toISOString()) : null],
      ],
    ]);
    return snapshotId;
  }

  interface Cell {
    bucket: 'CURRENT_YEAR' | 'CARRYOVER';
    level: 'CENTRAL' | 'LOCAL';
    pm: number;
    local: number;
    paid: number | null;
  }
  /** A project of a unit with the cells it has in a snapshot, a report revision that the cells came from, and Treasury transactions. */
  async function project(snapshotId: string, unit: number, cells: Cell[], options: { tenant?: string } = {}): Promise<{ projectId: string; lineIds: string[]; revisionId: string; code: string }> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const projectId = id(FAMILY, 500 + counter);
    const revisionId = id(FAMILY, 900 + counter);
    const code = `HD-${String(counter).padStart(3, '0')}`;
    const lineIds = cells.map((_cell, index) => id(FAMILY, 3000 + counter * 10 + index));
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, code, `Cầu ${code}`, unitId(unit), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, submitted_at, submitted_by, accepted_at, accepted_by, payload_hash)
         values ($1, $2, $3, $4, $5, 1, 'ACCEPTED', true, 1, '2027-10-10T01:00:00Z', $7, '2027-10-11T01:00:00Z', $6, repeat('b', 64))`,
        [tenant, revisionId, projectId, id(FAMILY, 2000 + counter), id(FAMILY, 31), WORKER_MEMBERSHIP_ID, id(FAMILY, 32)],
      ],
      ...cells.map(
        (cell, index): [string, unknown[]] => [
          `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage, report_revision_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $8::numeric + $9::numeric, $10::numeric, $11, $12)`,
          [tenant, lineIds[index], snapshotId, projectId, unitId(unit), cell.bucket, cell.level, dong(cell.pm), dong(cell.local), cell.paid === null ? null : dong(cell.paid), cell.paid === null ? 'NONE' : 'COMPLETE', revisionId],
        ],
      ),
    ]);
    return { projectId, lineIds, revisionId, code };
  }
  const transaction = (projectId: string, billions: number, at: string, external: string): [string, unknown[]] => [
    `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id)
     values ($1, gen_random_uuid(), $2, $3, 'KBNN', $4::numeric, $5::timestamptz, repeat('c', 64), 'CALLBACK_MOCK', $3)`,
    [TENANT_A, projectId, external, dong(billions), at],
  ];
  /** A transaction that was recorded in the system on 20 October, five days after the snapshot (15 October) was built. */
  const lateArrival = (projectId: string, billions: number, at: string, external: string): [string, unknown[]] => [
    `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id, created_at)
     values ($1, gen_random_uuid(), $2, $3, 'KBNN', $4::numeric, $5::timestamptz, repeat('c', 64), 'CALLBACK_MOCK', $3, '2027-10-20T03:00:00Z')`,
    [TENANT_A, projectId, external, dong(billions), at],
  ];
  const wipe = (): Promise<void> => seedReplica([['delete from machvon.period_snapshot_line', []], ['delete from machvon.report_revision', []], ['delete from machvon.treasury_transaction', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);

  /** Two units: the north has a project of two cells of the year plan (and a carried-over one), the south has one project. */
  async function world(): Promise<{ snapshotId: string; north: Awaited<ReturnType<typeof project>>; south: Awaited<ReturnType<typeof project>> }> {
    const snapshotId = await snapshot();
    const north = await project(snapshotId, NORTH, [
      { bucket: 'CURRENT_YEAR', level: 'CENTRAL', pm: 1000, local: 0, paid: 600 },
      { bucket: 'CURRENT_YEAR', level: 'LOCAL', pm: 0, local: 250, paid: null },
      { bucket: 'CARRYOVER', level: 'CENTRAL', pm: 50, local: 0, paid: 10 },
    ]);
    const south = await project(snapshotId, SOUTH, [{ bucket: 'CURRENT_YEAR', level: 'CENTRAL', pm: 400, local: 100, paid: 100 }]);
    await seedReplica([
      transaction(north.projectId, 200, '2027-10-01T03:00:00Z', 'TX-1'),
      transaction(north.projectId, 300, '2027-10-05T03:00:00Z', 'TX-2'),
      transaction(north.projectId, 100, '2027-10-12T16:00:00Z', 'TX-3'),
      // After the cutoff of the snapshot (12 October, Vietnam time): not a source of its figures.
      transaction(north.projectId, 999, '2027-10-13T03:00:00Z', 'TX-LATE'),
      // Recorded after the snapshot was built (15 October; it says it is as of an earlier day, 1 October, which is not when it was made), though it says it was confirmed before the cutoff: the snapshot did not see it.
      lateArrival(north.projectId, 55, '2027-10-10T03:00:00Z', 'TX-ARRIVED'),
      // Before the first day of the fiscal year of the snapshot (the snapshot counts the Treasury from it): not a source of the figures either.
      transaction(north.projectId, 77, '2026-12-30T03:00:00Z', 'TX-OLD'),
      transaction(south.projectId, 100, '2027-10-02T03:00:00Z', 'TX-S1'),
    ]);
    return { snapshotId, north, south };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
        { n: SUB, path: `/${unitId(ROOT)}/${unitId(NORTH)}/${unitId(SUB)}/`, parent: NORTH },
      ]);
    }
    for (const n of [LEADER, BRANCH, REVOKED, PROJECT_READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_LEADER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: BRANCH, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 3, member: REVOKED, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 4, member: REVOKED, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(SOUTH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CommandCenterController, HomeDrillController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => clock },
        { provide: HOME_CONTEXT_KEY, useValue: CONTEXT_KEY },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    clock = NOW;
    await wipe();
  });

  it('serves the controller of the drill in the module of HOME', () => {
    expect(homeModule.controllers).toContain(HomeDrillController);
  });

  it('AC-ST-HOME-002-1 / UAT-AC266: goes from the tile to the units, the project, its cell and its sources, each step of the snapshot with its day and formula, and the children of money add up to the parent to the dong', async () => {
    const { snapshotId, north } = await world();
    const home = await center();
    // The plan of the year: north 1250 billion (two cells of the year plan; the carried-over one is not of it), south 500 billion.
    const total = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit');
    expect(total.status).toBe(200);
    expect(total.json).toMatchObject({ snapshot_id: snapshotId, as_of_date: '2027-10-12', metric_code: 'PLAN_TOTAL', level: 'SCOPE', value: dong(1750), unit: 'VND', child_dimension: 'unit', reconciles_to_parent: true, non_additive_reason: null, scope_changed: false });
    expect(String(total.json.formula).length).toBeGreaterThan(5);
    expect(childrenOf(total).map((child) => [child.id, child.value])).toEqual([
      [unitId(NORTH), dong(1250)],
      [unitId(SOUTH), dong(500)],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    expect(childrenOf(total).reduce((sum, child) => sum + BigInt(child.value as string), 0n)).toBe(BigInt(total.json.value as string));
    // A ratio is not added: each child says its numerator and denominator, and the parent says why.
    const rate = await drill(tileToken(home, 'DISBURSEMENT_RATE_PM'), '&child_dimension=unit');
    expect(rate.json).toMatchObject({ value: '50.0000', numerator: dong(700), denominator: dong(1400), reconciles_to_parent: false, non_additive_reason: 'RATIO' });
    const northRate = childrenOf(rate).find((child) => child.id === unitId(NORTH)) as Child;
    expect([northRate.value, northRate.numerator, northRate.denominator]).toEqual(['60.0000', dong(600), dong(1000)]);
    // Down to the projects of the north, then to the cells of the project.
    const projects = await drill(northRate.context_token, '&child_dimension=project');
    expect(projects.json).toMatchObject({ snapshot_id: snapshotId, level: 'UNIT', child_dimension: 'project' });
    expect(childrenOf(projects).map((child) => child.code)).toEqual([north.code]);
    const projectToken = childrenOf(projects)[0]?.context_token as string;
    const cells = await drill(projectToken);
    expect(cells.json).toMatchObject({ snapshot_id: snapshotId, level: 'PROJECT', child_dimension: 'cell', value: '60.0000', numerator: dong(600), denominator: dong(1000) });
    expect(cells.json.scope).toMatchObject({ project_id: north.projectId, project_code: north.code, project_name: `Cầu ${north.code}`, unit_id: unitId(NORTH) });
    expect(childrenOf(cells).map((child) => child.code)).toEqual(['CURRENT_YEAR|CENTRAL', 'CURRENT_YEAR|LOCAL']);
    // Its sources: the report revision the cells came from, and the Treasury transactions up to the cutoff (not the one after it).
    expect(sources(cells).filter((source) => source.kind === 'REPORT_REVISION')).toEqual([{ kind: 'REPORT_REVISION', id: north.revisionId, revision: 1, status: 'ACCEPTED', submitted_at: expect.any(String), accepted_at: expect.any(String) }]);
    expect(sources(cells).filter((source) => source.kind === 'TREASURY_TRANSACTION').map((source) => source.external_id)).toEqual(['TX-3', 'TX-2', 'TX-1']);
    const cell = await drill((childrenOf(cells)[0] as Child).context_token);
    expect(cell.json).toMatchObject({ snapshot_id: snapshotId, level: 'CELL', child_dimension: null, children: [], reconciles_to_parent: true, value: '60.0000' });
    expect(sources(cell).some((source) => source.kind === 'REPORT_REVISION')).toBe(true);
  });

  it('adds up the cells of a project to the project for money, to the dong, and says no data (not 0) for a cell the Treasury booked nothing for', async () => {
    const { north } = await world();
    const home = await center(`?unit_id=${unitId(NORTH)}`);
    const projects = await drill(tileToken(home, 'DISBURSED_TREASURY'), '&child_dimension=project');
    const project = childrenOf(projects).find((child) => child.code === north.code) as Child;
    const cells = await drill(project.context_token);
    expect(cells.json).toMatchObject({ value: dong(600), reconciles_to_parent: true, non_additive_reason: null });
    expect(childrenOf(cells).map((child) => [child.code, child.value, child.null_reason])).toEqual([
      ['CURRENT_YEAR|CENTRAL', dong(600), null],
      ['CURRENT_YEAR|LOCAL', null, 'NO_DATA'],
    ]);
    expect((cells.json.exclusions as Array<Record<string, unknown>>).map((exclusion) => [exclusion.code, exclusion.reason])).toEqual([['CURRENT_YEAR|LOCAL', 'NO_DATA']]);
  });

  it('pages the children and the transactions, and says the children add up whatever page is shown', async () => {
    const { south } = await world();
    for (let n = 0; n < 5; n += 1) await seedReplica([transaction(south.projectId, 1, `2027-10-0${3 + (n % 5)}T03:00:00Z`, `TX-P${n}`)]);
    const home = await center();
    const first = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit&limit=1');
    expect(childrenOf(first)).toHaveLength(1);
    expect(first.json.next_cursor).not.toBeNull();
    expect(first.json.reconciles_to_parent).toBe(true);
    const second = await drill(tileToken(home, 'PLAN_TOTAL'), `&child_dimension=unit&limit=1&cursor=${String(first.json.next_cursor)}`);
    expect(childrenOf(second)).toHaveLength(1);
    expect(childrenOf(second)[0]?.id).not.toBe(childrenOf(first)[0]?.id);
    expect(second.json.next_cursor).toBeNull();
    // The Treasury transactions of the project, two at a time.
    const projects = await drill(tileToken(home, 'DISBURSED_TREASURY'), '&child_dimension=project');
    const token = (childrenOf(projects).find((child) => child.code === south.code) as Child).context_token;
    const page1 = await drill(token, '&limit=2');
    const page2 = await drill(token, `&limit=2&cursor=${String(page1.json.next_cursor)}`);
    // The cells are given once, with the first page, and the pages that follow carry transactions only.
    expect(childrenOf(page1).length).toBeGreaterThan(0);
    expect(childrenOf(page2)).toEqual([]);
    const ids = [...sources(page1), ...sources(page2)].filter((source) => source.kind === 'TREASURY_TRANSACTION').map((source) => source.id);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('shows for a child what opening it shows, when a unit and a unit under it both own lines: the child is the unit alone, and the children still add up to the parent', async () => {
    const { snapshotId } = await world();
    await project(snapshotId, SUB, [{ bucket: 'CURRENT_YEAR', level: 'CENTRAL', pm: 200, local: 0, paid: 50 }]);
    const home = await center();
    const units = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit');
    expect(units.json).toMatchObject({ value: dong(1950), reconciles_to_parent: true });
    const byId = Object.fromEntries(childrenOf(units).map((child) => [child.id, child]));
    expect(Object.keys(byId).sort()).toEqual([unitId(NORTH), unitId(SOUTH), unitId(SUB)].sort());
    expect([byId[unitId(NORTH)]?.value, byId[unitId(SUB)]?.value]).toEqual([dong(1250), dong(200)]);
    // Opening a child gives the figure the child showed (not the unit with what is under it).
    for (const child of childrenOf(units)) {
      const opened = await drill(child.context_token);
      expect([child.code, opened.json.value]).toEqual([child.code, child.value]);
      // The unit alone has no units under it: the way down from it is its projects, and it is the default.
      expect([opened.json.child_dimensions, opened.json.child_dimension]).toEqual([['project'], 'project']);
      expect(childrenOf(opened).every((entry) => entry.dimension === 'project')).toBe(true);
    }
    // The tile of the center for the north is the unit with what is under it, and its children are the two that own lines.
    const subtree = await center(`?unit_id=${unitId(NORTH)}`);
    const under = await drill(tileToken(subtree, 'PLAN_TOTAL'), '&child_dimension=unit');
    expect(under.json).toMatchObject({ value: dong(1450), reconciles_to_parent: true });
    expect(childrenOf(under).map((child) => child.value).sort()).toEqual([dong(1250), dong(200)].sort());
  });

  it('opens the children of a reader who holds the grant of one project and no grant of units: the unit is theirs by the project they may read, and nothing else of it is', async () => {
    const { snapshotId, north } = await world();
    const other = await project(snapshotId, NORTH, [{ bucket: 'CURRENT_YEAR', level: 'CENTRAL', pm: 5, local: 0, paid: 5 }]);
    await harness.seedGrants(TENANT_A, [{ n: 9, member: PROJECT_READER, role: 1, kind: 'PROJECT', refs: [north.projectId] }]);
    const home = await center('', PROJECT_READER);
    expect(home.status).toBe(200);
    const units = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit', PROJECT_READER);
    expect(units.status).toBe(200);
    expect(childrenOf(units).map((child) => [child.id, child.value])).toEqual([[unitId(NORTH), dong(1250)]]);
    // The children that the server gave are the ones that open: the unit, then its project (one, the one of the grant).
    const opened = await drill((childrenOf(units)[0] as Child).context_token, '&child_dimension=project', PROJECT_READER);
    expect(opened.status).toBe(200);
    expect(childrenOf(opened).map((child) => child.code)).toEqual([north.code]);
    expect(JSON.stringify(opened.json)).not.toContain(other.code);
  });

  it('gives a transaction that takes another back as what it contributes to the figure, negative, beside the amount it is stored with', async () => {
    const { south } = await world();
    const original = randomUUID();
    await seedReplica([
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id)
         values ($1, $2, $3, 'TX-ORIG', 'KBNN', $4::numeric, '2027-10-03T03:00:00Z', repeat('c', 64), 'CALLBACK_MOCK', 'TX-ORIG')`,
        [TENANT_A, original, south.projectId, dong(20)],
      ],
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, reversal_of_id, direction, source_hash, source_kind, provider_event_id)
         values ($1, gen_random_uuid(), $2, 'TX-BACK', 'KBNN', $3::numeric, '2027-10-04T03:00:00Z', $4, 'REFUND', repeat('c', 64), 'CALLBACK_MOCK', 'TX-BACK')`,
        [TENANT_A, south.projectId, dong(5), original],
      ],
    ]);
    const home = await center();
    const projects = await drill(tileToken(home, 'DISBURSED_TREASURY'), '&child_dimension=project');
    const reply = await drill((childrenOf(projects).find((child) => child.code === south.code) as Child).context_token);
    const back = sources(reply).find((source) => source.external_id === 'TX-BACK');
    const first = sources(reply).find((source) => source.external_id === 'TX-ORIG');
    expect(back).toMatchObject({ amount_vnd: dong(5), contribution_vnd: `-${dong(5)}`, reversal_of_id: original });
    expect(first).toMatchObject({ amount_vnd: dong(20), contribution_vnd: dong(20), reversal_of_id: null });
  });

  it('keeps the snapshot: a newer one that is frozen is not taken, whatever the leader drills', async () => {
    const { snapshotId } = await world();
    const home = await center();
    const newer = await snapshot({ frozenAt: '2027-10-16T03:00:00Z' });
    await project(newer, NORTH, [{ bucket: 'CURRENT_YEAR', level: 'CENTRAL', pm: 1, local: 0, paid: 1 }]);
    const reply = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit');
    expect(reply.json.snapshot_id).toBe(snapshotId);
    expect(reply.json.value).toBe(dong(1750));
    for (const child of childrenOf(reply)) expect(verifyHomeContext(child.context_token, CONTEXT_KEY, () => Math.floor(NOW.getTime() / 1000)).snapshotId).toBe(snapshotId);
  });

  it('AC-ST-HOME-002-2 / UAT-AC267: refuses a unit the reader may not read any more (403 SCOPE_DENIED) without naming anything, records the refusal, and says the token was made under another scope', async () => {
    await world();
    const home = await center('', REVOKED);
    const units = await drill(tileToken(home, 'PLAN_TOTAL'), '&child_dimension=unit', REVOKED);
    const tokens = Object.fromEntries(childrenOf(units).map((child) => [child.id, child.context_token]));
    expect(Object.keys(tokens).sort()).toEqual([unitId(NORTH), unitId(SOUTH)].sort());
    // The south is taken away from the reader while the page is open.
    // A change of the grants of a member moves the version of their scope: the next request is read over the grants as they are now.
    await seedReplica([
      [`update machvon.role_grant set status = 'Revoked', revoked_at = now() where id = $1`, [id(0x40, 4)]],
      ['update machvon.membership set scope_version = scope_version + 1 where id = $1', [memberId(REVOKED)]],
    ]);
    const version = Number((await harness.owner<{ scope_version: string }>(TENANT_A, [['select scope_version::text as scope_version from machvon.membership where id = $1', [memberId(REVOKED)]]]))[0]?.scope_version);
    versions.set(REVOKED, version);
    const denied = await drill(tokens[unitId(SOUTH)] as string, '&child_dimension=project', REVOKED);
    expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(JSON.stringify(denied.json)).not.toMatch(/HD-|Cầu/);
    const audit = await harness.owner<{ outcome: string; safe_diff: Record<string, unknown> }>(TENANT_A, [[`select outcome, safe_diff from machvon.audit_event where action = 'home.drill_denied' and actor_id = $1`, [memberId(REVOKED)]]]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'DENIED', safe_diff: { metric_code: 'PLAN_TOTAL', level: 'UNIT' } });
    expect(JSON.stringify(audit[0])).not.toMatch(/HD-|Cầu/);
    // What the reader still may read answers, over the scope they have now, and says its token is of an older scope.
    const still = await drill(tokens[unitId(NORTH)] as string, '&child_dimension=project', REVOKED);
    expect(still.status).toBe(200);
    expect(still.json.scope_changed).toBe(true);
    expect(childrenOf(still)).toHaveLength(1);
  });

  it('refuses a project that is outside the scope of the reader as it is now, as it does a unit, and records it without the name of the project', async () => {
    const { north } = await world();
    const home = await center('', BRANCH);
    const projects = await drill(tileToken(home, 'DISBURSED_TREASURY'), '&child_dimension=project', BRANCH);
    const token = (childrenOf(projects).find((child) => child.code === north.code) as Child).context_token;
    expect((await drill(token, '', BRANCH)).status).toBe(200);
    // The project moves to a unit that the reader does not read: the token, which was good a moment ago, opens nothing.
    await seedReplica([['update machvon.project set owner_unit_id = $1 where id = $2', [unitId(SOUTH), north.projectId]]]);
    const denied = await drill(token, '', BRANCH);
    expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(JSON.stringify(denied.json)).not.toMatch(/HD-|Cầu/);
    const audit = await harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [["select safe_diff from machvon.audit_event where action = 'home.drill_denied' and actor_id = $1", [memberId(BRANCH)]]]);
    expect(audit.map((row) => row.safe_diff)).toEqual([{ metric_code: 'DISBURSED_TREASURY', level: 'PROJECT' }]);
  });

  it('AC-ST-HOME-002-3: answers 400 INVALID_REQUEST, and no data, for a token of another member, of another tenant, altered, made for something else or missing a part', async () => {
    await world();
    const home = await center();
    const token = tileToken(home, 'PLAN_TOTAL');
    const [payload, signature] = token.split('.') as [string, string];
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), unitId: unitId(SOUTH) })).toString('base64url');
    const attempts: Array<[string, Reply]> = [
      ['another member', await drill(token, '', BRANCH)],
      ['another tenant', await drill(token, '', B_LEADER, TENANT_B)],
      ['altered', await drill(`${altered}.${signature}`)],
      ['not a token', await drill('x.y')],
      ['cut', await drill(token.slice(0, -3))],
    ];
    for (const [name, reply] of attempts) expect([name, reply.status, reply.json.code]).toEqual([name, 400, 'INVALID_REQUEST']);
    expect(JSON.stringify(attempts.map(([, reply]) => reply.json))).not.toContain(dong(1750));
    // Nothing named: 422.
    expect((await call('/home/drill')).status).toBe(422);
  });

  it('AC-ST-HOME-002-4: answers 409 SNAPSHOT_EXPIRED for a token that is old, with the snapshot to ask again for, and reads over the same snapshot with a new token', async () => {
    const { snapshotId } = await world();
    const home = await center();
    const token = tileToken(home, 'PLAN_TOTAL');
    clock = new Date(NOW.getTime() + 31 * 60_000);
    const expired = await drill(token);
    expect([expired.status, expired.json.code]).toEqual([409, 'SNAPSHOT_EXPIRED']);
    expect(expired.json).toMatchObject({ snapshot_id: snapshotId, metric_code: 'PLAN_TOTAL' });
    // A newer snapshot is frozen meanwhile: the new token, asked for the same snapshot, is of the same snapshot.
    const newer = await snapshot({ frozenAt: '2027-10-16T03:00:00Z' });
    void newer;
    const refreshed = await center(`?snapshot_id=${snapshotId}`);
    const again = await drill(tileToken(refreshed, 'PLAN_TOTAL'));
    expect(again.status).toBe(200);
    expect(again.json.snapshot_id).toBe(snapshotId);
  });

  it('does not tell where to ask again to whoever is not the owner of an old token: another member or another tenant gets the 400 of any token of someone else', async () => {
    await world();
    const home = await center();
    const token = tileToken(home, 'PLAN_TOTAL');
    clock = new Date(NOW.getTime() + 31 * 60_000);
    const other = await drill(token, '', BRANCH);
    expect([other.status, other.json.code]).toEqual([400, 'INVALID_REQUEST']);
    expect(other.json.snapshot_id).toBeUndefined();
    const foreign = await drill(token, '', B_LEADER, TENANT_B);
    expect([foreign.status, foreign.json.code]).toEqual([400, 'INVALID_REQUEST']);
    expect(foreign.json.snapshot_id).toBeUndefined();
    // The owner is told, as before.
    expect((await drill(token)).status).toBe(409);
  });

  it('refuses a dimension the level does not have, a bad cursor and a bad limit (422), and a snapshot that is not there (404)', async () => {
    const { north } = await world();
    const home = await center();
    const token = tileToken(home, 'PLAN_TOTAL');
    // The cursor of the transactions is a moment and an id: two strings that are not, which would only fail in the database, are refused here.
    const projectToken = (childrenOf(await drill(tileToken(home, 'DISBURSED_TREASURY'), '&child_dimension=project')).find((child) => child.code === north.code) as Child).context_token;
    const badCursor = Buffer.from(JSON.stringify(['bad-date', 'bad-id'])).toString('base64url');
    const refused = await drill(projectToken, `&cursor=${badCursor}`);
    expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    for (const query of ['&child_dimension=cell', '&child_dimension=galaxy', '&cursor=%%%', '&cursor=eA', '&limit=0', '&limit=201', '&limit=x']) {
      const reply = await drill(token, query);
      expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
    // The snapshot that the token names is gone from this tenant (a token of the time before it was removed): not found.
    await seedReplica([['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []]]);
    const gone = await drill(token);
    expect([gone.status, gone.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('gives a unit the leader of a branch reads only its own children, and a tenant its own', async () => {
    await world();
    const branch = await center('', BRANCH);
    const units = await drill(tileToken(branch, 'PLAN_TOTAL'), '&child_dimension=unit', BRANCH);
    expect(childrenOf(units).map((child) => child.id)).toEqual([unitId(NORTH)]);
    expect(units.json.value).toBe(dong(1250));
    const foreign = await snapshot({ tenant: TENANT_B });
    void foreign;
    const other = await center('', B_LEADER, TENANT_B);
    const empty = await drill(tileToken(other, 'PLAN_TOTAL'), '&child_dimension=unit', B_LEADER, TENANT_B);
    expect(childrenOf(empty)).toEqual([]);
  });
});
