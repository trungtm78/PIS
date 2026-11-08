import {
  DomainError,
  effectiveStateOn,
  extractionStatusOf,
  assertVersionMove,
  vietnamDateOf,
  versionConflict,
} from '@machvon/kernel';
import type { DocumentVersionStatus, EffectiveState, ProjectDocumentChange, ProjectDocumentInput, RepositoryFormat, TextUnit } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The project document repository (DOC-2, PD.01 and PD.02, docs/doc-repository.md): documents of a project with their versions. A document is read and changed in the scope of the caller over its PROJECT (the
 * owner unit or the investor unit of the project lies in a grant that carries the permission, or the grant names the project): a document of a project outside the scope is not there (404), never forbidden.
 * The rules live in the kernel (`doc-repository.ts`); the database keeps the ones that must hold whoever writes (the guards of V2160 to V2163).
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The aliases of the project scope: `d` the document, `p` its project, `ou` the owner unit and `iu` the investor unit. */
const SCOPE_JOINS = `join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

/** What a failed write means: the rules of the database, in the words of the codes. */
export function refuseWrite(error: unknown): never {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : '';
  const constraint = (error as { constraint?: string }).constraint ?? '';
  if (code === CHECK_VIOLATION) {
    for (const [prefix, status] of [['DOC_LINK_MISMATCH', 422], ['DOC_ARCHIVED', 409], ['DOC_VERSION_LOCKED', 409], ['DOC_VERSION_STATE_INVALID', 409], ['DOC_REVIEW_NOT_OPEN', 409]] as const) {
      if (message.startsWith(prefix)) throw new DomainError(prefix, status);
    }
  }
  if (code === UNIQUE_VIOLATION) {
    if (constraint === 'project_document_reference_uq') throw new DomainError('DOC_DUPLICATE_REFERENCE', 409, 'reference');
    if (constraint === 'project_document_version_file_uq') throw new DomainError('DOC_VERSION_DUPLICATE', 409, 'file_sha256');
    if (constraint === 'document_review_open_uq') throw new DomainError('DOC_REVIEW_ALREADY_OPEN', 409, 'document_id');
  }
  throw error;
}

export interface DocumentHeader {
  id: string;
  project: { id: string; code: string; name: string };
  contract: { id: string; code: string } | null;
  package: { id: string; code: string } | null;
  docClass: string;
  title: string;
  reference: string | null;
  securityClass: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  effectiveState: EffectiveState;
  note: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  archiveReason: string | null;
  currentVersion: { id: string; versionNo: number; status: DocumentVersionStatus; format: RepositoryFormat } | null;
  approvedVersion: { id: string; versionNo: number } | null;
  versionCount: number;
  latestReview: { id: string; round: number; status: string } | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

interface HeaderSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  contract_id: string | null;
  contract_code: string | null;
  package_id: string | null;
  package_code: string | null;
  doc_class: string;
  title: string;
  reference: string | null;
  security_class: string;
  effective_from: string | null;
  effective_to: string | null;
  note: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  archive_reason: string | null;
  current_version_id: string | null;
  current_no: number | null;
  current_status: DocumentVersionStatus | null;
  current_format: RepositoryFormat | null;
  approved_version_id: string | null;
  approved_no: number | null;
  version_count: string;
  review_id: string | null;
  review_round: number | null;
  review_status: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

const HEADER_COLUMNS = `d.id, d.project_id, p.code as project_code, p.name as project_name, d.contract_id, c.code as contract_code, d.package_id, pk.code as package_code,
       d.doc_class, d.title, d.reference, d.security_class, d.effective_from::text as effective_from, d.effective_to::text as effective_to, d.note, d.status, d.archive_reason,
       d.current_version_id, cv.version_no as current_no, cv.status as current_status, cv.format as current_format, d.approved_version_id, av.version_no as approved_no,
       (select count(*)::text from machvon.project_document_version x where x.tenant_id = d.tenant_id and x.document_id = d.id) as version_count,
       lr.id as review_id, lr.round_no as review_round, lr.status as review_status,
       d.version::text as version, to_char(d.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('d.created_at')} as created_at_key, d.created_by,
       to_char(d.updated_at at time zone 'UTC', ${ISO}) as updated_at, d.updated_by`;

const HEADER_FROM = `machvon.project_document d ${SCOPE_JOINS}
  left join machvon.contract c on c.tenant_id = d.tenant_id and c.id = d.contract_id
  left join machvon.procurement_package pk on pk.tenant_id = d.tenant_id and pk.id = d.package_id
  left join machvon.project_document_version cv on cv.tenant_id = d.tenant_id and cv.id = d.current_version_id
  left join machvon.project_document_version av on av.tenant_id = d.tenant_id and av.id = d.approved_version_id
  left join lateral (select r.id, r.round_no, r.status from machvon.document_review r where r.tenant_id = d.tenant_id and r.document_id = d.id order by r.round_no desc limit 1) lr on true`;

const headerOf = (row: HeaderSql, today: string): DocumentHeader => ({
  id: row.id,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  contract: row.contract_id === null ? null : { id: row.contract_id, code: row.contract_code ?? '' },
  package: row.package_id === null ? null : { id: row.package_id, code: row.package_code ?? '' },
  docClass: row.doc_class,
  title: row.title,
  reference: row.reference,
  securityClass: row.security_class,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  effectiveState: effectiveStateOn({ effectiveFrom: row.effective_from, effectiveTo: row.effective_to }, today),
  note: row.note,
  status: row.status,
  archiveReason: row.archive_reason,
  currentVersion: row.current_version_id === null ? null : { id: row.current_version_id, versionNo: row.current_no ?? 0, status: row.current_status ?? 'DRAFT', format: row.current_format ?? 'PDF' },
  approvedVersion: row.approved_version_id === null ? null : { id: row.approved_version_id, versionNo: row.approved_no ?? 0 },
  versionCount: Number(row.version_count),
  latestReview: row.review_id === null ? null : { id: row.review_id, round: row.review_round ?? 0, status: row.review_status ?? '' },
  version: Number(row.version),
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

export interface DocumentFilter {
  projectId?: string | undefined;
  contractId?: string | undefined;
  packageId?: string | undefined;
  docClass?: string | undefined;
  status?: 'ACTIVE' | 'ARCHIVED' | undefined;
  effective?: EffectiveState | undefined;
  reviewStatus?: string | undefined;
  q?: string | undefined;
}

export interface FileFacts {
  key: string;
  sha256: string;
  sizeBytes: number;
  format: RepositoryFormat;
  mime: string;
  pageCount: number | null;
}

/** What the extraction left, as it is recorded with a version. */
export interface ExtractionRecord {
  units: readonly TextUnit[];
  truncated: number;
  failed: boolean;
  engine: { name: string; version: string } | null;
}

export interface VersionHeader {
  id: string;
  documentId: string;
  versionNo: number;
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: RepositoryFormat;
  mime: string;
  pageCount: number | null;
  extractionStatus: string;
  extractionEngine: string | null;
  unitCount: number;
  truncatedUnits: number;
  status: DocumentVersionStatus;
  changeNote: string | null;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  createdBy: string;
}

interface VersionSql {
  id: string;
  document_id: string;
  version_no: number;
  file_object_key: string;
  file_sha256: string;
  size_bytes: string;
  format: RepositoryFormat;
  mime: string;
  page_count: number | null;
  extraction_status: string;
  extraction_engine: string | null;
  extraction_engine_version: string | null;
  unit_count: number;
  truncated_units: number;
  status: DocumentVersionStatus;
  change_note: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  created_by: string;
}

const VERSION_COLUMNS = `v.id, v.document_id, v.version_no, v.file_object_key, v.file_sha256, v.size_bytes::text as size_bytes, v.format, v.mime, v.page_count, v.extraction_status, v.extraction_engine,
       v.extraction_engine_version, v.unit_count, v.truncated_units, v.status, v.change_note, to_char(v.locked_at at time zone 'UTC', ${ISO}) as locked_at, v.locked_by,
       to_char(v.created_at at time zone 'UTC', ${ISO}) as created_at, v.created_by`;

const versionOf = (row: VersionSql): VersionHeader => ({
  id: row.id,
  documentId: row.document_id,
  versionNo: row.version_no,
  fileObjectKey: row.file_object_key,
  fileSha256: row.file_sha256,
  sizeBytes: Number(row.size_bytes),
  format: row.format,
  mime: row.mime,
  pageCount: row.page_count,
  extractionStatus: row.extraction_status,
  extractionEngine: row.extraction_engine === null ? null : `${row.extraction_engine} ${row.extraction_engine_version ?? ''}`.trim(),
  unitCount: row.unit_count,
  truncatedUnits: row.truncated_units,
  status: row.status,
  changeNote: row.change_note,
  locked: row.locked_at !== null,
  lockedAt: row.locked_at,
  lockedBy: row.locked_by,
  createdAt: row.created_at,
  createdBy: row.created_by,
});

const UNIT_BATCH = 400;

const like = (text: string): string => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export class DocumentRepositoryStore {
  // ---- reads ----------------------------------------------------------------------------------------------------------------------------------

  /** The display names of members; an id with no name in the directory is left out, never guessed. */
  async names(tx: TenantTx, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
    const names = new Map<string, string>();
    if (wanted.length === 0) return names;
    const rows = await tx.query<{ membership_id: string; display_name: string }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [wanted]);
    for (const row of rows) names.set(row.membership_id, row.display_name);
    return names;
  }

  /** The unit that owns the project of a document: where the approvers of its review are looked for. */
  async ownerUnitOf(tx: TenantTx, documentId: string): Promise<string> {
    const rows = await tx.query<{ owner_unit_id: string }>('select p.owner_unit_id from machvon.project_document d join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id where d.id = $1::uuid', [documentId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0].owner_unit_id;
  }

  /** One document as the caller may see it, or undefined when it does not exist or its project is out of the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder, now: Date): Promise<DocumentHeader | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<HeaderSql>(`select ${HEADER_COLUMNS} from ${HEADER_FROM} where d.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : headerOf(rows[0], vietnamDateOf(now));
  }

  async list(
    tx: TenantTx,
    filter: DocumentFilter,
    scope: ScopeBuilder,
    now: Date,
    page: { limit: number; after: { key: string; id: string } | undefined },
  ): Promise<{ items: DocumentHeader[]; more: boolean; last: { key: string; id: string } | undefined }> {
    const params: unknown[] = [];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const predicate = scope(params.length + 1);
    params.push(...predicate.params);
    const where: string[] = [predicate.sql];
    // The day is a parameter only when a filter reads it: a parameter nothing refers to has no type.
    const today = (): string => next(vietnamDateOf(now));
    if (filter.projectId !== undefined) where.push(`d.project_id = ${next(filter.projectId)}::uuid`);
    if (filter.contractId !== undefined) where.push(`d.contract_id = ${next(filter.contractId)}::uuid`);
    if (filter.packageId !== undefined) where.push(`d.package_id = ${next(filter.packageId)}::uuid`);
    if (filter.docClass !== undefined) where.push(`d.doc_class = ${next(filter.docClass)}`);
    if (filter.status !== undefined) where.push(`d.status = ${next(filter.status)}`);
    if (filter.reviewStatus !== undefined) where.push(filter.reviewStatus === 'NONE' ? 'lr.id is null' : `lr.status = ${next(filter.reviewStatus)}`);
    if (filter.q !== undefined) {
      const pattern = next(like(filter.q));
      where.push(`(d.title ilike ${pattern} escape '\\' or d.reference ilike ${pattern} escape '\\')`);
    }
    if (filter.effective !== undefined) {
      const state: Record<EffectiveState, () => string> = {
        UNDATED: () => 'd.effective_from is null and d.effective_to is null',
        NOT_YET: () => `d.effective_from is not null and ${today()}::date < d.effective_from`,
        EXPIRED: () => `d.effective_to is not null and ${today()}::date > d.effective_to`,
        IN_FORCE: () => {
          const day = today();
          return `(d.effective_from is not null or d.effective_to is not null) and (d.effective_from is null or ${day}::date >= d.effective_from) and (d.effective_to is null or ${day}::date <= d.effective_to)`;
        },
      };
      where.push(`(${state[filter.effective]()})`);
    }
    if (page.after !== undefined) where.push(`(${timestampKey('d.created_at')}, d.id) < (${next(page.after.key)}::text, ${next(page.after.id)}::uuid)`);
    const rows = await tx.query<HeaderSql>(`select ${HEADER_COLUMNS} from ${HEADER_FROM} where ${where.join(' and ')} order by d.created_at desc, d.id desc limit ${next(page.limit + 1)}`, params);
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map((row) => headerOf(row, vietnamDateOf(now))), more: rows.length > page.limit, last: last === undefined ? undefined : { key: last.created_at_key, id: last.id } };
  }

  async versionsOf(tx: TenantTx, documentId: string): Promise<VersionHeader[]> {
    const rows = await tx.query<VersionSql>(`select ${VERSION_COLUMNS} from machvon.project_document_version v where v.document_id = $1::uuid order by v.version_no desc`, [documentId]);
    return rows.map(versionOf);
  }

  /** A version with the document it belongs to, in the scope of the caller (undefined when either is out of it). */
  async findVersion(tx: TenantTx, versionId: string, scope: ScopeBuilder, now: Date): Promise<{ version: VersionHeader; document: DocumentHeader } | undefined> {
    const predicate = scope(2);
    const found = await tx.query<{ document_id: string }>(
      `select v.document_id from machvon.project_document_version v join machvon.project_document d on d.tenant_id = v.tenant_id and d.id = v.document_id ${SCOPE_JOINS} where v.id = $1::uuid and ${predicate.sql}`,
      [versionId, ...predicate.params],
    );
    if (found[0] === undefined) return undefined;
    const document = await this.find(tx, found[0].document_id, scope, now);
    if (document === undefined) return undefined;
    const rows = await tx.query<VersionSql>(`select ${VERSION_COLUMNS} from machvon.project_document_version v where v.id = $1::uuid`, [versionId]);
    return rows[0] === undefined ? undefined : { version: versionOf(rows[0]), document };
  }

  // ---- writes ---------------------------------------------------------------------------------------------------------------------------------

  /** The project of a new document, when the caller may write in it: 404 when it is out of the scope. */
  async assertProjectInScope(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<void> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string }>(
      `select p.id from machvon.project p join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id where p.id = $1::uuid and ${predicate.sql}`,
      [projectId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
  }

  /**
   * A new document with its first version. The project is in the scope of the caller; the contract and the package belong to the project (the database judges: 422 `DOC_LINK_MISMATCH`); a live document of the
   * same class and reference is refused (409 `DOC_DUPLICATE_REFERENCE`). The text is recorded with the version.
   */
  async create(tx: TenantTx, input: ProjectDocumentInput, file: FileFacts, extraction: ExtractionRecord, changeNote: string | null, actor: string, scope: ScopeBuilder, now: Date): Promise<{ document: DocumentHeader; version: VersionHeader }> {
    await this.assertProjectInScope(tx, input.projectId, scope);
    let documentId: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.project_document (tenant_id, project_id, contract_id, package_id, doc_class, title, reference, security_class, effective_from, effective_to, note, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, $10, $11::uuid, $11::uuid) returning id`,
        [input.projectId, input.contractId, input.packageId, input.docClass, input.title, input.reference, input.securityClass, input.effectiveFrom, input.effectiveTo, input.note, actor],
      );
      documentId = (rows[0] as { id: string }).id;
    } catch (error) {
      return refuseWrite(error);
    }
    const version = await this.insertVersion(tx, documentId, 1, file, extraction, changeNote, actor);
    await tx.query('update machvon.project_document set current_version_id = $2::uuid where id = $1::uuid', [documentId, version.id]);
    const document = await this.find(tx, documentId, scope, now);
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { document, version };
  }

  /** A new version of a document: the next number, the file, the text read from it; the document must not be archived and the file must not already be a version of it. */
  async addVersion(tx: TenantTx, documentId: string, file: FileFacts, extraction: ExtractionRecord, changeNote: string | null, actor: string, scope: ScopeBuilder, now: Date): Promise<{ document: DocumentHeader; version: VersionHeader }> {
    const locked = await this.lockDocument(tx, documentId, scope, now);
    if (locked.status === 'ARCHIVED') throw new DomainError('DOC_ARCHIVED', 409, 'document_id');
    const [numbered] = await tx.query<{ next: number }>('select coalesce(max(version_no), 0) + 1 as next from machvon.project_document_version where document_id = $1::uuid', [documentId]);
    const version = await this.insertVersion(tx, documentId, numbered?.next ?? 1, file, extraction, changeNote, actor);
    await tx.query('update machvon.project_document set current_version_id = $2::uuid, version = version + 1, updated_at = now(), updated_by = $3::uuid where id = $1::uuid', [documentId, version.id, actor]);
    const document = await this.find(tx, documentId, scope, now);
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { document, version };
  }

  private async insertVersion(tx: TenantTx, documentId: string, versionNo: number, file: FileFacts, extraction: ExtractionRecord, changeNote: string | null, actor: string): Promise<VersionHeader> {
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.project_document_version (tenant_id, document_id, version_no, file_object_key, file_sha256, size_bytes, format, mime, page_count, change_note, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid) returning id`,
        [documentId, versionNo, file.key, file.sha256, file.sizeBytes, file.format, file.mime, file.pageCount, changeNote, actor],
      );
      id = (rows[0] as { id: string }).id;
    } catch (error) {
      return refuseWrite(error);
    }
    await this.recordExtraction(tx, id, extraction);
    const rows = await tx.query<VersionSql>(`select ${VERSION_COLUMNS} from machvon.project_document_version v where v.id = $1::uuid`, [id]);
    return versionOf(rows[0] as VersionSql);
  }

  /**
   * The text of a version, kept once: the units, then the state of the reading on the version. A version whose text was read already is refused by the database; one whose reading failed or found no text may be read
   * again (for example when an OCR engine is bound).
   */
  async recordExtraction(tx: TenantTx, versionId: string, extraction: ExtractionRecord): Promise<void> {
    for (let from = 0; from < extraction.units.length; from += UNIT_BATCH) {
      const batch = extraction.units.slice(from, from + UNIT_BATCH);
      const values: string[] = [];
      const params: unknown[] = [versionId];
      for (const unit of batch) {
        const base = params.length;
        params.push(unit.seq, unit.citationId, unit.kind, unit.locatorKey, unit.label, unit.page, unit.paragraph, unit.sheet, unit.cell, unit.box === null ? null : JSON.stringify(unit.box), unit.text, unit.textSha256, unit.confidence);
        values.push(`(nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::jsonb, $${base + 11}, $${base + 12}, $${base + 13}::numeric)`);
      }
      try {
        await tx.query(
          `insert into machvon.document_text_unit (tenant_id, version_id, seq, citation_id, kind, locator_key, label, page_no, paragraph_no, sheet_name, cell_ref, box, text, text_sha256, confidence) values ${values.join(', ')}`,
          params,
        );
      } catch (error) {
        return refuseWrite(error);
      }
    }
    const status = extractionStatusOf(extraction.units.length, extraction.failed);
    await tx.query(
      `update machvon.project_document_version set extraction_status = $2, unit_count = $3, truncated_units = $4, extraction_engine = $5, extraction_engine_version = $6, extracted_at = now(), updated_at = now() where id = $1::uuid`,
      [versionId, status, extraction.units.length, extraction.truncated, extraction.engine?.name ?? null, extraction.engine?.version ?? null],
    );
  }

  /** The description of a document, corrected at the version the caller read (409 `VERSION_CONFLICT`); an archived document is restored first (409 `DOC_ARCHIVED`). */
  async update(tx: TenantTx, documentId: string, expectedVersion: number, change: ProjectDocumentChange, actor: string, scope: ScopeBuilder, now: Date): Promise<{ before: DocumentHeader; after: DocumentHeader }> {
    const before = await this.lockDocument(tx, documentId, scope, now);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status === 'ARCHIVED') throw new DomainError('DOC_ARCHIVED', 409, 'document_id');
    const sets: string[] = [];
    const params: unknown[] = [documentId];
    const set = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (change.contractId !== undefined) set('contract_id', change.contractId, '::uuid');
    if (change.packageId !== undefined) set('package_id', change.packageId, '::uuid');
    if (change.docClass !== undefined) set('doc_class', change.docClass);
    if (change.title !== undefined) set('title', change.title);
    if (change.reference !== undefined) set('reference', change.reference);
    if (change.securityClass !== undefined) set('security_class', change.securityClass);
    if (change.effectiveFrom !== undefined) set('effective_from', change.effectiveFrom, '::date');
    if (change.effectiveTo !== undefined) set('effective_to', change.effectiveTo, '::date');
    if (change.note !== undefined) set('note', change.note);
    params.push(actor);
    try {
      await tx.query(`update machvon.project_document set ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = $${params.length}::uuid where id = $1::uuid`, params);
    } catch (error) {
      return refuseWrite(error);
    }
    const after = await this.find(tx, documentId, scope, now);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  /** Archives a document with a reason (409 `DOC_REVIEW_IN_PROGRESS` while a review is open) or restores it; either way at the version the caller read. */
  async setArchived(tx: TenantTx, documentId: string, expectedVersion: number, archive: { reason: string } | null, actor: string, scope: ScopeBuilder, now: Date): Promise<{ before: DocumentHeader; after: DocumentHeader }> {
    const before = await this.lockDocument(tx, documentId, scope, now);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (archive !== null) {
      if (before.status === 'ARCHIVED') throw new DomainError('DOC_ARCHIVED', 409, 'document_id');
      if (before.latestReview?.status === 'IN_REVIEW') throw new DomainError('DOC_REVIEW_IN_PROGRESS', 409, 'document_id');
    } else if (before.status !== 'ARCHIVED') {
      throw new DomainError('DOC_NOT_ARCHIVED', 409, 'document_id');
    }
    try {
      await tx.query(
        `update machvon.project_document set status = $2, archive_reason = $3, version = version + 1, updated_at = now(), updated_by = $4::uuid where id = $1::uuid`,
        [documentId, archive === null ? 'ACTIVE' : 'ARCHIVED', archive?.reason ?? null, actor],
      );
    } catch (error) {
      return refuseWrite(error);
    }
    const after = await this.find(tx, documentId, scope, now);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  /** Reads the text of a version again: only a version whose text is not read (failed, or no text found) and that is not locked. The caller supplies the new extraction. */
  async reextract(tx: TenantTx, versionId: string, extraction: ExtractionRecord, scope: ScopeBuilder, now: Date): Promise<{ before: VersionHeader; after: VersionHeader; document: DocumentHeader }> {
    const found = await this.findVersion(tx, versionId, scope, now);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query('select id from machvon.project_document where id = $1::uuid for update', [found.document.id]);
    const [current] = await tx.query<VersionSql>(`select ${VERSION_COLUMNS} from machvon.project_document_version v where v.id = $1::uuid for update`, [versionId]);
    const before = versionOf(current as VersionSql);
    if (before.locked) throw new DomainError('DOC_VERSION_LOCKED', 409, 'version_id');
    if (before.extractionStatus === 'EXTRACTED') throw new DomainError('DOC_EXTRACTION_DONE', 409, 'version_id');
    await this.recordExtraction(tx, versionId, extraction);
    const [updated] = await tx.query<VersionSql>(`select ${VERSION_COLUMNS} from machvon.project_document_version v where v.id = $1::uuid`, [versionId]);
    return { before, after: versionOf(updated as VersionSql), document: found.document };
  }

  /** Locks the row of a document that is in the scope of the caller (404 otherwise) and returns it as it is under the lock. */
  async lockDocument(tx: TenantTx, documentId: string, scope: ScopeBuilder, now: Date): Promise<DocumentHeader> {
    const visible = await this.find(tx, documentId, scope, now);
    if (visible === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query('select id from machvon.project_document where id = $1::uuid for update', [documentId]);
    const held = await this.find(tx, documentId, scope, now);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return held;
  }

  /** A version moves along the chain of the kernel in the same transaction as the review row; an approved one is locked with the person who approved it. */
  async moveVersion(tx: TenantTx, versionId: string, from: DocumentVersionStatus, to: DocumentVersionStatus, actor: string | null): Promise<void> {
    assertVersionMove(from, to);
    const lock = to === 'APPROVED';
    const rows = await tx.query<{ id: string }>(
      `update machvon.project_document_version set status = $3, locked_at = case when $4::boolean then now() else null end, locked_by = case when $4::boolean then $5::uuid else null end, updated_at = now()
        where id = $1::uuid and status = $2 returning id`,
      [versionId, from, to, lock, actor],
    );
    if (rows[0] === undefined) throw new DomainError('DOC_VERSION_STATE_INVALID', 409, 'status', { extensions: { from, to } });
  }
}
