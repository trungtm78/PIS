import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, versionConflict } from '@machvon/kernel';
import { validateTemplateContent, templateContentSha256 } from './document-template-content.ts';
import type { TemplateContent } from './document-template-content.ts';
import { DocumentStore } from './document-store.ts';
import type { TemplateBlock, TemplateGroup } from './document-store.ts';
import type { TenantTx } from './tenant-database.ts';

const EXCLUSION_VIOLATION = '23P01';
const CODE_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('doc_template:' || current_setting('app.tenant_id') || ':' || $1::text, 0))";
const FORM_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('doc_template_form:' || current_setting('app.tenant_id') || ':' || $1::text, 0))";
const TEMPLATE_CODE = /^[A-Z0-9][A-Z0-9_.-]{2,79}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_REF = 3;
const MAX_REF = 50;
const MIN_REASON = 10;
const MAX_REASON = 2000;
const MAX_LEGAL_BASIS = 2000;
const GROUPS: readonly string[] = ['DECISION', 'OFFICIAL_LETTER', 'REPORT_DISBURSEMENT', 'REPORT_MONITORING', 'TREASURY_FORM', 'SETTLEMENT_FORM', 'AUDIT_FOLLOWUP', 'OTHER'];

export type TemplateStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'SUPERSEDED' | 'RETIRED';
export type ConfirmationStatus = 'CONFIRMED' | 'PENDING_CONFIRMATION';
export type TemplateOrigin = 'PLATFORM_PACK' | 'TENANT';

/**
 * Whether a render from this template carries the watermark (BR-DOC-10): the template or its layout profile still waits for its legal confirmation. A document
 * made from it can be issued only with the written override of a person who may confirm.
 */
export function rendersWatermarked(template: { confirmationStatus: ConfirmationStatus; layoutConfirmationStatus: ConfirmationStatus | null }): boolean {
  return template.confirmationStatus !== 'CONFIRMED' || template.layoutConfirmationStatus !== 'CONFIRMED';
}

/** One revision of a template as the library lists it (no body). */
export interface TemplateSummary {
  id: string;
  templateCode: string;
  revision: number;
  groupCode: TemplateGroup;
  docTypeCode: string;
  formCode: string | null;
  title: string;
  sourceModule: string | null;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: ConfirmationStatus;
  watermarkText: string | null;
  origin: TemplateOrigin;
  packVersion: string | null;
  layoutProfileId: string;
  /** Whether the layout profile is confirmed: a confirmed template over an unconfirmed profile still renders with the watermark. */
  layoutConfirmationStatus: ConfirmationStatus | null;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: TemplateStatus;
  version: number;
  createdBy: string;
  approvedBy: string | null;
}

/** A revision with its body and who did what (the detail of the library). */
export interface TemplateDetail extends TemplateSummary {
  bodyBlocks: TemplateBlock[];
  placeholderSchema: { required?: string[] };
  contentSha256: string;
  publishedAt: Date | null;
  legalConfirmedBy: string | null;
  legalConfirmedAt: Date | null;
  legalEvidenceDocumentId: string | null;
  legalConfirmationNote: string | null;
  retiredAt: Date | null;
  retirementReason: string | null;
}

export interface NewTemplateRevision {
  templateCode: string;
  groupCode: TemplateGroup;
  docTypeCode: string;
  formCode?: string | undefined;
  title: string;
  sourceModule?: string | undefined;
  layoutProfileId: string;
  bodyBlocks: unknown;
  placeholderSchema: unknown;
  legalBasis: string;
  /** A reference the drafter proposes; it confirms nothing until a legal officer records the confirmation. */
  legalConfirmationRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  watermarkText?: string | undefined;
  actor: string;
}

export interface TemplateFilter {
  groupCode?: string | undefined;
  status?: string | undefined;
  asOfDate?: string | undefined;
}

export interface TemplatePageRequest {
  limit: number;
  after?: { templateCode: string; revision: number } | undefined;
}

export interface LegalConfirmationInput {
  reference: string;
  evidenceDocumentId: string;
  note?: string | undefined;
}

