import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { checkRule, expectedRatePct } from '@machvon/kernel';
import type { EffectiveAccess, RuleDraft, RuleInput, Scope } from '@machvon/kernel';
import { DisWarningStore } from '../src/dis-warning-store';
import { projectScope } from '../src/prj-project-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new DisWarningStore();

const AUTHOR = 1;
const APPROVER = 2;
const HANDLER = 3;
const WORKER = 9;
const FAMILY = 0xa1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const NOW = new Date('2027-06-15T03:00:00Z');
const CUTOFF = '2027-06-13';
const EXPECTED = expectedRatePct(CUTOFF);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = HANDLER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const accessOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(HANDLER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'DIS', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const wholeScope = projectScope(accessOf(['warning.handle', 'warning.read'], { kind: 'TENANT' }), 'warning.handle', NOW);
const elsewhereScope = projectScope(accessOf(['warning.handle', 'warning.read'], { kind: 'UNIT_SUBTREE', refIds: [unitId(ELSEWHERE)], paths: ['/u3/'] }), 'warning.handle', NOW);

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
const rule = (over: RuleInput = {}): RuleDraft =>
  checkRule({
    rule_code: 'EW-01',
    name: 'Disbursement below the expected curve',
    metric_code: 'YTD_RATE_GAP',
    comparator: 'GTE',
    threshold_json: { points: 10 },
    severity: 'WARNING',
    scope_kind: 'PROJECT',
    legal_basis: 'DIS BR-DIS-13 [assumption until the finance office signs]',
    effective_from: '2027-01-01',
    ...over,
  });
const ew02 = (over: RuleInput = {}): RuleDraft =>
  rule({ rule_code: 'EW-02', name: 'No report after the deadline', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { explanation_due_days: 3 }, severity: 'CRITICAL', auto_explanation: true, ...over });
const ew05 = (): RuleDraft => rule({ rule_code: 'EW-05', name: 'Capital without a national code', metric_code: 'NATIONAL_CODE_MISSING', comparator: 'MISSING', threshold_json: {} });
const ew07 = (): RuleDraft => rule({ rule_code: 'EW-07', name: 'Negative change in the period', metric_code: 'PERIOD_DELTA_NEGATIVE', comparator: 'LT', threshold_json: {} });

/** A rule of a code of its own, written by the author and published by the approver. */
async function published(draft: RuleDraft) {
  const made = await as((tx) => store.createRuleVersion(tx, draft, memberId(AUTHOR)), TENANT_A, AUTHOR);
  return (await as((tx) => store.publish(tx, made.id, made.version, memberId(APPROVER)), TENANT_A, APPROVER)).rule;
}

interface Line {
  project: string;
  rate?: string | null;
  planTotal?: string;
  delta?: string | null;
}

/** A period of its own (the deadline is the day before `NOW` unless said) and the projects named in a snapshot of it that is frozen. */
async function frozenWorld(options: { lines: Line[]; deadline?: string; kind?: 'PERIOD_CLOSE' | 'ADHOC'; period?: string; periodType?: 'WEEK' | 'MONTH'; nationalCode?: Record<string, string> }) {
  counter += 1;
  const periodId = options.period ?? id(FAMILY, 1000 + counter);
  if (options.period === undefined) {
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, $5::timestamptz, 'DEFAULT', $8, 2027, 'OPEN', $6, $7, $7)`,
        [TENANT_A, periodId, `WP-${counter}`, new Date(Date.UTC(2040, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), options.deadline ?? '2027-06-14T03:00:00Z', id(FAMILY, 40), memberId(AUTHOR), options.periodType ?? 'WEEK'],
      ],
    ]);
  }
  const snapshotId = await snapshotOf(periodId, options.lines, options.kind ?? 'PERIOD_CLOSE');
  return { periodId, snapshotId };
}

const projects = new Map<string, string>();
async function projectOf(name: string, unit = HERE, code?: string): Promise<string> {
  const known = projects.get(name);
  if (known !== undefined) return known;
  counter += 1;
  const projectId = id(FAMILY, 100 + counter);
  projects.set(name, projectId);
  await seedReplica([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, national_project_code)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', $6)`,
      [TENANT_A, projectId, `${name}-${counter}`, unitId(unit), id(FAMILY, 30), code ?? null],
    ],
  ]);
  return projectId;
}

