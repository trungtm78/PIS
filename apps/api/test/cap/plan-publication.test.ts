import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, OutboxRelay, PrjProjectStore, TenantDatabase } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { assertOneWinner, loadErrorRegistry, runLoops, signTenantContext, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { Pool } from 'pg';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { AllocationLineReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController } from '../../src/modules/cap/plan.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { PlanPublishedConsumer } from '../../src/modules/prj/plan-published.consumer';
import { ProjectStageController } from '../../src/modules/prj/stage.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const A_PLANNER = 1; // holds every step of the approval: the four-eyes rule must still hold for them
const PLANNER = 2; // capital.plan.draft and capital.plan.submit on the whole tenant
const APPROVER = 3; // capital.plan.approve on the whole tenant
const PUBLISHER = 4; // plan.publish on the whole tenant
const BQL1_STEPS = 5; // every step, on the subtree of BQL1 only
const READER = 6; // capital.read: no step
const STAGE_MANAGER = 7; // project.stage.cancel and project.read
const NOBODY = 8;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const WORKER = '00000000-0000-4000-8000-000000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('approval and publication of the capital plan over HTTP (ST-CAP-003)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let relayPool: Pool;
  let counter = 0;
  let yearCounter = 2100;
  const versions: Record<string, string> = {};
  const gauges: Array<{ name: string; value: number }> = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const statusOf = async (planId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.status as string;

  async function document(tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [tenant, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function appropriation(year: number, amount: string): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.appropriation
           (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
        [TENANT_A, id, versions.nstw, year, amount, await document(), memberId(APPROVER), memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function project(status = 'PIPELINE', unit = BQL1): Promise<string> {
    counter += 1;
    const number = counter;
    const code = `PA-${number}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(5000000 + number)]);
    return created.id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  interface Plan {
    id: string;
    year: number;
    appropriationId: string;
    projects: string[];
    version: number;
  }

  const createPlan = (year: number, member = PLANNER, overrides: Record<string, unknown> = {}): Promise<Reply> => {
    counter += 1;
    return call('POST', '/capital-plans', {
      member,
      body: { plan_code: `PA-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT), ...overrides },
    });
  };
  const submit = (planId: string, version: number, member = PLANNER, options: { key?: string; tenantId?: string; ifMatch?: string } = {}): Promise<Reply> =>
    call('POST', `/capital-plans/${planId}/submit`, { member, ifMatch: options.ifMatch ?? `"${version}"`, body: {}, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });
  const decide = (planId: string, version: number, decision: string, member = APPROVER, reason = 'Reviewed against the decision', tenantId?: string): Promise<Reply> =>
    call('POST', `/capital-plans/${planId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason }, ...(tenantId === undefined ? {} : { tenantId }) });
  const publish = (planId: string, version: number, body: Record<string, unknown>, member = PUBLISHER, options: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/plans/${planId}/publish`, { member, ifMatch: `"${version}"`, body, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });

  /** A plan of the given lines (one project each), drafted by the command in DRAFT. */
  async function draftedPlan(amounts: string[], options: { member?: number; appropriationAmount?: string } = {}): Promise<Plan> {
    const year = freshYear();
    const source = await appropriation(year, options.appropriationAmount ?? money(10));
    const members: string[] = [];
    for (let index = 0; index < amounts.length; index += 1) members.push(await project());
    const created = await createPlan(year, options.member ?? PLANNER);
    expect(created.status).toBe(200);
    const drafted = await call('POST', `/capital-plans/${idOf(created)}/allocations`, {
      member: options.member ?? PLANNER,
      ifMatch: `"${versionOf(created)}"`,
      body: { lines: members.map((member, index) => ({ project_id: member, appropriation_id: source, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: amounts[index] })) },
    });
    expect(drafted.status).toBe(200);
    return { id: idOf(created), year, appropriationId: source, projects: members, version: versionOf(drafted) };
  }

  /** A plan submitted by the planner and approved by the approver. */
  async function approvedPlan(amounts: string[], options: { appropriationAmount?: string } = {}): Promise<Plan> {
    const plan = await draftedPlan(amounts, options);
    const submitted = await submit(plan.id, plan.version);
    expect(submitted.status).toBe(200);
    const decided = await decide(plan.id, versionOf(submitted), 'approve');
    expect(decided.status).toBe(200);
    return { ...plan, version: versionOf(decided) };
  }

  async function publishedPlan(amounts: string[], options: { appropriationAmount?: string } = {}): Promise<Plan> {
    const plan = await approvedPlan(amounts, options);
    const published = await publish(plan.id, plan.version, { decision_document_id: await document() });
    expect(published.status).toBe(200);
    return { ...plan, version: versionOf(published) };
  }

  const lineOf = async (planId: string, projectId: string): Promise<string> =>
    (
      await rows<{ id: string }>(
        'select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid and al.project_id = $2::uuid',
        [planId, projectId],
      )
    )[0]?.id as string;

  /** The money the payment story will have posted on the line of a published plan: committed and disbursed. */
  const spend = (lineId: string, committed: string, disbursed: string) =>
    rows('update machvon.allocation_balance set committed_vnd = $2::numeric, disbursed_vnd = $3::numeric where allocation_line_id = $1::uuid', [lineId, committed, disbursed]);

  /** A DRAFT revision of a published plan, the way the revision command of ST-CAP-004 leaves it (copied lines, the allocated total counts the difference). */
  async function revise(base: Plan, amounts: string[], author = A_PLANNER): Promise<Plan> {
    const header = (await rows<{ plan_code: string; revision: number }>('select plan_code, (select max(revision) from machvon.capital_plan o where o.plan_code = c.plan_code) as revision from machvon.capital_plan c where id = $1::uuid', [base.id]))[0] as {
      plan_code: string;
      revision: number;
    };
    const planId = randomUUID();
    const statements: Array<[string, unknown[]?]> = [
      [
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, created_by, updated_by, version)
         values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, $6, 'DRAFT', $7, $8, $8, 1)`,
        [TENANT_A, planId, header.plan_code, base.year, unitId(ROOT), header.revision + 1, base.id, memberId(author)],
      ],
    ];
    let delta = 0n;
    for (const [index, member] of base.projects.entries()) {
      const baseLine = await lineOf(base.id, member);
      const amount = amounts[index] as string;
      const baseAmount = (await rows<{ amount: string }>('select amount_vnd::text as amount from machvon.allocation_line where id = $1::uuid', [baseLine]))[0]?.amount as string;
      delta += BigInt(amount) - BigInt(baseAmount);
      const versionId = randomUUID();
      statements.push([
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $7, 1)`,
        [TENANT_A, versionId, member, base.year, header.revision + 1, planId, memberId(author)],
      ]);
      statements.push([
        `insert into machvon.allocation_line
           (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, previous_line_id, created_by, updated_by)
         select tenant_id, $2::uuid, $3::uuid, fund_source_version_id, bucket, source_year, $4::numeric, 0, appropriation_id, project_id, budget_level, origin, id, created_by, updated_by
           from machvon.allocation_line where id = $1::uuid`,
        [baseLine, randomUUID(), versionId, amount],
      ]);
    }
    statements.push(["select set_config('app.cap_allocation_write', 'on', false)"], ['update machvon.appropriation set allocated_total_vnd = allocated_total_vnd + $2::numeric where id = $1::uuid', [base.appropriationId, delta.toString()]]);
    await harness.owner(TENANT_A, statements);
    return { ...base, id: planId, version: 1 };
  }

  const events = (planId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at', [planId, type]);
  const auditOf = (planId: string, action: string) =>
    rows<{ diff: Record<string, unknown>; reason: string | null; actor_id: string }>('select safe_diff as diff, reason, actor_id from machvon.audit_event where resource_id = $1::uuid and action = $2 order by occurred_at', [planId, action]);
  const ledgerOf = (planId: string) =>
    rows<{ entry_type: string; amount: string; allocation_line_id: string }>(
      "select entry_type, amount_vnd::text as amount, allocation_line_id from machvon.capital_ledger_entry where source_ref_kind = 'CAPITAL_PLAN' and source_ref_id = $1::uuid order by entry_type, allocation_line_id",
      [planId],
    );
  const balanceOf = async (lineId: string) =>
    (await rows<{ allocated: string; committed: string; disbursed: string }>('select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid', [lineId]))[0];
  const allocatedOf = async (appropriationId: string): Promise<string> => (await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1::uuid', [appropriationId]))[0]?.allocated as string;

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      ]);
    }
    for (const n of [A_PLANNER, PLANNER, APPROVER, PUBLISHER, BQL1_STEPS, READER, STAGE_MANAGER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ALL_STEPS', ['capital.plan.draft', 'capital.plan.submit', 'capital.plan.approve', 'plan.publish', ...READS], 60);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...READS], 50);
    await harness.seedRole(TENANT_A, 5, 'READER', READS, 20);
    await harness.seedRole(TENANT_A, 6, 'STAGE', ['project.stage.cancel', 'project.read'], 50);
    await harness.seedRole(TENANT_B, 1, 'ALL_STEPS', ['capital.plan.draft', 'capital.plan.submit', 'capital.plan.approve', 'plan.publish', ...READS], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: A_PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: BQL1_STEPS, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 6, member: READER, role: 5, kind: 'TENANT' },
      { n: 7, member: STAGE_MANAGER, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = {
      increment: () => undefined,
      gauge: (name, value) => void gauges.push({ name, value }),
    };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, PlanVersionReadsController, AllocationLineReadsController, ProjectStageController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: metrics },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(CapitalPlanApprovalController);
  });

  describe('submitCapitalPlan', () => {
    it('submits a DRAFT plan with lines: IN_REVIEW at the next version, one audit row with the totals and capital.plan_submitted.v1 once, also when the key is replayed', async () => {
      const plan = await draftedPlan([money(2), money(1)]);
      const key = `submit-${randomUUID()}`;
      const submitted = await submit(plan.id, plan.version, PLANNER, { key });
      expect(submitted.status).toBe(200);
      expect(submitted.json).toMatchObject({ status: 'IN_REVIEW', resource_version: plan.version + 1, resource_id: plan.id });
      const replay = await submit(plan.id, plan.version, PLANNER, { key });
      expect([replay.status, replay.json.operation_id]).toEqual([200, submitted.json.operation_id]);
      const [event, ...more] = await events(plan.id, 'capital.plan_submitted.v1');
      expect(more).toEqual([]);
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, capital_plan_id: plan.id, version: plan.version + 1, actor_id: memberId(PLANNER), line_count: 2, project_count: 2, total_vnd: money(3) });
      const audit = await auditOf(plan.id, 'capital.plan_submitted');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(PLANNER), diff: { line_count: 2, total_vnd: money(3), plan_version_before: plan.version, plan_version_after: plan.version + 1 } });
      expect(await statusOf(plan.id)).toBe('IN_REVIEW');
    });

    it('refuses a plan without lines (422), a stale or missing If-Match (409, 428), a plan that is not a DRAFT (409 PLAN_NOT_DRAFT), and a plan of another tenant (404)', async () => {
      const year = freshYear();
      const empty = await createPlan(year);
      expect((await submit(idOf(empty), versionOf(empty))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'lines' });
      const plan = await draftedPlan([money(1)]);
      const stale = await submit(plan.id, plan.version - 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const bare = await call('POST', `/capital-plans/${plan.id}/submit`, { member: PLANNER, body: {} });
      expect(bare.status).toBe(428);
      const foreign = await submit(plan.id, plan.version, B_PLANNER, { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await submit(plan.id, plan.version)).status).toBe(200);
      const again = await submit(plan.id, plan.version + 1);
      expect([again.status, again.json.code]).toEqual([409, 'PLAN_NOT_DRAFT']);
      expect(await statusOf(plan.id)).toBe('IN_REVIEW');
    });

    it('needs capital.plan.submit on a grant that reaches the unit of the plan: a reader and a planner of a sub-unit are refused (403)', async () => {
      const plan = await draftedPlan([money(1)]);
      expect((await submit(plan.id, plan.version, READER)).status).toBe(403);
      expect((await submit(plan.id, plan.version, NOBODY)).status).toBe(403);
      const narrow = await submit(plan.id, plan.version, BQL1_STEPS);
      expect([narrow.status, narrow.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await statusOf(plan.id)).toBe('DRAFT');
    });
  });

  describe('decideCapitalPlan and the four-eyes rule', () => {
    it('refuses the person who drafted the plan, whatever else they may do (403 SELF_APPROVAL_DENIED), then lets an approver approve it (AC-ST-CAP-003-1, UAT-AC223)', async () => {
      const plan = await draftedPlan([money(2)], { member: A_PLANNER });
      const own = await decide(plan.id, plan.version, 'approve', A_PLANNER);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const submitted = await submit(plan.id, plan.version, A_PLANNER);
      for (const decision of ['approve', 'reject', 'return']) {
        const refused = await decide(plan.id, versionOf(submitted), decision, A_PLANNER);
        expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      }
      // The person who submitted a plan drafted by someone else is refused too.
      const other = await draftedPlan([money(1)]);
      const submittedByOther = await submit(other.id, other.version, A_PLANNER);
      expect((await decide(other.id, versionOf(submittedByOther), 'approve', A_PLANNER)).json.code).toBe('SELF_APPROVAL_DENIED');
      const approved = await decide(plan.id, versionOf(submitted), 'approve', APPROVER, 'The lines follow the decision');
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: versionOf(submitted) + 1 });
      const [audit] = await auditOf(plan.id, 'capital.plan_decided');
      expect(audit).toMatchObject({ reason: 'The lines follow the decision', actor_id: memberId(APPROVER), diff: { decision: 'approve', status: 'APPROVED' } });
      const [event] = await events(plan.id, 'capital.plan_decided.v1');
      expect(event?.payload).toMatchObject({ decision: 'approve', status: 'APPROVED', actor_id: memberId(APPROVER) });
      expect(JSON.stringify(event?.payload)).not.toContain('The lines follow');
    });

    it('returns a plan to its planner with the reason and rejects a plan for good, giving its ceiling back; a reason of fewer than 5 characters and a decision on a plan not in review are refused', async () => {
      const plan = await draftedPlan([money(3)]);
      const submitted = await submit(plan.id, plan.version);
      expect((await decide(plan.id, versionOf(submitted), 'approve', APPROVER, 'no')).status).toBe(422);
      const returned = await decide(plan.id, versionOf(submitted), 'return', APPROVER, 'Lower the line to two billion');
      expect(returned.json).toMatchObject({ status: 'DRAFT' });
      const header = await call('GET', `/resources/plan_version/${plan.id}`, { member: APPROVER });
      expect(header.json).toMatchObject({ status: 'DRAFT' });
      const idle = await decide(plan.id, versionOf(returned), 'approve');
      expect([idle.status, idle.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const resubmitted = await submit(plan.id, versionOf(returned));
      expect(resubmitted.status).toBe(200);
      expect(await allocatedOf(plan.appropriationId)).toBe(money(3));
      const rejected = await decide(plan.id, versionOf(resubmitted), 'reject', APPROVER, 'Outside the medium-term plan');
      expect(rejected.json).toMatchObject({ status: 'REJECTED' });
      expect(await allocatedOf(plan.appropriationId)).toBe('0');
      const [audit] = await auditOf(plan.id, 'capital.plan_decided');
      expect(audit).toBeDefined();
      const decided = await auditOf(plan.id, 'capital.plan_decided');
      expect(decided.map((row) => (row.diff as { decision: string }).decision)).toEqual(['return', 'reject']);
      expect((decided[1]?.diff as { released_ceilings: unknown[] }).released_ceilings).toEqual([{ appropriation_id: plan.appropriationId, allocated_before_vnd: money(3), allocated_after_vnd: '0' }]);
    });

    it('needs capital.plan.approve on a grant that reaches the plan unit (403 SCOPE_DENIED for a sub-unit), and does not know a plan of another tenant', async () => {
      const plan = await draftedPlan([money(1)]);
      const submitted = await submit(plan.id, plan.version);
      expect((await decide(plan.id, versionOf(submitted), 'approve', PLANNER)).status).toBe(403);
      const narrow = await decide(plan.id, versionOf(submitted), 'approve', BQL1_STEPS);
      expect([narrow.status, narrow.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const foreign = await decide(plan.id, versionOf(submitted), 'approve', B_PLANNER, 'Reviewed against the decision', TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await statusOf(plan.id)).toBe('IN_REVIEW');
    });
  });

  describe('post_plans_id_publish', () => {
    it('publishes a revision with the decision document and supersedes the previous one: 403 SELF_APPROVAL_DENIED, 422 DECISION_REQUIRED, then PUBLISHED (AC-ST-CAP-003-1, UAT-AC223)', async () => {
      const first = await publishedPlan([money(4)]);
      const second = await revise(first, [money(5)]);
      const submitted = await submit(second.id, 1, A_PLANNER);
      expect(submitted.status).toBe(200);
      const own = await decide(second.id, versionOf(submitted), 'approve', A_PLANNER);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const approved = await decide(second.id, versionOf(submitted), 'approve', APPROVER);
      expect(approved.status).toBe(200);
      const version = versionOf(approved);
      const own2 = await publish(second.id, version, { decision_document_id: await document() }, A_PLANNER);
      expect([own2.status, own2.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const bare = await publish(second.id, version, {});
      expect([bare.status, bare.json.code, bare.json.detail]).toEqual([422, 'DECISION_REQUIRED', 'decision_document_id']);
      const unknown = await publish(second.id, version, { decision_document_id: randomUUID() });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const foreign = await publish(second.id, version, { decision_document_id: await document(TENANT_B) });
      expect(foreign.json.code).toBe('DECISION_REQUIRED');
      expect(await statusOf(second.id)).toBe('APPROVED');
      const documentId = await document();
      const published = await publish(second.id, version, { decision_document_id: documentId, effective_at: '2099-01-01T00:00:00Z' });
      expect(published.status).toBe(200);
      expect(published.json).toMatchObject({ status: 'PUBLISHED', resource_version: version + 1, resource_id: second.id });
      expect(await statusOf(second.id)).toBe('PUBLISHED');
      expect(await statusOf(first.id)).toBe('SUPERSEDED');
      const header = await call('GET', `/resources/plan_version/${second.id}`, { member: READER });
      expect(header.json).toMatchObject({ status: 'PUBLISHED', supersedes_id: first.id, effective_at: '2099-01-01T00:00:00.000Z', decision_document: { id: documentId } });
      const [audit] = await auditOf(second.id, 'capital.plan_published');
      expect(audit).toMatchObject({
        actor_id: memberId(PUBLISHER),
        diff: { superseded_plan_id: first.id, decision_document_id: documentId, total_before_vnd: money(4), total_after_vnd: money(5), allocate_vnd: money(1), reduce_vnd: '0', ledger_entry_count: 1 },
      });
    });

    it('refuses the revision below what is committed and disbursed, lists the line, and accepts it at the floor (AC-ST-CAP-003-2, UAT-AC225, FX-CAP-003)', async () => {
      const base = await publishedPlan([money(10)]);
      const baseProject = base.projects[0] as string;
      await spend(await lineOf(base.id, baseProject), money(6), money(3));
      const low = await revise(base, [String(8.5 * BILLION)]);
      const lowSubmitted = await submit(low.id, 1, A_PLANNER);
      const lowApproved = await decide(low.id, versionOf(lowSubmitted), 'approve');
      const refused = await publish(low.id, versionOf(lowApproved), { decision_document_id: await document() });
      expect([refused.status, refused.json.code]).toEqual([422, 'REVISED_BELOW_COMMITTED']);
      const listed = refused.json.lines as Array<Record<string, string>>;
      expect(listed).toEqual([
        { line_id: await lineOf(low.id, baseProject), project_id: baseProject, allocated_vnd: String(8.5 * BILLION), committed_vnd: money(6), disbursed_vnd: money(3), minimum_vnd: money(9) },
      ]);
      expect(await statusOf(base.id)).toBe('PUBLISHED');
      expect(await balanceOf(await lineOf(base.id, baseProject))).toEqual({ allocated: money(10), committed: money(6), disbursed: money(3) });
      const ok = await revise(base, [money(9)]);
      const okSubmitted = await submit(ok.id, 1, A_PLANNER);
      const okApproved = await decide(ok.id, versionOf(okSubmitted), 'approve');
      const accepted = await publish(ok.id, versionOf(okApproved), { decision_document_id: await document() });
      expect(accepted.status).toBe(200);
      expect(await balanceOf(await lineOf(ok.id, baseProject))).toEqual({ allocated: money(9), committed: money(6), disbursed: money(3) });
      expect(await ledgerOf(ok.id)).toEqual([{ entry_type: 'REDUCE', amount: money(1), allocation_line_id: await lineOf(ok.id, baseProject) }]);
    });

    it('cannot update or delete a ledger entry with the application role; a correction is a REVERSAL entry (AC-ST-CAP-003-3, UAT-AC234)', async () => {
      const plan = await publishedPlan([money(1)]);
      const [entry] = await ledgerOf(plan.id);
      expect(entry).toMatchObject({ entry_type: 'ALLOCATE', amount: money(1) });
      const id = (await rows<{ id: string }>("select id from machvon.capital_ledger_entry where source_ref_id = $1::uuid and entry_type = 'ALLOCATE'", [plan.id]))[0]?.id;
      const attempt = async (sql: string): Promise<string> => {
        try {
          await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) => tx.query(sql, [id]));
        } catch (error) {
          return (error as { code?: string }).code ?? 'other';
        }
        return 'allowed';
      };
      expect(await attempt('update machvon.capital_ledger_entry set amount_vnd = 1 where id = $1::uuid')).toBe('42501');
      expect(await attempt('delete from machvon.capital_ledger_entry where id = $1::uuid')).toBe('42501');
      expect(await ledgerOf(plan.id)).toEqual([entry]);
    });

    it('writes capital.plan_published.v1 once, and the project register moves the funded project of the pipeline to BUDGETED in the name of the system (AC-ST-CAP-003-4, UAT-AC219)', async () => {
      const plan = await approvedPlan([money(1)]);
      const funded = plan.projects[0] as string;
      const key = `publish-${randomUUID()}`;
      const documentId = await document();
      const published = await publish(plan.id, plan.version, { decision_document_id: documentId }, PUBLISHER, { key });
      expect(published.status).toBe(200);
      const replay = await publish(plan.id, plan.version, { decision_document_id: documentId }, PUBLISHER, { key });
      expect([replay.status, replay.json.operation_id]).toEqual([200, published.json.operation_id]);
      const late = await publish(plan.id, plan.version, { decision_document_id: documentId });
      expect(late.status).toBe(409);
      const written = await events(plan.id, 'capital.plan_published.v1');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ event_key: `capital_plan:${plan.id}:published`, payload: { capital_plan_id: plan.id, decision_document_id: documentId, project_ids: [funded], actor_id: memberId(PUBLISHER), version: versionOf(published) } });
      const outcomes: Array<[string, string]> = [];
      const consumer = new PlanPublishedConsumer({ database: harness.tenants, security: { signingKey: RELAY_KEY }, cache });
      const deliver = async () => new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push([delivery.aggregateId, await consumer.handle(delivery)]), { signingKey: RELAY_KEY }).runOnce();
      await deliver();
      const ours = (): string[] => outcomes.filter(([aggregate, outcome]) => aggregate === plan.id && outcome !== 'ignored').map(([, outcome]) => outcome);
      expect(ours()).toEqual(['processed']);
      const state = (await rows<{ status: string; updated_by: string }>('select status, updated_by from machvon.project where id = $1::uuid', [funded]))[0];
      expect(state).toEqual({ status: 'BUDGETED', updated_by: WORKER });
      await deliver();
      expect(ours()).toEqual(['processed']);
      expect(await events(plan.id, 'capital.plan_published.v1')).toHaveLength(1);
    });

    it('answers 409 OPEN_OBLIGATIONS_EXIST to the cancellation of a project whose balance, written by the publication, holds committed capital (AC-ST-CAP-003-5, UAT-AC215)', async () => {
      const plan = await publishedPlan([money(2)]);
      const funded = plan.projects[0] as string;
      await rows("update machvon.project set status = 'BUDGETED' where id = $1::uuid", [funded]);
      await spend(await lineOf(plan.id, funded), String(500_000_000), '0');
      const row = (await rows<{ version: string }>('select version::text as version from machvon.project where id = $1::uuid', [funded]))[0];
      const refused = await call('POST', `/projects/${funded}/cancellation`, { member: STAGE_MANAGER, ifMatch: `"${row?.version}"`, body: { decision_document_id: await document(), reason: 'The project is withdrawn' } });
      expect([refused.status, refused.json.code]).toEqual([409, 'OPEN_OBLIGATIONS_EXIST']);
      await spend(await lineOf(plan.id, funded), '0', '0');
      const cancelled = await call('POST', `/projects/${funded}/cancellation`, { member: STAGE_MANAGER, ifMatch: `"${row?.version}"`, body: { decision_document_id: await document(), reason: 'The project is withdrawn' } });
      expect(cancelled.status).toBe(200);
    });

    it('needs plan.publish on a grant that reaches the plan unit and a plan in APPROVED (409 PLAN_NOT_APPROVED); a plan of another tenant does not exist', async () => {
      const plan = await approvedPlan([money(1)]);
      const body = { decision_document_id: await document() };
      expect((await publish(plan.id, plan.version, body, APPROVER)).status).toBe(403);
      const narrow = await publish(plan.id, plan.version, body, BQL1_STEPS);
      expect([narrow.status, narrow.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const foreign = await publish(plan.id, plan.version, { decision_document_id: await document(TENANT_B) }, B_PLANNER, { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const stale = await publish(plan.id, plan.version - 1, body);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const draft = await draftedPlan([money(1)]);
      const notApproved = await publish(draft.id, draft.version, body);
      expect([notApproved.status, notApproved.json.code]).toEqual([409, 'PLAN_NOT_APPROVED']);
      const extra = await publish(plan.id, plan.version, { ...body, status: 'PUBLISHED' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect(await statusOf(plan.id)).toBe('APPROVED');
    });

    it('reports the balance drift of the publication as 0 and its latency, and shows the published lines with their balances to the readers', async () => {
      const before = gauges.length;
      const plan = await approvedPlan([money(2), money(1)]);
      expect((await publish(plan.id, plan.version, { decision_document_id: await document() })).status).toBe(200);
      const recorded = gauges.slice(before);
      expect(recorded.filter((gauge) => gauge.name === 'cap_balance_drift_vnd').map((gauge) => gauge.value)).toEqual([0]);
      expect(recorded.some((gauge) => gauge.name === 'cap_publish_latency_ms')).toBe(true);
      const lines = await call('GET', `/capital-plans/${plan.id}/lines`, { member: READER });
      expect(lines.status).toBe(200);
      expect((lines.json.items as Array<Record<string, unknown>>).map((item) => [item.committed_vnd, item.reserved_vnd])).toEqual([
        ['0', '0'],
        ['0', '0'],
      ]);
      expect((lines.json.totals as Record<string, string>).allocated_vnd).toBe(money(3));
    });

    it('lets one of two parallel publications of a plan win and posts its entries once (UAT-AC223 race, runLoops)', async () => {
      let plan: Plan | undefined;
      const rounds = await runLoops({
        loops: 6,
        reset: async () => {
          plan = await approvedPlan([money(1), money(1)]);
        },
        commands: () => {
          const current = plan as Plan;
          return [0, 1].map(() => async () => {
            const reply = await publish(current.id, current.version, { decision_document_id: await document() });
            if (reply.status !== 200) throw Object.assign(new Error(String(reply.json.code)), { status: reply.status, code: reply.json.code });
          });
        },
        verify: async ({ outcomes }) => {
          const current = plan as Plan;
          assertOneWinner(outcomes, ['409 VERSION_CONFLICT', '409 PLAN_NOT_APPROVED']);
          expect(await ledgerOf(current.id)).toHaveLength(2);
          expect(await statusOf(current.id)).toBe('PUBLISHED');
          expect(await events(current.id, 'capital.plan_published.v1')).toHaveLength(1);
        },
      });
      expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))['200']).toBe(6);
    });
  });
});
