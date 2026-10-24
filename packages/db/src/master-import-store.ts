import { DomainError, assertFourEyes, readTabularFile, versionConflict } from '@machvon/kernel';
import type { TabularFile } from '@machvon/kernel';
import type { BatchAccess, MasterContent, MasterNamespace } from './master-store.ts';
import { MasterCrosswalkStore } from './master-crosswalk-store.ts';
import type { CrosswalkTarget } from './master-crosswalk-store.ts';
import { MasterStore } from './master-store.ts';
import { coerceCell, entryOfRecord, masterTypeDefinition, tenantLookup, validateMasterContent } from './master-types.ts';
import type { EntryRef, TypeLookup } from './master-types.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
/** The batch decides and publishes the change requests it owns; no other command may (see MasterStore). */
const BATCH_ACCESS: BatchAccess = { viaImportBatch: true };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9_]*$/;
const ATTRIBUTE_FIELD = 'attributes.';
const LABEL_MAX_LENGTH = 500;
const LEGAL_BASIS_MAX_LENGTH = 2000;
/** The errors that a batch keeps for the screen; the count of the rows with an error is kept whole. */
export const MAX_STORED_ERRORS = 1000;

export type ImportMode = 'ATOMIC' | 'PARTIAL';
export type ImportStatus = 'STAGED' | 'VALIDATED' | 'IN_REVIEW' | 'APPLIED' | 'FAILED' | 'CANCELLED';

/** Which column of the file feeds which part of an entry: the values are the names of the columns. */
export interface ImportMapping {
  key: string;
  label: string;
  valid_from: string;
  parent_key?: string;
  valid_until?: string;
  legal_basis?: string;
  attributes?: Record<string, string>;
  /**
   * Columns that hold the codes of another system instead of keys of master data, and the mapping that translates them. A code without an
   * ACTIVE mapping is the row error CROSSWALK_MISSING, never a guess. `fields` are `parent_key` and `attributes.<name>`.
   */
  crosswalk?: { source_system: string; external_type: string; fields: string[] };
}

/** A row that cannot be imported: its line in the file (the header is line 1), the field and a stable code the screen translates. */
export interface RowError {
  row: number;
  field: string;
  code: string;
}

interface PlannedRow {
  line: number;
  businessKey: string;
  parentKey: string | null;
  content: MasterContent;
}

export interface ImportPlan {
  total: number;
  /** In the order they can be created in: a parent before its children. */
  valid: PlannedRow[];
  errors: RowError[];
  /** The number of rows with at least one error (the list above is cut at MAX_STORED_ERRORS). */
  errorRows: number;
}

