import { DomainError, ND30_A4_STANDARD, canonicalJson, layoutProfileOf, sha256Hex, validateSymbolPattern } from '@machvon/kernel';
import type { LayoutProfile } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { EffectiveAccess } from '@machvon/kernel';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';
export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';
export type VersionStage =
  | 'SOURCE_UPLOAD'
  | 'RENDERED_FINAL'
  | 'LEADER_SIGNED'
  | 'NUMBERED'
  | 'ORG_SEALED'
  | 'ISSUED_LTV'
  | 'RECEIVED_SCAN'
  | 'ATTACHMENT'
  | 'CORRECTED_COPY';
export type DocumentKind = 'OUTGOING' | 'INCOMING' | 'REFERENCE' | 'ATTACHMENT';

/** The first day the layout of Decree 30/2020 applies; the seeded profile and template take effect from it. */
const ND30_EFFECTIVE_FROM = '2020-03-05';
const DEFAULT_TEMPLATE_CODE = 'QD-DEFAULT';

export interface LayoutProfileRecord {
  id: string;
  profile: LayoutProfile;
}

export type TemplateGroup = 'DECISION' | 'OFFICIAL_LETTER' | 'REPORT_DISBURSEMENT' | 'REPORT_MONITORING' | 'TREASURY_FORM' | 'SETTLEMENT_FORM' | 'AUDIT_FOLLOWUP' | 'OTHER';

/** A `{{name}}` placeholder is replaced by the payload member of that name when the template is rendered. */
export interface TemplateBlock {
  kind: 'heading' | 'paragraph';
  text: string;
}

export interface TemplateRecord {
  id: string;
  templateCode: string;
  revision: number;
  groupCode: TemplateGroup;
  docTypeCode: string;
  formCode: string | null;
  title: string;
  layoutProfileId: string;
  bodyBlocks: TemplateBlock[];
  placeholderSchema: { required?: string[] };
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  watermarkText: string | null;
  contentSha256: string;
}

const DOC_TYPE_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('doc_type:' || current_setting('app.tenant_id') || ':' || $1::text, 0))";

export type SymbolKind = 'DECISION' | 'NAMED_TYPE' | 'OFFICIAL_LETTER';

export interface NewDocType {
  code: string;
  name: string;
  abbreviation?: string | undefined;
  symbolKind: SymbolKind;
  symbolPattern: string;
  registerCode: string;
  legalBasis: string;
  legalConfirmationRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  actor: string;
}

export interface DocTypeRecord {
  id: string;
  code: string;
  name: string;
  abbreviation: string | null;
  symbolKind: SymbolKind;
  symbolPattern: string;
  registerCode: string;
  legalBasis: string;
  legalConfirmationRef: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  version: number;
}

export interface NewDocument {
  docKind: DocumentKind;
  docTypeCode: string;
  title: string;
  classification: Classification;
  createdBy: string;
  issuerUnitId?: string | undefined;
  /** The object of another module that the document is about (`PRJ` and the id of a project, for example); both or neither. */
  subjectModule?: string | undefined;
  subjectId?: string | undefined;
}

export interface NewDocumentVersion {
  documentId: string;
  objectKey: string;
  checksum: string;
  mime: string;
  pageCount: number;
  classification: Classification;
  stage: VersionStage;
  byteLength: number;
  rendererVersion?: string | undefined;
  templateId?: string | undefined;
  /** SHA-256 of the bytes of the revisions before this one: kept by the numbering revision (BR-DOC-14 c). */
  prefixSha256?: string | undefined;
  pdfRevisionCount?: number | undefined;
  createdBy: string;
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  version: number;
  objectKey: string;
  checksum: string;
  mime: string;
  pageCount: number;
  classification: Classification;
  scanStatus: ScanStatus;
  stage: VersionStage;
  byteLength: number | null;
  rendererVersion: string | null;
  templateId: string | null;
  createdAt: Date;
  /** Microsecond-precise text form of `createdAt`: the ordering key of the keyset cursor. */
  sortKey: string;
}

