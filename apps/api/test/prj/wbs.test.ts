import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { ProjectWbsController, ProjectWbsReadsController } from '../../src/modules/prj/wbs.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const dayFrom = (offset: number): string => vietnamDateOf(new Date(Date.now() + offset * 86_400_000));
const MANAGER = 1; // project.update and project.create on the whole tenant
const READER = 2; // project.read on the whole tenant
const BRANCH_MANAGER = 3; // project.read on the whole tenant, project.update on another branch only
const OUTSIDER = 4; // project.read and project.update on another branch only
const B_MANAGER = 21; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Milestone {
  id: string;
  code: string;
  component: { id: string; code: string; name: string } | null;
  baseline_date: string;
  planned_date: string;
  actual_date: string | null;
  depends_on: { id: string; code: string } | null;
  status: string;
  reason: string | null;
  delay_days: number;
  delayed: boolean;
  version: number;
}

interface Component {
  id: string;
  parent_component_id: string | null;
  code: string;
  planned_value_vnd: string;
  depth: number;
}

describe('the work breakdown and the milestones of a project (ST-PRJ-009, BR-PRJ-08, PRJ-05, PRJ-07)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  let area = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedMaster(tenant: string, type: string, key: string): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $4, $3, 'EFFECTIVE', $5, $5)`, [tenant, recordId, key, type, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $4, $3, 1, $3, '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $5, now(), $6, $6)`,
        [tenant, versionId, key, type, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function project(total = '45000000000', status = 'IMPLEMENTATION'): Promise<{ id: string; code: string }> {
    counter += 1;
    const code = `WB-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', { member: MANAGER, body: { code, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: area, total_investment_vnd: total } });
    expect(made.status).toBe(200);
    const grouped = !['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'].includes(status);
    await rows(`update machvon.project set status = $2, project_group = case when $3::boolean then 'B' else project_group end where id = $1::uuid`, [idOf(made), status, grouped]);
    return { id: idOf(made), code };
  }

  let componentCounter = 0;
  const addComponent = (member: number, target: { id: string }, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> => {
    componentCounter += 1;
    return call('POST', `/projects/${target.id}/components`, {
      member,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { code: `C-${componentCounter}-${randomUUID().slice(0, 4)}`, name: 'Gói xây lắp chính', planned_value_vnd: '10000000000', valid_from: '2026-01-01', ...extra },
    });
  };
  let milestoneCounter = 0;
  const addMilestone = (member: number, target: { id: string }, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> => {
    milestoneCounter += 1;
    return call('POST', `/projects/${target.id}/milestones`, {
      member,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { code: `M-${milestoneCounter}-${randomUUID().slice(0, 4)}`, name: 'Khởi công công trình', baseline_date: '2026-02-15', planned_date: '2026-02-15', ...extra },
    });
  };
  const progress = (member: number, milestoneId: string, body: Record<string, unknown>, version: number | string = 1): Promise<Reply> =>
    call('POST', `/project-milestones/${milestoneId}/progress`, { member, ifMatch: version, body });
  const depend = (member: number, milestoneId: string, dependsOn: string | null, version: number | string = 1): Promise<Reply> =>
    call('POST', `/project-milestones/${milestoneId}/dependency`, { member, ifMatch: version, body: { depends_on_milestone_id: dependsOn } });
  const components = async (member: number, target: { id: string }, tenantId?: string): Promise<Reply> => call('GET', `/projects/${target.id}/components`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const milestones = async (member: number, target: { id: string }, tenantId?: string): Promise<Reply> => call('GET', `/projects/${target.id}/milestones`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const milestoneItems = (reply: Reply): Milestone[] => reply.json.items as Milestone[];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MANAGER, READER, BRANCH_MANAGER, OUTSIDER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLANNER', ['project.read', 'project.create', 'project.update'], 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'UPDATER_ONLY', ['project.update'], 20);
    await harness.seedRole(TENANT_B, 1, 'PLANNER', ['project.read', 'project.create', 'project.update'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: BRANCH_MANAGER, role: 2, kind: 'TENANT' },
      { n: 4, member: BRANCH_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 5, member: OUTSIDER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: OUTSIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    area = await seedMaster(TENANT_A, 'AREA', 'TINH-W');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWbsController, ProjectWbsReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_PIPELINE_CACHE, useValue: new InMemoryPipelineCache() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectWbsController, ProjectWbsReadsController]));
  });

  describe('the work breakdown', () => {
    it('UAT-AC218: a component that takes the first level to 48 billion of 45 is accepted and answered with the warning WBS_EXCEEDS_TOTAL; the figures stay what they were', async () => {
      const target = await project();
      expect((await addComponent(MANAGER, target, { code: 'C1', planned_value_vnd: '30000000000' })).json.warnings).toEqual([]);
      expect((await addComponent(MANAGER, target, { code: 'C2', planned_value_vnd: '10000000000' })).json.warnings).toEqual([]);
      const third = await addComponent(MANAGER, target, { code: 'C3', planned_value_vnd: '8000000000' });
      expect(third.status).toBe(200);
      expect(third.json).toMatchObject({ status: 'ACTIVE', project_id: target.id, warnings: [{ code: 'WBS_EXCEEDS_TOTAL', wbs_total_vnd: '48000000000', project_total_vnd: '45000000000' }] });
      expect((third.json.warnings as Array<{ code: string }>)[0]?.code).toBe('WBS_EXCEEDS_TOTAL');
      const read = await components(READER, target);
      expect(read.json).toMatchObject({ wbs_total_vnd: '48000000000', project_total_vnd: '45000000000', exceeds_total: true, as_of: TODAY });
      expect((read.json.items as Component[]).map((line) => [line.code, line.planned_value_vnd, line.depth])).toEqual([['C1', '30000000000', 1], ['C2', '10000000000', 1], ['C3', '8000000000', 1]]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.component_added'`, [idOf(third)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ project_id: target.id, code: 'C3', exceeds_total: true });
    });

    it('counts only the first level against the total: a child adds no value to the sum, and the sum fits when it is no more than the total', async () => {
      const target = await project();
      const parent = await addComponent(MANAGER, target, { code: 'P', planned_value_vnd: '45000000000' });
      expect(parent.json.warnings).toEqual([]);
      const child = await addComponent(MANAGER, target, { code: 'P1', planned_value_vnd: '40000000000', parent_component_id: idOf(parent) });
      expect(child.json.warnings).toEqual([]);
      const read = await components(READER, target);
      expect(read.json).toMatchObject({ wbs_total_vnd: '45000000000', exceeds_total: false });
    });

    it('lists the tree in order, each component under its parent, by place then code, with its depth; a depth beyond the limit and a parent of another project are refused', async () => {
      const target = await project();
      const root = await addComponent(MANAGER, target, { code: 'B-ROOT', sort_order: 2, planned_value_vnd: '1' });
      const first = await addComponent(MANAGER, target, { code: 'A-ROOT', sort_order: 1, planned_value_vnd: '1' });
      const child = await addComponent(MANAGER, target, { code: 'CHILD', parent_component_id: idOf(first), planned_value_vnd: '1' });
      let deepest = child;
      for (let level = 3; level <= 6; level += 1) deepest = await addComponent(MANAGER, target, { code: `L${level}`, parent_component_id: idOf(deepest), planned_value_vnd: '1' });
      expect(deepest.status).toBe(200);
      const tooDeep = await addComponent(MANAGER, target, { code: 'L7', parent_component_id: idOf(deepest), planned_value_vnd: '1' });
      expect([tooDeep.status, tooDeep.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const other = await project();
      const foreignParent = await addComponent(MANAGER, other, { code: 'X', parent_component_id: idOf(root), planned_value_vnd: '1' });
      expect([foreignParent.status, foreignParent.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const unknownParent = await addComponent(MANAGER, other, { code: 'Y', parent_component_id: randomUUID(), planned_value_vnd: '1' });
      expect(unknownParent.status).toBe(422);
      const read = await components(READER, target);
      expect((read.json.items as Component[]).map((line) => [line.code, line.depth])).toEqual([['A-ROOT', 1], ['CHILD', 2], ['L3', 3], ['L4', 4], ['L5', 5], ['L6', 6], ['B-ROOT', 1]]);
    });

    it('keeps the descendants of a component under it when the codes of its brothers start with the same letters', async () => {
      const target = await project();
      const first = await addComponent(MANAGER, target, { code: 'A', planned_value_vnd: '1' });
      await addComponent(MANAGER, target, { code: 'A1', planned_value_vnd: '1' });
      await addComponent(MANAGER, target, { code: 'CHILD', parent_component_id: idOf(first), planned_value_vnd: '1' });
      const read = await components(READER, target);
      expect((read.json.items as Component[]).map((line) => line.code)).toEqual(['A', 'CHILD', 'A1']);
    });

    it('writes the code once for a project (409 COMPONENT_CODE_DUPLICATE), lets another project use it, and refuses what is not a component', async () => {
      const target = await project();
      const other = await project();
      expect((await addComponent(MANAGER, target, { code: 'SAME' })).status).toBe(200);
      const again = await addComponent(MANAGER, target, { code: 'SAME' });
      expect([again.status, again.json.code]).toEqual([409, 'COMPONENT_CODE_DUPLICATE']);
      expect((await addComponent(MANAGER, other, { code: 'SAME' })).status).toBe(200);
      const [one, two] = await Promise.all([addComponent(MANAGER, target, { code: 'RACE' }), addComponent(MANAGER, target, { code: 'RACE' })]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      for (const extra of [{ code: '-x' }, { name: 'x' }, { planned_value_vnd: '-1' }, { planned_value_vnd: '1.5' }, { valid_from: '2026-02-30' }, { sort_order: -1 }]) {
        const refused = await addComponent(MANAGER, target, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });
  });

  describe('the milestones', () => {
    it('UAT-AC218: marking a milestone DONE without the day it was done is 422 on actual_date; with it the milestone is late by the days from its baseline (15) and the screen reads DELAYED', async () => {
      const target = await project();
      const start = await addMilestone(MANAGER, target, { code: 'M-KC', baseline_date: '2026-02-15', planned_date: '2026-02-15' });
      const finish = await addMilestone(MANAGER, target, { code: 'M-HT', baseline_date: '2026-12-31', planned_date: '2026-12-31' });
      const missing = await progress(MANAGER, idOf(finish), { status: 'DONE' });
      expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(await rows('select status, actual_date from machvon.project_milestone where id = $1::uuid', [idOf(finish)])).toEqual([{ status: 'PLANNED', actual_date: null }]);
      const done = await progress(MANAGER, idOf(start), { status: 'DONE', actual_date: '2026-03-02' });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DONE', resource_version: 2, delay_days: 15, delayed: true, project_id: target.id });
      const read = milestoneItems(await milestones(READER, target));
      const line = read.find((item) => item.code === 'M-KC');
      expect(line).toMatchObject({ status: 'DONE', baseline_date: '2026-02-15', actual_date: '2026-03-02', delay_days: 15, delayed: true });
      expect(read.find((item) => item.code === 'M-HT')).toMatchObject({ status: 'PLANNED', delay_days: 0, delayed: false });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.milestone_updated.v1' and aggregate_id = $1`, [idOf(start)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, milestone_id: idOf(start), status: 'DONE', actual_date: '2026-03-02', delay_days: 15 }));
    });

    it('counts the delay of an open milestone from its baseline to its planned day, or to today once that day has passed', async () => {
      const target = await project();
      await addMilestone(MANAGER, target, { code: 'FUTURE', baseline_date: dayFrom(10), planned_date: dayFrom(14) });
      await addMilestone(MANAGER, target, { code: 'OVERDUE', baseline_date: dayFrom(-10), planned_date: dayFrom(-5) });
      await addMilestone(MANAGER, target, { code: 'EARLY', baseline_date: dayFrom(10), planned_date: dayFrom(5) });
      const byCode = new Map(milestoneItems(await milestones(READER, target)).map((item) => [item.code, item]));
      expect(byCode.get('FUTURE')).toMatchObject({ delay_days: 4, delayed: true });
      expect(byCode.get('OVERDUE')).toMatchObject({ delay_days: 10, delayed: true });
      expect(byCode.get('EARLY')).toMatchObject({ delay_days: 0, delayed: false });
    });

    it('delays a milestone to a later day with a reason (the baseline stays), cancels one with a reason, and moves a milestone that is done or cancelled no more (409 MILESTONE_STATE_INVALID)', async () => {
      const target = await project();
      const baseline = dayFrom(-60);
      const milestone = await addMilestone(MANAGER, target, { baseline_date: baseline, planned_date: baseline });
      const noReason = await progress(MANAGER, idOf(milestone), { status: 'DELAYED', planned_date: dayFrom(20) });
      expect([noReason.status, noReason.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const earlier = await progress(MANAGER, idOf(milestone), { status: 'DELAYED', planned_date: dayFrom(-70), reason: 'Site clearance is late' });
      expect([earlier.status, earlier.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const delayed = await progress(MANAGER, idOf(milestone), { status: 'DELAYED', planned_date: dayFrom(20), reason: 'Site clearance is late' });
      expect(delayed.json).toMatchObject({ status: 'DELAYED', resource_version: 2, delay_days: 80, delayed: true });
      expect(await rows('select baseline_date::text as baseline, planned_date::text as planned, status_reason from machvon.project_milestone where id = $1::uuid', [idOf(milestone)])).toEqual([
        { baseline, planned: dayFrom(20), status_reason: 'Site clearance is late' },
      ]);
      const audit = await rows<{ reason: string | null; safe_diff: Record<string, unknown> }>(`select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.milestone_progress'`, [idOf(milestone)]);
      const waiting = await addMilestone(MANAGER, target, { baseline_date: baseline, planned_date: baseline, depends_on_milestone_id: idOf(milestone) });
      await progress(MANAGER, idOf(waiting), { status: 'CANCELLED', reason: 'The works were dropped' });
      const unchanged = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.milestone_progress'`, [idOf(waiting)]);
      expect(unchanged[0]?.safe_diff).toMatchObject({ depends_on_milestone_id: idOf(milestone), previous_depends_on_milestone_id: idOf(milestone) });
      expect(audit[0]).toMatchObject({ reason: 'Site clearance is late', safe_diff: { status: 'DELAYED', previous_status: 'PLANNED', planned_date: dayFrom(20), previous_planned_date: baseline } });
      const again = await progress(MANAGER, idOf(milestone), { status: 'DELAYED', planned_date: dayFrom(50), reason: 'Still waiting for the permit' }, 2);
      expect(again.json.status).toBe('DELAYED');
      const cancelled = await progress(MANAGER, idOf(milestone), { status: 'CANCELLED', reason: 'The works were dropped' }, 3);
      expect(cancelled.json).toMatchObject({ status: 'CANCELLED', delay_days: 0, delayed: false });
      for (const body of [{ status: 'DONE', actual_date: TODAY }, { status: 'CANCELLED', reason: 'Cancelled twice' }]) {
        const refused = await progress(MANAGER, idOf(milestone), body, 4);
        expect([refused.status, refused.json.code]).toEqual([409, 'MILESTONE_STATE_INVALID']);
      }
    });

    it('is 409 VERSION_CONFLICT for a stale version and refuses a day in the future for a milestone done', async () => {
      const target = await project();
      const milestone = await addMilestone(MANAGER, target);
      const stale = await progress(MANAGER, idOf(milestone), { status: 'DONE', actual_date: TODAY }, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const future = await progress(MANAGER, idOf(milestone), { status: 'DONE', actual_date: dayFrom(3) });
      expect([future.status, future.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await progress(MANAGER, idOf(milestone), { status: 'DONE', actual_date: TODAY })).status).toBe(200);
    });

    it('UAT-PLAN-58: a dependency that would form a loop is 409 DEPENDENCY_CYCLE and the dependencies stay as they were; others are saved, and can be cleared', async () => {
      const target = await project();
      const m1 = await addMilestone(MANAGER, target, { code: 'M1' });
      const m2 = await addMilestone(MANAGER, target, { code: 'M2', depends_on_milestone_id: idOf(m1) });
      const m3 = await addMilestone(MANAGER, target, { code: 'M3', depends_on_milestone_id: idOf(m2) });
      const cycle = await depend(MANAGER, idOf(m1), idOf(m3));
      expect([cycle.status, cycle.json.code]).toEqual([409, 'DEPENDENCY_CYCLE']);
      const self = await depend(MANAGER, idOf(m2), idOf(m2));
      expect([self.status, self.json.code]).toEqual([409, 'DEPENDENCY_CYCLE']);
      const links = async () => (await rows<{ code: string; dep: string | null }>('select m.code, d.code as dep from machvon.project_milestone m left join machvon.project_milestone d on d.id = m.depends_on_milestone_id where m.project_id = $1::uuid order by m.code', [target.id])).filter((row) => row.dep !== null);
      expect(await links()).toEqual([{ code: 'M2', dep: 'M1' }, { code: 'M3', dep: 'M2' }]);
      expect((await rows<{ version: string }>('select version::text as version from machvon.project_milestone where id = $1::uuid', [idOf(m1)]))[0]?.version).toBe('1');
      const moved = await depend(MANAGER, idOf(m3), idOf(m1));
      expect(moved.status).toBe(200);
      expect(await links()).toEqual([{ code: 'M2', dep: 'M1' }, { code: 'M3', dep: 'M1' }]);
      const cleared = await depend(MANAGER, idOf(m3), null, 2);
      expect(cleared.status).toBe(200);
      expect(await links()).toEqual([{ code: 'M2', dep: 'M1' }]);
      const read = milestoneItems(await milestones(READER, target));
      expect(read.find((item) => item.code === 'M2')?.depends_on).toMatchObject({ id: idOf(m1), code: 'M1' });
      expect(read.find((item) => item.code === 'M3')?.depends_on).toBeNull();
      const foreign = await depend(MANAGER, idOf(m3), randomUUID(), 3);
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('writes the code once for a project (409 MILESTONE_CODE_DUPLICATE), keeps the component and the dependency inside the project, and refuses what is not a milestone', async () => {
      const target = await project();
      const other = await project();
      const component = await addComponent(MANAGER, target, { code: 'COMP' });
      const foreignComponent = await addComponent(MANAGER, other, { code: 'COMP' });
      const foreignMilestone = await addMilestone(MANAGER, other, { code: 'OTHER' });
      expect((await addMilestone(MANAGER, target, { code: 'SAME', component_id: idOf(component) })).status).toBe(200);
      const again = await addMilestone(MANAGER, target, { code: 'SAME' });
      expect([again.status, again.json.code]).toEqual([409, 'MILESTONE_CODE_DUPLICATE']);
      for (const extra of [{ component_id: idOf(foreignComponent) }, { depends_on_milestone_id: idOf(foreignMilestone) }, { component_id: randomUUID() }, { code: '' }, { baseline_date: '2026-02-30' }, { planned_date: 'x' }]) {
        const refused = await addMilestone(MANAGER, target, { code: `X-${randomUUID().slice(0, 4)}`, ...extra });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const line = milestoneItems(await milestones(READER, target)).find((item) => item.code === 'SAME');
      expect(line?.component).toEqual({ id: idOf(component), code: 'COMP', name: 'Gói xây lắp chính' });
    });
  });

  describe('who may change them', () => {
    it('is 403 SCOPE_DENIED where the caller reads the project but may not update it, 404 where they cannot see it, in every command', async () => {
      const target = await project();
      const milestone = await addMilestone(MANAGER, target);
      for (const reply of [await addComponent(READER, target), await addMilestone(READER, target), await addComponent(BRANCH_MANAGER, target), await addMilestone(BRANCH_MANAGER, target), await progress(BRANCH_MANAGER, idOf(milestone), { status: 'CANCELLED', reason: 'Not allowed' }), await depend(BRANCH_MANAGER, idOf(milestone), null)]) {
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const reply of [await addComponent(OUTSIDER, target), await addMilestone(OUTSIDER, target), await progress(OUTSIDER, idOf(milestone), { status: 'CANCELLED', reason: 'Not allowed' }), await depend(OUTSIDER, idOf(milestone), null), await components(OUTSIDER, target), await milestones(OUTSIDER, target)]) {
        expect(reply.status).toBe(404);
      }
      expect((await addComponent(B_MANAGER, target, {}, TENANT_B)).status).toBe(404);
      expect((await milestones(B_MANAGER, target, TENANT_B)).status).toBe(404);
      expect((await progress(MANAGER, randomUUID(), { status: 'CANCELLED', reason: 'No such milestone' })).status).toBe(404);
      expect(await rows('select 1 from machvon.project_component where project_id = $1::uuid', [target.id])).toHaveLength(0);
      expect(await rows('select status from machvon.project_milestone where id = $1::uuid', [idOf(milestone)])).toEqual([{ status: 'PLANNED' }]);
    });

    it('takes no change to a project that is closed, rejected or cancelled (422 PROJECT_STAGE_INVALID), and an ended project still shows what it holds', async () => {
      for (const status of ['CLOSED', 'REJECTED', 'CANCELLED']) {
        const target = await project('45000000000', status);
        for (const reply of [await addComponent(MANAGER, target), await addMilestone(MANAGER, target)]) expect([status, reply.status, reply.json.code]).toEqual([status, 422, 'PROJECT_STAGE_INVALID']);
        expect((await components(READER, target)).status).toBe(200);
      }
    });
  });

  it('is kept by the database as well: a milestone keeps its baseline, a done one never changes, a loop cannot be written, and no one deletes a component or a milestone', async () => {
    const target = await project();
    const first = await addMilestone(MANAGER, target, { code: 'D1' });
    const second = await addMilestone(MANAGER, target, { code: 'D2', depends_on_milestone_id: idOf(first) });
    const attempt = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await rows(sql, params);
        return 'written';
      } catch (error) {
        return (error as { message: string }).message;
      }
    };
    expect(await attempt(`update machvon.project_milestone set baseline_date = '2020-01-01' where id = $1::uuid`, [idOf(first)])).toContain('keeps its project, code and baseline');
    expect(await attempt(`update machvon.project_milestone set depends_on_milestone_id = $2::uuid where id = $1::uuid`, [idOf(first), idOf(second)])).toContain('would form a loop');
    expect(await attempt(`update machvon.project_milestone set status = 'DONE' where id = $1::uuid`, [idOf(first)])).toContain('project_milestone');
    expect(await attempt(`update machvon.project_milestone set status = 'DELAYED' where id = $1::uuid`, [idOf(first)])).toContain('project_milestone');
    await progress(MANAGER, idOf(first), { status: 'DONE', actual_date: TODAY });
    expect(await attempt(`update machvon.project_milestone set name = 'Another name' where id = $1::uuid`, [idOf(first)])).toContain('never changed');
    const component = await addComponent(MANAGER, target);
    expect(await attempt(`update machvon.project_component set parent_component_id = id where id = $1::uuid`, [idOf(component)])).toContain('project_component_parent_chk');
    expect(await attempt(`update machvon.project_component set valid_until = '2000-01-01' where id = $1::uuid`, [idOf(component)])).toContain('project_component_period_chk');
  });
});