/** The revision whose period ended on the start date of the one that took over from it. */
export interface ClosedRevision {
  id: string;
  revision: number;
  effectiveUntil: string;
}

export interface PackTemplate {
  templateCode: string;
  groupCode: TemplateGroup;
  docTypeCode: string;
  formCode?: string | undefined;
  title: string;
  sourceModule?: string | undefined;
  layoutProfileCode: string;
  bodyBlocks: unknown;
  placeholderSchema: unknown;
  legalBasis: string;
  watermarkText: string;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
}

export interface TemplatePack {
  packVersion: string;
  templates: readonly PackTemplate[];
}

export interface PackLoadResult {
  inserted: string[];
  upgraded: string[];
  unchanged: string[];
  /** TENANT_REVISION: the tenant owns a revision of the code; NOT_SUPERSEDABLE: the pack revision cannot take over from the one in force. */
  skipped: Array<{ templateCode: string; reason: 'TENANT_REVISION' | 'NOT_SUPERSEDABLE' }>;
}

interface SummaryRow {
  id: string;
  template_code: string;
  revision: number;
  group_code: TemplateGroup;
  doc_type_code: string;
  form_code: string | null;
  title: string;
  source_module: string | null;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  confirmation_status: ConfirmationStatus;
  watermark_text: string | null;
  origin: TemplateOrigin;
  pack_version: string | null;
  layout_profile_id: string;
  layout_confirmation_status: ConfirmationStatus | null;
  effective_from: string;
  effective_until: string | null;
  status: TemplateStatus;
  version: string;
  created_by: string;
  approved_by: string | null;
}

interface DetailRow extends SummaryRow {
  body_blocks: TemplateBlock[];
  placeholder_schema: { required?: string[] };
  content_sha256: string;
  published_at: Date | null;
  legal_confirmed_by: string | null;
  legal_confirmed_at: Date | null;
  legal_evidence_document_id: string | null;
  legal_confirmation_note: string | null;
  retired_at: Date | null;
  retirement_reason: string | null;
}

