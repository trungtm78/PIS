import { randomUUID } from 'node:crypto';
import { DomainError, LAND_USE_GROUPS, accept, compareDecimal, readTabularFile, reject } from '@machvon/kernel';
import type { FileImportFormat, LandUseGroup, Rejection, RowJudgement, SourceRow } from '@machvon/kernel';
import { FileImportStore } from './file-import-store.ts';
import type { FileImportAdapter } from './file-import-store.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { AREA_INTEGER_DIGITS, MAX_ADDRESS, MAX_CODE, fixedTwo, textOf } from './lnd-values.ts';
import { parcelCodeOf } from './lnd-parcel-store.ts';
import { normalizeHeader } from './pay-treasury-statement-format.ts';
import type { TenantTx } from './tenant-database.ts';

/** The prefix of the connector of a parcel file; the project is part of the name, so a file is new to every project it is imported into. */
export const LAND_PARCEL_CONNECTOR_PREFIX = 'LAND_PARCEL_FILE_';
/**
 * The version of the layout below. The land registry gives no API and no sample (LND 7, adapter PROPOSED), so the layout is a WORKING ASSUMPTION:
 * it is kept with every import as the evidence of what was read, and a different layout is a new version, not an edit.
 */
export const LAND_PARCEL_FORMAT_VERSION = 'ASSUMED-2026.1';

/** The logical fields of one parcel row. A parcel file has exactly these and no others: a column that is not here is never read and never stored. */
export const PARCEL_FIELDS = ['parcel_code', 'owner_unit_code', 'land_use_group', 'area_total_m2', 'area_affected_m2', 'address_text', 'section_code'] as const;
export type ParcelField = (typeof PARCEL_FIELDS)[number];
export const REQUIRED_PARCEL_FIELDS: readonly ParcelField[] = ['parcel_code', 'owner_unit_code', 'land_use_group', 'area_total_m2', 'area_affected_m2'];

/** The headers each field may carry in the file (the words of the database and the words of a Vietnamese register). */
export const PARCEL_COLUMNS: Readonly<Record<ParcelField, readonly string[]>> = {
  parcel_code: ['parcel_code', 'so_thua', 'so_to_so_thua'],
  owner_unit_code: ['owner_unit_code', 'ma_don_vi'],
  land_use_group: ['land_use_group', 'nhom_dat'],
  area_total_m2: ['area_total_m2', 'dien_tich'],
  area_affected_m2: ['area_affected_m2', 'dien_tich_thu_hoi'],
  address_text: ['address_text', 'dia_chi'],
  section_code: ['section_code', 'ma_doan'],
};

/** One accepted parcel row, typed. The areas are exact decimals with two fraction digits. */
export interface LandParcelFileRow {
  parcelCode: string;
  ownerUnitCode: string;
  landUseGroup: LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  addressText: string | null;
  sectionCode: string | null;
}

const invalidSchema = (): DomainError => new DomainError('IMPORT_SCHEMA_INVALID', 422, 'columns');

/**
 * For each field the index of its column. A parcel file carries no owner and no user of the land (LND section 1), so the layout is closed: every
 * column must be one of the fields above, and a column that is not (a name, an identity number, a phone, an owner, whatever it is called) makes the
 * whole file unreadable. A column with no header is allowed only while it is empty. Two columns that mean one field make the file ambiguous.
 */
function columnIndexes(headers: readonly string[], rows: readonly (readonly string[])[]): Map<ParcelField, number> {
  const found = new Map<ParcelField, number>();
  headers.forEach((header, index) => {
    const name = normalizeHeader(header);
    const field = name === '' ? undefined : PARCEL_FIELDS.find((candidate) => PARCEL_COLUMNS[candidate].some((alias) => normalizeHeader(alias) === name));
    if (field === undefined) {
      if (name === '' && rows.every((cells) => (cells[index] ?? '').trim() === '')) return;
      throw invalidSchema();
    }
    if (found.has(field)) throw invalidSchema();
    found.set(field, index);
  });
  if (REQUIRED_PARCEL_FIELDS.some((field) => !found.has(field))) throw invalidSchema();
  return found;
}

