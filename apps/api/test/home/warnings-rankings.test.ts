import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { homeModule } from '../../src/modules/home';
import { HomeRankingsController } from '../../src/modules/home/rankings.controller';
import { HOME_CLOCK, HOME_RANKING_VISIBILITY } from '../../src/modules/home/tokens';
import type { RankingVisibility } from '../../src/modules/home/tokens';
import { HomeWarningsController } from '../../src/modules/home/warnings.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // reads the whole tenant
const BRANCH = 2; // reads the north only
const NOBODY = 3; // holds no right to read HOME
const B_LEADER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const FAMILY = 0xa8;
const NOW = new Date('2027-10-15T03:00:00Z');
const BN = 1_000_000_000;
const dong = (billions: number): string => String(billions * BN);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
// A body of the server as the test reads it, whose shape each test names by what it expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

/** The warnings and the ranking of the command center over HTTP (ST-HOME-003, HOME-03, HOME-04, HOME-06). */
describe('the warnings and the ranking of the command center over HTTP (ST-HOME-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let visibility: RankingVisibility = 'ALL';
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(path: string, member = LEADER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const warnings = (query = '', member = LEADER, tenantId?: string): Promise<Reply> => call(`/home/warnings${query}`, member, tenantId);
  const rankings = (query = '', member = LEADER, tenantId?: string): Promise<Reply> => call(`/home/rankings${query}`, member, tenantId);
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const tables = (reply: Reply): Item[] => reply.json.tables as Item[];
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
  const day = (offset: number): string => new Date(Date.UTC(2048, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  async function snapshot(options: { kind?: string; frozen?: boolean; frozenAt?: string } = {}): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const frozen = options.frozen !== false;
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `WP-${counter}`, day(counter * 7), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, $4, $5::timestamptz, '2027-10-12', '2027-10-12', $6, 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, case when $6 = 'FROZEN' then repeat('a', 64) end, case when $6 = 'FROZEN' then $7::uuid end, $8::timestamptz, $7, $7)`,
        [TENANT_A, snapshotId, periodId, options.kind ?? 'PERIOD_CLOSE', NOW.toISOString(), frozen ? 'FROZEN' : 'BUILDING', WORKER_MEMBERSHIP_ID, frozen ? (options.frozenAt ?? NOW.toISOString()) : null],
      ],
    ]);
    return snapshotId;
  }

  /** A project of a unit with a cell in a snapshot, and a leader in charge of it now. */
  async function project(snapshotId: string, unit: number, options: { leader?: boolean } = {}): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = id(FAMILY, 500 + counter);
    const code = `HW-${String(counter).padStart(3, '0')}`;
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, `Cầu ${code}`, unitId(unit), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage, rate_pm_pct, rate_total_pct)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', $5::numeric, 0, $5::numeric, $6::numeric, 'COMPLETE', 22, 22)`,
        [TENANT_A, snapshotId, projectId, unitId(unit), dong(1000), dong(220)],
      ],
      ...(options.leader === false
        ? []
        : ([
            [
              `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
               values ($1, gen_random_uuid(), $2, $3, 'LEADER_IN_CHARGE', date '2027-01-01', 'ACTIVE', $4, $4)`,
              [TENANT_A, projectId, memberId(LEADER), WORKER_MEMBERSHIP_ID],
            ],
          ] as Array<[string, unknown[]]>)),
    ]);
    return { projectId, code };
  }

  let ruleId = '';
  let otherRuleId = '';
  async function rules(): Promise<void> {
    ruleId = id(FAMILY, 60);
    otherRuleId = id(FAMILY, 61);
    await seedReplica([
      [
        `insert into machvon.early_warning_rule (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, legal_basis, effective_from, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, 'EW-01', 'Tỷ lệ giải ngân thấp hơn kỳ vọng', 'YTD_RATE_GAP', 'GTE', '{"points":"10","critical_points":"20"}'::jsonb, 'WARNING', 'PROJECT', 'Legal basis', '2026-01-01', 1, 'PUBLISHED', $3, $4, $4),
                ($1, $5, 'EW-02', 'Chưa gửi báo cáo', 'REPORT_OVERDUE', 'MISSING', '{"grace_days":0}'::jsonb, 'CRITICAL', 'PROJECT', 'Legal basis', '2026-01-01', 1, 'PUBLISHED', $3, $4, $4)`,
        [TENANT_A, ruleId, memberId(LEADER), WORKER_MEMBERSHIP_ID, otherRuleId],
      ],
    ]);
  }

  interface WarningOptions {
    rule?: string;
    severity?: string;
    status?: string;
    openedAt?: string;
    snapshotId: string;
    explanation?: { status: string };
  }
  async function warning(projectId: string, options: WarningOptions): Promise<string> {
    counter += 1;
    const warningId = id(FAMILY, 4000 + counter);
    const status = options.status ?? 'OPEN';
    const explanationId = options.explanation === undefined ? null : id(FAMILY, 5000 + counter);
    await seedReplica([
      [
        `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, explanation_request_id, owner_membership_id,
           acknowledged_by, acknowledged_at, acknowledgement_note, resolution_reason, closed_at, closed_by, opened_at, created_by, updated_by)
         select $1, $2, $3, $4, s.period_id, s.id, $5, '{"metric":"YTD_RATE_GAP","observed_pct":"22.0000","expected_pct":"45.0000","gap_points":"23.0000"}'::jsonb, $6, $7, $8, null,
                case when $7 in ('ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RESOLVED') then $12::uuid end, case when $7 in ('ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RESOLVED') then '2027-10-03T03:00:00Z'::timestamptz end,
                case when $7 in ('ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RESOLVED') then 'The unit is on it.' end,
                case when $7 in ('RESOLVED', 'DISMISSED') then 'Caught up.' end, case when $7 in ('RESOLVED', 'DISMISSED') then '2027-10-09T03:00:00Z'::timestamptz end, case when $7 in ('RESOLVED', 'DISMISSED') then $12::uuid end,
                $9::timestamptz, $10, $10
           from machvon.period_snapshot s where s.id = $11`,
        [TENANT_A, warningId, options.rule === 'EW-02' ? otherRuleId : ruleId, projectId, options.severity ?? 'WARNING', `${options.rule ?? 'EW-01'}|${warningId}`, status, explanationId, options.openedAt ?? '2027-10-02T03:00:00Z', WORKER_MEMBERSHIP_ID, options.snapshotId, memberId(BRANCH)],
      ],
      ...(explanationId === null || options.explanation === undefined
        ? []
        : ([
            [
              `insert into machvon.explanation_request (tenant_id, id, subject_kind, project_id, warning_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, response_text, responded_by, responded_at, reviewed_by, review_note, is_late, created_at, created_by, updated_by)
               values ($1, $2, 'PROJECT', $3, $4, 'EW-01', 'Why is the disbursement slow?', $5, '2027-10-09T00:00:00Z', '2027-10-09T00:00:00Z', $6,
                       case when $6 in ('RESPONDED', 'ACCEPTED') then 'The works were delayed by the weather and are caught up.' end, case when $6 in ('RESPONDED', 'ACCEPTED') then $5::uuid end, case when $6 in ('RESPONDED', 'ACCEPTED') then '2027-10-05T03:00:00Z'::timestamptz end,
                       case when $6 = 'ACCEPTED' then $8::uuid end, case when $6 = 'ACCEPTED' then 'Accepted.' end, false, '2027-10-03T05:00:00Z', $7, $7)`,
              [TENANT_A, explanationId, projectId, warningId, memberId(LEADER), options.explanation.status, memberId(BRANCH), memberId(BRANCH)],
            ],
          ] as Array<[string, unknown[]]>)),
    ]);
    return warningId;
  }
  const wipe = (): Promise<void> =>
    seedReplica([['delete from machvon.early_warning', []], ['delete from machvon.explanation_request', []], ['delete from machvon.disbursement_ranking', []], ['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);

  async function ranking(snapshotId: string, rows: Array<{ group?: string; unit: number; kind: string; plan: number; disbursed: number | null; rate: string | null; rank: number | null; reason?: string }>): Promise<void> {
    await seedReplica(
      rows.map(
        (row): [string, unknown[]] => [
          `insert into machvon.disbursement_ranking (tenant_id, id, snapshot_id, comparison_group, unit_id, denominator_kind, plan_vnd, disbursed_vnd, rate_pct, rank, excluded_reason)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10)`,
          [TENANT_A, snapshotId, row.group ?? 'PROJECT_MANAGEMENT_BOARD', unitId(row.unit), row.kind, dong(row.plan), row.disbursed === null ? null : dong(row.disbursed), row.rate, row.rank, row.reason ?? null],
        ],
      ),
    );
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
    }
    await harness.owner(TENANT_A, [
      ["update machvon.organization_unit set code = 'BQL-N', name = 'Ban Bắc', unit_type = 'PROJECT_MANAGEMENT_BOARD' where id = $1", [unitId(NORTH)]],
      ["update machvon.organization_unit set code = 'BQL-S', name = 'Ban Nam', unit_type = 'PROJECT_MANAGEMENT_BOARD' where id = $1", [unitId(SOUTH)]],
    ]);
    for (const n of [LEADER, BRANCH, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_LEADER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: BRANCH, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [HomeWarningsController, HomeRankingsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: HOME_RANKING_VISIBILITY, useValue: () => Promise.resolve(visibility) },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    await rules();
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    visibility = 'ALL';
    await wipe();
  });

  it('serves the controllers of the warnings and the ranking in the module of HOME', () => {
    expect(homeModule.controllers).toEqual(expect.arrayContaining([HomeWarningsController, HomeRankingsController]));
  });

  describe('warnings (HOME-03, HOME-06)', () => {
    it('AC-ST-HOME-003-1: UAT-AC271 lists the open warning of a project with its rule, severity, the 22% observed against the 45% expected, its leader and the explanation that is open', async () => {
      const snapshotId = await snapshot();
      const slow = await project(snapshotId, NORTH);
      const id1 = await warning(slow.projectId, { snapshotId, status: 'EXPLANATION_REQUESTED', explanation: { status: 'REQUESTED' } });
      const reply = await warnings();
      expect(reply.status).toBe(200);
      expect(items(reply)).toHaveLength(1);
      const first = items(reply)[0] as Item;
      expect(first).toMatchObject({
        id: id1,
        severity: 'WARNING',
        status: 'EXPLANATION_REQUESTED',
        rule: { code: 'EW-01', name: 'Tỷ lệ giải ngân thấp hơn kỳ vọng', metric_code: 'YTD_RATE_GAP', comparator: 'GTE', threshold: { points: '10', critical_points: '20' } },
        project: { id: slow.projectId, code: slow.code, name: `Cầu ${slow.code}` },
        observed: { observed_pct: '22.0000', expected_pct: '45.0000', gap_points: '23.0000' },
        leader: { membership_id: memberId(LEADER) },
        explanation: { status: 'REQUESTED', is_late: false },
        snapshot_id: snapshotId,
        period_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(first.leader.display_name.length).toBeGreaterThan(0);
      // The list is light: the evidence and the history are of the profile.
      expect(first.history).toBeUndefined();
      expect(first.evidence).toBeUndefined();
    });

    it('AC-ST-HOME-003-2: UAT-AC271 gives the profile of a warning with an accepted explanation: the cause, the evidence in the snapshot, the leader, the explanation and the history', async () => {
      const snapshotId = await snapshot();
      const slow = await project(snapshotId, NORTH);
      const id1 = await warning(slow.projectId, { snapshotId, status: 'EXPLANATION_REQUESTED', explanation: { status: 'ACCEPTED' } });
      const reply = await warnings(`?warning_id=${id1}`);
      expect(reply.status).toBe(200);
      const profile = items(reply)[0] as Item;
      expect(profile).toMatchObject({ id: id1, rule: { code: 'EW-01', threshold: { points: '10' } }, observed: { observed_pct: '22.0000', expected_pct: '45.0000' }, explanation: { status: 'ACCEPTED' } });
      expect(profile.evidence).toMatchObject({ snapshot_id: snapshotId, as_of_date: '2027-10-12' });
      expect(profile.evidence.cells).toEqual([expect.objectContaining({ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', plan_pm_assigned_vnd: dong(1000), disbursed_treasury_vnd: dong(220), rate_pm_pct: '22.0000' })]);
      expect(profile.history.map((entry: Item) => entry.event)).toEqual(['OPENED', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'EXPLANATION_RESPONDED']);
      expect(profile.history[1]).toMatchObject({ by: memberId(BRANCH), note: 'The unit is on it.' });
    });

    it('lists the open warnings only, the newest first, and gives the profile of one that is closed', async () => {
      const snapshotId = await snapshot();
      const a = await project(snapshotId, NORTH);
      const b = await project(snapshotId, NORTH);
      const older = await warning(a.projectId, { snapshotId, openedAt: '2027-10-01T03:00:00Z' });
      const newer = await warning(b.projectId, { snapshotId, openedAt: '2027-10-04T03:00:00Z' });
      const closed = await warning((await project(snapshotId, NORTH)).projectId, { snapshotId, status: 'RESOLVED', openedAt: '2027-10-05T03:00:00Z' });
      expect(items(await warnings()).map((entry) => entry.id)).toEqual([newer, older]);
      const profile = await warnings(`?warning_id=${closed}`);
      expect(items(profile)[0]).toMatchObject({ id: closed, status: 'RESOLVED', resolution_reason: 'Caught up.' });
      expect(items(profile)[0]?.history.map((entry: Item) => entry.event)).toEqual(['OPENED', 'ACKNOWLEDGED', 'RESOLVED']);
    });

    it('narrows by severity, by rule and by snapshot, and pages by cursor', async () => {
      const first = await snapshot({ frozenAt: '2027-10-10T03:00:00Z' });
      const second = await snapshot({ frozenAt: '2027-10-14T03:00:00Z' });
      const p1 = await project(first, NORTH);
      const p2 = await project(second, NORTH);
      const p3 = await project(second, NORTH);
      const w1 = await warning(p1.projectId, { snapshotId: first, severity: 'INFO', openedAt: '2027-10-01T03:00:00Z' });
      const w2 = await warning(p2.projectId, { snapshotId: second, severity: 'CRITICAL', rule: 'EW-02', openedAt: '2027-10-02T03:00:00Z' });
      const w3 = await warning(p3.projectId, { snapshotId: second, severity: 'WARNING', openedAt: '2027-10-03T03:00:00Z' });
      expect(items(await warnings('?severity=CRITICAL')).map((entry) => entry.id)).toEqual([w2]);
      expect(items(await warnings('?rule_code=EW-01')).map((entry) => entry.id)).toEqual([w3, w1]);
      expect(items(await warnings(`?snapshot_id=${first}`)).map((entry) => entry.id)).toEqual([w1]);
      const page1 = await warnings('?limit=2');
      expect(items(page1).map((entry) => entry.id)).toEqual([w3, w2]);
      const page2 = await warnings(`?limit=2&cursor=${String(page1.json.next_cursor)}`);
      expect(items(page2).map((entry) => entry.id)).toEqual([w1]);
      expect(page2.json.next_cursor).toBeNull();
    });

    it('shows a reader only the warnings of the projects they may read, and says a warning of another place is not there (404) without naming it', async () => {
      const snapshotId = await snapshot();
      const north = await project(snapshotId, NORTH);
      const south = await project(snapshotId, SOUTH);
      const northWarning = await warning(north.projectId, { snapshotId });
      const southWarning = await warning(south.projectId, { snapshotId });
      expect(items(await warnings('', BRANCH)).map((entry) => entry.id)).toEqual([northWarning]);
      expect(items(await warnings('')).map((entry) => entry.id).sort()).toEqual([northWarning, southWarning].sort());
      const hidden = await warnings(`?warning_id=${southWarning}`, BRANCH);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(JSON.stringify(hidden.json)).not.toContain(south.code);
    });

    it('shows a project without a leader as having none, and reads nothing of another tenant', async () => {
      const snapshotId = await snapshot();
      const alone = await project(snapshotId, NORTH, { leader: false });
      await warning(alone.projectId, { snapshotId });
      expect(items(await warnings())[0]?.leader).toBeNull();
      expect(items(await warnings('', B_LEADER, TENANT_B))).toEqual([]);
    });

    it('refuses a request that is not well formed (422) and a member who may not read HOME (403)', async () => {
      for (const query of ['?severity=LOUD', '?rule_code=ew%2001', '?snapshot_id=nope', '?warning_id=nope', '?limit=0', '?cursor=%%%']) {
        const reply = await warnings(query);
        expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
      }
      expect((await warnings('', NOBODY)).status).toBe(403);
    });
  });

  describe('ranking (HOME-04)', () => {
    it('AC-ST-HOME-003-3, AC-ST-HOME-003-4: UAT-AC04 gives a table for each denominator apart, with the order, and the unit with a plan of nothing left out with its reason and no position', async () => {
      const snapshotId = await snapshot();
      await ranking(snapshotId, [
        { unit: NORTH, kind: 'PM_ASSIGNED', plan: 1000, disbursed: 140, rate: '14.0000', rank: 2 },
        { unit: SOUTH, kind: 'PM_ASSIGNED', plan: 500, disbursed: 250, rate: '50.0000', rank: 1 },
        { unit: ROOT, kind: 'PM_ASSIGNED', plan: 0, disbursed: null, rate: null, rank: null, reason: 'ZERO_DENOMINATOR' },
        { unit: NORTH, kind: 'TOTAL_INCL_LOCAL', plan: 1250, disbursed: 140, rate: '11.2000', rank: 1 },
        { unit: SOUTH, kind: 'TOTAL_INCL_LOCAL', plan: 500, disbursed: 40, rate: '8.0000', rank: 2 },
        { unit: ROOT, kind: 'TOTAL_INCL_LOCAL', plan: 0, disbursed: null, rate: null, rank: null, reason: 'ZERO_DENOMINATOR' },
      ]);
      await harness.owner(TENANT_A, [["update machvon.organization_unit set code = 'ROOT', name = 'Tổng', unit_type = 'PROJECT_MANAGEMENT_BOARD' where id = $1", [unitId(ROOT)]]]);
      const reply = await rankings();
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ snapshot_id: snapshotId, as_of_date: '2027-10-12', visibility: 'ALL', legal_confirmation_refs: ['CXN-03'], definition_status: 'PROPOSED_PENDING_SIGNOFF' });
      expect(tables(reply).map((table) => [table.comparison_group, table.denominator_kind])).toEqual([
        ['PROJECT_MANAGEMENT_BOARD', 'PM_ASSIGNED'],
        ['PROJECT_MANAGEMENT_BOARD', 'TOTAL_INCL_LOCAL'],
      ]);
      const [pm, total] = tables(reply) as [Item, Item];
      // The order is not the same over the two denominators: they are two tables, never one.
      expect(pm.ranked.map((row: Item) => [row.rank, row.unit.code, row.rate_pct])).toEqual([[1, 'BQL-S', '50.0000'], [2, 'BQL-N', '14.0000']]);
      expect(total.ranked.map((row: Item) => [row.rank, row.unit.code, row.rate_pct])).toEqual([[1, 'BQL-N', '11.2000'], [2, 'BQL-S', '8.0000']]);
      expect(pm.ranked[1]).toMatchObject({ plan_vnd: dong(1000), disbursed_vnd: dong(140), unit: { id: unitId(NORTH), name: 'Ban Bắc' } });
      // The unit with a plan of nothing has no position and says why (AC-ST-HOME-003-4).
      expect(pm.excluded).toEqual([{ rank: null, unit: { id: unitId(ROOT), code: 'ROOT', name: 'Tổng' }, plan_vnd: '0', disbursed_vnd: null, rate_pct: null, excluded_reason: 'ZERO_DENOMINATOR' }]);
      expect(total.excluded).toHaveLength(1);
    });

    it('narrows to a group and a denominator, opens on the latest snapshot that has a ranking, and the one that is named', async () => {
      const older = await snapshot({ frozenAt: '2027-10-08T03:00:00Z' });
      const newer = await snapshot({ frozenAt: '2027-10-14T03:00:00Z' });
      await snapshot({ frozenAt: '2027-10-15T03:00:00Z' });
      await ranking(older, [{ unit: NORTH, kind: 'PM_ASSIGNED', plan: 100, disbursed: 10, rate: '10.0000', rank: 1 }]);
      await ranking(newer, [
        { unit: NORTH, kind: 'PM_ASSIGNED', plan: 100, disbursed: 20, rate: '20.0000', rank: 1 },
        { unit: NORTH, kind: 'TOTAL_INCL_LOCAL', plan: 100, disbursed: 20, rate: '20.0000', rank: 1 },
        { group: 'COMMUNE', unit: SOUTH, kind: 'PM_ASSIGNED', plan: 100, disbursed: 30, rate: '30.0000', rank: 1 },
      ]);
      // The latest snapshot has no ranking (it is later than the one that has): the ranking opens on the latest that has.
      expect((await rankings()).json.snapshot_id).toBe(newer);
      expect((await rankings(`?snapshot_id=${older}`)).json.snapshot_id).toBe(older);
      const narrowed = await rankings('?comparison_group=COMMUNE&denominator_kind=PM_ASSIGNED');
      expect(tables(narrowed).map((table) => [table.comparison_group, table.denominator_kind, table.ranked.length])).toEqual([['COMMUNE', 'PM_ASSIGNED', 1]]);
    });

    it('answers 404 when no snapshot has a ranking, or the one named has none or is not frozen, and 422 for a request that is not well formed', async () => {
      expect((await rankings()).status).toBe(404);
      const building = await snapshot({ frozen: false });
      await ranking(building, [{ unit: NORTH, kind: 'PM_ASSIGNED', plan: 1, disbursed: 1, rate: '100.0000', rank: 1 }]);
      const bare = await snapshot();
      for (const id1 of [building, bare, randomUUID()]) expect([(await rankings(`?snapshot_id=${id1}`)).status]).toEqual([404]);
      for (const query of ['?snapshot_id=nope', '?comparison_group=bad%20group', '?denominator_kind=OTHER']) {
        const reply = await rankings(query);
        expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
      }
      expect((await rankings('', NOBODY)).status).toBe(403);
    });

    it('BR-HOME-06: shows only the units the reader may read when the policy of the tenant is OWN_ONLY, and says so', async () => {
      const snapshotId = await snapshot();
      await ranking(snapshotId, [
        { unit: NORTH, kind: 'PM_ASSIGNED', plan: 1000, disbursed: 140, rate: '14.0000', rank: 2 },
        { unit: SOUTH, kind: 'PM_ASSIGNED', plan: 500, disbursed: 250, rate: '50.0000', rank: 1 },
      ]);
      visibility = 'OWN_ONLY';
      const own = await rankings('', BRANCH);
      expect(own.json.visibility).toBe('OWN_ONLY');
      expect((tables(own)[0] as Item).ranked.map((row: Item) => row.unit.code)).toEqual(['BQL-N']);
      // The rank of the unit is its rank among all (the table is not re-numbered for the reader).
      expect((tables(own)[0] as Item).ranked[0].rank).toBe(2);
      visibility = 'ALL';
      expect(((await rankings('', BRANCH)).json.tables as Item[])[0]?.ranked).toHaveLength(2);
    });

    it('reads the ranking of its own tenant only', async () => {
      const snapshotId = await snapshot();
      await ranking(snapshotId, [{ unit: NORTH, kind: 'PM_ASSIGNED', plan: 1, disbursed: 1, rate: '100.0000', rank: 1 }]);
      expect((await rankings('', B_LEADER, TENANT_B)).status).toBe(404);
      expect((await rankings(`?snapshot_id=${snapshotId}`, B_LEADER, TENANT_B)).status).toBe(404);
    });
  });
});
