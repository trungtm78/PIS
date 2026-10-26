import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { DomainError, FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { lndModule } from '../../src/modules/lnd';
import { createFieldCipher } from '../../src/modules/lnd/field-cipher';
import { AffectedHouseholdController, AffectedHouseholdReadsController, householdLineView } from '../../src/modules/lnd/household.controller';
import { LandInventoryController, LandInventoryReadsController } from '../../src/modules/lnd/inventory.controller';
import { LandParcelController } from '../../src/modules/lnd/parcel.controller';
import { CompensationPlanController, CompensationPlanReadsController } from '../../src/modules/lnd/plan.controller';
import { CompensationPlanPostingController, CompensationPlanPostingReadsController } from '../../src/modules/lnd/plan-posting.controller';
import { FIELD_CIPHER, LND_METRICS } from '../../src/modules/lnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // writes, reads and opens the personal data of the households on the whole tenant (and manages parcels)
const DEPARTMENT_OFFICER = 2; // the same on the unit tree of the department only
const AUDITOR = 3; // reads households on the whole tenant, may not open their personal data
const PROJECT_OFFICER = 4; // the same rights as the officer, on project 1 only: a grant on a project reaches no household
const NOBODY = 5;
const DEPARTMENT_OPENER = 6; // reads households on the whole tenant, opens personal data in the department only
const DPO = 7; // handles the data requests of the households on the whole tenant
const DEPARTMENT_DPO = 8; // the same on the unit tree of the department only
const B_OFFICER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xb6;
const FAMILY_B = 0xb7;
const WORKER = WORKER_MEMBERSHIP_ID;
const HEAD = 'Nguyễn Văn Anh';
const ADDRESS = '12 Lê Lợi, Phường 3, Quận 1';
const PHONE = '0912345678';
const BASIS = 'Luật Đất đai 2024, Điều 87';
const REASON = 'Checking the record before the compensation payment';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the households affected by a land recovery: sealed personal data, masked views and the scope of the unit (ST-LND-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let world: LndWorld;
  let worldB: LndWorld;
  let counter = 0;
  const decrypted: Array<Record<string, string> | undefined> = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const get = (member: number, url: string, tenantId?: string): Promise<Reply> => call('GET', url, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  /** The statement as the owner of the tables sees it: the policy of the scope applies to the owner too, so the scope is put first. */
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> =>
    harness.owner<R>(tenant, [
      ["select set_config('app.scope_units', '*', false)", []],
      [sql, params],
    ]);
  /** An identity number nobody used before, so that a test registers its own household. */
  const nationalId = (): string => `079${String(++counter).padStart(9, '0')}`;

  const register = (member: number, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string; projectId?: string; unit?: number } = {}): Promise<Reply> =>
    call('POST', '/affected-households', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: {
        project_id: options.projectId ?? world.project,
        owner_unit_id: unitId(options.unit ?? DEPARTMENT),
        head_name: HEAD,
        national_id: nationalId(),
        phone: PHONE,
        address_text: ADDRESS,
        member_count: 4,
        policy_beneficiary: false,
        legal_basis: 'PUBLIC_TASK_LAND_LAW',
        legal_basis_ref: BASIS,
        retention_until: '2036-12-31',
        ...extra,
      },
    });
  const parcelIn = async (unit: number): Promise<string> => {
    const done = await call('POST', '/land-parcels', {
      member: OFFICER,
      body: { project_id: world.project, owner_unit_id: unitId(unit), parcel_code: `LP-H-${String(++counter).padStart(5, '0')}`, land_use_group: 'AGRICULTURAL', area_total_m2: '500', area_affected_m2: '300' },
    });
    expect(done.status).toBe(200);
    return done.json.resource_id as string;
  };
  const link = (member: number, householdId: string, parcelId: string, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/affected-households/${householdId}/parcels`, { member, ...(tenantId === undefined ? {} : { tenantId }), body: { parcel_id: parcelId, right_kind: 'OWNER', share_pct: '60', ...extra } });
  const reveal = (member: number, householdId: string, reason: string | null = REASON, tenantId?: string): Promise<Reply> =>
    get(member, `/affected-households/${householdId}/identity${reason === null ? '' : `?reason=${encodeURIComponent(reason)}`}`, tenantId);
  const listOf = (member: number, query = '', projectId = world.project, tenantId?: string): Promise<Reply> => get(member, `/affected-households?project_id=${projectId}${query}`, tenantId);

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  /** Everything the platform keeps about a household outside its sealed columns, as one text: the row, the trail, the events and the stored answers of the commands. */
  const everythingKept = async (householdId: string): Promise<string> => {
    const parts = await Promise.all([
      rows<object>(
        'select id, project_id, owner_unit_id, household_code, head_name, address_text, national_id_masked, phone_masked, national_id_hash::text as hash, legal_basis, legal_basis_ref, status from machvon.affected_household where id = $1::uuid',
        [householdId],
      ),
      rows<object>("select safe_diff from machvon.audit_event where resource_type in ('affected_household', 'household_parcel') and (resource_id = $1 or safe_diff::text like '%' || $1 || '%')", [householdId]),
      rows<object>("select payload from machvon.outbox_event where type like 'lnd.household.%'"),
      rows<object>("select response_ref from machvon.idempotency_record where operation in ('registerAffectedHousehold', 'linkHouseholdParcel', 'handleHouseholdDataRequest')"),
    ]);
    return JSON.stringify(parts);
  };

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
    for (const n of [OFFICER, DEPARTMENT_OFFICER, AUDITOR, PROJECT_OFFICER, NOBODY, DEPARTMENT_OPENER, DPO, DEPARTMENT_DPO]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOUSEHOLD_OFFICER', ['land.manage', 'land.read', 'land.household.write', 'land.household.read', 'lnd.pii.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'HOUSEHOLD_READER', ['land.household.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'HOUSEHOLD_OPENER', ['lnd.pii.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'HOUSEHOLD_DPO', ['land.dsr.handle'], 30);
    await harness.seedRole(TENANT_B, 1, 'HOUSEHOLD_OFFICER', ['land.manage', 'land.read', 'land.household.write', 'land.household.read', 'lnd.pii.read'], 40);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    worldB = await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_OFFICER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: AUDITOR, role: 2, kind: 'TENANT' },
      { n: 4, member: PROJECT_OFFICER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 5, member: DEPARTMENT_OPENER, role: 2, kind: 'TENANT' },
      { n: 6, member: DEPARTMENT_OPENER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 7, member: DPO, role: 4, kind: 'TENANT' },
      { n: 8, member: DEPARTMENT_DPO, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_OFFICER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LandParcelController, AffectedHouseholdController, AffectedHouseholdReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FIELD_CIPHER, useValue: new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]]))) },
        { provide: LND_METRICS, useValue: { increment: (name: string, labels?: Record<string, string>) => decrypted.push({ name, ...labels }), gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of LND, with a cipher that fails closed when the process has no keys', async () => {
    expect(lndModule.controllers).toEqual(expect.arrayContaining([AffectedHouseholdController, AffectedHouseholdReadsController, LandInventoryController, LandInventoryReadsController, CompensationPlanController, CompensationPlanReadsController, CompensationPlanPostingController, CompensationPlanPostingReadsController]));
    const bound = createFieldCipher({ FIELD_ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}` });
    const place = { tenantId: TENANT_A, table: 'affected_household', column: 'head_name_enc', rowId: randomUUID() };
    expect(bound.open(place, bound.seal(place, HEAD))).toBe(HEAD);
    // The cipher of the process itself reads its keys from the environment; a reader built without a metrics sink counts into the no-op one.
    expect(createFieldCipher()).toBeInstanceOf(FieldCipher);
    expect(new AffectedHouseholdReadsController(harness.tenants as TenantDatabase, bound)).toBeInstanceOf(AffectedHouseholdReadsController);
    const unbound = createFieldCipher({});
    for (const work of [() => unbound.seal(place, HEAD), () => unbound.open(place, bound.seal(place, HEAD))]) {
      try {
        work();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect([(error as DomainError).code, (error as DomainError).status]).toEqual(['PROVIDER_UNAVAILABLE', 503]);
      }
    }
  });

  describe('registerAffectedHousehold', () => {
    it('AC-ST-LND-002-1, UAT-AC379: registers a household with its personal data sealed and masked, and keeps no personal value in the trail, the event or the stored answer', async () => {
      const nid = nationalId();
      const done = await register(OFFICER, { national_id: nid });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'REGISTERED', resource_version: 1 });
      const householdId = done.json.resource_id as string;
      const [row] = await rows<Record<string, unknown>>(
        `select household_code, head_name, address_text, national_id_masked, phone_masked, status, legal_basis, owner_unit_id, project_id,
                head_name_enc is not null as sealed_name, national_id_enc is not null as sealed_nid, phone_enc is not null as sealed_phone, address_enc is not null as sealed_address,
                national_id_hash is not null as has_hash, created_by
           from machvon.affected_household where id = $1::uuid`,
        [householdId],
      );
      expect(row).toMatchObject({
        head_name: 'N***** V** A**',
        address_text: '***, Quận 1',
        national_id_masked: '********' + nid.slice(-4),
        phone_masked: '*******' + PHONE.slice(-3),
        status: 'REGISTERED',
        legal_basis: 'PUBLIC_TASK_LAND_LAW',
        owner_unit_id: unitId(DEPARTMENT),
        project_id: world.project,
        sealed_name: true,
        sealed_nid: true,
        sealed_phone: true,
        sealed_address: true,
        has_hash: true,
        created_by: memberId(OFFICER),
      });
      expect(row?.household_code).toMatch(/^HH-\d{6}$/);
      const [audit] = await audits(householdId, 'lnd.household_registered');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(OFFICER), classification: 'PERSONAL', safe_diff: { project_id: world.project, legal_basis: 'PUBLIC_TASK_LAND_LAW', sealed_fields: ['head_name', 'national_id', 'phone', 'address_text'] } });
      const [event] = await events(householdId, 'lnd.household.registered.v1');
      expect(event?.payload).toMatchObject({ household_id: householdId, project_id: world.project, owner_unit_id: unitId(DEPARTMENT), tenant_id: TENANT_A });
      const kept = await everythingKept(householdId);
      for (const personal of [HEAD, 'Nguyễn', ADDRESS, '12 Lê Lợi', PHONE, nid, '0912345']) expect(kept).not.toContain(personal);
    });

    it('registers a household without the optional personal data', async () => {
      const done = await register(OFFICER, { national_id: undefined, phone: undefined, address_text: undefined, member_count: undefined, policy_beneficiary: undefined });
      expect(done.status).toBe(200);
      const [audit] = await audits(done.json.resource_id as string, 'lnd.household_registered');
      expect(audit?.safe_diff.sealed_fields).toEqual(['head_name']);
    });

    it('numbers the households of a project one after another', async () => {
      const first = await register(OFFICER);
      const second = await register(OFFICER);
      const [a, b] = await rows<{ household_code: string }>('select household_code from machvon.affected_household where id = any($1::uuid[]) order by household_code', [[first.json.resource_id, second.json.resource_id]]);
      expect(Number(b?.household_code.slice(3))).toBe(Number(a?.household_code.slice(3)) + 1);
    });

    it('answers a repeated request with the first answer and registers one household', async () => {
      const key = `key-${randomUUID()}`;
      const extra = { national_id: nationalId() };
      const first = await register(OFFICER, extra, { key });
      const second = await register(OFFICER, extra, { key });
      expect(second.status).toBe(200);
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.affected_household where owner_unit_id = $1::uuid and id = $2::uuid', [unitId(DEPARTMENT), first.json.resource_id])).toHaveLength(1);
    });

    it('AC-ST-LND-002-2, UAT-AC380: wants the legal basis for the processing and the reference to it: 422 LEGAL_BASIS_REQUIRED, nothing stored', async () => {
      const before = Number((await rows<{ n: string }>('select count(*)::text as n from machvon.affected_household'))[0]?.n);
      for (const extra of [{ legal_basis_ref: undefined }, { legal_basis_ref: '' }, { legal_basis: undefined }, { legal_basis: 'WHIM' }]) {
        const refused = await register(OFFICER, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      }
      const blank = await register(OFFICER, { legal_basis_ref: '   ' });
      expect([blank.status, blank.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.affected_household'))[0]?.n)).toBe(before);
    });

    it('wants the record of the consent when the basis is consent: 422 CONSENT_REQUIRED', async () => {
      const refused = await register(OFFICER, { legal_basis: 'CONSENT' });
      expect([refused.status, refused.json.code]).toEqual([422, 'CONSENT_REQUIRED']);
      const allowed = await register(OFFICER, { legal_basis: 'CONSENT', consent_record_id: randomUUID() });
      expect(allowed.status).toBe(200);
    });

    it('refuses an identity number that is already registered in the project, however it is written: 409 HOUSEHOLD_DUPLICATE', async () => {
      const nid = nationalId();
      expect((await register(OFFICER, { national_id: nid })).status).toBe(200);
      const again = await register(OFFICER, { national_id: nid });
      expect([again.status, again.json.code]).toEqual([409, 'HOUSEHOLD_DUPLICATE']);
      const spaced = await register(OFFICER, { national_id: `${nid.slice(0, 3)} ${nid.slice(3)}` });
      expect([spaced.status, spaced.json.code]).toEqual([409, 'HOUSEHOLD_DUPLICATE']);
      // The same person in another project is another household.
      expect((await register(OFFICER, { national_id: nid, project_id: world.otherProject }, { projectId: world.otherProject })).status).toBe(200);
    });

    it('wants values that are values: an identity number of 9 or 12 digits, a telephone number, a date that is not past, a count of members', async () => {
      for (const extra of [{ national_id: '12345' }, { national_id: 'abcdefghijkl' }, { phone: '12' }, { retention_until: '2020-01-01' }, { retention_until: '2036-13-45' }, { member_count: 0 }, { head_name: '   ' }]) {
        const refused = await register(OFFICER, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const unknown = await register(OFFICER, { citizen_card: 'x' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('registers for a unit of the scope of the caller only: 403 SCOPE_DENIED elsewhere, for a grant on a project and for nobody; 404 for a project that is not there', async () => {
      const elsewhere = await register(DEPARTMENT_OFFICER, {}, { unit: ELSEWHERE });
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await register(DEPARTMENT_OFFICER)).status).toBe(200);
      const byProject = await register(PROJECT_OFFICER);
      expect([byProject.status, byProject.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await register(NOBODY)).status).toBe(403);
      expect((await register(AUDITOR)).status).toBe(403);
      const missing = await register(OFFICER, {}, { projectId: id(FAMILY, 0xee) });
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreign = await register(OFFICER, {}, { tenantId: TENANT_B, projectId: world.project });
      expect(foreign.status).toBe(404);
    });
  });

  describe('linkHouseholdParcel', () => {
    it('links a household to a parcel of its own unit and project, audits it and tells the world with ids only', async () => {
      const household = (await register(OFFICER)).json.resource_id as string;
      const parcel = await parcelIn(DEPARTMENT);
      const done = await link(OFFICER, household, parcel);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'LINKED', resource_version: 1 });
      const linkId = done.json.resource_id as string;
      const [stored] = await rows<Record<string, unknown>>('select household_id, parcel_id, owner_unit_id, right_kind, share_pct::text as share from machvon.household_parcel where id = $1::uuid', [linkId]);
      expect(stored).toEqual({ household_id: household, parcel_id: parcel, owner_unit_id: unitId(DEPARTMENT), right_kind: 'OWNER', share: '60.0000' });
      const [audit] = await audits(linkId, 'lnd.household_parcel_linked');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', safe_diff: { household_id: household, parcel_id: parcel, right_kind: 'OWNER', share_pct: '60' } });
      const [event] = await events(linkId, 'lnd.household.parcel_linked.v1');
      expect(event?.payload).toMatchObject({ household_id: household, parcel_id: parcel, project_id: world.project });
    });

    it('never gives a parcel more than the whole of it (422 SHARE_EXCEEDS_100) and never links the same pair twice (409 LINK_DUPLICATE)', async () => {
      const first = (await register(OFFICER)).json.resource_id as string;
      const second = (await register(OFFICER)).json.resource_id as string;
      const parcel = await parcelIn(DEPARTMENT);
      expect((await link(OFFICER, first, parcel, { share_pct: '70' })).status).toBe(200);
      const over = await link(OFFICER, second, parcel, { share_pct: '40' });
      expect([over.status, over.json.code]).toEqual([422, 'SHARE_EXCEEDS_100']);
      expect((await link(OFFICER, second, parcel, { share_pct: '30', right_kind: 'USER' })).status).toBe(200);
      const again = await link(OFFICER, first, parcel, { share_pct: '1' });
      expect([again.status, again.json.code]).toEqual([409, 'LINK_DUPLICATE']);
    });

    it('wants a parcel of the same unit and project, a share that is a share and a title document that the scan found clean', async () => {
      const household = (await register(OFFICER)).json.resource_id as string;
      const otherUnit = await link(OFFICER, household, await parcelIn(ELSEWHERE));
      expect([otherUnit.status, otherUnit.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const missing = await link(OFFICER, household, randomUUID());
      expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const parcel = await parcelIn(DEPARTMENT);
      for (const share_pct of ['0', '101', 'half', '12.123456']) {
        const refused = await link(OFFICER, household, parcel, { share_pct });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const pending = await link(OFFICER, household, parcel, { title_document_version_id: world.pendingDocument });
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      expect((await link(OFFICER, household, parcel, { title_document_version_id: world.cleanDocument })).status).toBe(200);
    });

    it('does not show a household outside the scope of the caller, and turns away a caller with no right to write', async () => {
      const household = (await register(OFFICER, {}, { unit: ELSEWHERE })).json.resource_id as string;
      const parcel = await parcelIn(ELSEWHERE);
      const hidden = await link(DEPARTMENT_OFFICER, household, parcel);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await link(AUDITOR, household, parcel)).status).toBe(403);
      expect((await link(PROJECT_OFFICER, household, parcel)).status).toBe(404);
      expect((await link(B_OFFICER, household, parcel, {}, TENANT_B)).status).toBe(404);
    });
  });

  describe('listAffectedHouseholds', () => {
    it('shows the households of the scope with the personal data masked, and the identity number and the telephone hidden whole from whoever may not open them', async () => {
      const nid = nationalId();
      const household = (await register(OFFICER, { national_id: nid })).json.resource_id as string;
      const parcel = await parcelIn(DEPARTMENT);
      await link(OFFICER, household, parcel);
      const seen = await listOf(OFFICER);
      expect(seen.status).toBe(200);
      const line = (seen.json.items as Array<Record<string, unknown>>).find((item) => item.id === household);
      expect(line).toMatchObject({
        project_id: world.project,
        owner_unit_id: unitId(DEPARTMENT),
        head_name_masked: 'N***** V** A**',
        national_id_masked: '********' + nid.slice(-4),
        phone_masked: '*******' + PHONE.slice(-3),
        address_masked: '***, Quận 1',
        legal_basis: 'PUBLIC_TASK_LAND_LAW',
        legal_basis_ref: BASIS,
        retention_until: '2036-12-31',
        status: 'REGISTERED',
        dsr_open: false,
        version: 1,
      });
      expect(line?.parcels).toEqual([expect.objectContaining({ parcel_id: parcel, right_kind: 'OWNER', share_pct: '60.0000' })]);
      expect(typeof seen.json.as_of).toBe('string');
      const auditor = (await listOf(AUDITOR)).json.items as Array<Record<string, unknown>>;
      expect(auditor.find((item) => item.id === household)).toMatchObject({ national_id_masked: '************', phone_masked: '************', head_name_masked: 'N***** V** A**' });
      const body = JSON.stringify(seen.json);
      for (const personal of [HEAD, ADDRESS, PHONE, nid]) expect(body).not.toContain(personal);
      expect(JSON.stringify(auditor)).not.toContain(nid.slice(-4));
      const mixed = (await listOf(DEPARTMENT_OPENER)).json.items as Array<Record<string, unknown>>;
      expect(mixed.find((item) => item.id === household)).toMatchObject({ national_id_masked: '********' + nid.slice(-4) });
    });

    it('opens the personal data per unit: where the caller may read households but not open them in a unit, that unit shows the hidden form', async () => {
      const elsewhere = (await register(OFFICER, {}, { unit: ELSEWHERE })).json.resource_id as string;
      const items = (await listOf(DEPARTMENT_OPENER)).json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.id === elsewhere)).toMatchObject({ national_id_masked: '************', phone_masked: '************' });
    });

    it('AC-ST-LND-002-1, UAT-AC379: shows a unit only the households of its own tree, nothing to a grant on a project, and nothing of another tenant', async () => {
      const elsewhere = (await register(OFFICER, {}, { unit: ELSEWHERE })).json.resource_id as string;
      const inside = (await register(OFFICER)).json.resource_id as string;
      const ids = (await listOf(DEPARTMENT_OFFICER)).json.items as Array<{ id: string }>;
      expect(ids.map((item) => item.id)).toContain(inside);
      expect(ids.map((item) => item.id)).not.toContain(elsewhere);
      expect((await listOf(PROJECT_OFFICER)).json.items).toEqual([]);
      expect((await listOf(NOBODY)).status).toBe(403);
      expect((await listOf(B_OFFICER, '', worldB.project, TENANT_B)).json.items).toEqual([]);
    });

    it('filters by status, pages with a cursor and refuses what is not a project, a status, a limit or a cursor', async () => {
      const page = await listOf(OFFICER, '&limit=2');
      const items = page.json.items as Array<{ household_code: string; id: string }>;
      expect(items).toHaveLength(2);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await listOf(OFFICER, `&limit=2&cursor=${page.json.next_cursor as string}`);
      const nextItems = next.json.items as Array<{ household_code: string }>;
      expect((nextItems[0]?.household_code ?? '') > (items[1]?.household_code ?? '')).toBe(true);
      expect((await listOf(OFFICER, '&status=CLOSED')).json.items).toEqual([]);
      for (const query of ['&status=NOPE', '&limit=0', '&cursor=!!!']) expect([(await listOf(OFFICER, query)).status, (await listOf(OFFICER, query)).json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const noProject = await get(OFFICER, '/affected-households');
      expect([noProject.status, noProject.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });

  describe('revealHouseholdIdentity', () => {
    it('AC-ST-LND-002-1, UAT-AC379: opens the sealed data for the holder of the right over the unit of the household, and records that it was opened without recording what it held', async () => {
      const nid = nationalId();
      const household = (await register(OFFICER, { national_id: nid })).json.resource_id as string;
      decrypted.length = 0;
      const opened = await reveal(OFFICER, household);
      expect(opened.status).toBe(200);
      expect(opened.json).toEqual({
        id: household,
        project_id: world.project,
        owner_unit_id: unitId(DEPARTMENT),
        household_code: expect.stringMatching(/^HH-\d{6}$/),
        head_name: HEAD,
        national_id: nid,
        phone: PHONE,
        address_text: ADDRESS,
      });
      const [audit] = await audits(household, 'lnd.household_identity_revealed');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(OFFICER), classification: 'PERSONAL', safe_diff: { fields: ['head_name', 'national_id', 'phone', 'address_text'], owner_unit_id: unitId(DEPARTMENT), reason: REASON } });
      expect(JSON.stringify(audit)).not.toContain(nid);
      expect(JSON.stringify(audit)).not.toContain(HEAD);
      expect(decrypted).toEqual([{ name: 'lnd_pii_decrypt_total', outcome: 'revealed' }]);
      const again = await reveal(OFFICER, household);
      expect(again.status).toBe(200);
      expect(await audits(household, 'lnd.household_identity_revealed')).toHaveLength(2);
    });

    it('wants the reason for the reading, in words, before anything is read or recorded: 422 VALIDATION_FAILED', async () => {
      const household = (await register(OFFICER)).json.resource_id as string;
      for (const reason of [null, '', '   ', 'too short', 'x'.repeat(301), 'a reason\u0007 with a control character']) {
        const refused = await reveal(OFFICER, household, reason);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      }
      expect(await audits(household, 'lnd.household_identity_revealed')).toHaveLength(0);
      const spaced = await reveal(OFFICER, household, `   ${REASON}   `);
      expect(spaced.status).toBe(200);
      const [audit] = await audits(household, 'lnd.household_identity_revealed');
      expect(audit?.safe_diff.reason).toBe(REASON);
    });

    it('lists only the fields that the household holds', async () => {
      const household = (await register(OFFICER, { national_id: undefined, phone: undefined, address_text: undefined })).json.resource_id as string;
      const opened = await reveal(OFFICER, household);
      expect(opened.json).toMatchObject({ head_name: HEAD, national_id: null, phone: null, address_text: null });
      const [audit] = await audits(household, 'lnd.household_identity_revealed');
      expect(audit?.safe_diff.fields).toEqual(['head_name']);
    });

    it('refuses whoever does not hold the right (403), a unit outside the right (403 SCOPE_DENIED), and answers 404 for a household outside the scope, another tenant or one that is not there', async () => {
      const inside = (await register(OFFICER)).json.resource_id as string;
      const elsewhere = (await register(OFFICER, {}, { unit: ELSEWHERE })).json.resource_id as string;
      expect((await reveal(AUDITOR, inside)).status).toBe(403);
      expect((await reveal(NOBODY, inside)).status).toBe(403);
      expect((await reveal(DEPARTMENT_OPENER, inside)).status).toBe(200);
      const outside = await reveal(DEPARTMENT_OPENER, elsewhere);
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await reveal(DEPARTMENT_OFFICER, elsewhere)).status).toBe(404);
      expect((await reveal(PROJECT_OFFICER, inside)).status).toBe(404);
      expect((await reveal(B_OFFICER, inside, REASON, TENANT_B)).status).toBe(404);
      expect((await reveal(OFFICER, randomUUID())).status).toBe(404);
      expect(await audits(elsewhere, 'lnd.household_identity_revealed')).toHaveLength(0);
    });
  });

  /** A payment made to a household, written as the superuser with the foreign keys off: the plan it belongs to is another story. */
  async function pay(householdId: string, status: 'PAID' | 'PENDING', unit = DEPARTMENT): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      const paid = status === 'PAID';
      await client.query(
        `insert into machvon.compensation_payment
           (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, paid_on, method, voucher_document_version_id, status, created_by, updated_by)
         values ($1, gen_random_uuid(), gen_random_uuid(), $2::uuid, $3::uuid, 1, 1000000, date '2026-10-01', $4, $5, $6, $7, $8, $8)`,
        [TENANT_A, householdId, unitId(unit), paid ? '2026-10-10' : null, paid ? 'BANK_TRANSFER' : null, paid ? world.cleanDocument : null, status, memberId(OFFICER)],
      );
    } finally {
      await client.end();
    }
  }
  const DSR_REASON = 'The voucher of the payment names the head of the household';
  const dsr = (member: number, householdId: string, body: Record<string, unknown> = {}, options: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/affected-households/${householdId}/data-requests`, {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: { request_kind: 'ACCESS', requester_verified: true, outcome: 'FULFILLED', reason: DSR_REASON, ...body },
    });
  const personal = async (householdId: string) =>
    (
      await rows<Record<string, unknown>>(
        `select head_name, address_text, national_id_masked, phone_masked, head_name_enc is not null as has_name, national_id_enc is not null as has_nid, phone_enc is not null as has_phone, address_enc is not null as has_address,
                anonymised_at is not null as anonymised, processing_restricted_at is not null as restricted, version::text as version
           from machvon.affected_household where id = $1::uuid`,
        [householdId],
      )
    )[0];

  describe('handleHouseholdDataRequest', () => {
    it('AC-ST-LND-003-1, UAT-AC381: holds an erasure back while the household was paid, meets it in part with the reason, and anonymises a household that was not paid', async () => {
      const nid = nationalId();
      const paid = (await register(OFFICER, { national_id: nid })).json.resource_id as string;
      await pay(paid, 'PAID');
      const held = await dsr(DPO, paid, { request_kind: 'ERASE', outcome: 'FULFILLED' });
      expect([held.status, held.json.code]).toEqual([409, 'RETENTION_LEGAL_HOLD']);
      expect((await personal(paid))?.version).toBe('1');
      expect(await rows('select 1 from machvon.household_data_request where household_id = $1::uuid', [paid])).toHaveLength(0);

      const partial = await dsr(DPO, paid, { request_kind: 'ERASE', outcome: 'PARTIAL' });
      expect(partial.status).toBe(200);
      expect(partial.json).toMatchObject({ status: 'PARTIAL', resource_version: 2, resource_id: paid });
      expect(await personal(paid)).toMatchObject({ has_name: true, has_nid: true, has_phone: false, has_address: false, address_text: null, phone_masked: null, anonymised: false });
      const [request] = await rows<{ reason: string; erased_fields: string[]; retained_payments: number }>('select reason, erased_fields, retained_payments from machvon.household_data_request where household_id = $1::uuid', [paid]);
      expect(request).toEqual({ reason: DSR_REASON, erased_fields: ['phone', 'address_text'], retained_payments: 1 });

      const unpaid = (await register(OFFICER, { national_id: nationalId() })).json.resource_id as string;
      await pay(unpaid, 'PENDING');
      const erased = await dsr(DPO, unpaid, { request_kind: 'ERASE', outcome: 'FULFILLED' });
      expect(erased.status).toBe(200);
      expect(await personal(unpaid)).toMatchObject({ head_name: '[erased]', has_nid: false, has_phone: false, has_address: false, anonymised: true });
      const [audit] = await audits(unpaid, 'lnd.household_data_request_handled');
      expect(audit).toMatchObject({
        outcome: 'SUCCESS',
        actor_id: memberId(DPO),
        classification: 'PERSONAL',
        safe_diff: { request_kind: 'ERASE', outcome: 'FULFILLED', requester_verified: true, erased_fields: ['head_name', 'national_id', 'phone', 'address_text'], retained_payments: 0, anonymised: true },
      });
      const [event] = await events(unpaid, 'lnd.household.dsr_handled.v1');
      expect(event?.payload).toMatchObject({ household_id: unpaid, request_kind: 'ERASE', outcome: 'FULFILLED', owner_unit_id: unitId(DEPARTMENT), tenant_id: TENANT_A });
      // Neither the trail, the events, the stored answers nor the row hold a name, an address, a telephone or an identity number, and the reason lives only in the request.
      const kept = await everythingKept(paid);
      for (const value of [HEAD, ADDRESS, PHONE, nid, DSR_REASON]) expect(kept).not.toContain(value);
      expect(JSON.stringify(await audits(paid, 'lnd.household_data_request_handled'))).not.toContain(DSR_REASON);
      expect(JSON.stringify(await events(paid, 'lnd.household.dsr_handled.v1'))).not.toContain(DSR_REASON);
    });

    it('AC-ST-LND-003-1, UAT-AC381: does not serve a person who was not verified (422 REQUESTER_NOT_VERIFIED) and records nothing', async () => {
      const mine = (await register(OFFICER)).json.resource_id as string;
      const refused = await dsr(DPO, mine, { requester_verified: false });
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'REQUESTER_NOT_VERIFIED', 'requester_verified']);
      expect(await rows('select 1 from machvon.household_data_request where household_id = $1::uuid', [mine])).toHaveLength(0);
      expect(await audits(mine, 'lnd.household_data_request_handled')).toHaveLength(0);
      expect((await dsr(DPO, mine)).status).toBe(200);
    });

    it('serves an access, restricts the processing so that the data is no longer opened, and says so in the list', async () => {
      const mine = (await register(OFFICER)).json.resource_id as string;
      expect((await reveal(OFFICER, mine)).status).toBe(200);
      expect((await dsr(DPO, mine, { request_kind: 'RESTRICT' })).json).toMatchObject({ status: 'FULFILLED', resource_version: 2 });
      const blocked = await reveal(OFFICER, mine);
      expect([blocked.status, blocked.json.code]).toEqual([409, 'PROCESSING_RESTRICTED']);
      const line = ((await listOf(OFFICER)).json.items as Array<Record<string, unknown>>).find((item) => item.id === mine);
      expect(line).toMatchObject({ processing_restricted: true, anonymised: false, dsr_open: false });
      expect(await audits(mine, 'lnd.household_identity_revealed')).toHaveLength(1);
    });

    it('withdraws a consent only where the consent was the basis (422 VALIDATION_FAILED otherwise)', async () => {
      const task = (await register(OFFICER)).json.resource_id as string;
      const refused = await dsr(DPO, task, { request_kind: 'WITHDRAW_CONSENT' });
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'request_kind']);
      const consent = (await register(OFFICER, { legal_basis: 'CONSENT', consent_record_id: randomUUID() })).json.resource_id as string;
      expect((await dsr(DPO, consent, { request_kind: 'WITHDRAW_CONSENT' })).status).toBe(200);
      expect(await personal(consent)).toMatchObject({ has_phone: false, has_address: false, has_name: true, has_nid: true });
    });

    it('wants the four fields of the request: 422 VALIDATION_FAILED for a missing one or a value that is not one, 400 for a field it does not know', async () => {
      const mine = (await register(OFFICER)).json.resource_id as string;
      for (const missing of ['request_kind', 'requester_verified', 'outcome', 'reason']) {
        const body: Record<string, unknown> = { request_kind: 'ACCESS', requester_verified: true, outcome: 'FULFILLED', reason: DSR_REASON };
        delete body[missing];
        const refused = await call('POST', `/affected-households/${mine}/data-requests`, { member: DPO, body });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      for (const bad of [{ request_kind: 'PORT' }, { outcome: 'MAYBE' }, { reason: '' }, { reason: '   ' }]) {
        const refused = await dsr(DPO, mine, bad);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const unknown = await dsr(DPO, mine, { national_id: '079000000001' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('is handled inside the unit of the officer: a household of another unit or another tenant is not found (404), and who holds no right is turned away (403)', async () => {
      const inside = (await register(OFFICER)).json.resource_id as string;
      const elsewhere = (await register(OFFICER, {}, { unit: ELSEWHERE })).json.resource_id as string;
      expect((await dsr(DEPARTMENT_DPO, inside)).status).toBe(200);
      const hidden = await dsr(DEPARTMENT_DPO, elsewhere);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await dsr(DPO, elsewhere)).status).toBe(200);
      expect((await dsr(OFFICER, inside)).status).toBe(403);
      expect((await dsr(NOBODY, inside)).status).toBe(403);
      expect((await dsr(PROJECT_OFFICER, inside)).status).toBe(403);
      expect((await dsr(B_OFFICER, inside, {}, { tenantId: TENANT_B })).status).toBe(403);
      expect((await dsr(DPO, randomUUID())).status).toBe(404);
      expect(await rows('select 1 from machvon.household_data_request where household_id = any($1::uuid[])', [[inside, elsewhere]])).toHaveLength(2);
    });

    it('answers a repeated request with the first answer and handles it once', async () => {
      const mine = (await register(OFFICER)).json.resource_id as string;
      const key = `key-${randomUUID()}`;
      const first = await dsr(DPO, mine, { request_kind: 'RESTRICT' }, { key });
      const second = await dsr(DPO, mine, { request_kind: 'RESTRICT' }, { key });
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.household_data_request where household_id = $1::uuid', [mine])).toHaveLength(1);
    });
  });

  it('shows a household in the allowlist and nothing else', () => {
    const view = householdLineView({
      id: 'a',
      projectId: 'p',
      ownerUnitId: 'u',
      householdCode: 'HH-000001',
      headNameMasked: 'N***',
      nationalIdMasked: null,
      phoneMasked: null,
      addressMasked: null,
      memberCount: null,
      policyBeneficiary: false,
      legalBasis: 'LEGAL_OBLIGATION',
      legalBasisRef: 'x',
      consentRecordId: null,
      retentionUntil: '2036-01-01',
      dsrOpen: false,
      processingRestricted: false,
      anonymised: false,
      status: 'REGISTERED',
      parcels: [],
      createdAt: '2026-10-26T00:00:00Z',
      version: 1,
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        'address_masked', 'consent_record_id', 'created_at', 'anonymised', 'dsr_open', 'processing_restricted', 'head_name_masked', 'household_code', 'id', 'legal_basis', 'legal_basis_ref', 'member_count', 'national_id_masked', 'owner_unit_id',
        'parcels', 'phone_masked', 'policy_beneficiary', 'project_id', 'retention_until', 'status', 'version',
      ].sort(),
    );
  });
});