export interface ImportBatchRow {
  id: string;
  masterType: string;
  fileObjectKey: string;
  fileSha256: string;
  mapping: ImportMapping;
  mode: ImportMode;
  status: ImportStatus;
  totalRows: number;
  errorRows: number;
  errors: RowError[];
  appliedAt: string | null;
  /** Who applied the batch (created its change requests): four-eyes is judged on this person, who may differ from the one who staged the file. Null until applied. */
  appliedBy: string | null;
  reviewedBy: string | null;
  publishedBy: string | null;
  decisionDocumentId: string | null;
  createdBy: string;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

/** One record that the publication of a batch put in force (or will, at its date). */
export interface PublishedRecord {
  recordId: string;
  businessKey: string;
  changeId: string;
  versionId: string;
  /** The version of the record after the publication: the aggregate version of its event. */
  recordVersion: number;
  validFrom: string;
  active: boolean;
}

interface BatchSqlRow {
  id: string;
  master_type: string;
  file_object_key: string;
  file_sha256: string;
  mapping_json: ImportMapping;
  mode: ImportMode;
  status: ImportStatus;
  total_rows: number;
  error_rows: number;
  errors_json: RowError[];
  applied_at: string | null;
  applied_by: string | null;
  reviewed_by: string | null;
  published_by: string | null;
  decision_document_id: string | null;
  created_by: string;
  version: string;
  created_at_key: string;
}

const KEY_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
const BATCH_SELECT = `select id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, applied_at::text as applied_at,
  applied_by, reviewed_by, published_by, decision_document_id, created_by, version::text as version, to_char(created_at at time zone 'UTC', ${KEY_FORMAT}) as created_at_key
  from machvon.master_import_batch`;

const toBatch = (row: BatchSqlRow): ImportBatchRow => ({
  id: row.id,
  masterType: row.master_type,
  fileObjectKey: row.file_object_key,
  fileSha256: row.file_sha256,
  mapping: row.mapping_json,
  mode: row.mode,
  status: row.status,
  totalRows: row.total_rows,
  errorRows: row.error_rows,
  errors: row.errors_json,
  appliedAt: row.applied_at,
  appliedBy: row.applied_by,
  reviewedBy: row.reviewed_by,
  publishedBy: row.published_by,
  decisionDocumentId: row.decision_document_id,
  createdBy: row.created_by,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const isCalendarDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** The attribute that names the key (alone or in a list of keys); the row as a whole when none does. */
function fieldReferring(attributes: Record<string, unknown>, key: string): string {
  const name = Object.entries(attributes).find(([, value]) => value === key || (Array.isArray(value) && value.includes(key)))?.[0];
  return name === undefined ? 'row' : `attributes.${name}`;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const CROSSWALK_NAME_MAX = 50;

/** The translation of a mapping: a system and a code type, and the columns of the mapping that carry such codes (at least one, each once). */
function checkCrosswalk(raw: unknown, mapping: ImportMapping): NonNullable<ImportMapping['crosswalk']> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('mapping.crosswalk');
  const { source_system: system, external_type: type, fields, ...rest } = raw as Record<string, unknown>;
  const name = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.trim().length > CROSSWALK_NAME_MAX) throw invalid('mapping.crosswalk');
    return value.trim();
  };
  if (Object.keys(rest).length > 0 || !Array.isArray(fields) || fields.length === 0) throw invalid('mapping.crosswalk');
  const allowed = new Set<string>([...(mapping.parent_key === undefined ? [] : ['parent_key']), ...Object.keys(mapping.attributes ?? {}).map((attribute) => `attributes.${attribute}`)]);
  const chosen = fields.map((field) => (typeof field === 'string' && allowed.has(field) ? field : undefined));
  if (chosen.includes(undefined) || new Set(chosen).size !== chosen.length) throw invalid('mapping.crosswalk');
  return { source_system: name(system), external_type: name(type), fields: chosen as string[] };
}

/** The mapping the request carries, checked against the columns of the file: every name must be a column that the file has. */
export function checkMapping(raw: unknown, headers: readonly string[]): ImportMapping {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('mapping');
  const { key, label, valid_from: validFrom, parent_key: parentKey, valid_until: validUntil, legal_basis: legalBasis, attributes, crosswalk, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid('mapping');
  const column = (field: string, value: unknown, required: boolean): string | undefined => {
    if (value === undefined) {
      if (required) throw invalid(`mapping.${field}`);
      return undefined;
    }
    if (typeof value !== 'string' || !headers.includes(value)) throw invalid(`mapping.${field}`);
    return value;
  };
  const mapping: ImportMapping = {
    key: column('key', key, true) as string,
    label: column('label', label, true) as string,
    valid_from: column('valid_from', validFrom, true) as string,
  };
  const optional = { parent_key: column('parent_key', parentKey, false), valid_until: column('valid_until', validUntil, false), legal_basis: column('legal_basis', legalBasis, false) };
  for (const [field, value] of Object.entries(optional)) if (value !== undefined) mapping[field as 'parent_key' | 'valid_until' | 'legal_basis'] = value;
  if (attributes !== undefined) {
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) throw invalid('mapping.attributes');
    const chosen: Record<string, string> = {};
    for (const [name, header] of Object.entries(attributes)) {
      if (!ATTRIBUTE_NAME.test(name) || typeof header !== 'string' || !headers.includes(header)) throw invalid('mapping.attributes');
      chosen[name] = header;
    }
    mapping.attributes = chosen;
  }
  if (crosswalk !== undefined) mapping.crosswalk = checkCrosswalk(crosswalk, mapping);
  return mapping;
}

/**
 * Bulk import of a catalogue (ST-MDM-006, MDM 3.1 F7), on the rules of every other change of master data: stage reads the file and says,
 * row by row, what is wrong; apply creates every record and its change request in one transaction and submits them; the batch is then
 * reviewed and published as one, so the whole file is in force or none of it. The file is the source of truth: stage and apply both read it,
 * and apply judges it again against what the tenant holds now.
 */
export class MasterImportStore {
  private readonly masters: MasterStore;
  private readonly crosswalks: MasterCrosswalkStore;

