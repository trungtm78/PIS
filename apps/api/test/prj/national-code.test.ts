import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { prjModule } from '../../src/modules/prj';
import { NationalCodeController } from '../../src/modules/prj/national-code.controller';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from '../../src/modules/prj/stage.controller';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const MANAGER = 1; // creates projects, starts them, reads the register
const CODE_ADMIN = 2; // project.national_code.manage and project.read on the whole tenant
const DEPARTMENT_ADMIN = 3; // project.national_code.manage on the department only
const READER = 4; // project.read
const NOBODY = 5;
const B_ADMIN = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER = WORKER_MEMBERSHIP_ID;
const MANAGE = 'project.national_code.manage';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(['internal_code,national_project_code', ...lines].join('\n'));

describe('the national project code: assignment by hand, reconciliation file and block rule (ST-PRJ-004)', () => {
  const harness = new AuthzHarness();
  const increments: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: (name, labels) => void increments.push({ name, labels }), gauge: () => undefined };
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;
  const versions: Record<string, string> = {};

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
  const row = async (projectId: string): Promise<Record<string, unknown>> => (await rows<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;
  const freshCode = (): string => String(7_100_000 + ++counter);

  async function seedVersion(tenant: string, key: string): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, key, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', $3, 1, $3, '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
        [tenant, versionId, key, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function document(status = 'EFFECTIVE'): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(1)],
    );
    return id;
  }

  /** A project made through the register, then left in a stage by the stories that come before this one (the owner stands in for them). */
  async function project(status: string, options: { unit?: number; nationalCode?: string | null; tenant?: string } = {}): Promise<{ id: string; code: string; version: number }> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const code = `NC-${counter}-${randomUUID().slice(0, 6)}`;
    const made = await call('POST', '/projects', {
      member: tenant === TENANT_A ? MANAGER : B_ADMIN,
      tenantId: tenant,
      body: { code, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(options.unit ?? DEPARTMENT), area_master_version_id: tenant === TENANT_A ? versions.area : versions.areaB, total_investment_vnd: '500000000000' },
    });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    await rows(`update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid`, [id, status, ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'].includes(status) ? null : 'B', options.nationalCode ?? null], tenant);
    return { id, code, version: 1 };
  }

  const assign = (member: number, target: { id: string; version: number }, body: Record<string, unknown>, extra: { version?: number | string; key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/projects/${target.id}/national-code`, { member, ifMatch: `"${extra.version ?? target.version}"`, body, ...(extra.key === undefined ? {} : { key: extra.key }), ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }) });
  const start = async (target: { id: string; version: number }, member = MANAGER, version?: number): Promise<Reply> =>
    call('POST', `/projects/${target.id}/implementation-start`, { member, ifMatch: `"${version ?? target.version}"`, body: { reason: 'Starting the works', investment_decision_document_id: await document() } });

  /** A file put through the shared pipeline the way the upload door will: the answer names the key and the hash. */
  async function upload(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId, membershipId: memberId(CODE_ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const importFile = (member: number, file: { key: string; sha: string }, options: { dryRun: boolean; mapping?: string; sha?: string; key?: string; tenantId?: string }): Promise<Reply> =>
    call('POST', '/project-national-code-imports', {
      member,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { file_object_key: file.key, file_sha256: options.sha ?? file.sha, dry_run: options.dryRun, ...(options.mapping === undefined ? {} : { mapping_version: options.mapping }) },
    });

  const events = (projectId: string) => rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'project.national_code_assigned.v1' and aggregate_id = $1 order by aggregate_version`, [projectId]);
  const audits = (projectId: string, action = 'project.national_code_assigned') =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>(`select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = $2`, [projectId, action]);

  async function setRuleMode(mode: 'BLOCK' | 'WARN'): Promise<void> {
    await rows(
      `update machvon.master_record_version v set attributes = jsonb_set(attributes, '{mode}', to_jsonb($1::text)) from machvon.master_record r where r.id = v.master_record_id and r.master_type = 'NATIONAL_CODE_REQUIRED'`,
      [mode],
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-national-code-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const n of [MANAGER, CODE_ADMIN, DEPARTMENT_ADMIN, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'STAGE_MANAGER', ['project.create', 'project.read', 'project.stage.implement'], 40);
    await harness.seedRole(TENANT_A, 2, 'CODE_ADMIN', ['project.read', MANAGE], 40);
    await harness.seedRole(TENANT_A, 3, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'CODE_ONLY', [MANAGE], 30);
    await harness.seedRole(TENANT_B, 1, 'CODE_ADMIN', ['project.create', 'project.read', MANAGE], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: CODE_ADMIN, role: 2, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_ADMIN, role: 3, kind: 'TENANT' },
      { n: 4, member: DEPARTMENT_ADMIN, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: READER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    versions.area = await seedVersion(TENANT_A, 'TINH-P');
    versions.areaB = await seedVersion(TENANT_B, 'TINH-P');
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, NationalCodeController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: PRJ_METRICS, useValue: metrics },
        { provide: PRJ_PIPELINE_CACHE, useValue: cache },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toContain(NationalCodeController);
  });

  describe('the block rule and the assignment by hand (AC-ST-PRJ-004-1)', () => {
    it('AC-ST-PRJ-004-1: P-A-012 is BUDGETED without a code: start is 422 NATIONAL_CODE_REQUIRED, then 200 once the code is assigned, and under WARN 200 with the warning', async () => {
      const target = await project('BUDGETED');
      const refused = await start(target);
      expect([refused.status, refused.json.code]).toEqual([422, 'NATIONAL_CODE_REQUIRED']);
      expect((await row(target.id)).status).toBe('BUDGETED');

      const code = freshCode();
      const done = await assign(CODE_ADMIN, target, { national_project_code: ` ${code} ` });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'BUDGETED', resource_version: 2, resource_id: target.id });
      expect(await row(target.id)).toMatchObject({ national_project_code: code, version: '2', updated_by: memberId(CODE_ADMIN) });
      const started = await start({ id: target.id, version: 2 });
      expect(started.status).toBe(200);
      expect(started.json).toMatchObject({ status: 'IMPLEMENTATION' });
      expect(started.json).not.toHaveProperty('warnings');

      await setRuleMode('WARN');
      try {
        const lenient = await project('BUDGETED');
        const warned = await start(lenient);
        expect(warned.status).toBe(200);
        expect(warned.json).toMatchObject({ status: 'IMPLEMENTATION', warnings: ['NATIONAL_CODE_REQUIRED'] });
        expect((await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.stage_changed'`, [lenient.id]))[0]?.safe_diff).toMatchObject({ national_code_warning: true });
      } finally {
        await setRuleMode('BLOCK');
      }
    });

    it('AC-ST-PRJ-004-1: the assignment is audited with what it was and what it is, announced once, and clears the pages of the project bank', async () => {
      const target = await project('PIPELINE');
      const code = freshCode();
      const before = increments.length;
      await cache.set(TENANT_A, 'all', 'probe', 'cached');
      const reply = await assign(CODE_ADMIN, target, { national_project_code: code });
      expect(reply.status).toBe(200);
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect(increments.length).toBe(before);
      const audit = await audits(target.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(CODE_ADMIN), safe_diff: { code: target.code, previous_national_project_code: null, national_project_code: code, via: 'MANUAL', evidence_document_id: null } });
      const announced = await events(target.id);
      expect(announced).toHaveLength(1);
      expect(announced[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, version: 2, actor_id: memberId(CODE_ADMIN), national_project_code: code, previous_national_project_code: null, via: 'MANUAL' }));
    });

    it('AC-ST-PRJ-004-1: the same code again is recorded as unchanged: no new version, no event', async () => {
      const code = freshCode();
      const target = await project('BUDGETED', { nationalCode: code });
      const reply = await assign(CODE_ADMIN, target, { national_project_code: code });
      expect(reply.json).toMatchObject({ resource_version: 1 });
      expect(await events(target.id)).toEqual([]);
      expect(await audits(target.id, 'project.national_code_unchanged')).toHaveLength(1);
    });

    it('AC-ST-PRJ-004-1: a code of the wrong format is 422, one held by another project is 409, a stale version is 409, nothing is stored', async () => {
      const held = freshCode();
      await project('BUDGETED', { nationalCode: held });
      const target = await project('BUDGETED');
      const format = await assign(CODE_ADMIN, target, { national_project_code: 'ABC-123' });
      expect([format.status, format.json.code]).toEqual([422, 'NATIONAL_CODE_FORMAT_INVALID']);
      const duplicate = await assign(CODE_ADMIN, target, { national_project_code: held });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'NATIONAL_CODE_DUPLICATE']);
      const stale = await assign(CODE_ADMIN, target, { national_project_code: freshCode() }, { version: 9 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await row(target.id)).toMatchObject({ national_project_code: null, version: '1' });
    });

    it('AC-ST-PRJ-004-1: once a project is under way, changing its code needs the evidence document; an ended project keeps its code', async () => {
      const running = await project('IMPLEMENTATION', { nationalCode: freshCode() });
      const fresh = freshCode();
      const without = await assign(CODE_ADMIN, running, { national_project_code: fresh });
      expect([without.status, without.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const evidence = await document();
      const done = await assign(CODE_ADMIN, running, { national_project_code: fresh, evidence_document_id: evidence });
      expect(done.status).toBe(200);
      expect((await audits(running.id))[0]?.safe_diff).toMatchObject({ national_project_code: fresh, evidence_document_id: evidence });
      const ended = await project('CLOSED');
      const locked = await assign(CODE_ADMIN, ended, { national_project_code: freshCode() });
      expect([locked.status, locked.json.code]).toEqual([422, 'STAGE_LOCKED_FIELD']);
    });

    it('AC-ST-PRJ-004-1: the permission and the scope decide: a reader is refused, a department administrator reaches the department only, another tenant finds no project', async () => {
      const inDepartment = await project('BUDGETED');
      const elsewhere = await project('BUDGETED', { unit: ELSEWHERE });
      const denied = await assign(READER, inDepartment, { national_project_code: freshCode() });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await assign(DEPARTMENT_ADMIN, inDepartment, { national_project_code: freshCode() })).status).toBe(200);
      const outside = await assign(DEPARTMENT_ADMIN, elsewhere, { national_project_code: freshCode() });
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const crossing = await assign(B_ADMIN, inDepartment, { national_project_code: freshCode() }, { tenantId: TENANT_B });
      expect([crossing.status, crossing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await row(elsewhere.id)).national_project_code).toBeNull();
    });

    it('AC-ST-PRJ-004-1: a command repeated with its key answers the first answer and writes nothing twice', async () => {
      const target = await project('BUDGETED');
      const key = `key-${randomUUID()}`;
      const code = freshCode();
      const first = await assign(CODE_ADMIN, target, { national_project_code: code }, { key });
      const second = await assign(CODE_ADMIN, target, { national_project_code: code }, { key });
      expect(second.json).toEqual(first.json);
      expect(await events(target.id)).toHaveLength(1);
    });
  });

  describe('the reconciliation file (AC-ST-PRJ-004-2)', () => {
    it('AC-ST-PRJ-004-2: national_codes.csv has 3 rows with one duplicate code: the dry run names the row error, the apply takes the valid rows, the second apply is 409 IMPORT_FILE_ALREADY_APPLIED', async () => {
      const [a, b, c] = [await project('BUDGETED'), await project('BUDGETED'), await project('BUDGETED')] as const;
      const first = freshCode();
      const second = freshCode();
      const file = await upload(csv(`${a.code},${first}`, `${b.code},${second}`, `${c.code},${first}`));

      const dry = await importFile(CODE_ADMIN, file, { dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.json).toMatchObject({
        status: 'DRY_RUN',
        dry_run: true,
        resource_version: 0,
        already_applied: false,
        file_sha256: file.sha,
        adapter: { connector_code: 'NATIONAL_PIM_FILE', format_version: 'WORKING-ASSUMPTION-2026.1', status: 'PROPOSED' },
        counts: { total: 3, valid: 2, duplicate: 0, conflict: 0, errors: 1 },
        rows_truncated: false,
      });
      expect((dry.json.rows as Array<Record<string, unknown>>).map((entry) => [entry.line, entry.internal_code, entry.status, entry.outcome ?? entry.code])).toEqual([
        [2, a.code, 'VALID', 'ASSIGN'],
        [3, b.code, 'VALID', 'ASSIGN'],
        [4, c.code, 'ERROR', 'NATIONAL_CODE_DUPLICATE'],
      ]);
      expect(dry.json).not.toHaveProperty('resource_id');
      expect((await row(a.id)).national_project_code).toBeNull();
      expect(await rows('select id from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);

      const applied = await importFile(CODE_ADMIN, file, { dryRun: false });
      expect(applied.status).toBe(200);
      expect(applied.json).toMatchObject({ status: 'APPLIED', dry_run: false, resource_version: 1, assigned: 2, counts: { total: 3, applied: 2, quarantined: 1 }, errors_truncated: false });
      expect(applied.json.errors).toEqual([{ line: 4, internal_code: c.code, code: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code', preview: { internal_code: c.code, national_project_code: first } }]);
      expect(await row(a.id)).toMatchObject({ national_project_code: first, version: '2' });
      expect(await row(b.id)).toMatchObject({ national_project_code: second, version: '2' });
      expect((await row(c.id)).national_project_code).toBeNull();
      expect(await events(a.id)).toHaveLength(1);
      expect((await audits(a.id))[0]?.safe_diff).toMatchObject({ via: 'IMPORT', national_project_code: first, import_id: applied.json.resource_id });
      const importAudit = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'project.national_code_import_applied'`, [applied.json.resource_id as string]);
      expect(importAudit[0]?.safe_diff).toMatchObject({ connector_code: 'NATIONAL_PIM_FILE', file_sha256: file.sha, assigned: 2, counts: { applied: 2, quarantined: 1 } });

      const again = await importFile(CODE_ADMIN, file, { dryRun: false });
      expect([again.status, again.json.code]).toEqual([409, 'IMPORT_FILE_ALREADY_APPLIED']);
      expect(await events(a.id)).toHaveLength(1);
      const dryAgain = await importFile(CODE_ADMIN, file, { dryRun: true });
      expect(dryAgain.json).toMatchObject({ already_applied: true, counts: { duplicate: 2, errors: 1, valid: 0 } });
    });

    it('AC-ST-PRJ-004-2: a file none of whose rows can be taken is 422 IMPORT_HAS_ERRORS with the line of each fault, and leaves nothing behind', async () => {
      const bytes = csv(`NO-SUCH-1,${freshCode()}`, `NO-SUCH-2,${freshCode()}`);
      const file = await upload(bytes);
      const reply = await importFile(CODE_ADMIN, file, { dryRun: false });
      expect([reply.status, reply.json.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
      expect((reply.json.errors as Array<Record<string, unknown>>).map((entry) => [entry.line, entry.code, entry.field])).toEqual([
        [2, 'PROJECT_NOT_FOUND', 'internal_code'],
        [3, 'PROJECT_NOT_FOUND', 'internal_code'],
      ]);
      expect(reply.json.counts).toMatchObject({ total: 2, applied: 0, quarantined: 2 });
      expect(await rows('select id from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);
      const corrected = await project('BUDGETED');
      const retry = await upload(csv(`${corrected.code},${freshCode()}`, `NO-SUCH-1,${freshCode()}`));
      expect((await importFile(CODE_ADMIN, retry, { dryRun: false })).status).toBe(200);
    });

    it('AC-ST-PRJ-004-2: a department administrator reconciles the projects of the department and no others, and a project with another code is a difference, not an overwrite', async () => {
      const mine = await project('BUDGETED');
      const elsewhere = await project('BUDGETED', { unit: ELSEWHERE });
      const held = await project('IMPLEMENTATION', { nationalCode: freshCode() });
      const heldCode = (await row(held.id)).national_project_code as string;
      const proposed = freshCode();
      const file = await upload(csv(`${mine.code},${freshCode()}`, `${elsewhere.code},${freshCode()}`, `${held.code},${proposed}`));
      const applied = await importFile(DEPARTMENT_ADMIN, file, { dryRun: false });
      expect(applied.status).toBe(200);
      expect(applied.json).toMatchObject({ assigned: 1, counts: { applied: 2, quarantined: 1, differencesOpened: 1 } });
      expect((applied.json.errors as Array<Record<string, unknown>>).map((entry) => [entry.internal_code, entry.code])).toEqual([[elsewhere.code, 'PROJECT_NOT_FOUND']]);
      expect((await row(held.id)).national_project_code).toBe(heldCode);
      expect((await row(elsewhere.id)).national_project_code).toBeNull();
      expect(await rows('select code, expected_value, actual_value from machvon.file_import_reconciliation_item where import_id = $1::uuid', [applied.json.resource_id as string])).toEqual([
        { code: 'NATIONAL_CODE_MISMATCH', expected_value: heldCode, actual_value: proposed },
      ]);
    });

    it('AC-ST-PRJ-004-2: the file is checked before it is read: a hash that is not its own is 422 HASH_MISMATCH, a layout it is not is 422, a file of another tenant does not exist, an unreadable file is 422', async () => {
      const target = await project('BUDGETED');
      const file = await upload(csv(`${target.code},${freshCode()}`));
      const mismatch = await importFile(CODE_ADMIN, file, { dryRun: true, sha: 'f'.repeat(64) });
      expect([mismatch.status, mismatch.json.code]).toEqual([422, 'HASH_MISMATCH']);
      const layout = await importFile(CODE_ADMIN, file, { dryRun: true, mapping: 'OTHER-LAYOUT' });
      expect([layout.status, layout.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await importFile(CODE_ADMIN, file, { dryRun: true, mapping: 'WORKING-ASSUMPTION-2026.1' })).status).toBe(200);
      const crossing = await importFile(B_ADMIN, file, { dryRun: true, tenantId: TENANT_B });
      expect([crossing.status, crossing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const unreadable = await upload(new TextEncoder().encode('name,code\nA,1'));
      const refused = await importFile(CODE_ADMIN, unreadable, { dryRun: false });
      expect([refused.status, refused.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      const dryRefused = await importFile(CODE_ADMIN, unreadable, { dryRun: true });
      expect([dryRefused.status, dryRefused.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      const empty = await upload(csv());
      expect((await importFile(CODE_ADMIN, empty, { dryRun: true })).json.code).toBe('IMPORT_EMPTY');
      expect((await row(target.id)).national_project_code).toBeNull();
    });

    it('AC-ST-PRJ-004-2: a caller without the permission cannot read the file at all, whatever they ask', async () => {
      const file = await upload(csv(`NO-SUCH-1,${freshCode()}`));
      for (const member of [READER, NOBODY]) {
        const dry = await importFile(member, file, { dryRun: true });
        expect(dry.status).toBe(403);
        const applied = await importFile(member, file, { dryRun: false });
        expect(applied.status).toBe(403);
      }
      expect(await rows('select id from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);
    });
  });

  describe('what the screen of the reconciliation reads', () => {
    it('UI-PRJ-21: the register tells which projects have no national code (the list read), and the adapter of the file is PROPOSED in every answer', async () => {
      const without = await project('BUDGETED');
      const list = await call('GET', '/resources/project?limit=200', { member: CODE_ADMIN });
      expect(list.status).toBe(200);
      const found = (list.json.items as Array<Record<string, unknown>>).find((item) => item.id === without.id);
      expect(found).toMatchObject({ national_project_code: null, status: 'BUDGETED' });
      const file = await upload(csv(`${without.code},${freshCode()}`));
      expect((await importFile(CODE_ADMIN, file, { dryRun: true })).json).toMatchObject({ adapter: { status: 'PROPOSED' } });
    });
  });
});
