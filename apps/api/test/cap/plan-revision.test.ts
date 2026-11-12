import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CapitalPlanRevisionController } from '../../src/modules/cap/plan-revision.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // capital.plan.draft and capital.plan.submit on the whole tenant
const APPROVER = 3; // capital.plan.approve on the whole tenant
const PUBLISHER = 4; // plan.publish on the whole tenant
const ALL_STEPS = 1; // every step, on the whole tenant
const BQL1_STEPS = 5; // every step, on the subtree of BQL1 only
const READER = 6; // capital.read: no step
const NOBODY = 7;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const REASON = 'The ceiling of the project moved after the review of the decision';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Plan {
  id: string;
  year: number;
  appropriationId: string;
  projects: string[];
  version: number;
}

describe('revision and as-of reading of the capital plan over HTTP (ST-CAP-004)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2100;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const codeOf = (reply: Reply): unknown => reply.json.code;

  async function document(): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
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

  async function project(unit = BQL1): Promise<string> {
    counter += 1;
    const number = counter;
    const code = `PR-${number}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(6000000 + number)]);
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

  const drafting = (planId: string, version: number, plan: Plan, amounts: string[], member = PLANNER): Promise<Reply> =>
    call('POST', `/capital-plans/${planId}/allocations`, {
      member,
      ifMatch: `"${version}"`,
      body: { lines: plan.projects.map((projectId, index) => ({ project_id: projectId, appropriation_id: plan.appropriationId, bucket: 'CURRENT_YEAR', source_year: plan.year, amount_vnd: amounts[index] })) },
    });

  /** Takes a plan to PUBLISHED through the three commands, in force from the given moment. */
  async function carry(planId: string, version: number, effectiveAt: string): Promise<number> {
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: `"${version}"`, body: {} });
    expect(submitted.status).toBe(200);
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    expect(decided.status).toBe(200);
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: `"${versionOf(decided)}"`, body: { decision_document_id: await document(), effective_at: effectiveAt } });
    expect(published.status).toBe(200);
    return versionOf(published);
  }

  /** A DRAFT plan of the given lines (one project each); published in force from the moment given when `effectiveAt` is. */
  async function planOf(amounts: string[], effectiveAt?: string): Promise<Plan> {
    const year = freshYear();
    const source = await appropriation(year, money(50));
    const members: string[] = [];
    for (let index = 0; index < amounts.length; index += 1) members.push(await project());
    counter += 1;
    const created = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `RV-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(created.status).toBe(200);
    const plan: Plan = { id: idOf(created), year, appropriationId: source, projects: members, version: versionOf(created) };
    const drafted = await drafting(plan.id, plan.version, plan, amounts);
    expect(drafted.status).toBe(200);
    plan.version = versionOf(drafted);
    if (effectiveAt !== undefined) plan.version = await carry(plan.id, plan.version, effectiveAt);
    return plan;
  }

  const revise = (planId: string, version: number | undefined, member = PLANNER, body: unknown = { reason: REASON }, tenantId?: string): Promise<Reply> =>
    call('POST', `/capital-plans/${planId}/revisions`, { member, body, ...(version === undefined ? {} : { ifMatch: `"${version}"` }), ...(tenantId === undefined ? {} : { tenantId }) });
  const asOf = (planId: string, query: string, member = READER, tenantId?: string): Promise<Reply> => call('GET', `/capital-plans/${planId}/as-of${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const statusOf = async (planId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.status as string;
  const linesOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.lines as Array<Record<string, unknown>>;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ALL_STEPS, PLANNER, APPROVER, PUBLISHER, BQL1_STEPS, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ALL_STEPS', ['capital.plan.draft', 'capital.plan.submit', 'capital.plan.approve', 'plan.publish', ...READS], 60);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...READS], 50);
    await harness.seedRole(TENANT_A, 5, 'READER', READS, 20);
    await harness.seedRole(TENANT_B, 1, 'ALL_STEPS', ['capital.plan.draft', 'capital.plan.submit', 'capital.plan.approve', 'plan.publish', ...READS], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ALL_STEPS, role: 1, kind: 'TENANT' },
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: BQL1_STEPS, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 6, member: READER, role: 5, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, CapitalPlanRevisionController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: metrics },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(CapitalPlanRevisionController);
  });

  describe('createCapitalPlanRevision', () => {
    it('copies the plan in force into a DRAFT revision at version 1, leaves the plan in force published, and writes one audit row with the reason', async () => {
      const plan = await planOf([money(2), money(1)], '2030-06-30T00:00:00Z');
      const created = await revise(plan.id, plan.version);
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const revisionId = idOf(created);
      expect(revisionId).not.toBe(plan.id);
      expect(await statusOf(plan.id)).toBe('PUBLISHED');
      const header = (await rows<{ revision: number; supersedes_id: string; plan_code: string }>('select revision, supersedes_id, plan_code from machvon.capital_plan where id = $1::uuid', [revisionId]))[0];
      expect(header).toMatchObject({ revision: 2, supersedes_id: plan.id });
      const copied = await rows<{ amount: string; previous: string | null }>(
        `select al.amount_vnd::text as amount, al.previous_line_id as previous
           from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid order by al.amount_vnd desc`,
        [revisionId],
      );
      expect(copied.map((line) => line.amount)).toEqual([money(2), money(1)]);
      expect(copied.every((line) => line.previous !== null)).toBe(true);
      const audit = await rows<{ reason: string; diff: Record<string, unknown> }>("select reason, safe_diff as diff from machvon.audit_event where resource_id = $1::uuid and action = 'capital.plan_revision_created'", [revisionId]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: REASON, diff: { revision: 2, supersedes_id: plan.id, copied_lines: 2, copied_projects: 2 } });
    });

    it('refuses a second revision while one is pending (409 REVISION_PENDING_EXISTS)', async () => {
      const plan = await planOf([money(2)], '2030-06-30T00:00:00Z');
      expect((await revise(plan.id, plan.version)).status).toBe(200);
      const again = await revise(plan.id, plan.version);
      expect([again.status, codeOf(again)]).toEqual([409, 'REVISION_PENDING_EXISTS']);
    });

    it('refuses a plan that is not published (409 PLAN_NOT_PUBLISHED), a stale (409) or missing (428) If-Match, a short reason (422), a missing one (400) and a plan of another tenant (404)', async () => {
      const draft = await planOf([money(2)]);
      const notPublished = await revise(draft.id, draft.version);
      expect([notPublished.status, codeOf(notPublished)]).toEqual([409, 'PLAN_NOT_PUBLISHED']);

      const plan = await planOf([money(2)], '2030-06-30T00:00:00Z');
      const stale = await revise(plan.id, plan.version + 5);
      expect([stale.status, codeOf(stale)]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await revise(plan.id, undefined)).status).toBe(428);
      expect((await revise(plan.id, plan.version, PLANNER, { reason: 'short' })).status).toBe(422);
      expect((await revise(plan.id, plan.version, PLANNER, {})).status).toBe(400);
      expect((await revise(plan.id, plan.version, B_PLANNER, { reason: REASON }, TENANT_B)).status).toBe(404);
      // Nothing of the refusals left a revision behind.
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.capital_plan where supersedes_id = $1::uuid', [plan.id]))[0]?.n).toBe('0');
    });

    it('is for those who may draft a plan on the unit of the plan: a reader and a stranger get 403, and so does a drafter of one subtree for a plan of the whole tenant', async () => {
      const plan = await planOf([money(2)], '2030-06-30T00:00:00Z');
      for (const member of [READER, NOBODY, BQL1_STEPS]) {
        const refused = await revise(plan.id, plan.version, member);
        expect([member, refused.status]).toEqual([member, 403]);
      }
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.capital_plan where supersedes_id = $1::uuid', [plan.id]))[0]?.n).toBe('0');
    });

    it('lets the revision be drafted, approved and published, and the plan it replaces becomes SUPERSEDED (AC-2: money moved between lines keeps the total)', async () => {
      const plan = await planOf([money(2), money(1)], '2030-06-30T00:00:00Z');
      const created = await revise(plan.id, plan.version);
      const revisionId = idOf(created);
      const drafted = await drafting(revisionId, versionOf(created), plan, [money(1), money(2)]);
      expect(drafted.status).toBe(200);
      await carry(revisionId, versionOf(drafted), '2030-07-02T00:00:00Z');
      expect(await statusOf(revisionId)).toBe('PUBLISHED');
      expect(await statusOf(plan.id)).toBe('SUPERSEDED');
      const allocated = (await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1::uuid', [plan.appropriationId]))[0]?.allocated;
      expect(allocated).toBe(money(3));
    });
  });

  describe('getCapitalPlanAsOf', () => {
    it('reads the plan as it was on a date: the revision in force then (AC-1: 30/6 gives the first revision, 2/7 the second), by any revision of the plan', async () => {
      const plan = await planOf([money(2), money(1)], '2030-06-30T00:00:00Z');
      const created = await revise(plan.id, plan.version);
      const revisionId = idOf(created);
      const drafted = await drafting(revisionId, versionOf(created), plan, [money(3), money(1)]);
      await carry(revisionId, versionOf(drafted), '2030-07-02T00:00:00Z');

      const june = await asOf(plan.id, '?at=2030-06-30');
      expect(june.status).toBe(200);
      expect(june.json).toMatchObject({ revision: 1, status: 'SUPERSEDED', capital_plan_id: plan.id, totals: { amount_vnd: money(3), initial_vnd: money(3), adjustment_vnd: '0' } });
      expect(linesOf(june).map((line) => line.amount_vnd).sort()).toEqual([money(1), money(2)].sort());

      const july = await asOf(revisionId, '?at=2030-07-02');
      expect(july.status).toBe(200);
      expect(july.json).toMatchObject({ revision: 2, status: 'PUBLISHED', capital_plan_id: revisionId, totals: { amount_vnd: money(4), initial_vnd: money(3), adjustment_vnd: money(1) } });
      const raised = linesOf(july).find((line) => line.amount_vnd === money(3));
      expect(raised).toMatchObject({ initial_vnd: money(2), adjustment_vnd: money(1), as_of_disbursed_vnd: '0' });

      // The day between the two moments is still the first revision; the day before any revision is nothing to read.
      expect(((await asOf(plan.id, '?at=2030-07-01')).json as { revision: number }).revision).toBe(1);
      expect((await asOf(plan.id, '?at=2030-06-01')).status).toBe(404);
    });

    it('narrows to a project, and shows a caller only the lines of their scope (AC-4)', async () => {
      const plan = await planOf([money(2), money(1)], '2030-06-30T00:00:00Z');
      const narrowed = await asOf(plan.id, `?at=2030-06-30&project_id=${plan.projects[0]}`);
      expect(narrowed.status).toBe(200);
      expect(linesOf(narrowed)).toHaveLength(1);
      // Both projects belong to BQL1: a caller of the subtree sees them, a caller of another unit sees none of them.
      expect(linesOf(await asOf(plan.id, '?at=2030-06-30', BQL1_STEPS))).toHaveLength(2);
      const stranger = await asOf(plan.id, '?at=2030-06-30', NOBODY);
      expect([stranger.status]).toEqual([403]);
    });

    it('refuses a moment that is not a date or an instant (422), a project that is not an id (422), and a plan of another tenant (404)', async () => {
      const plan = await planOf([money(2)], '2030-06-30T00:00:00Z');
      expect((await asOf(plan.id, '?at=yesterday')).status).toBe(422);
      expect((await asOf(plan.id, '?at=2030-02-31')).status).toBe(422);
      expect((await asOf(plan.id, '?at=2030-06-30&project_id=not-an-id')).status).toBe(422);
      expect((await asOf(plan.id, '?at=2030-06-30', B_PLANNER, TENANT_B)).status).toBe(404);
    });

    it('UAT-AC09: as of 2026-06-30 the plan reads revision 1 with 5,000,000,000 and the decision of revision 1, as of 2026-07-02 revision 2 with 4,200,000,000, and revision 1 is SUPERSEDED but still readable', async () => {
      const plan = await planOf(['5000000000', money(1)], '2026-01-15T00:00:00Z');
      const first = plan.id;
      const decisionOf = async (planId: string): Promise<string> => (await rows<{ doc: string }>('select decision_document_id::text as doc from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.doc as string;
      const firstDecision = await decisionOf(first);
      expect(firstDecision).toBeTruthy();
      const created = await revise(first, plan.version);
      const second = idOf(created);
      const drafted = await drafting(second, versionOf(created), plan, ['4200000000', money(1)]);
      expect(drafted.status).toBe(200);
      await carry(second, versionOf(drafted), '2026-07-01T00:00:00Z');
      const secondDecision = await decisionOf(second);
      expect(secondDecision).not.toBe(firstDecision);

      const june = await asOf(first, '?at=2026-06-30');
      expect(june.status).toBe(200);
      expect(june.json).toMatchObject({ revision: 1, status: 'SUPERSEDED', capital_plan_id: first, decision_document_id: firstDecision });
      expect(linesOf(june).find((line) => (line.project as { id: string }).id === plan.projects[0])).toMatchObject({ amount_vnd: '5000000000' });

      const july = await asOf(first, '?at=2026-07-02');
      expect(july.status).toBe(200);
      expect(july.json).toMatchObject({ revision: 2, status: 'PUBLISHED', capital_plan_id: second, decision_document_id: secondDecision });
      expect(linesOf(july).find((line) => (line.project as { id: string }).id === plan.projects[0])).toMatchObject({ amount_vnd: '4200000000', initial_vnd: '5000000000', adjustment_vnd: '-800000000' });

      // The replaced revision keeps its status and is still there to read, by its own id as well.
      expect(await statusOf(first)).toBe('SUPERSEDED');
      const again = await asOf(first, '?at=2026-06-30');
      expect(again.json).toMatchObject({ revision: 1, status: 'SUPERSEDED', totals: { amount_vnd: '6000000000' } });
      // A wrong expectation makes the check fail: the 30 June plan is not the 4,200,000,000 one.
      expect(linesOf(june).find((line) => (line.project as { id: string }).id === plan.projects[0])).not.toMatchObject({ amount_vnd: '4200000000' });
    });

    it('UAT-AC224: the revision opens as a DRAFT copy of the lines (previous_line_id names the line of revision 1), and once published the plan shows given at the start 5,000, adjustment -800 and in force 4,200 million for the project, the total of the plan unchanged', async () => {
      const plan = await planOf(['5000000000', '1000000000'], '2026-01-15T00:00:00Z');
      const created = await revise(plan.id, plan.version, PLANNER, { reason: 'Điều chỉnh giữa năm' });
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const second = idOf(created);
      const lineRows = (planId: string) =>
        rows<{ id: string; project_id: string; amount: string; previous: string | null }>(
          `select al.id, al.project_id, al.amount_vnd::text as amount, al.previous_line_id as previous
             from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid`,
          [planId],
        );
      const firstLines = await lineRows(plan.id);
      const copied = await lineRows(second);
      expect(copied).toHaveLength(2);
      for (const line of copied) {
        const origin = firstLines.find((candidate) => candidate.project_id === line.project_id);
        expect(origin).toBeDefined();
        expect(line.previous).toBe(origin?.id);
        expect(line.amount).toBe(origin?.amount);
      }
      // P-A-001 down to 4.2 billion, P-A-002 up by the 0.8 billion: the total of the plan does not move.
      const drafted = await drafting(second, versionOf(created), plan, ['4200000000', '1800000000']);
      expect(drafted.status).toBe(200);
      await carry(second, versionOf(drafted), '2026-07-01T00:00:00Z');
      const shown = await asOf(second, '?at=2026-07-02');
      expect(shown.status).toBe(200);
      const own = linesOf(shown).find((line) => (line.project as { id: string }).id === plan.projects[0]);
      expect(own).toMatchObject({ initial_vnd: '5000000000', adjustment_vnd: '-800000000', amount_vnd: '4200000000' });
      const other = linesOf(shown).find((line) => (line.project as { id: string }).id === plan.projects[1]);
      expect(other).toMatchObject({ initial_vnd: '1000000000', adjustment_vnd: '800000000', amount_vnd: '1800000000' });
      expect(shown.json).toMatchObject({ revision: 2, totals: { amount_vnd: '6000000000', initial_vnd: '6000000000' } });
      const before = await asOf(plan.id, '?at=2026-06-30');
      expect((before.json.totals as { amount_vnd: string }).amount_vnd).toBe((shown.json.totals as { amount_vnd: string }).amount_vnd);
      // A wrong expectation makes the check fail.
      expect(own).not.toMatchObject({ adjustment_vnd: '-700000000' });
    });
  });
});
