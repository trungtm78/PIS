import { planFileImport } from '@machvon/kernel';
import { PARCEL_COLUMNS, PARCEL_FIELDS, checkParcelLayout, connectorOf, createParcelFileFormat } from '../src/lnd-parcel-import';

const HEADER = 'parcel_code,owner_unit_code,land_use_group,area_total_m2,area_affected_m2,address_text,section_code';
const bytesOf = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const format = createParcelFileFormat('LAND_PARCEL_FILE_TEST');

const problem = (work: () => unknown): { code: string; status: number; detail?: string } | undefined => {
  try {
    work();
  } catch (error) {
    const e = error as { code: string; status: number; detail?: string };
    return { code: e.code, status: e.status, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  return undefined;
};

const judged = (...rows: string[]) => planFileImport(format, bytesOf(HEADER, ...rows)).rows;

describe('the layout of the parcel file (ST-LND-001, LND 3.1 step 1)', () => {
  it('names the connector of a project by its id, so a file is new to every project it is imported into', () => {
    expect(connectorOf('0a1b2c3d-0000-4000-8000-00000000abcd')).toBe('LAND_PARCEL_FILE_0A1B2C3D000040008000' + '00000000ABCD');
    expect(connectorOf('0a1b2c3d-0000-4000-8000-00000000abcd')).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(connectorOf('0a1b2c3d-0000-4000-8000-00000000abcd').length).toBeLessThanOrEqual(80);
  });

  it('reads a row into the words of the database, with the line it starts on', () => {
    const [row] = format.parse(bytesOf(HEADER, 'tb-12/345,U2,AGRICULTURAL,1200.5,800,Hamlet 3,SEC-1'));
    expect(row).toEqual({
      line: 2,
      values: { parcel_code: 'tb-12/345', owner_unit_code: 'U2', land_use_group: 'AGRICULTURAL', area_total_m2: '1200.5', area_affected_m2: '800', address_text: 'Hamlet 3', section_code: 'SEC-1' },
    });
  });

  it('reads the headers of a Vietnamese register, with accents and capitals', () => {
    const [row] = format.parse(bytesOf('Số thửa,Mã đơn vị,Nhóm đất,Diện tích,Diện tích thu hồi', '12,U2,AGRICULTURAL,100,50'));
    expect(row?.values).toEqual({ parcel_code: '12', owner_unit_code: 'U2', land_use_group: 'AGRICULTURAL', area_total_m2: '100', area_affected_m2: '50' });
  });

  it('knows every alias of every field', () => {
    for (const field of PARCEL_FIELDS) expect(PARCEL_COLUMNS[field].length).toBeGreaterThan(0);
  });

  it('refuses the whole file when it has a column that a parcel must not carry, whatever the column is called', () => {
    for (const header of ['owner_name', 'chu_su_dung', 'Chủ sử dụng', 'household_head', 'national_id', 'cccd', 'phone', 'dien_thoai', 'email', 'tax_id', 'notes', 'user']) {
      const outcome = problem(() => format.parse(bytesOf(`${HEADER},${header}`, 'A1,U2,AGRICULTURAL,100,50,,,someone')));
      expect(outcome).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'columns' });
    }
  });

  it('refuses a file with a required column missing, with two columns for one field, or with something that is not a table', () => {
    expect(problem(() => format.parse(bytesOf('parcel_code,owner_unit_code,land_use_group,area_total_m2', 'A1,U2,AGRICULTURAL,100')))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'columns' });
    expect(problem(() => format.parse(bytesOf(`${HEADER},so_thua`, 'A1,U2,AGRICULTURAL,100,50,,,7')))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'columns' });
    expect(problem(() => format.parse(new Uint8Array([0, 1, 2, 3])))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
  });

  it('ignores a column that has no header while it is empty and refuses it as soon as it holds something', () => {
    expect(format.parse(bytesOf(`${HEADER},`, 'A1,U2,AGRICULTURAL,100,50,,,'))).toHaveLength(1);
    expect(problem(() => format.parse(bytesOf(`${HEADER},`, 'A1,U2,AGRICULTURAL,100,50,,,Nguyen Van A')))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'columns' });
  });

  it('tells a person before the import what is wrong with the headers of a file', () => {
    expect(checkParcelLayout(HEADER.split(','))).toEqual({ ok: true, missing: [], unknown: [] });
    expect(checkParcelLayout(['parcel_code', 'owner_unit_code', 'owner_name'])).toEqual({
      ok: false,
      missing: ['land_use_group', 'area_total_m2', 'area_affected_m2'],
      unknown: ['owner_name'],
    });
    expect(checkParcelLayout(['Số thửa', 'Mã đơn vị', 'Nhóm đất', 'Diện tích', 'Diện tích thu hồi', ''])).toMatchObject({ ok: true });
  });
});