export interface ParcelLayoutCheck {
  ok: boolean;
  /** The required fields that no header names. */
  missing: ParcelField[];
  /** The headers that are not a field of the layout: the file carries something a parcel must not carry. */
  unknown: string[];
}

/** Whether the headers of a file are those of the layout, so that a person is told before the import what is wrong with the file. */
export function checkParcelLayout(headers: readonly string[]): ParcelLayoutCheck {
  const names = headers.map(normalizeHeader);
  const known = (name: string): ParcelField | undefined => PARCEL_FIELDS.find((field) => PARCEL_COLUMNS[field].some((alias) => normalizeHeader(alias) === name));
  const present = new Set(names.flatMap((name) => known(name) ?? []));
  const missing = REQUIRED_PARCEL_FIELDS.filter((field) => !present.has(field));
  const unknown = headers.filter((header, index) => normalizeHeader(header) !== '' && known(names[index] ?? '') === undefined);
  return { ok: missing.length === 0 && unknown.length === 0, missing, unknown };
}

const hasControlCharacter = (text: string): boolean => Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f);

/** A short code of a unit or a section as the file writes it: trimmed, not empty, no control character. */
function codePart(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  return text === '' || text.length > MAX_CODE || hasControlCharacter(text) ? undefined : text;
}

/** What a person may read of a refused row: the parcel, the unit and the land use and the areas, and never the address (it is free text). */
function maskedValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const preview: Record<string, string> = {};
  for (const field of ['parcel_code', 'owner_unit_code', 'land_use_group', 'area_total_m2', 'area_affected_m2'] as const) preview[field] = values[field] ?? '';
  return preview;
}

/**
 * The pure half of the parcel file adapter: it reads the bytes of a CSV or Excel file into rows with the words of the database and judges one row
 * at a time. It knows no database and no clock. The business key of a row is the parcel code (the file is imported into one project), so the same
 * parcel is never created twice, however many files name it.
 */
export function createParcelFileFormat(connectorCode: string): FileImportFormat<LandParcelFileRow> {
  return {
    connectorCode,
    formatVersion: LAND_PARCEL_FORMAT_VERSION,
    parse(bytes): SourceRow[] {
      let table;
      try {
        table = readTabularFile(bytes);
      } catch (error) {
        if (error instanceof DomainError) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
        throw error;
      }
      const indexes = columnIndexes(table.headers, table.rows);
      return table.rows.map((cells, row) => {
        const values: Record<string, string> = {};
        for (const [field, index] of indexes) values[field] = cells[index] ?? '';
        return { line: table.lines[row] ?? row + 2, values };
      });
    },
    judge(row): RowJudgement<LandParcelFileRow> {
      const { values } = row;
      let parcelCode: string;
      try {
        parcelCode = parcelCodeOf(values.parcel_code ?? '', 'parcel_code');
      } catch {
        return reject('PARCEL_CODE_INVALID', 'parcel_code');
      }
      const ownerUnitCode = codePart(values.owner_unit_code);
      if (ownerUnitCode === undefined) return reject('OWNER_UNIT_CODE_INVALID', 'owner_unit_code', parcelCode);
      const group = (values.land_use_group ?? '').trim().toUpperCase();
      if (!(LAND_USE_GROUPS as readonly string[]).includes(group)) return reject('LAND_USE_GROUP_INVALID', 'land_use_group', parcelCode);
      let areaTotal: string;
      let areaAffected: string;
      try {
        areaTotal = fixedTwo(values.area_total_m2 ?? '', AREA_INTEGER_DIGITS, 'area_total_m2');
        areaAffected = fixedTwo(values.area_affected_m2 ?? '', AREA_INTEGER_DIGITS, 'area_affected_m2');
      } catch {
        return reject('AREA_INVALID', 'area_total_m2', parcelCode);
      }
      if (compareDecimal(areaTotal, '0') <= 0 || compareDecimal(areaAffected, areaTotal) > 0) return reject('AREA_INVALID', 'area_affected_m2', parcelCode);
      const addressRaw = (values.address_text ?? '').trim();
      let addressText: string | null = null;
      if (addressRaw !== '') {
        try {
          addressText = textOf(addressRaw, 'address_text', 1, MAX_ADDRESS);
        } catch {
          return reject('ADDRESS_INVALID', 'address_text', parcelCode);
        }
      }
      const sectionRaw = (values.section_code ?? '').trim();
      const sectionCode = sectionRaw === '' ? null : (codePart(sectionRaw) ?? null);
      if (sectionRaw !== '' && sectionCode === null) return reject('SECTION_CODE_INVALID', 'section_code', parcelCode);
      return accept({
        businessKey: parcelCode,
        fields: {
          parcel_code: parcelCode,
          owner_unit_code: ownerUnitCode,
          land_use_group: group,
          area_total_m2: areaTotal,
          area_affected_m2: areaAffected,
          address_text: addressText ?? '',
          section_code: sectionCode ?? '',
        },
        record: { parcelCode, ownerUnitCode, landUseGroup: group as LandUseGroup, areaTotalM2: areaTotal, areaAffectedM2: areaAffected, addressText, sectionCode },
        measure: areaAffected,
      });
    },
    mask: maskedValues,
  };
}

