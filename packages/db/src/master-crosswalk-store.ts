import { randomUUID } from 'node:crypto';
import { DomainError, vietnamDateOf, versionConflict } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const MAX_SYSTEM = 50;
const MAX_CODE = 100;

export type CrosswalkMethod = 'MANUAL' | 'IMPORT' | 'RULE';
export type CrosswalkStatus = 'ACTIVE' | 'RETIRED';

export interface CrosswalkRow {
  id: string;
  masterRecordId: string;
  masterType: string;
  businessKey: string;
  sourceSystem: string;
  externalType: string;
  externalCode: string;
  validFrom: string;
  validUntil: string | null;
  matchMethod: CrosswalkMethod;
  confidence: number | null;
  status: CrosswalkStatus;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface CrosswalkInput {
  masterRecordId: string;
  sourceSystem: string;
  externalType: string;
  externalCode: string;
  validFrom: string;
  matchMethod: CrosswalkMethod;
  confidence?: number | undefined;
}

export interface CrosswalkFilter {
  sourceSystem?: string | undefined;
  externalType?: string | undefined;
  externalCode?: string | undefined;
  masterRecordId?: string | undefined;
  status?: CrosswalkStatus | undefined;
}

/** What an external code stands for: the entry it is mapped to. */
export interface CrosswalkTarget {
  recordId: string;
  masterType: string;
  businessKey: string;
}

interface SqlRow {
  id: string;
  master_record_id: string;
  master_type: string;
  business_key: string;
  source_system: string;
  external_type: string;
  external_code: string;
  valid_from: string;
  valid_until: string | null;
  match_method: CrosswalkMethod;
  confidence: string | null;
  status: CrosswalkStatus;
  version: string;
  created_at_key: string;
}

const SELECT = `select x.id, x.master_record_id, r.master_type, r.business_key, x.source_system, x.external_type, x.external_code,
  x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.match_method, x.confidence::text as confidence, x.status,
  x.version::text as version, ${timestampKey('x.created_at')} as created_at_key
  from machvon.master_crosswalk x join machvon.master_record r on r.tenant_id = x.tenant_id and r.id = x.master_record_id`;

const toRow = (row: SqlRow): CrosswalkRow => ({
  id: row.id,
  masterRecordId: row.master_record_id,
  masterType: row.master_type,
  businessKey: row.business_key,
  sourceSystem: row.source_system,
  externalType: row.external_type,
  externalCode: row.external_code,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  matchMethod: row.match_method,
  confidence: row.confidence === null ? null : Number(row.confidence),
  status: row.status,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A name or a code as it is stored: trimmed, not empty, without control characters, within its length. */
function textOf(value: string, field: string, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/**
 * The crosswalk between the codes of other systems and the entries of master data (ST-MDM-007, MDM 3.1 F8): one external code stands for one
 * entry at a time, a retired mapping keeps its history, and a code that has no mapping is told apart from one that has (the import does not
 * guess). The unique index of the table is the last word on duplicates; this store turns it into CROSSWALK_DUPLICATE.
 */
export class MasterCrosswalkStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<CrosswalkRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where x.id = $1::uuid${lock ? ' for update of x' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The mappings of the tenant, the newest first, by system, code type, code, entry and status. */
  async list(tx: TenantTx, filter: CrosswalkFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<CrosswalkRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::text is null or x.source_system = $1) and ($2::text is null or x.external_type = $2) and ($3::text is null or x.external_code = $3)
          and ($4::uuid is null or x.master_record_id = $4::uuid) and ($5::text is null or x.status = $5)
          and ($6::text is null or (${timestampKey('x.created_at')}, x.id) < ($6::text, $7::uuid))
        order by x.created_at desc, x.id desc limit $8`,
      [
        filter.sourceSystem ?? null,
        filter.externalType ?? null,
        filter.externalCode ?? null,
        filter.masterRecordId ?? null,
        filter.status ?? null,
        request.after?.code ?? null,
        request.after?.id ?? null,
        request.limit,
      ],
    );
    return rows.map(toRow);
  }

  /** Maps a code of another system to an entry; one entry for one code, so a second ACTIVE mapping of the same code is refused. */
  async create(tx: TenantTx, input: CrosswalkInput, actor: string): Promise<{ id: string; version: number }> {
    const sourceSystem = textOf(input.sourceSystem, 'source_system', MAX_SYSTEM);
    const externalType = textOf(input.externalType, 'external_type', MAX_SYSTEM);
    const externalCode = textOf(input.externalCode, 'external_code', MAX_CODE);
    if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) throw invalid('confidence');
    const record = await tx.query<{ status: string }>('select status from machvon.master_record where id = $1::uuid', [input.masterRecordId]);
    // An entry of another tenant is indistinguishable from one that does not exist.
    if (record[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A merged entry no longer stands for anything: the code belongs to the entry it was merged into.
    if (record[0].status === 'MERGED') throw invalid('master_record_id');
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.master_crosswalk
           (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, confidence, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8::numeric, 'ACTIVE', $9::uuid, $9::uuid)`,
        [id, input.masterRecordId, sourceSystem, externalType, externalCode, input.validFrom, input.matchMethod, input.confidence ?? null, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CROSSWALK_DUPLICATE', 409);
      throw error;
    }
    return { id, version: 1 };
  }

  /** Ends a mapping today (Vietnam date): the row stays, so the history of what a code meant is kept. */
  async retire(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ row: CrosswalkRow; version: number }> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    if (row.status !== 'ACTIVE') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const today = vietnamDateOf(new Date());
    const until = today < row.validFrom ? row.validFrom : today;
    await tx.query(
      `update machvon.master_crosswalk set status = 'RETIRED', valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, until, actor],
    );
    return { row, version: row.version + 1 };
  }

  /**
   * Translates the codes of one system and one code type, those that have an ACTIVE mapping in force on the date; a code that is not in
   * the answer has no mapping. The target is an entry that is not retired nor merged away.
   */
  async resolve(tx: TenantTx, sourceSystem: string, externalType: string, codes: readonly string[], on: string = vietnamDateOf(new Date())): Promise<Map<string, CrosswalkTarget>> {
    const found = new Map<string, CrosswalkTarget>();
    if (codes.length === 0) return found;
    const rows = await tx.query<{ external_code: string; master_record_id: string; master_type: string; business_key: string }>(
      `select x.external_code, x.master_record_id, r.master_type, r.business_key
         from machvon.master_crosswalk x join machvon.master_record r on r.tenant_id = x.tenant_id and r.id = x.master_record_id
        where x.status = 'ACTIVE' and x.source_system = $1 and x.external_type = $2 and x.external_code = any($3::text[])
          and x.valid_from <= $4::date and (x.valid_until is null or x.valid_until > $4::date) and r.status not in ('RETIRED', 'MERGED')`,
      [sourceSystem, externalType, [...codes], on],
    );
    for (const row of rows) found.set(row.external_code, { recordId: row.master_record_id, masterType: row.master_type, businessKey: row.business_key });
    return found;
  }
}
