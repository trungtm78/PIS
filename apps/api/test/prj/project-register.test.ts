import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { MODULES } from '../../src/modules/registry';
import { PRJ_METRICS } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const MAKER = 1; // project.create, project.update and project.read on the whole tenant
const DEPARTMENT_MAKER = 2; // the same permissions on the subtree of unit 2
const READER = 3; // project.read on the whole tenant
const NOBODY = 4;
const B_MAKER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER = '00000000-0000-4000-8000-000000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the project register: create, profile update, list and workspace (ST-PRJ-001)', () => {
  const harness = new AuthzHarness();
  const gauges: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value, labels) => void gauges.push({ name, value, labels }) };
  let app: RunningApp;
  let counter = 0;
  const versions: Record<string, string> = {};
  const bVersions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function seedVersion(tenant: string, masterType: string, key: string, validUntil: string | null = null): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`,
        [tenant, recordId, masterType, key, memberId(1)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, '{}'::jsonb, '2020-01-01', $5::date, 'EFFECTIVE', $6, now(), $7, $7)`,
        [tenant, versionId, masterType, key, validUntil, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  const create = (member: number, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> => {
    counter += 1;
    const own = tenantId === TENANT_B ? bVersions : versions;
    return call('POST', '/projects', {
      member,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { code: `DA-${counter}-${randomUUID().slice(0, 6)}`, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: own.area, total_investment_vnd: '500000000000', ...extra },
    });
  };
  const profile = (member: number, projectId: string, version: number | string, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', `/projects/${projectId}/profile`, { member, ifMatch: `"${version}"`, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const row = async (projectId: string): Promise<Record<string, unknown>> => (await rows<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;

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
    for (const n of [MAKER, DEPARTMENT_MAKER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    const maker = ['project.create', 'project.update', 'project.read'];
    await harness.seedRole(TENANT_A, 1, 'PROJECT_MAKER', maker, 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PROJECT_MAKER', maker, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    versions.area = await seedVersion(TENANT_A, 'AREA', 'TINH-P');
    versions.sector = await seedVersion(TENANT_A, 'SECTOR', 'TRANSPORT');
    versions.expired = await seedVersion(TENANT_A, 'SECTOR', 'OLD-SECTOR', '2024-01-01');
    bVersions.area = await seedVersion(TENANT_B, 'AREA', 'TINH-P');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: metrics },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered once in the module registry with the controllers of the register', () => {
    expect(prjModule.code).toBe('PRJ');
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectController, ProjectReadsController]));
    expect(MODULES).toContain(prjModule);
  });

  describe('createProject', () => {
    it('creates a CONCEPT project at version 1 with revision r1 INITIAL, audited and announced, and refuses the same code in the tenant but not in another (AC-ST-PRJ-001-1)', async () => {
      const code = 'DA-2026-001';
      const first = await create(MAKER, { code, sector_master_version_id: versions.sector });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'CONCEPT', resource_version: 1 });
      const projectId = idOf(first);
      expect(await rows('select revision, change_kind from machvon.project_revision where project_id = $1', [projectId])).toEqual([{ revision: 1, change_kind: 'INITIAL' }]);
      expect(await rows('select action, resource_type, outcome from machvon.audit_event where resource_id = $1', [projectId])).toEqual([{ action: 'project.created', resource_type: 'project', outcome: 'SUCCESS' }]);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [projectId]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'project.created.v1', payload: { project_id: projectId, version: 1, code, status: 'CONCEPT', actor_id: memberId(MAKER), tenant_id: TENANT_A } });

      const duplicate = await create(MAKER, { code });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'PROJECT_CODE_DUPLICATE']);
      expect(await rows("select count(*)::int as n from machvon.project where code = 'DA-2026-001'")).toEqual([{ n: 1 }]);
      const other = await create(B_MAKER, { code }, TENANT_B);
      expect(other.status).toBe(200);
      expect(other.json).toMatchObject({ status: 'CONCEPT', resource_version: 1 });
      expect(await rows("select count(*)::int as n from machvon.project where code = 'DA-2026-001'", [], TENANT_B)).toEqual([{ n: 1 }]);
    });

    it('tells the audit trail and the other modules the code that was stored, not the one that was typed', async () => {
      const made = await create(MAKER, { code: '  DA-STORED-1  ', total_investment_vnd: '500000000000.00' });
      expect(made.status).toBe(200);
      expect(await rows('select code, total_investment_vnd::text as total from machvon.project where id = $1', [idOf(made)])).toEqual([{ code: 'DA-STORED-1', total: '500000000000' }]);
      const event = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1', [idOf(made)]);
      expect(event[0]?.payload).toMatchObject({ code: 'DA-STORED-1' });
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.created'", [idOf(made)]);
      expect(audit[0]?.safe_diff).toMatchObject({ code: 'DA-STORED-1' });
    });

    it('needs project.create on the owner unit, and a unit and master data that are valid', async () => {
      expect((await create(NOBODY)).status).toBe(403);
      expect((await create(READER)).status).toBe(403);
      expect((await create(DEPARTMENT_MAKER, { owner_unit_id: unitId(ELSEWHERE) })).json.code).toBe('SCOPE_DENIED');
      expect((await create(DEPARTMENT_MAKER, { owner_unit_id: unitId(ROOT) })).status).toBe(403);
      expect((await create(DEPARTMENT_MAKER, { owner_unit_id: unitId(DEPARTMENT) })).status).toBe(200);
      const missingUnit = await create(MAKER, { owner_unit_id: randomUUID() });
      expect([missingUnit.status, missingUnit.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const expired = await create(MAKER, { sector_master_version_id: versions.expired });
      expect([expired.status, expired.json.code]).toEqual([422, 'MASTER_NOT_EFFECTIVE']);
      expect((await create(MAKER, { area_master_version_id: bVersions.area })).json.code).toBe('VALIDATION_FAILED');
      expect((await create(MAKER, { total_investment_vnd: '10.5' })).status).toBe(422);
      expect((await create(MAKER, { surprise: true })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await create(MAKER, { status: 'IMPLEMENTATION' })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await create(MAKER, { name: 'ab' })).status).toBe(422);
      expect((await create(MAKER, { total_investment_vnd: undefined })).status).toBe(400);
    });

    it('classifies the audit row of a confidential project as confidential', async () => {
      const made = await create(MAKER, { classification: 'CONFIDENTIAL' });
      expect(await rows('select classification from machvon.audit_event where resource_id = $1', [idOf(made)])).toEqual([{ classification: 'CONFIDENTIAL' }]);
    });
  });

  describe('updateProjectProfile', () => {
    it('refuses a stale If-Match and a body with status, tenant_id or money, and leaves the row unchanged (AC-ST-PRJ-001-2)', async () => {
      const made = await create(MAKER);
      const projectId = idOf(made);
      expect((await profile(MAKER, projectId, 1, { name: 'Tên thứ hai' })).json).toMatchObject({ resource_version: 2, status: 'CONCEPT' });
      expect((await profile(MAKER, projectId, 2, { name: 'Tên thứ ba' })).json.resource_version).toBe(3);
      const before = await row(projectId);
      const stale = await profile(MAKER, projectId, 1, { name: 'Tên cũ' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      for (const forbidden of [{ status: 'IMPLEMENTATION' }, { tenant_id: TENANT_B }, { total_investment_vnd: '1' }, { code: 'OTHER' }, { national_project_code: '7654321' }, { name: 'Hợp lệ', status: 'CLOSED' }]) {
        const refused = await profile(MAKER, projectId, 3, forbidden);
        expect([refused.status, refused.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect(await row(projectId)).toEqual(before);
    });

    it('changes the profile, audits the change with its before and after and announces it, and writes nothing for a request that changes nothing', async () => {
      const made = await create(MAKER, { name: 'Tên ban đầu' });
      const projectId = idOf(made);
      const done = await profile(MAKER, projectId, 1, { name: 'Tên chỉnh sửa', sector_master_version_id: versions.sector, start_year: 2026, end_year: 2029, classification: 'CONFIDENTIAL' });
      expect(done.json).toMatchObject({ resource_version: 2, status: 'CONCEPT' });
      expect(await row(projectId)).toMatchObject({ name: 'Tên chỉnh sửa', sector_master_version_id: versions.sector, start_year: 2026, end_year: 2029, classification: 'CONFIDENTIAL', version: '2', updated_by: memberId(MAKER) });
      const audit = await rows<{ action: string; safe_diff: { changes: Array<{ field: string; before: unknown; after: unknown }> } }>(
        "select action, safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.profile_changed'",
        [projectId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff.changes).toContainEqual({ field: 'name', before: 'Tên ban đầu', after: 'Tên chỉnh sửa' });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'project.profile_changed.v1'", [projectId]);
      expect(events[0]?.payload).toMatchObject({ project_id: projectId, version: 2, changed_fields: expect.arrayContaining(['name', 'start_year']) });

      const same = await profile(MAKER, projectId, 2, { name: 'Tên chỉnh sửa' });
      expect(same.json).toMatchObject({ resource_version: 2 });
      expect(await rows("select action, count(*)::int as n from machvon.audit_event where resource_id = $1 and action like 'project.profile_%' group by action order by action", [projectId])).toEqual([
        { action: 'project.profile_changed', n: 1 },
        { action: 'project.profile_unchanged', n: 1 },
      ]);
      expect(await rows("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1 and type = 'project.profile_changed.v1'", [projectId])).toEqual([{ n: 1 }]);
    });

    it('reads an identifier in capitals as the identifier it is: naming the entry a project already holds, in capitals, changes nothing', async () => {
      const made = await create(MAKER, { sector_master_version_id: versions.sector, investor_unit_id: unitId(DEPARTMENT) });
      const projectId = idOf(made);
      const same = await profile(MAKER, projectId, 1, { sector_master_version_id: (versions.sector as string).toUpperCase(), area_master_version_id: (versions.area as string).toUpperCase() });
      expect(same.json).toMatchObject({ resource_version: 1, status: 'CONCEPT' });
      expect(await row(projectId)).toMatchObject({ version: '1', sector_master_version_id: versions.sector, area_master_version_id: versions.area });
      expect(await rows("select action from machvon.audit_event where resource_id = $1 and action like 'project.profile_%'", [projectId])).toEqual([{ action: 'project.profile_unchanged' }]);
      // A real change in capitals is stored the way the database writes an identifier.
      const other = await seedVersion(TENANT_A, 'SECTOR', 'EDUCATION');
      const moved = await profile(MAKER, projectId, 1, { sector_master_version_id: other.toUpperCase() });
      expect(moved.json).toMatchObject({ resource_version: 2 });
      expect(await row(projectId)).toMatchObject({ sector_master_version_id: other });
    });

    it('locks the dossier fields after the concept stage, takes no change once the project is closed, and checks master data and years', async () => {
      const made = await create(MAKER);
      const projectId = idOf(made);
      const badYears = await profile(MAKER, projectId, 1, { start_year: 2031, end_year: 2030 });
      expect([badYears.status, badYears.json.code, badYears.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'end_year']);
      expect((await profile(MAKER, projectId, 1, { sector_master_version_id: versions.expired })).json.code).toBe('MASTER_NOT_EFFECTIVE');
      expect((await profile(MAKER, projectId, 1, {})).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'body' });
      await rows("update machvon.project set status = 'PIPELINE', project_group = 'B' where id = $1::uuid", [projectId]);
      const locked = await profile(MAKER, projectId, 1, { start_year: 2026 });
      expect([locked.status, locked.json.code, locked.json.detail]).toEqual([422, 'STAGE_LOCKED_FIELD', 'start_year']);
      expect((await profile(MAKER, projectId, 1, { name: 'Vẫn đổi được tên' })).json).toMatchObject({ resource_version: 2, status: 'PIPELINE' });
      await rows("update machvon.project set status = 'CLOSED' where id = $1::uuid", [projectId]);
      expect((await profile(MAKER, projectId, 2, { name: 'Đã đóng' })).json.code).toBe('STAGE_LOCKED_FIELD');
    });

    it('judges the scope of project.update: out of sight is 404, readable but not updatable is 403', async () => {
      const inRoot = await create(MAKER, { owner_unit_id: unitId(ROOT) });
      const inDepartment = await create(MAKER, { owner_unit_id: unitId(DEPARTMENT) });
      expect((await profile(DEPARTMENT_MAKER, idOf(inDepartment), 1, { name: 'Sửa trong phòng' })).status).toBe(200);
      // The department maker cannot read the project of the root unit: for them it does not exist.
      const hidden = await profile(DEPARTMENT_MAKER, idOf(inRoot), 1, { name: 'Sửa ngoài phạm vi' });
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await profile(READER, idOf(inRoot), 1, { name: 'Chỉ đọc' })).status).toBe(403);
      expect((await profile(NOBODY, idOf(inRoot), 1, { name: 'Không quyền' })).status).toBe(403);
      expect((await profile(MAKER, randomUUID(), 1, { name: 'Không có' })).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await profile(MAKER, idOf(inRoot), 'abc', { name: 'Sai phiên bản' })).status).toBe(400);
    });
  });

  describe('the register and the workspace', () => {
    it('lists only the projects in the unit tree of the caller, with the stage, the national code and the leader (AC-ST-PRJ-001-5)', async () => {
      await create(MAKER, { owner_unit_id: unitId(ROOT), code: 'LST-ROOT' });
      const inDepartment = await create(MAKER, { owner_unit_id: unitId(DEPARTMENT), code: 'LST-DEPT' });
      await create(MAKER, { owner_unit_id: unitId(ELSEWHERE), code: 'LST-ELSE' });
      await create(MAKER, { owner_unit_id: unitId(ELSEWHERE), investor_unit_id: unitId(DEPARTMENT), code: 'LST-INV' });
      await harness.seedMembership(TENANT_A, 9, DEPARTMENT);
      await rows(
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, randomUUID(), idOf(inDepartment), memberId(9), memberId(MAKER)],
      );
      const codesOf = (reply: Reply): string[] => items(reply).map((item) => item.code as string).filter((code) => code.startsWith('LST-'));
      const all = await call('GET', '/resources/project?limit=200', { member: MAKER });
      expect(all.status).toBe(200);
      expect(codesOf(all)).toEqual(['LST-DEPT', 'LST-ELSE', 'LST-INV', 'LST-ROOT']);
      expect(codesOf(await call('GET', '/resources/project?limit=200', { member: READER }))).toEqual(['LST-DEPT', 'LST-ELSE', 'LST-INV', 'LST-ROOT']);
      const scoped = await call('GET', '/resources/project?limit=200', { member: DEPARTMENT_MAKER });
      expect(codesOf(scoped)).toEqual(['LST-DEPT', 'LST-INV']);
      const line = items(scoped).find((item) => item.code === 'LST-DEPT');
      expect(line).toMatchObject({
        id: idOf(inDepartment),
        status: 'CONCEPT',
        project_group: null,
        national_project_code: null,
        leader_in_charge: { membership_id: memberId(9), display_name: 'User 9' },
        owner_unit_name: 'Unit 2',
        version: 1,
      });
      expect(Object.keys(line ?? {}).sort()).toEqual(
        ['id', 'code', 'name', 'owner_unit_id', 'owner_unit_name', 'investor_unit_id', 'investor_unit_name', 'project_group', 'status', 'national_project_code', 'leader_in_charge', 'version'].sort(),
      );
      expect(items(scoped).find((item) => item.code === 'LST-INV')).toMatchObject({ investor_unit_name: 'Unit 2', leader_in_charge: null });
      expect((await call('GET', '/resources/project', { member: NOBODY })).status).toBe(403);
      // Paging continues after the last line, and the scope is applied before the page is cut.
      const page = await call('GET', '/resources/project?limit=2', { member: DEPARTMENT_MAKER });
      expect(items(page)).toHaveLength(2);
      const next = await call('GET', `/resources/project?limit=2&cursor=${page.json.next_cursor as string}`, { member: DEPARTMENT_MAKER });
      expect(items(next).every((item) => !items(page).some((seen) => seen.id === item.id))).toBe(true);
      expect((await call('GET', '/resources/project?limit=0', { member: MAKER })).status).toBe(422);
      expect((await call('GET', '/resources/project?cursor=nope', { member: MAKER })).status).toBe(422);
    });

    it('opens the workspace of one project with its master data, its money as a decimal string and the group the rules suggest', async () => {
      const made = await create(MAKER, { sector_master_version_id: versions.sector, total_investment_vnd: '2300000000000', start_year: 2026, end_year: 2029 });
      const reply = await call('GET', `/resources/project/${idOf(made)}`, { member: READER });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        id: idOf(made),
        status: 'CONCEPT',
        classification: 'INTERNAL',
        total_investment_vnd: '2300000000000',
        start_year: 2026,
        end_year: 2029,
        area: { version_id: versions.area, business_key: 'TINH-P' },
        sector: { version_id: versions.sector, business_key: 'TRANSPORT' },
        project_type: null,
        proposed_on: TODAY,
        group_suggestion: { group_key: 'A', as_of: TODAY, awaiting_confirmation: true, cxn: 'CXN-32' },
      });
      expect(reply.json.created_by).toBeUndefined();
      expect(reply.json.tenant_id).toBeUndefined();
    });

    it('keeps another tenant and a caller outside the scope from every path of the register: 404 with nothing to count (AC-ST-PRJ-001-3)', async () => {
      const made = await create(MAKER, { owner_unit_id: unitId(ROOT), code: 'ISO-ROOT' });
      const projectId = idOf(made);
      const foreign = await call('GET', `/resources/project/${projectId}`, { member: B_MAKER, tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreignUpdate = await profile(B_MAKER, projectId, 1, { name: 'Tên của tenant khác' }, TENANT_B);
      expect([foreignUpdate.status, foreignUpdate.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreignList = await call('GET', '/resources/project?limit=200', { member: B_MAKER, tenantId: TENANT_B });
      expect(items(foreignList).map((item) => item.id)).not.toContain(projectId);
      expect(JSON.stringify(foreignList.json)).not.toContain('ISO-ROOT');
      expect((await call('GET', `/resources/project/${projectId}`, { member: DEPARTMENT_MAKER })).status).toBe(404);
      expect((await call('GET', `/resources/project/${randomUUID()}`, { member: MAKER })).status).toBe(404);
      expect((await call('GET', '/resources/project/not-a-uuid', { member: MAKER })).status).toBe(422);
      expect((await row(projectId)).name).toBe('Dự án cầu Thủ Thiêm 4');
    });

    it('has no generic write for the status, the tenant, the rights or the money of a project (AC-ST-PRJ-001-4)', async () => {
      const made = await create(MAKER);
      const projectId = idOf(made);
      await rows("update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [projectId]);
      const before = await row(projectId);
      for (const [method, url] of [
        ['PUT', `/resources/project/${projectId}`],
        ['PATCH', `/resources/project/${projectId}`],
        ['DELETE', `/resources/project/${projectId}`],
        ['POST', `/resources/project/${projectId}`],
        ['POST', '/resources/project'],
        ['PUT', `/projects/${projectId}`],
        ['PATCH', `/projects/${projectId}`],
        ['DELETE', `/projects/${projectId}`],
        ['POST', `/projects/${projectId}/status`],
        ['POST', `/projects/${projectId}/money`],
      ] as const) {
        const reply = await call(method, url, { member: MAKER, body: { status: 'CLOSED', total_investment_vnd: '1' }, ifMatch: '"1"' });
        expect([404, 405]).toContain(reply.status);
      }
      expect((await profile(MAKER, projectId, 1, { status: 'CLOSED' })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect(await row(projectId)).toEqual(before);
    });

    it('reports the number of open projects without a national code once per first page, for the tenant (prj_national_code_missing_gauge)', async () => {
      gauges.length = 0;
      await call('GET', '/resources/project?limit=1', { member: MAKER });
      const expected = Number((await rows<{ n: string }>("select count(*)::text as n from machvon.project where national_project_code is null and status not in ('CLOSED', 'REJECTED', 'CANCELLED')"))[0]?.n);
      expect(gauges).toEqual([{ name: 'prj_national_code_missing_gauge', value: expected, labels: { tenant: TENANT_A } }]);
      const first = await call('GET', '/resources/project?limit=1', { member: MAKER });
      gauges.length = 0;
      await call('GET', `/resources/project?limit=1&cursor=${first.json.next_cursor as string}`, { member: MAKER });
      expect(gauges).toEqual([]);
    });
  });
});