export interface ParcelAdapterOptions {
  projectId: string;
  actor: string;
  source?: LndLandSource;
}

/** The name of the connector of the parcel files of one project. */
export const connectorOf = (projectId: string): string => `${LAND_PARCEL_CONNECTOR_PREFIX}${projectId.replaceAll('-', '').toUpperCase()}`;

interface Resolved {
  unitId: string;
  sectionId: string | null;
}

/**
 * The adapter of the parcel file (ST-LND-001): the pure layout of `createParcelFileFormat`, the judgement of a row against what the tenant holds and
 * the write of the parcel. A row names the unit that answers for the parcel by its code and, when it has one, the section by its code; both must
 * exist, and a parcel code that the project already has (created by hand or by another file) is
 * the row error PARCEL_CODE_DUPLICATE in the quarantine. The adapter is built for one import, because it remembers what `examine` resolved for `apply`.
 */
export function createParcelFileAdapter(options: ParcelAdapterOptions): FileImportAdapter<LandParcelFileRow> {
  const source = options.source ?? new LndLandSource();
  const format = createParcelFileFormat(connectorOf(options.projectId));
  const units = new Map<string, { id: string; path: string } | null>();
  const sections = new Map<string, string | null>();
  const resolved = new Map<string, Resolved>();

  async function unitOf(tx: TenantTx, code: string): Promise<{ id: string; path: string } | null> {
    const known = units.get(code);
    if (known !== undefined) return known;
    const unit = (await source.unitByCode(tx, code)) ?? null;
    units.set(code, unit);
    return unit;
  }

  async function sectionOf(tx: TenantTx, code: string): Promise<string | null> {
    const known = sections.get(code);
    if (known !== undefined) return known;
    const section = (await source.sectionByCode(tx, options.projectId, code))?.id ?? null;
    sections.set(code, section);
    return section;
  }

  return {
    ...format,
    async examine(tx, entry): Promise<Rejection | undefined> {
      const { record } = entry;
      const unit = await unitOf(tx, record.ownerUnitCode);
      if (unit === null) return { code: 'UNIT_NOT_FOUND', field: 'owner_unit_code' };
      let sectionId: string | null = null;
      if (record.sectionCode !== null) {
        sectionId = await sectionOf(tx, record.sectionCode);
        if (sectionId === null) return { code: 'SECTION_NOT_FOUND', field: 'section_code' };
      }
      const existing = await tx.query<{ id: string }>('select id from machvon.land_parcel where project_id = $1::uuid and parcel_code = $2', [options.projectId, record.parcelCode]);
      if (existing[0] !== undefined) return { code: 'PARCEL_CODE_DUPLICATE', field: 'parcel_code' };
      resolved.set(entry.businessKey, { unitId: unit.id, sectionId });
      return undefined;
    },
    async apply(tx, entry) {
      const where = resolved.get(entry.businessKey);
      if (where === undefined) throw new Error('a parcel row reached apply without being examined');
      const { record } = entry;
      await tx.query(
        `insert into machvon.land_parcel
           (tenant_id, id, project_id, section_id, owner_unit_id, parcel_code, address_text, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::numeric, $9::numeric, 'SURVEYED', 1, $10::uuid, $10::uuid)`,
        [randomUUID(), options.projectId, where.sectionId, where.unitId, record.parcelCode, record.addressText, record.landUseGroup, record.areaTotalM2, record.areaAffectedM2, options.actor],
      );
      return [];
    },
  };
}

