import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, staticKeyProvider } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
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
});

void id;