/** A snapshot of the period with a carrier line for each project (and the other cells), written while it is being built and then frozen, the one frozen before for the period and kind superseded. */
async function snapshotOf(periodId: string, lines: Line[], kind: 'PERIOD_CLOSE' | 'ADHOC'): Promise<string> {
  const snapshotId = randomUUID();
  await seedReplica([
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
       values ($1, $2, $3, $4, $5::timestamptz, $6::date, $6::date, 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $7, $8, $8)`,
      [TENANT_A, snapshotId, periodId, kind, NOW.toISOString(), CUTOFF, lines.length, memberId(WORKER)],
    ],
  ]);
  for (const line of lines) {
    const projectId = await projectOf(line.project);
    await seedReplica([
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, period_delta_vnd, rate_total_pct, rate_null_reason, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', $5::numeric, 0, $5::numeric, $6::numeric, $7::numeric, $8, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(HERE), line.planTotal ?? '1000000000', line.delta ?? null, line.rate === undefined ? '50.0000' : line.rate, line.rate === null ? 'NO_DATA' : null],
      ],
    ]);
  }
  await seedReplica([
    [`update machvon.period_snapshot set status = 'SUPERSEDED' where tenant_id = $1 and period_id = $2 and snapshot_kind = $3 and status = 'FROZEN' and id <> $4`, [TENANT_A, periodId, kind, snapshotId]],
    [`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, memberId(WORKER), NOW.toISOString()]],
  ]);
  return snapshotId;
}

const evaluate = (snapshotId: string, at = NOW) => as((tx) => store.evaluate(tx, snapshotId, at, memberId(WORKER)), TENANT_A, WORKER);
const warnings = (filter: { ruleCode?: string; status?: string; projectId?: string } = {}, scope = wholeScope) => as((tx) => store.list(tx, scope, filter, { limit: 100, after: undefined }));
const submit = async (projectId: string, periodId: string, status: 'DRAFT' | 'SUBMITTED' | 'RETURNED'): Promise<void> => {
  const reportId = randomUUID();
  await seedReplica([
    [
      `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 1, 'DRAFT', false, 1, repeat('b', 64), 'WEEKLY', 'YTD', $6, $6)`,
      [TENANT_A, reportId, projectId, periodId, id(FAMILY, 50), memberId(AUTHOR)],
    ],
    ...(status === 'DRAFT' ? [] : ([[`update machvon.report_revision set status = $2, submitted_by = $3, submitted_at = now(), returned_reason = case when $2 = 'RETURNED' then 'Fix the cell.' end where id = $1`, [reportId, status, memberId(AUTHOR)]]] as Array<[string, unknown[]]>)),
  ]);
};

