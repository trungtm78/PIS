import { randomUUID } from 'node:crypto';
import { BASELINE_PACK, applyBaseline } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertRefusedForPermission, assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * Design cases of the enterprise edition of the module DIS that no suite named yet (docs/uat/ent and docs/uat/dis): the soft close and the lock of a period with a report handed in late (UAT-AC245), the snapshot of the
 * enterprise period from the refusal to the next revision after a reopening (UAT-DIS-ENT3A-1) and the calendar of the periods with the rule of the deadlines (UAT-DIS-ENT4C-1). The world is the whole enterprise edition over
 * a real database; every figure and code a case names is read back from the answer, the table, the audit trail or the outbox.
 * The case UAT-AC245 is dated 2026-10-02; the world runs on the real clock, so the period W2026-40 is seeded with the deadline of that day (it is in the past, as the case needs) and the soft close is made now.
 */
jest.setTimeout(600_000);

const WORKER = '00000000-0000-4000-8000-000000000000';
const FAMILY = 0xc5;
const DEPARTMENT = 2;
const OTHER_DEPARTMENT = 3;
const PERSONAS = {
  planner: ['period.manage', 'reporting_period.read', 'report.read', 'adm.governance.manage', 'adm.governance.read'],
  manager: ['period.manage', 'period.lock', 'reporting_period.read'],
  maker: ['report.create', 'report.edit', 'report.submit', 'report.read', 'report_revision.read'],
  'rule-submitter': ['adm.governance.manage', 'adm.governance.read'],
  'rule-approver': ['adm.governance.approve', 'adm.governance.read'],
  reader: ['report.read'],
  'snap-builder': ['funding.snapshot.build', 'funding.snapshot.read'],
  'snap-freezer': ['funding.snapshot.freeze', 'funding.snapshot.read'],
  'snap-both': ['funding.snapshot.build', 'funding.snapshot.freeze', 'funding.snapshot.read'],
  'reopen-both': ['period.reopen.request', 'period.reopen.approve'],
  'reopen-approver': ['period.reopen.approve'],
  'audit-admin': ['adm.audit_detail.manage', 'adm.audit_detail.read'],
  'audit-reader': ['audit_event.read'],
  nobody: ['uat.nothing'],
};
const FX_DIS_001 = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];
const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };
const AREA = id(FAMILY, 30);
const FUND_SOURCE = id(FAMILY, 31);

