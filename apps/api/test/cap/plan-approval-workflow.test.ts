import { randomBytes, randomUUID } from 'node:crypto';
import { CapPlanStore, EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { signTenantContext, verifyTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { DomainError, SignalRequest, TenantContext, WorkflowDefinition } from '@machvon/kernel';
import { APPROVAL_STATES, CAPITAL_PLAN_APPROVAL_WORKFLOW, capitalPlanApprovalWorkflow } from '../../src/modules/cap';
import { InProcessOrchestrator } from '../../src/modules/orchestration/in-process-orchestrator';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

jest.setTimeout(240_000);

const KEY = randomBytes(32);
const PLANNER = 1;
const APPROVER = 2;
const PUBLISHER = 3;
const B_USER = 1; // of tenant B
const ROOT = 1;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];

const contextOf = (tenantId: string, member: number): TenantContext => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });
const tokenOf = (tenantId: string, member: number): string => signTenantContext(contextOf(tenantId, member), KEY);

async function failure(work: Promise<unknown>): Promise<DomainError> {
  try {
    await work;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a failure');
}

/** The approval workflow of the capital plan CAP-PLAN-A-01 (ST-CAP-003, NFR-TENANCY-08): every activity runs in the signed tenant context of its signal. */
describe('the approval workflow of the capital plan (AC-ST-CAP-003-6, UAT-NFR-TENANCY-08)', () => {
  const harness = new AuthzHarness();
  const seen: Array<{ signal: string; context: TenantContext }> = [];
  let orchestrator: InProcessOrchestrator;
  let area = '';
  let fund = '';

  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function master(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, name, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, $5::jsonb, '2020-01-01', 'EFFECTIVE', $6, now(), $7, $7)`,
        [TENANT_A, versionId, masterType, name, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  async function document(): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
    );
    return id;
  }

  /** The plan CAP-PLAN-A-01 with one line of a project of the pipeline, drafted by the planner. */
  async function plan(): Promise<{ planId: string; projectId: string; version: number; lineId: string }> {
    const year = 2090 + Math.floor(Math.random() * 9);
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, fund, year, String(10 * BILLION), await document(), memberId(APPROVER), memberId(PLANNER)],
    );
    const tenants = harness.tenants as TenantDatabase;
    const created = await tenants.withTenant(contextOf(TENANT_A, PLANNER), (tx) =>
      new PrjProjectStore().create(tx, { code: `WF-${randomUUID().slice(0, 8)}`, name: 'Workflow project', ownerUnitId: unitId(ROOT), areaMasterVersionId: area, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows("update machvon.project set status = 'PIPELINE', project_group = 'B', national_project_code = $2 where id = $1::uuid", [created.id, String(4000000 + Math.floor(Math.random() * 999999))]);
    const everything = () => ({ sql: 'true', params: [] as unknown[] });
    const store = new CapPlanStore();
    const header = await tenants.withTenant(contextOf(TENANT_A, PLANNER), (tx) =>
      store.createPlan(tx, { planCode: `CAP-PLAN-A-01-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(PLANNER), () => undefined),
    );
    const drafted = await tenants.withTenant(contextOf(TENANT_A, PLANNER), (tx) =>
      store.draft(tx, header.id, 1, { lines: [{ projectId: created.id, appropriationId, bucket: 'CURRENT_YEAR', sourceYear: year, amountVnd: String(BILLION) }] }, memberId(PLANNER), { write: everything, read: { lines: everything, drafts: true } }),
    );
    const lineId = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [header.id]))[0]?.id as string;
    return { planId: header.id, projectId: created.id, version: drafted.version, lineId };
  }

  const versionOf = async (planId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.version);
  const statusOf = async (planId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.status as string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [PLANNER, APPROVER, PUBLISHER]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_B, B_USER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...READS], 40);
    await harness.seedRole(TENANT_A, 2, 'APPROVER', ['capital.plan.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 3, 'PUBLISHER', ['plan.publish', ...READS], 50);
    await harness.seedRole(TENANT_B, 1, 'ALL', ['capital.plan.submit', 'capital.plan.approve', 'plan.publish', ...READS], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_USER, role: 1, kind: 'TENANT' }]);
    area = await master('AREA-WF', 'AREA', {});
    fund = await master('NSTW-WF', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    const tenants = harness.tenants as TenantDatabase;
    const access = new EffectiveAccessStore(tenants, new InMemoryAuthzCache());
    const definition = capitalPlanApprovalWorkflow({ database: tenants, access: (context) => access.load(context) });
    // Every activity is recorded with the context it ran under, so the test can say whose context each one carried.
    const recorded: WorkflowDefinition = {
      ...definition,
      transitions: definition.transitions.map((transition) => ({
        ...transition,
        activity: async (request: SignalRequest) => {
          seen.push({ signal: request.signal, context: request.context });
          await transition.activity?.(request);
        },
      })),
    };
    orchestrator = new InProcessOrchestrator({ verify: (token) => verifyTenantContext(token, KEY) });
    orchestrator.register(recorded);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('moves a plan from drafting to published, every activity under the signed context of its signal and the plan, audit, ledger and event written like the commands do', async () => {
    const target = await plan();
    const started = await orchestrator.start(CAPITAL_PLAN_APPROVAL_WORKFLOW, { plan_id: target.planId }, tokenOf(TENANT_A, PLANNER));
    expect(started).toMatchObject({ state: APPROVAL_STATES.drafting, status: 'WAITING', tenantId: TENANT_A });
    const before = seen.length;

    const submitted = await orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: target.version }, tokenOf(TENANT_A, PLANNER));
    expect(submitted).toMatchObject({ state: APPROVAL_STATES.inReview });
    expect(await statusOf(target.planId)).toBe('IN_REVIEW');

    // A planner holds no approval permission: the activity refuses as the command does and the instance keeps waiting.
    const unauthorised = await failure(orchestrator.signal(started.id, 'approve', { plan_id: target.planId, expected_version: await versionOf(target.planId), reason: 'My own plan is fine' }, tokenOf(TENANT_A, PLANNER)));
    expect(unauthorised).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    expect((await orchestrator.describe(started.id, tokenOf(TENANT_A, APPROVER))).state).toBe(APPROVAL_STATES.inReview);

    const approved = await orchestrator.signal(started.id, 'approve', { plan_id: target.planId, expected_version: await versionOf(target.planId), reason: 'Reviewed against the decision' }, tokenOf(TENANT_A, APPROVER));
    expect(approved.state).toBe(APPROVAL_STATES.approved);
    const documentId = await document();
    const published = await orchestrator.signal(started.id, 'publish', { plan_id: target.planId, expected_version: await versionOf(target.planId), decision_document_id: documentId }, tokenOf(TENANT_A, PUBLISHER));
    expect(published).toMatchObject({ state: APPROVAL_STATES.published, status: 'COMPLETED' });

    // Every activity that ran carried the tenant and the person of the token of its own signal.
    expect(seen.slice(before).map((call) => [call.signal, call.context.tenantId, call.context.membershipId])).toEqual([
      ['submit', TENANT_A, memberId(PLANNER)],
      ['approve', TENANT_A, memberId(PLANNER)],
      ['approve', TENANT_A, memberId(APPROVER)],
      ['publish', TENANT_A, memberId(PUBLISHER)],
    ]);
    expect(await statusOf(target.planId)).toBe('PUBLISHED');
    const audit = await rows<{ action: string; actor_id: string }>('select action, actor_id from machvon.audit_event where resource_id = $1::uuid order by occurred_at', [target.planId]);
    expect(audit.map((row) => [row.action, row.actor_id])).toEqual([
      ['capital.plan_submitted', memberId(PLANNER)],
      ['capital.plan_decided', memberId(APPROVER)],
      ['capital.plan_published', memberId(PUBLISHER)],
    ]);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.plan_published.v1'", [target.planId]))[0]?.n).toBe('1');
    expect(await rows<{ entry_type: string; amount: string }>("select entry_type, amount_vnd::text as amount from machvon.capital_ledger_entry where source_ref_id = $1::uuid", [target.planId])).toEqual([{ entry_type: 'ALLOCATE', amount: String(BILLION) }]);
    expect(await rows<{ allocated: string }>('select allocated_vnd::text as allocated from machvon.allocation_balance where allocation_line_id = $1::uuid', [target.lineId])).toEqual([{ allocated: String(BILLION) }]);
  });

  it('does not find the instance of another tenant, refuses a context that does not verify, and runs no activity for either', async () => {
    const target = await plan();
    const started = await orchestrator.start(CAPITAL_PLAN_APPROVAL_WORKFLOW, { plan_id: target.planId }, tokenOf(TENANT_A, PLANNER));
    const before = seen.length;
    const foreign = await failure(orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: target.version }, tokenOf(TENANT_B, B_USER)));
    expect(foreign).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const signature = tokenOf(TENANT_A, PLANNER).split('.')[1];
    const forged = `${Buffer.from(JSON.stringify(contextOf(TENANT_B, B_USER)), 'utf8').toString('base64url')}.${signature}`;
    expect(await failure(orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: target.version }, forged))).toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    expect(await failure(orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: target.version }, 'not-a-token'))).toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    expect(seen.length).toBe(before);
    expect(await statusOf(target.planId)).toBe('DRAFT');
    expect((await orchestrator.describe(started.id, tokenOf(TENANT_A, APPROVER))).state).toBe(APPROVAL_STATES.drafting);
  });

  it('runs an instance started in another tenant only in that tenant: the plan of tenant A does not exist for it, and a signal for another plan is refused', async () => {
    const target = await plan();
    const other = await plan();
    const foreignInstance = await orchestrator.start(CAPITAL_PLAN_APPROVAL_WORKFLOW, { plan_id: target.planId }, tokenOf(TENANT_B, B_USER));
    const reached = await failure(orchestrator.signal(foreignInstance.id, 'submit', { plan_id: target.planId, expected_version: target.version }, tokenOf(TENANT_B, B_USER)));
    expect(reached).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await statusOf(target.planId)).toBe('DRAFT');
    const own = await orchestrator.start(CAPITAL_PLAN_APPROVAL_WORKFLOW, { plan_id: target.planId }, tokenOf(TENANT_A, PLANNER));
    expect(await failure(orchestrator.signal(own.id, 'submit', { plan_id: other.planId, expected_version: other.version }, tokenOf(TENANT_A, PLANNER)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
    expect(await failure(orchestrator.signal(own.id, 'submit', { plan_id: target.planId, expected_version: 0 }, tokenOf(TENANT_A, PLANNER)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expected_version' });
    expect(await failure(orchestrator.signal(own.id, 'publish', { plan_id: target.planId, expected_version: target.version }, tokenOf(TENANT_A, PUBLISHER)))).toMatchObject({ code: 'WORKFLOW_STATE_INVALID' });
    expect(await statusOf(other.planId)).toBe('DRAFT');
  });

  it('returns a plan to drafting and ends the instance when the plan is rejected', async () => {
    const target = await plan();
    const started = await orchestrator.start(CAPITAL_PLAN_APPROVAL_WORKFLOW, { plan_id: target.planId }, tokenOf(TENANT_A, PLANNER));
    await orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: target.version }, tokenOf(TENANT_A, PLANNER));
    const returned = await orchestrator.signal(started.id, 'return', { plan_id: target.planId, expected_version: await versionOf(target.planId), reason: 'Lower the line' }, tokenOf(TENANT_A, APPROVER));
    expect(returned.state).toBe(APPROVAL_STATES.drafting);
    expect(await statusOf(target.planId)).toBe('DRAFT');
    await orchestrator.signal(started.id, 'submit', { plan_id: target.planId, expected_version: await versionOf(target.planId) }, tokenOf(TENANT_A, PLANNER));
    const rejected = await orchestrator.signal(started.id, 'reject', { plan_id: target.planId, expected_version: await versionOf(target.planId), reason: 'Outside the plan' }, tokenOf(TENANT_A, APPROVER));
    expect(rejected).toMatchObject({ state: APPROVAL_STATES.rejected, status: 'COMPLETED' });
    expect(await statusOf(target.planId)).toBe('REJECTED');
  });
});