describe('DisWarningStore (the early-warning rules and warnings, ST-DIS-012)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: HERE, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    for (const n of [AUTHOR, APPROVER, HANDLER, WORKER]) await harness.seedMembership(TENANT_A, n, ROOT);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the rules', () => {
    it('makes a revision of a rule as a draft, the next one of the same code the next revision, and keeps what each says', async () => {
      const first = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R1' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      expect(first).toMatchObject({ ruleCode: 'EW-R1', revision: 1, status: 'DRAFT', approvedBy: null, version: 1, severity: 'WARNING', threshold: { points: '10' }, comparator: 'GTE', autoExplanation: false, effectiveUntil: null });
      const second = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R1', threshold_json: { points: 15 } }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      expect(second).toMatchObject({ revision: 2, threshold: { points: '15' } });
      expect((await as((tx) => store.listRules(tx))).filter((row) => row.ruleCode === 'EW-R1').map((row) => row.revision)).toEqual([2, 1]);
      expect(await as((tx) => store.findRule(tx, randomUUID()))).toBeUndefined();
    });

    it('AC-ST-DIS-012-3 / UAT-PLAN-70: the author does not publish their own rule (403 SELF_APPROVAL_DENIED); another person does, under the version shown, and the rule has who approved it', async () => {
      const made = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R2' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      expect(await refusal(as((tx) => store.publish(tx, made.id, 1, memberId(AUTHOR)), TENANT_A, AUTHOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.publish(tx, made.id, 7, memberId(APPROVER)), TENANT_A, APPROVER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await as((tx) => store.findRule(tx, made.id)))?.status).toBe('DRAFT');
      const done = await as((tx) => store.publish(tx, made.id, 1, memberId(APPROVER)), TENANT_A, APPROVER);
      expect(done.rule).toMatchObject({ status: 'PUBLISHED', approvedBy: memberId(APPROVER), version: 2 });
      expect(done.retiredId).toBeNull();
      expect(await refusal(as((tx) => store.publish(tx, made.id, 2, memberId(APPROVER)), TENANT_A, APPROVER))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      expect(await refusal(as((tx) => store.publish(tx, randomUUID(), 1, memberId(APPROVER)), TENANT_A, APPROVER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('AC-ST-DIS-012-3: a published rule is never edited, only versioned: publishing the next revision retires the one in force, and an older draft cannot take its place', async () => {
      const one = await published(rule({ rule_code: 'EW-R3' }));
      const older = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R3', threshold_json: { points: 11 } }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      const newer = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R3', threshold_json: { points: 12 } }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      const done = await as((tx) => store.publish(tx, newer.id, newer.version, memberId(APPROVER)), TENANT_A, APPROVER);
      expect(done.retiredId).toBe(one.id);
      expect((await as((tx) => store.findRule(tx, one.id)))?.status).toBe('RETIRED');
      expect(await refusal(as((tx) => store.publish(tx, older.id, older.version, memberId(APPROVER)), TENANT_A, APPROVER))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'revision', extensions: { published_revision: 3 } });
      const inForce = (await as((tx) => store.listRules(tx))).filter((row) => row.ruleCode === 'EW-R3' && row.status === 'PUBLISHED');
      expect(inForce.map((row) => row.revision)).toEqual([3]);
    });

    it('what the table refuses: a change of what a rule says, a delete, a way back from published, two published revisions of a code, who approved it changing, and the author approving', async () => {
      const draft = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R4' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
      expect(await guard("update machvon.early_warning_rule set threshold_json = '{\"points\": 1}'::jsonb where id = $1", [draft.id])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning_rule set severity = 'CRITICAL' where id = $1", [draft.id])).toMatchObject({ code: '23514' });
      expect(await guard('delete from machvon.early_warning_rule where id = $1', [draft.id])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning_rule set status = 'PUBLISHED' where id = $1", [draft.id])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning_rule set status = 'PUBLISHED', approved_by = created_by where id = $1", [draft.id])).toMatchObject({ code: '23514' });
      const live = await as((tx) => store.publish(tx, draft.id, 1, memberId(APPROVER)), TENANT_A, APPROVER);
      expect(await guard("update machvon.early_warning_rule set status = 'DRAFT' where id = $1", [live.rule.id])).toMatchObject({ code: '23514' });
      expect(await guard('update machvon.early_warning_rule set approved_by = $2 where id = $1', [live.rule.id, memberId(HANDLER)])).toMatchObject({ code: '23514' });
      const rival = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-R4' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      expect(await guard("update machvon.early_warning_rule set status = 'PUBLISHED', approved_by = $2 where id = $1", [rival.id, memberId(APPROVER)])).toMatchObject({ code: '23505' });
    });

    it('gives a tenant the four rules of the release as drafts, once, and leaves a code that has any revision as it is', async () => {
      const made = await as((tx) => store.ensureSeedRules(tx, memberId(WORKER)), TENANT_A, WORKER);
      expect(made).toBe(4);
      expect(await as((tx) => store.ensureSeedRules(tx, memberId(WORKER)), TENANT_A, WORKER)).toBe(0);
      const seeded = (await as((tx) => store.listRules(tx))).filter((row) => ['EW-01', 'EW-02', 'EW-05', 'EW-07'].includes(row.ruleCode) && row.createdBy === memberId(WORKER));
      expect(seeded.map((row) => [row.ruleCode, row.metricCode, row.status, row.severity, row.autoExplanation])).toEqual([
        ['EW-01', 'YTD_RATE_GAP', 'DRAFT', 'WARNING', false],
        ['EW-02', 'REPORT_OVERDUE', 'DRAFT', 'CRITICAL', true],
        ['EW-05', 'NATIONAL_CODE_MISSING', 'DRAFT', 'WARNING', false],
        ['EW-07', 'PERIOD_DELTA_NEGATIVE', 'DRAFT', 'WARNING', false],
      ]);
      expect(seeded.every((row) => row.legalBasis.length > 3)).toBe(true);
    });
  });

  describe('the evaluation after a snapshot is frozen', () => {
    /** Warnings and published rules of the other tests are put away: a project that is not in the snapshot of a test would otherwise be cleared by it, as it should be. */
    const reset = (): Promise<void> =>
      seedReplica([
        ['delete from machvon.early_warning', []],
        ["update machvon.early_warning_rule set status = 'RETIRED' where status = 'PUBLISHED'", []],
      ]);
    beforeEach(reset);

    it('AC-ST-DIS-012-1 / UAT-AC252: opens one warning for a project 10 points under the expected curve (20% against the curve), and the second snapshot updates what it saw and opens no second one', async () => {
      await published(rule());
      const a = await projectOf('P-A-002');
      const first = await frozenWorld({ lines: [{ project: 'P-A-002', rate: '20.0000' }] });
      const done = await evaluate(first.snapshotId);
      expect(done).toMatchObject({ skipped: undefined, rules: 1, updated: 0, cleared: [] });
      expect(done.opened).toHaveLength(1);
      expect(done.opened[0]).toMatchObject({ ruleCode: 'EW-01', severity: 'WARNING', projectId: a, dedupeKey: `EW-01|${a}|2027`, autoExplanation: false });
      const [one] = await warnings({ ruleCode: 'EW-01', projectId: a });
      expect(one).toMatchObject({ status: 'OPEN', severity: 'WARNING', dedupeKey: `EW-01|${a}|2027`, snapshotId: first.snapshotId, projectCode: expect.stringContaining('P-A-002'), closedAt: null });
      expect(one?.observed).toEqual({ metric: 'YTD_RATE_GAP', observed_pct: '20.0000', expected_pct: EXPECTED, gap_points: expect.any(String) });
      // The same period is built and frozen again, the project at 22%: one warning, the new figure.
      const second = await frozenWorld({ lines: [{ project: 'P-A-002', rate: '22.0000' }], period: first.periodId });
      const again = await evaluate(second.snapshotId);
      expect(again).toMatchObject({ opened: [], updated: 1, cleared: [] });
      const rows = await warnings({ ruleCode: 'EW-01', projectId: a });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: one?.id, status: 'OPEN', snapshotId: second.snapshotId });
      expect(rows[0]?.observed).toMatchObject({ observed_pct: '22.0000' });
      expect((rows[0]?.version ?? 0) > (one?.version ?? 0)).toBe(true);
      // The snapshot that was replaced is not evaluated any more: an older figure does not undo a newer one.
      expect(await evaluate(first.snapshotId)).toMatchObject({ skipped: 'SUPERSEDED', opened: [], updated: 0 });
      expect((await warnings({ ruleCode: 'EW-01', projectId: a }))[0]?.observed).toMatchObject({ observed_pct: '22.0000' });
    });

    it('keeps a project at the curve, a project with no rate and a rule that is not published out of the warnings, and counts the CRITICAL threshold of the rule', async () => {
      await published(rule({ threshold_json: { points: 10, critical_points: 30 } }));
      const world = await frozenWorld({
        lines: [
          { project: 'P-OK', rate: '40.0000' },
          { project: 'P-NO-RATE', rate: null },
          { project: 'P-SLOW', rate: '30.0000' },
          { project: 'P-VERY-SLOW', rate: '5.0000' },
        ],
      });
      const done = await evaluate(world.snapshotId);
      expect(done.opened.map((item) => [item.projectId === projects.get('P-SLOW') ? 'slow' : item.projectId === projects.get('P-VERY-SLOW') ? 'very' : 'other', item.severity]).sort()).toEqual([
        ['slow', 'WARNING'],
        ['very', 'CRITICAL'],
      ]);
      await seedReplica([["update machvon.early_warning_rule set status = 'RETIRED' where rule_code = 'EW-01' and status = 'PUBLISHED'", []]]);
      expect(await evaluate(world.snapshotId)).toMatchObject({ rules: 0, opened: [], updated: 0, cleared: [] });
      // A rule that is only a draft opens nothing.
      await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-DRAFT' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      expect(await evaluate(world.snapshotId)).toMatchObject({ rules: 0 });
    });

    it('AC-ST-DIS-012-2 / UAT-AC253: opens a CRITICAL warning for a project that has handed in no report once the deadline has passed, with the explanation to ask for in 3 days; a report that was handed in, a draft and a deadline ahead behave as they should', async () => {
      await published(ew02());
      const missing = await projectOf('P-LATE');
      const handed = await projectOf('P-HANDED');
      const draft = await projectOf('P-DRAFT');
      const returned = await projectOf('P-RETURNED');
      const world = await frozenWorld({ lines: [{ project: 'P-LATE' }, { project: 'P-HANDED' }, { project: 'P-DRAFT' }, { project: 'P-RETURNED' }], deadline: '2027-06-14T03:00:00Z' });
      await submit(handed, world.periodId, 'SUBMITTED');
      await submit(draft, world.periodId, 'DRAFT');
      await submit(returned, world.periodId, 'RETURNED');
      const done = await evaluate(world.snapshotId);
      expect(done.opened.map((item) => item.projectId).sort()).toEqual([missing, draft, returned].sort());
      expect(done.opened[0]).toMatchObject({ ruleCode: 'EW-02', severity: 'CRITICAL', autoExplanation: true, explanationDueDays: 3 });
      expect(done.opened[0]?.dedupeKey).toBe(`EW-02|${done.opened[0]?.projectId}|2027|${world.periodId}`);
      expect(done.opened[0]?.observed).toEqual({ metric: 'REPORT_OVERDUE', days_past_deadline: 1 });
      // Before the deadline passes there is nothing to say.
      await reset();
      expect(await evaluate(world.snapshotId, new Date('2027-06-13T03:00:00Z'))).toMatchObject({ opened: [] });
    });

    it('EW-05 and EW-07: capital with no national code, and a fall in the period, each once per its key; a project with the code or with no fall is left alone', async () => {
      await published(ew05());
      await published(ew07());
      await projectOf('P-CODED', HERE, 'QG-001');
      const bare = await projectOf('P-BARE');
      const falling = await projectOf('P-FALLING');
      const world = await frozenWorld({ lines: [{ project: 'P-CODED', delta: '5' }, { project: 'P-BARE', delta: '0' }, { project: 'P-FALLING', delta: '-20000000', planTotal: '0' }] });
      const done = await evaluate(world.snapshotId);
      expect(done.opened.map((item) => [item.ruleCode, item.projectId]).sort()).toEqual(
        [
          ['EW-05', bare],
          ['EW-07', falling],
        ].sort(),
      );
      expect(done.opened.find((item) => item.ruleCode === 'EW-07')?.observed).toEqual({ metric: 'PERIOD_DELTA_NEGATIVE', delta_vnd: '-20000000' });
      expect(done.opened.find((item) => item.ruleCode === 'EW-07')?.dedupeKey).toBe(`EW-07|${falling}|2027|${world.periodId}`);
      expect(done.opened.find((item) => item.ruleCode === 'EW-05')?.dedupeKey).toBe(`EW-05|${bare}|2027`);
    });

    it('closes a warning as AUTO_CLEARED when the violation is gone in the next snapshot, opens a new one if it comes back, and leaves a warning of another rule or another year alone', async () => {
      await published(rule());
      const a = await projectOf('P-CLEARS');
      const first = await frozenWorld({ lines: [{ project: 'P-CLEARS', rate: '10.0000' }] });
      await evaluate(first.snapshotId);
      const [open] = await warnings({ projectId: a });
      expect(open?.status).toBe('OPEN');
      // A warning of the year before is not touched by a snapshot of this year.
      await seedReplica([
        [
          `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, unit_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, 'WARNING', '{}'::jsonb, $8, 'OPEN', $9, $9)`,
          [TENANT_A, randomUUID(), open?.ruleId, a, unitId(HERE), first.periodId, first.snapshotId, `EW-01|${a}|2026`, memberId(WORKER)],
        ],
      ]);
      const second = await frozenWorld({ lines: [{ project: 'P-CLEARS', rate: '60.0000' }], period: first.periodId });
      const done = await evaluate(second.snapshotId);
      expect(done.cleared).toEqual([{ id: open?.id, ruleCode: 'EW-01', projectId: a, dedupeKey: `EW-01|${a}|2027` }]);
      const [closed] = await warnings({ status: 'RESOLVED', projectId: a });
      expect(closed).toMatchObject({ id: open?.id, status: 'RESOLVED', resolutionReason: 'AUTO_CLEARED', closedBy: null });
      expect(closed?.closedAt).not.toBeNull();
      expect((await warnings({ status: 'OPEN', projectId: a })).map((row) => row.dedupeKey)).toEqual([`EW-01|${a}|2026`]);
      // It comes back: a new warning, the closed one stays closed.
      const third = await frozenWorld({ lines: [{ project: 'P-CLEARS', rate: '5.0000' }], period: first.periodId });
      expect((await evaluate(third.snapshotId)).opened).toHaveLength(1);
      expect((await warnings({ projectId: a })).filter((row) => row.dedupeKey.endsWith('|2027')).map((row) => row.status)).toEqual(['OPEN', 'RESOLVED']);
    });

    it('evaluates a close snapshot that is frozen and nothing else: not an ad hoc one, not one that is only built, not one that does not exist', async () => {
      await published(rule());
      const adhoc = await frozenWorld({ lines: [{ project: 'P-ADHOC', rate: '1.0000' }], kind: 'ADHOC' });
      expect(await evaluate(adhoc.snapshotId)).toMatchObject({ skipped: 'NOT_CLOSE', opened: [] });
      const building = await frozenWorld({ lines: [{ project: 'P-BUILDING', rate: '1.0000' }] });
      await seedReplica([[`update machvon.period_snapshot set status = 'BUILDING', payload_sha256 = null, frozen_by = null, frozen_at = null where id = $1`, [building.snapshotId]]]);
      expect(await evaluate(building.snapshotId)).toMatchObject({ skipped: 'NOT_FROZEN', opened: [] });
      expect(await refusal(evaluate(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.evaluate(tx, adhoc.snapshotId, NOW, memberId(WORKER)), TENANT_B, WORKER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('an older period never overwrites what a newer one has said: its snapshot, processed later, is left alone (OLDER_PERIOD) and the warnings stay as they were', async () => {
      await published(rule());
      const a = await projectOf('P-ORDER');
      const older = await frozenWorld({ lines: [{ project: 'P-ORDER', rate: '5.0000' }] });
      const newer = await frozenWorld({ lines: [{ project: 'P-ORDER', rate: '8.0000' }] });
      expect((await evaluate(newer.snapshotId)).opened).toHaveLength(1);
      expect(await evaluate(older.snapshotId)).toMatchObject({ skipped: 'OLDER_PERIOD', opened: [], updated: 0, cleared: [] });
      const [row] = await warnings({ projectId: a });
      expect(row).toMatchObject({ status: 'OPEN', snapshotId: newer.snapshotId });
      expect(row?.observed).toMatchObject({ observed_pct: '8.0000' });
    });

    it('ST-DIS-015: leaves the close snapshot of a monthly period alone (NOT_WEEKLY): an older month never overwrites or clears what a newer week has said', async () => {
      await published(rule());
      const a = await projectOf('P-MONTH');
      const week = await frozenWorld({ lines: [{ project: 'P-MONTH', rate: '8.0000' }] });
      expect((await evaluate(week.snapshotId)).opened).toHaveLength(1);
      // A month that closes later, with a figure that would clear the warning, says nothing about it.
      const month = await frozenWorld({ lines: [{ project: 'P-MONTH', rate: '60.0000' }], periodType: 'MONTH' });
      expect(await evaluate(month.snapshotId)).toMatchObject({ skipped: 'NOT_WEEKLY', opened: [], updated: 0, cleared: [] });
      const [row] = await warnings({ projectId: a });
      expect(row).toMatchObject({ status: 'OPEN', snapshotId: week.snapshotId });
    });

    it('serialises the publication of two drafts of one code that arrive together: one revision is in force at the end, and neither of them meets the unique index', async () => {
      const first = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-RACE' }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      const second = await as((tx) => store.createRuleVersion(tx, rule({ rule_code: 'EW-RACE', threshold_json: { points: 12 } }), memberId(AUTHOR)), TENANT_A, AUTHOR);
      const results = await Promise.allSettled([
        as((tx) => store.publish(tx, first.id, first.version, memberId(APPROVER)), TENANT_A, APPROVER),
        as((tx) => store.publish(tx, second.id, second.version, memberId(APPROVER)), TENANT_A, APPROVER),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') expect((result.reason as { code?: string }).code).toBe('STAGE_TRANSITION_DENIED');
      }
      const live = (await as((tx) => store.listRules(tx))).filter((row) => row.ruleCode === 'EW-RACE' && row.status === 'PUBLISHED');
      expect(live).toHaveLength(1);
      expect(live[0]?.revision).toBe(2);
    });

    it('counts how many warnings a rule would open on the latest frozen close snapshot, without opening one', async () => {
      const world = await frozenWorld({ lines: [{ project: 'P-PV1', rate: '5.0000' }, { project: 'P-PV2', rate: '42.0000' }, { project: 'P-PV3', rate: '1.0000' }] });
      const draft = rule({ threshold_json: { points: 10 } });
      const counted = await as((tx) => store.preview(tx, draft, NOW));
      expect(counted.snapshotId).toBe(world.snapshotId);
      expect(counted.wouldOpen).toBe(2);
      expect(await as((tx) => store.preview(tx, rule({ threshold_json: { points: 50 } }), NOW))).toMatchObject({ wouldOpen: 0 });
      expect(await warnings()).toEqual([]);
      // The count is of the projects the caller may read.
      expect(await as((tx) => store.preview(tx, draft, NOW, elsewhereScope))).toMatchObject({ snapshotId: world.snapshotId, wouldOpen: 0 });
      expect(await as((tx) => store.preview(tx, draft, NOW, wholeScope))).toMatchObject({ wouldOpen: 2 });
      expect(await as((tx) => store.preview(tx, draft, NOW), TENANT_B, HANDLER)).toEqual({ snapshotId: null, wouldOpen: 0 });
    });

    it('counts the warnings still to be handled by severity, for the gauge', async () => {
      await published(rule({ threshold_json: { points: 10, critical_points: 30 } }));
      const world = await frozenWorld({ lines: [{ project: 'P-G1', rate: '30.0000' }, { project: 'P-G2', rate: '2.0000' }, { project: 'P-G3', rate: '1.0000' }] });
      await evaluate(world.snapshotId);
      const counts = await as((tx) => store.openCounts(tx));
      expect(counts.sort((a, b) => a.severity.localeCompare(b.severity))).toEqual([
        { severity: 'CRITICAL', count: 2 },
        { severity: 'WARNING', count: 1 },
      ]);
    });
  });

  describe('handling a warning', () => {
    beforeEach(() =>
      seedReplica([
        ['delete from machvon.early_warning', []],
        ["update machvon.early_warning_rule set status = 'RETIRED' where status = 'PUBLISHED'", []],
      ]),
    );
    const opened = async (name: string, unit = HERE): Promise<string> => {
      await published(rule());
      const projectId = await projectOf(name, unit);
      const world = await frozenWorld({ lines: [{ project: name, rate: '1.0000' }] });
      await evaluate(world.snapshotId);
      return ((await warnings({ projectId }))[0] as { id: string }).id;
    };
    const handle = (warningId: string, action: 'acknowledge' | 'dismiss', over: { version?: number; reason?: string; owner?: string; scope?: typeof wholeScope } = {}) =>
      as((tx) => store.handle(tx, warningId, action, { expectedVersion: over.version ?? 1, actor: memberId(HANDLER), reason: over.reason ?? 'Seen by the unit head.', ownerMembershipId: over.owner, scope: over.scope ?? wholeScope }));

    it('acknowledges an open warning with a note and the owner who will handle it, who and when kept, and the version moved once', async () => {
      const warningId = await opened('P-H1');
      const done = await handle(warningId, 'acknowledge', { owner: memberId(APPROVER) });
      expect(done.before).toBe('OPEN');
      expect(done.warning).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: memberId(HANDLER), acknowledgementNote: 'Seen by the unit head.', ownerMembershipId: memberId(APPROVER), version: 2, closedAt: null });
      expect(done.warning.acknowledgedAt).not.toBeNull();
      expect(await refusal(handle(warningId, 'acknowledge', { version: 2 }))).toMatchObject({ code: 'WARNING_STATE_INVALID', status: 409, detail: 'status', extensions: { warning_status: 'ACKNOWLEDGED' } });
    });

    it('dismisses an open or an acknowledged warning with a reason: closed, by whom and when, and a closed warning is neither handled again nor opened again by the same snapshot', async () => {
      const first = await opened('P-H2');
      const dismissed = await handle(first, 'dismiss', { reason: 'The project is on the plan of the next quarter.' });
      expect(dismissed.warning).toMatchObject({ status: 'DISMISSED', resolutionReason: 'The project is on the plan of the next quarter.', closedBy: memberId(HANDLER) });
      expect(dismissed.warning.closedAt).not.toBeNull();
      expect(await refusal(handle(first, 'dismiss', { version: 2 }))).toMatchObject({ code: 'WARNING_STATE_INVALID', status: 409 });
      expect(await refusal(handle(first, 'acknowledge', { version: 2 }))).toMatchObject({ code: 'WARNING_STATE_INVALID', status: 409 });
      const second = await opened('P-H3');
      await handle(second, 'acknowledge');
      expect((await handle(second, 'dismiss', { version: 2 })).warning.status).toBe('DISMISSED');
    });

    it('is for the projects in the scope of the caller (404 for another branch), under the version shown (409), and an owner has to be a member of the tenant (422)', async () => {
      const warningId = await opened('P-H4');
      expect(await refusal(handle(warningId, 'acknowledge', { scope: elsewhereScope }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as((tx) => store.find(tx, warningId, elsewhereScope))).toBeUndefined();
      expect(await warnings({}, elsewhereScope)).toEqual([]);
      expect(await refusal(handle(warningId, 'acknowledge', { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(handle(warningId, 'acknowledge', { owner: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      expect(await refusal(as((tx) => store.handle(tx, randomUUID(), 'dismiss', { expectedVersion: 1, actor: memberId(HANDLER), reason: 'Not there at all.', scope: wholeScope })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await as((tx) => store.find(tx, warningId)))?.status).toBe('OPEN');
    });

    it('lists the warnings of the scope newest first, narrowed by status, severity, rule, project and unit, a page at a time, and another tenant sees none', async () => {
      await published(rule({ threshold_json: { points: 10, critical_points: 30 } }));
      const world = await frozenWorld({ lines: [{ project: 'P-L1', rate: '30.0000' }, { project: 'P-L2', rate: '2.0000' }, { project: 'P-L3', rate: '1.0000' }] });
      await evaluate(world.snapshotId);
      const all = await warnings();
      expect(all).toHaveLength(3);
      expect(all.map((row) => row.openedAt)).toEqual([...all.map((row) => row.openedAt)].sort().reverse());
      expect((await warnings({ status: 'OPEN' })).length).toBe(3);
      expect((await warnings({ status: 'RESOLVED' })).length).toBe(0);
      expect((await as((tx) => store.list(tx, wholeScope, { severity: 'CRITICAL' }, { limit: 10, after: undefined }))).length).toBe(2);
      expect((await as((tx) => store.list(tx, wholeScope, { ruleCode: 'EW-01' }, { limit: 10, after: undefined }))).length).toBe(3);
      expect((await as((tx) => store.list(tx, wholeScope, { ruleCode: 'EW-99' }, { limit: 10, after: undefined }))).length).toBe(0);
      expect((await as((tx) => store.list(tx, wholeScope, { unitId: unitId(HERE) }, { limit: 10, after: undefined }))).length).toBe(3);
      const first = await as((tx) => store.list(tx, wholeScope, {}, { limit: 2, after: undefined }));
      const last = first[1] as { openedAt: string; id: string };
      const rest = await as((tx) => store.list(tx, wholeScope, {}, { limit: 2, after: { openedAt: last.openedAt, id: last.id } }));
      expect([...first, ...rest].map((row) => row.id)).toEqual(all.map((row) => row.id));
      expect(await as((tx) => store.list(tx, wholeScope, {}, { limit: 10, after: undefined }), TENANT_B, HANDLER)).toEqual([]);
    });

    it('what the table refuses: a warning is kept and what opened it never changes, it moves only along its graph, a closed one is final, and the dedupe key is held by one open warning', async () => {
      const warningId = await opened('P-H5');
      const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
      expect(await guard('delete from machvon.early_warning where id = $1', [warningId])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning set dedupe_key = 'EW-01|x|2027' where id = $1", [warningId])).toMatchObject({ code: '23514' });
      expect(await guard('update machvon.early_warning set project_id = $2 where id = $1', [warningId, randomUUID()])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning set status = 'EXPLANATION_REQUESTED' where id = $1", [warningId])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning set status = 'RESOLVED' where id = $1", [warningId])).toMatchObject({ code: '23514' });
      // While it is open the severity follows the latest snapshot; once it is closed nothing changes.
      await handle(warningId, 'dismiss', { reason: 'Closed to try the table.' });
      expect(await guard("update machvon.early_warning set severity = 'INFO' where id = $1", [warningId])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.early_warning set resolution_reason = 'changed' where id = $1", [warningId])).toMatchObject({ code: '23514' });
      const second = await opened('P-H6');
      const [row] = await owner<{ rule_id: string; project_id: string; period_id: string; snapshot_id: string; dedupe_key: string }>('select rule_id, project_id, period_id, snapshot_id, dedupe_key from machvon.early_warning where id = $1', [second]);
      expect(
        await guard(
          `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, unit_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
           values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, 'WARNING', '{}'::jsonb, $6, 'OPEN', $7, $7)`,
          [row?.rule_id, row?.project_id, unitId(HERE), row?.period_id, row?.snapshot_id, row?.dedupe_key, memberId(WORKER)],
        ),
      ).toMatchObject({ code: '23505' });
      expect(await guard("update machvon.early_warning set status = 'DISMISSED' where id = $1", [second])).toMatchObject({ code: '23514' });
    });
  });
});
