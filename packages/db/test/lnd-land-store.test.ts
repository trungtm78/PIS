import { randomUUID } from 'node:crypto';
import { handedRatio } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { LndParcelStore, parcelCodeOf, parcelScope } from '../src/lnd-parcel-store';
import { LndSectionStore } from '../src/lnd-section-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { projectScope } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { WorkCalendarStore } from '../src/work-calendar-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const sections = new LndSectionStore();
const parcels = new LndParcelStore();
const calendars = new WorkCalendarStore();
const ACTOR = 1;
const TODAY = '2026-10-24';
const READ = 'land.read';
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xb0;
const NOW = new Date('2026-10-24T03:00:00Z');

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
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
const tenantWide = (permission: string): EffectiveAccess => grant(permission, { kind: 'TENANT' });
const subtree = (unit: number, path: string): EffectiveAccess => grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [path] });

const section = (extra: Record<string, unknown> = {}) => {
  counter += 1;
  return { projectId: world.project, code: `SEC-${String(counter).padStart(3, '0')}`, name: 'Km 0 to km 3', requiredAreaM2: '30000', ...extra };
};
const parcel = (extra: Record<string, unknown> = {}) => {
  counter += 1;
  return { projectId: world.project, ownerUnitId: unitId(DEPARTMENT), parcelCode: `LP-A-${String(counter).padStart(3, '0')}`, landUseGroup: 'AGRICULTURAL' as const, areaTotalM2: '1200.5', areaAffectedM2: '800', ...extra };
};
const makeParcel = (extra: Record<string, unknown> = {}) => as((tx) => parcels.create(tx, parcel(extra), memberId(ACTOR), TODAY));
const notice = (parcelId: string, version: number, noticeOn: string, documentId = world.cleanDocument, today = TODAY) =>
  as((tx) => parcels.recordNotice(tx, { parcelId, expectedVersion: version, noticeOn, noticeDocumentVersionId: documentId }, memberId(ACTOR), today));
const parcelRow = async (parcelId: string) =>
  (
    await owner<{ status: string; version: string; recovery_notice_on: string | null; notice_days_applied: number | null; recovery_decision_on: string | null; notice_document_version_id: string | null }>(
      `select status, version::text as version, recovery_notice_on::text as recovery_notice_on, notice_days_applied, recovery_decision_on::text as recovery_decision_on, notice_document_version_id
         from machvon.land_parcel where id = $1::uuid`,
      [parcelId],
    )
  )[0];
const deadlineRows = (parcelId: string) =>
  owner<{ id: string; timer_code: string; days_applied: number; started_on: string; due_on: string; status: string; satisfied_on: string | null; rule_version_id: string }>(
    `select id, timer_code, days_applied, started_on::text as started_on, due_on::text as due_on, status, satisfied_on::text as satisfied_on, rule_version_id
       from machvon.land_deadline where subject_id = $1::uuid order by created_at`,
    [parcelId],
  );
const ruleVersion = async (key: string) =>
  (await owner<{ id: string; revision: number }>("select v.id, v.revision from machvon.master_record_version v where v.master_type = 'LND_TIMER' and v.code = $1 order by v.revision desc limit 1", [key]))[0];

