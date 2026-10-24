import { createHash, randomUUID } from 'node:crypto';
import { FileImportStore } from '../src/file-import-store';
import { LndParcelImportStore, connectorOf } from '../src/lnd-parcel-import';
import type { ParcelImportResult } from '../src/lnd-parcel-import';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { LndSectionStore } from '../src/lnd-section-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const imports = new LndParcelImportStore();
const core = new FileImportStore();
const sections = new LndSectionStore();
const parcels = new LndParcelStore();
const ACTOR = 1;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xb1;
const HEADER = 'parcel_code,owner_unit_code,land_use_group,area_total_m2,area_affected_m2,address_text,section_code';

let world: LndWorld;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const bytesOf = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const runImport = (bytes: Uint8Array, options: { projectId?: string; expectedSha256?: string; tenant?: string } = {}): Promise<ParcelImportResult> =>
  as(
    (tx) =>
      imports.import(tx, {
        projectId: options.projectId ?? world.project,
        bytes,
        fileObjectKey: `tenants/${options.tenant ?? TENANT_A}/import/${shaOf(bytes).slice(0, 32)}`,
        expectedSha256: options.expectedSha256 ?? shaOf(bytes),
        importedBy: memberId(ACTOR),
        correlationId: randomUUID(),
        now: new Date('2026-10-24T03:00:00Z'),
      }),
    options.tenant ?? TENANT_A,
  );

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const parcelCount = async (projectId = world.project): Promise<number> => Number((await owner<{ n: string }>('select count(*)::text as n from machvon.land_parcel where project_id = $1::uuid', [projectId]))[0]?.n);
const parcelRows = (projectId = world.project) =>
  owner<{ parcel_code: string; owner_unit_id: string; section_id: string | null; land_use_group: string; area_total_m2: string; area_affected_m2: string; address_text: string | null; status: string; version: string }>(
    `select parcel_code, owner_unit_id, section_id, land_use_group, area_total_m2::text as area_total_m2, area_affected_m2::text as area_affected_m2, address_text, status, version::text as version
       from machvon.land_parcel where project_id = $1::uuid order by parcel_code`,
    [projectId],
  );