  constructor(masters: MasterStore = new MasterStore(), crosswalks: MasterCrosswalkStore = new MasterCrosswalkStore()) {
    this.masters = masters;
    this.crosswalks = crosswalks;
  }

  // ---- reads -----------------------------------------------------------------------------------------------------

  async find(tx: TenantTx, id: string, lock = false): Promise<ImportBatchRow | undefined> {
    const rows = await tx.query<BatchSqlRow>(`${BATCH_SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toBatch(rows[0]);
  }

  /** The batches of the tenant, the newest first, by status. */
  async list(tx: TenantTx, request: { status?: string | undefined; limit: number; after: { code: string; id: string } | undefined }): Promise<ImportBatchRow[]> {
    const rows = await tx.query<BatchSqlRow>(
      `${BATCH_SELECT}
        where ($1::text is null or status = $1)
          and ($2::text is null or (to_char(created_at at time zone 'UTC', ${KEY_FORMAT}), id) < ($2::text, $3::uuid))
        order by created_at desc, id desc limit $4`,
      [request.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toBatch);
  }

  /** The change requests that the batch created, by status: what is still waiting and what is decided. */
  async changeCounts(tx: TenantTx, id: string): Promise<Record<string, number>> {
    const rows = await tx.query<{ status: string; n: string }>('select status, count(*)::text as n from machvon.master_change_request where import_batch_id = $1::uuid group by status', [id]);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  }

  // ---- planning --------------------------------------------------------------------------------------------------

  /**
   * Judges every row of the file against the mapping, the rules of the type and what the tenant holds. Pure of side effects: it reads, and
   * the answer is the same for stage and for apply, so a file that passed stage and has not changed passes apply.
   */
  async plan(tx: TenantTx, masterType: string, table: TabularFile, mapping: ImportMapping): Promise<ImportPlan> {
    const policy = await this.masters.policyOf(tx, masterType);
    if (policy.scope === 'PLATFORM_ONLY') throw new DomainError('POLICY_LOCKED', 403, 'master_type');
    const column = (header: string | undefined): number => (header === undefined ? -1 : table.headers.indexOf(header));
    const at = {
      key: column(mapping.key),
      label: column(mapping.label),
      validFrom: column(mapping.valid_from),
      parent: column(mapping.parent_key),
      validUntil: column(mapping.valid_until),
      basis: column(mapping.legal_basis),
    };
    const attributeColumns = Object.entries(mapping.attributes ?? {}).map(([name, header]) => [name, column(header)] as const);
    const errors: RowError[] = [];
    const failed = new Set<number>();
    const seen = new Set<string>();
    const fail = (line: number, field: string, code: string): void => {
      failed.add(line);
      // The same fault of the same field is told once.
      if (seen.has(`${line}:${field}:${code}`)) return;
      seen.add(`${line}:${field}:${code}`);
      errors.push({ row: line, field, code });
    };

    // The codes of another system, translated in one read: a code that is not in the answer has no ACTIVE mapping in force.
    const translated = new Set(mapping.crosswalk?.fields ?? []);
    const codePositions = [...(translated.has('parent_key') ? [at.parent] : []), ...attributeColumns.filter(([name]) => translated.has(`attributes.${name}`)).map(([, position]) => position)];
    const targets =
      mapping.crosswalk === undefined
        ? new Map<string, CrosswalkTarget>()
        : await this.crosswalks.resolve(
            tx,
            mapping.crosswalk.source_system,
            mapping.crosswalk.external_type,
            [...new Set(table.rows.flatMap((cells) => codePositions.map((position) => (cells[position] ?? '').trim()).filter((code) => code !== '')))],
          );

    interface Draft extends PlannedRow {
      parentLine: number | null;
      /** The parent that a crosswalk named: the very record, whatever other entries share its key. */
      pinned: { id: string } | null;
    }
    const drafts: Draft[] = [];
    const lineOfKey = new Map<string, number>();
    table.rows.forEach((cells, index) => {
      // The line of the source, not the place in the list: blank lines and cells that run over several lines are not rows.
      const line = table.lines[index] as number;
      const cell = (position: number): string => (position < 0 ? '' : (cells[position] ?? '').trim());
      const key = cell(at.key);
      if (key === '') fail(line, 'business_key', 'REQUIRED');
      else if (!KEY.test(key)) fail(line, 'business_key', 'INVALID_FORMAT');
      else if (lineOfKey.has(key)) fail(line, 'business_key', 'DUPLICATE_IN_FILE');
      else lineOfKey.set(key, line);
      const label = cell(at.label);
      if (label === '') fail(line, 'label', 'REQUIRED');
      else if (label.length > LABEL_MAX_LENGTH) fail(line, 'label', 'TOO_LONG');
      const from = cell(at.validFrom);
      if (from === '') fail(line, 'valid_from', 'REQUIRED');
      else if (!isCalendarDate(from)) fail(line, 'valid_from', 'INVALID_DATE');
      const until = cell(at.validUntil);
      if (until !== '' && !isCalendarDate(until)) fail(line, 'valid_until', 'INVALID_DATE');
      else if (until !== '' && from !== '' && isCalendarDate(from) && until <= from) fail(line, 'valid_until', 'INVALID_RANGE');
      const basis = cell(at.basis);
      if (basis.length > LEGAL_BASIS_MAX_LENGTH) fail(line, 'legal_basis', 'TOO_LONG');
      const attributes: Record<string, unknown> = {};
      for (const [name, position] of attributeColumns) {
        let raw = cell(position);
        if (raw === '') continue;
        if (translated.has(`attributes.${name}`)) {
          const target = targets.get(raw);
          if (target === undefined) {
            fail(line, `attributes.${name}`, 'CROSSWALK_MISSING');
            continue;
          }
          // The code stands for an entry of one type: the attribute must refer to that type, or the key would pick another entry that happens to share it.
          const declared = masterTypeDefinition(masterType)?.fields.find((candidate) => candidate.name === name);
          const referred = declared !== undefined && (declared.kind === 'key' || declared.kind === 'keys') ? declared.refType : undefined;
          if (referred !== target.masterType) {
            fail(line, `attributes.${name}`, 'INVALID_VALUE');
            continue;
          }
          raw = target.businessKey;
        }
        const coerced = coerceCell(masterType, name, raw);
        if (coerced.ok) attributes[name] = coerced.value;
        else fail(line, `attributes.${name}`, 'INVALID_VALUE');
      }
      let parentKey = cell(at.parent);
      let pinned: Draft['pinned'] = null;
      if (parentKey !== '' && translated.has('parent_key')) {
        const target = targets.get(parentKey);
        if (target === undefined) {
          fail(line, 'parent_key', 'CROSSWALK_MISSING');
          parentKey = '';
        } else if (target.masterType !== masterType) {
          fail(line, 'parent_key', 'PARENT_NOT_FOUND');
          parentKey = '';
        } else {
          parentKey = target.businessKey;
          pinned = { id: target.recordId };
        }
      }
      drafts.push({
        line,
        businessKey: key,
        parentKey: parentKey === '' ? null : parentKey,
        parentLine: null,
        pinned,
        content: { label, attributes, parentRecordId: null, validFrom: from, validUntil: until === '' ? null : until, legalBasis: basis === '' ? null : basis },
      });
    });

    // Keys that the tenant already holds in its own namespace.
    const keys = drafts.map((draft) => draft.businessKey).filter((key) => key !== '');
    if (keys.length > 0) {
      const existing = await tx.query<{ business_key: string }>("select business_key from machvon.master_record where namespace = 'TENANT' and master_type = $1 and business_key = any($2::text[])", [masterType, keys]);
      const held = new Set(existing.map((row) => row.business_key));
      for (const draft of drafts) if (held.has(draft.businessKey) && lineOfKey.get(draft.businessKey) === draft.line) fail(draft.line, 'business_key', 'DUPLICATE_KEY');
    }

    // Parents: another row of the file, or an entry that exists; a parent that is nowhere is an error, a ring of parents is an error for each of its rows.
    const parents = new Map<string, { id: string; namespace: MasterNamespace; entry: EntryRef } | null>();
    const pinnedParents = new Map<number, { id: string; namespace: MasterNamespace; entry: EntryRef }>();
    const existingParent = async (key: string): Promise<{ id: string; namespace: MasterNamespace; entry: EntryRef } | null> => {
      const known = parents.get(key);
      if (known !== undefined) return known;
      const rows = await tx.query<{ id: string; namespace: MasterNamespace }>(
        `select id, namespace from machvon.master_record where master_type = $1 and business_key = $2 and status not in ('RETIRED', 'MERGED')
          order by case namespace when 'PLATFORM' then 0 else 1 end limit 1`,
        [masterType, key],
      );
      const found = rows[0];
      const entry = found === undefined ? undefined : await entryOfRecord(tx, found.id);
      const resolved = found === undefined || entry === undefined ? null : { id: found.id, namespace: found.namespace, entry };
      parents.set(key, resolved);
      return resolved;
    };
    for (const draft of drafts) {
      if (draft.parentKey === null || draft.businessKey === '') continue;
      if (draft.pinned !== null) {
        const entry = await entryOfRecord(tx, draft.pinned.id);
        const namespaces = await tx.query<{ namespace: MasterNamespace }>('select namespace from machvon.master_record where id = $1::uuid', [draft.pinned.id]);
        const namespace = namespaces[0]?.namespace;
        if (entry === undefined || namespace === undefined) fail(draft.line, 'parent_key', 'PARENT_NOT_FOUND');
        else {
          pinnedParents.set(draft.line, { id: draft.pinned.id, namespace, entry });
          draft.content.parentRecordId = draft.pinned.id;
        }
        continue;
      }
      const inFile = lineOfKey.get(draft.parentKey);
      if (inFile !== undefined) {
        draft.parentLine = inFile;
        if (inFile === draft.line) fail(draft.line, 'parent_key', 'PARENT_CYCLE');
        continue;
      }
      const found = await existingParent(draft.parentKey);
      if (found === null) fail(draft.line, 'parent_key', 'PARENT_NOT_FOUND');
      else draft.content.parentRecordId = found.id;
    }

    // The order the rows can be created in; the rows of a ring are never reached.
    const byLine = new Map(drafts.map((draft) => [draft.line, draft]));
    const ordered: Draft[] = [];
    const state = new Map<number, 'visiting' | 'done'>();
    const visit = (draft: Draft): boolean => {
      const seen = state.get(draft.line);
      if (seen === 'done') return true;
      if (seen === 'visiting') return false;
      state.set(draft.line, 'visiting');
      const parent = draft.parentLine === null ? undefined : byLine.get(draft.parentLine);
      const parentOk = parent === undefined || visit(parent);
      if (!parentOk) {
        fail(draft.line, 'parent_key', 'PARENT_CYCLE');
        state.set(draft.line, 'done');
        return false;
      }
      state.set(draft.line, 'done');
      ordered.push(draft);
      return true;
    };
    for (const draft of drafts) visit(draft);

    // The rules of the type, with the entries of the file visible to each other (a programme may name a source of the same file, a stage
    // the stage that follows it, wherever it stands in the file). Which rows of the file a row refers to is kept: if one of them is left out,
    // the row cannot be created either.
    const inFile = new Map<string, EntryRef>();
    for (const draft of ordered) if (!failed.has(draft.line)) inFile.set(draft.businessKey, { masterType, businessKey: draft.businessKey, attributes: draft.content.attributes });
    const database = tenantLookup(tx);
    const referred = new Map<number, Set<string>>();
    const rowsOk = new Set<number>();
    for (const draft of ordered) {
      if (failed.has(draft.line)) continue;
      const used = new Set<string>();
      referred.set(draft.line, used);
      const lookup: TypeLookup = {
        entry: async (type, key) => {
          const own = type === masterType ? inFile.get(key) : undefined;
          if (own === undefined) return database.entry(type, key);
          used.add(key);
          return own;
        },
      };
      // A row whose parent is in the file is judged after the parent: if the parent failed, the row cannot be created either.
      const parentRow = draft.parentLine === null ? undefined : byLine.get(draft.parentLine);
      if (parentRow !== undefined && !rowsOk.has(parentRow.line)) {
        fail(draft.line, 'parent_key', 'PARENT_SKIPPED');
        continue;
      }
      const parentEntry =
        draft.parentKey === null ? undefined : parentRow !== undefined ? inFile.get(parentRow.businessKey) : (pinnedParents.get(draft.line) ?? parents.get(draft.parentKey))?.entry;
      // Under a type that a tenant only extends, the parent must be an entry of the platform.
      if (policy.scope === 'PLATFORM_WITH_TENANT_EXTENSION' && (draft.parentKey === null || parentRow !== undefined || (pinnedParents.get(draft.line) ?? parents.get(draft.parentKey))?.namespace !== 'PLATFORM')) {
        fail(draft.line, 'parent_key', 'POLICY_LOCKED');
        continue;
      }
      try {
        await validateMasterContent({ masterType, businessKey: draft.businessKey, content: draft.content, parent: parentEntry, lookup });
        rowsOk.add(draft.line);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // The parent is named by its key in a file: the field of a row is the column that holds it.
        // A reference to a row of the file that is itself in error is not a wrong value: the other row is the fault.
        const named = error.detail?.startsWith(ATTRIBUTE_FIELD) ? draft.content.attributes[error.detail.slice(ATTRIBUTE_FIELD.length)] : undefined;
        const toLeftOut = (Array.isArray(named) ? named : [named]).some((key) => typeof key === 'string' && failed.has(lineOfKey.get(key) ?? -1));
        const code = toLeftOut ? 'REFERENCE_SKIPPED' : error.code === 'VALIDATION_FAILED' ? 'INVALID_VALUE' : error.code;
        fail(draft.line, error.detail === 'parent_record_id' ? 'parent_key' : (error.detail ?? 'row'), code);
      }
    }

    // A row that was judged right while a row it refers to was still standing is not right once that row is left out (the rows that refer to
    // it follow, until nothing changes): it is told here, never found out when the records are created.
    for (let changed = true; changed; ) {
      changed = false;
      for (const draft of ordered) {
        if (failed.has(draft.line)) continue;
        const gone = [...(referred.get(draft.line) ?? [])].find((key) => failed.has(lineOfKey.get(key) as number));
        if (gone !== undefined) fail(draft.line, fieldReferring(draft.content.attributes, gone), 'REFERENCE_SKIPPED');
        else if (draft.parentLine !== null && failed.has(draft.parentLine)) fail(draft.line, 'parent_key', 'PARENT_SKIPPED');
        else continue;
        changed = true;
      }
    }

    errors.sort((left, right) => left.row - right.row || left.field.localeCompare(right.field));
    return {
      total: table.rows.length,
      // A pinned parent is created against its record id: the key of the parent is not looked up again among the rows of the file.
      valid: ordered.filter((draft) => !failed.has(draft.line)).map((draft) => (draft.pinned === null ? draft : { ...draft, parentKey: null })),
      errors: errors.slice(0, MAX_STORED_ERRORS),
      errorRows: failed.size,
    };
  }

  // ---- commands --------------------------------------------------------------------------------------------------

  /** Reads and judges the file; the batch is stored as VALIDATED with its row errors, nothing else is written. */
  async stage(tx: TenantTx, input: { masterType: string; fileObjectKey: string; fileSha256: string; mapping: unknown; mode: ImportMode; bytes: Uint8Array }, actor: string): Promise<ImportBatchRow> {
    await this.assertNotApplied(tx, input.masterType, input.fileSha256);
    const table = readTabularFile(input.bytes);
    const mapping = checkMapping(input.mapping, table.headers);
    const plan = await this.plan(tx, input.masterType, table, mapping);
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.master_import_batch (tenant_id, id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, 'VALIDATED', $6, $7, $8::jsonb, $9::uuid, $9::uuid) returning id`,
      [input.masterType, input.fileObjectKey, input.fileSha256, JSON.stringify(mapping), input.mode, plan.total, plan.errorRows, JSON.stringify(plan.errors), actor],
    );
    return (await this.find(tx, (rows[0] as { id: string }).id)) as ImportBatchRow;
  }

