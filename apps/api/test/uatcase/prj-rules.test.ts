import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ProjectAppraisalController } from '../../src/modules/prj/appraisal.controller';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { ProjectRiskController } from '../../src/modules/prj/risk.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from '../../src/modules/prj/stage.controller';
import { TaskForceController } from '../../src/modules/prj/task-force.controller';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(300_000);

/**
 * The PRJ cases of the UAT plan that had no script (docs/uat/prj): the stale and forbidden fields of a profile (UAT-AC201), the four eyes and the override of an appraisal
 * (UAT-AC203), the task force (UAT-AC211) and the walls between tenants (UAT-AC217). One embedded PostgreSQL, the real controllers.
 */
const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const WORKER = WORKER_MEMBERSHIP_ID;
const A_MAKER = 1; // creates, updates the profile, sends to appraisal: the proposer
const A_REVIEWER = 2; // scores
const A_APPROVER = 3; // decides
const A_ADMIN = 4; // manages the task forces
const FIELD_OFFICER = 5; // project.read on the department: the lead of the task force
const IN_SCOPE = 6; // project.read on the department
const A_OUTSIDER = 7; // a membership in the unit outside the scope of the task force
const B_MAKER = 21; // of tenant B: project.read and project.create
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WEIGHTS = [30, 25, 20, 15, 10];