const SUMMARY_COLUMNS = `t.id, t.template_code, t.revision, t.group_code, t.doc_type_code, t.form_code, t.title, t.source_module, t.legal_basis,
  t.legal_confirmation_ref, t.confirmation_status, t.watermark_text, t.origin, t.pack_version, t.layout_profile_id,
  p.confirmation_status as layout_confirmation_status, t.effective_from::text as effective_from, t.effective_until::text as effective_until,
  t.status, t.version::text as version, t.created_by, t.approved_by`;
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, t.body_blocks, t.placeholder_schema, t.content_sha256, t.published_at,
  t.legal_confirmed_by, t.legal_confirmed_at, t.legal_evidence_document_id, t.legal_confirmation_note, t.retired_at, t.retirement_reason`;
const FROM = `from machvon.document_template t
  left join machvon.document_layout_profile p on p.tenant_id = t.tenant_id and p.id = t.layout_profile_id`;

function toSummary(row: SummaryRow): TemplateSummary {
  return {
    id: row.id,
    templateCode: row.template_code,
    revision: row.revision,
    groupCode: row.group_code,
    docTypeCode: row.doc_type_code,
    formCode: row.form_code,
    title: row.title,
    sourceModule: row.source_module,
    legalBasis: row.legal_basis,
    legalConfirmationRef: row.legal_confirmation_ref,
    confirmationStatus: row.confirmation_status,
    watermarkText: row.watermark_text,
    origin: row.origin,
    packVersion: row.pack_version,
    layoutProfileId: row.layout_profile_id,
    layoutConfirmationStatus: row.layout_confirmation_status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by,
    approvedBy: row.approved_by,
  };
}

function toDetail(row: DetailRow): TemplateDetail {
  return {
    ...toSummary(row),
    bodyBlocks: row.body_blocks,
    placeholderSchema: row.placeholder_schema,
    contentSha256: row.content_sha256,
    publishedAt: row.published_at,
    legalConfirmedBy: row.legal_confirmed_by,
    legalConfirmedAt: row.legal_confirmed_at,
    legalEvidenceDocumentId: row.legal_evidence_document_id,
    legalConfirmationNote: row.legal_confirmation_note,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason,
  };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (): DomainError => new DomainError('TEMPLATE_STATE_INVALID', 409, 'status');
const rangeOverlap = (): DomainError => new DomainError('TEMPLATE_RANGE_OVERLAP', 409, 'effective_from');

function assertDate(value: string, field: string): void {
  const match = DATE.exec(value);
  const date = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (match === null || date === undefined || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw invalid(field);
}

/** A text as it is stored: trimmed, within its length, without control characters. */
function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

interface Revision {
  fields: NewTemplateRevision;
  content: TemplateContent;
  contentSha256: string;
  watermarkText: string;
  status: 'DRAFT' | 'PUBLISHED';
  origin: TemplateOrigin;
  packVersion: string | null;
}

/**
 * The template library of a tenant (ST-DOC-006, DOC F12, BR-DOC-09, BR-DOC-10): revisions with an effective period, a
 * drafter, a publisher and a legal confirmer who are three different people, and the platform pack loaded with a version.
 * The legal text of a template is data on its row, never code. Rendering reads the published, confirmed or watermarked
 * rows through DocumentStore.templateFor; this store writes them. The guard trigger of V1220 keeps the content of a revision
 * and the three steps in order even against a caller that bypasses this class.
 */
export class DocumentTemplateStore {
  private readonly documents = new DocumentStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<TemplateDetail | undefined> {
    const rows = await tx.query<DetailRow>(`select ${DETAIL_COLUMNS} ${FROM} where t.id = $1::uuid${lock ? ' for update of t' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toDetail(rows[0]);
  }

  /** The revisions of the tenant by code and revision, narrowed by group, status and the date they are in force on. */
  /** How many published templates wait for the legal confirmation of their basis (the tile of the overview). */
  async countPendingConfirmation(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.document_template where status = 'PUBLISHED' and confirmation_status = 'PENDING_CONFIRMATION'");
    return Number(row?.n ?? 0);
  }

  async list(tx: TenantTx, filter: TemplateFilter, page: TemplatePageRequest): Promise<TemplateSummary[]> {
    const rows = await tx.query<SummaryRow>(
      `select ${SUMMARY_COLUMNS} ${FROM}
        where ($1::text is null or t.group_code = $1) and ($2::text is null or t.status = $2)
          and ($3::date is null or (t.effective_from <= $3::date and (t.effective_until is null or $3::date < t.effective_until)))
          and ($4::text is null or (t.template_code, t.revision) > ($4::text, $5::int))
        order by t.template_code, t.revision limit $6`,
      [filter.groupCode ?? null, filter.status ?? null, filter.asOfDate ?? null, page.after?.templateCode ?? null, page.after?.revision ?? null, page.limit],
    );
    return rows.map(toSummary);
  }

  /** Every revision of one code, oldest first: the history the detail of a template shows. */
  async revisionsOf(tx: TenantTx, templateCode: string): Promise<TemplateSummary[]> {
    const rows = await tx.query<SummaryRow>(`select ${SUMMARY_COLUMNS} ${FROM} where t.template_code = $1 order by t.revision`, [templateCode]);
    return rows.map(toSummary);
  }

  /** Drafts the next revision of a code. Nothing is published or confirmed by drafting, whatever the input says. */
  async create(tx: TenantTx, input: NewTemplateRevision): Promise<TemplateDetail> {
    const fields = this.checkedFields(input);
    const content = validateTemplateContent(input.bodyBlocks, input.placeholderSchema);
    const profile = await tx.query<{ watermark_text: string | null }>(
      "select watermark_policy->>'text' as watermark_text from machvon.document_layout_profile where id = $1::uuid and status = 'PUBLISHED'",
      [fields.layoutProfileId],
    );
    if (profile[0] === undefined) throw new DomainError('PROFILE_NOT_PUBLISHED', 422, 'layout_profile_id');
    // BR-DOC-10: a revision that waits for its legal confirmation always has a watermark; the profile names the default one.
    const watermarkText = fields.watermarkText ?? profile[0].watermark_text ?? undefined;
    if (watermarkText === undefined || watermarkText.trim() === '') throw invalid('watermark_text');
    const id = await this.insertNext(tx, {
      fields,
      content,
      contentSha256: templateContentSha256(content, fields.docTypeCode, fields.groupCode),
      watermarkText,
      status: 'DRAFT',
      origin: 'TENANT',
      packVersion: null,
    });
    const created = await this.find(tx, id);
    if (created === undefined) throw new Error('the drafted template vanished');
    return created;
  }

  /**
   * The approval of a draft by someone other than its drafter (four eyes). The period must not overlap another published
   * revision of the code: an open-ended revision that starts after an earlier one takes over from it (the earlier one ends on
   * the new start date), any other overlap is refused.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string): Promise<{ record: TemplateDetail; closed: ClosedRevision[] }> {
    const row = await this.lockedByCode(tx, id, expectedVersion);
    assertFourEyes(row.createdBy, publisher);
    if (row.status !== 'DRAFT') throw stateInvalid();
    const closed = await this.takeOver(tx, row, publisher);
    try {
      await tx.query(
        `update machvon.document_template set status = 'PUBLISHED', approved_by = $2::uuid, published_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid`,
        [id, publisher],
      );
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw rangeOverlap();
      throw error;
    }
    return { record: await this.reread(tx, id), closed };
  }

  /**
   * The legal confirmation of a published revision: a reference and the evidence document, by someone who neither drafted nor
   * published it. From then on new renders carry no watermark of the template; what was rendered before keeps its own.
   */
  async confirmLegalBasis(tx: TenantTx, id: string, expectedVersion: number, input: LegalConfirmationInput, confirmer: string): Promise<TemplateDetail> {
    const row = await this.lockedByCode(tx, id, expectedVersion);
    if (row.status !== 'PUBLISHED' || row.confirmationStatus !== 'PENDING_CONFIRMATION') throw stateInvalid();
    const reference = input.reference.trim();
    if (reference.length < MIN_REF || reference.length > MAX_REF) throw new DomainError('CONFIRMATION_REF_REQUIRED', 422, 'legal_confirmation_ref');
    assertFourEyes(row.createdBy, confirmer);
    if (row.approvedBy !== null) assertFourEyes(row.approvedBy, confirmer);
    const note = input.note === undefined || input.note.trim() === '' ? null : textOf(input.note, 'note', 1, 1000);
    const evidence = await tx.query('select 1 from machvon.document where id = $1::uuid', [input.evidenceDocumentId]);
    if (evidence.length === 0) throw invalid('evidence_document_id');
    await tx.query(
      `update machvon.document_template
          set confirmation_status = 'CONFIRMED', legal_confirmation_ref = $2, legal_confirmed_by = $3::uuid, legal_confirmed_at = now(),
              legal_evidence_document_id = $4::uuid, legal_confirmation_note = $5, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [id, reference, confirmer, input.evidenceDocumentId, note],
    );
    return this.reread(tx, id);
  }

  /** Takes a draft or published revision out of use; documents already issued keep the id of the template they were made with. */
  async retire(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string): Promise<TemplateDetail> {
    const row = await this.lockedByCode(tx, id, expectedVersion);
    if (row.status !== 'DRAFT' && row.status !== 'PUBLISHED') throw stateInvalid();
    const text = textOf(reason, 'reason', MIN_REASON, MAX_REASON);
    await tx.query(
      `update machvon.document_template
          set status = 'RETIRED', retired_at = now(), retired_by = $2::uuid, retirement_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [id, actor, text],
    );
    return this.reread(tx, id);
  }

  /**
   * Loads the platform pack into a tenant, published and waiting for its legal confirmation (the watermark is the pack's own text).
   * Loading again changes nothing; a newer pack version adds a revision that takes over from the pack revision in force; a code
   * that the tenant has revised itself is left alone.
   */
  async loadPack(tx: TenantTx, pack: TemplatePack, actor: string): Promise<PackLoadResult> {
    const result: PackLoadResult = { inserted: [], upgraded: [], unchanged: [], skipped: [] };
    for (const entry of pack.templates) {
      await tx.query(CODE_LOCK_SQL, [entry.templateCode]);
      const existing = await tx.query<{ id: string; revision: number; origin: TemplateOrigin; pack_version: string | null; status: TemplateStatus; effective_from: string; effective_until: string | null }>(
        'select id, revision, origin, pack_version, status, effective_from::text as effective_from, effective_until::text as effective_until from machvon.document_template where template_code = $1 order by revision desc',
        [entry.templateCode],
      );
      if (existing.some((row) => row.origin === 'TENANT')) {
        result.skipped.push({ templateCode: entry.templateCode, reason: 'TENANT_REVISION' });
        continue;
      }
      if (existing.some((row) => row.pack_version === pack.packVersion)) {
        result.unchanged.push(entry.templateCode);
        continue;
      }
      const current = existing.find((row) => row.status === 'PUBLISHED' && row.effective_until === null);
      if (current !== undefined && current.effective_from >= entry.effectiveFrom) {
        result.skipped.push({ templateCode: entry.templateCode, reason: 'NOT_SUPERSEDABLE' });
        continue;
      }
      const profile = await this.documents.layoutProfileByCode(tx, entry.layoutProfileCode, entry.effectiveFrom);
      const content = validateTemplateContent(entry.bodyBlocks, entry.placeholderSchema);
      const fields = this.checkedFields({
        templateCode: entry.templateCode,
        groupCode: entry.groupCode,
        docTypeCode: entry.docTypeCode,
        formCode: entry.formCode,
        title: entry.title,
        sourceModule: entry.sourceModule,
        layoutProfileId: profile.id,
        bodyBlocks: entry.bodyBlocks,
        placeholderSchema: entry.placeholderSchema,
        legalBasis: entry.legalBasis,
        effectiveFrom: entry.effectiveFrom,
        effectiveUntil: entry.effectiveUntil,
        watermarkText: entry.watermarkText,
        actor,
      });
      if (current !== undefined) {
        await tx.query(
          'update machvon.document_template set effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid',
          [current.id, entry.effectiveFrom, actor],
        );
      }
      try {
        await this.insertNext(tx, {
          fields,
          content,
          contentSha256: templateContentSha256(content, fields.docTypeCode, fields.groupCode),
          watermarkText: entry.watermarkText,
          status: 'PUBLISHED',
          origin: 'PLATFORM_PACK',
          packVersion: pack.packVersion,
        });
      } catch (error) {
        if ((error as { code?: string }).code === EXCLUSION_VIOLATION) {
          // The period collides with a revision that is not open-ended: the pack cannot take over from it.
          throw rangeOverlap();
        }
        throw error;
      }
      (existing.length === 0 ? result.inserted : result.upgraded).push(entry.templateCode);
    }
    return result;
  }

  private checkedFields(input: NewTemplateRevision): NewTemplateRevision {
    if (!TEMPLATE_CODE.test(input.templateCode)) throw invalid('template_code');
    if (!GROUPS.includes(input.groupCode)) throw invalid('group_code');
    assertDate(input.effectiveFrom, 'effective_from');
    if (input.effectiveUntil !== undefined) {
      assertDate(input.effectiveUntil, 'effective_until');
      if (input.effectiveUntil <= input.effectiveFrom) throw invalid('effective_until');
    }
    const legalBasis = input.legalBasis.trim();
    if (legalBasis === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis');
    if (legalBasis.length > MAX_LEGAL_BASIS) throw invalid('legal_basis');
    const reference = input.legalConfirmationRef === undefined || input.legalConfirmationRef.trim() === '' ? undefined : textOf(input.legalConfirmationRef, 'legal_confirmation_ref', 1, MAX_REF);
    return {
      ...input,
      title: textOf(input.title, 'title', 3, 300),
      docTypeCode: textOf(input.docTypeCode, 'doc_type_code', 1, 20),
      formCode: input.formCode === undefined ? undefined : textOf(input.formCode, 'form_code', 1, 40),
      sourceModule: input.sourceModule === undefined ? undefined : textOf(input.sourceModule, 'source_module', 2, 10),
      legalBasis,
      legalConfirmationRef: reference,
      watermarkText: input.watermarkText === undefined ? undefined : textOf(input.watermarkText, 'watermark_text', 3, 120),
    };
  }

  /** Writes the next revision of the code under the locks of the code and of its form code, and returns its id. */
  private async insertNext(tx: TenantTx, revision: Revision): Promise<string> {
    const { fields } = revision;
    await tx.query(CODE_LOCK_SQL, [fields.templateCode]);
    if (fields.formCode !== undefined) {
      await tx.query(FORM_LOCK_SQL, [fields.formCode]);
      const taken = await tx.query('select 1 from machvon.document_template where form_code = $1 and template_code <> $2 limit 1', [fields.formCode, fields.templateCode]);
      if (taken.length > 0) throw new DomainError('FORM_CODE_DUPLICATE', 409, 'form_code');
    }
    const last = await tx.query<{ revision: number }>('select max(revision) as revision from machvon.document_template where template_code = $1', [fields.templateCode]);
    const next = (last[0]?.revision ?? 0) + 1;
    const id = randomUUID();
    const published = revision.status === 'PUBLISHED';
    await tx.query(
      `insert into machvon.document_template
         (tenant_id, id, template_code, revision, group_code, doc_type_code, form_code, title, source_module, layout_profile_id, body_blocks,
          placeholder_schema, legal_basis, legal_confirmation_ref, confirmation_status, watermark_text, origin, pack_version, content_sha256,
          effective_from, effective_until, status, published_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::jsonb, $11::jsonb,
          $12, $13, 'PENDING_CONFIRMATION', $14, $15, $16, $17, $18::date, $19::date, $20, case when $21 then now() end, $22::uuid, $22::uuid)`,
      [
        id,
        fields.templateCode,
        next,
        fields.groupCode,
        fields.docTypeCode,
        fields.formCode ?? null,
        fields.title,
        fields.sourceModule ?? null,
        fields.layoutProfileId,
        JSON.stringify(revision.content.blocks),
        JSON.stringify(revision.content.placeholderSchema),
        fields.legalBasis,
        fields.legalConfirmationRef ?? null,
        revision.watermarkText,
        revision.origin,
        revision.packVersion,
        revision.contentSha256,
        fields.effectiveFrom,
        fields.effectiveUntil ?? null,
        revision.status,
        published,
        fields.actor,
      ],
    );
    return id;
  }

  /** Reads the revision under the lock of its code, then locks its row: commands on one code take turns. */
  private async lockedByCode(tx: TenantTx, id: string, expectedVersion: number): Promise<TemplateDetail> {
    const head = await this.find(tx, id);
    if (head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query(CODE_LOCK_SQL, [head.templateCode]);
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async reread(tx: TenantTx, id: string): Promise<TemplateDetail> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the template vanished after its update');
    return row;
  }

  /** The overlap rule of publishing: see `publish`. Returns the revisions that ended on the start date of the new one. */
  private async takeOver(tx: TenantTx, row: TemplateDetail, actor: string): Promise<ClosedRevision[]> {
    const overlapping = await tx.query<{ id: string; revision: number; effective_from: string }>(
      `select id, revision, effective_from::text as effective_from from machvon.document_template
        where template_code = $1 and status = 'PUBLISHED' and id <> $2::uuid
          and daterange(effective_from, effective_until, '[)') && daterange($3::date, $4::date, '[)')
        order by effective_from for update`,
      [row.templateCode, row.id, row.effectiveFrom, row.effectiveUntil],
    );
    // Only an open-ended revision takes over from an earlier one; a closed period may not overlap anything.
    if (overlapping.some((earlier) => earlier.effective_from >= row.effectiveFrom) || (row.effectiveUntil !== null && overlapping.length > 0)) throw rangeOverlap();
    const closed: ClosedRevision[] = [];
    for (const earlier of overlapping) {
      await tx.query(
        'update machvon.document_template set effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid',
        [earlier.id, row.effectiveFrom, actor],
      );
      closed.push({ id: earlier.id, revision: earlier.revision, effectiveUntil: row.effectiveFrom });
    }
    return closed;
  }
}