describe('the sections, parcels and recovery timers of land clearance (ST-LND-001)', () => {
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
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(ACTOR)));
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('createLandSection (LND-10)', () => {
    it('keeps a section NOT_READY with nothing handed over, at version 1, with its areas as exact decimals', async () => {
      const input = section({ contractId: world.contract, fromKm: '0', toKm: '3.5', requiredAreaM2: '30000.5', targetDate: '2027-03-01' });
      const created = await as((tx) => sections.create(tx, input, memberId(ACTOR)));
      expect(created).toMatchObject({ projectId: world.project, contractId: world.contract, requiredAreaM2: '30000.50', version: 1, status: 'NOT_READY' });
      const [row] = await owner<Record<string, unknown>>(
        'select code, name, from_km::text as from_km, to_km::text as to_km, required_area_m2::text as required_area_m2, handed_area_m2::text as handed_area_m2, target_date::text as target_date, status, version::text as version, created_by from machvon.land_handover_section where id = $1::uuid',
        [created.id],
      );
      expect(row).toEqual({ code: input.code, name: 'Km 0 to km 3', from_km: '0.00', to_km: '3.50', required_area_m2: '30000.50', handed_area_m2: '0.00', target_date: '2027-03-01', status: 'NOT_READY', version: '1', created_by: memberId(ACTOR) });
    });

    it('refuses a second section with the same code in the project with 409 and leaves the transaction usable, and allows the code in another project', async () => {
      const first = section();
      await as((tx) => sections.create(tx, first, memberId(ACTOR)));
      const outcome = await as(async (tx) => {
        const refused = await refusal(sections.create(tx, { ...first, name: 'Again' }, memberId(ACTOR)));
        // The refusal rolled back to a savepoint: the transaction goes on (a raw 25P02 would fail here).
        const still = await tx.query<{ n: string }>('select count(*)::text as n from machvon.land_handover_section where project_id = $1::uuid', [world.project]);
        return { refused, still: Number(still[0]?.n) };
      });
      expect(outcome.refused).toEqual({ code: 'SECTION_CODE_DUPLICATE', status: 409 });
      expect(outcome.still).toBeGreaterThan(0);
      await expect(as((tx) => sections.create(tx, { ...first, projectId: world.otherProject }, memberId(ACTOR)))).resolves.toMatchObject({ version: 1 });
    });

    it('trims the code and the name, and refuses text that is empty, too long or has a control character', async () => {
      const created = await as((tx) => sections.create(tx, section({ code: '  KM-TRIM  ', name: '  A name  ' }), memberId(ACTOR)));
      const [row] = await owner<{ code: string; name: string }>('select code, name from machvon.land_handover_section where id = $1::uuid', [created.id]);
      expect(row).toEqual({ code: 'KM-TRIM', name: 'A name' });
      for (const [field, value] of [
        ['code', '   '],
        ['code', 'x'.repeat(51)],
        ['name', ''],
        ['name', 'x'.repeat(301)],
        ['code', 'A\u0007B'],
      ] as const) {
        expect(await refusal(as((tx) => sections.create(tx, section({ [field]: value }), memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      }
    });

    it('refuses an area wider than its column, a negative or fractional-third figure, a km order that is reversed and a date that is not a date, as 422 and not as a database overflow', async () => {
      for (const [field, value] of [
        ['requiredAreaM2', '1000000000000'],
        ['requiredAreaM2', '-1'],
        ['requiredAreaM2', '1.234'],
        ['requiredAreaM2', 'many'],
        ['fromKm', '1000000'],
        ['toKm', 'abc'],
        ['targetDate', '2027-02-30'],
      ] as const) {
        const detail = field === 'requiredAreaM2' ? 'required_area_m2' : field === 'fromKm' ? 'from_km' : field === 'toKm' ? 'to_km' : 'target_date';
        expect(await refusal(as((tx) => sections.create(tx, section({ [field]: value }), memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
      }
      expect(await refusal(as((tx) => sections.create(tx, section({ fromKm: '5', toKm: '3' }), memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'to_km' });
      await expect(as((tx) => sections.create(tx, section({ requiredAreaM2: '999999999999.99' }), memberId(ACTOR)))).resolves.toMatchObject({ requiredAreaM2: '999999999999.99' });
    });

    it('takes a contract of the same project only', async () => {
      expect(await refusal(as((tx) => sections.create(tx, section({ contractId: world.foreignContract }), memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      expect(await refusal(as((tx) => sections.create(tx, section({ contractId: id(FAMILY, 999) }), memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
    });

    it('stores an identifier in capitals as the lower-case uuid the database writes', async () => {
      const created = await as((tx) => sections.create(tx, section({ projectId: world.project.toUpperCase(), contractId: world.contract.toUpperCase() }), memberId(ACTOR)));
      expect(created.projectId).toBe(world.project);
      expect(created.contractId).toBe(world.contract);
    });

    it('is guarded by the database: more handed over than required, a reversed km range and a changed code are refused', async () => {
      const created = await as((tx) => sections.create(tx, section({ fromKm: '1', toKm: '2' }), memberId(ACTOR)));
      expect((await sqlState(owner('update machvon.land_handover_section set handed_area_m2 = required_area_m2 + 1 where id = $1::uuid', [created.id]))).message).toContain('land_section_area_chk');
      expect((await sqlState(owner('update machvon.land_handover_section set from_km = 9 where id = $1::uuid', [created.id]))).message).toContain('land_section_km_chk');
      expect((await sqlState(owner("update machvon.land_handover_section set code = 'RENAMED' where id = $1::uuid", [created.id]))).sqlstate).toBe('23514');
      expect((await sqlState(owner('update machvon.land_handover_section set project_id = $2::uuid where id = $1::uuid', [created.id, world.otherProject]))).sqlstate).toBe('23514');
    });

    it('lists the sections of a project in the scope of the caller, by code', async () => {
      const everywhere = projectScope(tenantWide(READ), READ, NOW);
      const rows = await as((tx) => sections.listOfProject(tx, world.project, everywhere));
      expect(rows.length).toBeGreaterThan(3);
      expect(rows.map((row) => row.code)).toEqual([...rows.map((row) => row.code)].sort());
      expect(rows[0]).toMatchObject({ projectId: world.project, handedAreaM2: '0.00', status: 'NOT_READY' });
      const elsewhere = projectScope(subtree(OTHER_BRANCH, '/u3/'), READ, NOW);
      expect(await as((tx) => sections.listOfProject(tx, world.project, elsewhere))).toEqual([]);
      const department = projectScope(subtree(DEPARTMENT, '/u1/u2/'), READ, NOW);
      expect((await as((tx) => sections.listOfProject(tx, world.project, department))).length).toBe(rows.length);
    });
  });

  describe('createLandParcel (LND-02)', () => {
    it('declares a parcel in SURVEYED at version 1 with a normalised code and exact areas', async () => {
      const created = await makeParcel({ parcelCode: ' tb-12/345 ', areaTotalM2: '1200.5', areaAffectedM2: '800', addressText: '  Hamlet 3  ' });
      expect(created).toMatchObject({ projectId: world.project, parcelCode: 'TB-12/345', areaTotalM2: '1200.50', areaAffectedM2: '800.00', version: 1, status: 'SURVEYED', sectionId: null });
      const [row] = await owner<Record<string, unknown>>(
        'select address_text, area_total_m2::text as area_total_m2, status, notice_days_applied, recovery_notice_on, boundary_geojson from machvon.land_parcel where id = $1::uuid',
        [created.id],
      );
      expect(row).toEqual({ address_text: 'Hamlet 3', area_total_m2: '1200.50', status: 'SURVEYED', notice_days_applied: null, recovery_notice_on: null, boundary_geojson: null });
    });

    it('normalises the code the way a register writes it and refuses what is not a code', () => {
      expect(parcelCodeOf('  tb-12/345 ', 'c')).toBe('TB-12/345');
      expect(parcelCodeOf('12.3_4', 'c')).toBe('12.3_4');
      for (const text of ['', ' ', 'to 12', '-12', '12\n3', 'x'.repeat(51), 'số 12']) {
        let caught: { code?: string; detail?: string } | undefined;
        try {
          parcelCodeOf(text, 'c');
        } catch (error) {
          caught = error as { code?: string; detail?: string };
        }
        expect(caught).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'c' });
      }
    });

    it('refuses an area that cannot be the area of a parcel with AREA_INVALID and one that is not a figure with VALIDATION_FAILED', async () => {
      expect(await refusal(makeParcel({ areaTotalM2: '0', areaAffectedM2: '0' }))).toEqual({ code: 'AREA_INVALID', status: 422, detail: 'area_total_m2' });
      expect(await refusal(makeParcel({ areaTotalM2: '100', areaAffectedM2: '100.01' }))).toEqual({ code: 'AREA_INVALID', status: 422, detail: 'area_affected_m2' });
      await expect(makeParcel({ areaTotalM2: '100', areaAffectedM2: '100' })).resolves.toMatchObject({ areaAffectedM2: '100.00' });
      await expect(makeParcel({ areaTotalM2: '100', areaAffectedM2: '0' })).resolves.toMatchObject({ areaAffectedM2: '0.00' });
      expect(await refusal(makeParcel({ areaTotalM2: '1e3' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'area_total_m2' });
      expect(await refusal(makeParcel({ areaTotalM2: '1000000000000', areaAffectedM2: '1' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'area_total_m2' });
      expect(await refusal(makeParcel({ areaAffectedM2: '-5' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'area_affected_m2' });
    });

    it('refuses a code that is not a code, and the same code twice in a project (whatever its capitals), with 409 and a usable transaction', async () => {
      expect(await refusal(makeParcel({ parcelCode: 'has space' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcel_code' });
      expect(await refusal(makeParcel({ parcelCode: '' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcel_code' });
      expect(await refusal(makeParcel({ parcelCode: 'x'.repeat(51) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcel_code' });
      await makeParcel({ parcelCode: 'DUP-1' });
      const outcome = await as(async (tx) => {
        const refused = await refusal(parcels.create(tx, parcel({ parcelCode: 'dup-1' }), memberId(ACTOR), TODAY));
        const next = await parcels.create(tx, parcel(), memberId(ACTOR), TODAY);
        return { refused, next };
      });
      expect(outcome.refused).toEqual({ code: 'PARCEL_CODE_DUPLICATE', status: 409 });
      expect(outcome.next.version).toBe(1);
      await expect(makeParcel({ parcelCode: 'DUP-1', projectId: world.otherProject })).resolves.toMatchObject({ parcelCode: 'DUP-1' });
    });

    it('takes a unit that exists and is active, a section of the same project and a ward in force', async () => {
      expect(await refusal(makeParcel({ projectId: id(FAMILY, 900) }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(makeParcel({ ownerUnitId: id(FAMILY, 901) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_unit_id' });
      const otherSection = await as((tx) => sections.create(tx, section({ projectId: world.otherProject }), memberId(ACTOR)));
      expect(await refusal(makeParcel({ sectionId: otherSection.id }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'section_id' });
      const own = await as((tx) => sections.create(tx, section(), memberId(ACTOR)));
      await expect(makeParcel({ sectionId: own.id, wardMasterVersionId: world.ward })).resolves.toMatchObject({ sectionId: own.id });
      expect(await refusal(makeParcel({ wardMasterVersionId: world.retiredWard }))).toEqual({ code: 'MASTER_NOT_EFFECTIVE', status: 422, detail: 'ward_master_version_id' });
      expect(await refusal(makeParcel({ wardMasterVersionId: world.notAWard }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'ward_master_version_id' });
      expect(await refusal(makeParcel({ wardMasterVersionId: id(FAMILY, 902) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'ward_master_version_id' });
    });

    it('refuses an address that is empty, too long or has a control character, and keeps the outline as geometry and nothing else', async () => {
      expect(await refusal(makeParcel({ addressText: '   ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'address_text' });
      expect(await refusal(makeParcel({ addressText: 'x'.repeat(501) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'address_text' });
      const ring = [[[0, 0], [0, 1], [1, 1], [0, 0]]];
      const created = await makeParcel({ boundaryGeojson: { type: 'Polygon', coordinates: ring } });
      const [row] = await owner<{ boundary_geojson: unknown }>('select boundary_geojson from machvon.land_parcel where id = $1::uuid', [created.id]);
      expect(row?.boundary_geojson).toEqual({ type: 'Polygon', coordinates: ring });
      await expect(makeParcel({ boundaryGeojson: { type: 'MultiPolygon', coordinates: [ring] } })).resolves.toMatchObject({ version: 1 });
      for (const outline of [
        { type: 'Polygon', coordinates: ring, properties: { owner: 'Nguyen Van A' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: ring }, properties: { name: 'A' } },
        { type: 'Point', coordinates: [1, 2] },
        { type: 'Polygon' },
        { coordinates: ring },
        'text',
        [],
        null,
        { type: 'Polygon', coordinates: 'x' },
      ]) {
        expect(await refusal(makeParcel({ boundaryGeojson: outline }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'boundary_geojson' });
      }
      expect(await refusal(makeParcel({ boundaryGeojson: { type: 'Polygon', coordinates: [[Array.from({ length: 30000 }, () => [123456.789, 654321.987])]] } }))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'boundary_geojson',
      });
    });
  });

  describe('a parcel carries no owner and no user of the land (AC-ST-LND-001-2)', () => {
    it('has no column that could hold a person: the whole of what a parcel keeps is a code, an address, areas, a land use, an outline and the unit that answers for it', async () => {
      const columns = await owner<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'machvon' and table_name = 'land_parcel' order by column_name");
      expect(columns.map((column) => column.column_name)).toEqual([
        'address_text',
        'area_affected_m2',
        'area_total_m2',
        'boundary_geojson',
        'created_at',
        'created_by',
        'id',
        'land_use_group',
        'notice_days_applied',
        'notice_document_version_id',
        'owner_unit_id',
        'parcel_code',
        'project_id',
        'recovery_decision_on',
        'recovery_notice_on',
        'section_id',
        'status',
        'tenant_id',
        'updated_at',
        'updated_by',
        'version',
        'ward_master_version_id',
      ]);
      // owner_unit_id is the unit of the organisation that answers for the parcel; it names no person.
      const [unit] = await owner<{ n: string }>("select count(*)::text as n from information_schema.columns where table_schema = 'machvon' and table_name = 'land_parcel' and column_name ~ '(holder|household|national_id|phone|head_name|user_id|person|owner_name)'");
      expect(unit?.n).toBe('0');
    });

    it('is guarded by the database: an outline with a member other than the geometry cannot be stored by any statement', async () => {
      const created = await makeParcel();
      const bad = await sqlState(owner(`update machvon.land_parcel set boundary_geojson = '{"type":"Polygon","coordinates":[],"properties":{"owner":"x"}}'::jsonb where id = $1::uuid`, [created.id]));
      expect(bad.message).toContain('land_parcel_boundary_geometry_chk');
      const text = await sqlState(owner(`update machvon.land_parcel set address_text = '   ' where id = $1::uuid`, [created.id]));
      expect(text.message).toContain('land_parcel_address_text_chk');
      expect((await sqlState(owner(`update machvon.land_parcel set parcel_code = 'OTHER' where id = $1::uuid`, [created.id]))).sqlstate).toBe('23514');
      expect((await sqlState(owner('update machvon.land_parcel set project_id = $2::uuid where id = $1::uuid', [created.id, world.otherProject]))).sqlstate).toBe('23514');
      expect((await sqlState(owner('update machvon.land_parcel set area_affected_m2 = area_total_m2 + 1 where id = $1::uuid', [created.id]))).message).toContain('land_parcel_area_chk');
    });
  });

  describe('recordRecoveryNotice and the timers (BR-LND-01, AC-ST-LND-001-1, UAT-AC376)', () => {
    it('counts 90 days for agricultural land and 180 for non-agricultural land from the same notice date, with the rule and its legal basis', async () => {
      const agricultural = await makeParcel({ parcelCode: 'LP-A-001', landUseGroup: 'AGRICULTURAL' });
      const residential = await makeParcel({ parcelCode: 'LP-A-002', landUseGroup: 'NON_AGRICULTURAL_RESIDENTIAL' });
      const first = await notice(agricultural.id, 1, '2026-07-01');
      const second = await notice(residential.id, 1, '2026-07-01');
      expect(first).toMatchObject({ timerCode: 'NOTICE_AGRICULTURAL_90', daysApplied: 90, noticeOn: '2026-07-01', dueOn: '2026-09-29', version: 2, status: 'SURVEYED', noticeDocumentVersionId: world.cleanDocument });
      expect(second).toMatchObject({ timerCode: 'NOTICE_NON_AGRICULTURAL_180', daysApplied: 180, dueOn: '2026-12-28', version: 2 });
      const rule90 = await ruleVersion('NOTICE_AGRICULTURAL_90');
      expect(first.ruleVersionId).toBe(rule90?.id);
      expect(first.ruleRevision).toBe(rule90?.revision);
      expect(await deadlineRows(agricultural.id)).toEqual([
        { id: first.deadlineId, timer_code: 'NOTICE_AGRICULTURAL_90', days_applied: 90, started_on: '2026-07-01', due_on: '2026-09-29', status: 'RUNNING', satisfied_on: null, rule_version_id: rule90?.id },
      ]);
      expect((await deadlineRows(residential.id))[0]).toMatchObject({ timer_code: 'NOTICE_NON_AGRICULTURAL_180', days_applied: 180, due_on: '2026-12-28', status: 'RUNNING' });
      expect(await parcelRow(agricultural.id)).toMatchObject({ recovery_notice_on: '2026-07-01', notice_days_applied: 90, version: '2', notice_document_version_id: world.cleanDocument, status: 'SURVEYED' });
      expect(await parcelRow(residential.id)).toMatchObject({ notice_days_applied: 180 });
    });

    it('blocks a decision to recover before the end of the notice and accepts it on the last day, in the database and in the store', async () => {
      const agricultural = await makeParcel({ parcelCode: 'LP-A-011', landUseGroup: 'AGRICULTURAL' });
      const residential = await makeParcel({ parcelCode: 'LP-A-012', landUseGroup: 'NON_AGRICULTURAL_RESIDENTIAL' });
      await notice(agricultural.id, 1, '2026-07-01');
      await notice(residential.id, 1, '2026-07-01');
      // The database refuses the earlier date whoever writes it (UAT-AC376 steps 2 and 3, written straight into the table).
      expect((await sqlState(owner("update machvon.land_parcel set recovery_decision_on = date '2026-09-28' where id = $1::uuid", [agricultural.id]))).message).toContain('land_parcel_notice_chk');
      expect((await sqlState(owner("update machvon.land_parcel set recovery_decision_on = date '2026-12-27' where id = $1::uuid", [residential.id]))).message).toContain('land_parcel_notice_chk');
      expect((await parcelRow(agricultural.id))?.recovery_decision_on).toBeNull();
      // The store answers the same refusal in the words of the contract, before the database is asked.
      const decide = (parcelId: string, version: number, decisionOn: string) =>
        as((tx) => parcels.recordRecoveryDecision(tx, { parcelId, expectedVersion: version, decisionOn }, memberId(ACTOR), TODAY));
      expect(await refusal(decide(agricultural.id, 2, '2026-09-28'))).toEqual({ code: 'NOTICE_PERIOD_NOT_ELAPSED', status: 422, detail: 'recovery_decision_on' });
      expect(await refusal(decide(residential.id, 2, '2026-12-27'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'recovery_decision_on' });
      const done = await decide(agricultural.id, 2, '2026-09-29');
      expect(done).toMatchObject({ decisionOn: '2026-09-29', version: 3 });
      expect((await deadlineRows(agricultural.id))[0]).toMatchObject({ status: 'SATISFIED', satisfied_on: '2026-09-29' });
      expect((await parcelRow(agricultural.id))?.recovery_decision_on).toBe('2026-09-29');
      // A decision is recorded once, and not on a parcel without a notice.
      expect(await refusal(decide(agricultural.id, 3, '2026-10-01'))).toEqual({ code: 'PARCEL_STATE_INVALID', status: 409 });
      const bare = await makeParcel();
      expect(await refusal(decide(bare.id, 1, '2026-09-29'))).toEqual({ code: 'PARCEL_STATE_INVALID', status: 409 });
      expect(await refusal(decide(agricultural.id, 1, '2026-10-01'))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(id(FAMILY, 903), 1, '2026-10-01'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(residential.id, 2, '2027-01-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'recovery_decision_on' });
    });

    it('on the last day of the 180 days the decision of non-agricultural land is accepted (UAT-AC376 step 3)', async () => {
      const residential = await makeParcel({ parcelCode: 'LP-A-013', landUseGroup: 'NON_AGRICULTURAL_OTHER' });
      await notice(residential.id, 1, '2026-07-01');
      const lateToday = '2027-01-15';
      expect(await refusal(as((tx) => parcels.recordRecoveryDecision(tx, { parcelId: residential.id, expectedVersion: 2, decisionOn: '2026-12-27' }, memberId(ACTOR), lateToday)))).toEqual({
        code: 'NOTICE_PERIOD_NOT_ELAPSED',
        status: 422,
        detail: 'recovery_decision_on',
      });
      await expect(as((tx) => parcels.recordRecoveryDecision(tx, { parcelId: residential.id, expectedVersion: 2, decisionOn: '2026-12-28' }, memberId(ACTOR), lateToday))).resolves.toMatchObject({ decisionOn: '2026-12-28' });
    });

    it('treats public land as non-agricultural land: the longer notice', async () => {
      const created = await makeParcel({ landUseGroup: 'PUBLIC' });
      expect(await notice(created.id, 1, '2026-07-01')).toMatchObject({ timerCode: 'NOTICE_NON_AGRICULTURAL_180', daysApplied: 180, dueOn: '2026-12-28' });
    });

    it('answers 422 TIMER_RULE_UNCONFIRMED when no rule is in force on the day of the notice, and starts nothing', async () => {
      const created = await makeParcel({ parcelCode: 'LP-A-003' });
      // The rules of the platform are in force from 2025-01-01: before that day there is none.
      expect(await refusal(notice(created.id, 1, '2024-12-31'))).toEqual({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      expect(await deadlineRows(created.id)).toEqual([]);
      expect(await parcelRow(created.id)).toMatchObject({ recovery_notice_on: null, notice_days_applied: null, version: '1' });
    });

    it('refuses a rule that is not enabled yet: a version that has not been published', async () => {
      const created = await makeParcel({ landUseGroup: 'AGRICULTURAL' });
      await owner("update machvon.master_record_version set published_at = null where master_type = 'LND_TIMER' and code = 'NOTICE_AGRICULTURAL_90'");
      try {
        expect(await refusal(notice(created.id, 1, '2026-07-01'))).toEqual({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      } finally {
        await owner("update machvon.master_record_version set published_at = now() where master_type = 'LND_TIMER' and code = 'NOTICE_AGRICULTURAL_90'");
      }
      await expect(notice(created.id, 1, '2026-07-01')).resolves.toMatchObject({ daysApplied: 90 });
    });

    it('gives a notice once, to a parcel that has not been paid or handed over, on a date that has come, with a clean document', async () => {
      const created = await makeParcel();
      await notice(created.id, 1, '2026-07-01');
      expect(await refusal(notice(created.id, 2, '2026-07-02'))).toEqual({ code: 'PARCEL_STATE_INVALID', status: 409 });
      for (const status of ['PAID', 'HANDED_OVER', 'ENFORCEMENT']) {
        const frozen = await makeParcel();
        await owner('update machvon.land_parcel set status = $2 where id = $1::uuid', [frozen.id, status]);
        expect(await refusal(notice(frozen.id, 1, '2026-07-01'))).toEqual({ code: 'PARCEL_STATE_INVALID', status: 409 });
      }
      for (const status of ['INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED', 'DISPUTED']) {
        const open = await makeParcel();
        await owner('update machvon.land_parcel set status = $2 where id = $1::uuid', [open.id, status]);
        await expect(notice(open.id, 1, '2026-07-01')).resolves.toMatchObject({ status });
      }
      const another = await makeParcel();
      expect(await refusal(notice(another.id, 1, '2026-10-25'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'notice_on' });
      expect(await refusal(notice(another.id, 1, '1989-12-31'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'notice_on' });
      expect(await refusal(notice(another.id, 1, '2026-02-30'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'notice_on' });
      expect(await refusal(notice(another.id, 1, '2026-07-01', world.pendingDocument))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'notice_document_version_id' });
      expect(await refusal(notice(another.id, 1, '2026-07-01', id(FAMILY, 904)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'notice_document_version_id' });
      expect(await refusal(notice(another.id, 5, '2026-07-01'))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(notice(id(FAMILY, 905), 1, '2026-07-01'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await deadlineRows(another.id)).toEqual([]);
      await expect(notice(another.id, 1, '2026-10-24')).resolves.toMatchObject({ dueOn: '2027-01-22' });
    });

    it('lets only one of two notices given at once start a timer', async () => {
      const created = await makeParcel();
      const settled = await Promise.allSettled([notice(created.id, 1, '2026-07-01'), notice(created.id, 1, '2026-07-02')]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(['VERSION_CONFLICT', 'PARCEL_STATE_INVALID']).toContain((failure.reason as { code: string }).code);
      expect(await deadlineRows(created.id)).toHaveLength(1);
    });
  });

  describe('what the database keeps as it was', () => {
    it('does not let a recorded notice, its length, its evidence or the land use that decided it be rewritten', async () => {
      const created = await makeParcel({ landUseGroup: 'AGRICULTURAL' });
      await notice(created.id, 1, '2026-07-01');
      for (const change of [
        "recovery_notice_on = date '2026-07-02'",
        'notice_days_applied = 180',
        `notice_document_version_id = '${world.pendingDocument}'::uuid`,
        "land_use_group = 'NON_AGRICULTURAL_OTHER'",
      ]) {
        expect((await sqlState(owner(`update machvon.land_parcel set ${change} where id = $1::uuid`, [created.id]))).sqlstate).toBe('23514');
      }
      expect((await sqlState(owner('update machvon.land_parcel set recovery_notice_on = null, notice_days_applied = null, notice_document_version_id = null where id = $1::uuid', [created.id]))).sqlstate).toBe('23514');
    });

    it('does not let a recorded decision be rewritten', async () => {
      const created = await makeParcel();
      await notice(created.id, 1, '2026-07-01');
      await as((tx) => parcels.recordRecoveryDecision(tx, { parcelId: created.id, expectedVersion: 2, decisionOn: '2026-10-01' }, memberId(ACTOR), TODAY));
      expect((await sqlState(owner("update machvon.land_parcel set recovery_decision_on = date '2026-10-02' where id = $1::uuid", [created.id]))).sqlstate).toBe('23514');
    });

    it('keeps a notice, its length and its evidence together: all or none', async () => {
      const created = await makeParcel();
      expect((await sqlState(owner("update machvon.land_parcel set recovery_notice_on = date '2026-07-01' where id = $1::uuid", [created.id]))).message).toContain('land_parcel_notice_evidence_chk');
      expect((await sqlState(owner('update machvon.land_parcel set notice_days_applied = 90 where id = $1::uuid', [created.id]))).message).toContain('land_parcel_notice_evidence_chk');
    });

    it('keeps the days, the dates and the rule version of a started timer, and does not start an ended one again', async () => {
      const created = await makeParcel();
      const recorded = await notice(created.id, 1, '2026-07-01');
      for (const change of ["days_applied = 91", "due_on = date '2026-10-30'", "started_on = date '2026-07-02'", "timer_code = 'NOTICE_NON_AGRICULTURAL_180'", 'rule_version_id = null', 'subject_id = gen_random_uuid()']) {
        expect((await sqlState(owner(`update machvon.land_deadline set ${change} where id = $1::uuid`, [recorded.deadlineId]))).sqlstate).toBe('23514');
      }
      await owner("update machvon.land_deadline set status = 'BREACHED' where id = $1::uuid", [recorded.deadlineId]);
      expect((await sqlState(owner("update machvon.land_deadline set status = 'RUNNING' where id = $1::uuid", [recorded.deadlineId]))).sqlstate).toBe('23514');
      // What is not a fact of the timer may still move: the alert level of an ended timer.
      await owner('update machvon.land_deadline set alert_level_sent = 2 where id = $1::uuid', [recorded.deadlineId]);
    });

    it('ties a timer to what it counts and allows one running timer for a subject', async () => {
      const created = await makeParcel();
      const insert = (kind: string, timer: string, status = 'RUNNING') =>
        owner(
          `insert into machvon.land_deadline (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, created_by, updated_by)
           values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, 30, date '2026-07-01', date '2026-07-31', $5, $6::uuid, $6::uuid)`,
          [world.project, kind, created.id, timer, status, memberId(ACTOR)],
        );
      expect((await sqlState(insert('PARCEL', 'PAYMENT_30'))).message).toContain('land_deadline_subject_timer_chk');
      expect((await sqlState(insert('PLAN', 'NOTICE_AGRICULTURAL_90'))).message).toContain('land_deadline_subject_timer_chk');
      await insert('PLAN', 'PLAN_POSTING_30');
      expect((await sqlState(insert('PLAN', 'PLAN_POSTING_30'))).message).toContain('land_deadline_running_uq');
      await insert('PLAN', 'PLAN_POSTING_30', 'CANCELLED');
    });

    it('cannot be deleted or truncated by the runtime role: a section, a parcel and a timer are kept for good', async () => {
      const created = await makeParcel();
      const recorded = await notice(created.id, 1, '2026-07-01');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_parcel where id = $1::uuid', [created.id])))).sqlstate).toBe('42501');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_deadline where id = $1::uuid', [recorded.deadlineId])))).sqlstate).toBe('42501');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_handover_section')))).sqlstate).toBe('42501');
    });
  });

  describe('the reads of parcels (LND-02)', () => {
    it('lists the parcels of a project by code with the timer of the notice and the rule it stands on', async () => {
      const created = await makeParcel({ parcelCode: 'ZZ-LIST-1', landUseGroup: 'AGRICULTURAL', addressText: 'Hamlet 9' });
      await notice(created.id, 1, '2026-07-01');
      const all = parcelScope(tenantWide(READ), READ, NOW);
      const rows = await as((tx) => parcels.list(tx, all, { projectId: world.project }, { limit: 500, after: undefined }));
      expect(rows.map((row) => row.parcelCode)).toEqual([...rows.map((row) => row.parcelCode)].sort());
      const row = rows.find((candidate) => candidate.parcelCode === 'ZZ-LIST-1');
      expect(row).toMatchObject({
        id: created.id,
        ownerUnitName: 'Unit 2',
        addressText: 'Hamlet 9',
        landUseGroup: 'AGRICULTURAL',
        areaTotalM2: '1200.50',
        hasBoundary: false,
        status: 'SURVEYED',
        recoveryNoticeOn: '2026-07-01',
        noticeDaysApplied: 90,
        version: 2,
        deadline: { timerCode: 'NOTICE_AGRICULTURAL_90', daysApplied: 90, startedOn: '2026-07-01', dueOn: '2026-09-29', status: 'RUNNING', awaitingConfirmation: true, cxn: 'CXN-12' },
      });
      expect(row?.deadline?.legalBasis).toContain('Luật Đất đai 2024');
      expect(Object.keys(row ?? {}).sort()).toEqual(
        ['addressText', 'areaAffectedM2', 'areaTotalM2', 'deadline', 'hasBoundary', 'id', 'landUseGroup', 'noticeDaysApplied', 'ownerUnitId', 'ownerUnitName', 'parcelCode', 'projectId', 'recoveryDecisionOn', 'recoveryNoticeOn', 'sectionCode', 'sectionId', 'status', 'version'].sort(),
      );
    });

    it('pages by code and id, and filters by section and status', async () => {
      const own = await as((tx) => sections.create(tx, section(), memberId(ACTOR)));
      const a = await makeParcel({ parcelCode: 'PG-1', sectionId: own.id });
      await makeParcel({ parcelCode: 'PG-2', sectionId: own.id });
      const c = await makeParcel({ parcelCode: 'PG-3', sectionId: own.id });
      await owner("update machvon.land_parcel set status = 'DISPUTED' where id = $1::uuid", [c.id]);
      const all = parcelScope(tenantWide(READ), READ, NOW);
      const first = await as((tx) => parcels.list(tx, all, { projectId: world.project, sectionId: own.id }, { limit: 2, after: undefined }));
      expect(first.map((row) => row.parcelCode)).toEqual(['PG-1', 'PG-2']);
      expect(first[0]?.sectionCode).toBe(own.code);
      const after = first[1] as { parcelCode: string; id: string };
      const second = await as((tx) => parcels.list(tx, all, { projectId: world.project, sectionId: own.id }, { limit: 2, after: { code: after.parcelCode, id: after.id } }));
      expect(second.map((row) => row.parcelCode)).toEqual(['PG-3']);
      const disputed = await as((tx) => parcels.list(tx, all, { projectId: world.project, sectionId: own.id, status: 'DISPUTED' }, { limit: 10, after: undefined }));
      expect(disputed.map((row) => row.id)).toEqual([c.id]);
      expect(a.id).not.toBe(c.id);
    });

    it('shows a caller the parcels of the units in their scope and of the projects they are granted, and a parcel outside it does not exist for them', async () => {
      const inDepartment = await makeParcel({ parcelCode: 'SC-1', ownerUnitId: unitId(DEPARTMENT) });
      const inOther = await makeParcel({ parcelCode: 'SC-2', ownerUnitId: unitId(OTHER_BRANCH) });
      const department = parcelScope(subtree(DEPARTMENT, '/u1/u2/'), READ, NOW);
      const rows = await as((tx) => parcels.list(tx, department, { projectId: world.project }, { limit: 500, after: undefined }));
      expect(rows.map((row) => row.id)).toContain(inDepartment.id);
      expect(rows.map((row) => row.id)).not.toContain(inOther.id);
      expect(await as((tx) => parcels.find(tx, inOther.id, department))).toBeUndefined();
      expect((await as((tx) => parcels.find(tx, inDepartment.id, department)))?.parcelCode).toBe('SC-1');
      const byProject = parcelScope(grant(READ, { kind: 'PROJECT', refIds: [world.project] }), READ, NOW);
      expect((await as((tx) => parcels.find(tx, inOther.id, byProject)))?.parcelCode).toBe('SC-2');
      const nobody = parcelScope(grant('other.permission', { kind: 'TENANT' }), READ, NOW);
      expect(await as((tx) => parcels.list(tx, nobody, { projectId: world.project }, { limit: 10, after: undefined }))).toEqual([]);
      const unitAndProject = parcelScope(
        { ...subtree(OTHER_BRANCH, '/u3/'), grants: [...subtree(OTHER_BRANCH, '/u3/').grants, ...grant(READ, { kind: 'PROJECT', refIds: [world.otherProject] }).grants] },
        READ,
        NOW,
      );
      const mixed = await as((tx) => parcels.list(tx, unitAndProject, { projectId: world.project }, { limit: 500, after: undefined }));
      expect(mixed.map((row) => row.id)).toContain(inOther.id);
      expect(mixed.map((row) => row.id)).not.toContain(inDepartment.id);
    });

    it('does not show a parcel of another tenant', async () => {
      const all = parcelScope(tenantWide(READ), READ, NOW);
      const created = await makeParcel();
      expect(await as((tx) => parcels.find(tx, created.id, all), TENANT_B)).toBeUndefined();
      expect(await as((tx) => parcels.list(tx, all, { projectId: world.project }, { limit: 500, after: undefined }), TENANT_B)).toEqual([]);
    });
  });

  describe('timers counted in working days (the working calendar of ADM)', () => {
    const publish = async (year: number, holidays: string[]): Promise<void> => {
      await as(async (tx) => {
        const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: holidays.map((date) => ({ date, name: 'Holiday' })), legal_basis_ref: 'Labour Code' }, memberId(ACTOR));
        const locked = await calendars.lockDraft(tx, draft.id, draft.version);
        await calendars.publish(tx, locked, memberId(ACTOR));
      });
    };
    const workingRule = (validFrom: string): BaselineEntry => ({
      masterType: 'LND_TIMER',
      businessKey: 'NOTICE_AGRICULTURAL_90',
      label: 'Notice counted in working days',
      attributes: { owner_module: 'LND', awaiting_confirmation: false, days: 90, day_count: 'WORKING', calendar_code: 'WORKDAY_VN' },
      validFrom,
      legalBasis: 'Test rule in working days',
    });

    it('counts the days of a rule that says working days on the published calendar, from the day the rule takes effect', async () => {
      await publish(2026, ['2026-09-02']);
      const result = await as((tx) => applyBaseline(tx, sealPack('LND-WORKING', [workingRule('2026-08-01')]), memberId(ACTOR), TODAY));
      expect(result).toEqual({ created: 0, superseded: 1, unchanged: 0 });
      const created = await makeParcel({ landUseGroup: 'AGRICULTURAL' });
      // 90 working days after Monday 2026-08-10 are 18 weeks, and the holiday of 2026-09-02 adds one day.
      const recorded = await notice(created.id, 1, '2026-08-10');
      expect(recorded).toMatchObject({ daysApplied: 90, dueOn: '2026-12-15', ruleRevision: 2 });
      expect((await deadlineRows(created.id))[0]).toMatchObject({ days_applied: 90, started_on: '2026-08-10', due_on: '2026-12-15' });
    });

    it('leaves the notices of the days before the rule on the days of the older rule', async () => {
      const created = await makeParcel({ landUseGroup: 'AGRICULTURAL' });
      expect(await notice(created.id, 1, '2026-07-01')).toMatchObject({ dueOn: '2026-09-29', ruleRevision: 1 });
    });

    it('refuses to guess when the calendar of a year the count passes through is missing (2027 has none)', async () => {
      const created = await makeParcel({ landUseGroup: 'AGRICULTURAL' });
      expect(await refusal(notice(created.id, 1, '2026-10-20'))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'year' });
      expect(await deadlineRows(created.id)).toEqual([]);
    });
  });

  describe('recordSectionHandover (LND-10, ST-LND-009, BR-LND-06)', () => {
    const DOCUMENT_OK = (): string => world.cleanDocument;
    const make = async (extra: Record<string, unknown> = {}) => (await as((tx) => sections.create(tx, section({ contractId: world.contract, ...extra }), memberId(ACTOR)))).id;
    const hand = (sectionId: string, area: string, version = 1, extra: Partial<Parameters<LndSectionStore['recordHandover']>[3]> = {}, today = TODAY) =>
      as((tx) => sections.recordHandover(tx, sectionId, version, { handedAreaM2: area, handedOverOn: '2026-10-20', handoverDocumentVersionId: DOCUMENT_OK(), ...extra }, memberId(ACTOR), today));
    const sectionRow = async (sectionId: string) =>
      (
        await owner<{ status: string; handed_area_m2: string; handed_over_on: string | null; handover_document_version_id: string | null; version: string; contract_id: string | null }>(
          'select status, handed_area_m2::text, handed_over_on::text, handover_document_version_id, version::text, contract_id from machvon.land_handover_section where id = $1::uuid',
          [sectionId],
        )
      )[0];
    const contractOf = async (status: string, category = 'CONSTRUCTION'): Promise<string> => {
      counter += 1;
      const contractId = id(FAMILY, 100 + counter);
      await seedAs(harness, [
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, advance_category)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 1000, date '2026-01-01', $8::date, $9)`,
          [TENANT_A, contractId, world.project, id(FAMILY, 51), id(FAMILY, 50), `HD-S-${counter}`, status, status === 'SIGNED' ? null : '2026-01-01', category],
        ],
      ]);
      return contractId;
    };

    it('AC-ST-LND-009-1, UAT-AC386: hands the land over in steps: PARTIAL with the area and the day, then HANDED_OVER with the whole of it, and keeps the document', async () => {
      const created = await make();
      const first = await hand(created, '18000');
      expect(first).toMatchObject({ fromStatus: 'NOT_READY', status: 'PARTIAL', version: 2, previousHandedAreaM2: '0.00', handedAreaM2: '18000.00', handedOverOn: '2026-10-20', parcelsHandedOver: 0, contractId: world.contract });
      expect(await sectionRow(created)).toEqual({ status: 'PARTIAL', handed_area_m2: '18000.00', handed_over_on: '2026-10-20', handover_document_version_id: world.cleanDocument, version: '2', contract_id: world.contract });

      const last = await hand(created, '30000', 2, { handedOverOn: '2026-10-22' });
      expect(last).toMatchObject({ fromStatus: 'PARTIAL', status: 'HANDED_OVER', version: 3, previousHandedAreaM2: '18000.00', handedAreaM2: '30000.00', handedOverOn: '2026-10-22' });
      expect(await sectionRow(created)).toMatchObject({ status: 'HANDED_OVER', handed_area_m2: '30000.00', handed_over_on: '2026-10-22', version: '3' });
    });

    it('AC-ST-LND-009-1, UAT-AC386: refuses the handover above the area the section needs, and one to a contract that is not active', async () => {
      const created = await make();
      expect(await refusal(hand(created, '30000.01'))).toEqual({ code: 'HANDED_AREA_EXCEEDS_REQUIRED', status: 422, detail: 'handed_area_m2' });
      expect((await sqlState(owner('update machvon.land_handover_section set handed_area_m2 = 30000.01, status = $2 where id = $1::uuid', [created, 'PARTIAL']))).message).toContain('land_section_area_chk');
      expect((await sectionRow(created))?.status).toBe('NOT_READY');

      for (const status of ['SIGNED', 'DRAFT', 'COMPLETED']) {
        const contract = await contractOf(status);
        const target = await make({ contractId: contract });
        const refused = await as((tx) => sections.recordHandover(tx, target, 1, { handedAreaM2: '10000', handedOverOn: '2026-10-20', handoverDocumentVersionId: world.cleanDocument }, memberId(ACTOR), TODAY)).catch((error: unknown) => error as { code: string; status: number; extensions: Record<string, unknown> });
        expect(refused).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: status } });
        expect((await sectionRow(target))?.status).toBe('NOT_READY');
      }
    });

    it('is for a contract that builds: a section with no contract, and a consulting contract, are refused', async () => {
      const bare = await as((tx) => sections.create(tx, section(), memberId(ACTOR)));
      const refused = await as((tx) => sections.recordHandover(tx, bare.id, 1, { handedAreaM2: '10', handedOverOn: '2026-10-20', handoverDocumentVersionId: world.cleanDocument }, memberId(ACTOR), TODAY)).catch((error: unknown) => error as { code: string; status: number; detail: string; extensions: Record<string, unknown> });
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id', extensions: { reason: 'NO_CONTRACT' } });
      const consulting = await contractOf('ACTIVE', 'CONSULTING');
      const target = await make({ contractId: consulting });
      const second = await as((tx) => sections.recordHandover(tx, target, 1, { handedAreaM2: '10', handedOverOn: '2026-10-20', handoverDocumentVersionId: world.cleanDocument }, memberId(ACTOR), TODAY)).catch((error: unknown) => error as { code: string; extensions: Record<string, unknown> });
      expect(second).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NOT_A_CONSTRUCTION_CONTRACT' } });
      const epc = await contractOf('ACTIVE', 'EPC');
      expect((await hand(await make({ contractId: epc }), '10')).status).toBe('PARTIAL');
    });

    it('lets the area only grow, the day only move forward, and takes a clean document under the version the caller saw', async () => {
      const created = await make();
      await hand(created, '10000');
      expect(await refusal(hand(created, '10000', 2))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_area_m2' });
      expect(await refusal(hand(created, '9000', 2))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_area_m2' });
      expect(await refusal(hand(created, '12000', 2, { handedOverOn: '2026-10-19' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_over_on' });
      expect(await refusal(hand(created, '12000', 2, { handedOverOn: '2026-10-25' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_over_on' });
      expect(await refusal(hand(created, '12000', 2, { handoverDocumentVersionId: world.pendingDocument }))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'handover_document_version_id' });
      expect(await refusal(hand(created, '12000', 2, { handoverDocumentVersionId: id(FAMILY, 99) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handover_document_version_id' });
      expect(await refusal(hand(created, '12000', 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await sectionRow(created))?.handed_area_m2).toBe('10000.00');
      expect((await hand(created, '12000', 2, { handedOverOn: '2026-10-20' })).handedAreaM2).toBe('12000.00');
    });

    it('judges the shape: areas of at most two decimals and twelve integer digits, and days that exist', async () => {
      const created = await make();
      for (const area of ['', 'abc', '-1', '10.123', '1e3', '1234567890123', '0.00']) {
        expect(await refusal(hand(created, area))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_area_m2' });
      }
      expect(await refusal(hand(created, '10', 1, { handedOverOn: '2026-02-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'handed_over_on' });
      expect(await refusal(hand(randomUUID(), '10'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('hands the parcels over with the last of the area, and only when every parcel of the section is paid', async () => {
      const created = await make({ requiredAreaM2: '1000' });
      const paid = await makeParcel({ sectionId: created });
      const waiting = await makeParcel({ sectionId: created });
      const done = await makeParcel({ sectionId: created });
      await owner("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [paid.id]);
      await owner("update machvon.land_parcel set status = 'HANDED_OVER' where id = $1::uuid", [done.id]);
      // Part of the area may go before the compensation is all paid.
      expect((await hand(created, '400')).status).toBe('PARTIAL');
      const refused = await as((tx) => sections.recordHandover(tx, created, 2, { handedAreaM2: '1000', handedOverOn: '2026-10-21', handoverDocumentVersionId: world.cleanDocument }, memberId(ACTOR), TODAY)).catch((error: unknown) => error as { code: string; status: number; extensions: Record<string, unknown> });
      expect(refused).toMatchObject({ code: 'PARCELS_NOT_READY', status: 422, extensions: { parcels_not_ready: 1 } });
      expect((await sectionRow(created))?.status).toBe('PARTIAL');
      expect((await parcelRow(paid.id))?.status).toBe('PAID');

      await owner("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [waiting.id]);
      const last = await hand(created, '1000', 2, { handedOverOn: '2026-10-21' });
      expect(last).toMatchObject({ status: 'HANDED_OVER', parcelsHandedOver: 2 });
      expect([(await parcelRow(paid.id))?.status, (await parcelRow(waiting.id))?.status, (await parcelRow(done.id))?.status]).toEqual(['HANDED_OVER', 'HANDED_OVER', 'HANDED_OVER']);
      expect((await parcelRow(paid.id))?.version).toBe('2');
      expect((await parcelRow(done.id))?.version).toBe('1');
    });

    it('keeps a section as it was handed over: the database refuses a smaller area, a contract that changes, a status that does not match, and a handover with no day or document', async () => {
      const created = await make();
      await hand(created, '10000');
      const update = (set: string, params: unknown[] = []) => sqlState(owner(`update machvon.land_handover_section set ${set} where id = $1::uuid`, [created, ...params]));
      expect((await update('handed_area_m2 = 9000')).message).toContain('never decreases');
      expect((await update("handed_over_on = date '2026-10-01'")).message).toContain('never moves back');
      expect((await update('contract_id = $2::uuid', [world.foreignContract])).message).toContain('does not change');
      expect((await update("status = 'HANDED_OVER'")).message).toContain('land_section_status_chk');
      expect((await update('handed_over_on = null')).message).toContain('land_section_handover_chk');
      expect((await update('handover_document_version_id = null')).message).toContain('land_section_handover_chk');
      const bare = await as((tx) => sections.create(tx, section(), memberId(ACTOR)));
      expect((await sqlState(owner("update machvon.land_handover_section set handed_area_m2 = 10, status = 'PARTIAL', handed_over_on = date '2026-10-20', handover_document_version_id = $2::uuid where id = $1::uuid", [bare.id, world.cleanDocument]))).message).toContain('land_section_contract_chk');
      expect(await sectionRow(created)).toMatchObject({ status: 'PARTIAL', handed_area_m2: '10000.00' });
    });

    it('computes the share of the project that was handed over from the sections it has', async () => {
      const project = world.otherProject;
      const seedSection = (code: string, required: string, handed: string, contract: string) =>
        seedAs(harness, [
          [
            `insert into machvon.land_handover_section (tenant_id, id, project_id, contract_id, code, name, required_area_m2, handed_area_m2, handed_over_on, handover_document_version_id, status, created_by, updated_by)
             values ($1, gen_random_uuid(), $2, $3, $4, 'Section', $5::numeric, $6::numeric, case when $6::numeric = 0 then null else date '2026-10-20' end, case when $6::numeric = 0 then null else $7::uuid end,
                     case when $6::numeric = 0 then 'NOT_READY' when $6::numeric = $5::numeric then 'HANDED_OVER' else 'PARTIAL' end, $8, $8)`,
            [TENANT_A, project, contract, code, required, handed, world.cleanDocument, memberId(ACTOR)],
          ],
        ]);
      await seedSection('RATIO-1', '30000', '30000', world.foreignContract);
      await seedSection('RATIO-2', '28000', '0', world.foreignContract);
      const totals = await owner<{ required: string; handed: string }>("select sum(required_area_m2)::text as required, sum(handed_area_m2)::text as handed from machvon.land_handover_section where project_id = $1::uuid and code like 'RATIO-%'", [project]);
      expect(handedRatio(totals[0]?.handed ?? '0', totals[0]?.required ?? '0')).toBe('51.72');
    });
  });
});

describe('scopes without a database', () => {
  const tenant = tenantWide('land.read');
  const now = new Date('2026-10-24T03:00:00Z');
  const nothing: ScopeBuilder = parcelScope(tenantWide('x.y'), 'land.read', now);

  it('compiles a tenant-wide grant to true and a grant of another permission to false', () => {
    expect(parcelScope(tenant, 'land.read', now)(1)).toEqual({ sql: 'true', params: [] });
    expect(nothing(1)).toEqual({ sql: 'false', params: [] });
  });

  it('numbers the parameters of a project grant after the first one it is given', () => {
    const access = grant('land.read', { kind: 'PROJECT', refIds: ['b', 'a'] });
    expect(parcelScope(access, 'land.read', now)(7)).toEqual({ sql: 'pc.project_id = any($7::uuid[])', params: [['a', 'b']] });
  });
});