describe('UAT of the periods, the enterprise snapshot and the calendar of the enterprise edition (cases of docs/uat/dis and docs/uat/ent)', () => {
  const world = new UatWorld();
  let counter = 0;
  const drafts = new Map<string, { projectId: string; planId: string }>();

  /** A project of the root unit with a plan version of 2026 that allocated 500,000,000 to the year plan of the central budget: what a report is drafted against. */
  async function reportProject(): Promise<{ projectId: string; planId: string }> {
    counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `UAT-C5-${counter}`, unitId(ROOT_UNIT), AREA],
      ],
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', timestamptz '2026-01-10T03:00:00Z')`, [TENANT_A, planId, projectId, id(FAMILY, 32)]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2026, 500000000, 0, $4, 'CENTRAL')`,
        [TENANT_A, planId, FUND_SOURCE, projectId],
      ],
    ]);
    return { projectId, planId };
  }

  const weeklyPeriod = async (code: string, start: string, end: string, deadline: string): Promise<string> => {
    const created = randomUUID();
    // The period is bound to the published version of the calendar of the tenant, as a generated one is; the deadline of a week is judged by that calendar (Friday 10:00 of Vietnam).
    const calendar = (await world.rows<{ id: string }>("select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.master_type = 'CALENDAR' and v.status in ('APPROVED', 'EFFECTIVE') order by v.revision desc limit 1"))[0]?.id as string;
    await world.seedAsAdmin([
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $6::timestamptz, 'UAT-C5', 'WEEK', 2026, 'OPEN', $7, $8, $8)`,
        [TENANT_A, created, code, start, end, deadline, calendar, WORKER],
      ],
    ]);
    return created;
  };

  const monthlyLocked = async (code: string, start: string, end: string): Promise<string> => {
    const created = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'ENTERPRISE', 'MONTH', 2026, 'LOCKED', $6, $7, $8, $9, $10, $10)`,
        [TENANT_A, created, code, start, end, `${end}T05:00:00Z`, `${end}T06:00:00Z`, memberId(1), randomUUID(), memberId(1)],
      ],
    ]);
    return created;
  };

  const enterpriseProject = async (unit: number, label: string): Promise<string> => {
    const created = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, created, `UAT-C5-ENT-${label}`, `Enterprise project ${label}`, unitId(unit), unitId(ROOT_UNIT), AREA],
      ],
    ]);
    return created;
  };

  const plannedCell = async (projectId: string, amount: string): Promise<void> => {
    const version = randomUUID();
    await world.seedAsAdmin([
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z'::timestamptz)`, [TENANT_A, version, projectId, randomUUID()]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack) values ($1, $2, $3, $4, 'EQUITY', 2026, $5::numeric, 0, 'ALL', 'ENTERPRISE')`,
        [TENANT_A, randomUUID(), version, randomUUID(), amount],
      ],
    ]);
  };

  /** The accepted actuals up to March, as the figure store leaves them after a preparer and a checker. */
  const acceptedActual = (projectId: string, amount: string): Promise<void> =>
    world.seedAsAdmin([
      [
        `insert into machvon.plan_figure_revision (tenant_id, id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, status, prepared_by, approved_by, approved_at, updated_by)
         select $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, m::smallint, case when m = 3 then $4::numeric else 0 end, 'REPORTED', '2026-04-03'::date, 'ACCEPTED', $5::uuid, $6::uuid, now(), $5::uuid from generate_series(1, 3) as m`,
        [TENANT_A, randomUUID(), projectId, amount, memberId(1), memberId(2)],
      ],
    ]);

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT)}/`, parent: ROOT_UNIT },
        { n: OTHER_DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(OTHER_DEPARTMENT)}/`, parent: ROOT_UNIT },
      ]);
      // The calendar of the reporting periods is the one of the baseline of the tenant (the periods of the calendar test are generated from it).
      await (w.harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER));
      await w.seedAsAdmin([
        [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW', 'EFFECTIVE', $3, $3)`, [TENANT_A, id(FAMILY, 33), memberId(1)]],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
           values ($1, $2, $3, 'FUND_SOURCE', 'NSTW', 1, 'Central budget', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
          [TENANT_A, FUND_SOURCE, id(FAMILY, 33), memberId(1)],
        ],
      ]);
    });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  const periodOf = (code: string): Promise<{ id: string; status: string; version: string; locked_at: string | null; soft_closed_at: string | null }[]> =>
    world.rows('select id, status, version::text as version, locked_at::text as locked_at, soft_closed_at::text as soft_closed_at from machvon.reporting_period where code = $1', [code]);
  const draftBody = (projectId: string, periodId: string, planId: string): Record<string, unknown> => ({ project_id: projectId, period_id: periodId, plan_version_id: planId, report_type: 'WEEKLY', measurement_basis: 'YTD', funding_lines: FX_DIS_001, ...PROGRESS });
  const createDraft = async (persona: string, periodId: string): Promise<string> => {
    const { projectId, planId } = await reportProject();
    const made = await world.as(persona, 'POST', '/reports', { body: draftBody(projectId, periodId, planId) });
    assertStatus(made, 200);
    drafts.set(made.json.resource_id as string, { projectId, planId });
    return made.json.resource_id as string;
  };

  it('UAT-AC245 a period soft closed after its deadline still takes a report, handed in late (200, is_late true); the lock sets locked_at under the table check, and a report handed in after it is 409 PERIOD_LOCKED; the period never reads "Closed"', async () => {
    // W2026-40 is open with its deadline of 2026-10-02T03:00Z (in the past on the real clock); two makers each have a draft in it.
    const period = await weeklyPeriod('W2026-40', '2026-09-26', '2026-10-02', '2026-10-02T03:00:00Z');
    const late = await createDraft('maker', period);
    const afterLock = await createDraft('maker', period);
    expect((await periodOf('W2026-40'))[0]).toMatchObject({ status: 'OPEN', version: '1', locked_at: null });
    // 1. The planner soft closes the period (the deadline has passed): SOFT_CLOSED, version 2.
    const closed = await world.as('planner', 'POST', `/reporting-periods/${period}/soft-close`, { ifMatch: 1, body: { reason: 'The deadline has passed' } });
    assertStatus(closed, 200);
    expect(closed.json).toMatchObject({ status: 'SOFT_CLOSED', resource_version: 2, resource_id: period });
    expect((await periodOf('W2026-40'))[0]).toMatchObject({ status: 'SOFT_CLOSED', locked_at: null });
    // 2. The maker hands in R-late: accepted (200), and it says that it is late; the revision, the audit row and the event say so too.
    const submitted = await world.as('maker', 'POST', `/reports/${late}/submit`, { ifMatch: 1, body: {} });
    assertStatus(submitted, 200);
    expect(submitted.json).toMatchObject({ status: 'SUBMITTED', is_late: true, resource_id: late });
    expect((await world.rows<{ is_late: boolean; status: string }>('select is_late, status from machvon.report_revision where id = $1', [late]))[0]).toEqual({ is_late: true, status: 'SUBMITTED' });
    expect((await world.audits(late, 'dis.report_submitted'))[0]?.safe_diff).toMatchObject({ is_late: true });
    expect((await world.events(late, 'report.submitted.v1'))[0]?.payload).toMatchObject({ report_id: late, is_late: true });
    // 3. The manager locks the period: LOCKED with locked_at (the check of the table ties the two), by the manager.
    const locked = await world.as('manager', 'POST', `/reporting-periods/${period}/lock`, { ifMatch: 2, body: { reason: 'Locked after the review' } });
    assertStatus(locked, 200);
    expect(locked.json).toMatchObject({ status: 'LOCKED', resource_version: 3 });
    const row = (await periodOf('W2026-40'))[0];
    expect(row).toMatchObject({ status: 'LOCKED', version: '3' });
    expect(row?.locked_at).not.toBeNull();
    await expect(
      world.seedAsAdmin([
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, 'W2026-40-BAD', 1, '2026-10-03', '2026-10-09', '2026-10-09T03:00:00Z', 'UAT-C5', 'WEEK', 2026, 'LOCKED', $3, $4, $4)`,
          [TENANT_A, randomUUID(), randomUUID(), WORKER],
        ],
      ]),
    ).rejects.toMatchObject({ constraint: 'reporting_period_lock_chk' });
    // 4. R-late2 is handed in after the lock: 409 PERIOD_LOCKED, and the draft is as it was.
    const refused = await world.as('maker', 'POST', `/reports/${afterLock}/submit`, { ifMatch: 1, body: {} });
    assertStatus(refused, 409, 'PERIOD_LOCKED');
    expect((await world.rows<{ status: string; version: string }>('select status, version::text as version from machvon.report_revision where id = $1', [afterLock]))[0]).toEqual({ status: 'DRAFT', version: '1' });
    expect(await world.events(afterLock, 'report.submitted.v1')).toEqual([]);
    // The period reads its status, and no value "Closed" anywhere.
    const read = await world.as('planner', 'GET', `/resources/reporting_period/${period}`);
    assertStatus(read, 200);
    expect(read.json).toMatchObject({ code: 'W2026-40', status: 'LOCKED', version: 3, locked_by: expect.any(String) });
    expect(JSON.stringify(read.json)).not.toContain('"Closed"');
    expect((await world.audits(period, 'dis.period_soft_closed')).length + (await world.audits(period, 'dis.period_locked')).length).toBe(2);
  });

  it('UAT-DIS-ENT3A-1 the snapshot of the enterprise period: incomplete is 422 with the missing units and no row; once the actual is accepted it is built; the builder cannot freeze it (403 SELF_APPROVAL_DENIED), another person does and its SHA-256 never changes; a second build is 409 SNAPSHOT_FROZEN until a reopening with a reason and a second approver, then the next revision supersedes the old one', async () => {
    const period = await monthlyLocked('UAT-C5-2026-03', '2026-03-01', '2026-03-31');
    const project = await enterpriseProject(DEPARTMENT, 'A');
    await plannedCell(project, '1000');
    const build = (persona: string): Promise<Reply> => world.as(persona, 'POST', '/enterprise-snapshots', { body: { period_id: period } });
    const freeze = (persona: string, snapshot: string, version: number): Promise<Reply> => world.as(persona, 'POST', `/enterprise-snapshots/${snapshot}/freeze`, { ifMatch: version });
    const snapshots = (): Promise<Array<{ id: string; revision: number; status: string; payload_sha256: string | null; supersedes_id: string | null }>> =>
      world.rows(`select id, revision, status, payload_sha256, supersedes_id from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE' and period_id = $1 order by revision, created_at`, [period]);
    // Step 1: one planned cell has no accepted actual: 422, the unit of the project is named, nothing is written.
    const incomplete = await build('snap-both');
    assertStatus(incomplete, 422, 'ENTERPRISE_SNAPSHOT_INCOMPLETE');
    expect((incomplete.json.missing_units as Array<{ unit_id: string; projects: Array<{ project_id: string }> }>).map((unit) => [unit.unit_id, unit.projects.map((one) => one.project_id)])).toEqual([[unitId(DEPARTMENT), [project]]]);
    expect(await snapshots()).toEqual([]);
    // Step 2: the actual is accepted and the snapshot is built (for review, revision 1).
    await acceptedActual(project, '100');
    const built = await build('snap-both');
    assertStatus(built, 200);
    expect(built.json).toMatchObject({ status: 'BUILDING', resource_version: 1 });
    const first = built.json.resource_id as string;
    // Step 3: the builder cannot freeze it, a person without the right cannot, another person does, and the hash is then fixed.
    assertStatus(await freeze('snap-both', first, 1), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await freeze('snap-builder', first, 1), 403);
    const frozen = await freeze('snap-freezer', first, 1);
    assertStatus(frozen, 200);
    expect(frozen.json).toMatchObject({ status: 'FROZEN', resource_version: 2 });
    const [one] = await snapshots();
    expect(one).toMatchObject({ id: first, revision: 1, status: 'FROZEN', supersedes_id: null });
    expect(one?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const hash = one?.payload_sha256;
    expect((await world.audits(first, 'enterprise.snapshot_frozen'))[0]?.safe_diff).toMatchObject({ revision: 1, payload_sha256: hash });
    // Step 4: building the same period again is refused while it is frozen, and a reopening that is only requested changes nothing.
    const refused = await build('snap-both');
    assertStatus(refused, 409, 'SNAPSHOT_FROZEN');
    expect(refused.json).toMatchObject({ reopen_required: true, snapshot_id: first });
    const requested = await world.as('reopen-both', 'POST', `/reporting-periods/${period}/reopen-requests`, { body: { scope_kind: 'PERIOD', reason: 'The owner of the unit corrects the actual of the month', window_hours: 24 } });
    assertStatus(requested, 200);
    assertStatus(await build('snap-both'), 409, 'SNAPSHOT_FROZEN');
    // The requester cannot approve his own request; a second person approves with a reason.
    const reopenId = requested.json.resource_id as string;
    assertStatus(await world.as('reopen-both', 'POST', `/period-reopens/${reopenId}/decision`, { ifMatch: requested.json.resource_version as number, body: { decision: 'approve', reason: 'approved by the requester' } }), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await world.as('reopen-approver', 'POST', `/period-reopens/${reopenId}/decision`, { ifMatch: requested.json.resource_version as number, body: { decision: 'approve', reason: 'The correction is justified' } }), 200);
    // The next revision is built, frozen by somebody else, and supersedes the first, which keeps its hash.
    const next = await build('snap-both');
    assertStatus(next, 200);
    expect(next.json.resource_id).not.toBe(first);
    const second = next.json.resource_id as string;
    assertStatus(await freeze('snap-freezer', second, 1), 200);
    const after = await snapshots();
    expect(after.map((row) => [row.revision, row.status, row.supersedes_id])).toEqual([[1, 'SUPERSEDED', null], [2, 'FROZEN', first]]);
    expect(after[0]?.payload_sha256).toBe(hash);
    expect(after[1]?.id).toBe(second);
    expect((await world.audits(second, 'enterprise.snapshot_frozen'))[0]?.safe_diff).toMatchObject({ revision: 2, supersedes_id: first });
  });

  it('UAT-DIS-ENT4C-1 periods of a month, a quarter and a year are generated and the calendar is read: the entry deadline of a generated period is the one of the rule in force on the day it was generated and never changes, the other steps follow the rule in force, and a step with no fact is not tracked', async () => {
    const generate = (year: number, type: 'MONTH' | 'QUARTER' | 'YEAR'): Promise<Reply> => world.as('planner', 'POST', '/reporting-periods/generate', { body: { calendar_code: 'DEFAULT', fiscal_year: year, period_type: type } });
    const itemOf = (reply: Reply, code: string): { generated: boolean; period_id: string | null; steps: Array<{ kind: string; due_at: string }> } =>
      (reply.json.items as Array<{ code: string; kind: string }>).find((item) => item.kind === 'REPORT_PERIOD' && item.code === code) as never;
    const dueOf = (item: { steps: Array<{ kind: string; due_at: string }> }, kind: string): string | undefined => item.steps.find((step) => step.kind === kind)?.due_at;
    // A tenant on the built-in schedule: no rule was approved, and the schedule says it is not confirmed.
    const before = await world.as('reader', 'GET', '/reporting-calendar?year=2027');
    assertStatus(before, 200);
    expect((before.json.schedules as Array<Record<string, unknown>>).find((one) => one.code === 'MONTH')).toMatchObject({ source: 'DEFAULT', version: 0, unverified: true });
    expect(itemOf(before, 'M2027-09')).toMatchObject({ generated: false, period_id: null });
    for (const type of ['MONTH', 'QUARTER', 'YEAR'] as const) assertStatus(await generate(2027, type), 200);
    const read = await world.as('reader', 'GET', '/reporting-calendar?year=2027');
    expect(itemOf(read, 'M2027-09')).toMatchObject({ generated: true });
    expect(dueOf(itemOf(read, 'M2027-09'), 'ENTRY')).toBe('2027-10-05T03:00:00.000Z');
    expect(dueOf(itemOf(read, 'M2027-09'), 'UNIT_APPROVAL')).toBe('2027-10-07T03:00:00.000Z');
    expect(dueOf(itemOf(read, 'Q2027-1'), 'ENTRY')).toBe('2027-04-10T03:00:00.000Z');
    expect(dueOf(itemOf(read, 'Y2027'), 'ENTRY')).toBe('2028-01-20T03:00:00.000Z');
    // The tenant approves a new version of the rule of the months (written by one person, submitted by a second, approved by a third) that is in force from today.
    const today = vietnamDateOf(new Date());
    const steps = [{ kind: 'ENTRY', offset_days: 8 }, { kind: 'UNIT_APPROVAL', offset_days: 9 }, { kind: 'PLANNING_REVIEW', offset_days: 11 }, { kind: 'PERIOD_CLOSE', offset_days: 13 }, { kind: 'PUSH', offset_days: 15, time: '16:00' }];
    const draft = await world.as('planner', 'POST', '/governance-rules', {
      body: { rule_type: 'REPORTING_SCHEDULE', code: 'MONTH', params: { steps, reminder_days_before: [2], overdue_repeat_days: 2, overdue_max_reminders: 3, escalate_after_overdue_days: 0 }, effective_from: today, reason: 'The deadline is moved by the planning board' },
    });
    assertStatus(draft, 201);
    const ruleId = draft.json.resource_id as string;
    const submitted = await world.as('rule-submitter', 'POST', `/governance-rules/${ruleId}/submit`, { ifMatch: draft.json.resource_version as number, body: { reason: 'Ready for the decision' } });
    assertStatus(submitted, 200);
    assertStatus(await world.as('rule-approver', 'POST', `/governance-rules/${ruleId}/approve`, { ifMatch: submitted.json.resource_version as number, body: { reason: 'Approved by the head of the planning board' } }), 200);
    // The months of 2028 are generated after the rule: they carry the new entry deadline; the months of 2027 keep theirs.
    assertStatus(await generate(2028, 'MONTH'), 200);
    const after = await world.as('reader', 'GET', '/reporting-calendar?year=2028');
    expect((after.json.schedules as Array<Record<string, unknown>>).find((one) => one.code === 'MONTH')).toMatchObject({ source: 'RULE', version: 1, unverified: false });
    expect(dueOf(itemOf(after, 'M2028-09'), 'ENTRY')).toBe('2028-10-08T03:00:00.000Z');
    const old = await world.as('reader', 'GET', '/reporting-calendar?year=2027');
    expect(dueOf(itemOf(old, 'M2027-09'), 'ENTRY')).toBe('2027-10-05T03:00:00.000Z');
    expect((await world.rows<{ deadline_at: string }>(`select to_char(deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deadline_at from machvon.reporting_period where code = 'M2027-09'`))[0]?.deadline_at).toBe('2027-10-05T03:00:00Z');
    // The other steps of a period that exists follow the rule in force now.
    expect(dueOf(itemOf(old, 'M2027-09'), 'UNIT_APPROVAL')).toBe('2027-10-09T03:00:00.000Z');
    expect(dueOf(itemOf(old, 'M2027-09'), 'PUSH')).toBe('2027-10-15T09:00:00.000Z');
    // The board of a period: the review of the planning board and the push have no fact on this tenant (no approval chain runs), so they are not tracked, never open.
    const periodId = itemOf(old, 'M2027-09').period_id as string;
    const board = await world.as('reader', 'GET', `/reporting-calendar/periods/${periodId}/board`);
    assertStatus(board, 200);
    expect((board.json.period_steps as Array<{ kind: string; state: string }>).filter((step) => ['PLANNING_REVIEW', 'PUSH'].includes(step.kind)).map((step) => [step.kind, step.state])).toEqual([['PLANNING_REVIEW', 'NOT_TRACKED'], ['PUSH', 'NOT_TRACKED']]);
    assertStatus(await world.as('reader', 'GET', `/reporting-calendar/periods/${randomUUID()}/board`), 404);
  });

  it('UAT-ADM-ENT4E-1 the full before and after of a class is kept only after the class is switched on with a reason (422 without, 409 on a stale version): the detail row hashes to the detail_ref of the sealed row, secrets are masked at any depth, the row is cut at the byte cap, and a user without audit_event.read gets 403', async () => {
    const period = await weeklyPeriod('W2026-41', '2026-10-03', '2026-10-09', '2026-10-09T03:00:00Z');
    const auditOf = async (reportId: string, action: string): Promise<{ id: string; safe_diff: { detail_ref?: { sha256: string; bytes: number; truncated: boolean; redacted_paths: string[] } } }> =>
      (await world.rows<{ id: string; safe_diff: { detail_ref?: { sha256: string; bytes: number; truncated: boolean; redacted_paths: string[] } } }>('select id, safe_diff from machvon.audit_event where resource_id = $1 and action = $2', [reportId, action]))[0] as never;
    const detailRows = (auditId: string): Promise<Array<{ after_value: Record<string, unknown> | string; before_value: unknown; detail_sha256: string; bytes: number; redacted_paths: string[]; truncated: boolean }>> =>
      world.rows('select before_value, after_value, detail_sha256, bytes, redacted_paths, truncated from machvon.audit_event_detail where audit_event_id = $1', [auditId]);
    const switchOn = (body: Record<string, unknown>): Promise<Reply> =>
      world.as('audit-admin', 'POST', '/audit-detail-policies', { body: { resource_type: 'report_revision', enabled: true, max_bytes: 1024, sensitive_keys: ['cumulative_vnd'], reason: 'The audit of the weekly reports needs the figures', expected_version: 0, ...body } });
    // Run 1: the class is off, so the sealed row says nothing of a detail and no detail row is written.
    const first = await createDraft('maker', period);
    const sealed1 = await auditOf(first, 'dis.report_created');
    expect(sealed1.safe_diff).not.toHaveProperty('detail_ref');
    expect(await detailRows(sealed1.id)).toEqual([]);
    // The switch needs a reason (422 VALIDATION_FAILED, nothing is stored) and the version of the policy it was read at (409 VERSION_CONFLICT once the policy exists).
    assertStatus(await switchOn({ reason: '' }), 422, 'VALIDATION_FAILED');
    expect(((await world.as('audit-admin', 'GET', '/audit-detail-policies')).json.items as unknown[]).length).toBe(0);
    const on = await switchOn({});
    assertStatus(on, 200);
    expect(on.json).toMatchObject({ resource_version: 1 });
    assertStatus(await switchOn({ expected_version: 0 }), 409, 'VERSION_CONFLICT');
    expect((await world.as('audit-admin', 'GET', '/audit-detail-policies')).json.items).toMatchObject([{ resource_type: 'report_revision', enabled: true, max_bytes: 1024, version: 1 }]);
    // Run 2: one detail row whose SHA-256 is the detail_ref of the sealed row, with the secret key masked at its depth (lines.<cell>.cumulative_vnd).
    const second = await createDraft('maker', period);
    const sealed2 = await auditOf(second, 'dis.report_created');
    const stored = await detailRows(sealed2.id);
    expect(stored).toHaveLength(1);
    expect(sealed2.safe_diff.detail_ref).toMatchObject({ sha256: stored[0]?.detail_sha256, truncated: false });
    expect(stored[0]?.detail_sha256).toMatch(/^[0-9a-f]{64}$/);
    const after = JSON.stringify(stored[0]?.after_value);
    expect(after).toContain('"cumulative_vnd":"[REDACTED]"');
    expect(after).not.toMatch(/"cumulative_vnd":"[0-9]/);
    expect(stored[0]?.redacted_paths.length).toBe(6);
    expect(stored[0]?.redacted_paths.every((path) => path.endsWith('.cumulative_vnd'))).toBe(true);
    expect(stored[0]?.truncated).toBe(false);
    // The detail cannot be changed afterwards, even by the owner of the database.
    await expect(world.rows("update machvon.audit_event_detail set after_value = '{}'::jsonb where audit_event_id = $1", [sealed2.id])).rejects.toThrow();
    // Run 3: a save keeps the figures before and after, which is more than the cap of 1024 bytes: the row is cut at the cap and says so, and its hash is still the one of the sealed row.
    const meta = drafts.get(second) as { projectId: string; planId: string };
    const saved = await world.as('maker', 'POST', `/reports/${second}/revisions`, { ifMatch: 1, body: { ...draftBody(meta.projectId, period, meta.planId), funding_lines: FX_DIS_001.map((line) => ({ ...line, cumulative_vnd: String(BigInt(line.cumulative_vnd) + 1n) })) } });
    assertStatus(saved, 200);
    const sealed3 = await auditOf(second, 'dis.report_saved');
    const cut = await detailRows(sealed3.id);
    expect(cut).toHaveLength(1);
    expect(cut[0]?.truncated).toBe(true);
    expect(cut[0]?.bytes).toBeLessThanOrEqual(1024);
    expect(sealed3.safe_diff.detail_ref).toMatchObject({ sha256: cut[0]?.detail_sha256, truncated: true });
    // The reader opens the detail of that row; it hashes to the sealed row. Without audit_event.read (or with only the right to manage the policy) the answer is 403, and a row with no detail is 404.
    const opened = await world.as('audit-reader', 'GET', `/audit-events/${sealed2.id}/detail`);
    assertStatus(opened, 200);
    expect(opened.json).toMatchObject({ audit_event_id: sealed2.id, resource_type: 'report_revision', sha256: stored[0]?.detail_sha256, matches_sealed_row: true, truncated: false });
    assertRefusedForPermission(await world.as('nobody', 'GET', `/audit-events/${sealed2.id}/detail`));
    assertRefusedForPermission(await world.as('audit-admin', 'GET', `/audit-events/${sealed2.id}/detail`));
    assertStatus(await world.as('audit-reader', 'GET', `/audit-events/${sealed1.id}/detail`), 404);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'PERIOD_LOCKED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'SNAPSHOT_FROZEN' } }, 409, 'PERIOD_LOCKED'));
    expectCheckFails(() => {
      if (codeOf({ status: 422, json: { code: 'ENTERPRISE_SNAPSHOT_INCOMPLETE' } }) !== 'SNAPSHOT_FROZEN') throw new Error('the code is not the one of the case');
    });
  });
});
