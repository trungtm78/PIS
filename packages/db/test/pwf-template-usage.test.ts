import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * How many projects run each kind of workflow (PWF-01, the library of procedures): the running workflows (ACTIVE, or ON_HOLD: the project still uses the template) by the code of the template, only for the projects
 * of the scope of the caller, only in the tenant of the transaction.
 */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const reads = new PwfWorkflowReads();

const MANAGER = 1;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_DEPARTMENT = 3;
const CHECKER = 4;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
/** The projects owned by one unit: what a reader of one department holds. */
const ownedBy =
  (unit: string): ScopeBuilder =>
  (first) => ({ sql: `p.owner_unit_id = $${first}::uuid`, params: [unit] });

const flow = (name: string): Record<string, unknown> => ({
  name,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [{ code: 'ONLY', name: 'Only task', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', priority: 'NORMAL', predecessors: [], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [] }],
});

const as = <T>(run: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(MANAGER)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

let areaVersion = '';
let counter = 0;

/** A project of a department with a running workflow of a template. */
async function started(template: string, department = DEPARTMENT): Promise<{ projectId: string; workflowId: string }> {
  counter += 1;
  const code = `TU-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(department), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [created.id]);
  const workflow = await as((tx) =>
    workflows.start(tx, { projectId: created.id, templateCode: template, plannedStartDate: TODAY, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes: { act: everything, read: everything }, now: NOW }),
  );
  return { projectId: created.id, workflowId: workflow.id };
}

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: PROVINCE, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    { n: OTHER_DEPARTMENT, path: '/u1/u3/', parent: PROVINCE },
  ]);
  await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
  await harness.seedMembership(TENANT_A, CHECKER, DEPARTMENT);
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
  const recordId = randomUUID();
  areaVersion = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-U', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-U', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
  for (const code of ['USE_ONE', 'USE_TWO']) {
    await owner(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template for the tests', $4, $4, now(), $5, now())`,
      [TENANT_A, code, JSON.stringify(flow(code)), memberId(MANAGER), memberId(CHECKER)],
    );
  }
});

afterAll(async () => {
  await harness.stop();
}, 60_000);

const usage = (scope: ScopeBuilder, tenant = TENANT_A): Promise<Array<{ template_code: string; active_projects: number }>> => as((tx) => reads.templateUsage(tx, scope), tenant);

describe('the projects that run each kind of workflow (PWF-01)', () => {
  it('counts the running workflows by template code, a kind nobody runs has no row, and the answer is in the order of the codes', async () => {
    expect(await usage(everything)).toEqual([]);
    await started('USE_ONE');
    await started('USE_ONE');
    const two = await started('USE_TWO');
    expect(await usage(everything)).toEqual([
      { template_code: 'USE_ONE', active_projects: 2 },
      { template_code: 'USE_TWO', active_projects: 1 },
    ]);
    // A workflow that is paused is still in use; one that ended is not.
    await owner(`update machvon.project_workflow set status = 'ON_HOLD' where id = $1::uuid`, [two.workflowId]);
    expect((await usage(everything)).find((row) => row.template_code === 'USE_TWO')).toEqual({ template_code: 'USE_TWO', active_projects: 1 });
    await owner(`update machvon.project_workflow set status = 'CANCELLED' where id = $1::uuid`, [two.workflowId]);
    expect(await usage(everything)).toEqual([{ template_code: 'USE_ONE', active_projects: 2 }]);
  });

  it('counts only the projects in the scope of the caller: a reader of one department sees its projects, a caller with no scope sees none', async () => {
    await started('USE_TWO', OTHER_DEPARTMENT);
    const all = await usage(everything);
    expect(all.find((row) => row.template_code === 'USE_TWO')?.active_projects).toBe(1);
    expect(await usage(ownedBy(unitId(DEPARTMENT)))).toEqual([{ template_code: 'USE_ONE', active_projects: 2 }]);
    expect(await usage(ownedBy(unitId(OTHER_DEPARTMENT)))).toEqual([{ template_code: 'USE_TWO', active_projects: 1 }]);
    expect(await usage(nothing)).toEqual([]);
  });

  it('never counts another tenant: the same read in tenant B answers nothing of what tenant A runs', async () => {
    expect((await usage(everything)).length).toBeGreaterThan(0);
    expect(await usage(everything, TENANT_B)).toEqual([]);
  });
});
