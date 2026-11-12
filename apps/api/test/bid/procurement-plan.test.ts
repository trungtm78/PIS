import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { bidModule } from '../../src/modules/bid';
import { ProcurementPackageReadsController, ProcurementPlanController, ProcurementPlanReadsController } from '../../src/modules/bid/plan.controller';
import { MODULES } from '../../src/modules/registry';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // bid.plan.manage, bid.read, procurement_package.read over the tenant
const APPROVER = 2; // bid.plan.approve, bid.read over the tenant
const SECOND_APPROVER = 3; // the same
const READER = 4; // bid.read, procurement_package.read
const NOBODY = 5;
const DEPARTMENT_PLANNER = 6; // bid.plan.manage, bid.read over the department
const ELSEWHERE_PLANNER = 7; // the same over another branch
const DEPARTMENT_APPROVER = 8; // bid.plan.approve over the department
const SOLO = 9; // bid.plan.manage and bid.plan.approve over the tenant: may do both, never on the same plan
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x94;
const BILLION = 1_000_000_000;
const money = (billions: number): string => String(billions * BILLION);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** A line of a list as the screens read it: the fields the tests look at, whatever else the answer carries. */
interface Item {
  id: string;
  plan?: { id: string } | null;
  project: object;
  last_decision?: unknown;
  [key: string]: unknown;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

describe('procurement plan commands and reads (ST-BID-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A decision of the tenant; `effective` makes it a decision in force. */
  async function document(effective = true, tenant = TENANT_A): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '45/QD-UBND', date '2026-10-01', $3, $4, $4)`,
      [tenant, documentId, effective ? 'EFFECTIVE' : 'PENDING', memberId(PLANNER)],
      tenant,
    );
    return documentId;
  }

  interface Seeded {
    projectId: string;
    line: string;
    secondLine: string;
  }

  /** A project of the unit with two published lines of capital (30 and 10 billion unless told otherwise). */
  async function project(options: { unit?: number; status?: string; lineBillions?: number; tenant?: string } = {}): Promise<Seeded> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const [projectId, capitalPlan, version, line, secondLine] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const decision = await document(true, tenant);
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Bridge project', $4, $5, $6, 'INTERNAL', 1000, $7, 1, 'B')`,
        [tenant, projectId, `PRJ-BP-${counter}`, unitId(options.unit ?? DEPARTMENT), unitId(ROOT), id(FAMILY, 90), options.status ?? 'IMPLEMENTATION'],
      ],
      [
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
         values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, 'PUBLISHED', $5, now(), $6, $6)`,
        [tenant, capitalPlan, `CP-BP-${counter}`, unitId(ROOT), decision, memberId(PLANNER)],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', now(), $5)`,
        [tenant, version, projectId, decision, capitalPlan],
      ],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id)
         values ($1, $2, $4, $5, 'CURRENT_YEAR', 2026, $6::numeric, 0, $7), ($1, $3, $4, $5, 'OTHER', 2025, $8::numeric, 0, $7)`,
        [tenant, line, secondLine, version, id(FAMILY, 91), money(options.lineBillions ?? 30), projectId, money(10)],
      ],
    ]);
    return { projectId, line, secondLine };
  }

  const pack = (line: string, billions: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      code: `GT-${counter}`,
      title: 'Construction package',
      budget_vnd: money(billions),
      method: 'OPEN_BIDDING',
      contract_type: 'LUMP_SUM',
      bidding_form: 'ONLINE',
      allocation_line_id: line,
      planned_start_period: '2026-Q4',
      duration_days: 180,
      ...extra,
    };
  };
  const planBody = (seeded: Seeded, packages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: seeded.projectId,
    title: 'Procurement plan for the bridge',
    legal_basis: 'Luật Đấu thầu 22/2023/QH15',
    packages,
    ...extra,
  });
  const create = (member: number, body: Record<string, unknown>, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/procurement-plans', { member, body, ...options });
  const submit = (member: number, planId: string, version: number | string, tenantId?: string): Promise<Reply> =>
    call('POST', `/procurement-plans/${planId}/submit`, { member, ifMatch: `"${version}"`, body: {}, ...(tenantId === undefined ? {} : { tenantId }) });
  const decide = (member: number, planId: string, version: number | string, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', `/procurement-plans/${planId}/decision`, { member, ifMatch: `"${version}"`, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const approve = async (member: number, planId: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    decide(member, planId, version, { decision: 'APPROVE', decision_document_id: await document(true), ...extra });
  const events = async (planId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [planId])).map((event) => event.type);
  const auditActions = async (planId: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [planId])).map((event) => event.action);
  const statusOf = async (planId: string): Promise<string | undefined> => (await rows<{ status: string }>('select status from machvon.procurement_plan where id = $1', [planId]))[0]?.status;

  /** Drafts the plan of 18 and 10 billion on the first line of a fresh project, and submits it. */
  async function inReview(): Promise<{ seeded: Seeded; planId: string }> {
    const seeded = await project();
    const made = await create(PLANNER, planBody(seeded, [pack(seeded.line, 18), pack(seeded.line, 10)]));
    await submit(PLANNER, idOf(made), 1);
    return { seeded, planId: idOf(made) };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PLANNER, APPROVER, SECOND_APPROVER, READER, NOBODY, DEPARTMENT_PLANNER, ELSEWHERE_PLANNER, DEPARTMENT_APPROVER, SOLO]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLAN_MANAGER', ['bid.plan.manage', 'bid.read', 'procurement_package.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PLAN_APPROVER', ['bid.plan.approve', 'bid.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'PLAN_READER', ['bid.read', 'procurement_package.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'PLAN_SOLO', ['bid.plan.manage', 'bid.plan.approve', 'bid.read'], 60);
    await harness.seedRole(TENANT_B, 1, 'PLAN_MANAGER', ['bid.plan.manage', 'bid.plan.approve', 'bid.read', 'procurement_package.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: SECOND_APPROVER, role: 2, kind: 'TENANT' },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
      { n: 5, member: DEPARTMENT_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 6, member: ELSEWHERE_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 7, member: DEPARTMENT_APPROVER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 8, member: SOLO, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProcurementPlanController, ProcurementPlanReadsController, ProcurementPackageReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered once in the module registry with the controllers of the plan', () => {
    expect(bidModule.code).toBe('BID');
    expect(bidModule.controllers).toEqual(expect.arrayContaining([ProcurementPlanController, ProcurementPlanReadsController, ProcurementPackageReadsController]));
    expect(MODULES.filter((module) => module.code === 'BID')).toHaveLength(1);
  });

  describe('the plan, the budget check and the decision', () => {
    it('UAT-AC445: drafts a plan on a line of 30 billion with packages of 18 and 10, refuses the maker as approver, a decision not in force, and approves on a decision in force with bid.plan.approved.v1; a revision adding 5 billion cannot be submitted and only one plan stays APPROVED (AC-ST-BID-001-1)', async () => {
      const seeded = await project();
      const made = await create(SOLO, planBody(seeded, [pack(seeded.line, 18), pack(seeded.line, 10)]));
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const planId = idOf(made);
      const sent = await submit(SOLO, planId, 1);
      expect(sent.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 2 });

      // The planner who holds the right to approve is still the maker of this plan; one who does not hold it is not an approver at all.
      const own = await approve(SOLO, planId, 2);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const noRight = await approve(PLANNER, planId, 2);
      expect([noRight.status, noRight.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const noDecision = await decide(APPROVER, planId, 2, { decision: 'APPROVE' });
      expect([noDecision.status, noDecision.json.code]).toEqual([422, 'DECISION_DOCUMENT_NOT_EFFECTIVE']);
      const pending = await decide(APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: await document(false) });
      expect([pending.status, pending.json.code]).toEqual([422, 'DECISION_DOCUMENT_NOT_EFFECTIVE']);
      expect(await statusOf(planId)).toBe('IN_REVIEW');

      const decision = await document(true);
      const done = await decide(APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: decision });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'APPROVED', resource_version: 3 });
      expect(await rows('select status, decision_document_id, approved_by from machvon.procurement_plan where id = $1', [planId])).toEqual([{ status: 'APPROVED', decision_document_id: decision, approved_by: memberId(APPROVER) }]);
      expect(await events(planId)).toEqual(['bid.plan.drafted.v1', 'bid.plan.submitted.v1', 'bid.plan.approved.v1']);
      const approvedEvent = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'bid.plan.approved.v1'", [planId]);
      expect(approvedEvent[0]?.payload).toMatchObject({ plan_id: planId, project_id: seeded.projectId, revision: 1, decision_document_id: decision, total_value_vnd: money(28), superseded_plan_id: null, actor_id: memberId(APPROVER) });
      expect((approvedEvent[0]?.payload.package_ids as string[]).length).toBe(2);
      expect(await auditActions(planId)).toEqual(['procurement_plan.drafted', 'procurement_plan.submitted', 'procurement_plan.approved']);

      const revision = await create(PLANNER, planBody(seeded, [pack(seeded.line, 18), pack(seeded.line, 10), pack(seeded.line, 5)]));
      expect(revision.json).toMatchObject({ status: 'DRAFT' });
      const over = await submit(PLANNER, idOf(revision), 1);
      expect([over.status, over.json.code]).toEqual([422, 'PACKAGE_BUDGET_EXCEEDS_ALLOCATION']);
      expect(over.json.lines).toEqual([{ allocation_line_id: seeded.line, allocated_vnd: money(30), packages_vnd: money(33), excess_vnd: money(3) }]);
      expect(await rows('select id from machvon.procurement_plan where project_id = $1 and status = \'APPROVED\'', [seeded.projectId])).toEqual([{ id: planId }]);
      expect(await statusOf(idOf(revision))).toBe('DRAFT');
    });

    it('rejects the submission of a plan for a project in a stage that takes no procurement with a state error and creates no IN_REVIEW row (AC-ST-BID-001-2)', async () => {
      const seeded = await project();
      const made = await create(PLANNER, planBody(seeded, [pack(seeded.line, 5)]));
      await rows("update machvon.project set status = 'SETTLED' where id = $1", [seeded.projectId]);
      const refused = await submit(PLANNER, idOf(made), 1);
      expect([refused.status, refused.json.code]).toEqual([422, 'PROJECT_STAGE_INVALID']);
      expect(await rows("select id from machvon.procurement_plan where project_id = $1 and status = 'IN_REVIEW'", [seeded.projectId])).toEqual([]);
      expect(await statusOf(idOf(made))).toBe('DRAFT');
      const early = await project({ status: 'CONCEPT' });
      const none = await create(PLANNER, planBody(early, [pack(early.line, 5)]));
      expect([none.status, none.json.code]).toEqual([422, 'PROJECT_STAGE_INVALID']);
      expect(await rows('select 1 from machvon.procurement_plan where project_id = $1', [early.projectId])).toEqual([]);
    });

    it('supersedes the plan in force when the revision is approved by someone else than its maker and submitter, and keeps the one APPROVED plan per project', async () => {
      const first = await inReview();
      await approve(APPROVER, first.planId, 2);
      const revision = await create(PLANNER, planBody(first.seeded, [pack(first.seeded.line, 20)]));
      await submit(SECOND_APPROVER, idOf(revision), 1).then((reply) => expect(reply.status).toBe(403));
      await submit(PLANNER, idOf(revision), 1);
      const decided = await approve(SECOND_APPROVER, idOf(revision), 2, { comment: 'Adjusted for the new price' });
      expect(decided.json).toMatchObject({ status: 'APPROVED', resource_version: 3 });
      expect(await statusOf(first.planId)).toBe('SUPERSEDED');
      expect(await rows("select count(*)::int as n from machvon.procurement_plan where project_id = $1 and status = 'APPROVED'", [first.seeded.projectId])).toEqual([{ n: 1 }]);
      expect(await rows("select status from machvon.procurement_package where plan_id = $1", [first.planId])).toEqual([{ status: 'SUPERSEDED' }, { status: 'SUPERSEDED' }]);
      const event = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'bid.plan.approved.v1'", [idOf(revision)]);
      expect(event[0]?.payload).toMatchObject({ superseded_plan_id: first.planId, revision: 2 });
    });

    it('returns a plan to its maker and ends one with a rejection, each with its words; the words are in the audit trail, never in the event', async () => {
      const returned = await inReview();
      const silent = await decide(APPROVER, returned.planId, 2, { decision: 'RETURN' });
      expect([silent.status, silent.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const back = await decide(APPROVER, returned.planId, 2, { decision: 'RETURN', comment: 'Split the supervision package' });
      expect(back.json).toMatchObject({ status: 'DRAFT', resource_version: 3 });
      const audit = await rows<{ action: string; reason: string | null }>('select action, reason from machvon.audit_event where resource_id = $1 order by occurred_at, id', [returned.planId]);
      expect(audit.map((row) => row.action)).toEqual(['procurement_plan.drafted', 'procurement_plan.submitted', 'procurement_plan.returned']);
      expect(audit[2]?.reason).toBe('Split the supervision package');
      expect(await events(returned.planId)).toEqual(['bid.plan.drafted.v1', 'bid.plan.submitted.v1']);
      const resubmitted = await submit(PLANNER, returned.planId, 3);
      expect(resubmitted.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 4 });

      const rejected = await inReview();
      const ended = await decide(APPROVER, rejected.planId, 2, { decision: 'REJECT', comment: 'The capital is needed elsewhere' });
      expect(ended.json).toMatchObject({ status: 'CANCELLED', resource_version: 3 });
      const again = await decide(APPROVER, rejected.planId, 3, { decision: 'REJECT', comment: 'Twice' });
      expect([again.status, again.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
    });

    it('lets only one of two approvers decide at the same moment', async () => {
      const { planId } = await inReview();
      const decision = await document(true);
      const replies = await Promise.all([
        decide(APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: decision }),
        decide(SECOND_APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: decision }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await statusOf(planId)).toBe('APPROVED');
      expect((await events(planId)).filter((type) => type === 'bid.plan.approved.v1')).toHaveLength(1);
    });
  });

  describe('createProcurementPlan', () => {
    it('stores what was kept (trimmed text, exact money, lower-case ids), audits it without the text of the plan and emits the event without personal data', async () => {
      const seeded = await project();
      const body = planBody(seeded, [pack(seeded.line.toUpperCase(), 0, { code: '  GT-STORED  ', title: '  Stored package  ', budget_vnd: '12000000000' }), pack(seeded.secondLine, 0, { budget_vnd: '3000000000', method: 'DIRECT_PURCHASE', bidding_form: 'OFFLINE' })], {
        title: '  Plan with spaces  ',
        project_id: seeded.projectId.toUpperCase(),
      });
      const made = await create(PLANNER, body);
      expect(made.status).toBe(200);
      const planId = idOf(made);
      expect(await rows('select title, total_value_vnd::text as total, project_id, created_by, status, revision from machvon.procurement_plan where id = $1', [planId])).toEqual([
        { title: 'Plan with spaces', total: '15000000000', project_id: seeded.projectId, created_by: memberId(PLANNER), status: 'DRAFT', revision: 1 },
      ]);
      expect(await rows('select code, title, allocation_line_id, budget_vnd::text as budget from machvon.procurement_package where plan_id = $1 order by budget_vnd desc', [planId])).toEqual([
        { code: 'GT-STORED', title: 'Stored package', allocation_line_id: seeded.line, budget: '12000000000' },
        expect.objectContaining({ allocation_line_id: seeded.secondLine, budget: '3000000000' }),
      ]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1', [planId]);
      expect(audit[0]?.safe_diff).toMatchObject({ project_id: seeded.projectId, revision: 1, total_value_vnd: '15000000000', replaced_plan_id: null });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Stored package');
      const event = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1', [planId]);
      expect(event[0]?.payload).toMatchObject({ plan_id: planId, package_count: 2, total_value_vnd: '15000000000', actor_id: memberId(PLANNER) });
      expect(JSON.stringify(event[0]?.payload)).not.toContain('Plan with spaces');
    });

    it('takes only the fields of the contract: a status, an approver, a total or a field of a package that is not one of the nine is refused', async () => {
      const seeded = await project();
      for (const extra of [{ status: 'APPROVED' }, { approved_by: memberId(PLANNER) }, { total_value_vnd: '1' }, { tenant_id: TENANT_B }, { revision: 9 }, { decision_document_id: randomUUID() }]) {
        const reply = await create(PLANNER, planBody(seeded, [pack(seeded.line, 1)], extra));
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      const item = await create(PLANNER, planBody(seeded, [pack(seeded.line, 1, { status: 'AWARDED' })]));
      expect([item.status, item.json.code, item.json.detail]).toEqual([400, 'FIELD_NOT_ALLOWED', 'packages.0.status']);
      const money = await create(PLANNER, planBody(seeded, [pack(seeded.line, 1, { budget_vnd: '1000.5' })]));
      expect([money.status, money.json.code, money.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'packages.0.budget_vnd']);
      expect((await create(PLANNER, planBody(seeded, [pack(seeded.line, 1, { method: 'OPEN' })]))).status).toBe(422);
      expect((await create(PLANNER, planBody(seeded, []))).status).toBe(422);
      expect((await create(PLANNER, { project_id: seeded.projectId })).status).toBe(400);
      expect(await rows('select 1 from machvon.procurement_plan where project_id = $1', [seeded.projectId])).toEqual([]);
    });

    it('refuses a repeated package code (409), a line of another project or none (409) and a plan while another is in review (409)', async () => {
      const seeded = await project();
      const other = await project();
      const dup = await create(PLANNER, planBody(seeded, [pack(seeded.line, 1, { code: 'SAME' }), pack(seeded.line, 1, { code: 'SAME' })]));
      expect([dup.status, dup.json.code]).toEqual([409, 'PACKAGE_CODE_DUPLICATE']);
      const stray = await create(PLANNER, planBody(seeded, [pack(other.line, 1)]));
      expect([stray.status, stray.json.code]).toEqual([409, 'ALLOCATION_LINE_INVALID']);
      const unknown = await create(PLANNER, planBody(seeded, [pack(randomUUID(), 1)]));
      expect([unknown.status, unknown.json.code]).toEqual([409, 'ALLOCATION_LINE_INVALID']);
      const busy = await inReview();
      const blocked = await create(PLANNER, planBody(busy.seeded, [pack(busy.seeded.line, 1)]));
      expect([blocked.status, blocked.json.code, blocked.json.open_plan_id]).toEqual([409, 'PLAN_STATE_INVALID', busy.planId]);
    });

    it('answers a replay with the first answer, refuses the same key with another body and keeps one plan and one event', async () => {
      const seeded = await project();
      const body = planBody(seeded, [pack(seeded.line, 2)]);
      const first = await create(PLANNER, body, { key: 'K-BID-PLAN-0123456789' });
      const second = await create(PLANNER, body, { key: 'K-BID-PLAN-0123456789' });
      expect(second.json).toEqual(first.json);
      const changed = await create(PLANNER, { ...body, title: 'Another title' }, { key: 'K-BID-PLAN-0123456789' });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await rows('select id from machvon.procurement_plan where project_id = $1', [seeded.projectId])).toEqual([{ id: idOf(first) }]);
      expect(await events(idOf(first))).toEqual(['bid.plan.drafted.v1']);
    });

    it('judges the scope of the project: the department planner and the whole tenant plan, another branch, a reader and nobody do not, and another tenant does not see the project', async () => {
      const seeded = await project({ unit: DEPARTMENT });
      expect((await create(DEPARTMENT_PLANNER, planBody(seeded, [pack(seeded.line, 1)]))).status).toBe(200);
      const elsewhere = await create(ELSEWHERE_PLANNER, planBody(seeded, [pack(seeded.line, 1)]));
      expect([elsewhere.status, elsewhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await create(READER, planBody(seeded, [pack(seeded.line, 1)]))).status).toBe(403);
      expect((await create(APPROVER, planBody(seeded, [pack(seeded.line, 1)]))).status).toBe(403);
      expect((await create(NOBODY, planBody(seeded, [pack(seeded.line, 1)]))).status).toBe(403);
      const foreign = await create(B_PLANNER, planBody(seeded, [pack(seeded.line, 1)]), { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await create(PLANNER, planBody({ ...seeded, projectId: randomUUID() }, [pack(seeded.line, 1)]))).status).toBe(404);
    });
  });

  describe('submitProcurementPlan and decideProcurementPlan', () => {
    it('needs If-Match, a current version and a plan in the scope; a plan outside it does not exist for the caller', async () => {
      const seeded = await project({ unit: DEPARTMENT });
      const made = await create(PLANNER, planBody(seeded, [pack(seeded.line, 2)]));
      expect((await call('POST', `/procurement-plans/${idOf(made)}/submit`, { member: PLANNER, body: {} })).status).toBeGreaterThanOrEqual(400);
      expect(await submit(PLANNER, idOf(made), 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await submit(ELSEWHERE_PLANNER, idOf(made), 1)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await submit(B_PLANNER, idOf(made), 1, TENANT_B).then((reply) => reply.status)).toBe(404);
      expect((await submit(READER, idOf(made), 1)).status).toBe(403);
      expect(await submit(PLANNER, randomUUID(), 1)).toMatchObject({ status: 404 });
      expect((await submit(DEPARTMENT_PLANNER, idOf(made), 1)).json).toMatchObject({ status: 'IN_REVIEW' });
      expect(await submit(PLANNER, idOf(made), 2)).toMatchObject({ status: 409, json: { code: 'PLAN_STATE_INVALID' } });
    });

    it('lets the department approver decide the plans of the department only, and a planner or a reader decide nothing', async () => {
      const inside = await project({ unit: DEPARTMENT });
      const made = await create(PLANNER, planBody(inside, [pack(inside.line, 2)]));
      await submit(PLANNER, idOf(made), 1);
      expect((await decide(PLANNER, idOf(made), 2, { decision: 'RETURN', comment: 'x' })).status).toBe(403);
      expect((await decide(READER, idOf(made), 2, { decision: 'RETURN', comment: 'x' })).status).toBe(403);
      expect((await decide(B_PLANNER, idOf(made), 2, { decision: 'RETURN', comment: 'x' }, TENANT_B)).status).toBe(404);
      const away = await project({ unit: ELSEWHERE });
      const awayPlan = await create(PLANNER, planBody(away, [pack(away.line, 2)]));
      await submit(PLANNER, idOf(awayPlan), 1);
      const denied = await decide(DEPARTMENT_APPROVER, idOf(awayPlan), 2, { decision: 'RETURN', comment: 'x' });
      expect([denied.status, denied.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await approve(DEPARTMENT_APPROVER, idOf(made), 2)).json).toMatchObject({ status: 'APPROVED' });
    });

    it('takes only the fields of the decision and a decision document of the tenant', async () => {
      const { planId } = await inReview();
      for (const extra of [{ status: 'APPROVED' }, { approved_by: memberId(APPROVER) }, { tenant_id: TENANT_B }]) {
        const reply = await decide(APPROVER, planId, 2, { decision: 'RETURN', comment: 'x', ...extra });
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect((await decide(APPROVER, planId, 2, { decision: 'MAYBE' })).status).toBe(422);
      expect(await decide(APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(APPROVER, planId, 2, { decision: 'APPROVE', decision_document_id: await document(true, TENANT_B) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await statusOf(planId)).toBe('IN_REVIEW');
    });
  });

  describe('the reads', () => {
    const list = (member: number, query = '', tenantId?: string): Promise<Reply> => call('GET', `/procurement-plans${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
    const packages = (member: number, query = '', tenantId?: string): Promise<Reply> => call('GET', `/resources/procurement_package${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
    const itemsOf = (reply: Reply): Item[] => reply.json.items as Item[];

    it('lists the plans with an explicit allowlist of fields: no person behind the plan, no internal column', async () => {
      const { seeded, planId } = await inReview();
      const reply = await list(PLANNER, `?project_id=${seeded.projectId}`);
      expect(reply.status).toBe(200);
      const item = itemsOf(reply).find((line) => line.id === planId) as Item;
      expect(Object.keys(item).sort()).toEqual(
        ['approved_at', 'decision_document', 'id', 'last_decision', 'legal_basis', 'package_count', 'project', 'revision', 'status', 'supersedes_id', 'title', 'total_value_vnd', 'version'].sort(),
      );
      expect(item).toMatchObject({ status: 'IN_REVIEW', revision: 1, package_count: 2, total_value_vnd: money(28), version: 2, decision_document: null, last_decision: null });
      expect(Object.keys(item.project).sort()).toEqual(['code', 'id', 'name', 'status']);
      expect(reply.json.as_of).toEqual(expect.any(String));
    });

    it('shows a plan in work to the people who plan and approve, the words of a decision with it, and to a reader only once it is in force', async () => {
      const { seeded, planId } = await inReview();
      await decide(APPROVER, planId, 2, { decision: 'RETURN', comment: 'Split the supervision package' });
      const query = `?project_id=${seeded.projectId}`;
      expect(itemsOf(await list(PLANNER, query)).find((line) => line.id === planId)).toMatchObject({ status: 'DRAFT', last_decision: { decision: 'RETURNED', comment: 'Split the supervision package' } });
      expect(itemsOf(await list(APPROVER, query)).map((line) => line.id)).toContain(planId);
      expect(itemsOf(await list(READER, query))).toEqual([]);
      await submit(PLANNER, planId, 3);
      await approve(APPROVER, planId, 4, { comment: 'Approved with the internal remark' });
      const forReader = itemsOf(await list(READER, query));
      expect(forReader.map((line) => line.id)).toEqual([planId]);
      expect(forReader[0]).toMatchObject({ status: 'APPROVED', last_decision: { decision: 'APPROVED', comment: null }, decision_document: { symbol: '45/QD-UBND', issued_on: '2026-10-01' } });
      expect(itemsOf(await list(PLANNER, query))[0]?.last_decision).toMatchObject({ comment: 'Approved with the internal remark' });
    });

    it('filters by status, pages with a cursor, refuses a malformed filter or cursor, and stays inside the scope and the tenant', async () => {
      const seeded = await project({ unit: DEPARTMENT });
      const first = await create(PLANNER, planBody(seeded, [pack(seeded.line, 1)]));
      await submit(PLANNER, idOf(first), 1);
      await approve(APPROVER, idOf(first), 2);
      const second = await create(PLANNER, planBody(seeded, [pack(seeded.line, 2)]));
      const query = `project_id=${seeded.projectId}`;
      expect(itemsOf(await list(PLANNER, `?${query}&status=DRAFT`)).map((line) => line.id)).toEqual([idOf(second)]);
      const page1 = await list(PLANNER, `?${query}&limit=1`);
      expect(itemsOf(page1).map((line) => line.id)).toEqual([idOf(second)]);
      expect(page1.json.next_cursor).toEqual(expect.any(String));
      const page2 = await list(PLANNER, `?${query}&limit=1&cursor=${page1.json.next_cursor as string}`);
      expect(itemsOf(page2).map((line) => line.id)).toEqual([idOf(first)]);
      expect(page2.json.next_cursor).toBeNull();
      expect((await list(PLANNER, '?status=DONE')).status).toBe(422);
      expect((await list(PLANNER, '?project_id=nope')).status).toBe(422);
      expect((await list(PLANNER, '?cursor=bad')).status).toBe(422);
      expect(itemsOf(await list(ELSEWHERE_PLANNER, `?${query}`))).toEqual([]);
      expect(itemsOf(await list(DEPARTMENT_PLANNER, `?${query}`))).toHaveLength(2);
      expect(itemsOf(await list(B_PLANNER, `?${query}`, TENANT_B))).toEqual([]);
      expect((await list(NOBODY)).status).toBe(403);
    });

    it('lists the packages with the plan, the project and the fund source, reads one by id and does not know another tenant\'s', async () => {
      const { seeded, planId } = await inReview();
      const reply = await packages(PLANNER);
      expect(reply.status).toBe(200);
      const mine = itemsOf(reply).filter((line) => line.plan?.id === planId);
      expect(mine).toHaveLength(2);
      expect(Object.keys(mine[0] as object).sort()).toEqual(
        ['allocation_line_id', 'approved_decision_id', 'bidding_form', 'budget_vnd', 'code', 'contract_type', 'duration_days', 'fund_source', 'id', 'method', 'plan', 'planned_start_period', 'project', 'status', 'title', 'version'].sort(),
      );
      expect(mine[0]).toMatchObject({ status: 'IN_REVIEW', plan: { id: planId, revision: 1, status: 'IN_REVIEW' }, project: { id: seeded.projectId }, allocation_line_id: seeded.line, duration_days: 180, planned_start_period: '2026-Q4' });
      const one = await call('GET', `/resources/procurement_package/${(mine[0] as { id: string }).id}`, { member: PLANNER });
      expect(one.json).toMatchObject({ id: (mine[0] as { id: string }).id, budget_vnd: expect.any(String) });
      expect((await call('GET', `/resources/procurement_package/${(mine[0] as { id: string }).id}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/resources/procurement_package/${(mine[0] as { id: string }).id}`, { member: B_PLANNER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/procurement_package/${randomUUID()}`, { member: PLANNER })).status).toBe(404);
      expect((await call('GET', '/resources/procurement_package/not-an-id', { member: PLANNER })).status).toBeGreaterThanOrEqual(400);
      expect((await packages(READER)).status).toBe(200);
      expect(itemsOf(await packages(READER)).some((line) => line.plan?.id === planId)).toBe(false);
      const page = await packages(PLANNER, '?limit=1');
      expect(itemsOf(page)).toHaveLength(1);
      expect(page.json.next_cursor).toEqual(expect.any(String));
      expect((await packages(PLANNER, '?limit=0')).status).toBe(422);
      expect((await packages(NOBODY)).status).toBe(403);
    });
  });
});
