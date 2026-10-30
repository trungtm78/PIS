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
import { ProjectRevisionController, ProjectRevisionReadsController } from '../../src/modules/prj/revision.controller';
import { PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const INVESTOR = 1; // project.revision.propose and project.create on the whole tenant
const APPROVER = 2; // project.revision.approve on the whole tenant
const READER = 3; // project.read on the whole tenant
const BOTH = 4; // proposes and approves on the whole tenant
const BRANCH_APPROVER = 5; // project.read on the whole tenant, project.revision.approve on another branch only
const OUTSIDER = 6; // project.read and project.revision.approve on another branch only
const B_INVESTOR = 21; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const AUTHORITY = 4; // a unit that decides on projects
const DISSOLVED = 5; // a unit that is no longer in force
const LATER_DISSOLVED = 6; // a unit that is dissolved while a revision waits

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Line {
  id: string;
  revision: number;
  change_kind: string;
  status: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  total_investment_vnd: string | null;
  decision_reason: string | null;
  decision_document: { id: string; title: string; symbol: string | null; issued_on: string | null } | null;
  effective_from: string | null;
  supersedes_id: string | null;
  created_by: { membership_id: string; display_name: string | null };
  decided_by: { membership_id: string } | null;
  version: number;
}

describe('the revisions of a project (ST-PRJ-008, PRJ 3.1 F6, PRJ-06)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  let area = '';
  const cache = new InMemoryPipelineCache();

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
  const items = (reply: Reply): Line[] => reply.json.items as Line[];

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

  async function document(status = 'EFFECTIVE'): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'Decision on the adjustment', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
      [TENANT_A, documentId, `QD-${documentId.slice(0, 8)}/2026`, status, memberId(1)],
    );
    return documentId;
  }

  /** A project made through the register, brought to a stage that takes revisions. */
  async function project(options: { status?: string; total?: string; authority?: boolean } = {}): Promise<{ id: string; code: string }> {
    counter += 1;
    const code = `RV-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', {
      member: INVESTOR,
      body: {
        code,
        name: 'Dự án cầu Thủ Thiêm 4',
        owner_unit_id: unitId(DEPARTMENT),
        area_master_version_id: area,
        total_investment_vnd: options.total ?? '45000000000',
        start_year: 2026,
        end_year: 2028,
        ...(options.authority === true ? { decision_authority_unit_id: unitId(AUTHORITY) } : {}),
      },
    });
    expect(made.status).toBe(200);
    const projectId = idOf(made);
    const status = options.status ?? 'IMPLEMENTATION';
    const grouped = !['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'].includes(status);
    await rows(`update machvon.project set status = $2, project_group = case when $3::boolean then 'B' else project_group end where id = $1::uuid`, [projectId, status, grouped]);
    return { id: projectId, code };
  }

  const projectRow = async (projectId: string) =>
    (await rows<{ total: string; start_year: number | null; end_year: number | null; investor_unit_id: string | null; version: string }>(
      'select total_investment_vnd::text as total, start_year, end_year, investor_unit_id, version::text as version from machvon.project where id = $1::uuid',
      [projectId],
    ))[0]!;
  const propose = (member: number, target: { id: string }, body: Record<string, unknown>, version: number | string = 1): Promise<Reply> =>
    call('POST', `/projects/${target.id}/revisions`, { member, ifMatch: version, body: { change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '55000000000', reason: 'The cost of the site clearance went up', ...body } });
  const decide = (member: number, revisionId: string, body: Record<string, unknown>, version: number | string = 1): Promise<Reply> =>
    call('POST', `/project-revisions/${revisionId}/decision`, { member, ifMatch: version, body: { decision: 'approve', reason: 'Approved by the people committee', effective_from: TODAY, ...body } });
  const history = (member: number, target: { id: string }, tenantId?: string): Promise<Reply> => call('GET', `/projects/${target.id}/revisions`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
        { n: AUTHORITY, path: `/${unitId(AUTHORITY)}/` },
        { n: DISSOLVED, path: `/${unitId(DISSOLVED)}/` },
        { n: LATER_DISSOLVED, path: `/${unitId(LATER_DISSOLVED)}/` },
      ]);
    }
    for (const n of [INVESTOR, APPROVER, READER, BOTH, BRANCH_APPROVER, OUTSIDER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_INVESTOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'INVESTOR', ['project.read', 'project.create', 'project.revision.propose'], 40);
    await harness.seedRole(TENANT_A, 2, 'APPROVER', ['project.read', 'project.revision.approve'], 40);
    await harness.seedRole(TENANT_A, 3, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'BOTH', ['project.read', 'project.revision.propose', 'project.revision.approve'], 40);
    await harness.seedRole(TENANT_A, 5, 'ELSEWHERE_ONLY', ['project.revision.approve', 'project.revision.propose'], 20);
    await harness.seedRole(TENANT_B, 1, 'INVESTOR', ['project.read', 'project.create', 'project.revision.propose', 'project.revision.approve'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: INVESTOR, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: BOTH, role: 4, kind: 'TENANT' },
      { n: 5, member: BRANCH_APPROVER, role: 3, kind: 'TENANT' },
      { n: 6, member: BRANCH_APPROVER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 7, member: OUTSIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 8, member: OUTSIDER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_INVESTOR, role: 1, kind: 'TENANT' }]);
    await harness.owner(TENANT_A, [[`update machvon.organization_unit set status = 'Dissolved' where id = $1::uuid`, [unitId(DISSOLVED)]]]);
    area = await seedMaster(TENANT_A, 'AREA', 'TINH-V');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectRevisionController, ProjectRevisionReadsController],
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
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectRevisionController, ProjectRevisionReadsController]));
  });

  describe('proposing (AC-ST-PRJ-008-2)', () => {
    it('writes the revision IN_REVIEW with what the project holds and what it would hold, leaves the project as it is, and audits it', async () => {
      const target = await project();
      const reply = await propose(INVESTOR, target, {});
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 1, revision: 2, project_id: target.id, project_version: 1 });
      expect(await rows('select change_kind, before_json, after_json, total_investment_vnd::text as total, status, created_by, reason from machvon.project_revision where id = $1::uuid', [idOf(reply)])).toEqual([
        {
          change_kind: 'ADJUST_INVESTMENT',
          before_json: { total_investment_vnd: '45000000000' },
          after_json: { total_investment_vnd: '55000000000' },
          total: '55000000000',
          status: 'IN_REVIEW',
          created_by: memberId(INVESTOR),
          reason: 'The cost of the site clearance went up',
        },
      ]);
      expect((await projectRow(target.id)).total).toBe('45000000000');
      const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string }>(`select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = 'project.revision_proposed'`, [idOf(reply)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(INVESTOR), safe_diff: { project_id: target.id, code: target.code, revision: 2, change_kind: 'ADJUST_INVESTMENT', status: 'IN_REVIEW' } });
    });

    it('AC-ST-PRJ-008-2, UAT-PLAN-57: another revision is 409 REVISION_PENDING_EXISTS while one waits, and may be proposed once it is decided; two at once are one 200 and one 409', async () => {
      const target = await project();
      const first = await propose(INVESTOR, target, {});
      const second = await propose(INVESTOR, target, { total_investment_vnd: '60000000000' });
      expect([second.status, second.json.code]).toEqual([409, 'REVISION_PENDING_EXISTS']);
      expect((await decide(APPROVER, idOf(first), { decision: 'reject', reason: 'Not justified enough', effective_from: undefined })).status).toBe(200);
      const third = await propose(INVESTOR, target, { total_investment_vnd: '60000000000' });
      expect(third.status).toBe(200);
      expect(third.json.revision).toBe(3);
      const other = await project();
      const [one, two] = await Promise.all([propose(INVESTOR, other, {}), propose(INVESTOR, other, { total_investment_vnd: '70000000000' })]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(await rows(`select 1 from machvon.project_revision where project_id = $1::uuid and status = 'IN_REVIEW'`, [other.id])).toHaveLength(1);
    });

    it('moves the schedule, the scope and the investor unit, each with the fields it changes, and refuses a proposal that changes nothing or names a field that is not its own', async () => {
      const target = await project();
      const refused = async (body: Record<string, unknown>) => {
        const reply = await propose(INVESTOR, target, body);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      };
      await refused({ change_kind: 'ADJUST_INVESTMENT', total_investment_vnd: '45000000000' });
      await refused({ change_kind: 'ADJUST_INVESTMENT', total_investment_vnd: '1.5' });
      await refused({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2028 } });
      await refused({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2025 } });
      await refused({ change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, total_investment_vnd: '1' });
      await refused({ change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'short' } });
      await refused({ change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: randomUUID() } });
      await refused({ reason: 'short' });
      expect((await propose(INVESTOR, target, { change_kind: 'BOGUS' })).status).toBeGreaterThanOrEqual(400);
      expect(await rows('select 1 from machvon.project_revision where project_id = $1::uuid and change_kind <> $2', [target.id, 'INITIAL'])).toHaveLength(0);
      const schedule = await propose(INVESTOR, target, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, total_investment_vnd: undefined });
      expect(schedule.status).toBe(200);
      expect(await rows('select before_json, after_json, total_investment_vnd::text as total from machvon.project_revision where id = $1::uuid', [idOf(schedule)])).toEqual([
        { before_json: { end_year: 2028 }, after_json: { end_year: 2030 }, total: '45000000000' },
      ]);
    });

    it('is refused in a stage that takes no revision (409 STAGE_TRANSITION_DENIED), under a stale version (409 VERSION_CONFLICT), and writes nothing', async () => {
      for (const status of ['CONCEPT', 'APPRAISAL', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED']) {
        const target = await project({ status });
        const reply = await propose(INVESTOR, target, {});
        expect([status, reply.status, reply.json.code]).toEqual([status, 409, 'STAGE_TRANSITION_DENIED']);
      }
      const target = await project();
      const stale = await propose(INVESTOR, target, {}, 7);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      for (const status of ['PIPELINE', 'BUDGETED', 'SUSPENDED', 'COMPLETED']) {
        const open = await project({ status });
        expect((await propose(INVESTOR, open, {})).status).toBe(200);
      }
    });

    it('is 403 SCOPE_DENIED where the caller reads the project but may not propose, 404 where they cannot see it', async () => {
      const target = await project();
      const reader = await propose(READER, target, {});
      expect([reader.status, reader.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await propose(OUTSIDER, target, {})).status).toBe(404);
      const foreign = await call('POST', `/projects/${target.id}/revisions`, { member: B_INVESTOR, tenantId: TENANT_B, ifMatch: 1, body: { change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '1', reason: 'A reason of ten letters' } });
      expect(foreign.status).toBe(404);
      expect(await rows(`select 1 from machvon.project_revision where project_id = $1::uuid and change_kind <> 'INITIAL'`, [target.id])).toHaveLength(0);
    });
  });

  describe('deciding against the project as it is when it is decided', () => {
    it('refuses to approve once the project has gone to a stage that takes no revision (409 STAGE_TRANSITION_DENIED), and still lets the revision be rejected', async () => {
      const target = await project({ status: 'COMPLETED' });
      const revision = await propose(INVESTOR, target, {});
      await rows(`update machvon.project set status = 'SETTLED' where id = $1::uuid`, [target.id]);
      const approved = await decide(APPROVER, idOf(revision), { decision_document_id: await document() });
      expect([approved.status, approved.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await projectRow(target.id)).total).toBe('45000000000');
      expect((await decide(APPROVER, idOf(revision), { decision: 'reject', reason: 'The project is settled', effective_from: undefined })).status).toBe(200);
    });

    it('refuses to approve a revision whose old content is no longer what the project holds (409 VERSION_CONFLICT): a transfer, a profile change or an earlier adjustment moved it while the revision waited', async () => {
      const investor = await project();
      const toInvestor = await propose(INVESTOR, investor, { change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: unitId(ELSEWHERE) }, total_investment_vnd: undefined });
      await rows(`update machvon.project set investor_unit_id = $2::uuid, version = version + 1 where id = $1::uuid`, [investor.id, unitId(AUTHORITY)]);
      const stale = await decide(APPROVER, idOf(toInvestor), { decision_document_id: await document() });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await projectRow(investor.id)).investor_unit_id).toBe(unitId(AUTHORITY));
      const money = await project();
      const toTotal = await propose(INVESTOR, money, {});
      await rows(`update machvon.project set total_investment_vnd = 46000000000, version = version + 1 where id = $1::uuid`, [money.id]);
      expect((await decide(APPROVER, idOf(toTotal), { decision_document_id: await document() })).json.code).toBe('VERSION_CONFLICT');
      const years = await project();
      const toYears = await propose(INVESTOR, years, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, total_investment_vnd: undefined });
      await rows(`update machvon.project set end_year = 2029, version = version + 1 where id = $1::uuid`, [years.id]);
      expect((await decide(APPROVER, idOf(toYears), { decision_document_id: await document() })).json.code).toBe('VERSION_CONFLICT');
      expect(await rows(`select status from machvon.project_revision where id = any($1::uuid[]) order by status`, [[idOf(toInvestor), idOf(toTotal), idOf(toYears)]])).toEqual([{ status: 'IN_REVIEW' }, { status: 'IN_REVIEW' }, { status: 'IN_REVIEW' }]);
    });

    it('takes an investor unit that is in force, when it is proposed and when it is approved', async () => {
      const target = await project();
      const refused = await propose(INVESTOR, target, { change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: unitId(DISSOLVED) }, total_investment_vnd: undefined });
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const revision = await propose(INVESTOR, target, { change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: unitId(LATER_DISSOLVED) }, total_investment_vnd: undefined });
      expect(revision.status).toBe(200);
      await rows(`update machvon.organization_unit set status = 'Dissolved' where id = $1::uuid`, [unitId(LATER_DISSOLVED)]);
      const late = await decide(APPROVER, idOf(revision), { decision_document_id: await document() });
      expect([late.status, late.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await projectRow(target.id)).investor_unit_id).toBeNull();
    });
  });

  describe('deciding (AC-ST-PRJ-008-1)', () => {
    it('UAT-AC214: approving without a decision document is 422 DECISION_REQUIRED; with one the revision is APPROVED, the one approved before is SUPERSEDED and the total of the project follows', async () => {
      const target = await project();
      // The revision approved before: the first adjustment.
      const first = await propose(INVESTOR, target, { total_investment_vnd: '50000000000' });
      const firstDocument = await document();
      expect((await decide(APPROVER, idOf(first), { decision_document_id: firstDocument })).status).toBe(200);
      const second = await propose(INVESTOR, target, { total_investment_vnd: '55000000000' }, 2);
      const missing = await decide(APPROVER, idOf(second), {});
      expect([missing.status, missing.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      expect((await projectRow(target.id)).total).toBe('50000000000');
      const documentId = await document();
      const approved = await decide(APPROVER, idOf(second), { decision_document_id: documentId });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2, revision: 3, project_version: 3 });
      expect(await projectRow(target.id)).toMatchObject({ total: '55000000000', version: '3' });
      expect(await rows('select revision, status, supersedes_id, decision_document_id, effective_from::text as effective_from, decided_by, decision_reason from machvon.project_revision where project_id = $1::uuid and change_kind <> $2 order by revision', [target.id, 'INITIAL'])).toEqual([
        { revision: 2, status: 'SUPERSEDED', supersedes_id: null, decision_document_id: firstDocument, effective_from: TODAY, decided_by: memberId(APPROVER), decision_reason: 'Approved by the people committee' },
        { revision: 3, status: 'APPROVED', supersedes_id: idOf(first), decision_document_id: documentId, effective_from: TODAY, decided_by: memberId(APPROVER), decision_reason: 'Approved by the people committee' },
      ]);
      const audit = await rows<{ reason: string | null; safe_diff: { status: string; superseded_revision_id: string | null; decision_document_id: string } }>(`select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.revision_decided'`, [idOf(second)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: 'Approved by the people committee', safe_diff: { status: 'APPROVED', superseded_revision_id: idOf(first), decision_document_id: documentId } });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.revised.v1' and aggregate_id = $1 order by created_at`, [target.id]);
      expect(events).toHaveLength(2);
      expect(events[1]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, version: 3, revision_id: idOf(second), revision: 3, change_kind: 'ADJUST_INVESTMENT', total_investment_vnd: '55000000000', decision_document_id: documentId, supersedes_revision_id: idOf(first) }));
    });

    it('applies a schedule revision to the years and an investor revision to the unit, and leaves the total and the other figures alone; a scope revision is only recorded', async () => {
      const target = await project();
      const schedule = await propose(INVESTOR, target, { change_kind: 'ADJUST_SCHEDULE', after: { start_year: 2027, end_year: 2031 }, total_investment_vnd: undefined });
      expect((await decide(APPROVER, idOf(schedule), { decision_document_id: await document() })).status).toBe(200);
      expect(await projectRow(target.id)).toMatchObject({ total: '45000000000', start_year: 2027, end_year: 2031, investor_unit_id: null });
      const investor = await propose(INVESTOR, target, { change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: unitId(ELSEWHERE) }, total_investment_vnd: undefined }, 2);
      expect((await decide(APPROVER, idOf(investor), { decision_document_id: await document() })).status).toBe(200);
      expect(await projectRow(target.id)).toMatchObject({ total: '45000000000', start_year: 2027, end_year: 2031, investor_unit_id: unitId(ELSEWHERE), version: '3' });
      const scope = await propose(INVESTOR, target, { change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'Add a pedestrian bridge on the north bank' }, total_investment_vnd: undefined }, 3);
      expect((await decide(APPROVER, idOf(scope), { decision_document_id: await document() })).status).toBe(200);
      expect(await projectRow(target.id)).toMatchObject({ total: '45000000000', version: '4' });
      expect(await rows(`select status from machvon.project_revision where project_id = $1::uuid and change_kind <> 'INITIAL' order by revision`, [target.id])).toEqual([{ status: 'SUPERSEDED' }, { status: 'SUPERSEDED' }, { status: 'APPROVED' }]);
    });

    it('rejects with a reason, leaving the project and the revision approved before as they were, with or without a document', async () => {
      const target = await project();
      const revision = await propose(INVESTOR, target, {});
      const rejected = await decide(APPROVER, idOf(revision), { decision: 'reject', reason: 'The estimate is not supported', effective_from: undefined, decision_document_id: await document() });
      expect(rejected.json).toMatchObject({ status: 'REJECTED', project_version: 1 });
      expect(await projectRow(target.id)).toMatchObject({ total: '45000000000', version: '1' });
      expect(await rows('select status, decision_reason, effective_from from machvon.project_revision where id = $1::uuid', [idOf(revision)])).toEqual([{ status: 'REJECTED', decision_reason: 'The estimate is not supported', effective_from: null }]);
      expect(await rows(`select 1 from machvon.outbox_event where type = 'project.revised.v1' and aggregate_id = $1`, [target.id])).toHaveLength(0);
      const again = await decide(APPROVER, idOf(revision), { decision: 'reject', reason: 'Rejected once more', effective_from: undefined }, 2);
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const other = await propose(INVESTOR, target, {});
      expect((await decide(APPROVER, idOf(other), { decision: 'reject', reason: 'Rejected without a document', effective_from: undefined })).status).toBe(200);
    });

    it('refuses the day, the document and the decision when they are not valid, and writes nothing', async () => {
      const target = await project();
      const revision = await propose(INVESTOR, target, {});
      const documentId = await document();
      for (const extra of [{ effective_from: undefined }, { effective_from: '2026-02-30' }, { effective_from: vietnamDateOf(new Date(Date.now() + 3 * 86_400_000)) }, { decision: 'approve', reason: 'No' }, { decision: 'return' }]) {
        const reply = await decide(APPROVER, idOf(revision), { decision_document_id: documentId, ...extra });
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      for (const bad of [await document('RECALLED'), await document('EXPIRED'), randomUUID()]) {
        const reply = await decide(APPROVER, idOf(revision), { decision_document_id: bad });
        expect([reply.status, reply.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      }
      const reject = await decide(APPROVER, idOf(revision), { decision: 'reject', reason: 'Rejected for a day', effective_from: TODAY });
      expect([reject.status, reject.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(await rows('select status from machvon.project_revision where id = $1::uuid', [idOf(revision)])).toEqual([{ status: 'IN_REVIEW' }]);
      expect((await projectRow(target.id)).total).toBe('45000000000');
    });

    it('is 403 SELF_APPROVAL_DENIED to the one who proposed it, 409 VERSION_CONFLICT for a stale version, and 403/404 outside the scope of the decider', async () => {
      const target = await project();
      const revision = await propose(BOTH, target, {});
      const documentId = await document();
      const self = await decide(BOTH, idOf(revision), { decision_document_id: documentId });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const stale = await decide(APPROVER, idOf(revision), { decision_document_id: documentId }, 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const branch = await decide(BRANCH_APPROVER, idOf(revision), { decision_document_id: documentId });
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await decide(OUTSIDER, idOf(revision), { decision_document_id: documentId })).status).toBe(404);
      expect((await call('POST', `/project-revisions/${idOf(revision)}/decision`, { member: B_INVESTOR, tenantId: TENANT_B, ifMatch: 1, body: { decision: 'reject', reason: 'A foreign decision attempt' } })).status).toBe(404);
      expect((await decide(APPROVER, randomUUID(), { decision_document_id: documentId })).status).toBe(404);
      expect(await rows('select status from machvon.project_revision where id = $1::uuid', [idOf(revision)])).toEqual([{ status: 'IN_REVIEW' }]);
    });

    it('asks a project with a deciding authority for the right over that unit: a decider who holds it elsewhere only is 403 SCOPE_DENIED', async () => {
      const target = await project({ authority: true });
      const revision = await propose(INVESTOR, target, {});
      const reply = await decide(APPROVER, idOf(revision), { decision_document_id: await document() });
      expect([reply.status, reply.json.code]).toEqual([200, undefined]);
      const guarded = await project({ authority: true });
      await harness.seedGrants(TENANT_A, [{ n: 20, member: BRANCH_APPROVER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] }]);
      const pending = await propose(INVESTOR, guarded, {});
      const denied = await decide(BRANCH_APPROVER, idOf(pending), { decision_document_id: await document() });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });

    it('is kept by the database as well: a decided revision keeps what it proposed and its decision, a rejected one never changes, and no one deletes a revision', async () => {
      const target = await project();
      const revision = await propose(INVESTOR, target, {});
      const attempt = async (sql: string, params: unknown[] = [idOf(revision)]): Promise<string> => {
        try {
          await rows(sql, params);
          return 'written';
        } catch (error) {
          return (error as { message: string }).message;
        }
      };
      expect(await attempt(`update machvon.project_revision set reason = 'Another reason entirely' where id = $1::uuid`)).toContain('keeps what it proposed');
      expect(await attempt(`update machvon.project_revision set status = 'SUPERSEDED' where id = $1::uuid`)).toContain('only an approved revision is superseded');
      expect(await attempt(`update machvon.project_revision set status = 'APPROVED' where id = $1::uuid`)).toContain('project_revision');
      await decide(APPROVER, idOf(revision), { decision_document_id: await document() });
      expect(await attempt(`update machvon.project_revision set effective_from = '2020-01-01' where id = $1::uuid`)).toContain('can only be superseded');
      expect(await attempt(`update machvon.project_revision set status = 'IN_REVIEW' where id = $1::uuid`)).toContain('can only be superseded');
      const second = await propose(INVESTOR, target, { total_investment_vnd: '66000000000' }, 2);
      await decide(APPROVER, idOf(second), { decision: 'reject', reason: 'Rejected for the test', effective_from: undefined });
      expect(await attempt(`update machvon.project_revision set decision_reason = 'Changed my mind' where id = $1::uuid`, [idOf(second)])).toContain('never changed');
    });
  });

  describe('reading the history', () => {
    it('lists the revisions of the project, the latest first, with before and after, the document that grounds each, who proposed and decided, and the total held now', async () => {
      const target = await project();
      const first = await propose(INVESTOR, target, { total_investment_vnd: '50000000000' });
      const documentId = await document();
      await decide(APPROVER, idOf(first), { decision_document_id: documentId });
      const second = await propose(INVESTOR, target, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 }, total_investment_vnd: undefined }, 2);
      const reply = await history(READER, target);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ current_total_investment_vnd: '50000000000', as_of: TODAY });
      const lines = items(reply);
      expect(lines.map((line) => [line.revision, line.change_kind, line.status])).toEqual([
        [3, 'ADJUST_SCHEDULE', 'IN_REVIEW'],
        [2, 'ADJUST_INVESTMENT', 'APPROVED'],
        [1, 'INITIAL', 'DRAFT'],
      ]);
      expect(lines[0]).toMatchObject({ id: idOf(second), before: { end_year: 2028 }, after: { end_year: 2030 }, decision_document: null, decided_by: null, effective_from: null });
      expect(lines[1]).toMatchObject({
        before: { total_investment_vnd: '45000000000' },
        after: { total_investment_vnd: '50000000000' },
        total_investment_vnd: '50000000000',
        decision_reason: 'Approved by the people committee',
        decision_document: { id: documentId, title: 'Decision on the adjustment', issued_on: '2026-01-15' },
        effective_from: TODAY,
        created_by: { membership_id: memberId(INVESTOR), display_name: expect.any(String) },
        decided_by: { membership_id: memberId(APPROVER) },
      });
      expect(lines[2]?.after).toMatchObject({ total_investment_vnd: '45000000000' });
    });

    it('never cuts the history: a project with hundreds of rejected proposals still shows its approved revision and its document', async () => {
      const target = await project();
      const first = await propose(INVESTOR, target, {});
      await decide(APPROVER, idOf(first), { decision_document_id: await document() });
      await rows(
        `insert into machvon.project_revision (tenant_id, id, project_id, revision, change_kind, before_json, after_json, total_investment_vnd, reason, status, decided_by, decided_at, decision_reason, created_by, updated_by)
         select $1, gen_random_uuid(), $2::uuid, 100 + n, 'ADJUST_SCOPE', '{}'::jsonb, '{"scope_summary": "A scope that was rejected"}'::jsonb, 55000000000, 'A proposal that was rejected', 'REJECTED', $4::uuid, now(), 'Not justified', $3::uuid, $3::uuid
           from generate_series(1, 230) as n`,
        [TENANT_A, target.id, memberId(INVESTOR), memberId(APPROVER)],
      );
      const reply = await history(READER, target);
      expect(items(reply)).toHaveLength(232);
      expect(items(reply).filter((line) => line.status === 'APPROVED' && line.decision_document !== null)).toHaveLength(1);
      expect(items(reply)[231]?.change_kind).toBe('INITIAL');
    });

    it('is 404 for a project the caller cannot read, of another tenant, or that does not exist', async () => {
      const target = await project();
      expect((await history(OUTSIDER, target)).status).toBe(404);
      expect((await history(B_INVESTOR, target, TENANT_B)).status).toBe(404);
      expect((await call('GET', `/projects/${randomUUID()}/revisions`, { member: READER })).status).toBe(404);
    });
  });
});