  /**
   * Creates every record of the batch with its change request, in one transaction, and submits them for review. The file is read and judged
   * again: ATOMIC with one error row changes nothing (422 IMPORT_HAS_ERRORS), PARTIAL leaves the error rows out and keeps their list.
   */
  async apply(tx: TenantTx, id: string, expectedVersion: number, bytes: Uint8Array, actor: string): Promise<{ batch: ImportBatchRow; created: number; skipped: number }> {
    const batch = await this.lock(tx, id, expectedVersion);
    if (batch.status !== 'VALIDATED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${batch.status}->apply`);
    await this.assertNotApplied(tx, batch.masterType, batch.fileSha256);
    const table = readTabularFile(bytes);
    const plan = await this.plan(tx, batch.masterType, table, checkMapping(batch.mapping, table.headers));
    if (batch.mode === 'ATOMIC' && plan.errorRows > 0) throw new DomainError('IMPORT_HAS_ERRORS', 422, undefined, { extensions: { error_rows: plan.errorRows } });
    // A batch with no record to create has nothing to review or publish: it would wait in review for ever.
    if (plan.valid.length === 0) throw new DomainError('IMPORT_EMPTY', 422);
    // The records are created in one transaction, parents first, and refer to each other as the plan judged them: against the file.
    const database = tenantLookup(tx);
    const entries = new Map(plan.valid.map((row) => [row.businessKey, { masterType: batch.masterType, businessKey: row.businessKey, attributes: row.content.attributes }] as const));
    const lookup: TypeLookup = { entry: async (type, key) => (type === batch.masterType ? entries.get(key) : undefined) ?? (await database.entry(type, key)) };
    const created = new Map<string, string>();
    const reason = `Imported from the file ${batch.fileSha256.slice(0, 12)}`;
    for (const row of plan.valid) {
      const parentId = row.parentKey === null ? row.content.parentRecordId : (created.get(row.parentKey) ?? row.content.parentRecordId);
      const proposed = await this.masters.propose(tx, { masterType: batch.masterType, businessKey: row.businessKey, content: { ...row.content, parentRecordId: parentId }, reason }, actor, lookup);
      created.set(row.businessKey, proposed.recordId);
      await tx.query('update machvon.master_change_request set import_batch_id = $2::uuid where id = $1::uuid', [proposed.changeRequestId, batch.id]);
      await this.masters.submit(tx, proposed.changeRequestId, proposed.version, actor, BATCH_ACCESS);
    }
    await tx.query(
      `update machvon.master_import_batch set status = 'IN_REVIEW', total_rows = $2, error_rows = $3, errors_json = $4::jsonb, applied_by = $5::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [batch.id, plan.total, plan.errorRows, JSON.stringify(plan.errors), actor],
    );
    return { batch: (await this.find(tx, batch.id)) as ImportBatchRow, created: plan.valid.length, skipped: plan.errorRows };
  }

  /** The change requests of the batch that are open, with the record each one is about. */
  private async openChanges(tx: TenantTx, id: string): Promise<Array<{ id: string; version: number; status: string; masterRecordId: string; createdBy: string }>> {
    const rows = await tx.query<{ id: string; version: string; status: string; master_record_id: string; created_by: string }>(
      'select id, version::text as version, status, master_record_id, created_by from machvon.master_change_request where import_batch_id = $1::uuid order by created_at, id',
      [id],
    );
    return rows.map((row) => ({ id: row.id, version: Number(row.version), status: row.status, masterRecordId: row.master_record_id, createdBy: row.created_by }));
  }

  /** Approves or rejects the whole batch: every change request of it is decided together, by someone who did not apply it. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: 'approve' | 'reject', reviewer: string): Promise<{ batch: ImportBatchRow; changes: number }> {
    const batch = await this.lock(tx, id, expectedVersion);
    if (batch.status !== 'IN_REVIEW' || batch.reviewedBy !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${batch.status}->${decision}`);
    const changes = await this.openChanges(tx, id);
    const first = changes[0];
    if (first === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${batch.status}->${decision}`);
    assertFourEyes(batch.appliedBy ?? first.createdBy, reviewer);
    for (const change of changes) {
      if (change.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${change.status}->${decision}`);
      await this.masters.decide(tx, change.id, change.version, decision, reviewer, BATCH_ACCESS);
    }
    await tx.query(
      `update machvon.master_import_batch set status = $2, reviewed_by = $3::uuid, reviewed_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, decision === 'approve' ? 'IN_REVIEW' : 'CANCELLED', reviewer],
    );
    return { batch: (await this.find(tx, id)) as ImportBatchRow, changes: changes.length };
  }

  /**
   * Puts the approved batch in force on one decision document: every record is published in this transaction or none is. The batch becomes
   * APPLIED, and the file cannot be applied again (409 IMPORT_FILE_ALREADY_APPLIED).
   */
  async publish(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    decisionDocumentId: string,
    publisher: string,
  ): Promise<{ batch: ImportBatchRow; published: PublishedRecord[] }> {
    const batch = await this.lock(tx, id, expectedVersion);
    if (batch.status !== 'IN_REVIEW' || batch.reviewedBy === null) throw new DomainError('CHANGE_NOT_APPROVED', 409);
    const changes = await this.openChanges(tx, id);
    if (changes.length === 0 || changes.some((change) => change.status !== 'APPROVED')) throw new DomainError('CHANGE_NOT_APPROVED', 409);
    assertFourEyes(batch.appliedBy ?? (changes[0] as { createdBy: string }).createdBy, publisher);
    const published: PublishedRecord[] = [];
    for (const change of changes) {
      const record = await this.masters.findRecord(tx, change.masterRecordId, true);
      if (record === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const result = await this.masters.publish(tx, record.id, record.version, decisionDocumentId, publisher, BATCH_ACCESS);
      published.push({ recordId: record.id, businessKey: record.businessKey, changeId: result.change.id, versionId: result.versionId, recordVersion: result.version, validFrom: result.change.effectiveFrom, active: result.active });
    }
    try {
      await tx.query(
        `update machvon.master_import_batch set status = 'APPLIED', applied_at = now(), published_by = $2::uuid, published_at = now(), decision_document_id = $3::uuid,
                updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [id, publisher, decisionDocumentId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409);
      throw error;
    }
    return { batch: (await this.find(tx, id)) as ImportBatchRow, published };
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number): Promise<ImportBatchRow> {
    const batch = await this.find(tx, id, true);
    if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (batch.version !== expectedVersion) throw versionConflict(batch.version);
    return batch;
  }

  /** A file whose content was applied before is never applied again, whatever its name (the same bytes, the same type). */
  private async assertNotApplied(tx: TenantTx, masterType: string, sha256: string): Promise<void> {
    const rows = await tx.query("select 1 from machvon.master_import_batch where master_type = $1 and file_sha256 = $2 and status = 'APPLIED'", [masterType, sha256]);
    if (rows.length > 0) throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409);
  }
}
