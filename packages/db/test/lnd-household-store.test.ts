import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, staticKeyProvider } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { Client } from 'pg';
import { LndHouseholdStore, enterScope, householdScopeUnits, unitInScope } from '../src/lnd-household-store';
import type { NewHousehold } from '../src/lnd-household-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const KEY = randomBytes(32);
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, KEY]])));
const households = new LndHouseholdStore(cipher);
const parcels = new LndParcelStore();
const ACTOR = 1;
const FAMILY = 0xb1;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const TODAY = '2026-10-26';
const NOW = new Date('2026-10-26T03:00:00Z');
const NID_1 = '079000010001';
const NID_2 = '079000020001';
const NID_3 = '079000030001';
const PHONE = '0900000001';
const HEAD = 'Nguyễn Văn A';
const ADDRESS = '12 Lê Lợi, Phường 3, Quận 1';
const EVERYWHERE = '*';

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(ACTOR)), work);
/** The statement as the owner of the tables sees it: the policy of the scope applies to the owner too, so the scope is put first. */
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], units: string | null = EVERYWHERE): Promise<R[]> =>
  harness.owner<R>(
    TENANT_A,
    units === null
      ? [[sql, params]]
      : [
          ["select set_config('app.scope_units', $1, false)", [units]],
          [sql, params],
        ],
  );

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
};

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});