export interface ParcelImportInput {
  projectId: string;
  /** The file exactly as stored; its SHA-256 is its identity. */
  bytes: Uint8Array;
  fileObjectKey: string;
  /** The hash that the upload recorded (HASH_MISMATCH when the stored bytes differ). */
  expectedSha256: string;
  importedBy: string;
  correlationId: string;
  now?: Date;
}

export interface ParcelImportCounts {
  total: number;
  created: number;
  duplicate: number;
  conflict: number;
  refused: number;
}

export interface ParcelImportResult {
  /** APPLIED when every row was taken or was a repeat, PARTIALLY_APPLIED when some rows were refused or came back with other content, ALREADY_IMPORTED for bytes taken before. */
  outcome: 'APPLIED' | 'PARTIALLY_APPLIED' | 'ALREADY_IMPORTED';
  importId: string;
  counts: ParcelImportCounts;
}

/**
 * The parcel list import (ST-LND-001, LND 3.1 step 1, NFR-OPERABILITY-06). The file is read by the idempotent core of ST-KERNEL-070 (the file by its
 * SHA-256 within the project, each row by its parcel code and hash, the quarantine, the items with an owner) through the parcel adapter. The same file
 * again answers ALREADY_IMPORTED and changes nothing; a parcel code that another file or a person created is refused or left as it is, so no parcel is
 * ever created twice. Everything runs in the tenant transaction of the caller, so a defect leaves nothing and the same file can be tried again.
 */
export class LndParcelImportStore {
  private readonly core = new FileImportStore();

  async import(tx: TenantTx, input: ParcelImportInput): Promise<ParcelImportResult> {
    const adapter = createParcelFileAdapter({ projectId: input.projectId, actor: input.importedBy });
    const run = await this.core.run(tx, {
      adapter,
      bytes: input.bytes,
      fileObjectKey: input.fileObjectKey,
      expectedSha256: input.expectedSha256,
      importedBy: input.importedBy,
      fallbackOwnerId: input.importedBy,
      correlationId: input.correlationId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (run.outcome === 'FAILED') throw new DomainError(run.errorCode ?? 'IMPORT_SCHEMA_INVALID', 422, 'file');
    const counts: ParcelImportCounts = { total: run.counts.total, created: run.counts.applied, duplicate: run.counts.duplicate, conflict: run.counts.conflict, refused: run.counts.quarantined };
    if (run.outcome === 'ALREADY_IMPORTED') return { outcome: 'ALREADY_IMPORTED', importId: run.importId, counts };
    return {
      outcome: counts.refused > 0 || counts.conflict > 0 ? 'PARTIALLY_APPLIED' : 'APPLIED',
      importId: run.importId,
      counts,
    };
  }
}
