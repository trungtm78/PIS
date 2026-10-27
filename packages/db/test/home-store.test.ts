import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeStore } from '../src/home-store';
import type { ScopeBuilder } from '../src/scope-version';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new HomeStore();

const WORKER = '00000000-0000-4000-8000-000000000000';
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const NOW = new Date('2026-10-28T03:00:00Z');
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
/** What a leader of one unit reads: the projects and the units under its path. */
const under =
  (column: string, path: string): ScopeBuilder =>
  (first) => ({ sql: `starts_with(${column}, $${first})`, params: [path] });
const NORTH_PATH = `/${unitId(ROOT)}/${unitId(NORTH)}/`;

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(1)), work);

async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let triggers = 0;
const project = (id: string, code: string, unit: number, tenant = TENANT_A): [string, unknown[]] => [
  `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
   values ($1, $2, $3, 'Project', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
  [tenant, id, code, unitId(unit), randomUUID()],
];

describe('HomeStore (ST-HOME-001): what the command center counts beside the rates', () => {
  const northProject = randomUUID();
  const southProject = randomUUID();
  const foreignProject = randomUUID();
  let ruleId = '';
  let periodId = '';
  let snapshotId = '';

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: NORTH, path: NORTH_PATH, parent: ROOT },
      { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
    ]);
    await harness.seedMembership(TENANT_A, 1, ROOT);
    ruleId = randomUUID();
    periodId = randomUUID();
    snapshotId = randomUUID();
    await seed([
      project(northProject, 'DA-N', NORTH),
      project(southProject, 'DA-S', SOUTH),
      [
        `insert into machvon.early_warning_rule (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, legal_basis, effective_from, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, 'EW-01', 'Rule', 'YTD_RATE_GAP', 'GTE', '{}'::jsonb, 'WARNING', 'PROJECT', 'Legal basis', '2026-01-01', 1, 'PUBLISHED', $3, $4, $4)`,
        [TENANT_A, ruleId, memberId(1), WORKER],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, 'RP-HOME', 1, '2026-10-24', '2026-10-30', now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $3, $4, $4)`,
        [TENANT_A, periodId, randomUUID(), WORKER],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2026-10-27', '2026-10-27', 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 0, repeat('a', 64), $4, now(), $4, $4)`,
        [TENANT_A, snapshotId, periodId, WORKER],
      ],
    ]);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await seed([project(foreignProject, 'DA-X', ROOT, TENANT_B)]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    // A warning is kept by the database, so the rows are removed the way they were put in.
    await seed([['delete from machvon.early_warning', []], ['delete from machvon.explanation_request', []], ['delete from machvon.reallocation_proposal', []]]);
  });

  const warning = (status: string, project: string | null, unit: number | null, key: string): [string, unknown[]] => [
    `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, unit_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, explanation_request_id, resolution_reason, closed_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'WARNING', '{}'::jsonb, $8, $9, case when $9 = 'EXPLANATION_REQUESTED' then gen_random_uuid() end, case when $9 = 'RESOLVED' then 'done' end, case when $9 = 'RESOLVED' then now() end, $10, $10)`,
    [TENANT_A, randomUUID(), ruleId, project, unit === null ? null : unitId(unit), periodId, snapshotId, `EW-01|${key}`, status, WORKER],
  ];
  const explanation = (status: string, due: string, project: string | null, unit: number | null): [string, unknown[]] => [
    `insert into machvon.explanation_request (tenant_id, id, subject_kind, project_id, unit_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, response_text, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $10, 'Why is the disbursement slow?', $6, $7::timestamptz, $7::timestamptz, $8, case when $8 = 'RESPONDED' then 'The works were delayed by the weather.' end, $9, $9)`,
    [TENANT_A, randomUUID(), project === null ? 'UNIT' : 'PROJECT', project, unit === null ? null : unitId(unit), memberId(1), due, status, WORKER, `T-${++triggers}`],
  ];
  const reallocation = (status: string, unit: number, code: string): [string, unknown[]] => [
    `insert into machvon.reallocation_proposal (tenant_id, id, code, plan_year, scope_unit_id, basis_snapshot_id, source_capital_plan_id, reason, status, submitted_by, submitted_at, created_by, updated_by)
     values ($1, $2, $3, 2026, $4, $5, $6, 'Move capital from slow projects to fast ones', $7, case when $7 = 'SUBMITTED' then $8::uuid end, case when $7 = 'SUBMITTED' then now() end, $8, $8)`,
    [TENANT_A, randomUUID(), code, unitId(unit), snapshotId, randomUUID(), status, WORKER],
  ];

  it('counts the warnings that still ask something of someone, in the scope of the reader, and under the unit they narrowed to', async () => {
    await seed([
      warning('OPEN', northProject, null, 'a'),
      warning('ACKNOWLEDGED', northProject, null, 'b'),
      warning('EXPLANATION_REQUESTED', southProject, null, 'c'),
      warning('RESOLVED', northProject, null, 'd'),
      warning('OPEN', null, NORTH, 'e'),
    ]);
    const all = await as((tx) => store.counts(tx, { projectScope: EVERYTHING, unitScope: EVERYTHING, unitId: undefined, now: NOW }));
    expect(all.openWarnings).toBe(4);
    const north = await as((tx) => store.counts(tx, { projectScope: under('ou.path', NORTH_PATH), unitScope: under('u.path', NORTH_PATH), unitId: undefined, now: NOW }));
    expect(north.openWarnings).toBe(3);
    // The reader chose a unit: only what is under it, whatever else they may read.
    const narrowed = await as((tx) => store.counts(tx, { projectScope: EVERYTHING, unitScope: EVERYTHING, unitId: unitId(SOUTH), now: NOW }));
    expect(narrowed.openWarnings).toBe(1);
  });

  it('counts the explanations that are late by their status or by their day, and not the ones that were answered or are not yet due', async () => {
    await seed([
      explanation('OVERDUE', '2026-10-01T00:00:00Z', northProject, null),
      explanation('REQUESTED', '2026-10-27T00:00:00Z', northProject, null),
      explanation('REQUESTED', '2026-11-05T00:00:00Z', northProject, null),
      explanation('RESPONDED', '2026-10-01T00:00:00Z', northProject, null),
      explanation('CANCELLED', '2026-10-01T00:00:00Z', northProject, null),
      explanation('OVERDUE', '2026-10-02T00:00:00Z', southProject, null),
      explanation('REQUESTED', '2026-10-02T00:00:00Z', null, SOUTH),
    ]);
    const all = await as((tx) => store.counts(tx, { projectScope: EVERYTHING, unitScope: EVERYTHING, unitId: undefined, now: NOW }));
    expect(all.overdueExplanations).toBe(4);
    const north = await as((tx) => store.counts(tx, { projectScope: under('ou.path', NORTH_PATH), unitScope: under('u.path', NORTH_PATH), unitId: undefined, now: NOW }));
    expect(north.overdueExplanations).toBe(2);
  });

  it('counts the proposals of reallocation that wait for a decision, in the units of the reader', async () => {
    await seed([reallocation('SUBMITTED', NORTH, 'RA-1'), reallocation('SUBMITTED', SOUTH, 'RA-2'), reallocation('DRAFT', NORTH, 'RA-3'), reallocation('WITHDRAWN', NORTH, 'RA-4')]);
    const all = await as((tx) => store.counts(tx, { projectScope: EVERYTHING, unitScope: EVERYTHING, unitId: undefined, now: NOW }));
    expect(all.pendingReallocations).toBe(2);
    const north = await as((tx) => store.counts(tx, { projectScope: under('ou.path', NORTH_PATH), unitScope: under('u.path', NORTH_PATH), unitId: undefined, now: NOW }));
    expect(north.pendingReallocations).toBe(1);
  });

  it('reads nothing of another tenant, and nothing when the reader has no scope at all', async () => {
    await seed([warning('OPEN', northProject, null, 'a'), explanation('OVERDUE', '2026-10-01T00:00:00Z', northProject, null), reallocation('SUBMITTED', NORTH, 'RA-1')]);
    const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
    expect(await as((tx) => store.counts(tx, { projectScope: nothing, unitScope: nothing, unitId: undefined, now: NOW }))).toEqual({ openWarnings: 0, overdueExplanations: 0, pendingReallocations: 0 });
    expect(await as((tx) => store.counts(tx, { projectScope: EVERYTHING, unitScope: EVERYTHING, unitId: undefined, now: NOW }), TENANT_B)).toEqual({ openWarnings: 0, overdueExplanations: 0, pendingReallocations: 0 });
  });
});
