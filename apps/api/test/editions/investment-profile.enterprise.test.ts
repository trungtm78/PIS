import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { CapAppropriationStore, CapPlanStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { AppropriationInput } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { registerEnterpriseCatalogueRules } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { InvestmentProfileController } from '../../src/editions/enterprise/investment-profile.controller';
import { APPROVER, BQL1, CapWorld, MAKER, ROOT, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The investment profile of a project through the application the enterprise edition mounts (MD.01, MD.02, CN.01). The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the
 * enterprise package. The plan lines go through the stores of the product, so the origin and the decision document are the ones the register leaves.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const READER = 4;
const OUTSIDER = 5;
const TODAY = vietnamDateOf(new Date());

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the investment profile of a project (MD.01, MD.02, CN.01)', () => {
  const world = new CapWorld();
  const appropriations = new CapAppropriationStore();
  const plans = new CapPlanStore();
  let app: RunningApp;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(url: string, member = READER): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function publishAppropriation(year: number, origin: AppropriationInput['origin'], decisionKind: string): Promise<string> {
    const input: AppropriationInput = {
      fundSourceVersionId: world.defaultFundVersionId,
      planYear: year,
      origin,
      budgetLevel: 'ALL',
      amountVnd: money(10),
      decisionDocumentId: await world.document(),
      issuingAuthority: 'Issuing authority',
      decisionKind,
      sourceYear: year,
    };
    const draft = await world.as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY, 'ENTERPRISE'));
    await world.as((tx) => appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), APPROVER);
    return draft.id;
  }

  /** A draft plan of the year with one line per origin for the project. */
  async function draftPlan(year: number, projectId: string, lines: Array<{ appropriationId: string; bucket: 'EQUITY' | 'LOAN'; amount: string }>): Promise<void> {
    const everything = () => ({ sql: 'true', params: [] });
    const created = await world.as((tx) => plans.createPlan(tx, { planCode: `ENT-${randomUUID().slice(0, 8)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), () => undefined));
    const [row] = await world.owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]);
    await world.as((tx) =>
      plans.draft(
        tx,
        created.id,
        Number(row?.version),
        { lines: lines.map((one) => ({ projectId, appropriationId: one.appropriationId, bucket: one.bucket, sourceYear: year, amountVnd: one.amount })), removeLineIds: [] },
        memberId(MAKER),
        { write: everything, read: { lines: everything, drafts: true } },
        TODAY,
      ),
    );
  }

  const milestone = (projectId: string, code: string, planned: string, actual: string | null) =>
    world.owner(
      `insert into machvon.project_milestone (tenant_id, id, project_id, code, name, baseline_date, planned_date, actual_date, status, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, $3, $4::date, $4::date, $5::date, $6, $7, $7)`,
      [TENANT_A, projectId, code, planned, actual, actual === null ? 'PLANNED' : 'DONE', memberId(MAKER)],
    );

  beforeAll(async () => {
    await world.start();
    registerEnterpriseCatalogueRules();
    await world.harness.seedMembership(TENANT_A, READER, ROOT);
    await world.harness.seedMembership(TENANT_A, OUTSIDER, ROOT);
    await world.harness.seedRole(TENANT_A, 1, 'PROJECT_READER', ['project.read'], 30);
    await world.harness.seedGrants(TENANT_A, [{ n: 1, member: READER, role: 1, kind: 'TENANT' }]);
    const tenants = world.harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [InvestmentProfileController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('reads the type, the flag of the stage, the milestones against the catalogue and the split of the plan by the origin of the capital', async () => {
    const year = world.freshYear();
    const projectId = await world.project({ unitNumber: BQL1 });
    const typeVersion = await world.master('ENT_MAJOR_REPAIR', 'PROJECT_TYPE', { kind: 'MAJOR_REPAIR' });
    await world.owner('update machvon.project set start_year = $2, project_type_master_version_id = $3::uuid where id = $1::uuid', [projectId, year - 1, typeVersion]);
    await milestone(projectId, 'INVESTMENT_POLICY', '2024-01-10', '2024-01-12');
    await milestone(projectId, 'FS_APPROVAL', '2024-06-01', '2024-07-01');
    await milestone(projectId, 'TMDT_APPROVAL', '2024-06-15', '2024-06-20');
    await milestone(projectId, 'CONTRACTOR_SELECTION_PLAN', '2026-01-01', null);
    const group = await publishAppropriation(year, 'GROUP_ASSIGNED', 'GROUP_RESOLUTION');
    const company = await publishAppropriation(year, 'BOARD_APPROVED', 'COMPANY_DECISION');
    await draftPlan(year, projectId, [
      { appropriationId: group, bucket: 'EQUITY', amount: money(3) },
      { appropriationId: company, bucket: 'LOAN', amount: money(2) },
    ]);

    const reply = await get(`/projects/${projectId}/investment-profile?plan_year=${year}`);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      project_id: projectId,
      plan_year: year,
      as_of: TODAY,
      project_type: { code: expect.stringMatching(/^ENT_MAJOR_REPAIR/u), kind: 'MAJOR_REPAIR' },
      start_flag: 'CONTINUING',
      start_year: year - 1,
      start_year_basis: 'PROJECT',
      plan: { status: 'DRAFT', revision: 1 },
      findings: ['MILESTONE_ORDER:TMDT_APPROVAL'],
    });
    const milestones = reply.json.milestones as Array<{ code: string; state: string; actual_on: string | null }>;
    expect(milestones.map((one) => one.code)).toEqual(['INVESTMENT_POLICY', 'INVESTMENT_CERTIFICATE', 'FS_APPROVAL', 'TMDT_APPROVAL', 'CONTRACTOR_SELECTION_PLAN', 'GROUNDBREAKING', 'ACCEPTANCE', 'FINAL_SETTLEMENT']);
    expect(milestones.find((one) => one.code === 'FS_APPROVAL')).toMatchObject({ state: 'REACHED', actual_on: '2024-07-01' });
    expect(milestones.find((one) => one.code === 'CONTRACTOR_SELECTION_PLAN')).toMatchObject({ state: 'PLANNED', actual_on: null });
    expect(milestones.find((one) => one.code === 'ACCEPTANCE')).toMatchObject({ state: 'NOT_HELD' });
    const split = reply.json.origin_split as { total_vnd: string; group_assigned_vnd: string; board_approved_vnd: string; other_vnd: string; origins: Array<{ origin: string; decisions: Array<{ kind: string; symbol: string }> }> };
    expect(split).toMatchObject({ total_vnd: money(5), group_assigned_vnd: money(3), board_approved_vnd: money(2), other_vnd: '0' });
    expect(split.origins.map((one) => [one.origin, one.decisions.map((decision) => decision.kind)])).toEqual([
      ['BOARD_APPROVED', ['COMPANY_DECISION']],
      ['GROUP_ASSIGNED', ['GROUP_RESOLUTION']],
    ]);
    expect(split.origins.every((one) => one.decisions.every((decision) => /^QD-/u.test(decision.symbol)))).toBe(true);
  });

  it('says there is no plan of the year, no type and no milestone for a project that has none, and takes the year of today when none is asked', async () => {
    const projectId = await world.project({ unitNumber: BQL1 });
    const reply = await get(`/projects/${projectId}/investment-profile`);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ plan_year: Number(TODAY.slice(0, 4)), project_type: null, start_flag: null, start_year: null, start_year_basis: null, plan: null, findings: [] });
    expect((reply.json.milestones as Array<{ state: string }>).every((one) => one.state === 'NOT_HELD')).toBe(true);
    expect(reply.json.origin_split).toMatchObject({ total_vnd: '0', origins: [] });
  });

  it('refuses a year that is not a year (422), a project that does not exist (404) and a caller without the permission (403)', async () => {
    const projectId = await world.project({ unitNumber: BQL1 });
    for (const bad of ['abc', '1999', '2101', '20260', '']) {
      const reply = await get(`/projects/${projectId}/investment-profile?plan_year=${bad}`);
      expect([reply.status, reply.json.code, reply.json.detail === undefined ? undefined : 'detail']).toEqual([422, 'VALIDATION_FAILED', 'detail']);
    }
    expect((await get(`/projects/${randomUUID()}/investment-profile`)).status).toBe(404);
    expect((await get(`/projects/${projectId}/investment-profile`, OUTSIDER)).status).toBe(403);
  });
});