export interface VersionPageAnchor {
  sortKey: string;
  id: string;
}

export interface VersionPage {
  limit: number;
  after?: VersionPageAnchor | undefined;
}

interface ProfileRow {
  id: string;
  profile_code: string;
  revision: number;
  page_size: string;
  margins_mm: unknown;
  font_family: string;
  font_substitute: string | null;
  element_styles: unknown;
  signature_layout: unknown;
  number_field_layout: unknown;
  watermark_policy: unknown;
  confirmation_status: string;
}

interface TemplateRow {
  id: string;
  template_code: string;
  revision: number;
  group_code: TemplateGroup;
  doc_type_code: string;
  form_code: string | null;
  title: string;
  layout_profile_id: string;
  body_blocks: TemplateBlock[];
  placeholder_schema: { required?: string[] };
  confirmation_status: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  watermark_text: string | null;
  content_sha256: string;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  object_key: string;
  checksum: string;
  mime: string;
  page_count: number;
  classification: Classification;
  scan_status: ScanStatus;
  stage: VersionStage;
  byte_length: string | null;
  renderer_version: string | null;
  template_id: string | null;
  created_at: Date;
  sort_key: string;
}

interface DocTypeRow {
  id: string;
  code: string;
  name: string;
  abbreviation: string | null;
  symbol_kind: SymbolKind;
  symbol_pattern: string;
  register_code: string;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  effective_from: string;
  effective_until: string | null;
  status: DocTypeRecord['status'];
  version: string;
}

const DOC_TYPE_COLUMNS = `id, code, name, abbreviation, symbol_kind, symbol_pattern, register_code, legal_basis, legal_confirmation_ref,
  effective_from::text as effective_from, effective_until::text as effective_until, status, version::text as version`;

function toDocType(row: DocTypeRow): DocTypeRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    abbreviation: row.abbreviation,
    symbolKind: row.symbol_kind,
    symbolPattern: row.symbol_pattern,
    registerCode: row.register_code,
    legalBasis: row.legal_basis,
    legalConfirmationRef: row.legal_confirmation_ref,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    version: Number(row.version),
  };
}

const PROFILE_COLUMNS = `id, profile_code, revision, page_size, margins_mm, font_family, font_substitute, element_styles,
  signature_layout, number_field_layout, watermark_policy, confirmation_status`;
const TEMPLATE_COLUMNS = `id, template_code, revision, group_code, doc_type_code, form_code, title, layout_profile_id, body_blocks,
  placeholder_schema, confirmation_status, watermark_text, content_sha256`;
const VERSION_COLUMNS = `v.id, v.document_id, v.version, v.object_key, v.checksum, v.mime, v.page_count, v.classification, v.scan_status, v.stage,
  v.byte_length::text as byte_length, v.renderer_version, v.template_id, v.created_at, ${timestampKey('v.created_at')} as sort_key`;
// The owner unit of a version is the issuer unit of its document: scope predicates read `ou.path` and `ou.id`.
const VERSION_FROM = `from machvon.document_version v
  join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id
  left join machvon.organization_unit ou on ou.tenant_id = d.tenant_id and ou.id = d.issuer_unit_id
  left join machvon.incoming_document inc on inc.tenant_id = d.tenant_id and inc.document_id = d.id
  left join machvon.document_number_register ir on ir.tenant_id = inc.tenant_id and ir.id = inc.register_id
  left join machvon.organization_unit hu on hu.tenant_id = ir.tenant_id and hu.id = ir.organization_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = inc.tenant_id and iu.id = inc.assigned_unit_id`;

/**
 * The subject of the files of a sealed proposal (ST-BID-004): they are confidential until the bids are opened and then for the evaluators who declared, so the reads of this module,
 * whose scope is a unit, never serve them; the proposal serves them to the people it names.
 */
export const SEALED_SUBJECT_MODULE = 'BID_PROPOSAL';

const NOT_SEALED = `d.subject_module is distinct from '${SEALED_SUBJECT_MODULE}'`;