describe('the judgement of a parcel row', () => {
  it('accepts a good row with a normalised code, a land use in capitals and areas with two fraction digits, and keys it by the code', () => {
    const [row] = judged('tb-12/345,U2,agricultural,1200.5,800,  Hamlet 3 ,SEC-1');
    expect(row).toMatchObject({
      accepted: true,
      row: {
        businessKey: 'TB-12/345',
        fields: { parcel_code: 'TB-12/345', owner_unit_code: 'U2', land_use_group: 'AGRICULTURAL', area_total_m2: '1200.50', area_affected_m2: '800.00', address_text: 'Hamlet 3', section_code: 'SEC-1' },
        record: { parcelCode: 'TB-12/345', ownerUnitCode: 'U2', landUseGroup: 'AGRICULTURAL', areaTotalM2: '1200.50', areaAffectedM2: '800.00', addressText: 'Hamlet 3', sectionCode: 'SEC-1' },
        measure: '800.00',
      },
    });
  });

  it('gives the same row the same hash whatever the spelling of the same facts, and another hash when a fact differs', () => {
    const hashOf = (line: string) => (judged(line)[0] as { rowHash: string }).rowHash;
    expect(hashOf('A1,U2,AGRICULTURAL,100,50,,')).toBe(hashOf('a1,U2, agricultural ,100.00,50.0,,'));
    expect(hashOf('A1,U2,AGRICULTURAL,100,50,,')).not.toBe(hashOf('A1,U2,AGRICULTURAL,100,51,,'));
  });

  it.each([
    ['PARCEL_CODE_INVALID', 'parcel_code', 'has space,U2,AGRICULTURAL,100,50,,'],
    ['PARCEL_CODE_INVALID', 'parcel_code', ',U2,AGRICULTURAL,100,50,,'],
    ['OWNER_UNIT_CODE_INVALID', 'owner_unit_code', 'A1,,AGRICULTURAL,100,50,,'],
    ['LAND_USE_GROUP_INVALID', 'land_use_group', 'A1,U2,FOREST,100,50,,'],
    ['AREA_INVALID', 'area_total_m2', 'A1,U2,AGRICULTURAL,abc,50,,'],
    ['AREA_INVALID', 'area_total_m2', 'A1,U2,AGRICULTURAL,100,50.123,,'],
    ['AREA_INVALID', 'area_affected_m2', 'A1,U2,AGRICULTURAL,100,101,,'],
    ['AREA_INVALID', 'area_affected_m2', 'A1,U2,AGRICULTURAL,0,0,,'],
    ['ADDRESS_INVALID', 'address_text', `A1,U2,AGRICULTURAL,100,50,${'x'.repeat(501)},`],
    ['SECTION_CODE_INVALID', 'section_code', `A1,U2,AGRICULTURAL,100,50,,${'x'.repeat(51)}`],
  ])('rejects a row with %s on %s', (code, field, line) => {
    expect(judged(line)[0]).toMatchObject({ accepted: false, rejection: { code, field } });
  });

  it('keeps the key of a row that is refused after its code was read, so the quarantine can name it', () => {
    expect(judged('A1,U2,FOREST,100,50,,')[0]).toMatchObject({ accepted: false, businessKey: 'A1' });
  });

  it('shows a person only the parcel, the unit, the land use and the areas of a refused row, never the address', () => {
    const rejected = judged('A1,U2,FOREST,100,50,Home of Nguyen Van A,SEC-1')[0] as { preview: Record<string, string> };
    expect(rejected.preview).toEqual({ parcel_code: 'A1', owner_unit_code: 'U2', land_use_group: 'FOREST', area_total_m2: '100', area_affected_m2: '50' });
  });

  it('refuses a file with no rows', () => {
    expect(problem(() => planFileImport(format, bytesOf(HEADER)))).toMatchObject({ code: 'IMPORT_EMPTY', status: 422 });
  });
});