describe('the import of a parcel list (ST-LND-001, AC-ST-LND-001-2, UAT-PLAN-28)', () => {
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

  it('creates the parcels of a file in SURVEYED with the unit and the section the file names, and keeps no word about a person', async () => {
    const section = await as((tx) => sections.create(tx, { projectId: world.project, code: 'KM-0-3', name: 'Km 0 to km 3', requiredAreaM2: '30000' }, memberId(ACTOR)));
    const bytes = bytesOf(HEADER, 'tb-1/10,U2,AGRICULTURAL,1200.5,800,Hamlet 3,KM-0-3', 'TB-1/11,U3,NON_AGRICULTURAL_RESIDENTIAL,300,300,,', 'TB-1/12,U2,public,50,0,,KM-0-3');
    const done = await runImport(bytes);
    expect(done).toMatchObject({ outcome: 'APPLIED', counts: { total: 3, created: 3, duplicate: 0, conflict: 0, refused: 0 } });
    expect(await parcelRows()).toEqual([
      { parcel_code: 'TB-1/10', owner_unit_id: unitId(DEPARTMENT), section_id: section.id, land_use_group: 'AGRICULTURAL', area_total_m2: '1200.50', area_affected_m2: '800.00', address_text: 'Hamlet 3', status: 'SURVEYED', version: '1' },
      { parcel_code: 'TB-1/11', owner_unit_id: unitId(OTHER_BRANCH), section_id: null, land_use_group: 'NON_AGRICULTURAL_RESIDENTIAL', area_total_m2: '300.00', area_affected_m2: '300.00', address_text: null, status: 'SURVEYED', version: '1' },
      { parcel_code: 'TB-1/12', owner_unit_id: unitId(DEPARTMENT), section_id: section.id, land_use_group: 'PUBLIC', area_total_m2: '50.00', area_affected_m2: '0.00', address_text: null, status: 'SURVEYED', version: '1' },
    ]);
    const [record] = await owner<{ connector_code: string; format_version: string; status: string; rows_applied: number; file_sha256: string }>(
      'select connector_code, format_version, status, rows_applied, file_sha256 from machvon.file_import where connector_code = $1',
      [connectorOf(world.project)],
    );
    expect(record).toEqual({ connector_code: connectorOf(world.project), format_version: 'ASSUMED-2026.1', status: 'APPLIED', rows_applied: 3, file_sha256: shaOf(bytes) });
  });

  it('does not create a parcel twice when the same file is imported a second time (AC-ST-LND-001-2)', async () => {
    const bytes = bytesOf(HEADER, 'RE-1,U2,AGRICULTURAL,100,50,,', 'RE-2,U2,AGRICULTURAL,200,50,,');
    const first = await runImport(bytes);
    const before = await parcelCount();
    const second = await runImport(bytes);
    expect(first).toMatchObject({ outcome: 'APPLIED', counts: { created: 2 } });
    expect(second).toMatchObject({ outcome: 'ALREADY_IMPORTED', importId: first.importId, counts: { created: 2 } });
    expect(await parcelCount()).toBe(before);
    expect((await parcelRows()).filter((row) => row.parcel_code.startsWith('RE-'))).toHaveLength(2);
  });

  it('gives exactly one application to two imports of the same file at once', async () => {
    const bytes = bytesOf(HEADER, 'RACE-1,U2,AGRICULTURAL,100,50,,', 'RACE-2,U2,AGRICULTURAL,100,50,,');
    const settled = await Promise.all([runImport(bytes), runImport(bytes)]);
    expect(settled.map((result) => result.outcome).sort()).toEqual(['ALREADY_IMPORTED', 'APPLIED']);
    expect((await parcelRows()).filter((row) => row.parcel_code.startsWith('RACE-'))).toHaveLength(2);
  });

  it('does not create the parcel again when another file names it: the same content is a repeat, other content leaves the first as it is and opens an item', async () => {
    await runImport(bytesOf(HEADER, 'FILE-A,U2,AGRICULTURAL,100,50,,'));
    const other = await runImport(bytesOf(HEADER, 'file-a,U2,AGRICULTURAL,100.00,50.0,,', 'FILE-B,U2,AGRICULTURAL,10,5,,'));
    expect(other).toMatchObject({ outcome: 'APPLIED', counts: { total: 2, created: 1, duplicate: 1 } });
    const changed = await runImport(bytesOf(HEADER, 'FILE-A,U2,AGRICULTURAL,999,50,,'));
    expect(changed).toMatchObject({ outcome: 'PARTIALLY_APPLIED', counts: { created: 0, conflict: 1 } });
    expect((await parcelRows()).filter((row) => row.parcel_code === 'FILE-A')).toEqual([expect.objectContaining({ area_total_m2: '100.00' })]);
    const items = await owner<{ code: string }>("select code from machvon.file_import_reconciliation_item where connector_code = $1 and business_key = 'FILE-A'", [connectorOf(world.project)]);
    expect(items).toEqual([{ code: 'DUPLICATE_CONFLICT' }]);
  });

  it('takes a file into every project it is sent to: the same bytes are new to another project', async () => {
    const bytes = bytesOf(HEADER, 'SHARED-1,U2,AGRICULTURAL,100,50,,');
    await expect(runImport(bytes)).resolves.toMatchObject({ outcome: 'APPLIED' });
    await expect(runImport(bytes, { projectId: world.otherProject })).resolves.toMatchObject({ outcome: 'APPLIED', counts: { created: 1 } });
    expect((await parcelRows(world.otherProject)).map((row) => row.parcel_code)).toEqual(['SHARED-1']);
  });

  it('quarantines the rows that cannot be taken, with the line and the reason, and takes the others', async () => {
    const bytes = bytesOf(
      HEADER,
      'Q-1,U2,AGRICULTURAL,100,50,,',
      'bad code,U2,AGRICULTURAL,100,50,,',
      'Q-3,NOUNIT,AGRICULTURAL,100,50,,',
      'Q-4,U2,AGRICULTURAL,100,50,,NOSECTION',
      'Q-5,U2,FOREST,100,50,,',
      'Q-6,U2,AGRICULTURAL,100,500,,',
    );
    const done = await runImport(bytes);
    expect(done).toMatchObject({ outcome: 'PARTIALLY_APPLIED', counts: { total: 6, created: 1, refused: 5 } });
    const [record] = await owner<{ id: string }>('select id from machvon.file_import where id = $1::uuid', [done.importId]);
    const rows = await as((tx) => core.quarantined(tx, record?.id ?? '', 50));
    expect(rows.map((row) => [row.line, row.errorCode, row.field])).toEqual([
      [3, 'PARCEL_CODE_INVALID', 'parcel_code'],
      [4, 'UNIT_NOT_FOUND', 'owner_unit_code'],
      [5, 'SECTION_NOT_FOUND', 'section_code'],
      [6, 'LAND_USE_GROUP_INVALID', 'land_use_group'],
      [7, 'AREA_INVALID', 'area_affected_m2'],
    ]);
    expect((await parcelRows()).map((row) => row.parcel_code)).toContain('Q-1');
    expect((await parcelRows()).map((row) => row.parcel_code)).not.toContain('Q-3');
    // A corrected file takes the rows the first one refused: a refused row claims nothing.
    await expect(runImport(bytesOf(HEADER, 'Q-3,U2,AGRICULTURAL,100,50,,'))).resolves.toMatchObject({ outcome: 'APPLIED', counts: { created: 1 } });
  });

  it('refuses a parcel code that the project already has from a parcel made by hand, and leaves that parcel as it is', async () => {
    await as((tx) => parcels.create(tx, { projectId: world.project, ownerUnitId: unitId(DEPARTMENT), parcelCode: 'HAND-1', landUseGroup: 'AGRICULTURAL', areaTotalM2: '10', areaAffectedM2: '5' }, memberId(ACTOR), '2026-10-24'));
    const done = await runImport(bytesOf(HEADER, 'AUTH-1,U2,AGRICULTURAL,100,50,,', 'HAND-1,U3,PUBLIC,99,9,,'));
    expect(done).toMatchObject({ outcome: 'PARTIALLY_APPLIED', counts: { total: 2, created: 1, refused: 1 } });
    const rows = await as((tx) => core.quarantined(tx, done.importId, 50));
    expect(rows.map((row) => [row.businessKey, row.errorCode])).toEqual([['HAND-1', 'PARCEL_CODE_DUPLICATE']]);
    expect((await parcelRows()).filter((row) => row.parcel_code === 'HAND-1')).toEqual([expect.objectContaining({ owner_unit_id: unitId(DEPARTMENT), land_use_group: 'AGRICULTURAL', area_total_m2: '10.00' })]);
  });

  it('keeps the address out of the quarantine: a refused row shows its parcel, unit, land use and areas only', async () => {
    const done = await runImport(bytesOf(HEADER, 'ADDR-1,U2,FOREST,100,50,Home of Nguyen Van A,'));
    const rows = await as((tx) => core.quarantined(tx, done.importId, 50));
    expect(rows[0]?.maskedPreview).toEqual({ parcel_code: 'ADDR-1', owner_unit_code: 'U2', land_use_group: 'FOREST', area_total_m2: '100', area_affected_m2: '50' });
  });

  it('refuses a file with an owner column as a whole, creates no parcel and leaves no trace of an import', async () => {
    const before = await parcelCount();
    const withOwner = bytesOf(`${HEADER},owner_name`, 'OWN-1,U2,AGRICULTURAL,100,50,,,Nguyen Van A');
    expect(await refusal(runImport(withOwner))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'file' });
    expect(await parcelCount()).toBe(before);
    expect(await owner('select 1 from machvon.file_import where file_sha256 = $1', [shaOf(withOwner)])).toEqual([]);
    // The same file without the column goes through: the refusal was about the column and not about the bytes.
    await expect(runImport(bytesOf(HEADER, 'OWN-1,U2,AGRICULTURAL,100,50,,'))).resolves.toMatchObject({ outcome: 'APPLIED' });
  });

  it('refuses a file whose hash is not the hash that was recorded, an empty file and something that is not a table', async () => {
    const bytes = bytesOf(HEADER, 'HASH-1,U2,AGRICULTURAL,100,50,,');
    expect(await refusal(runImport(bytes, { expectedSha256: 'a'.repeat(64) }))).toEqual({ code: 'HASH_MISMATCH', status: 422, detail: 'file' });
    expect(await refusal(runImport(bytesOf(HEADER)))).toMatchObject({ code: 'IMPORT_EMPTY', status: 422 });
    expect(await refusal(runImport(new Uint8Array([1, 2, 3, 4])))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
    expect((await parcelRows()).map((row) => row.parcel_code)).not.toContain('HASH-1');
  });

  it('counts the area it took in the certified totals of the connector', async () => {
    await runImport(bytesOf(HEADER, 'TOT-1,U2,AGRICULTURAL,100,50.5,,', 'TOT-2,U2,AGRICULTURAL,100,20,,'), { projectId: world.otherProject });
    const totals = await as((tx) => core.totals(tx, connectorOf(world.otherProject)));
    // The other project has SHARED-1 (50) from an earlier test.
    expect(totals).toMatchObject({ rows: 3, measure: '120.5' });
  });

  it('does not see the parcels of another tenant', async () => {
    const [row] = await owner<{ n: string }>('select count(*)::text as n from machvon.land_parcel', [], TENANT_B);
    expect(row?.n).toBe('0');
  });
});