/** The columns of the owner unit a scope predicate for versions is compiled against. */
export const VERSION_SCOPE_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;

/**
 * The scope of the reads of versions: the unit that issues the document or, for an incoming letter (which has no issuer), the unit of its register, the unit it was given to, and whoever took it in
 * (ST-DOC-011): the people who work a letter can read its file.
 */
export function versionScope(access: EffectiveAccess, permission: string, now: Date, membershipId: string): ScopeBuilder {
  return (first) => {
    const issuer = scopePredicate(access, permission, now, VERSION_SCOPE_COLUMNS, first);
    // The permission is not held anywhere, or held over the whole tenant: nothing to add.
    if (issuer.sql === 'false' || issuer.sql === 'true') return issuer;
    const home = scopePredicate(access, permission, now, { unitPath: 'hu.path', unitId: 'hu.id' }, first + issuer.params.length);
    const given = scopePredicate(access, permission, now, { unitPath: 'iu.path', unitId: 'iu.id' }, first + issuer.params.length + home.params.length);
    const receiver = `$${first + issuer.params.length + home.params.length + given.params.length}::uuid`;
    return { sql: `(${issuer.sql} or (inc.id is not null and (${home.sql} or ${given.sql} or inc.received_by = ${receiver})))`, params: [...issuer.params, ...home.params, ...given.params, membershipId] };
  };
}

function toProfile(row: ProfileRow): LayoutProfileRecord {
  return {
    id: row.id,
    profile: layoutProfileOf({
      profile_code: row.profile_code,
      revision: row.revision,
      page_size: row.page_size,
      margins_mm: row.margins_mm,
      font_family: row.font_family,
      font_substitute: row.font_substitute,
      element_styles: row.element_styles,
      signature_layout: row.signature_layout,
      number_field_layout: row.number_field_layout,
      watermark_policy: row.watermark_policy,
      confirmation_status: row.confirmation_status,
    }),
  };
}

function toTemplate(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    templateCode: row.template_code,
    revision: row.revision,
    groupCode: row.group_code,
    docTypeCode: row.doc_type_code,
    formCode: row.form_code,
    title: row.title,
    layoutProfileId: row.layout_profile_id,
    bodyBlocks: row.body_blocks,
    placeholderSchema: row.placeholder_schema,
    confirmationStatus: row.confirmation_status,
    watermarkText: row.watermark_text,
    contentSha256: row.content_sha256,
  };
}

function toVersion(row: VersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    objectKey: row.object_key,
    checksum: row.checksum,
    mime: row.mime,
    pageCount: row.page_count,
    classification: row.classification,
    scanStatus: row.scan_status,
    stage: row.stage,
    byteLength: row.byte_length === null ? null : Number(row.byte_length),
    rendererVersion: row.renderer_version,
    templateId: row.template_id,
    createdAt: row.created_at,
    sortKey: row.sort_key,
  };
}

function defaultTemplateBlocks(): TemplateBlock[] {
  return [
    { kind: 'heading', text: '{{title}}' },
    { kind: 'paragraph', text: '{{body}}' },
  ];
}

/**
 * The document anchor, its file versions and the rendering inputs (layout profiles and templates), BR-DOC-09,
 * BR-DOC-13, BR-DOC-16. Every query runs inside the caller's tenant transaction, so row-level security keeps tenants
 * apart; a stored version cannot be edited by the application role (trigger of V015).
 */
