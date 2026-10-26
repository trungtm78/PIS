import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndParcelStore, TenantDatabase, WORKER_MEMBERSHIP_ID, readIntake } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { LandComplaintController, LandComplaintReadsController, complaintLineView } from '../../src/modules/lnd/complaint.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const FILER = 1; // land.complaint.write and land.read on the whole tenant
const RESOLVER = 2; // land.complaint.resolve and land.read on the whole tenant
const DEPARTMENT_OFFICER = 3; // both rights on the unit tree of the department only
const PROJECT_OFFICER = 4; // both rights on project 1 only: it reaches the project and no household
const READER = 5; // land.read on the whole tenant
const NOBODY = 6;
const OFFICER = 7; // registers households and parcels (through the stores)
const B_FILER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xc4;
const FAMILY_B = 0xc5;
const WORKER = WORKER_MEMBERSHIP_ID;
const BASIS = 'Luật Đất đai 2024, Điều 87';
const WORDS = 'Nguyễn Văn A says that the price of the house is far too low';
const TODAY = vietnamDateOf(new Date());
const daysAgo = (days: number): string => vietnamDateOf(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
const daysAhead = (days: number): string => vietnamDateOf(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the complaints of the households about the clearance of their land (ST-LND-008)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const parcels = new LndParcelStore();
  let app: RunningApp;
  let world: LndWorld;
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
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> =>
    harness.owner<R>(tenant, [
      ["select set_config('app.scope_units', '*', false)", []],
      [sql, params],
    ]);
  const context = (member: number) => ({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 });

  interface Target {
    householdId: string;
    parcelId: string;
  }
  async function target(unit = DEPARTMENT): Promise<Target> {
    counter += 1;
    const tenants = harness.tenants as TenantDatabase;
    const registered = await tenants.withTenant(context(OFFICER), (tx) =>
      households.register(tx, { projectId: world.project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(950000000000 + counter * 43), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' }, memberId(OFFICER), '*', TODAY),
    );
    const parcel = await tenants.withTenant(context(OFFICER), (tx) =>
      parcels.create(tx, { projectId: world.project, ownerUnitId: unitId(unit), parcelCode: `LP-D-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
    );
    await tenants.withTenant(context(OFFICER), (tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), '*'));
    return { householdId: registered.id, parcelId: parcel.id };
  }

  const fileBody = (aim: Target, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: world.project,
    household_id: aim.householdId,
    owner_unit_id: unitId(DEPARTMENT),
    channel: 'MEETING',
    subject: 'PRICE',
    description: WORDS,
    filed_on: daysAgo(10),
    ...extra,
  });
  const file = (member: number, aim: Target, extra: Record<string, unknown> = {}, options: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', '/land-complaints', { member, ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }), ...(options.key === undefined ? {} : { key: options.key }), body: fileBody(aim, extra) });
  const resolve = (member: number, complaintId: string, version: number | string, body: Record<string, unknown> = {}, options: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', `/land-complaints/${complaintId}/resolve`, {
      member,
      ifMatch: `"${version}"`,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { outcome: 'RESOLVED_ACCEPTED', resolution_document_version_id: world.cleanDocument, resolved_on: TODAY, note: 'The price was checked again', ...body },
    });

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const complaintRow = async (id: string) =>
    (await rows<Record<string, unknown>>('select status, version::text as version, complaint_no, due_on::text as due_on, resolved_on::text as resolved_on, description from machvon.land_complaint where id = $1::uuid', [id]))[0];
  const parcelStatus = async (id: string): Promise<string> => ((await rows<{ status: string }>('select status from machvon.land_parcel where id = $1::uuid', [id]))[0] as { status: string }).status;
  const deadlineOf = async (id: string) => (await rows<{ status: string; due_on: string; satisfied_on: string | null }>("select status, due_on::text as due_on, satisfied_on::text as satisfied_on from machvon.land_deadline where subject_id = $1::uuid", [id]))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, '2026-10-24'));
    for (const n of [FILER, RESOLVER, DEPARTMENT_OFFICER, PROJECT_OFFICER, READER, NOBODY, OFFICER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_FILER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'COMPLAINT_FILER', ['land.complaint.write', 'land.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'COMPLAINT_RESOLVER', ['land.complaint.resolve', 'land.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'COMPLAINT_OFFICER', ['land.complaint.write', 'land.complaint.resolve', 'land.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'COMPLAINT_FILER', ['land.complaint.write', 'land.complaint.resolve', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_FILER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: FILER, role: 1, kind: 'TENANT' },
      { n: 2, member: RESOLVER, role: 2, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_OFFICER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: PROJECT_OFFICER, role: 3, kind: 'PROJECT', refs: [world.project] },
      { n: 5, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_FILER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LandComplaintController, LandComplaintReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('fileLandComplaint', () => {
    it('AC-ST-LND-008-1, UAT-AC384: files a complaint with the number, the days of the rule from the day it was filed and a timer, holds the parcels, and asks the intake of ISS for an issue with the number and nothing the complainant said', async () => {
      const aim = await target();
      const done = await file(FILER, aim);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'RECEIVED', resource_version: 1 });
      const id = done.json.resource_id as string;
      expect(await complaintRow(id)).toMatchObject({ status: 'RECEIVED', version: '1', complaint_no: expect.stringMatching(/^LC-\d{6}$/), due_on: daysAhead(20), description: WORDS });
      expect(await deadlineOf(id)).toEqual({ status: 'RUNNING', due_on: daysAhead(20), satisfied_on: null });
      expect(await parcelStatus(aim.parcelId)).toBe('DISPUTED');
      const [audit] = await audits(id, 'lnd.complaint_filed');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(FILER), classification: 'PERSONAL', safe_diff: { project_id: world.project, subject: 'PRICE', channel: 'MEETING', filed_on: daysAgo(10), due_on: daysAhead(20), days_applied: 30, parcels_held: 1 } });
      const [event] = await events(id, 'lnd.complaint.filed.v1');
      expect(event?.payload).toMatchObject({ source_ref_id: id, reference_code: (await complaintRow(id))?.complaint_no, project_id: world.project, owner_unit_id: unitId(DEPARTMENT), subject: 'PRICE', source_module: 'LND', tenant_id: TENANT_A, actor_id: memberId(FILER) });
      expect(readIntake('lnd.complaint.filed.v1', event?.payload as Record<string, unknown>)).toMatchObject({ kind: 'REQUEST', request: { sourceRefId: id, referenceReplaced: false } });
      for (const trail of [audit, event]) {
        expect(JSON.stringify(trail)).not.toContain(WORDS);
        expect(JSON.stringify(trail)).not.toContain('Nguyễn');
        expect(JSON.stringify(trail)).not.toContain(aim.householdId);
      }
    });

    it('AC-ST-LND-007-3 for the complaints: answers a repeated request with the first answer and files once', async () => {
      const aim = await target();
      const key = `key-${randomUUID()}`;
      const first = await file(FILER, aim, {}, { key });
      const second = await file(FILER, aim, {}, { key });
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.land_complaint where household_id = $1::uuid', [aim.householdId])).toHaveLength(1);
      expect(await audits(first.json.resource_id as string, 'lnd.complaint_filed')).toHaveLength(1);
      expect(await events(first.json.resource_id as string, 'lnd.complaint.filed.v1')).toHaveLength(1);
    });

    it('wants its fields (422 VALIDATION_FAILED, 400 for a field it does not know) and a household that is there: HOUSEHOLD_NOT_FOUND', async () => {
      const aim = await target();
      for (const missing of ['project_id', 'household_id', 'owner_unit_id', 'channel', 'subject', 'description', 'filed_on']) {
        const refused = await file(FILER, aim, { [missing]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      for (const [extra, field] of [
        [{ channel: 'SMOKE' }, 'channel'],
        [{ subject: 'WEATHER' }, 'subject'],
        [{ description: '   ' }, 'description'],
        [{ filed_on: daysAhead(2) }, 'filed_on'],
      ] as const) {
        const refused = await file(FILER, aim, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(refused.json.detail).toBe(field);
      }
      const unknown = await file(FILER, aim, { status: 'CLOSED' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const stranger = await file(FILER, aim, { household_id: randomUUID() });
      expect([stranger.status, stranger.json.code, stranger.json.detail]).toEqual([422, 'HOUSEHOLD_NOT_FOUND', 'household_id']);
      const wrongUnit = await file(FILER, aim, { owner_unit_id: unitId(ELSEWHERE) });
      expect([wrongUnit.status, wrongUnit.json.code, wrongUnit.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'owner_unit_id']);
      expect(await rows('select 1 from machvon.land_complaint where household_id = $1::uuid', [aim.householdId])).toEqual([]);
      expect(await parcelStatus(aim.parcelId)).toBe('SURVEYED');
    });

    it('is filed by someone who reaches the project and the unit of the household: a department sees its own, a grant on a project reaches no household, a resolver without the right to file, a reader and nobody are turned away, another tenant does not find the project', async () => {
      const inside = await target();
      const elsewhere = await target(ELSEWHERE);
      expect((await file(DEPARTMENT_OFFICER, inside)).status).toBe(200);
      const hidden = await file(DEPARTMENT_OFFICER, elsewhere, { owner_unit_id: unitId(ELSEWHERE) });
      expect([hidden.status, hidden.json.code]).toEqual([422, 'HOUSEHOLD_NOT_FOUND']);
      const byProject = await file(PROJECT_OFFICER, inside);
      expect([byProject.status, byProject.json.code]).toEqual([422, 'HOUSEHOLD_NOT_FOUND']);
      expect((await file(RESOLVER, inside)).status).toBe(403);
      expect((await file(READER, inside)).status).toBe(403);
      expect((await file(NOBODY, inside)).status).toBe(403);
      expect((await file(B_FILER, inside, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await file(FILER, inside, { project_id: randomUUID() })).status).toBe(404);
    });
  });

  describe('resolveLandComplaint', () => {
    it('AC-ST-LND-008-1, UAT-AC384: refuses an answer without a reply document, records one with it, ends the timer and gives the parcels back, once', async () => {
      const aim = await target();
      const id = (await file(FILER, aim)).json.resource_id as string;
      const missing = await resolve(RESOLVER, id, 1, { resolution_document_version_id: undefined });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'DECISION_DOCUMENT_REQUIRED', 'resolution_document_version_id']);
      expect((await resolve(RESOLVER, id, 1, { resolution_document_version_id: world.pendingDocument })).json.code).toBe('DOCUMENT_NOT_CLEAN');
      expect((await complaintRow(id))?.status).toBe('RECEIVED');
      const done = await resolve(RESOLVER, id, 1);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'RESOLVED_ACCEPTED', resource_version: 2 });
      expect(await complaintRow(id)).toMatchObject({ status: 'RESOLVED_ACCEPTED', resolved_on: TODAY, version: '2' });
      expect(await deadlineOf(id)).toMatchObject({ status: 'SATISFIED', satisfied_on: TODAY });
      expect(await parcelStatus(aim.parcelId)).toBe('SURVEYED');
      const [audit] = await audits(id, 'lnd.complaint_resolved');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(RESOLVER), classification: 'PERSONAL', safe_diff: { outcome: 'RESOLVED_ACCEPTED', from_status: 'RECEIVED', resolved_on: TODAY, late_days: 0, resolution_document_version_id: world.cleanDocument, parcels_released: 1 } });
      const [event] = await events(id, 'lnd.complaint.resolved.v1');
      expect(event?.payload).toMatchObject({ complaint_id: id, status: 'RESOLVED_ACCEPTED', late_days: 0, version: 2 });
      expect(JSON.stringify([audit, event])).not.toContain('The price was checked again');
      expect(JSON.stringify([audit, event])).not.toContain(WORDS);
      const again = await resolve(RESOLVER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'COMPLAINT_STATE_INVALID']);
    });

    it('answers a repeated answer with the first answer: one answer, one audit row, one event', async () => {
      const aim = await target();
      const id = (await file(FILER, aim)).json.resource_id as string;
      const key = `key-${randomUUID()}`;
      const first = await resolve(RESOLVER, id, 1, {}, { key });
      const second = await resolve(RESOLVER, id, 1, {}, { key });
      expect(second.json).toEqual(first.json);
      expect(await audits(id, 'lnd.complaint_resolved')).toHaveLength(1);
      expect(await events(id, 'lnd.complaint.resolved.v1')).toHaveLength(1);
    });

    it('records an answer after the days as late, breaching the timer, and escalates without a document', async () => {
      const late = await target();
      const lateId = (await file(FILER, late, { filed_on: daysAgo(40) })).json.resource_id as string;
      expect((await resolve(RESOLVER, lateId, 1, { outcome: 'RESOLVED_REJECTED' })).status).toBe(200);
      expect(await deadlineOf(lateId)).toMatchObject({ status: 'BREACHED', due_on: daysAgo(10) });
      expect((await audits(lateId, 'lnd.complaint_resolved'))[0]?.safe_diff).toMatchObject({ outcome: 'RESOLVED_REJECTED', late_days: 10 });
      const escalating = await target();
      const escalatedId = (await file(FILER, escalating)).json.resource_id as string;
      const escalated = await resolve(RESOLVER, escalatedId, 1, { outcome: 'ESCALATED', resolution_document_version_id: undefined });
      expect(escalated.json).toMatchObject({ status: 'ESCALATED', resource_version: 2 });
      expect(await parcelStatus(escalating.parcelId)).toBe('DISPUTED');
    });

    it('wants its fields and the units of the complaint: 422 for what is missing or wrong, 409 for a stale version, 404 for a complaint of another unit, another tenant or nobody, 403 for who may not answer', async () => {
      const aim = await target();
      const id = (await file(FILER, aim)).json.resource_id as string;
      for (const field of ['outcome', 'resolved_on', 'note']) {
        const refused = await resolve(RESOLVER, id, 1, { [field]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      const outcome = await resolve(RESOLVER, id, 1, { outcome: 'CLOSED' });
      expect([outcome.status, outcome.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const future = await resolve(RESOLVER, id, 1, { resolved_on: daysAhead(2) });
      expect([future.status, future.json.detail]).toEqual([422, 'resolved_on']);
      const stale = await resolve(RESOLVER, id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const unknown = await resolve(RESOLVER, id, 1, { closed: true });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await resolve(PROJECT_OFFICER, id, 1)).status).toBe(404);
      expect((await resolve(FILER, id, 1)).status).toBe(403);
      expect((await resolve(READER, id, 1)).status).toBe(403);
      expect((await resolve(NOBODY, id, 1)).status).toBe(403);
      expect((await resolve(B_FILER, id, 1, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await resolve(RESOLVER, randomUUID(), 1)).status).toBe(404);
      expect((await resolve(DEPARTMENT_OFFICER, id, 1)).status).toBe(200);
    });
  });

  describe('listLandComplaints', () => {
    it('lists the complaints of a project inside the units of the reader with the words and the days left, and nothing to a grant that reaches no household', async () => {
      const mine = await target();
      const elsewhere = await target(ELSEWHERE);
      const first = (await file(FILER, mine)).json.resource_id as string;
      const second = (await file(FILER, elsewhere, { owner_unit_id: unitId(ELSEWHERE), description: 'Second words' })).json.resource_id as string;
      await resolve(RESOLVER, second, 1, { outcome: 'ESCALATED', resolution_document_version_id: undefined });
      const all = await get(READER, `/land-complaints?project_id=${world.project}`);
      expect(all.status).toBe(200);
      const list = all.json.items as Array<Record<string, unknown>>;
      expect(list.find((line) => line.id === first)).toMatchObject({
        project_id: world.project,
        household_id: mine.householdId,
        owner_unit_id: unitId(DEPARTMENT),
        channel: 'MEETING',
        subject: 'PRICE',
        description: WORDS,
        status: 'RECEIVED',
        due_on: daysAhead(20),
        remaining_days: 20,
        resolved_on: null,
        issue_id: null,
        version: 1,
      });
      expect(list.find((line) => line.id === second)).toMatchObject({ status: 'ESCALATED', remaining_days: null, resolution_note: 'The price was checked again', resolution_document_version_id: null });
      expect(typeof all.json.as_of).toBe('string');
      expect(((await get(DEPARTMENT_OFFICER, `/land-complaints?project_id=${world.project}`)).json.items as Array<{ id: string }>).map((line) => line.id)).not.toContain(second);
      expect(((await get(PROJECT_OFFICER, `/land-complaints?project_id=${world.project}`)).json.items as unknown[]).length).toBe(0);
      expect(((await get(READER, `/land-complaints?project_id=${world.project}&status=ESCALATED`)).json.items as Array<{ id: string }>).map((line) => line.id)).toContain(second);
      expect(((await get(READER, `/land-complaints?project_id=${world.project}&status=ESCALATED`)).json.items as Array<{ id: string }>).map((line) => line.id)).not.toContain(first);
      const page = await get(READER, `/land-complaints?project_id=${world.project}&limit=1`);
      expect(page.json.items).toHaveLength(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await get(READER, `/land-complaints?project_id=${world.project}&limit=1&cursor=${page.json.next_cursor as string}`);
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
      expect(((await get(B_FILER, `/land-complaints?project_id=${world.project}`, TENANT_B)).json.items as unknown[]).length).toBe(0);
      expect((await get(NOBODY, `/land-complaints?project_id=${world.project}`)).status).toBe(403);
      for (const url of ['/land-complaints', '/land-complaints?project_id=nope', `/land-complaints?project_id=${world.project}&status=LOST`, `/land-complaints?project_id=${world.project}&limit=0`]) {
        const refused = await get(READER, url);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });

    it('counts a complaint that is past its day as negative and an answered one as none', () => {
      const line = {
        id: 'c',
        projectId: 'p',
        householdId: 'h',
        householdCode: 'HH',
        planId: null,
        ownerUnitId: 'u',
        complaintNo: 'LC-000001',
        filedOn: '2026-09-01',
        channel: 'LETTER' as const,
        subject: 'AREA' as const,
        description: 'x',
        status: 'UNDER_REVIEW' as const,
        dueOn: '2026-10-01',
        resolvedOn: null,
        resolutionNote: null,
        resolutionDocumentVersionId: null,
        issueId: null,
        version: 1,
      };
      expect(complaintLineView(line, '2026-10-03').remaining_days).toBe(-2);
      expect(complaintLineView({ ...line, status: 'CLOSED' }, '2026-10-03').remaining_days).toBeNull();
    });
  });
});
