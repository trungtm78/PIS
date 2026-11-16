import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * The projects that run each kind of workflow over HTTP (PWF-01, the library of procedures): `GET /project-workflow/templates/usage` counts the running workflows by template code, in the scope of `pwf.read` of the
 * caller and in the tenant of the caller only; a caller without `pwf.read` is refused.
 */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const MANAGER = 1;
const READER_OF_DEPARTMENT = 2;
const NO_RIGHT = 3;
const CHECKER = 4;
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_DEPARTMENT = 3;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

const TEMPLATE = {
  name: 'Usage over HTTP',
  project_type: null,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [{ code: 'ONLY', name: 'Only task', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: null, priority: 'NORMAL', predecessors: [], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [] }],
};

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the projects that run each kind of workflow over HTTP (PWF-01)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenant = TENANT_A): string => signTenantContext({ tenantId: tenant, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, member: number, body?: unknown, tenant = TENANT_A): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member, tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      { n: OTHER_DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(OTHER_DEPARTMENT)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
    await harness.seedMembership(TENANT_A, MANAGER, ROOT);
    await harness.seedMembership(TENANT_A, READER_OF_DEPARTMENT, DEPARTMENT);
    await harness.seedMembership(TENANT_A, NO_RIGHT, ROOT);
    await harness.seedMembership(TENANT_A, CHECKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_READER', ['project.read', 'pwf.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'NO_PWF', ['home.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER_OF_DEPARTMENT, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: NO_RIGHT, role: 3, kind: 'TENANT' },
    ]);
    const recordId = randomUUID();
    const areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-U', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', 'TINH-U', 1, 'TINH-U', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
        [TENANT_A, areaVersion, recordId, memberId(MANAGER)],
      ],
    ]);
    await harness.owner(
      TENANT_A,
      [YEAR - 1, YEAR, YEAR + 1, YEAR + 2].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'USAGEAPI', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $3, now(), $4, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(CHECKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWorkflowController, ProjectWorkflowReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    for (const department of [DEPARTMENT, OTHER_DEPARTMENT]) {
      const made = await call('POST', '/projects', MANAGER, { code: `PUA-${randomUUID().slice(0, 6)}`, name: `Dự án ${department}`, owner_unit_id: unitId(department), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
      expect(made.status).toBe(200);
      const projectId = made.json.resource_id as string;
      await harness.owner(TENANT_A, [[`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [projectId]]]);
      const flow = await call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'USAGEAPI', planned_start_date: TODAY, facts: { project_group: 'B' } });
      expect(flow.status).toBe(200);
    }
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('answers the running workflows by template code for a reader of the whole tenant, with the day it was read', async () => {
    const reply = await call('GET', '/project-workflow/templates/usage', MANAGER);
    expect(reply.status).toBe(200);
    expect(reply.json.items).toEqual([{ template_code: 'USAGEAPI', active_projects: 2 }]);
    expect(typeof reply.json.as_of).toBe('string');
  });

  it('counts only the projects in the scope of the caller: a reader of one department sees one', async () => {
    const reply = await call('GET', '/project-workflow/templates/usage', READER_OF_DEPARTMENT);
    expect(reply.status).toBe(200);
    expect(reply.json.items).toEqual([{ template_code: 'USAGEAPI', active_projects: 1 }]);
  });

  it('refuses a caller who does not hold pwf.read', async () => {
    expect((await call('GET', '/project-workflow/templates/usage', NO_RIGHT)).status).toBe(403);
  });

  it('answers nothing of this tenant to a caller of another tenant', async () => {
    const reply = await call('GET', '/project-workflow/templates/usage', MANAGER, undefined, TENANT_B);
    expect([200, 401, 403, 404]).toContain(reply.status);
    if (reply.status === 200) expect(reply.json.items).toEqual([]);
  });
});