export class DocumentStore {
  /**
   * Gives a tenant the layout profile `ND30_A4_STANDARD` r1 (waiting for legal confirmation, so every render carries the
   * watermark of BR-DOC-10) and a generic decision template that uses it. Calling it again changes nothing.
   */
  async seedDefaults(tx: TenantTx, actor: string): Promise<{ layoutProfileId: string; templateId: string }> {
    const profile = ND30_A4_STANDARD;
    const profileRows = await tx.query<{ id: string }>(
      `insert into machvon.document_layout_profile
         (tenant_id, id, profile_code, revision, page_size, margins_mm, font_family, font_substitute, element_styles, signature_layout,
          number_field_layout, watermark_policy, legal_basis, confirmation_status, effective_from, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb,
          $9::jsonb, $10::jsonb, 'Nghi dinh 30/2020/ND-CP Phu luc I', 'PENDING_CONFIRMATION', $11::date, 'PUBLISHED', $12, $12)
       on conflict (tenant_id, profile_code, revision) do nothing
       returning id`,
      [
        profile.code,
        profile.revision,
        profile.pageSize,
        JSON.stringify(profile.marginsMm),
        profile.fontFamily,
        profile.fontSubstitute ?? null,
        JSON.stringify(profile.elementStyles),
        JSON.stringify(profile.signatureLayout),
        JSON.stringify(profile.numberFieldLayout),
        JSON.stringify(profile.watermarkPolicy),
        ND30_EFFECTIVE_FROM,
        actor,
      ],
    );
    const layoutProfileId =
      profileRows[0]?.id ??
      (await tx.query<{ id: string }>('select id from machvon.document_layout_profile where profile_code = $1 and revision = $2', [profile.code, profile.revision]))[0]?.id;
    if (layoutProfileId === undefined) throw new Error('the default layout profile vanished after a conflict');
    const blocks = defaultTemplateBlocks();
    const placeholderSchema = { required: ['title', 'body'] };
    const contentSha256 = sha256Hex(canonicalJson({ blocks, placeholderSchema, docTypeCode: 'QD', groupCode: 'DECISION' }));
    const templateRows = await tx.query<{ id: string }>(
      `insert into machvon.document_template
         (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema,
          legal_basis, confirmation_status, watermark_text, origin, content_sha256, effective_from, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, 1, 'DECISION', 'QD', 'Decision', $2, $3::jsonb, $4::jsonb,
          'Nghi dinh 30/2020/ND-CP', 'PENDING_CONFIRMATION', $5, 'PLATFORM_PACK', $6, $7::date, 'PUBLISHED', $8, $8)
       on conflict (tenant_id, template_code, revision) do nothing
       returning id`,
      [DEFAULT_TEMPLATE_CODE, layoutProfileId, JSON.stringify(blocks), JSON.stringify(placeholderSchema), profile.watermarkPolicy.text, contentSha256, ND30_EFFECTIVE_FROM, actor],
    );
    const templateId =
      templateRows[0]?.id ??
      (await tx.query<{ id: string }>('select id from machvon.document_template where template_code = $1 and revision = 1', [DEFAULT_TEMPLATE_CODE]))[0]?.id;
    if (templateId === undefined) throw new Error('the default template vanished after a conflict');
    return { layoutProfileId, templateId };
  }

  /** The published revision of a profile that is in force on a date (the newest when two overlap). */
  async layoutProfileByCode(tx: TenantTx, code: string, asOfDate: string): Promise<LayoutProfileRecord> {
    const [row] = await tx.query<ProfileRow>(
      `select ${PROFILE_COLUMNS} from machvon.document_layout_profile
        where profile_code = $1 and status = 'PUBLISHED' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)
        order by revision desc limit 1`,
      [code, asOfDate],
    );
    if (row === undefined) throw new DomainError('PROFILE_NOT_PUBLISHED', 422, 'layout_profile_code');
    return toProfile(row);
  }

  /** A published profile by id; with an as-of date it must also be in force on that date, like a profile chosen by code. */
  async layoutProfileById(tx: TenantTx, id: string, asOfDate?: string): Promise<LayoutProfileRecord> {
    const [row] = await tx.query<ProfileRow>(
      `select ${PROFILE_COLUMNS} from machvon.document_layout_profile
        where id = $1::uuid and status = 'PUBLISHED'
          and ($2::date is null or (effective_from <= $2::date and (effective_until is null or $2::date < effective_until)))`,
      [id, asOfDate ?? null],
    );
    if (row !== undefined) return toProfile(row);
    // A template points at the revision of the profile it was drawn on; when a later revision has taken over from it, the render of a date from then on is made on the revision in force that day.
    // Only a successor takes over: a date before the revision the template stands on starts is not served by an earlier revision.
    const [pinned] =
      asOfDate === undefined
        ? []
        : await tx.query<{ profile_code: string }>("select profile_code from machvon.document_layout_profile where id = $1::uuid and status in ('PUBLISHED', 'SUPERSEDED') and effective_from <= $2::date", [id, asOfDate]);
    if (pinned === undefined) throw new DomainError('PROFILE_NOT_PUBLISHED', 422, 'layout_profile_id');
    return this.layoutProfileByCode(tx, pinned.profile_code, asOfDate as string);
  }

