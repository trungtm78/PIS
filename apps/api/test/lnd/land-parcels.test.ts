import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { lndModule } from '../../src/modules/lnd';
import { AffectedHouseholdController, AffectedHouseholdReadsController } from '../../src/modules/lnd/household.controller';
import { LandInventoryController, LandInventoryReadsController } from '../../src/modules/lnd/inventory.controller';
import { LandParcelController } from '../../src/modules/lnd/parcel.controller';
import { CompensationPlanController, CompensationPlanReadsController } from '../../src/modules/lnd/plan.controller';
import { CompensationPlanPostingController, CompensationPlanPostingReadsController } from '../../src/modules/lnd/plan-posting.controller';
import { CompensationPaymentController, CompensationPaymentReadsController } from '../../src/modules/lnd/payment.controller';
import { LandParcelImportController } from '../../src/modules/lnd/parcel-import.controller';
import { LandReadsController } from '../../src/modules/lnd/read.controller';
import { LandSectionController } from '../../src/modules/lnd/section.controller';
import { LandStageProgressController } from '../../src/modules/lnd/stage-progress.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // land.manage, land.process, land.read on the whole tenant
const DEPARTMENT_OFFICER = 2; // the same on the unit tree of the department only
const PROJECT_OFFICER = 3; // the same on project 1 only
const READER = 4; // land.read on the whole tenant
const PROCESS_ELSEWHERE = 5; // land.read on the whole tenant, land.process on the other branch only
const NOBODY = 6;
const HANDOVER = 8; // land.handover and land.read on the whole tenant
const HANDOVER_ELSEWHERE = 9; // land.read on the whole tenant, land.handover on the other branch only
const PROCESS_ONLY = 7; // land.process on the unit tree of the department and nothing else: the commune officer of the module document
const B_OFFICER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xb4;
const FAMILY_B = 0xb5;
const WORKER = WORKER_MEMBERSHIP_ID;
const PERSON = 'Nguyễn Văn A';
const HEADER = 'parcel_code,owner_unit_code,land_use_group,area_total_m2,area_affected_m2,address_text,section_code';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('land clearance: sections, parcels without owners, the parcel import and the recovery notice timers (ST-LND-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let world: LndWorld;
  let worldB: LndWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const get = (member: number, url: string, tenantId?: string): Promise<Reply> => call('GET', url, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  async function uploadDoor(member: number, bytes: Uint8Array, key = `key-${randomUUID()}`): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/csv' }), 'parcels.csv');
    const response = await fetch(`${app.baseUrl}/land-parcels/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': key }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const code = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, '0')}`;

  const createSection = (member: number, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string; projectId?: string } = {}): Promise<Reply> =>
    call('POST', '/land-sections', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: { project_id: options.projectId ?? world.project, code: code('SEC'), name: 'Km 0 to km 3', required_area_m2: '30000', ...extra },
    });
  const createParcel = (member: number, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string; projectId?: string } = {}): Promise<Reply> =>
    call('POST', '/land-parcels', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: { project_id: options.projectId ?? world.project, owner_unit_id: unitId(DEPARTMENT), parcel_code: code('LP'), land_use_group: 'AGRICULTURAL', area_total_m2: '1200.5', area_affected_m2: '800', ...extra },
    });
  const noticeOf = (member: number, parcelId: string, version: number | string, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/land-parcels/${parcelId}/recovery-notice`, {
      member,
      ifMatch: `"${version}"`,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { notice_on: '2026-07-01', notice_document_version_id: world.cleanDocument, ...extra },
    });

  /** A file put through the shared pipeline the way the upload door will: its id is the last segment of the key. */
  async function upload(bytes: Uint8Array, declaredType = 'text/csv'): Promise<{ id: string; sha: string }> {
    const stored = await files.upload({ tenantId: TENANT_A, membershipId: memberId(OFFICER), scopeVersion: 1 }, { purpose: 'import', declaredType, bytes });
    return { id: stored.key.split('/').pop() ?? '', sha: shaOf(bytes) };
  }
  const importFile = (member: number, file: { id: string; sha: string }, extra: { key?: string; projectId?: string; sha?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/land-parcels/import', {
      member,
      ...(extra.key === undefined ? {} : { key: extra.key }),
      ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }),
      body: { project_id: extra.projectId ?? world.project, file_object_id: file.id, file_sha256: extra.sha ?? file.sha },
    });

  const parcelRow = async (parcelId: string) =>
    (
      await rows<Record<string, unknown>>(
        `select status, version::text as version, recovery_notice_on::text as recovery_notice_on, notice_days_applied, notice_document_version_id, address_text, owner_unit_id
           from machvon.land_parcel where id = $1::uuid`,
        [parcelId],
      )
    )[0] as Record<string, unknown>;
  const countParcels = async (projectId = world.project): Promise<number> => Number((await rows<{ n: string }>('select count(*)::text as n from machvon.land_parcel where project_id = $1::uuid', [projectId]))[0]?.n);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>('select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-lnd-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, '2026-10-24'));
    for (const n of [OFFICER, DEPARTMENT_OFFICER, PROJECT_OFFICER, READER, PROCESS_ELSEWHERE, NOBODY, PROCESS_ONLY, HANDOVER, HANDOVER_ELSEWHERE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'LAND_OFFICER', ['land.manage', 'land.process', 'land.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'LAND_PROCESS', ['land.process'], 30);
    await harness.seedRole(TENANT_A, 4, 'LAND_HANDOVER', ['land.handover'], 30);
    await harness.seedRole(TENANT_B, 1, 'LAND_OFFICER', ['land.manage', 'land.process', 'land.read'], 40);
    await harness.seedRole(TENANT_B, 2, 'LAND_HANDOVER', ['land.handover'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    worldB = await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_OFFICER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: PROJECT_OFFICER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
      { n: 5, member: PROCESS_ELSEWHERE, role: 2, kind: 'TENANT' },
      { n: 6, member: PROCESS_ELSEWHERE, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 7, member: PROCESS_ONLY, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 8, member: HANDOVER, role: 4, kind: 'TENANT' },
      { n: 9, member: HANDOVER, role: 2, kind: 'TENANT' },
      { n: 10, member: HANDOVER_ELSEWHERE, role: 2, kind: 'TENANT' },
      { n: 11, member: HANDOVER_ELSEWHERE, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: B_OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: B_OFFICER, role: 2, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LandSectionController, LandParcelController, LandParcelImportController, LandReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of LND', () => {
    expect(lndModule.code).toBe('LND');
    expect(lndModule.controllers).toEqual([LandSectionController, LandParcelController, LandParcelImportController, LandReadsController, LandStageProgressController, AffectedHouseholdController, AffectedHouseholdReadsController, LandInventoryController, LandInventoryReadsController, CompensationPlanController, CompensationPlanReadsController, CompensationPlanPostingController, CompensationPlanPostingReadsController, CompensationPaymentController, CompensationPaymentReadsController]);
  });

  describe('createLandSection', () => {
    it('creates a NOT_READY section for the land office of the project, audits it and tells the world with ids only', async () => {
      const body = { contract_id: world.contract, from_km: '0', to_km: '3', required_area_m2: '30000', target_date: '2027-03-01' };
      const done = await createSection(OFFICER, body);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'NOT_READY', resource_version: 1 });
      const id = done.json.resource_id as string;
      const [section] = await rows<Record<string, unknown>>('select status, handed_area_m2::text as handed, required_area_m2::text as required, contract_id, created_by from machvon.land_handover_section where id = $1::uuid', [id]);
      expect(section).toEqual({ status: 'NOT_READY', handed: '0.00', required: '30000.00', contract_id: world.contract, created_by: memberId(OFFICER) });
      const [audit] = await audits(id, 'land.section_created');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(OFFICER), safe_diff: { project_id: world.project, contract_id: world.contract, required_area_m2: '30000.00', status: 'NOT_READY' } });
      const [event] = await events(id, 'lnd.section.created.v1');
      expect(event?.payload).toMatchObject({ section_id: id, project_id: world.project, contract_id: world.contract, handed_area_m2: '0.00', tenant_id: TENANT_A });
    });

    it('answers a repeated request with the first answer and creates one section', async () => {
      const key = `key-${randomUUID()}`;
      const extra = { code: code('IDEM') };
      const first = await createSection(OFFICER, extra, { key });
      const second = await createSection(OFFICER, extra, { key });
      expect(second.status).toBe(200);
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.land_handover_section where code = $1', [extra.code])).toHaveLength(1);
    });

    it('refuses the same code twice with 409 SECTION_CODE_DUPLICATE', async () => {
      const extra = { code: code('DUP') };
      expect((await createSection(OFFICER, extra)).status).toBe(200);
      const again = await createSection(OFFICER, extra);
      expect([again.status, again.json.code]).toEqual([409, 'SECTION_CODE_DUPLICATE']);
    });

    it('wants a project that exists, a contract of that project and a figure that is a figure', async () => {
      expect((await createSection(OFFICER, {}, { projectId: randomUUID() })).status).toBe(404);
      const foreign = await createSection(OFFICER, { contract_id: world.foreignContract });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const wide = await createSection(OFFICER, { required_area_m2: '1000000000000' });
      expect([wide.status, wide.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('lets the unit tree of the project and a grant on the project in, and turns the rest away with 403 SCOPE_DENIED', async () => {
      expect((await createSection(DEPARTMENT_OFFICER)).status).toBe(200);
      expect((await createSection(PROJECT_OFFICER)).status).toBe(200);
      const elsewhere = await createSection(PROCESS_ELSEWHERE);
      expect(elsewhere.status).toBe(403);
      const reader = await createSection(READER);
      expect(reader.status).toBe(403);
      expect((await createSection(NOBODY)).status).toBe(403);
    });

    it('does not see a project of another tenant, and takes no field beyond the allowlist (status, tenant, handed area)', async () => {
      expect((await createSection(OFFICER, {}, { projectId: worldB.project })).status).toBe(404);
      for (const field of ['status', 'tenant_id', 'handed_area_m2', 'version']) {
        const refused = await createSection(OFFICER, { [field]: field === 'status' ? 'HANDED_OVER' : '1' });
        expect([refused.status, refused.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
    });
  });

  describe('createLandParcel (a parcel has no owner)', () => {
    it('creates a SURVEYED parcel at version 1 and keeps the address and the outline out of the trail and the event', async () => {
      const ring = [[[0, 0], [0, 1], [1, 1], [0, 0]]];
      const done = await createParcel(OFFICER, { address_text: `Hamlet 3, plot of ${PERSON}`, boundary_geojson: { type: 'Polygon', coordinates: ring }, ward_master_version_id: world.ward });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'SURVEYED', resource_version: 1 });
      expect(JSON.stringify(done.json)).not.toContain(PERSON);
      const id = done.json.resource_id as string;
      expect(await parcelRow(id)).toMatchObject({ status: 'SURVEYED', version: '1', owner_unit_id: unitId(DEPARTMENT), notice_days_applied: null });
      const [audit] = await audits(id, 'land.parcel_created');
      expect(audit?.safe_diff).toMatchObject({ project_id: world.project, owner_unit_id: unitId(DEPARTMENT), land_use_group: 'AGRICULTURAL', area_total_m2: '1200.50', area_affected_m2: '800.00', status: 'SURVEYED' });
      const [event] = await events(id, 'lnd.parcel.created.v1');
      expect(event?.payload).toMatchObject({ parcel_id: id, project_id: world.project, owner_unit_id: unitId(DEPARTMENT), land_use_group: 'AGRICULTURAL', tenant_id: TENANT_A });
      expect(JSON.stringify([audit, event])).not.toMatch(/Hamlet|Polygon|coordinates|Nguy/);
    });

    it('AC-ST-LND-001-2: takes no field that could name an owner or a user of the land: the body is an allowlist and the table has no such column', async () => {
      for (const field of ['owner_name', 'owner', 'household_id', 'household_head', 'national_id', 'cccd', 'phone', 'user_id', 'holder_name', 'owner_user_id']) {
        const before = await countParcels();
        const refused = await createParcel(OFFICER, { [field]: PERSON });
        expect([refused.status, refused.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
        expect(await countParcels()).toBe(before);
      }
      const geometryWithOwner = await createParcel(OFFICER, { boundary_geojson: { type: 'Polygon', coordinates: [], properties: { owner: PERSON } } });
      expect([geometryWithOwner.status, geometryWithOwner.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const columns = await rows<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'machvon' and table_name = 'land_parcel' and column_name ~ '(holder|household|national_id|phone|head_name|user_id|person|owner_name|email)'");
      expect(columns).toEqual([]);
    });

    it('refuses a code twice in a project with 409 PARCEL_CODE_DUPLICATE and an area that cannot be a parcel with 422 AREA_INVALID', async () => {
      const extra = { parcel_code: code('LP-DUP') };
      expect((await createParcel(OFFICER, extra)).status).toBe(200);
      const again = await createParcel(OFFICER, { parcel_code: extra.parcel_code.toLowerCase() });
      expect([again.status, again.json.code]).toEqual([409, 'PARCEL_CODE_DUPLICATE']);
      const area = await createParcel(OFFICER, { area_total_m2: '100', area_affected_m2: '101' });
      expect([area.status, area.json.code]).toEqual([422, 'AREA_INVALID']);
      const zero = await createParcel(OFFICER, { area_total_m2: '0', area_affected_m2: '0' });
      expect([zero.status, zero.json.code]).toEqual([422, 'AREA_INVALID']);
    });

    it('wants a project, a unit, a section and a ward that are what they say', async () => {
      expect((await createParcel(OFFICER, {}, { projectId: randomUUID() })).status).toBe(404);
      expect((await createParcel(OFFICER, { owner_unit_id: randomUUID() })).status).toBe(404);
      const section = await createSection(OFFICER);
      const own = await createParcel(OFFICER, { section_id: section.json.resource_id });
      expect(own.status).toBe(200);
      const foreignSection = await createSection(OFFICER, {}, { projectId: world.otherProject });
      const wrong = await createParcel(OFFICER, { section_id: foreignSection.json.resource_id });
      expect([wrong.status, wrong.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const ward = await createParcel(OFFICER, { ward_master_version_id: world.retiredWard });
      expect([ward.status, ward.json.code]).toEqual([422, 'MASTER_NOT_EFFECTIVE']);
    });

    it('lets the unit tree of the unit that answers for the parcel in, and a grant on the project, but not a caller whose tree does not reach that unit', async () => {
      expect((await createParcel(DEPARTMENT_OFFICER)).status).toBe(200);
      const elsewhere = await createParcel(DEPARTMENT_OFFICER, { owner_unit_id: unitId(ELSEWHERE) });
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await createParcel(PROJECT_OFFICER, { owner_unit_id: unitId(ELSEWHERE) })).status).toBe(200);
      expect((await createParcel(READER)).status).toBe(403);
      expect((await createParcel(NOBODY)).status).toBe(403);
    });

    it('does not see a project or a unit of another tenant', async () => {
      expect((await createParcel(OFFICER, {}, { projectId: worldB.project })).status).toBe(404);
      expect((await createParcel(B_OFFICER, {}, { tenantId: TENANT_B, projectId: worldB.project })).status).toBe(200);
      expect((await createParcel(B_OFFICER, {}, { tenantId: TENANT_B, projectId: world.project })).status).toBe(404);
    });
  });

  describe('recordRecoveryNotice (AC-ST-LND-001-1, UAT-AC376)', () => {
    it('AC-ST-LND-001-1: starts 90 days for agricultural land and 180 for the rest from the same notice date, and tells the rule it stands on', async () => {
      const agricultural = await createParcel(OFFICER, { parcel_code: 'LP-A-001', land_use_group: 'AGRICULTURAL' });
      const residential = await createParcel(OFFICER, { parcel_code: 'LP-A-002', land_use_group: 'NON_AGRICULTURAL_RESIDENTIAL' });
      const first = await noticeOf(OFFICER, agricultural.json.resource_id as string, 1);
      const second = await noticeOf(OFFICER, residential.json.resource_id as string, 1);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'SURVEYED', resource_version: 2, resource_id: agricultural.json.resource_id });
      expect(second.status).toBe(200);
      const deadlines = await rows<{ subject_id: string; timer_code: string; days_applied: number; due_on: string; status: string; rule_version_id: string }>(
        'select subject_id, timer_code, days_applied, due_on::text as due_on, status, rule_version_id from machvon.land_deadline where subject_id = any($1::uuid[]) order by days_applied',
        [[agricultural.json.resource_id, residential.json.resource_id]],
      );
      expect(deadlines).toEqual([
        expect.objectContaining({ subject_id: agricultural.json.resource_id, timer_code: 'NOTICE_AGRICULTURAL_90', days_applied: 90, due_on: '2026-09-29', status: 'RUNNING' }),
        expect.objectContaining({ subject_id: residential.json.resource_id, timer_code: 'NOTICE_NON_AGRICULTURAL_180', days_applied: 180, due_on: '2026-12-28', status: 'RUNNING' }),
      ]);
      expect(await parcelRow(agricultural.json.resource_id as string)).toMatchObject({ recovery_notice_on: '2026-07-01', notice_days_applied: 90, version: '2', notice_document_version_id: world.cleanDocument });
      const [audit] = await audits(agricultural.json.resource_id as string, 'land.recovery_notice_recorded');
      expect(audit?.safe_diff).toMatchObject({ timer_code: 'NOTICE_AGRICULTURAL_90', notice_on: '2026-07-01', days_applied: 90, due_on: '2026-09-29', rule_version_id: deadlines[0]?.rule_version_id, notice_document_version_id: world.cleanDocument });
      const [event] = await events(agricultural.json.resource_id as string, 'lnd.parcel.notice_recorded.v1');
      expect(event?.payload).toMatchObject({ timer_code: 'NOTICE_AGRICULTURAL_90', due_on: '2026-09-29', days_applied: 90, parcel_id: agricultural.json.resource_id });
    });

    it('AC-ST-LND-001-1: an earlier decision to recover is blocked by the database, whoever writes it, until the end of the notice', async () => {
      const parcel = await createParcel(OFFICER, { land_use_group: 'AGRICULTURAL' });
      const id = parcel.json.resource_id as string;
      await noticeOf(OFFICER, id, 1);
      const early = await harness
        .owner(TENANT_A, [["update machvon.land_parcel set recovery_decision_on = date '2026-09-28' where id = $1::uuid", [id]]])
        .then(() => 'accepted', (error: { message: string }) => error.message);
      expect(early).toContain('land_parcel_notice_chk');
      await harness.owner(TENANT_A, [["update machvon.land_parcel set recovery_decision_on = date '2026-09-29' where id = $1::uuid", [id]]]);
      expect((await parcelRow(id)).status).toBe('SURVEYED');
    });

    it('wants If-Match, the current version and a notice that has not been given yet', async () => {
      const parcel = await createParcel(OFFICER);
      const id = parcel.json.resource_id as string;
      const missing = await call('POST', `/land-parcels/${id}/recovery-notice`, { member: OFFICER, body: { notice_on: '2026-07-01', notice_document_version_id: world.cleanDocument } });
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await noticeOf(OFFICER, id, 7);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await noticeOf(OFFICER, id, 1)).status).toBe(200);
      const again = await noticeOf(OFFICER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'PARCEL_STATE_INVALID']);
    });

    it('refuses a date in the future, a document that is not clean or not there, and a day with no rule in force (TIMER_RULE_UNCONFIRMED)', async () => {
      const parcel = await createParcel(OFFICER);
      const id = parcel.json.resource_id as string;
      expect((await noticeOf(OFFICER, id, 1, { notice_on: '2999-01-01' })).json.code).toBe('VALIDATION_FAILED');
      const pending = await noticeOf(OFFICER, id, 1, { notice_document_version_id: world.pendingDocument });
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      expect((await noticeOf(OFFICER, id, 1, { notice_document_version_id: randomUUID() })).json.code).toBe('VALIDATION_FAILED');
      const early = await noticeOf(OFFICER, id, 1, { notice_on: '2024-12-31' });
      expect([early.status, early.json.code]).toEqual([422, 'TIMER_RULE_UNCONFIRMED']);
      expect(await rows('select 1 from machvon.land_deadline where subject_id = $1::uuid', [id])).toEqual([]);
      expect((await parcelRow(id)).recovery_notice_on).toBeNull();
    });

    it('answers TIMER_RULE_UNCONFIRMED in a tenant whose rules have not been published', async () => {
      const parcel = await createParcel(B_OFFICER, {}, { tenantId: TENANT_B, projectId: worldB.project });
      const done = await call('POST', `/land-parcels/${parcel.json.resource_id as string}/recovery-notice`, {
        member: B_OFFICER,
        tenantId: TENANT_B,
        ifMatch: '"1"',
        body: { notice_on: '2026-07-01', notice_document_version_id: worldB.cleanDocument },
      });
      expect([done.status, done.json.code]).toEqual([422, 'TIMER_RULE_UNCONFIRMED']);
    });

    it('does not show a parcel to a caller who cannot see it (404), and refuses one who sees it and may not act on it (403)', async () => {
      const mine = await createParcel(OFFICER, { owner_unit_id: unitId(DEPARTMENT) });
      const id = mine.json.resource_id as string;
      // The department officer sees the parcels of the department; the officer of the other branch has no read over it at all.
      const hidden = await noticeOf(PROCESS_ELSEWHERE, id, 1);
      expect([hidden.status, hidden.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const other = await createParcel(OFFICER, { owner_unit_id: unitId(ELSEWHERE) });
      const elsewhere = await noticeOf(DEPARTMENT_OFFICER, other.json.resource_id as string, 1);
      expect([elsewhere.status, elsewhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await noticeOf(OFFICER, randomUUID(), 1)).status).toBe(404);
      const unreadable = await noticeOf(READER, id, 1);
      expect(unreadable.status).toBe(403);
      expect((await parcelRow(id)).recovery_notice_on).toBeNull();
      expect((await noticeOf(DEPARTMENT_OFFICER, id, 1)).status).toBe(200);
    });

    it('lets the officer who may only process the parcels of a unit give the notice of a parcel of that unit, and not see one of another unit', async () => {
      const mine = await createParcel(OFFICER, { owner_unit_id: unitId(DEPARTMENT) });
      const other = await createParcel(OFFICER, { owner_unit_id: unitId(ELSEWHERE) });
      const hidden = await noticeOf(PROCESS_ONLY, other.json.resource_id as string, 1);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await noticeOf(PROCESS_ONLY, mine.json.resource_id as string, 1)).status).toBe(200);
    });

    it('does not reach a parcel of another tenant', async () => {
      const foreign = await createParcel(B_OFFICER, {}, { tenantId: TENANT_B, projectId: worldB.project });
      expect((await noticeOf(OFFICER, foreign.json.resource_id as string, 1)).status).toBe(404);
    });

    it('takes no field beyond the date and the notice document', async () => {
      const parcel = await createParcel(OFFICER);
      const refused = await noticeOf(OFFICER, parcel.json.resource_id as string, 1, { days_applied: 1 });
      expect([refused.status, refused.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });
  });

  describe('importLandParcels (AC-ST-LND-001-2, UAT-PLAN-28)', () => {
    it('AC-ST-LND-001-2: imports a parcel list once; the same file a second time creates nothing and answers ALREADY_IMPORTED', async () => {
      const bytes = bytesOf(HEADER, 'IMP-1,U2,AGRICULTURAL,1200.5,800,Hamlet 3,', 'IMP-2,U2,NON_AGRICULTURAL_RESIDENTIAL,300,300,,');
      const file = await upload(bytes);
      const first = await importFile(OFFICER, file);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'APPLIED', result: 'APPLIED', duplicate: false, row_total: 2, row_created: 2, row_refused: 0 });
      const before = await countParcels();
      const second = await importFile(OFFICER, file);
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ status: 'ALREADY_IMPORTED', result: 'ALREADY_IMPORTED', duplicate: true, resource_id: first.json.resource_id });
      expect(await countParcels()).toBe(before);
      expect(await rows('select 1 from machvon.land_parcel where project_id = $1::uuid and parcel_code in ($2, $3)', [world.project, 'IMP-1', 'IMP-2'])).toHaveLength(2);
      const [audit] = await audits(first.json.resource_id as string, 'land.parcels_imported');
      expect(audit?.safe_diff).toMatchObject({ project_id: world.project, file_sha256: file.sha, row_created: 2 });
      expect(JSON.stringify(audit)).not.toContain('Hamlet');
      expect(await audits(first.json.resource_id as string, 'land.parcels_import_repeated')).toHaveLength(1);
      expect(await events(first.json.resource_id as string, 'lnd.parcel.imported.v1')).toHaveLength(1);
    });

    it('answers a repeated request with the first answer, and two requests at once give one application', async () => {
      const file = await upload(bytesOf(HEADER, 'IMP-R1,U2,AGRICULTURAL,100,50,,', 'IMP-R2,U2,AGRICULTURAL,100,50,,'));
      const key = `key-${randomUUID()}`;
      const settled = await Promise.all([importFile(OFFICER, file, { key }), importFile(OFFICER, file), importFile(OFFICER, file)]);
      expect(settled.every((reply) => reply.status === 200)).toBe(true);
      expect(settled.filter((reply) => reply.json.result === 'APPLIED').length).toBe(1);
      expect(await rows('select 1 from machvon.land_parcel where project_id = $1::uuid and parcel_code like $2', [world.project, 'IMP-R%'])).toHaveLength(2);
    });

    it('AC-ST-LND-001-2: refuses a file that carries a column for an owner or a user of the land, and creates no parcel', async () => {
      const before = await countParcels();
      const file = await upload(bytesOf(`${HEADER},owner_name`, `IMP-O1,U2,AGRICULTURAL,100,50,,,${PERSON}`));
      const refused = await importFile(OFFICER, file);
      expect([refused.status, refused.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      expect(await countParcels()).toBe(before);
    });

    it('reports the rows it could not take and takes the others, without ever showing the address of a refused row', async () => {
      const file = await upload(bytesOf(HEADER, 'IMP-Q1,U2,AGRICULTURAL,100,50,,', `IMP-Q2,NOUNIT,AGRICULTURAL,100,50,Home of ${PERSON},`, 'IMP-Q3,U2,FOREST,100,50,,'));
      const done = await importFile(OFFICER, file);
      expect(done.json).toMatchObject({ status: 'PARTIALLY_APPLIED', row_total: 3, row_created: 1, row_refused: 2 });
      const quarantine = await rows<{ error_code: string; masked_preview: Record<string, string> | null }>('select error_code, masked_preview from machvon.file_import_quarantine where import_id = $1::uuid order by line', [done.json.resource_id]);
      expect(quarantine.map((row) => row.error_code)).toEqual(['UNIT_NOT_FOUND', 'LAND_USE_GROUP_INVALID']);
      expect(JSON.stringify(quarantine)).not.toContain(PERSON);
    });

    it('wants the hash that was recorded, a file that exists and a file that is clean', async () => {
      const file = await upload(bytesOf(HEADER, 'IMP-H1,U2,AGRICULTURAL,100,50,,'));
      const mismatch = await importFile(OFFICER, file, { sha: 'a'.repeat(64) });
      expect([mismatch.status, mismatch.json.code]).toEqual([422, 'HASH_MISMATCH']);
      expect((await importFile(OFFICER, { id: randomUUID(), sha: file.sha })).status).toBe(404);
      const infected = await upload(eicarBytes());
      const unclean = await importFile(OFFICER, infected);
      expect([unclean.status, unclean.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      expect(await rows('select 1 from machvon.land_parcel where parcel_code = $1', ['IMP-H1'])).toEqual([]);
    });

    it('is for whoever holds land.manage over the whole project or the whole tenant: a unit tree is not enough, a grant on the project is', async () => {
      const file = await upload(bytesOf(HEADER, 'IMP-S1,U2,AGRICULTURAL,100,50,,'));
      const unit = await importFile(DEPARTMENT_OFFICER, file);
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select 1 from machvon.land_parcel where parcel_code = $1', ['IMP-S1'])).toEqual([]);
      // The refused call left no claim on the file: the project officer can still import the same bytes.
      expect((await importFile(PROJECT_OFFICER, file)).json).toMatchObject({ result: 'APPLIED', row_created: 1 });
      expect((await importFile(READER, file)).status).toBe(403);
      expect((await importFile(NOBODY, file)).status).toBe(403);
    });

    it('does not see a project of another tenant, and takes no field beyond the allowlist', async () => {
      const file = await upload(bytesOf(HEADER, 'IMP-F1,U2,AGRICULTURAL,100,50,,'));
      expect((await importFile(OFFICER, file, { projectId: worldB.project })).status).toBe(404);
      const extra = await call('POST', '/land-parcels/import', { member: OFFICER, body: { project_id: world.project, file_object_id: file.id, file_sha256: file.sha, mapping: {} } });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });
  });

  describe('listLandParcels and listLandSections (LND-02)', () => {
    it('lists the parcels of a project by code with the timer of the notice, and nothing about a person', async () => {
      const created = await createParcel(OFFICER, { parcel_code: 'RD-1', land_use_group: 'AGRICULTURAL', address_text: 'Hamlet 3' });
      await noticeOf(OFFICER, created.json.resource_id as string, 1);
      const listed = await get(OFFICER, `/land-parcels?project_id=${world.project}`);
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<Record<string, unknown>>;
      const mine = items.find((item) => item.parcel_code === 'RD-1') as Record<string, unknown>;
      expect(mine).toMatchObject({ id: created.json.resource_id, project_id: world.project, land_use_group: 'AGRICULTURAL', status: 'SURVEYED', recovery_notice_on: '2026-07-01', notice_days_applied: 90, version: 2 });
      expect(mine.deadline).toMatchObject({ timer_code: 'NOTICE_AGRICULTURAL_90', due_on: '2026-09-29', status: 'RUNNING', awaiting_confirmation: true, cxn: 'CXN-12' });
      expect(Object.keys(mine).sort()).toEqual(['address_text', 'area_affected_m2', 'area_total_m2', 'deadline', 'has_boundary', 'id', 'land_use_group', 'notice_days_applied', 'owner_unit_id', 'owner_unit_name', 'parcel_code', 'project_id', 'recovery_decision_on', 'recovery_notice_on', 'section_code', 'section_id', 'status', 'version']);
      expect(items.map((item) => item.parcel_code)).toEqual([...items.map((item) => item.parcel_code as string)].sort());
    });

    it('pages by code and filters by status and section', async () => {
      const first = await get(OFFICER, `/land-parcels?project_id=${world.project}&limit=2`);
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await get(OFFICER, `/land-parcels?project_id=${world.project}&limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
      expect((second.json.items as Array<Record<string, unknown>>)[0]?.parcel_code).not.toBe((first.json.items as Array<Record<string, unknown>>)[0]?.parcel_code);
      expect(((await get(OFFICER, `/land-parcels?project_id=${world.project}&status=PAID`)).json.items as unknown[]).length).toBe(0);
      expect((await get(OFFICER, `/land-parcels?project_id=${world.project}&status=NOPE`)).status).toBe(422);
      expect((await get(OFFICER, '/land-parcels')).status).toBe(422);
    });

    it('shows a caller the parcels of their units and of their projects only, and a reader the whole tenant', async () => {
      const other = await createParcel(OFFICER, { parcel_code: 'RD-ELSE', owner_unit_id: unitId(ELSEWHERE) });
      const inDepartment = (await get(DEPARTMENT_OFFICER, `/land-parcels?project_id=${world.project}`)).json.items as Array<Record<string, unknown>>;
      expect(inDepartment.map((item) => item.id)).not.toContain(other.json.resource_id);
      const byProject = (await get(PROJECT_OFFICER, `/land-parcels?project_id=${world.project}`)).json.items as Array<Record<string, unknown>>;
      expect(byProject.map((item) => item.id)).toContain(other.json.resource_id);
      expect(((await get(READER, `/land-parcels?project_id=${world.project}`)).json.items as unknown[]).length).toBeGreaterThan(0);
      expect((await get(NOBODY, `/land-parcels?project_id=${world.project}`)).status).toBe(403);
    });

    it('does not show the parcels of another tenant', async () => {
      const listed = await get(B_OFFICER, `/land-parcels?project_id=${world.project}`, TENANT_B);
      expect(listed.json.items).toEqual([]);
    });

    it('lists the sections of a project by code in the scope of the caller', async () => {
      const section = await createSection(OFFICER, { code: 'RD-SEC' });
      const listed = (await get(OFFICER, `/land-sections?project_id=${world.project}`)).json.items as Array<Record<string, unknown>>;
      expect(listed.find((item) => item.code === 'RD-SEC')).toMatchObject({ id: section.json.resource_id, status: 'NOT_READY', handed_area_m2: '0.00', required_area_m2: '30000.00' });
      expect(((await get(PROCESS_ELSEWHERE, `/land-sections?project_id=${world.project}`)).json.items as unknown[]).length).toBeGreaterThan(0);
      expect((await get(OFFICER, '/land-sections?project_id=nope')).status).toBe(422);
    });
  });

  describe('uploadLandParcelFile (AC-ST-LND-001-2)', () => {
    it('stores a clean file with the columns of the layout and answers its id and hash', async () => {
      const bytes = bytesOf(HEADER, 'UP-1,U2,AGRICULTURAL,100,50,,');
      const done = await uploadDoor(OFFICER, bytes);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, format: 'CSV', row_count: 1 });
      expect(done.json.columns).toEqual(HEADER.split(','));
      expect((await importFile(OFFICER, { id: done.json.file_object_id as string, sha: done.json.file_sha256 as string })).json).toMatchObject({ result: 'APPLIED' });
    });

    it('AC-ST-LND-001-2: refuses a file with a column for an owner or a user of the land, names the columns and keeps the file nowhere', async () => {
      const bytes = bytesOf(`${HEADER},owner_name,phone`, `UP-2,U2,AGRICULTURAL,100,50,,,${PERSON},0900000001`);
      const before = (await readdir(root, { recursive: true })).length;
      const refused = await uploadDoor(OFFICER, bytes);
      expect([refused.status, refused.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      expect(refused.json.unknown_columns).toEqual(['owner_name', 'phone']);
      expect(JSON.stringify(refused.json)).not.toContain(PERSON);
      // The file was stored to be scanned and removed again: the store holds what it held before.
      expect((await readdir(root, { recursive: true })).length).toBe(before);
    });

    it('refuses an infected file, something that is not a table, a missing column, and a caller without land.manage', async () => {
      expect((await uploadDoor(OFFICER, eicarBytes())).json.code).toBe('FILE_NOT_CLEAN');
      expect((await uploadDoor(OFFICER, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).json.code).toBe('IMPORT_SCHEMA_INVALID');
      const missing = await uploadDoor(OFFICER, bytesOf('parcel_code,owner_unit_code', 'A,U2'));
      expect(missing.json.missing_columns).toEqual(['land_use_group', 'area_total_m2', 'area_affected_m2']);
      expect((await uploadDoor(READER, bytesOf(HEADER, 'UP-3,U2,AGRICULTURAL,100,50,,'))).status).toBe(403);
    });
  });
  describe('recordSectionHandover (AC-ST-LND-009-1, UAT-AC386)', () => {
    const hand = (member: number, sectionId: string, version: number | string, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
      call('POST', `/land-sections/${sectionId}/handover`, {
        member,
        ifMatch: `"${version}"`,
        ...(tenantId === undefined ? {} : { tenantId }),
        body: { handed_area_m2: '18000', handed_over_on: '2026-10-20', handover_document_version_id: world.cleanDocument, ...extra },
      });
    const sectionOf = async (sectionId: string) =>
      (
        await rows<{ status: string; handed_area_m2: string; handed_over_on: string | null; handover_document_version_id: string | null; version: string }>(
          'select status, handed_area_m2::text, handed_over_on::text, handover_document_version_id, version::text from machvon.land_handover_section where id = $1::uuid',
          [sectionId],
        )
      )[0];
    const newSection = async (extra: Record<string, unknown> = {}): Promise<string> => (await createSection(OFFICER, { contract_id: world.contract, ...extra })).json.resource_id as string;
    const contractWith = async (status: string, category = 'CONSTRUCTION'): Promise<string> => {
      const contractId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, advance_category)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 1000, date '2026-01-01', $8::date, $9)`,
          [TENANT_A, contractId, world.project, id(FAMILY, 51), id(FAMILY, 50), code('HD-H'), status, status === 'SIGNED' ? null : '2026-01-01', category],
        ],
      ]);
      return contractId;
    };

    it('hands the land over in steps for a contract that is active: PARTIAL, then HANDED_OVER, with the audit row and the event the contracts read', async () => {
      const sectionId = await newSection();
      const first = await hand(HANDOVER, sectionId, 1);
      expect(first).toMatchObject({ status: 200, json: { status: 'PARTIAL', resource_version: 2, resource_id: sectionId } });
      expect(await sectionOf(sectionId)).toEqual({ status: 'PARTIAL', handed_area_m2: '18000.00', handed_over_on: '2026-10-20', handover_document_version_id: world.cleanDocument, version: '2' });
      const last = await hand(HANDOVER, sectionId, 2, { handed_area_m2: '30000', handed_over_on: '2026-10-22' });
      expect(last).toMatchObject({ status: 200, json: { status: 'HANDED_OVER', resource_version: 3 } });
      expect((await sectionOf(sectionId))?.handed_area_m2).toBe('30000.00');

      const trail = await audits(sectionId, 'land.section_handed_over');
      expect(trail).toHaveLength(2);
      expect(trail[1]).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(HANDOVER), safe_diff: { from_status: 'PARTIAL', status: 'HANDED_OVER', previous_handed_area_m2: '18000.00', handed_area_m2: '30000.00', contract_id: world.contract } });
      const handed = await events(sectionId, 'lnd.section.handed_over.v1');
      expect(handed).toHaveLength(2);
      expect(handed[1]?.payload).toMatchObject({ section_id: sectionId, project_id: world.project, contract_id: world.contract, status: 'HANDED_OVER', handed_area_m2: '30000.00', required_area_m2: '30000.00', handed_over_on: '2026-10-22', version: 3, actor_id: memberId(HANDOVER) });
    });

    it('UAT-AC386: refuses 30000.01 against 30000.00 needed (422 HANDED_AREA_EXCEEDS_REQUIRED) and a contract that is only signed (409 CONTRACT_STATE_INVALID), and changes nothing', async () => {
      const sectionId = await newSection();
      expect(await hand(HANDOVER, sectionId, 1, { handed_area_m2: '30000.01' })).toMatchObject({ status: 422, json: { code: 'HANDED_AREA_EXCEEDS_REQUIRED' } });
      const signed = await contractWith('SIGNED');
      const second = await newSection({ contract_id: signed, required_area_m2: '28000' });
      expect(await hand(HANDOVER, second, 1, { handed_area_m2: '10000' })).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID', contract_status: 'SIGNED' } });
      expect((await sectionOf(sectionId))?.status).toBe('NOT_READY');
      expect((await sectionOf(second))?.status).toBe('NOT_READY');
      expect(await audits(sectionId, 'land.section_handed_over')).toEqual([]);
      expect(await events(second, 'lnd.section.handed_over.v1')).toEqual([]);
    });

    it('is for a contract that builds, and for the area, the day and the document of a real handover', async () => {
      const bare = (await createSection(OFFICER)).json.resource_id as string;
      expect(await hand(HANDOVER, bare, 1)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const consulting = await newSection({ contract_id: await contractWith('ACTIVE', 'CONSULTING') });
      expect(await hand(HANDOVER, consulting, 1)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const target = await newSection();
      await hand(HANDOVER, target, 1);
      expect(await hand(HANDOVER, target, 2, { handed_area_m2: '18000' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await hand(HANDOVER, target, 2, { handed_area_m2: '20000', handed_over_on: '2026-10-19' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await hand(HANDOVER, target, 2, { handed_area_m2: '20000', handover_document_version_id: world.pendingDocument })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await hand(HANDOVER, target, 1, { handed_area_m2: '20000' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await hand(HANDOVER, target, 2, { handed_area_m2: '20000', status: 'HANDED_OVER' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await hand(HANDOVER, target, 2, { handed_area_m2: '20000', tenant_id: TENANT_B })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await sectionOf(target))?.handed_area_m2).toBe('18000.00');
    });

    it('hands the paid parcels over with the last of the area, and refuses it while a parcel is not paid', async () => {
      const sectionId = await newSection({ required_area_m2: '1000' });
      const paid = (await createParcel(OFFICER, { section_id: sectionId })).json.resource_id as string;
      const waiting = (await createParcel(OFFICER, { section_id: sectionId })).json.resource_id as string;
      await rows("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [paid]);
      expect(await hand(HANDOVER, sectionId, 1, { handed_area_m2: '1000' })).toMatchObject({ status: 422, json: { code: 'PARCELS_NOT_READY' } });
      expect((await sectionOf(sectionId))?.status).toBe('NOT_READY');
      await rows("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [waiting]);
      expect(await hand(HANDOVER, sectionId, 1, { handed_area_m2: '1000' })).toMatchObject({ status: 200, json: { status: 'HANDED_OVER' } });
      expect((await parcelRow(paid)).status).toBe('HANDED_OVER');
      expect((await parcelRow(waiting)).status).toBe('HANDED_OVER');
      const [audit] = await audits(sectionId, 'land.section_handed_over');
      expect(audit?.safe_diff).toMatchObject({ parcels_handed_over: 2 });
    });

    it('is for whoever holds land.handover over the project: a reader and an officer of another branch are refused, a section of another tenant does not exist', async () => {
      const sectionId = await newSection();
      expect((await hand(READER, sectionId, 1)).status).toBe(403);
      expect((await hand(OFFICER, sectionId, 1)).status).toBe(403);
      expect((await hand(HANDOVER_ELSEWHERE, sectionId, 1)).status).toBe(403);
      expect((await hand(NOBODY, sectionId, 1)).status).toBe(403);
      expect((await hand(HANDOVER, randomUUID(), 1)).status).toBe(404);
      expect((await hand(B_OFFICER, sectionId, 1, {}, TENANT_B)).status).toBe(404);
      expect((await sectionOf(sectionId))?.status).toBe('NOT_READY');
    });
  });
});
