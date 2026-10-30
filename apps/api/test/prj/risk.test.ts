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
import { ProjectRiskController, ProjectRiskReadsController } from '../../src/modules/prj/risk.controller';
import { PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const NEXT_MONTH = vietnamDateOf(new Date(Date.now() + 30 * 86_400_000));
const LAST_WEEK = vietnamDateOf(new Date(Date.now() - 7 * 86_400_000));
const MANAGER = 1; // project.risk.manage and project.create on the whole tenant
const OWNER = 2; // project.read on the department: able to follow its projects
const READER = 3; // project.read on the whole tenant, no right over risks
const BRANCH_MANAGER = 4; // project.read on the whole tenant, project.risk.manage on another branch only
const OUTSIDER = 5; // project.read and project.risk.manage on another branch only
const OWNER_ELSEWHERE = 6; // project.read on another branch: cannot follow the projects of the department
const B_MANAGER = 21; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Cell {
  likelihood: number;
  impact: number;
  score: number;
  level: string;
  count: number;
}

interface Line {
  id: string;
  code: string;
  score: number;
  level: string;
  status: string;
  overdue: boolean;
  owner: { membership_id: string; display_name: string | null };
  version: number;
  closed_reason: string | null;
}

describe('the risks of a project (ST-PRJ-010, BR-PRJ-07, PRJ-16)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  let area = '';
  let category = '';
  let retiredCategory = '';
  let expiredCategory = '';
  let futureCategory = '';

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
  const items = (reply: Reply): Line[] => reply.json.items as Line[];

  async function seedMaster(tenant: string, type: string, key: string, status: string, window: { from?: string; until?: string | null } = {}): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $4, $3, $5, $6, $6)`, [tenant, recordId, key, type, status, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $4, $3, 1, $3, '{}'::jsonb, $7::date, 'EFFECTIVE', $5, now(), $6, $6)`,
        [tenant, versionId, key, type, recordId, memberId(1), window.from ?? '2020-01-01'],
      ],
    ]);
    return versionId;
  }

  async function project(unit = DEPARTMENT): Promise<{ id: string; code: string }> {
    counter += 1;
    const code = `RK-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', { member: MANAGER, body: { code, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(unit), area_master_version_id: area, total_investment_vnd: '500000000000' } });
    expect(made.status).toBe(200);
    return { id: idOf(made), code };
  }

  let riskCounter = 0;
  let issueCounter = 0;
  const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    riskCounter += 1;
    return {
      code: `R-${riskCounter}-${randomUUID().slice(0, 4)}`,
      category_master_version_id: category,
      title: 'Giải phóng mặt bằng chậm',
      description: 'Hộ dân chưa nhận tiền bồi thường',
      likelihood: 4,
      impact: 5,
      owner_membership_id: memberId(OWNER),
      mitigation: 'Họp dân hằng tuần',
      due_date: NEXT_MONTH,
      ...extra,
    };
  };
  const register = (member: number, target: { id: string }, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/projects/${target.id}/risks`, { member, ...(tenantId === undefined ? {} : { tenantId }), body: entry(extra) });
  const update = (member: number, riskId: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/project-risks/${riskId}/update`, { member, ifMatch: `"${version}"`, body: entry(extra) });
  const close = (member: number, riskId: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/project-risks/${riskId}/closure`, { member, ifMatch: `"${version}"`, body: { status: 'CLOSED', closed_reason: 'Đã bàn giao mặt bằng đợt 1', ...extra } });
  const list = (member: number, target: { id: string }, query = '', tenantId?: string): Promise<Reply> => call('GET', `/projects/${target.id}/risks${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  async function issueOf(projectId: string): Promise<string> {
    issueCounter += 1;
    const issueId = randomUUID();
    const categoryRecord = randomUUID();
    const issueCategory = randomUUID();
    const policy = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, categoryRecord, `CAT-${issueId.slice(0, 8)}`, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, $4, '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $5, $5)`,
        [TENANT_A, issueCategory, categoryRecord, `CAT-${issueId.slice(0, 8)}`, memberId(1)],
      ],
      [
        `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, 1, $4, $5, 'HIGH', 'WORKDAY_VN', 4, 16, '2026-01-01', 'ACTIVE', $6, $6)`,
        [TENANT_A, policy, `SLA-${issueId.slice(0, 8)}`, issueCategory, categoryRecord, memberId(1)],
      ],
      [
        `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, reported_by, opened_at, response_due_at, due_at, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'HIGH', 'Vướng mặt bằng', 'Fixture', $6, $7, 'OPEN', 1, $8, now(), now() + interval '4 hours', now() + interval '30 days', $8, $8)`,
        [TENANT_A, issueId, `VM-2026-${String(800_000 + issueCounter)}`, projectId, issueCategory, unitId(DEPARTMENT), policy, memberId(1)],
      ],
    ]);
    return issueId;
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
    for (const n of [MANAGER, OWNER, READER, BRANCH_MANAGER, OUTSIDER, OWNER_ELSEWHERE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RISK_MANAGER', ['project.read', 'project.create', 'project.risk.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'RISK_MANAGER_ONLY', ['project.risk.manage'], 20);
    await harness.seedRole(TENANT_B, 1, 'RISK_MANAGER', ['project.read', 'project.create', 'project.risk.manage'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: BRANCH_MANAGER, role: 2, kind: 'TENANT' },
      { n: 5, member: BRANCH_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: OUTSIDER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 7, member: OUTSIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 8, member: OWNER_ELSEWHERE, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    area = await seedMaster(TENANT_A, 'AREA', 'TINH-R', 'EFFECTIVE');
    category = await seedMaster(TENANT_A, 'RISK_CATEGORY', 'LAND', 'EFFECTIVE');
    retiredCategory = await seedMaster(TENANT_A, 'RISK_CATEGORY', 'OLD', 'RETIRED');
    expiredCategory = await seedMaster(TENANT_A, 'RISK_CATEGORY', 'EXPIRED', 'EFFECTIVE');
    futureCategory = await seedMaster(TENANT_A, 'RISK_CATEGORY', 'FUTURE', 'EFFECTIVE', { from: NEXT_MONTH });
    await harness.owner(TENANT_A, [[`update machvon.master_record_version set valid_until = '2021-01-01' where id = $1::uuid`, [expiredCategory]]]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectRiskController, ProjectRiskReadsController],
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
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectRiskController, ProjectRiskReadsController]));
  });

  describe('registering a risk (AC-ST-PRJ-010-1)', () => {
    it('UAT-AC209: a risk of likelihood 4 and impact 5 scores 20, is critical, and is announced once as CRITICAL for the executive warnings', async () => {
      const target = await project();
      const reply = await register(MANAGER, target, { code: 'RK-20' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'OPEN', resource_version: 1, score: 20, level: 'CRITICAL', project_id: target.id });
      expect(await rows('select score::int as score, status, owner_membership_id, created_by, due_date::text as due_date from machvon.project_risk where id = $1::uuid', [idOf(reply)])).toEqual([
        { score: 20, status: 'OPEN', owner_membership_id: memberId(OWNER), created_by: memberId(MANAGER), due_date: NEXT_MONTH },
      ]);
      const audit = await rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>(`select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = 'project.risk_registered'`, [idOf(reply)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(MANAGER), safe_diff: { project_id: target.id, code: 'RK-20', status: 'OPEN', score: 20, severity: 'CRITICAL' } });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.risk_registered.v1' and aggregate_id = $1`, [idOf(reply)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, actor_id: memberId(MANAGER), risk_id: idOf(reply), code: 'RK-20', score: 20, severity: 'CRITICAL', likelihood: 4, impact: 5, owner_membership_id: memberId(OWNER) }));
    });

    it('scores the bands by the server: 1 to 5 low, 6 to 14 medium, 15 and more critical; the score is not taken from the client', async () => {
      const target = await project();
      const low = await register(MANAGER, target, { likelihood: 1, impact: 5 });
      const medium = await register(MANAGER, target, { likelihood: 2, impact: 3 });
      const edge = await register(MANAGER, target, { likelihood: 3, impact: 5 });
      expect([low, medium, edge].map((reply) => [reply.json.score, reply.json.level])).toEqual([[5, 'LOW'], [6, 'MEDIUM'], [15, 'CRITICAL']]);
      const severities = await rows<{ severity: string }>(`select payload->>'severity' as severity from machvon.outbox_event where type = 'project.risk_registered.v1' and aggregate_id = any($1::uuid[]) order by (payload->>'score')::int`, [[idOf(low), idOf(medium), idOf(edge)]]);
      expect(severities.map((row) => row.severity)).toEqual(['LOW', 'MEDIUM', 'CRITICAL']);
      const sent = await register(MANAGER, target, { score: 1 });
      expect(sent.status).toBe(400);
    });

    it('writes the code once for a project: a second risk with it is 409 RISK_CODE_DUPLICATE, another project may use it, and two at once are one 200 and one 409', async () => {
      const target = await project();
      const other = await project();
      expect((await register(MANAGER, target, { code: 'SAME' })).status).toBe(200);
      const again = await register(MANAGER, target, { code: 'SAME' });
      expect([again.status, again.json.code]).toEqual([409, 'RISK_CODE_DUPLICATE']);
      expect((await register(MANAGER, other, { code: 'SAME' })).status).toBe(200);
      const [first, second] = await Promise.all([register(MANAGER, target, { code: 'RACE' }), register(MANAGER, target, { code: 'RACE' })]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect(await rows('select 1 from machvon.project_risk where project_id = $1::uuid and code = $2', [target.id, 'RACE'])).toHaveLength(1);
    });

    it('refuses what is not a risk: a scale out of 1 to 5, words too short, a code that is not one, a day that is not real, a status the register does not write with', async () => {
      const target = await project();
      const fields: Array<[string, Record<string, unknown>]> = [
        ['likelihood', { likelihood: 6 }],
        ['impact', { impact: 0 }],
        ['title', { title: 'ab' }],
        ['mitigation', { mitigation: '  ' }],
        ['code', { code: '-x' }],
        ['due_date', { due_date: '2026-02-30' }],
      ];
      for (const [field, extra] of fields) {
        const reply = await register(MANAGER, target, extra);
        expect([reply.status, reply.json.code, (reply.json as { field?: string }).field ?? field]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      expect((await register(MANAGER, target, { status: 'CLOSED' })).status).toBeGreaterThanOrEqual(400);
      expect(await rows('select 1 from machvon.project_risk where project_id = $1::uuid', [target.id])).toHaveLength(0);
    });

    it('takes a group of risks that is in use, an owner who can follow the project, and an issue of the same project, and says which of them is wrong', async () => {
      const target = await project();
      const other = await project();
      const wrongType = await register(MANAGER, target, { category_master_version_id: area });
      const retired = await register(MANAGER, target, { category_master_version_id: retiredCategory });
      const unknown = await register(MANAGER, target, { category_master_version_id: randomUUID() });
      const expired = await register(MANAGER, target, { category_master_version_id: expiredCategory });
      const future = await register(MANAGER, target, { category_master_version_id: futureCategory });
      for (const reply of [wrongType, retired, unknown, expired, future]) expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const elsewhere = await register(MANAGER, target, { owner_membership_id: memberId(OWNER_ELSEWHERE) });
      const nobody = await register(MANAGER, target, { owner_membership_id: randomUUID() });
      const otherTenant = await register(MANAGER, target, { owner_membership_id: memberId(B_MANAGER) });
      for (const reply of [elsewhere, nobody, otherTenant]) expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const foreignIssue = await issueOf(other.id);
      const wrongIssue = await register(MANAGER, target, { linked_issue_id: foreignIssue });
      const missingIssue = await register(MANAGER, target, { linked_issue_id: randomUUID() });
      for (const reply of [wrongIssue, missingIssue]) expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const issue = await issueOf(target.id);
      const linked = await register(MANAGER, target, { linked_issue_id: issue });
      expect(linked.status).toBe(200);
      expect(await rows('select linked_issue_id from machvon.project_risk where id = $1::uuid', [idOf(linked)])).toEqual([{ linked_issue_id: issue }]);
      expect(await rows('select 1 from machvon.project_risk where project_id = $1::uuid', [other.id])).toHaveLength(0);
    });
  });

  describe('who may manage the risks of a project', () => {
    it('is 403 SCOPE_DENIED for a caller who can read the project but not manage its risks, whatever the reason, and 404 where they cannot see it', async () => {
      const target = await project();
      const reader = await register(READER, target);
      expect([reader.status, reader.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const branch = await register(BRANCH_MANAGER, target);
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const outsider = await register(OUTSIDER, target);
      expect(outsider.status).toBe(404);
      const foreign = await register(B_MANAGER, target, {}, TENANT_B);
      expect(foreign.status).toBe(404);
      expect(await rows('select 1 from machvon.project_risk where project_id = $1::uuid', [target.id])).toHaveLength(0);
    });

    it('answers the same for a risk that exists: 403 SCOPE_DENIED to someone who reads its project, 404 to someone who cannot see it, and nothing changes', async () => {
      const target = await project();
      const made = await register(MANAGER, target);
      const before = await rows('select * from machvon.project_risk where id = $1::uuid', [idOf(made)]);
      const denied = await update(BRANCH_MANAGER, idOf(made), 1);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await close(BRANCH_MANAGER, idOf(made), 1)).status).toBe(403);
      expect((await update(OUTSIDER, idOf(made), 1)).status).toBe(404);
      expect((await close(OUTSIDER, idOf(made), 1)).status).toBe(404);
      expect((await call('POST', `/project-risks/${idOf(made)}/update`, { member: B_MANAGER, tenantId: TENANT_B, ifMatch: '"1"', body: entry() })).status).toBe(404);
      expect((await update(MANAGER, randomUUID(), 1)).status).toBe(404);
      expect(await rows('select * from machvon.project_risk where id = $1::uuid', [idOf(made)])).toEqual(before);
    });
  });

  describe('updating a risk', () => {
    it('rewrites the assessment under the version the caller saw, scores it again, and leaves the audit row and the event of the same transaction', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'UPD', likelihood: 2, impact: 2 });
      const changed = await update(MANAGER, idOf(made), 1, { code: 'UPD', likelihood: 5, impact: 4, mitigation: 'Cấp thêm kinh phí bồi thường' });
      expect(changed.status).toBe(200);
      expect(changed.json).toMatchObject({ status: 'OPEN', resource_version: 2, score: 20, level: 'CRITICAL' });
      expect(await rows('select likelihood::int as likelihood, impact::int as impact, score::int as score, mitigation, version::int as version, updated_by from machvon.project_risk where id = $1::uuid', [idOf(made)])).toEqual([
        { likelihood: 5, impact: 4, score: 20, mitigation: 'Cấp thêm kinh phí bồi thường', version: 2, updated_by: memberId(MANAGER) },
      ]);
      const audit = await rows<{ safe_diff: { changed: string[]; score: number; previous_status: string } }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.risk_updated'`, [idOf(made)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff.score).toBe(20);
      expect([...(audit[0]?.safe_diff.changed ?? [])].sort()).toEqual(['impact', 'likelihood', 'mitigation']);
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.risk_updated.v1' and aggregate_id = $1`, [idOf(made)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual(expect.objectContaining({ risk_id: idOf(made), risk_version: 2, score: 20, severity: 'CRITICAL' }));
    });

    it('is 409 VERSION_CONFLICT for a version that is not the current one, and writes nothing', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'VER' });
      expect((await update(MANAGER, idOf(made), 1, { code: 'VER', title: 'Tiêu đề mới của rủi ro' })).status).toBe(200);
      const stale = await update(MANAGER, idOf(made), 1, { code: 'VER', title: 'Tiêu đề muộn hơn' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await rows<{ title: string }>('select title from machvon.project_risk where id = $1::uuid', [idOf(made)]))[0]?.title).toBe('Tiêu đề mới của rủi ro');
    });

    it('leaves the status where it is when none is sent, moves it on towards escalation, and never back (409 RISK_STATE_INVALID)', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'MOVE' });
      const kept = await update(MANAGER, idOf(made), 1, { code: 'MOVE' });
      expect(kept.json.status).toBe('OPEN');
      const mitigating = await update(MANAGER, idOf(made), 2, { code: 'MOVE', status: 'MITIGATING' });
      expect(mitigating.json).toMatchObject({ status: 'MITIGATING', resource_version: 3 });
      const silent = await update(MANAGER, idOf(made), 3, { code: 'MOVE' });
      expect(silent.json.status).toBe('MITIGATING');
      const escalated = await update(MANAGER, idOf(made), 4, { code: 'MOVE', status: 'ESCALATED' });
      expect(escalated.json.status).toBe('ESCALATED');
      for (const back of ['MITIGATING', 'OPEN']) {
        const refused = await update(MANAGER, idOf(made), 5, { code: 'MOVE', status: back });
        expect([refused.status, refused.json.code]).toEqual([409, 'RISK_STATE_INVALID']);
      }
      expect((await rows<{ status: string; version: number }>('select status, version::int as version from machvon.project_risk where id = $1::uuid', [idOf(made)]))[0]).toEqual({ status: 'ESCALATED', version: 5 });
    });

    it('renames the code only to one that is free inside the project (409 RISK_CODE_DUPLICATE) and keeps its own code without complaint', async () => {
      const target = await project();
      const first = await register(MANAGER, target, { code: 'ONE' });
      await register(MANAGER, target, { code: 'TWO' });
      const taken = await update(MANAGER, idOf(first), 1, { code: 'TWO' });
      expect([taken.status, taken.json.code]).toEqual([409, 'RISK_CODE_DUPLICATE']);
      const renamed = await update(MANAGER, idOf(first), 1, { code: 'THREE' });
      expect(renamed.status).toBe(200);
      expect((await update(MANAGER, idOf(first), 2, { code: 'THREE', title: 'Tiêu đề khác của rủi ro' })).status).toBe(200);
    });

    it('does not ask again for an owner or a group the risk already holds: a risk can be corrected and closed after its owner lost the project', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'LOSS' });
      await harness.owner(TENANT_A, [[`update machvon.membership set status = 'Suspended' where id = $1`, [memberId(OWNER)]]]);
      try {
        expect((await update(MANAGER, idOf(made), 1, { code: 'LOSS', title: 'Tiêu đề sửa lại cho rủi ro' })).status).toBe(200);
        const swapped = await update(MANAGER, idOf(made), 2, { code: 'LOSS', owner_membership_id: memberId(OWNER_ELSEWHERE) });
        expect([swapped.status, swapped.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect((await close(MANAGER, idOf(made), 2)).status).toBe(200);
      } finally {
        await harness.owner(TENANT_A, [[`update machvon.membership set status = 'Active' where id = $1`, [memberId(OWNER)]]]);
      }
    });
  });

  describe('ending a risk', () => {
    it('closes a risk with the reason, which the audit row keeps, and a risk that has ended is not changed, closed or updated again', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'END' });
      const closed = await close(MANAGER, idOf(made), 1);
      expect(closed.json).toMatchObject({ status: 'CLOSED', resource_version: 2 });
      expect(await rows('select status, closed_reason, version::int as version from machvon.project_risk where id = $1::uuid', [idOf(made)])).toEqual([{ status: 'CLOSED', closed_reason: 'Đã bàn giao mặt bằng đợt 1', version: 2 }]);
      const audit = await rows<{ reason: string | null; safe_diff: { previous_status: string } }>(`select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.risk_closed'`, [idOf(made)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: 'Đã bàn giao mặt bằng đợt 1', safe_diff: { previous_status: 'OPEN' } });
      for (const reply of [await close(MANAGER, idOf(made), 2), await update(MANAGER, idOf(made), 2, { code: 'END' })]) expect([reply.status, reply.json.code]).toEqual([409, 'RISK_STATE_INVALID']);
    });

    it('accepts a risk as it is with a reason, and refuses a reason that is not one, a status that is not an end, and a stale version', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'ACC' });
      for (const reason of ['ngắn', ' '.repeat(12), 'x'.repeat(2001)]) {
        const refused = await close(MANAGER, idOf(made), 1, { closed_reason: reason });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      expect((await close(MANAGER, idOf(made), 1, { status: 'OPEN' })).status).toBeGreaterThanOrEqual(400);
      const stale = await close(MANAGER, idOf(made), 7, { status: 'ACCEPTED' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const accepted = await close(MANAGER, idOf(made), 1, { status: 'ACCEPTED', closed_reason: 'Rủi ro nằm trong mức chấp nhận được' });
      expect(accepted.json.status).toBe('ACCEPTED');
    });

    it('is kept by the database as well: an ended risk cannot be written, a live one cannot go back, a reason is only on an ended risk, and no one deletes a risk', async () => {
      const target = await project();
      const made = await register(MANAGER, target, { code: 'DB' });
      const attempt = async (sql: string, params: unknown[] = [idOf(made)]): Promise<string> => {
        try {
          await rows(sql, params);
          return 'written';
        } catch (error) {
          return (error as { message: string }).message;
        }
      };
      expect(await attempt(`update machvon.project_risk set closed_reason = 'Một lý do đủ dài' where id = $1::uuid`)).toContain('project_risk');
      expect(await attempt(`update machvon.project_risk set status = 'CLOSED' where id = $1::uuid`)).toContain('project_risk');
      await update(MANAGER, idOf(made), 1, { code: 'DB', status: 'MITIGATING' });
      expect(await attempt(`update machvon.project_risk set status = 'OPEN' where id = $1::uuid`)).toContain('earlier status');
      await close(MANAGER, idOf(made), 2);
      expect(await attempt(`update machvon.project_risk set title = 'Tiêu đề bị sửa lại' where id = $1::uuid`)).toContain('never changed');
      expect(await attempt(`update machvon.project_risk set project_id = $2::uuid where id = $1::uuid`, [idOf(made), randomUUID()])).not.toBe('written');
    });
  });

  describe('reading the register', () => {
    it('lists the risks of the project with the highest score first, with the level, the owner and the overdue flag, and the live risks by likelihood and impact', async () => {
      const target = await project();
      const critical = await register(MANAGER, target, { code: 'A-CRIT', likelihood: 5, impact: 5 });
      await register(MANAGER, target, { code: 'B-MED', likelihood: 2, impact: 3 });
      await register(MANAGER, target, { code: 'C-MED', likelihood: 2, impact: 3, due_date: LAST_WEEK });
      const ended = await register(MANAGER, target, { code: 'D-END', likelihood: 4, impact: 4 });
      expect((await close(MANAGER, idOf(ended), 1)).status).toBe(200);
      const reply = await list(READER, target);
      expect(reply.status).toBe(200);
      expect(items(reply).map((line) => [line.code, line.score, line.level, line.status, line.overdue])).toEqual([
        ['A-CRIT', 25, 'CRITICAL', 'OPEN', false],
        ['D-END', 16, 'CRITICAL', 'CLOSED', false],
        ['C-MED', 6, 'MEDIUM', 'OPEN', true],
        ['B-MED', 6, 'MEDIUM', 'OPEN', false],
      ]);
      expect(items(reply)[0]).toMatchObject({ id: idOf(critical), owner: { membership_id: memberId(OWNER), display_name: expect.any(String) } });
      expect(reply.json).toMatchObject({ live_count: 3, critical_count: 1, overdue_count: 1, next_cursor: null, as_of: TODAY });
      const matrix = reply.json.matrix as Cell[];
      expect(matrix).toHaveLength(25);
      expect(matrix.every((cell) => cell.score === cell.likelihood * cell.impact && cell.level === (cell.score >= 15 ? 'CRITICAL' : cell.score >= 6 ? 'MEDIUM' : 'LOW'))).toBe(true);
      expect(matrix.filter((cell) => cell.count > 0)).toEqual([
        { likelihood: 2, impact: 3, score: 6, level: 'MEDIUM', count: 2 },
        { likelihood: 5, impact: 5, score: 25, level: 'CRITICAL', count: 1 },
      ]);
    });

    it('filters by status, cuts pages with a cursor that gives each risk once, and keeps the matrix whole whatever the page and the filter', async () => {
      const target = await project();
      for (let n = 1; n <= 5; n += 1) await register(MANAGER, target, { code: `P-${n}`, likelihood: n, impact: 1 });
      const closed = await register(MANAGER, target, { code: 'P-END', likelihood: 1, impact: 1 });
      await close(MANAGER, idOf(closed), 1);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 6; page += 1) {
        const reply = await list(MANAGER, target, `?limit=2${cursor === '' ? '' : `&cursor=${cursor}`}`);
        expect(reply.json.live_count).toBe(5);
        seen.push(...items(reply).map((line) => line.code));
        if (reply.json.next_cursor === null) break;
        cursor = encodeURIComponent(reply.json.next_cursor as string);
      }
      expect(seen).toEqual(['P-5', 'P-4', 'P-3', 'P-2', 'P-1', 'P-END']);
      const onlyClosed = await list(MANAGER, target, '?status=CLOSED');
      expect(items(onlyClosed).map((line) => line.code)).toEqual(['P-END']);
      expect(onlyClosed.json.live_count).toBe(5);
      const refused = await list(MANAGER, target, '?status=LOST');
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await list(MANAGER, target, '?limit=0')).status).toBe(422);
    });

    it('is 404 for a project the caller cannot read and for one of another tenant, and holds nothing for a project with no risk', async () => {
      const target = await project();
      expect((await list(OUTSIDER, target)).status).toBe(404);
      expect((await list(B_MANAGER, target, '', TENANT_B)).status).toBe(404);
      expect((await call('GET', `/projects/${randomUUID()}/risks`, { member: MANAGER })).status).toBe(404);
      const empty = await list(READER, target);
      expect(empty.json).toMatchObject({ items: [], live_count: 0, critical_count: 0, overdue_count: 0, next_cursor: null });
      expect((empty.json.matrix as Cell[]).filter((cell) => cell.count > 0)).toEqual([]);
      expect(empty.json.matrix).toHaveLength(25);
    });
  });
});
