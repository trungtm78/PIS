import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { homeScopeHash, loadErrorRegistry, signTenantContext, verifyHomeContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { CommandCenterController } from '../../src/modules/home/command-center.controller';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from '../../src/modules/home/tokens';
import { homeModule } from '../../src/modules/home';
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
const BRANCH_LEADER = 2; // reads one branch
const NOBODY = 3; // holds no right to read HOME
const B_LEADER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const FAMILY = 0xa6;
const NOW = new Date('2027-10-15T03:00:00Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

type Tile = { metric_code: string; value: string | null; numerator: string | null; denominator: string | null; null_reason: string | null; unit: string; formula: string; definition_status: string; context_token: string };

/** The command center of the leader over HTTP (ST-HOME-001, HOME-09, HOME-01, BR-HOME-01). */
describe('the command center over HTTP (ST-HOME-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let clock = NOW;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(query = '', member = LEADER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/home/command-center${query}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const tiles = (reply: Reply): Tile[] => reply.json.tiles as Tile[];
  const tile = (reply: Reply, code: string): Tile => tiles(reply).find((candidate) => candidate.metric_code === code) as Tile;
  async function seedReplica(statements: Array<[string, unknown[]]>, tenant = TENANT_A): Promise<void> {
    void tenant;
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const day = (offset: number): string => new Date(Date.UTC(2046, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  /** A project of a unit with a line in a snapshot (not frozen yet): 1000 from the Prime Minister, 250 added, `paid` paid by the Treasury (null: the Treasury booked nothing). */
  async function project(snapshotId: string, unit: number, paid: string | null, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const projectId = id(FAMILY, 500 + counter);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, `HM-${counter}`, unitId(unit), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, $6)`,
        [tenant, snapshotId, projectId, unitId(unit), paid, paid === null ? 'NONE' : 'COMPLETE'],
      ],
    ]);
    return projectId;
  }
  /** A snapshot of a week, building until `freeze` says otherwise. */
  async function snapshot(options: { asOf?: string; frozenAt?: string; frozen?: boolean; tenant?: string } = {}): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const frozen = options.frozen !== false;
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [options.tenant ?? TENANT_A, periodId, `HP-${counter}`, day(counter * 7), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, $6, 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, case when $6 = 'FROZEN' then repeat('a', 64) end, case when $6 = 'FROZEN' then $7::uuid end, $8::timestamptz, $7, $7)`,
        [options.tenant ?? TENANT_A, snapshotId, periodId, NOW.toISOString(), options.asOf ?? '2027-10-12', frozen ? 'FROZEN' : 'BUILDING', WORKER_MEMBERSHIP_ID, frozen ? (options.frozenAt ?? NOW.toISOString()) : null],
      ],
    ]);
    return snapshotId;
  }
  const wipe = (): Promise<void> => seedReplica([['delete from machvon.early_warning', []], ['delete from machvon.explanation_request', []], ['delete from machvon.reallocation_proposal', []], ['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
    }
    for (const n of [LEADER, BRANCH_LEADER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_LEADER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: BRANCH_LEADER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CommandCenterController],
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

  it('serves the controller of the command center in the module of HOME', () => {
    expect(homeModule.controllers).toContain(CommandCenterController);
  });

  it('AC-ST-HOME-001-1 / UAT-AC266: gives every tile its scope, as-of day, snapshot, unit and formula, with the two rates side by side over the same numerator', async () => {
    const frozen = await snapshot({ asOf: '2027-10-12' });
    await project(frozen, NORTH, '600000000000');
    await project(frozen, SOUTH, '600000000000');
    const reply = await get();
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ snapshot_id: frozen, as_of_date: '2027-10-12', quality_badge: 'NOT_ASSESSED', freshness: 'FRESH', definition_status: 'PROPOSED_PENDING_SIGNOFF', legal_confirmation_refs: ['CXN-03'] });
    expect(reply.json.scope).toMatchObject({ unit_id: null, projects: 2 });
    const pm = tile(reply, 'DISBURSEMENT_RATE_PM');
    const total = tile(reply, 'DISBURSEMENT_RATE_TOTAL');
    // 1200 billion of 2000 billion from the Prime Minister, and of 2500 billion in all.
    expect([pm.value, pm.numerator, pm.denominator, pm.unit]).toEqual(['60.0000', '1200000000000', '2000000000000', 'PERCENT']);
    expect([total.value, total.numerator, total.denominator, total.unit]).toEqual(['48.0000', '1200000000000', '2500000000000', 'PERCENT']);
    expect(pm.numerator).toBe(total.numerator);
    for (const each of tiles(reply)) {
      expect(each.formula.length).toBeGreaterThan(5);
      expect(each.definition_status).toBe('PROPOSED_PENDING_SIGNOFF');
      expect(each.context_token).toMatch(/^[\w-]+\.[\w-]+$/);
    }
    // The tile of the same figures as DIS-19: what the dashboard says is what the center says.
    const dis = await fetch(`${app.baseUrl}/home/command-center?snapshot_id=${frozen}`, { headers: { [TENANT_HEADER]: tokenOf(LEADER) } });
    expect(((await dis.json()) as { tiles: Tile[] }).tiles.map((each) => each.value)).toEqual(tiles(reply).map((each) => each.value));
  });

  it('gives a token to each tile that names the tenant, the snapshot, the scope of the reader and the metric, good for 30 minutes', async () => {
    const frozen = await snapshot();
    await project(frozen, NORTH, '600000000000');
    const reply = await get(`?unit_id=${unitId(NORTH)}`);
    expect(reply.status).toBe(200);
    const context = verifyHomeContext(tile(reply, 'DISBURSEMENT_RATE_PM').context_token, CONTEXT_KEY, () => Math.floor(NOW.getTime() / 1000));
    expect(context).toMatchObject({ tenantId: TENANT_A, snapshotId: frozen, metricCode: 'DISBURSEMENT_RATE_PM', unitId: unitId(NORTH), scopeHash: homeScopeHash({ membershipId: memberId(LEADER), scopeVersion: 1, unitId: unitId(NORTH), grants: 'TENANT::' }) });
    expect(context.exp - Math.floor(NOW.getTime() / 1000)).toBeGreaterThan(1700);
    expect(context.exp - Math.floor(NOW.getTime() / 1000)).toBeLessThanOrEqual(1800);
    // Another reader gets another scope hash, so the token of one is not the token of the other.
    const branch = await get(`?unit_id=${unitId(NORTH)}`, BRANCH_LEADER);
    const other = verifyHomeContext(tile(branch, 'DISBURSEMENT_RATE_PM').context_token, CONTEXT_KEY, () => Math.floor(NOW.getTime() / 1000));
    expect(other.scopeHash).not.toBe(context.scopeHash);
  });

  it('AC-ST-HOME-001-2 / UAT-AC06: keeps the figures of the frozen snapshot until a newer one is frozen, whatever happens to the data after it', async () => {
    const first = await snapshot({ asOf: '2027-10-05', frozenAt: '2027-10-06T03:00:00Z' });
    await project(first, NORTH, '600000000000');
    const before = await get();
    expect(tile(before, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
    // A newer snapshot that is still being built, and a project that changed after the freeze: the figures stand.
    const building = await snapshot({ asOf: '2027-10-12', frozen: false });
    await project(building, NORTH, '900000000000');
    await seedReplica([[`update machvon.project set total_investment_vnd = 9999 where tenant_id = $1`, [TENANT_A]]]);
    const during = await get();
    expect(during.json.snapshot_id).toBe(first);
    expect(tile(during, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
    // Once it is frozen it is the one the center opens on, and the old one is still there for whoever pinned it.
    await seedReplica([[`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $3, frozen_at = $2::timestamptz where id = $1`, [building, '2027-10-14T03:00:00Z', WORKER_MEMBERSHIP_ID]]]);
    const after = await get();
    expect(after.json.snapshot_id).toBe(building);
    expect(tile(after, 'DISBURSEMENT_RATE_PM').value).toBe('90.0000');
    const pinned = await get(`?snapshot_id=${first}`);
    expect(pinned.json.snapshot_id).toBe(first);
    expect(tile(pinned, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
  });

  it('AC-ST-HOME-001-3 / UAT-AC268: shows no figure, with NO_DATA, for a project that has a plan and no Treasury data, never 0, and counts it as one project without data', async () => {
    const frozen = await snapshot();
    await project(frozen, NORTH, null);
    const reply = await get();
    expect(reply.status).toBe(200);
    for (const code of ['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY']) {
      expect(tile(reply, code)).toMatchObject({ value: null });
      expect(tile(reply, code).null_reason).not.toBeNull();
    }
    expect(tile(reply, 'DISBURSED_TREASURY').null_reason).toBe('NO_DATA');
    // The plan is a figure of its own and stays.
    expect(tile(reply, 'PLAN_TOTAL').value).toBe('1250000000000');
    expect(reply.json.projects_without_data).toBe(1);
  });

  it('AC-ST-HOME-001-4 / UAT-AC270: loads without data governance and says the quality is not assessed, with the freshness taken from the snapshot', async () => {
    const frozen = await snapshot({ asOf: '2027-10-12' });
    await project(frozen, NORTH, '600000000000');
    const reply = await get();
    expect(reply.json.quality_badge).toBe('NOT_ASSESSED');
    expect(reply.json.as_of_date).toBe('2027-10-12');
  });

  it('AC-ST-HOME-001-5: answers 404 when nothing is frozen, says a snapshot older than eight days is stale without hiding it, and refuses one that is not frozen', async () => {
    expect((await get()).status).toBe(404);
    const building = await snapshot({ frozen: false });
    expect((await get()).status).toBe(404);
    expect((await get(`?snapshot_id=${building}`)).status).toBe(422);
    const old = await snapshot({ asOf: '2027-10-01', frozenAt: '2027-10-02T03:00:00Z' });
    await project(old, NORTH, '600000000000');
    const stale = await get();
    expect(stale.status).toBe(200);
    expect(stale.json).toMatchObject({ snapshot_id: old, freshness: 'STALE' });
    expect(tile(stale, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
    clock = new Date('2027-10-09T03:00:00Z');
    expect((await get()).json.freshness).toBe('FRESH');
  });

  it('counts the open warnings, the overdue explanations and the pending reallocations of the reader beside the tiles', async () => {
    const frozen = await snapshot();
    const northProject = await project(frozen, NORTH, '600000000000');
    await seedReplica([
      [
        `insert into machvon.early_warning_rule (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, legal_basis, effective_from, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, 'EW-HOME-1', 'Rule', 'YTD_RATE_GAP', 'GTE', '{}'::jsonb, 'WARNING', 'PROJECT', 'Legal basis', '2026-01-01', 1, 'PUBLISHED', $3, $4, $4)`,
        [TENANT_A, id(FAMILY, 60), memberId(LEADER), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
         select $1, gen_random_uuid(), $2, $3, s.period_id, s.id, 'WARNING', '{}'::jsonb, 'EW-HOME|one', 'OPEN', $5, $5 from machvon.period_snapshot s where s.id = $4`,
        [TENANT_A, id(FAMILY, 60), northProject, frozen, WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.explanation_request (tenant_id, id, subject_kind, project_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, created_by, updated_by)
         values ($1, gen_random_uuid(), 'PROJECT', $2, 'EW-HOME', 'Why is the disbursement slow?', $3, '2027-10-01T00:00:00Z', '2027-10-01T00:00:00Z', 'REQUESTED', $4, $4)`,
        [TENANT_A, northProject, memberId(LEADER), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.reallocation_proposal (tenant_id, id, code, plan_year, scope_unit_id, basis_snapshot_id, source_capital_plan_id, reason, status, submitted_by, submitted_at, created_by, updated_by)
         values ($1, gen_random_uuid(), 'RA-HOME', 2027, $2, $3, $4, 'Move capital from slow projects to fast ones', 'SUBMITTED', $5, now(), $5, $5)`,
        [TENANT_A, unitId(SOUTH), frozen, randomUUID(), WORKER_MEMBERSHIP_ID],
      ],
    ]);
    const all = await get();
    expect([all.json.open_warnings, all.json.overdue_explanations, all.json.pending_reallocations]).toEqual([1, 1, 1]);
    // The branch of the north reads its own warning and explanation, and not the proposal of the south.
    const branch = await get('', BRANCH_LEADER);
    expect([branch.json.open_warnings, branch.json.overdue_explanations, branch.json.pending_reallocations]).toEqual([1, 1, 0]);
  });

  it('narrows to a unit the reader may read, refuses one they may not (403 SCOPE_DENIED), and gives a branch only its own figures', async () => {
    const frozen = await snapshot();
    await project(frozen, NORTH, '600000000000');
    await project(frozen, SOUTH, '300000000000');
    const north = await get(`?unit_id=${unitId(NORTH)}`);
    expect(north.status).toBe(200);
    expect(north.json.scope).toMatchObject({ unit_id: unitId(NORTH), projects: 1 });
    expect(tile(north, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
    const branch = await get('', BRANCH_LEADER);
    expect(branch.json.scope).toMatchObject({ projects: 1 });
    expect(tile(branch, 'DISBURSEMENT_RATE_PM').value).toBe('60.0000');
    const refused = await get(`?unit_id=${unitId(SOUTH)}`, BRANCH_LEADER);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('SCOPE_DENIED');
    expect(JSON.stringify(refused.json)).not.toContain('HM-');
  });

  it('refuses a request that is not well formed (422 VALIDATION_FAILED) and a member who may not read HOME (403)', async () => {
    for (const query of ['?snapshot_id=nope', '?unit_id=nope', '?denominator_kind=weird']) {
      const reply = await get(query);
      expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    expect((await get('', NOBODY)).status).toBe(403);
  });

  it('reads only the tenant of the reader: another tenant has its own snapshot, and a snapshot of another tenant is not found', async () => {
    const mine = await snapshot();
    await project(mine, NORTH, '600000000000');
    const foreign = await snapshot({ tenant: TENANT_B });
    const reply = await get('', B_LEADER, TENANT_B);
    expect(reply.status).toBe(200);
    expect(reply.json.snapshot_id).toBe(foreign);
    expect(reply.json.scope).toMatchObject({ projects: 0 });
    expect((await get(`?snapshot_id=${mine}`, B_LEADER, TENANT_B)).status).toBe(404);
  });
});