  /**
   * BR-DOC-09: the published template revision, by template code or form code, whose period contains the as-of date
   * (`effective_until` is exclusive, like the exclusion constraint that keeps published periods apart).
   */
  async templateFor(tx: TenantTx, selector: { templateCode?: string | undefined; formCode?: string | undefined }, asOfDate: string): Promise<TemplateRecord> {
    if (selector.templateCode === undefined && selector.formCode === undefined) throw new DomainError('TEMPLATE_NOT_EFFECTIVE', 422, 'template_code');
    const [row] = await tx.query<TemplateRow>(
      `select ${TEMPLATE_COLUMNS} from machvon.document_template
        where status = 'PUBLISHED' and effective_from <= $3::date and (effective_until is null or $3::date < effective_until)
          and ($1::text is null or template_code = $1) and ($2::text is null or form_code = $2)
        order by revision desc limit 1`,
      [selector.templateCode ?? null, selector.formCode ?? null, asOfDate],
    );
    if (row === undefined) throw new DomainError('TEMPLATE_NOT_EFFECTIVE', 422, selector.templateCode === undefined ? 'form_code' : 'template_code');
    return toTemplate(row);
  }

  /** A published template revision by id that is in force on the date, or undefined: the template a draft was pinned to (BR-DOC-09). */
  async templateInForce(tx: TenantTx, id: string, asOfDate: string): Promise<TemplateRecord | undefined> {
    const [row] = await tx.query<TemplateRow>(
      `select ${TEMPLATE_COLUMNS} from machvon.document_template
        where id = $1::uuid and status = 'PUBLISHED' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)`,
      [id, asOfDate],
    );
    return row === undefined ? undefined : toTemplate(row);
  }

  /**
   * The template a draft of a document type starts from when the drafter names none: the published revision in force on the date whose
   * code is `<TYPE>-DEFAULT`, else the first by code. Undefined when the type has no template in force.
   */
  async templateForDocType(tx: TenantTx, docTypeCode: string, asOfDate: string): Promise<TemplateRecord | undefined> {
    const [row] = await tx.query<TemplateRow>(
      `select ${TEMPLATE_COLUMNS} from machvon.document_template
        where doc_type_code = $1 and status = 'PUBLISHED' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)
        order by (template_code = $1 || '-DEFAULT') desc, template_code, revision desc limit 1`,
      [docTypeCode, asOfDate],
    );
    return row === undefined ? undefined : toTemplate(row);
  }

