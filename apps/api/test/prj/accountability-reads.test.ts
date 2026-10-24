import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AccountabilityReadsController } from '../../src/modules/prj/accountability-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const ACTOR = 1;
const DEPARTMENT_READER = 2; // project.read and taskforce.read on the department
const TENANT_READER = 3; // the same on the whole tenant
const OTHER_BRANCH_READER = 4; // the same on another branch
const NO_READ = 5; // taskforce.manage only
const NOBODY = 6;
const B_READER = 21; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the reads of the assignments and of the task forces (ST-PRJ-005, PRJ-17 and PRJ-18)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';
  const projects: Record<string, string> = {};
  const forceIds: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(url: string, options: { member: number; tenantId?: string }): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(options.member, options.tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const owner = (sql: string, params: unknown[] = [], tenant = TENANT_A) => harness.owner(tenant, [[sql, params]]);

  async function project(code: string, unit: number): Promise<string> {
    const created = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(ACTOR)), (tx) =>
      new PrjProjectStore().create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(ACTOR), TODAY),
    );
    return created.id;
  }
  const assignment = (projectId: string, leader: number, role: string, from: string, until: string | null, tenant = TENANT_A) =>
    owner(
      `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, valid_until, status, end_reason, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $10)`,
      [tenant, randomUUID(), projectId, memberId(leader), role, from, until, until === null ? 'ACTIVE' : 'ENDED', until === null ? null : 'Reassigned', memberId(ACTOR)],
      tenant,
    );
  async function force(code: string, unit: number, lead: number, tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await owner(
      `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, status, created_by, updated_by)
       values ($1, $2, $3, $4, 'Press the disbursement of the slow projects', $5, $6, '2026-01-05', 'ACTIVE', $7, $7)`,
      [tenant, id, code, `Task force ${code}`, memberId(lead), unitId(unit), memberId(ACTOR)],
      tenant,
    );
    await owner(
      `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, valid_from, created_by, updated_by) values ($1, $2, $3, $4, 'LEAD', '2026-01-05', $5, $5)`,
      [tenant, randomUUID(), id, memberId(lead), memberId(ACTOR)],
      tenant,
    );
    return id;
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
    for (const n of [ACTOR, DEPARTMENT_READER, TENANT_READER, OTHER_BRANCH_READER, NO_READ, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'READER', ['project.read', 'taskforce.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'MANAGER_ONLY', ['taskforce.manage'], 30);
    await harness.seedRole(TENANT_B, 1, 'READER', ['project.read', 'taskforce.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: DEPARTMENT_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 2, member: TENANT_READER, role: 1, kind: 'TENANT' },
      { n: 3, member: OTHER_BRANCH_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: NO_READ, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_READER, role: 1, kind: 'TENANT' }]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-P', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(ACTOR)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', 'TINH-P', 1, 'TINH-P', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
        [TENANT_A, areaVersion, recordId, memberId(ACTOR)],
      ],
    ]);
    projects.a = await project('RD-A', DEPARTMENT);
    projects.b = await project('RD-B', ELSEWHERE);
    await assignment(projects.a, DEPARTMENT_READER, 'LEADER_IN_CHARGE', '2024-01-01', '2024-12-31');
    await assignment(projects.a, TENANT_READER, 'LEADER_IN_CHARGE', '2025-01-01', null);
    await assignment(projects.a, DEPARTMENT_READER, 'DEPUTY_LEADER', '2025-01-01', null);
    await assignment(projects.b, OTHER_BRANCH_READER, 'LEADER_IN_CHARGE', '2025-01-01', null);
    forceIds.a = await force('RD-TF-A', DEPARTMENT, DEPARTMENT_READER);
    forceIds.b = await force('RD-TF-B', ELSEWHERE, OTHER_BRANCH_READER);
    await owner(`update machvon.task_force_member set valid_until = '2026-02-01' where task_force_id = $1::uuid`, [forceIds.a]);
    await owner(
      `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, project_id, valid_from, created_by, updated_by) values ($1, $2, $3, $4, 'MEMBER', $5, '2026-02-02', $6, $6)`,
      [TENANT_A, randomUUID(), forceIds.a, memberId(TENANT_READER), projects.a, memberId(ACTOR)],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({
          database: tenants,
          access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()),
        }),
      ],
      controllers: [AccountabilityReadsController],
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

  describe('the register of assignments (PRJ-17)', () => {
    it('UI-PRJ-17: lists the assignments of the projects in the scope, a project first and its latest period first, with the names and the history', async () => {
      const reply = await get('/resources/project_accountability', { member: TENANT_READER });
      expect(reply.status).toBe(200);
      expect(reply.json.as_of).toBe(TODAY);
      expect(items(reply).map((line) => [line.project_code, line.accountability_role, line.status, line.valid_from, line.valid_until])).toEqual([
        ['RD-A', 'LEADER_IN_CHARGE', 'ACTIVE', '2025-01-01', null],
        ['RD-A', 'DEPUTY_LEADER', 'ACTIVE', '2025-01-01', null],
        ['RD-A', 'LEADER_IN_CHARGE', 'ENDED', '2024-01-01', '2024-12-31'],
        ['RD-B', 'LEADER_IN_CHARGE', 'ACTIVE', '2025-01-01', null],
      ]);
      expect(items(reply)[0]).toEqual({
        id: expect.any(String),
        project_id: projects.a,
        project_code: 'RD-A',
        project_name: 'Project RD-A',
        leader: { membership_id: memberId(TENANT_READER), display_name: 'User 3' },
        accountability_role: 'LEADER_IN_CHARGE',
        assignment_document_id: null,
        valid_from: '2025-01-01',
        valid_until: null,
        status: 'ACTIVE',
        end_reason: null,
        version: 1,
      });
      expect(items(reply)[2]).toMatchObject({ status: 'ENDED', end_reason: 'Reassigned' });
      expect(reply.json.next_cursor).toBeNull();
    });

    it('shows a caller only the projects of their units, filters by project and by status, and pages with a cursor', async () => {
      const scoped = await get('/resources/project_accountability', { member: DEPARTMENT_READER });
      expect(new Set(items(scoped).map((line) => line.project_code))).toEqual(new Set(['RD-A']));
      expect((await get('/resources/project_accountability', { member: OTHER_BRANCH_READER })).json.items).toHaveLength(1);
      const one = await get(`/resources/project_accountability?project_id=${projects.a}&status=ENDED`, { member: TENANT_READER });
      expect(items(one)).toHaveLength(1);
      const first = await get('/resources/project_accountability?limit=2', { member: TENANT_READER });
      expect(items(first)).toHaveLength(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await get(`/resources/project_accountability?limit=2&cursor=${first.json.next_cursor as string}`, { member: TENANT_READER });
      expect(items(second).map((line) => line.project_code)).toEqual(['RD-A', 'RD-B']);
      expect(second.json.next_cursor).toBeNull();
    });

    it('refuses what is not a query (422), a caller without project.read (403), and shows nothing of another tenant', async () => {
      for (const query of ['project_id=nope', 'status=DONE', 'status=', 'limit=0', 'cursor=junk']) expect((await get(`/resources/project_accountability?${query}`, { member: TENANT_READER })).status).toBe(422);
      expect((await get('/resources/project_accountability', { member: NOBODY })).status).toBe(403);
      expect(items(await get('/resources/project_accountability', { member: B_READER, tenantId: TENANT_B }))).toEqual([]);
    });
  });

  describe('the task forces (PRJ-18)', () => {
    it('UI-PRJ-18: lists the task forces whose unit is in the scope with the lead, the scope unit and the terms, the open ones first', async () => {
      const reply = await get('/resources/task_force', { member: TENANT_READER });
      expect(reply.status).toBe(200);
      expect(items(reply).map((line) => line.code)).toEqual(['RD-TF-A', 'RD-TF-B']);
      const a = items(reply)[0] as Record<string, unknown>;
      expect(a).toMatchObject({
        id: forceIds.a,
        name: 'Task force RD-TF-A',
        lead: { membership_id: memberId(DEPARTMENT_READER), display_name: 'User 2' },
        scope_unit: { id: unitId(DEPARTMENT), code: 'U2', name: 'Unit 2' },
        establishment_document_id: null,
        status: 'ACTIVE',
        version: 1,
      });
      expect((a.members as Array<Record<string, unknown>>).map((member) => [member.display_name, member.role, member.valid_until, (member.project as { code: string } | null)?.code ?? null])).toEqual([
        ['User 3', 'MEMBER', null, 'RD-A'],
        ['User 2', 'LEAD', '2026-02-01', null],
      ]);
    });

    it('shows a caller only the forces of their units, filters by status and pages with a cursor', async () => {
      expect(items(await get('/resources/task_force', { member: DEPARTMENT_READER })).map((line) => line.code)).toEqual(['RD-TF-A']);
      expect(items(await get('/resources/task_force', { member: OTHER_BRANCH_READER })).map((line) => line.code)).toEqual(['RD-TF-B']);
      expect(items(await get('/resources/task_force?status=DISSOLVED', { member: TENANT_READER }))).toEqual([]);
      expect(items(await get('/resources/task_force?status=ACTIVE', { member: TENANT_READER }))).toHaveLength(2);
      const first = await get('/resources/task_force?limit=1', { member: TENANT_READER });
      expect(items(first).map((line) => line.code)).toEqual(['RD-TF-A']);
      const second = await get(`/resources/task_force?limit=1&cursor=${first.json.next_cursor as string}`, { member: TENANT_READER });
      expect(items(second).map((line) => line.code)).toEqual(['RD-TF-B']);
      expect(second.json.next_cursor).toBeNull();
    });

    it('refuses a status that is not one (422), a caller without taskforce.read (403) even with taskforce.manage, and shows nothing of another tenant', async () => {
      expect((await get('/resources/task_force?status=GONE', { member: TENANT_READER })).status).toBe(422);
      expect((await get('/resources/task_force?status=', { member: TENANT_READER })).status).toBe(422);
      expect((await get('/resources/task_force', { member: NO_READ })).status).toBe(403);
      expect((await get('/resources/task_force', { member: NOBODY })).status).toBe(403);
      expect(items(await get('/resources/task_force', { member: B_READER, tenantId: TENANT_B }))).toEqual([]);
    });
  });
});