const household = (extra: Partial<NewHousehold> = {}): NewHousehold => ({
  projectId: world.project,
  ownerUnitId: unitId(DEPARTMENT),
  headName: HEAD,
  nationalId: NID_1,
  phone: PHONE,
  addressText: ADDRESS,
  memberCount: 4,
  policyBeneficiary: true,
  legalBasis: 'PUBLIC_TASK_LAND_LAW',
  legalBasisRef: 'Luật Đất đai 2024, Điều 87',
  retentionUntil: '2036-12-31',
  ...extra,
});
const uniqueId = (): string => String(100000000000 + ++counter * 7);
const register = (extra: Partial<NewHousehold> = {}, units = EVERYWHERE) => as((tx) => households.register(tx, household({ nationalId: uniqueId(), ...extra }), memberId(ACTOR), units, TODAY));
const makeParcel = (ownerUnit = DEPARTMENT, project = world.project) =>
  as((tx) =>
    parcels.create(
      tx,
      { projectId: project, ownerUnitId: unitId(ownerUnit), parcelCode: `LP-H-${String(++counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' },
      memberId(ACTOR),
      TODAY,
    ),
  );
const list = (units: string, filter: { projectId?: string; status?: string; limit?: number; after?: { code: string; id: string } } = {}, personal: string = EVERYWHERE) =>
  as((tx) => households.list(tx, units, { limit: 100, ...filter }, personal));
const link = (householdId: string, parcelId: string, extra: Record<string, unknown> = {}, units = EVERYWHERE) =>
  as((tx) => households.link(tx, householdId, { parcelId, rightKind: 'OWNER', ...extra }, memberId(ACTOR), units));

describe('the affected households, their personal data and their unit scope (ST-LND-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, ACTOR, DEPARTMENT, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('registering', () => {
    it('AC-ST-LND-002-1, UAT-AC379: stores the personal fields sealed, keeps nothing of them readable, and answers with ids and the values that are not personal', async () => {
      const registered = await register({ nationalId: NID_1 });
      expect(registered).toMatchObject({
        projectId: world.project,
        ownerUnitId: unitId(DEPARTMENT),
        legalBasis: 'PUBLIC_TASK_LAND_LAW',
        retentionUntil: '2036-12-31',
        status: 'REGISTERED',
        version: 1,
        sealed: ['head_name', 'national_id', 'phone', 'address_text'],
      });
      expect(registered.householdCode).toMatch(/^HH-\d{6}$/);
      const [row] = await owner<Record<string, unknown>>('select to_jsonb(h) as dump from machvon.affected_household h where h.id = $1::uuid', [registered.id]);
      const dump = JSON.stringify(row);
      for (const clear of [NID_1, PHONE, HEAD, ADDRESS, '12 Lê Lợi', 'Nguyễn Văn A']) expect(dump).not.toContain(clear);
      const [stored] = await owner<{ head_name: string; address_text: string; national_id_masked: string; phone_masked: string; national_id_hash: string; sealed: boolean }>(
        `select head_name, address_text, national_id_masked, phone_masked, national_id_hash,
                (national_id_enc is not null and phone_enc is not null and head_name_enc is not null and address_enc is not null and pg_typeof(national_id_enc)::text = 'bytea') as sealed
           from machvon.affected_household where id = $1::uuid`,
        [registered.id],
      );
      expect(stored).toEqual({
        head_name: 'N***** V** A',
        address_text: '***, Quận 1',
        national_id_masked: '********0001',
        phone_masked: '*******001',
        national_id_hash: cipher.blindIndex(TENANT_A, world.project, NID_1),
        sealed: true,
      });
      expect(stored?.national_id_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('issues the codes one after another in the project, and the same number in another project', async () => {
      const first = await register();
      const second = await register();
      expect(Number(second.householdCode.slice(3))).toBe(Number(first.householdCode.slice(3)) + 1);
      const other = await as((tx) => households.register(tx, household({ projectId: world.otherProject, nationalId: uniqueId() }), memberId(ACTOR), EVERYWHERE, TODAY));
      expect(other.householdCode).toBe('HH-000001');
    });

    it('registers a household with nothing but a name, a basis and a retention', async () => {
      const bare = await as((tx) =>
        households.register(
          tx,
          { projectId: world.project, ownerUnitId: unitId(DEPARTMENT), headName: ' Trần Thị B ', legalBasis: 'LEGAL_OBLIGATION', legalBasisRef: 'Nghị định 88/2024/NĐ-CP', retentionUntil: TODAY },
          memberId(ACTOR),
          EVERYWHERE,
          TODAY,
        ),
      );
      expect(bare.sealed).toEqual(['head_name']);
      const [line] = (await list(EVERYWHERE, { projectId: world.project })).filter((candidate) => candidate.id === bare.id);
      expect(line).toMatchObject({ headNameMasked: 'T*** T** B', nationalIdMasked: null, phoneMasked: null, addressMasked: null, memberCount: null, policyBeneficiary: false });
    });

    it('AC-ST-LND-002-2, UAT-AC380: refuses a household with no legal basis for processing, with a consent that is not named, or whose retention has ended', async () => {
      expect(await refusal(register({ legalBasisRef: '   ' }))).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis_ref' });
      expect(await refusal(register({ legalBasis: 'CONSENT' }))).toMatchObject({ code: 'CONSENT_REQUIRED', status: 422, detail: 'consent_record_id' });
      expect(await refusal(register({ legalBasis: 'GUESS' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'legal_basis' });
      expect(await refusal(register({ retentionUntil: '2026-10-25' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'retention_until', extensions: { reason: 'IN_THE_PAST' } });
      expect(await refusal(register({ retentionUntil: 'someday' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'retention_until' });
      expect(await refusal(register({ consentRecordId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'consent_record_id' });
      const consent = randomUUID();
      const consented = await register({ legalBasis: 'CONSENT', consentRecordId: consent.toUpperCase() });
      expect(consented).toMatchObject({ legalBasis: 'CONSENT', retentionUntil: '2036-12-31' });
      const [row] = await owner<{ consent_record_id: string; legal_basis_ref: string }>('select consent_record_id, legal_basis_ref from machvon.affected_household where id = $1::uuid', [
        consented.id,
      ]);
      expect(row).toEqual({ consent_record_id: consent, legal_basis_ref: 'Luật Đất đai 2024, Điều 87' });
    });

    it('refuses an identity number already registered in the project, whatever its spelling, and not in another project', async () => {
      const first = await register({ nationalId: '079 000-000 777' });
      expect(first.sealed).toContain('national_id');
      expect(await refusal(register({ nationalId: '079000000777' }))).toMatchObject({ code: 'HOUSEHOLD_DUPLICATE', status: 409 });
      expect(await as((tx) => households.register(tx, household({ projectId: world.otherProject, nationalId: '079000000777' }), memberId(ACTOR), EVERYWHERE, TODAY))).toMatchObject({
        projectId: world.otherProject,
      });
    });

    it('refuses what is not a well-formed value, before anything is stored', async () => {
      const bad = async (extra: Partial<NewHousehold>, field: string) => expect(await refusal(register(extra))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      await bad({ headName: '   ' }, 'head_name');
      await bad({ nationalId: '12345' }, 'national_id');
      await bad({ phone: 'call me' }, 'phone');
      await bad({ addressText: '  ' }, 'address_text');
      await bad({ memberCount: 0 }, 'member_count');
      await bad({ memberCount: 1001 }, 'member_count');
      await bad({ memberCount: 2.5 }, 'member_count');
      await bad({ legalBasisRef: 'x'.repeat(2001) }, 'legal_basis_ref');
      expect(await owner('select 1 from machvon.affected_household where head_name_enc is null')).toEqual([]);
    });

    it('is inside the scope of the caller: a unit outside it, or one that is not there, is refused alike; a project that is not there does not exist', async () => {
      expect(await refusal(register({ ownerUnitId: unitId(OTHER_BRANCH) }, unitId(DEPARTMENT)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(register({ ownerUnitId: randomUUID() }, unitId(DEPARTMENT)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(register({ ownerUnitId: unitId(DEPARTMENT) }, ''))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(register({ projectId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await register({ ownerUnitId: unitId(DEPARTMENT) }, `${unitId(OTHER_BRANCH)},${unitId(DEPARTMENT)}`)).toMatchObject({ ownerUnitId: unitId(DEPARTMENT) });
    });
  });

  describe('the scope of units (UAT-AC379)', () => {
    it('shows a household to the unit it belongs to and to a caller that sees everything, and to no other unit; with no scope set the database shows no row at all', async () => {
      const mine = await register({ ownerUnitId: unitId(DEPARTMENT) });
      const theirs = await register({ ownerUnitId: unitId(OTHER_BRANCH) });
      const ids = async (units: string) => (await list(units)).map((line) => line.id);
      expect(await ids(unitId(DEPARTMENT))).toContain(mine.id);
      expect(await ids(unitId(DEPARTMENT))).not.toContain(theirs.id);
      expect(await ids(unitId(OTHER_BRANCH))).toEqual(expect.arrayContaining([theirs.id]));
      expect(await ids(unitId(OTHER_BRANCH))).not.toContain(mine.id);
      expect(await ids(EVERYWHERE)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(await ids('')).toEqual([]);
      expect(await ids(unitId(PROVINCE))).toEqual([]);
      // The policy of the database, apart from the application: the same statement, with the scope set to different values or not at all.
      const count = async (units: string | null) => Number((await owner<{ n: string }>('select count(*)::text as n from machvon.affected_household where id = $1::uuid', [mine.id], units))[0]?.n);
      expect({ own: await count(unitId(DEPARTMENT)), other: await count(unitId(OTHER_BRANCH)), everywhere: await count(EVERYWHERE), unset: await count(null), empty: await count('') }).toEqual({
        own: 1,
        other: 0,
        everywhere: 1,
        unset: 0,
        empty: 0,
      });
    });

    it('works out the units of a caller from its grants: the whole tenant, a unit tree, a single unit, and nothing for a project or a contract', async () => {
      const read = 'land.household.read';
      const units = (access: EffectiveAccess) => as((tx) => householdScopeUnits(tx, access, read, NOW));
      expect(await units(grant(read, { kind: 'TENANT' }))).toBe('*');
      expect((await units(grant(read, { kind: 'UNIT_SUBTREE', refIds: [unitId(PROVINCE)], paths: ['/u1/'] }))).split(',').sort()).toEqual([unitId(PROVINCE), unitId(DEPARTMENT)].sort());
      expect(await units(grant(read, { kind: 'UNIT_ONLY', refIds: [unitId(OTHER_BRANCH)] }))).toBe(unitId(OTHER_BRANCH));
      expect(await units(grant(read, { kind: 'PROJECT', refIds: [world.project] }))).toBe('');
      expect(await units(grant('land.read', { kind: 'TENANT' }))).toBe('');
      expect(unitInScope('*', unitId(1))).toBe(true);
      expect(unitInScope(`${unitId(1)},${unitId(2)}`, unitId(2))).toBe(true);
      expect(unitInScope(unitId(1), unitId(2))).toBe(false);
      expect(unitInScope('', unitId(1))).toBe(false);
    });

    it('does not show a household of another tenant to anyone', async () => {
      await register();
      const other = await harness.tenants.withTenant(contextFor(TENANT_B, memberId(ACTOR)), (tx) => households.list(tx, EVERYWHERE, { limit: 100 }, EVERYWHERE));
      expect(other).toEqual([]);
    });
  });

  describe('listing and revealing', () => {
    it('AC-ST-LND-002-1, UAT-AC379: shows the personal fields masked, hiding the identity number and the telephone whole from whoever may not read personal data, and filters and pages', async () => {
      const first = await register({ nationalId: NID_2 });
      const second = await register();
      const staff = (await list(EVERYWHERE, { projectId: world.project })).find((line) => line.id === first.id);
      expect(staff).toMatchObject({
        projectId: world.project,
        ownerUnitId: unitId(DEPARTMENT),
        headNameMasked: 'N***** V** A',
        nationalIdMasked: '********0001',
        phoneMasked: '*******001',
        addressMasked: '***, Quận 1',
        memberCount: 4,
        policyBeneficiary: true,
        legalBasis: 'PUBLIC_TASK_LAND_LAW',
        legalBasisRef: 'Luật Đất đai 2024, Điều 87',
        consentRecordId: null,
        retentionUntil: '2036-12-31',
        dsrOpen: false,
        status: 'REGISTERED',
        parcels: [],
        version: 1,
      });
      const auditor = (await list(EVERYWHERE, { projectId: world.project }, '')).find((line) => line.id === first.id);
      expect(auditor).toMatchObject({ headNameMasked: 'N***** V** A', nationalIdMasked: '************', phoneMasked: '************', addressMasked: '***, Quận 1' });
      expect(JSON.stringify(auditor)).not.toContain('********0001');
      expect(JSON.stringify(auditor)).not.toContain('*******001');
      const all = await list(EVERYWHERE, { projectId: world.project });
      expect(all.map((line) => line.householdCode)).toEqual([...all.map((line) => line.householdCode)].sort());
      const page = await list(EVERYWHERE, { projectId: world.project, limit: 1 });
      const next = await list(EVERYWHERE, { projectId: world.project, limit: 1, after: { code: page[0]?.householdCode ?? '', id: page[0]?.id ?? '' } });
      expect(next[0]?.householdCode).not.toBe(page[0]?.householdCode);
      expect((next[0]?.householdCode ?? '') > (page[0]?.householdCode ?? '')).toBe(true);
      expect((await list(EVERYWHERE, { projectId: world.project, status: 'DISPUTED' })).length).toBe(0);
      expect((await list(EVERYWHERE, { status: 'REGISTERED' })).map((line) => line.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(await refusal(list(EVERYWHERE, { status: 'GONE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(list(EVERYWHERE, { projectId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect(await refusal(list(EVERYWHERE, { limit: 0 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(list(EVERYWHERE, { limit: 202 }))).toMatchObject({ detail: 'limit' });
    });

    it('opens the sealed data of a household in the scope, and not that of a household outside it', async () => {
      const registered = await register({ nationalId: NID_3, ownerUnitId: unitId(DEPARTMENT) });
      expect(await as((tx) => households.reveal(tx, registered.id.toUpperCase(), unitId(DEPARTMENT)))).toEqual({
        id: registered.id,
        projectId: world.project,
        ownerUnitId: unitId(DEPARTMENT),
        householdCode: registered.householdCode,
        headName: HEAD,
        nationalId: NID_3,
        phone: PHONE,
        addressText: ADDRESS,
      });
      expect(await refusal(as((tx) => households.reveal(tx, registered.id, unitId(OTHER_BRANCH))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => households.reveal(tx, registered.id, '')))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => households.reveal(tx, randomUUID(), EVERYWHERE)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const bare = await as((tx) =>
        households.register(
          tx,
          { projectId: world.project, ownerUnitId: unitId(DEPARTMENT), headName: 'Phạm C', legalBasis: 'LEGAL_OBLIGATION', legalBasisRef: 'Nghị định 88/2024/NĐ-CP', retentionUntil: TODAY },
          memberId(ACTOR),
          EVERYWHERE,
          TODAY,
        ),
      );
      expect(await as((tx) => households.reveal(tx, bare.id, EVERYWHERE))).toMatchObject({ headName: 'Phạm C', nationalId: null, phone: null, addressText: null });
    });

    it('does not open a sealed field moved to another household or another column', async () => {
      const one = await register();
      const two = await register();
      await owner('update machvon.affected_household set national_id_enc = (select national_id_enc from machvon.affected_household where id = $1::uuid) where id = $2::uuid', [one.id, two.id]);
      const failure = await sqlState(as((tx) => households.reveal(tx, two.id, EVERYWHERE)));
      expect(failure.message).toContain('does not open here');
    });

    it('opens what an older master key sealed once the newest one is held', async () => {
      const old = await register({ nationalId: '079000000555' });
      const key2 = randomBytes(32);
      const rotated = new LndHouseholdStore(
        new FieldCipher(
          staticKeyProvider(
            new Map([
              [1, KEY],
              [2, key2],
            ]),
          ),
        ),
      );
      expect((await as((tx) => rotated.reveal(tx, old.id, EVERYWHERE))).nationalId).toBe('079000000555');
      const fresh = await as((tx) => rotated.register(tx, household({ nationalId: '079000000556' }), memberId(ACTOR), EVERYWHERE, TODAY));
      expect((await as((tx) => rotated.reveal(tx, fresh.id, EVERYWHERE))).nationalId).toBe('079000000556');
      expect((await owner<{ key: number }>('select get_byte(national_id_enc, 1) as key from machvon.affected_household where id = $1::uuid', [fresh.id]))[0]?.key).toBe(2);
    });
  });

  describe('linking to parcels', () => {
    it('links a household to a parcel of its unit and project, with its right and share, keeping the share and the right', async () => {
      const target = await register();
      const parcel = await makeParcel();
      const linked = await link(target.id, parcel.id, { rightKind: 'USER', sharePct: '60.5', titleDocumentVersionId: world.cleanDocument });
      expect(linked).toMatchObject({
        householdId: target.id,
        parcelId: parcel.id,
        ownerUnitId: unitId(DEPARTMENT),
        projectId: world.project,
        rightKind: 'USER',
        sharePct: '60.5',
        titleDocumentVersionId: world.cleanDocument,
      });
      const line = (await list(EVERYWHERE, { projectId: world.project })).find((candidate) => candidate.id === target.id);
      expect(line?.parcels).toEqual([{ id: linked.id, parcelId: parcel.id, parcelCode: expect.stringMatching(/^LP-H-/), rightKind: 'USER', sharePct: '60.5000' }]);
      const whole = await link((await register()).id, (await makeParcel()).id);
      expect(whole.sharePct).toBe('100');
    });

    it('refuses the same link twice, and shares that come to more than the whole parcel', async () => {
      const parcel = await makeParcel();
      const one = await register();
      const two = await register();
      const three = await register();
      await link(one.id, parcel.id, { sharePct: '60' });
      expect(await refusal(link(one.id, parcel.id, { sharePct: '10' }))).toMatchObject({ code: 'LINK_DUPLICATE', status: 409 });
      expect(await refusal(link(two.id, parcel.id, { sharePct: '40.0001' }))).toMatchObject({ code: 'SHARE_EXCEEDS_100', status: 422, extensions: { shares_pct: '60.0000', share_pct: '40.0001' } });
      await link(two.id, parcel.id, { sharePct: '40' });
      expect(await refusal(link(three.id, parcel.id, { sharePct: '0.0001' }))).toMatchObject({ code: 'SHARE_EXCEEDS_100' });
    });

    it('refuses a parcel of another project or another unit, one that is not there, a document that is not clean and a share that is not a share', async () => {
      const target = await register();
      const reason = (value: string) => ({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcel_id', extensions: { reason: value } });
      expect(await refusal(link(target.id, (await makeParcel(DEPARTMENT, world.otherProject)).id))).toMatchObject(reason('NOT_A_PARCEL_OF_THE_PROJECT'));
      expect(await refusal(link(target.id, (await makeParcel(OTHER_BRANCH)).id))).toMatchObject(reason('NOT_A_PARCEL_OF_THE_UNIT'));
      expect(await refusal(link(target.id, randomUUID()))).toMatchObject(reason('NOT_FOUND'));
      const parcel = await makeParcel();
      expect(await refusal(link(target.id, parcel.id, { titleDocumentVersionId: world.pendingDocument }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(link(target.id, parcel.id, { titleDocumentVersionId: randomUUID() }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'title_document_version_id',
        extensions: { reason: 'NOT_FOUND' },
      });
      expect(await refusal(link(target.id, parcel.id, { titleDocumentVersionId: 'nope' }))).toMatchObject({ detail: 'title_document_version_id' });
      for (const sharePct of ['0', '100.0001', '-5', 'half', '12.34567'])
        expect(await refusal(link(target.id, parcel.id, { sharePct }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'share_pct' });
      expect(await refusal(link(target.id, parcel.id, { rightKind: 'KING' }))).toMatchObject({ detail: 'right_kind' });
      expect(await owner('select 1 from machvon.household_parcel where household_id = $1::uuid', [target.id])).toEqual([]);
    });

    it('does not link a household outside the scope of the caller: it is not there for them', async () => {
      const target = await register({ ownerUnitId: unitId(DEPARTMENT) });
      const parcel = await makeParcel();
      expect(await refusal(link(target.id, parcel.id, {}, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(link(randomUUID(), parcel.id))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the database', () => {
    it('keeps what a household is, moves its status along the edges only, and never deletes it', async () => {
      const target = await register();
      const update = (set: string, units: string | null = EVERYWHERE) => owner(`update machvon.affected_household set ${set} where id = $1::uuid`, [target.id], units);
      expect((await sqlState(update("household_code = 'HH-999999'"))).message).toContain('never changes');
      expect((await sqlState(update(`owner_unit_id = '${unitId(OTHER_BRANCH)}'`))).message).toContain('never changes');
      expect((await sqlState(update("status = 'CLOSED'"))).message).toContain('this move of the status');
      await update("status = 'INVENTORIED'");
      expect((await sqlState(update("status = 'REGISTERED'"))).message).toContain('this move of the status');
      await update("status = 'DISPUTED'");
      await update("status = 'INVENTORIED'");
      expect((await sqlState(as((tx) => tx.query('delete from machvon.affected_household where id = $1::uuid', [target.id])))).message).toContain('permission denied');
    });

    it('refuses a household that is not registered first, whose sealed forms disagree, whose words are empty or whose retention began before it did', async () => {
      const insert = (set: Record<string, string>) => {
        const columns = [
          'tenant_id',
          'id',
          'project_id',
          'owner_unit_id',
          'household_code',
          'head_name',
          'head_name_enc',
          'legal_basis',
          'legal_basis_ref',
          'retention_until',
          'created_by',
          'updated_by',
        ];
        const values = [
          TENANT_A,
          randomUUID(),
          world.project,
          unitId(DEPARTMENT),
          `HH-${randomUUID().slice(0, 8)}`,
          'N**',
          "decode('00', 'hex')",
          'PUBLIC_TASK_LAND_LAW',
          'Law',
          "date '2036-01-01'",
          memberId(ACTOR),
          memberId(ACTOR),
        ];
        const raw = new Set(['head_name_enc', 'retention_until']);
        for (const [column, value] of Object.entries(set)) {
          const at = columns.indexOf(column);
          if (at >= 0) values[at] = value;
          else {
            columns.push(column);
            values.push(value);
            if (/^(national_id_enc|phone_enc|address_enc)$/.test(column)) raw.add(column);
          }
        }
        const params: unknown[] = [];
        const holes = columns.map((column, index) => {
          if (raw.has(column)) return values[index] as string;
          params.push(values[index]);
          return `$${params.length}`;
        });
        return owner(`insert into machvon.affected_household (${columns.join(', ')}) values (${holes.join(', ')})`, params);
      };
      expect(await insert({})).toEqual([]);
      expect((await sqlState(insert({ status: 'CLOSED' }))).message).toContain('registered first');
      expect((await sqlState(insert({ national_id_hash: 'a'.repeat(64) }))).message).toContain('affected_household_sealed_chk');
      expect((await sqlState(insert({ national_id_enc: "decode('00', 'hex')" }))).message).toContain('affected_household_sealed_chk');
      expect((await sqlState(insert({ head_name: '   ' }))).message).toContain('affected_household_text_chk');
      expect((await sqlState(insert({ legal_basis_ref: '' }))).message).toContain('affected_household_text_chk');
      expect((await sqlState(insert({ retention_until: "date '2020-01-01'" }))).message).toContain('affected_household_retention_chk');
      expect((await sqlState(insert({ legal_basis: 'CONSENT' }))).message).toContain('affected_household_consent_chk');
    });

    it('keeps a link inside one unit and one project, never changes it and refuses shares above the whole', async () => {
      const target = await register();
      const parcel = await makeParcel();
      const linked = await link(target.id, parcel.id, { sharePct: '50' });
      const rogue = (parcelId: string, householdId: string, share: string, unit = unitId(DEPARTMENT)) =>
        owner(
          `insert into machvon.household_parcel (tenant_id, id, household_id, parcel_id, owner_unit_id, right_kind, share_pct, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, 'OWNER', $5::numeric, $6, $6)`,
          [TENANT_A, householdId, parcelId, unit, share, memberId(ACTOR)],
        );
      const other = await register();
      expect((await sqlState(rogue(parcel.id, other.id, '60'))).message).toContain('SHARE_EXCEEDS_100');
      expect((await sqlState(rogue((await makeParcel(OTHER_BRANCH)).id, other.id, '10'))).message).toContain('its own unit and its own project');
      expect((await sqlState(rogue((await makeParcel(DEPARTMENT, world.otherProject)).id, other.id, '10'))).message).toContain('its own unit and its own project');
      expect((await sqlState(rogue(parcel.id, other.id, '10', unitId(OTHER_BRANCH)))).message).toContain('its own unit and its own project');
      expect((await sqlState(owner('update machvon.household_parcel set parcel_id = gen_random_uuid() where id = $1::uuid', [linked.id]))).message).toContain('never changes');
      await owner('update machvon.household_parcel set share_pct = 70 where id = $1::uuid', [linked.id]);
      expect((await sqlState(as((tx) => tx.query('delete from machvon.household_parcel where id = $1::uuid', [linked.id])))).message).toContain('permission denied');
    });

    it('lets a statement in a transaction see the households only after the scope is put', async () => {
      const mine = await register();
      const seen = await as(async (tx) => {
        const before = await tx.query('select id from machvon.affected_household where id = $1::uuid', [mine.id]);
        await enterScope(tx, EVERYWHERE);
        const after = await tx.query('select id from machvon.affected_household where id = $1::uuid', [mine.id]);
        return { before: before.length, after: after.length };
      });
      expect(seen).toEqual({ before: 0, after: 1 });
    });
  });

  describe('the requests of the people whose data a household holds (ST-LND-003)', () => {
    describe('erasing', () => {
      it('AC-ST-LND-003-1, UAT-AC381: holds an erasure back while a payment was made to the household (409 RETENTION_LEGAL_HOLD), and changes and records nothing', async () => {
        const paid = await register();
        await pay(paid.id, 'PAID');
        await pay(paid.id, 'DEPOSITED', 2);
        const before = await stored(paid.id);
        const held = await refusal(handle(paid.id, 'ERASE', 'FULFILLED'));
        expect(held).toMatchObject({ code: 'RETENTION_LEGAL_HOLD', status: 409, extensions: { retained_payments: 2 } });
        expect(await stored(paid.id)).toEqual(before);
        expect(await requestsOf(paid.id)).toEqual([]);
      });

      it('AC-ST-LND-003-1, UAT-AC381: meets an erasure in part when the officer says so, erasing the telephone and the address and keeping the name, the identity number and the code, with the reason', async () => {
        const paid = await register();
        await pay(paid.id, 'PAID');
        const done = await handle(paid.id, 'ERASE', 'PARTIAL', { reason: 'The payment voucher names the head of the household' });
        expect(done).toMatchObject({ householdId: paid.id, requestKind: 'ERASE', outcome: 'PARTIAL', erasedFields: ['phone', 'address_text'], retainedPayments: 1, restricted: false, anonymised: false, version: 2 });
        expect(await stored(paid.id)).toMatchObject({
          head_name: 'N***** V** A',
          address_text: null,
          phone_masked: null,
          national_id_masked: expect.stringMatching(/^\*{8}\d{4}$/),
          has_name: true,
          has_nid: true,
          has_hash: true,
          has_phone: false,
          has_address: false,
          anonymised: false,
          version: '2',
        });
        expect(await requestsOf(paid.id)).toEqual([
          { request_kind: 'ERASE', outcome: 'PARTIAL', reason: 'The payment voucher names the head of the household', erased_fields: ['phone', 'address_text'], retained_payments: 1, restricted: false, requester_verified: true },
        ]);
        const identity = await as((tx) => households.reveal(tx, paid.id, EVERYWHERE));
        expect(identity).toMatchObject({ headName: HEAD, phone: null, addressText: null });
        expect(identity.nationalId).not.toBeNull();
      });

      it('AC-ST-LND-003-1, UAT-AC381: anonymises a household that nothing was paid to, keeping the record, the code, the unit and the basis', async () => {
        const nid = uniqueId();
        const unpaid = await register({ nationalId: nid });
        await pay(unpaid.id, 'PENDING');
        await pay(unpaid.id, 'CANCELLED', 2);
        const done = await handle(unpaid.id, 'ERASE', 'FULFILLED');
        expect(done).toMatchObject({ erasedFields: ['head_name', 'national_id', 'phone', 'address_text'], retainedPayments: 0, anonymised: true, version: 2 });
        expect(await stored(unpaid.id)).toMatchObject({
          head_name: '[erased]',
          address_text: null,
          national_id_masked: null,
          phone_masked: null,
          has_name: true,
          has_nid: false,
          has_hash: false,
          has_phone: false,
          has_address: false,
          anonymised: true,
        });
        const identity = await as((tx) => households.reveal(tx, unpaid.id, EVERYWHERE));
        expect(identity).toMatchObject({ headName: '[erased]', nationalId: null, phone: null, addressText: null, householdCode: unpaid.householdCode });
        const line = (await list(EVERYWHERE, { projectId: world.project })).find((entry) => entry.id === unpaid.id);
        expect(line).toMatchObject({ anonymised: true, headNameMasked: '[erased]', nationalIdMasked: null, phoneMasked: null, addressMasked: null, legalBasis: 'PUBLIC_TASK_LAND_LAW', status: 'REGISTERED' });
        // The same identity number may be registered again: the blind index went with the data.
        expect((await register({ nationalId: nid })).householdCode).toMatch(/^HH-/);
      });

      it('asks nothing more of a household that is anonymised already: the second erasure erases nothing and changes no version, and the personal data cannot be written back', async () => {
        const gone = await register();
        await handle(gone.id, 'ERASE', 'FULFILLED');
        const again = await handle(gone.id, 'ERASE', 'FULFILLED');
        expect(again).toMatchObject({ erasedFields: [], anonymised: true, version: 2 });
        expect(await requestsOf(gone.id)).toHaveLength(2);
        const rewrite = (assignment: string) => sqlState(owner(`update machvon.affected_household set ${assignment} where id = $1::uuid`, [gone.id]));
        expect((await rewrite("head_name = 'Someone'")).message).toContain('does not get its personal data back');
        expect((await rewrite('anonymised_at = null')).message).toContain('does not get its personal data back');
        expect((await rewrite("phone_masked = '*******123'")).message).toContain('does not get its personal data back');
      });

      it('lets the officer refuse an erasure, which changes nothing and keeps the reason', async () => {
        const kept = await register();
        const before = await stored(kept.id);
        const done = await handle(kept.id, 'ERASE', 'REFUSED', { reason: 'The household is a party to a complaint that is still open' });
        expect(done).toMatchObject({ erasedFields: [], anonymised: false, restricted: false, version: 1 });
        expect(await stored(kept.id)).toEqual(before);
        expect(await requestsOf(kept.id)).toEqual([
          { request_kind: 'ERASE', outcome: 'REFUSED', reason: 'The household is a party to a complaint that is still open', erased_fields: [], retained_payments: 0, restricted: false, requester_verified: true },
        ]);
      });
    });

    describe('the other requests', () => {
      it('AC-ST-LND-003-1: serves an access and a rectification by recording them, with the household left as it was', async () => {
        const mine = await register();
        const before = await stored(mine.id);
        for (const kind of ['ACCESS', 'RECTIFY']) expect(await handle(mine.id, kind, 'FULFILLED')).toMatchObject({ requestKind: kind, erasedFields: [], version: 1 });
        expect(await stored(mine.id)).toEqual(before);
        expect((await requestsOf(mine.id)).map((entry) => entry.request_kind)).toEqual(['ACCESS', 'RECTIFY']);
      });

      it('does not handle a request of a person who was not verified (422 REQUESTER_NOT_VERIFIED), whatever it asks, and records nothing', async () => {
        const mine = await register();
        for (const kind of ['ACCESS', 'ERASE', 'RESTRICT']) expect(await refusal(handle(mine.id, kind, 'FULFILLED', { verified: false }))).toMatchObject({ code: 'REQUESTER_NOT_VERIFIED', status: 422, detail: 'requester_verified' });
        expect(await requestsOf(mine.id)).toEqual([]);
        expect((await stored(mine.id))?.version).toBe('1');
      });

      it('restricts the processing at the request of the person: the sealed data is kept and is no longer opened (409 PROCESSING_RESTRICTED), and the list says so', async () => {
        const mine = await register();
        expect(await handle(mine.id, 'RESTRICT', 'FULFILLED')).toMatchObject({ restricted: true, erasedFields: [], version: 2 });
        expect(await stored(mine.id)).toMatchObject({ restricted: true, has_name: true, has_nid: true, anonymised: false });
        expect(await refusal(as((tx) => households.reveal(tx, mine.id, EVERYWHERE)))).toMatchObject({ code: 'PROCESSING_RESTRICTED', status: 409 });
        expect((await list(EVERYWHERE, { projectId: world.project })).find((entry) => entry.id === mine.id)).toMatchObject({ processingRestricted: true, anonymised: false });
        // A second restriction records the request and changes nothing; the restriction is not lifted by an update.
        expect(await handle(mine.id, 'RESTRICT', 'PARTIAL')).toMatchObject({ restricted: true, version: 2 });
        expect((await sqlState(owner('update machvon.affected_household set processing_restricted_at = null where id = $1::uuid', [mine.id]))).message).toContain('is not lifted here');
        expect(await requestsOf(mine.id)).toHaveLength(2);
      });

      it('lets the withdrawal of a consent erase the telephone and the address of a household registered on that consent, and nothing else', async () => {
        const consent = await register({ legalBasis: 'CONSENT', consentRecordId: randomUUID() });
        expect(await handle(consent.id, 'WITHDRAW_CONSENT', 'FULFILLED')).toMatchObject({ erasedFields: ['phone', 'address_text'], anonymised: false, version: 2 });
        expect(await stored(consent.id)).toMatchObject({ has_name: true, has_nid: true, has_phone: false, has_address: false, anonymised: false });
      });

      it('refuses the withdrawal of a consent that was never the basis (422 VALIDATION_FAILED, request_kind)', async () => {
        const task = await register();
        expect(await refusal(handle(task.id, 'WITHDRAW_CONSENT', 'FULFILLED'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'request_kind', extensions: { reason: 'NOT_CONSENT_BASED' } });
        expect(await handle(task.id, 'WITHDRAW_CONSENT', 'REFUSED')).toMatchObject({ outcome: 'REFUSED', erasedFields: [] });
      });

      it('erases only what the household holds: no telephone and no address, none to name', async () => {
        const bare = await register({ phone: undefined, addressText: undefined });
        expect(await handle(bare.id, 'ERASE', 'PARTIAL')).toMatchObject({ erasedFields: [], version: 1 });
        expect(await handle(bare.id, 'ERASE', 'FULFILLED')).toMatchObject({ erasedFields: ['head_name', 'national_id'], anonymised: true, version: 2 });
      });
    });

    describe('what is asked and who asks', () => {
      it('wants a kind, an outcome and a reason that are what they should be (422 VALIDATION_FAILED)', async () => {
        const mine = await register();
        expect(await refusal(handle(mine.id, 'PORT', 'FULFILLED'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'request_kind' });
        expect(await refusal(handle(mine.id, 'ACCESS', 'MAYBE'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
        for (const reason of ['', '   ', 'x'.repeat(2001), 'a\u0007b']) expect(await refusal(handle(mine.id, 'ACCESS', 'FULFILLED', { reason }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
        expect(await requestsOf(mine.id)).toEqual([]);
      });

      it('does not find a household outside the scope of the caller (404), and does not record a thing for it', async () => {
        const mine = await register();
        expect(await refusal(handle(mine.id, 'ACCESS', 'FULFILLED', {}, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
        expect(await refusal(handle(mine.id, 'ACCESS', 'FULFILLED', {}, ''))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
        expect(await refusal(handle(randomUUID(), 'ACCESS', 'FULFILLED'))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
        expect(await handle(mine.id, 'ACCESS', 'FULFILLED', {}, unitId(DEPARTMENT))).toMatchObject({ requestKind: 'ACCESS' });
        expect(await requestsOf(mine.id)).toHaveLength(1);
      });

      it('keeps the records of the requests inside the unit, for good: the policy hides them, the runtime role cannot change or remove them, and a refused request cannot carry an erasure', async () => {
        const mine = await register();
        await handle(mine.id, 'ACCESS', 'FULFILLED');
        const visible = (units: string | null) => owner<{ n: string }>('select count(*)::text as n from machvon.household_data_request where household_id = $1::uuid', [mine.id], units);
        expect((await visible(EVERYWHERE))[0]?.n).toBe('1');
        expect((await visible(unitId(OTHER_BRANCH)))[0]?.n).toBe('0');
        expect((await visible(unitId(DEPARTMENT)))[0]?.n).toBe('1');
        expect((await visible(''))[0]?.n).toBe('0');
        for (const statement of ['delete from machvon.household_data_request', "update machvon.household_data_request set reason = 'changed'", 'truncate machvon.household_data_request']) {
          expect((await sqlState(as(async (tx) => { await enterScope(tx, EVERYWHERE); await tx.query(statement); }))).message).toContain('permission denied');
        }
        const insert = (kind: string, outcome: string, erased: string, restricted: boolean, verified = true) =>
          sqlState(
            owner(
              `insert into machvon.household_data_request (tenant_id, id, household_id, owner_unit_id, request_kind, requester_verified, outcome, reason, erased_fields, restricted, handled_by)
               values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4, $8, $5, 'a reason', $6::text[], $7, $9)`,
              [TENANT_A, mine.id, unitId(DEPARTMENT), kind, outcome, erased, restricted, verified, memberId(ACTOR)],
            ),
          );
        expect((await insert('ERASE', 'REFUSED', '{phone}', false)).message).toContain('household_data_request_refused_chk');
        expect((await insert('RESTRICT', 'REFUSED', '{}', true)).message).toContain('household_data_request_refused_chk');
        expect((await insert('ERASE', 'FULFILLED', '{iban}', false)).message).toContain('erased_fields');
        expect((await insert('ACCESS', 'FULFILLED', '{}', false, false)).message).toContain('requester_verified');
        expect((await insert('PORT', 'FULFILLED', '{}', false)).message).toContain('request_kind');
      });
    });
  });
});

/** A payment made to a household: the voucher of it has to be kept. Written as the superuser with the foreign keys off, because the plan that a payment belongs to is another story. */
async function pay(householdId: string, status: 'PAID' | 'DEPOSITED' | 'PENDING' | 'CANCELLED', paymentNo = 1): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const paid = status === 'PAID' || status === 'DEPOSITED';
    await client.query(
      `insert into machvon.compensation_payment
         (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, paid_on, method, voucher_document_version_id, deposit_reason, status, created_by, updated_by)
       values ($1, gen_random_uuid(), gen_random_uuid(), $2::uuid, $3::uuid, $4, 1000000, date '2026-10-01', $5, $6, $7, $8, $9, $10, $10)`,
      [TENANT_A, householdId, unitId(DEPARTMENT), paymentNo, paid ? '2026-10-10' : null, paid ? 'BANK_TRANSFER' : null, paid ? world.cleanDocument : null, status === 'DEPOSITED' ? 'The household did not come' : null, status, memberId(ACTOR)],
    );
  } finally {
    await client.end();
  }
}

const REASON = 'The request was checked against the record of the household';
const handle = (householdId: string, requestKind: string, outcome: string, extra: { verified?: boolean; reason?: string } = {}, units = EVERYWHERE) =>
  as((tx) => households.handleRequest(tx, householdId, { requestKind, requesterVerified: extra.verified ?? true, outcome, reason: extra.reason ?? REASON }, memberId(ACTOR), units));
const stored = async (householdId: string) =>
  (
    await owner<Record<string, unknown>>(
      `select head_name, address_text, national_id_masked, phone_masked, head_name_enc is not null as has_name, national_id_enc is not null as has_nid, national_id_hash is not null as has_hash, phone_enc is not null as has_phone,
              address_enc is not null as has_address, anonymised_at is not null as anonymised, processing_restricted_at is not null as restricted, version::text as version
         from machvon.affected_household where id = $1::uuid`,
      [householdId],
    )
  )[0];
const requestsOf = (householdId: string) =>
  owner<{ request_kind: string; outcome: string; reason: string; erased_fields: string[]; retained_payments: number; restricted: boolean; requester_verified: boolean }>(
    'select request_kind, outcome, reason, erased_fields, retained_payments, restricted, requester_verified from machvon.household_data_request where household_id = $1::uuid order by handled_at, id',
    [householdId],
  );

void id;