  /** Whether any revision of the template code exists, in force or not: tells a missing template from one that is not in force. */
  async templateCodeExists(tx: TenantTx, templateCode: string): Promise<boolean> {
    const [row] = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.document_template where template_code = $1) as found', [templateCode]);
    return row?.found === true;
  }

  /**
   * BR-DOC-05: defines a document type with the symbol pattern of its register. An open-ended revision that starts after an
   * earlier one closes it on its own start date; any other overlap of two periods of the same code is refused.
   */
  async defineDocType(tx: TenantTx, input: NewDocType): Promise<DocTypeRecord> {
    validateSymbolPattern(input.symbolPattern);
    if (input.effectiveUntil !== undefined && input.effectiveUntil <= input.effectiveFrom) throw new DomainError('VALIDATION_FAILED', 422, 'effective_until');
    // A code that has no row yet leaves nothing for FOR UPDATE to lock: definitions of one code of one tenant take turns.
    await tx.query(DOC_TYPE_LOCK_SQL, [input.code]);
    const overlapping = await tx.query<{ id: string; effective_from: string }>(
      `select id, effective_from::text as effective_from from machvon.doc_type
        where code = $1 and effective_from < coalesce($3::date, 'infinity'::date) and coalesce(effective_until, 'infinity'::date) > $2::date
        order by effective_from for update`,
      [input.code, input.effectiveFrom, input.effectiveUntil ?? null],
    );
    // Only an open-ended revision takes over from an earlier one; a closed period may not overlap anything.
    if (overlapping.some((row) => row.effective_from >= input.effectiveFrom) || (input.effectiveUntil !== undefined && overlapping.length > 0)) throw new DomainError('DOC_TYPE_RANGE_OVERLAP', 409, 'effective_from');
    for (const earlier of overlapping) {
      await tx.query('update machvon.doc_type set effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [
        earlier.id,
        input.effectiveFrom,
        input.actor,
      ]);
    }
    const [row] = await tx.query<DocTypeRow>(
      `insert into machvon.doc_type
         (tenant_id, id, code, name, abbreviation, symbol_kind, symbol_pattern, register_code, legal_basis, legal_confirmation_ref,
          effective_from, effective_until, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date,
          'PUBLISHED', $11::uuid, $11::uuid)
       returning ${DOC_TYPE_COLUMNS}`,
      [
        input.code,
        input.name,
        input.abbreviation ?? null,
        input.symbolKind,
        input.symbolPattern,
        input.registerCode,
        input.legalBasis,
        input.legalConfirmationRef ?? null,
        input.effectiveFrom,
        input.effectiveUntil ?? null,
        input.actor,
      ],
    );
    if (row === undefined) throw new Error('document type insert returned no row');
    return toDocType(row);
  }

  async listDocTypes(tx: TenantTx): Promise<DocTypeRecord[]> {
    const rows = await tx.query<DocTypeRow>(`select ${DOC_TYPE_COLUMNS} from machvon.doc_type order by code, effective_from`);
    return rows.map(toDocType);
  }

  /** The revision of a document type that is in force on a date, or undefined. */
  async docTypeFor(tx: TenantTx, code: string, asOfDate: string): Promise<DocTypeRecord | undefined> {
    const [row] = await tx.query<DocTypeRow>(
      `select ${DOC_TYPE_COLUMNS} from machvon.doc_type
        where code = $1 and status = 'PUBLISHED' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)
        order by effective_from desc limit 1`,
      [code, asOfDate],
    );
    return row === undefined ? undefined : toDocType(row);
  }

  async insertDocument(tx: TenantTx, input: NewDocument): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, issuer_unit_id, subject_module, subject_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, $7, $8::uuid, $6, $6)
       returning id`,
      [input.docKind, input.docTypeCode, input.title, input.classification, input.issuerUnitId ?? null, input.createdBy, input.subjectModule ?? null, input.subjectId ?? null],
    );
    if (row === undefined) throw new Error('document insert returned no row');
    return row;
  }

  /** Writes the next version of a document and points the document at it; the stored row never changes afterwards. */
  async appendVersion(tx: TenantTx, input: NewDocumentVersion): Promise<DocumentVersionRecord> {
    const [locked] = await tx.query<{ id: string }>('select id from machvon.document where id = $1::uuid for update', [input.documentId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [row] = await tx.query<VersionRow>(
      `insert into machvon.document_version as v
         (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage,
          byte_length, renderer_version, template_id, prefix_sha256, pdf_revision_count, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid,
          (select coalesce(max(version), 0) + 1 from machvon.document_version where document_id = $1::uuid),
          $2, $3, $4, $5, $6, 'PENDING', '{}'::jsonb, $7, $8, $9, $10::uuid, $11, $12, $13::uuid)
       returning ${VERSION_COLUMNS}`,
      [
        input.documentId,
        input.objectKey,
        input.checksum,
        input.mime,
        input.pageCount,
        input.classification,
        input.stage,
        input.byteLength,
        input.rendererVersion ?? null,
        input.templateId ?? null,
        input.prefixSha256 ?? null,
        input.pdfRevisionCount ?? null,
        input.createdBy,
      ],
    );
    if (row === undefined) throw new Error('version insert returned no row');
    await tx.query('update machvon.document set current_version_id = $2::uuid, updated_at = now(), version = version + 1 where id = $1::uuid', [input.documentId, row.id]);
    return toVersion(row);
  }

  /** One version; `scope` (compiled over `VERSION_SCOPE_COLUMNS`) narrows it to what the caller may see. */
  async findVersion(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<DocumentVersionRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<VersionRow>(`select ${VERSION_COLUMNS} ${VERSION_FROM} where v.id = $1::uuid and ${NOT_SEALED} and ${predicate?.sql ?? 'true'}`, [id, ...(predicate?.params ?? [])]);
    return row === undefined ? undefined : toVersion(row);
  }

  /** Versions newest first, in keyset pages of the microsecond creation time and the id. */
  async listVersions(tx: TenantTx, page: VersionPage, scope?: ScopeBuilder): Promise<DocumentVersionRecord[]> {
    assertTimestampCursor(page.after?.sortKey);
    const predicate = scope?.(4);
    const rows = await tx.query<VersionRow>(
      `select ${VERSION_COLUMNS} ${VERSION_FROM}
        where ($1::text is null or (v.created_at, v.id) < ($1::timestamptz, $2::uuid)) and ${NOT_SEALED} and ${predicate?.sql ?? 'true'}
        order by v.created_at desc, v.id desc limit $3`,
      [page.after?.sortKey ?? null, page.after?.id ?? null, page.limit, ...(predicate?.params ?? [])],
    );
    return rows.map(toVersion);
  }

  /** The version of a document stored under the key, or undefined: a file written again with the same bytes is the same version. */
  async versionByKey(tx: TenantTx, documentId: string, objectKey: string): Promise<DocumentVersionRecord | undefined> {
    const [row] = await tx.query<VersionRow>(`select ${VERSION_COLUMNS} ${VERSION_FROM} where v.document_id = $1::uuid and v.object_key = $2`, [documentId, objectKey]);
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * Whether a sealed file with these bytes already stands for a document of the tenant that was not cancelled: one signed file is one document with one
   * number. The check is serialised on the hash for the rest of the transaction, so two clerks entering the same file under two numbers at once cannot
   * both pass it.
   */
  async sealedFileRegistered(tx: TenantTx, checksum: string): Promise<boolean> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('sealed-file:' || $1, 0))", [checksum]);
    const [row] = await tx.query<{ found: boolean }>(
      `select exists (
         select 1 from machvon.document_version v join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id
          where v.checksum = $1 and v.stage = 'ORG_SEALED' and d.effect_status <> 'EXPIRED') as found`,
      [checksum],
    );
    return row?.found === true;
  }

  /** Makes a version of the document its current one (after the final PDF was taken back and is approved again as the same file). */
  async pointAt(tx: TenantTx, documentId: string, versionId: string, actor: string): Promise<void> {
    await tx.query(
      `update machvon.document set current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid and exists (select 1 from machvon.document_version where id = $2::uuid and document_id = $1::uuid)`,
      [documentId, versionId, actor],
    );
  }

  /** Records the result of the malware scan, once: only a version still PENDING takes a result (V015 enforces it too). */
  async setScanResult(tx: TenantTx, id: string, result: 'CLEAN' | 'INFECTED'): Promise<DocumentVersionRecord> {
    const [row] = await tx.query<VersionRow>(
      `update machvon.document_version as v set scan_status = $2 where v.id = $1::uuid and v.scan_status = 'PENDING' returning ${VERSION_COLUMNS}`,
      [id, result],
    );
    if (row !== undefined) return toVersion(row);
    if ((await this.findVersion(tx, id)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'scan_status');
  }
}
