import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { ProjectAccountabilityController } from '../../src/modules/prj/accountability.controller';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { TaskForceController } from '../../src/modules/prj/task-force.controller';
import { PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YESTERDAY = vietnamDateOf(new Date(Date.now() - 86_400_000));
const WORKER = '00000000-0000-4000-8000-000000000000';
const ADMIN = 1; // assigns leaders and manages task forces on the whole tenant
const UNIT_ADMIN = 2; // the same permissions on the subtree of the department only
const LEADER = 3; // project.read on the subtree of the root
const SECOND_LEADER = 4; // project.read on the whole tenant
const ELSEWHERE_READER = 5; // project.read on another branch
const READER = 6; // project.read on the whole tenant, no right to assign
const FIELD_OFFICER = 7; // project.read on the department
const FIELD_OFFICER_2 = 8; // project.read on the department
const OTHER_BRANCH_OFFICER = 9; // project.read on another branch
const B_ADMIN = 21; // of tenant B
const B_MEMBER = 20; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const MANAGE = ['project.read', 'project.create', 'project.accountability.assign', 'taskforce.manage'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('who answers for a project and the task forces (ST-PRJ-005)', () => {
  const harness = new AuthzHarness();
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let counter = 0;
  let area = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedArea(tenant: string): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-P', 'EFFECTIVE', $3, $3)`, [tenant, recordId, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', 'TINH-P', 1, 'TINH-P', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
        [tenant, versionId, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function project(unit = DEPARTMENT): Promise<{ id: string; code: string }> {
    counter += 1;
    const code = `AC-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', { member: ADMIN, body: { code, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(unit), area_master_version_id: area, total_investment_vnd: '500000000000' } });
    expect(made.status).toBe(200);
    return { id: idOf(made), code };
  }

  const assign = (member: number, target: { id: string }, extra: Record<string, unknown> = {}, options: { key?: string } = {}): Promise<Reply> =>
    call('POST', `/projects/${target.id}/accountability-assignments`, {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { leader_membership_id: memberId(LEADER), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2026-01-05', ...extra },
    });
  const endAssignment = (member: number, assignmentId: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/accountability-assignments/${assignmentId}/end`, { member, ifMatch: `"${version}"`, body: { valid_until: TODAY, end_reason: 'Reassigned to another leader', ...extra } });

  let forceCounter = 0;
  const createForce = (member: number, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> => {
    forceCounter += 1;
    return call('POST', '/task-forces', {
      member,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: {
        code: `TF-${forceCounter}-${randomUUID().slice(0, 6)}`,
        name: 'Disbursement task force of the department',
        purpose: 'Press the disbursement of the slow projects of the department',
        lead_membership_id: memberId(FIELD_OFFICER),
        scope_unit_id: unitId(DEPARTMENT),
        valid_from: '2026-01-05',
        ...extra,
      },
    });
  };
  const addMember = (member: number, forceId: string, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/task-forces/${forceId}/members`, { member, ...(tenantId === undefined ? {} : { tenantId }), body: { membership_id: memberId(FIELD_OFFICER_2), member_role: 'MEMBER', valid_from: '2026-01-05', ...extra } });
  const dissolve = (member: number, forceId: string, version: number | string, reason = 'The disbursement target was met'): Promise<Reply> =>
    call('POST', `/task-forces/${forceId}/dissolution`, { member, ifMatch: `"${version}"`, body: { reason } });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const n of [ADMIN, UNIT_ADMIN, LEADER, SECOND_LEADER, ELSEWHERE_READER, READER, FIELD_OFFICER, FIELD_OFFICER_2, OTHER_BRANCH_OFFICER]) await harness.seedMembership(TENANT_A, n, ROOT);
    for (const n of [B_ADMIN, B_MEMBER]) await harness.seedMembership(TENANT_B, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ASSIGNMENT_ADMIN', MANAGE, 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'ASSIGNMENT_ADMIN', MANAGE, 40);
    await harness.seedRole(TENANT_B, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: LEADER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 4, member: SECOND_LEADER, role: 2, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE_READER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: READER, role: 2, kind: 'TENANT' },
      { n: 7, member: FIELD_OFFICER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 8, member: FIELD_OFFICER_2, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 9, member: OTHER_BRANCH_OFFICER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: B_MEMBER, role: 2, kind: 'TENANT' },
    ]);
    area = await seedArea(TENANT_A);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectAccountabilityController, TaskForceController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_PIPELINE_CACHE, useValue: cache },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectAccountabilityController, TaskForceController]));
  });

  describe('the leader in charge (AC-ST-PRJ-005-1)', () => {
    it('AC-ST-PRJ-005-1: assigns the leader, audits and announces it once, clears the project bank, and the register shows the name', async () => {
      const target = await project();
      await cache.set(TENANT_A, 'all', 'probe', 'cached');
      const reply = await assign(ADMIN, target);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect(await rows('select leader_membership_id, accountability_role, status, valid_from::text as valid_from, created_by from machvon.project_accountability where project_id = $1::uuid', [target.id])).toEqual([
        { leader_membership_id: memberId(LEADER), accountability_role: 'LEADER_IN_CHARGE', status: 'ACTIVE', valid_from: '2026-01-05', created_by: memberId(ADMIN) },
      ]);
      const audit = await rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>(`select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = 'project.leader_assigned'`, [target.id]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(ADMIN), safe_diff: { assignment_id: idOf(reply), code: target.code, leader_membership_id: memberId(LEADER), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2026-01-05' } });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.leader_assigned.v1' and aggregate_id = $1`, [target.id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, actor_id: memberId(ADMIN), assignment_id: idOf(reply), leader_membership_id: memberId(LEADER), accountability_role: 'LEADER_IN_CHARGE' }));
      const list = await call('GET', '/resources/project?limit=200', { member: ADMIN });
      const line = (list.json.items as Array<Record<string, unknown>>).find((item) => item.id === target.id);
      expect(line?.leader_in_charge).toEqual({ membership_id: memberId(LEADER), display_name: 'User 3' });
    });

    it('AC-ST-PRJ-005-1: two leaders in charge assigned at once: one is 200 and the other 409 LEADER_ALREADY_ASSIGNED; a later one is 409 until the first has ended, then 200', async () => {
      const target = await project();
      const [first, second] = await Promise.all([assign(ADMIN, target, { leader_membership_id: memberId(LEADER) }), assign(ADMIN, target, { leader_membership_id: memberId(SECOND_LEADER) })]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const refused = first.status === 409 ? first : second;
      const won = first.status === 200 ? first : second;
      expect(refused.json.code).toBe('LEADER_ALREADY_ASSIGNED');
      expect(await rows(`select id from machvon.project_accountability where project_id = $1::uuid and status = 'ACTIVE'`, [target.id])).toHaveLength(1);
      const third = await assign(ADMIN, target, { leader_membership_id: memberId(SECOND_LEADER) });
      expect([third.status, third.json.code]).toEqual([409, 'LEADER_ALREADY_ASSIGNED']);
      // The last day is inclusive: the next leader starts the day after it.
      const ended = await endAssignment(ADMIN, idOf(won), 1, { valid_until: YESTERDAY });
      expect(ended.status).toBe(200);
      const replacement = await assign(ADMIN, target, { leader_membership_id: memberId(SECOND_LEADER), valid_from: TODAY });
      expect(replacement.status).toBe(200);
      expect(await rows(`select leader_membership_id from machvon.project_accountability where project_id = $1::uuid and status = 'ACTIVE'`, [target.id])).toEqual([{ leader_membership_id: memberId(SECOND_LEADER) }]);
    });

    it('AC-ST-PRJ-005-1: the same command repeated with its key answers the first answer and writes nothing twice', async () => {
      const target = await project();
      const key = `key-${randomUUID()}`;
      const first = await assign(ADMIN, target, {}, { key });
      const again = await assign(ADMIN, target, {}, { key });
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(await rows('select id from machvon.project_accountability where project_id = $1::uuid', [target.id])).toHaveLength(1);
      expect(await rows(`select id from machvon.outbox_event where type = 'project.leader_assigned.v1' and aggregate_id = $1`, [target.id])).toHaveLength(1);
    });

    it('ends the assignment with a day and a reason under its version, audits it with the reason, announces it, and the register shows no leader', async () => {
      const target = await project();
      const made = await assign(ADMIN, target);
      await cache.set(TENANT_A, 'all', 'probe', 'cached');
      const stale = await endAssignment(ADMIN, idOf(made), 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const ended = await endAssignment(ADMIN, idOf(made), 1, { end_reason: '  Moved to the ministry  ' });
      expect(ended.status).toBe(200);
      expect(ended.json).toMatchObject({ status: 'ENDED', resource_version: 2, resource_id: idOf(made) });
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect(await rows('select status, valid_until::text as valid_until, end_reason from machvon.project_accountability where id = $1::uuid', [idOf(made)])).toEqual([{ status: 'ENDED', valid_until: TODAY, end_reason: 'Moved to the ministry' }]);
      const audit = await rows<{ reason: string; safe_diff: Record<string, unknown> }>(`select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.leader_unassigned'`, [target.id]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: 'Moved to the ministry', safe_diff: { assignment_id: idOf(made), valid_until: TODAY } });
      expect(await rows(`select id from machvon.outbox_event where type = 'project.leader_unassigned.v1' and aggregate_id = $1`, [target.id])).toHaveLength(1);
      const list = await call('GET', '/resources/project?limit=200', { member: ADMIN });
      expect((list.json.items as Array<Record<string, unknown>>).find((item) => item.id === target.id)?.leader_in_charge ?? null).toBeNull();
      const again = await endAssignment(ADMIN, idOf(made), 2);
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
    });

    it('refuses a person who cannot read the project (422 LEADER_NOT_ELIGIBLE) and knows no member of another tenant (404)', async () => {
      const target = await project();
      const ineligible = await assign(ADMIN, target, { leader_membership_id: memberId(ELSEWHERE_READER) });
      expect([ineligible.status, ineligible.json.code]).toEqual([422, 'LEADER_NOT_ELIGIBLE']);
      const foreign = await assign(ADMIN, target, { leader_membership_id: memberId(B_MEMBER) });
      expect(foreign.status).toBe(404);
      expect(await rows('select id from machvon.project_accountability where project_id = $1::uuid', [target.id])).toEqual([]);
    });

    it('stores the ids in lower case and the text as it was trimmed, in the row, the audit row and the event', async () => {
      const target = await project();
      const made = await call('POST', `/projects/${target.id.toUpperCase()}/accountability-assignments`, {
        member: ADMIN,
        body: { leader_membership_id: memberId(LEADER).toUpperCase(), accountability_role: 'DEPUTY_LEADER', valid_from: '2026-01-05' },
      });
      expect(made.status).toBe(200);
      expect(await rows('select leader_membership_id from machvon.project_accountability where project_id = $1::uuid', [target.id])).toEqual([{ leader_membership_id: memberId(LEADER) }]);
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.leader_assigned.v1' and aggregate_id = $1`, [target.id]);
      expect(events[0]?.payload).toMatchObject({ project_id: target.id, leader_membership_id: memberId(LEADER), accountability_role: 'DEPUTY_LEADER' });
    });

    it('does not reach a project or an assignment of another tenant (404)', async () => {
      const target = await project();
      const made = await assign(ADMIN, target);
      const foreignAssign = await call('POST', `/projects/${target.id}/accountability-assignments`, { member: B_ADMIN, tenantId: TENANT_B, body: { leader_membership_id: memberId(B_MEMBER), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2026-01-05' } });
      expect(foreignAssign.status).toBe(404);
      const foreignEnd = await call('POST', `/accountability-assignments/${idOf(made)}/end`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { valid_until: TODAY, end_reason: 'Not mine to end' } });
      expect(foreignEnd.status).toBe(404);
    });
  });

  describe('the task forces (AC-ST-PRJ-005-2)', () => {
    it('founds a task force scoped to the department with its lead, audits and announces it', async () => {
      const made = await createForce(ADMIN, { code: ' TF-AUDIT ' });
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      expect(await rows('select code, status, lead_membership_id, scope_unit_id from machvon.task_force where id = $1::uuid', [idOf(made)])).toEqual([
        { code: 'TF-AUDIT', status: 'ACTIVE', lead_membership_id: memberId(FIELD_OFFICER), scope_unit_id: unitId(DEPARTMENT) },
      ]);
      expect(await rows('select member_role, membership_id from machvon.task_force_member where task_force_id = $1::uuid', [idOf(made)])).toEqual([{ member_role: 'LEAD', membership_id: memberId(FIELD_OFFICER) }]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'taskforce.created'`, [idOf(made)]);
      expect(audit[0]?.safe_diff).toMatchObject({ code: 'TF-AUDIT', scope_unit_id: unitId(DEPARTMENT) });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'taskforce.created.v1' and aggregate_id = $1`, [idOf(made)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, task_force_id: idOf(made), code: 'TF-AUDIT', actor_id: memberId(ADMIN) }));
      const duplicate = await createForce(ADMIN, { code: 'TF-AUDIT' });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'TASK_FORCE_CODE_DUPLICATE']);
      const invalid = await createForce(ADMIN, { scope_unit_id: randomUUID() });
      expect(invalid.status).toBe(404);
    });

    it('AC-ST-PRJ-005-2: a member outside the scope is 422 MEMBER_OUT_OF_SCOPE, a member from another tenant is 404, and a member of the scope is seated', async () => {
      const force = await createForce(ADMIN);
      const outside = await addMember(ADMIN, idOf(force), { membership_id: memberId(OTHER_BRANCH_OFFICER) });
      expect([outside.status, outside.json.code]).toEqual([422, 'MEMBER_OUT_OF_SCOPE']);
      const foreign = await addMember(ADMIN, idOf(force), { membership_id: memberId(B_MEMBER) });
      expect(foreign.status).toBe(404);
      const target = await project();
      const seated = await addMember(ADMIN, idOf(force), { project_id: target.id });
      expect(seated.status).toBe(200);
      expect(seated.json).toMatchObject({ status: 'ACTIVE', resource_version: 2, resource_id: idOf(force) });
      const wrongProject = await addMember(ADMIN, idOf(force), { membership_id: memberId(FIELD_OFFICER), project_id: (await project(ELSEWHERE)).id });
      expect([wrongProject.status, wrongProject.json.code]).toEqual([422, 'MEMBER_OUT_OF_SCOPE']);
      expect(await rows('select membership_id, member_role, project_id from machvon.task_force_member where task_force_id = $1::uuid order by created_at', [idOf(force)])).toEqual([
        { membership_id: memberId(FIELD_OFFICER), member_role: 'LEAD', project_id: null },
        { membership_id: memberId(FIELD_OFFICER_2), member_role: 'MEMBER', project_id: target.id },
      ]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'taskforce.member_added'`, [idOf(force)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ membership_id: memberId(FIELD_OFFICER_2), member_role: 'MEMBER', project_id: target.id });
      const outsiderForeignForce = await addMember(B_ADMIN, idOf(force), { membership_id: memberId(B_MEMBER) }, TENANT_B);
      expect(outsiderForeignForce.status).toBe(404);
    });

    it('AC-ST-PRJ-005-2: dissolving ends every member in the same transaction, announces it, and the force takes no more members', async () => {
      const force = await createForce(ADMIN);
      const seated = await addMember(ADMIN, idOf(force));
      const stale = await dissolve(ADMIN, idOf(force), 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await dissolve(ADMIN, idOf(force), seated.json.resource_version as number);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DISSOLVED', resource_version: 3 });
      expect(await rows('select status, valid_until::text as valid_until from machvon.task_force where id = $1::uuid', [idOf(force)])).toEqual([{ status: 'DISSOLVED', valid_until: TODAY }]);
      expect((await rows<{ valid_until: string | null }>('select valid_until::text as valid_until from machvon.task_force_member where task_force_id = $1::uuid', [idOf(force)])).map((term) => term.valid_until)).toEqual([TODAY, TODAY]);
      const audit = await rows<{ reason: string; safe_diff: Record<string, unknown> }>(`select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'taskforce.dissolved'`, [idOf(force)]);
      expect(audit[0]).toMatchObject({ reason: 'The disbursement target was met', safe_diff: { ended_members: 2 } });
      expect(await rows(`select id from machvon.outbox_event where type = 'taskforce.dissolved.v1' and aggregate_id = $1`, [idOf(force)])).toHaveLength(1);
      const late = await addMember(ADMIN, idOf(force), { membership_id: memberId(FIELD_OFFICER) });
      expect([late.status, late.json.code]).toEqual([409, 'TASK_FORCE_DISSOLVED']);
      const again = await dissolve(ADMIN, idOf(force), 3);
      expect([again.status, again.json.code]).toEqual([409, 'TASK_FORCE_DISSOLVED']);
      const foreign = await call('POST', `/task-forces/${idOf(force)}/dissolution`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'Not mine to dissolve' } });
      expect(foreign.status).toBe(404);
    });
  });

  describe('who may administer the assignments', () => {
    it('answers 403 SCOPE_DENIED to a holder of the permissions on a unit subtree for every command, and writes nothing', async () => {
      const target = await project();
      const made = await assign(ADMIN, target);
      const force = await createForce(ADMIN);
      const replies = [
        await assign(UNIT_ADMIN, target, { accountability_role: 'DEPUTY_LEADER' }),
        await endAssignment(UNIT_ADMIN, idOf(made), 1),
        await createForce(UNIT_ADMIN),
        await addMember(UNIT_ADMIN, idOf(force)),
        await dissolve(UNIT_ADMIN, idOf(force), 1),
      ];
      expect(replies.map((reply) => [reply.status, reply.json.code])).toEqual(Array.from({ length: 5 }, () => [403, 'SCOPE_DENIED']));
      expect(await rows('select status from machvon.project_accountability where project_id = $1::uuid', [target.id])).toEqual([{ status: 'ACTIVE' }]);
      expect(await rows('select status from machvon.task_force where id = $1::uuid', [idOf(force)])).toEqual([{ status: 'ACTIVE' }]);
      expect(await rows('select id from machvon.task_force_member where task_force_id = $1::uuid', [idOf(force)])).toHaveLength(1);
    });

    it('answers 403 to a caller who holds neither permission, and 400 to a body with a field that is not in the contract', async () => {
      const target = await project();
      expect((await assign(READER, target)).status).toBe(403);
      expect((await createForce(READER)).status).toBe(403);
      const unknownField = await assign(ADMIN, target, { status: 'ACTIVE' });
      expect(unknownField.status).toBe(400);
      const badDate = await assign(ADMIN, target, { valid_from: '2026-02-30' });
      expect(badDate.status).toBeGreaterThanOrEqual(400);
      expect(await rows('select id from machvon.project_accountability where project_id = $1::uuid', [target.id])).toEqual([]);
    });
  });
});