describe('the PRJ cases of the UAT plan with a script of their own', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const versions: Record<string, string> = {};
  let criteria: { versionId: string; codes: string[] };

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; headers?: Record<string, string> }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', ...(options.headers ?? {}) };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedVersion(tenant: string, masterType: string, key: string, attributes: Record<string, unknown> = {}): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [tenant, recordId, masterType, key, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, $5::jsonb, '2020-01-01', null, 'EFFECTIVE', $6, now(), $7, $7)`,
        [tenant, versionId, masterType, key, JSON.stringify(attributes), recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function document(): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(1)],
    );
    return id;
  }

  async function project(options: { member?: number; tenantId?: string; unit?: number } = {}): Promise<{ id: string; code: string; version: number }> {
    counter += 1;
    const tenantId = options.tenantId ?? TENANT_A;
    const code = `UC-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', {
      member: options.member ?? A_MAKER,
      tenantId,
      body: { code, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(options.unit ?? DEPARTMENT), area_master_version_id: tenantId === TENANT_A ? versions.area : versions.areaB, total_investment_vnd: '500000000000' },
    });
    expect(made.status).toBe(200);
    return { id: idOf(made), code, version: 1 };
  }

  const profile = (member: number, projectId: string, version: number, body: Record<string, unknown>): Promise<Reply> => call('POST', `/projects/${projectId}/profile`, { member, ifMatch: `"${version}"`, body });
  const projectRow = async (projectId: string): Promise<Record<string, unknown>> => (await rows<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;
  const sheetRows = (projectId: string) => rows<Record<string, unknown>>('select * from machvon.project_appraisal where project_id = $1::uuid order by round, created_at, id', [projectId]);
  const audits = (action: string, resourceId: string) => rows<{ reason: string | null; safe_diff: Record<string, unknown>; outcome: string }>('select reason, safe_diff, outcome from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);

  const submitToAppraisal = async (target: { id: string; version: number }): Promise<{ id: string; version: number }> => {
    const sent = await call('POST', `/projects/${target.id}/appraisal-submissions`, { member: A_MAKER, ifMatch: `"${target.version}"`, body: { reason: 'Sent to appraisal with its proposal', policy_proposal_document_id: await document() } });
    expect(sent.status).toBe(200);
    return { id: target.id, version: sent.json.resource_version as number };
  };
  const scoresOf = (values: number[], codes = criteria.codes) => codes.map((criterion_code, index) => ({ criterion_code, score: values[index] }));
  const appraise = (target: { id: string }, member: number, body: Record<string, unknown>): Promise<Reply> => call('POST', `/projects/${target.id}/appraisals`, { member, body: { criteria_set_version_id: criteria.versionId, scores: scoresOf([4, 3, 5, 2, 4]), recommendation: 'ADMIT', ...body } });

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
    for (const n of [A_MAKER, A_REVIEWER, A_APPROVER, A_ADMIN, FIELD_OFFICER, IN_SCOPE, A_OUTSIDER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'MAKER', ['project.create', 'project.update', 'project.read', 'project.stage.submit', 'project.appraise'], 30);
    await harness.seedRole(TENANT_A, 2, 'REVIEWER', ['project.read', 'project.appraise'], 30);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['project.read', 'project.appraisal.decide'], 40);
    await harness.seedRole(TENANT_A, 4, 'ADMIN', ['project.read', 'project.create', 'taskforce.manage'], 40);
    await harness.seedRole(TENANT_A, 5, 'READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'B_MAKER', ['project.create', 'project.read', 'project.risk.manage'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: A_MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: A_REVIEWER, role: 2, kind: 'TENANT' },
      { n: 3, member: A_APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: A_ADMIN, role: 4, kind: 'TENANT' },
      { n: 5, member: FIELD_OFFICER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 6, member: IN_SCOPE, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 7, member: A_OUTSIDER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    versions.area = await seedVersion(TENANT_A, 'AREA', 'TINH-P');
    versions.areaB = await seedVersion(TENANT_B, 'AREA', 'TINH-P');
    const codes = WEIGHTS.map((_, index) => `C${index + 1}`);
    criteria = {
      versionId: await seedVersion(TENANT_A, 'APPRAISAL_CRITERIA', 'UAT-CRIT', { owner_module: 'PRJ', criteria: WEIGHTS.map((weight, index) => ({ code: codes[index], name: `Criterion ${index + 1}`, max_score: weight })), pass_threshold: 60 }),
      codes,
    };
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController, TaskForceController, ProjectRiskController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: { increment: () => undefined, gauge: () => undefined } },
        { provide: PRJ_PIPELINE_CACHE, useValue: new InMemoryPipelineCache() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('the checks of this suite can go red: a check fed a wrong answer on purpose throws', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'VERSION_CONFLICT'));
    expectCheckFails(() => assertStatus({ status: 404, json: { code: 'SCOPE_DENIED' } }, 404, 'RESOURCE_NOT_FOUND'));
  });

  it('UAT-AC201: a stale If-Match is 409 VERSION_CONFLICT with the current version, a body with status and tenant_id is 400 naming both, and the profile with the right version is 200 at version 5 with the status unchanged', async () => {
    const target = await project();
    for (const [version, name] of [[1, 'Tên hai'], [2, 'Tên ba'], [3, 'Tên bốn']] as const) expect((await profile(A_MAKER, target.id, version, { name })).status).toBe(200);
    expect((await projectRow(target.id)).version).toBe('4');
    const before = await projectRow(target.id);
    const stale = await profile(A_MAKER, target.id, 3, { name: 'Tên mới' });
    assertStatus(stale, 409, 'VERSION_CONFLICT');
    expect(stale.json.current_version).toBe(4);
    const forbidden = await profile(A_MAKER, target.id, 4, { name: 'Tên mới', status: 'IMPLEMENTATION', tenant_id: TENANT_B });
    assertStatus(forbidden, 400, 'FIELD_NOT_ALLOWED');
    expect(String(forbidden.json.detail)).toContain('status');
    expect(String(forbidden.json.detail)).toContain('tenant_id');
    expect(await projectRow(target.id)).toEqual(before);
    const done = await profile(A_MAKER, target.id, 4, { name: 'Tên mới' });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ resource_version: 5, status: 'CONCEPT' });
    expect(await projectRow(target.id)).toMatchObject({ name: 'Tên mới', status: 'CONCEPT', version: '5', tenant_id: TENANT_A });
  });

  it('UAT-AC203: the proposer scoring is 403 SELF_APPROVAL_DENIED, a sheet of 55.00 recommends REJECT under the threshold of 60, admitting against it needs an override reason, and with one the decision is 200 and the audit flags the override', async () => {
    const target = await submitToAppraisal(await project());
    const own = await appraise(target, A_MAKER, {});
    assertStatus(own, 403, 'SELF_APPROVAL_DENIED');
    expect(await sheetRows(target.id)).toEqual([]);
    const scored = await appraise(target, A_REVIEWER, { scores: scoresOf([3, 2, 3, 3, 3]), recommendation: 'REJECT' });
    assertStatus(scored, 200);
    expect(scored.json).toMatchObject({ status: 'SUBMITTED', total_score: '55.00' });
    const sheetId = idOf(scored);
    expect((await sheetRows(target.id))[0]).toMatchObject({ id: sheetId, total_score: '55.00', recommendation: 'REJECT' });
    const lifecycle = await call('GET', `/projects/${target.id}/lifecycle`, { member: A_APPROVER });
    expect((lifecycle.json.appraisal as Record<string, unknown>).summary).toMatchObject({ mean_score: '55.00', threshold_recommendation: 'REJECT', override_required: { ADMIT: true } });
    const decide = (body: Record<string, unknown>) => call('POST', `/project-appraisals/${sheetId}/decision`, { member: A_APPROVER, ifMatch: `"${scored.json.resource_version as number}"`, body: { decision: 'ADMIT', reason: 'Decided after the appraisal', project_group: 'B', ...body } });
    const decisionDocument = await document();
    const missing = await decide({ decision_document_id: decisionDocument });
    assertStatus(missing, 422, 'OVERRIDE_REASON_REQUIRED');
    expect((await sheetRows(target.id))[0]).toMatchObject({ status: 'SUBMITTED', decision: null });
    expect(await projectRow(target.id)).toMatchObject({ status: 'APPRAISAL' });
    const reason = 'The financing is secured by a decision of the province';
    expect(reason.length).toBeGreaterThanOrEqual(20);
    const admitted = await decide({ decision_document_id: decisionDocument, override_reason: reason });
    assertStatus(admitted, 200);
    expect(await projectRow(target.id)).toMatchObject({ status: 'PIPELINE', project_group: 'B' });
    expect((await audits('project.appraisal_decided', sheetId))[0]).toMatchObject({ outcome: 'SUCCESS', safe_diff: { decision: 'ADMIT', against_recommendation: true, override_reason: reason } });
  });

  it('scores 4,3,5,2,4 against weights 30/25/20/15/10 are 73.00 in numeric(5,2), weights adding up to 95 are 422 CRITERIA_WEIGHT_INVALID and a score of 6 is refused with 422 and nothing stored', async () => {
    const column = await rows<{ numeric_precision: number; numeric_scale: number }>("select numeric_precision, numeric_scale from information_schema.columns where table_schema = 'machvon' and table_name = 'project_appraisal' and column_name = 'total_score'");
    expect(column).toEqual([{ numeric_precision: 5, numeric_scale: 2 }]);
    const target = await submitToAppraisal(await project());
    const first = await appraise(target, A_REVIEWER, {});
    assertStatus(first, 200);
    expect(first.json.total_score).toBe('73.00');
    expect((await sheetRows(target.id)).map((sheet) => sheet.total_score)).toEqual(['73.00']);
    const broken = await seedVersion(TENANT_A, 'APPRAISAL_CRITERIA', `UAT-BAD-${randomUUID().slice(0, 6)}`, {
      criteria: [30, 25, 20, 15, 5].map((weight, index) => ({ code: criteria.codes[index], name: `Criterion ${index + 1}`, max_score: weight })),
      pass_threshold: 60,
    });
    const second = await submitToAppraisal(await project());
    assertStatus(await appraise(second, A_REVIEWER, { criteria_set_version_id: broken }), 422, 'CRITERIA_WEIGHT_INVALID');
    const third = await submitToAppraisal(await project());
    const outOfRange = await appraise(third, A_REVIEWER, { scores: scoresOf([6, 3, 5, 2, 4]) });
    // The request schema stops it before the rule does: 422 VALIDATION_FAILED on scores.score, not 422 SCORE_OUT_OF_RANGE on scores[0].score (the finding kept with UAT-AC204).
    assertStatus(outOfRange, 422);
    expect(await sheetRows(second.id)).toEqual([]);
    expect(await sheetRows(third.id)).toEqual([]);
  });

  it('UAT-AC211: a member outside the scope of the task force is 422 MEMBER_OUT_OF_SCOPE, a member of another tenant is 404 RESOURCE_NOT_FOUND, and dissolving ends every member on the day of the dissolution in one transaction', async () => {
    const created = await call('POST', '/task-forces', {
      member: A_ADMIN,
      body: {
        code: `TF-${randomUUID().slice(0, 6)}`,
        name: 'Disbursement task force of the department',
        purpose: 'Press the disbursement of the slow projects of the department',
        lead_membership_id: memberId(FIELD_OFFICER),
        scope_unit_id: unitId(DEPARTMENT),
        valid_from: '2026-01-05',
      },
    });
    assertStatus(created, 200);
    const forceId = idOf(created);
    const seat = (membershipId: string, tenantId?: string) => call('POST', `/task-forces/${forceId}/members`, { member: A_ADMIN, ...(tenantId === undefined ? {} : { tenantId }), body: { membership_id: membershipId, member_role: 'MEMBER', valid_from: '2026-01-05' } });
    const members = () => rows<{ membership_id: string; valid_until: string | null }>('select membership_id, valid_until::text as valid_until from machvon.task_force_member where task_force_id = $1::uuid', [forceId]);
    assertStatus(await seat(memberId(A_OUTSIDER)), 422, 'MEMBER_OUT_OF_SCOPE');
    const foreign = await seat(memberId(B_MAKER));
    assertStatus(foreign, 404, 'RESOURCE_NOT_FOUND');
    expect(await members()).toEqual([{ membership_id: memberId(FIELD_OFFICER), valid_until: null }]);
    const seated = await seat(memberId(IN_SCOPE));
    assertStatus(seated, 200);
    expect(await members()).toHaveLength(2);
    const dissolved = await call('POST', `/task-forces/${forceId}/dissolution`, { member: A_ADMIN, ifMatch: `"${seated.json.resource_version as number}"`, body: { reason: 'Hoàn thành nhiệm vụ' } });
    assertStatus(dissolved, 200);
    expect(dissolved.json).toMatchObject({ status: 'DISSOLVED' });
    expect(await rows('select status, valid_until::text as valid_until from machvon.task_force where id = $1::uuid', [forceId])).toEqual([{ status: 'DISSOLVED', valid_until: TODAY }]);
    expect((await members()).map((member) => member.valid_until)).toEqual([TODAY, TODAY]);
    const sameInstant = await rows<{ n: string }>(
      'select count(distinct updated_at)::text as n from (select updated_at from machvon.task_force where id = $1::uuid union all select updated_at from machvon.task_force_member where task_force_id = $1::uuid) x',
      [forceId],
    );
    expect(sameInstant).toEqual([{ n: '1' }]);
    expect((await audits('taskforce.dissolved', forceId))[0]).toMatchObject({ reason: 'Hoàn thành nhiệm vụ', safe_diff: { ended_members: 2 } });
  });

  it('UAT-AC217: a maker of tenant B gets 404 RESOURCE_NOT_FOUND for a project of tenant A on the read and on the risk register, a header naming tenant A changes nothing, row-level security returns no row, and the list holds only the projects of tenant B', async () => {
    const mine = await project({ member: A_MAKER });
    const other = await project({ member: A_ADMIN });
    const own = await project({ member: B_MAKER, tenantId: TENANT_B });
    const forgedHeader = { 'x-tenant-id': TENANT_A };
    assertStatus(await call('GET', `/resources/project/${mine.id}`, { member: B_MAKER, tenantId: TENANT_B }), 404, 'RESOURCE_NOT_FOUND');
    assertStatus(await call('GET', `/resources/project/${mine.id}`, { member: B_MAKER, tenantId: TENANT_B, headers: forgedHeader }), 404, 'RESOURCE_NOT_FOUND');
    const firstPage = await call('GET', '/resources/project?limit=1', { member: A_MAKER });
    const cursor = firstPage.json.next_cursor as string;
    expect(typeof cursor).toBe('string');
    const page = await call('GET', `/resources/project?limit=200&cursor=${encodeURIComponent(cursor)}`, { member: B_MAKER, tenantId: TENANT_B, headers: forgedHeader });
    assertStatus(page, 200);
    const codes = (page.json.items as Array<{ code: string }>).map((item) => item.code);
    expect(codes).not.toContain(mine.code);
    expect(codes).not.toContain(other.code);
    const everything = await call('GET', '/resources/project?limit=200', { member: B_MAKER, tenantId: TENANT_B, headers: forgedHeader });
    expect((everything.json.items as Array<{ code: string }>).map((item) => item.code)).toEqual([own.code]);
    const risk = await call('POST', `/projects/${mine.id}/risks`, {
      member: B_MAKER,
      tenantId: TENANT_B,
      body: { code: 'R-FOREIGN', category_master_version_id: randomUUID(), title: 'Giải phóng mặt bằng chậm', description: 'Hộ dân chưa nhận tiền bồi thường', likelihood: 4, impact: 5, owner_membership_id: memberId(B_MAKER), mitigation: 'Họp dân hằng tuần', due_date: '2099-01-01' },
    });
    assertStatus(risk, 404, 'RESOURCE_NOT_FOUND');
    expect(await rows('select id from machvon.project where id = $1::uuid', [mine.id], TENANT_B)).toEqual([]);
    expect(await rows('select id from machvon.project_risk where project_id = $1::uuid', [mine.id])).toEqual([]);
    expect(await rows('select id from machvon.project_risk where project_id = $1::uuid', [mine.id], TENANT_B)).toEqual([]);
  });
});
