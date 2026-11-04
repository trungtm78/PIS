import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, isIsoDate, parseReportSchema, versionConflict, hasControlChar } from '@machvon/kernel';
import { DocumentStore } from './document-store.ts';
import { MneRevisionTable } from './mne-revision-table.ts';
import type { ClosedRevision } from './mne-revision-table.ts';
import type { TenantTx } from './tenant-database.ts';

export const MNE_REPORT_KINDS = ['OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL', 'PROJECT_START', 'PROJECT_ADJUST', 'PROJECT_COMPLETION', 'PROJECT_PERIODIC', 'EVALUATION', 'WEEKLY_QUICK'] as const;
export type MneReportKind = (typeof MNE_REPORT_KINDS)[number];
export const MNE_EXPORT_FORMATS = ['XLSX', 'PDF', 'XML', 'CSV'] as const;
export type MneExportFormat = (typeof MNE_EXPORT_FORMATS)[number];
export type MneRevisionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type MneOrigin = 'PLATFORM_PACK' | 'TENANT';

const FORM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const MAX_TITLE = 500;
const MIN_TITLE = 3;
const MAX_LEGAL_BASIS = 2000;
const MIN_LEGAL_BASIS = 3;
const MAX_REFERENCE = 50;
const MAX_TEMPLATE_CODE = 80;
const MAX_WATERMARK = 120;

/** One revision of a report form as the catalogue lists it. */
export interface MneFormRow {
  id: string;
  formCode: string;
  revision: number;
  title: string;
  reportKind: MneReportKind;
  legalBasis: string;
  /** The reference of the confirmation of the legal basis; null while the revision is a working assumption that waits for it. */
  legalConfirmationRef: string | null;
  /** Exported files carry this text while the revision waits for its confirmation (BR-MNE-01). */
  watermarkText: string | null;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  docTemplateCode: string;
  /** The published DOC template of that code in force on the first day of the revision; null when none is (it may have been retired since). */
  docTemplateId: string | null;
  exportFormats: MneExportFormat[];
  schemaJson: Record<string, unknown>;
  status: MneRevisionStatus;
  origin: MneOrigin;
  packVersion: string | null;
  version: number;
  createdBy: string;
  approvedBy: string | null;
}

export interface MneFormInput {
  formCode: string;
  title: string;
  reportKind: string;
  legalBasis: string;
  legalConfirmationRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  schemaJson: unknown;
  docTemplateCode: string;
  exportFormats: readonly string[];
  watermarkText?: string | undefined;
}

export interface MneFormFilter {
  /** The forms in force on this date (the revisions of any status but DRAFT whose period contains it). */
  effectiveOn?: string | undefined;
  reportKind?: string | undefined;
}

export interface MneFormPage {
  limit: number;
  after?: { formCode: string; revision: number } | undefined;
}

/** A form of the platform pack: the legal text is data of the pack file, never of this class. */
export interface MneFormPackEntry extends MneFormInput {
  watermarkText: string;
}

export interface MneFormPackResult {
  inserted: string[];
  upgraded: string[];
  unchanged: string[];
  /** TENANT_REVISION: the tenant revised the code itself; NOT_SUPERSEDABLE: the pack cannot take over from the revision in force; DOC_TEMPLATE_MISSING: DOC has no template of that code. */
  skipped: Array<{ formCode: string; reason: 'TENANT_REVISION' | 'NOT_SUPERSEDABLE' | 'DOC_TEMPLATE_MISSING' }>;
}

interface Sql {
  id: string;
  form_code: string;
  revision: number;
  title: string;
  report_kind: MneReportKind;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  watermark_text: string | null;
  effective_from: string;
  effective_until: string | null;
  doc_template_code: string;
  doc_template_id: string | null;
  export_formats: MneExportFormat[];
  schema_json: Record<string, unknown>;
  status: MneRevisionStatus;
  origin: MneOrigin;
  pack_version: string | null;
  version: string;
  created_by: string;
  approved_by: string | null;
}

const SELECT = `select f.id, f.form_code, f.revision, f.title, f.report_kind, f.legal_basis, f.legal_confirmation_ref, f.watermark_text,
  f.effective_from::text as effective_from, f.effective_until::text as effective_until, f.doc_template_code,
  (select t.id from machvon.document_template t
    where t.template_code = f.doc_template_code and t.status = 'PUBLISHED' and t.effective_from <= f.effective_from and (t.effective_until is null or f.effective_from < t.effective_until)
    order by t.revision desc limit 1) as doc_template_id,
  f.export_formats, f.schema_json, f.status, f.origin, f.pack_version, f.version::text as version, f.created_by, f.approved_by
  from machvon.mne_report_form f`;

const toRow = (row: Sql): MneFormRow => ({
  id: row.id,
  formCode: row.form_code,
  revision: row.revision,
  title: row.title,
  reportKind: row.report_kind,
  legalBasis: row.legal_basis,
  legalConfirmationRef: row.legal_confirmation_ref,
  watermarkText: row.watermark_text,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  docTemplateCode: row.doc_template_code,
  docTemplateId: row.doc_template_id,
  exportFormats: row.export_formats,
  schemaJson: row.schema_json,
  status: row.status,
  origin: row.origin,
  packVersion: row.pack_version,
  version: Number(row.version),
  createdBy: row.created_by,
  approvedBy: row.approved_by,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const rangeOverlap = (): DomainError => new DomainError('FORM_RANGE_OVERLAP', 409, 'effective_from');
const templateMissing = (): DomainError => new DomainError('DOC_TEMPLATE_MISSING', 422, 'doc_template_code');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A text as it is stored: trimmed, within its length, without control characters. */
function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

interface CheckedForm {
  formCode: string;
  title: string;
  reportKind: MneReportKind;
  legalBasis: string;
  legalConfirmationRef: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  schemaJson: Record<string, unknown>;
  docTemplateCode: string;
  exportFormats: MneExportFormat[];
  watermarkText: string | null;
}

function checked(input: MneFormInput): CheckedForm {
  const formCode = input.formCode.trim();
  if (!FORM_CODE.test(formCode)) throw invalid('form_code');
  if (!(MNE_REPORT_KINDS as readonly string[]).includes(input.reportKind)) throw invalid('report_kind');
  if (!isIsoDate(input.effectiveFrom)) throw invalid('effective_from');
  if (input.effectiveUntil !== undefined && (!isIsoDate(input.effectiveUntil) || input.effectiveUntil <= input.effectiveFrom)) throw invalid('effective_until');
  if (!isRecord(input.schemaJson)) throw invalid('schema_json');
  // What a report is made of is read from here: a form whose cells cannot be read is refused when it is drafted, not when the first report is opened.
  parseReportSchema(input.schemaJson);
  const formats = [...new Set(input.exportFormats)];
  if (formats.length === 0 || formats.length !== input.exportFormats.length || !formats.every((format) => (MNE_EXPORT_FORMATS as readonly string[]).includes(format))) throw invalid('export_formats');
  const reference = input.legalConfirmationRef === undefined || input.legalConfirmationRef.trim() === '' ? null : textOf(input.legalConfirmationRef, 'legal_confirmation_ref', 1, MAX_REFERENCE);
  return {
    formCode,
    title: textOf(input.title, 'title', MIN_TITLE, MAX_TITLE),
    reportKind: input.reportKind as MneReportKind,
    legalBasis: textOf(input.legalBasis, 'legal_basis', MIN_LEGAL_BASIS, MAX_LEGAL_BASIS),
    legalConfirmationRef: reference,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil ?? null,
    schemaJson: input.schemaJson,
    docTemplateCode: textOf(input.docTemplateCode, 'doc_template_code', 1, MAX_TEMPLATE_CODE),
    exportFormats: formats as MneExportFormat[],
    watermarkText: input.watermarkText === undefined || input.watermarkText.trim() === '' ? null : textOf(input.watermarkText, 'watermark_text', MIN_TITLE, MAX_WATERMARK),
  };
}

/**
 * The report forms of the monitoring module (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-02): each revision of a form code is data with a
 * legal basis, the reference of its confirmation and an effective period, drafted by one person and published by another. The DOC
 * template that renders the form must exist (BR-DOC-09) when the revision is drafted and when it is published. A report is made with
 * the revision in force on the last day of its period, so a revision that was retired is still read for the days it covered.
 */
export class MneFormStore {
  private readonly table = new MneRevisionTable('mne_report_form', 'form_code', rangeOverlap);
  private readonly documents = new DocumentStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<MneFormRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where f.id = $1::uuid${lock ? ' for update of f' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The revisions of the tenant by code and revision, narrowed by the date they are in force on and by report kind. */
  async list(tx: TenantTx, filter: MneFormFilter, page: MneFormPage): Promise<MneFormRow[]> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ($1::date is null or (f.status <> 'DRAFT' and f.effective_from <= $1::date and (f.effective_until is null or $1::date < f.effective_until)))
          and ($2::text is null or f.report_kind = $2)
          and ($3::text is null or (f.form_code, f.revision) > ($3::text, $4::int))
        order by f.form_code, f.revision limit $5`,
      [filter.effectiveOn ?? null, filter.reportKind ?? null, page.after?.formCode ?? null, page.after?.revision ?? null, page.limit],
    );
    return rows.map(toRow);
  }

  /** The revision of a code that is in force on a date (BR-MNE-02); a retired revision counts for the days it covered. */
  async inForce(tx: TenantTx, formCode: string, on: string): Promise<MneFormRow | undefined> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where f.form_code = $1 and f.status <> 'DRAFT' and f.effective_from <= $2::date and (f.effective_until is null or $2::date < f.effective_until)`,
      [formCode, on],
    );
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Drafts the next revision of a code. Nothing is published by drafting; the period is checked against the published revisions now and again at publication. */
  async create(tx: TenantTx, input: MneFormInput, actor: string): Promise<MneFormRow> {
    const form = checked(input);
    await this.assertTemplate(tx, form.docTemplateCode, form.effectiveFrom);
    await this.table.lockCode(tx, form.formCode);
    await this.table.predecessors(tx, form.formCode, null, { from: form.effectiveFrom, until: form.effectiveUntil });
    const id = await this.insert(tx, form, { status: 'DRAFT', origin: 'TENANT', packVersion: null, actor });
    return this.reread(tx, id);
  }

  /**
   * The approval of a draft by someone other than its maker. An open-ended revision that starts after the one in force takes over from
   * it (the earlier one is retired on the new start date); any other overlap is refused.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string): Promise<{ record: MneFormRow; closed: ClosedRevision[] }> {
    const head = await this.find(tx, id);
    if (head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.table.lockCode(tx, head.formCode);
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    assertFourEyes(row.createdBy, publisher);
    if (row.status !== 'DRAFT') throw new DomainError('REPORT_STATE_INVALID', 409, 'status');
    await this.assertTemplate(tx, row.docTemplateCode, row.effectiveFrom);
    const earlier = await this.table.predecessors(tx, row.formCode, row.id, { from: row.effectiveFrom, until: row.effectiveUntil });
    const closed = await this.table.retire(tx, earlier, row.effectiveFrom, publisher);
    try {
      await tx.query(
        `update machvon.mne_report_form set status = 'PUBLISHED', approved_by = $2::uuid, published_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [id, publisher],
      );
    } catch (error) {
      throw this.table.asOverlap(error);
    }
    return { record: await this.reread(tx, id), closed };
  }

  /**
   * Loads the forms of the platform pack, published and waiting for their legal confirmation. Loading again changes nothing; a newer pack
   * version adds a revision that takes over from the pack revision in force; a code that the tenant revised itself is left alone.
   */
  async loadPack(tx: TenantTx, packVersion: string, entries: readonly MneFormPackEntry[], actor: string): Promise<MneFormPackResult> {
    const result: MneFormPackResult = { inserted: [], upgraded: [], unchanged: [], skipped: [] };
    for (const entry of entries) {
      const form = checked(entry);
      await this.table.lockCode(tx, form.formCode);
      const existing = await tx.query<{ id: string; origin: MneOrigin; pack_version: string | null; status: MneRevisionStatus; effective_from: string; effective_until: string | null }>(
        'select id, origin, pack_version, status, effective_from::text as effective_from, effective_until::text as effective_until from machvon.mne_report_form where form_code = $1 order by revision desc',
        [form.formCode],
      );
      if (existing.some((row) => row.origin === 'TENANT')) {
        result.skipped.push({ formCode: form.formCode, reason: 'TENANT_REVISION' });
        continue;
      }
      if (existing.some((row) => row.pack_version === packVersion)) {
        result.unchanged.push(form.formCode);
        continue;
      }
      const current = existing.find((row) => row.status === 'PUBLISHED' && row.effective_until === null);
      if (current !== undefined && current.effective_from >= form.effectiveFrom) {
        result.skipped.push({ formCode: form.formCode, reason: 'NOT_SUPERSEDABLE' });
        continue;
      }
      if (!(await this.templateExists(tx, form.docTemplateCode, form.effectiveFrom))) {
        result.skipped.push({ formCode: form.formCode, reason: 'DOC_TEMPLATE_MISSING' });
        continue;
      }
      const earlier = await this.table.predecessors(tx, form.formCode, null, { from: form.effectiveFrom, until: form.effectiveUntil });
      await this.table.retire(tx, earlier, form.effectiveFrom, actor);
      try {
        await this.insert(tx, form, { status: 'PUBLISHED', origin: 'PLATFORM_PACK', packVersion, actor });
      } catch (error) {
        throw this.table.asOverlap(error);
      }
      (existing.length === 0 ? result.inserted : result.upgraded).push(form.formCode);
    }
    return result;
  }

  /** DOC_TEMPLATE_MISSING unless DOC has a published template of the code in force on the day the revision starts (BR-DOC-09). */
  private async assertTemplate(tx: TenantTx, templateCode: string, on: string): Promise<void> {
    if (!(await this.templateExists(tx, templateCode, on))) throw templateMissing();
  }

  private async templateExists(tx: TenantTx, templateCode: string, on: string): Promise<boolean> {
    try {
      await this.documents.templateFor(tx, { templateCode }, on);
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'TEMPLATE_NOT_EFFECTIVE') return false;
      throw error;
    }
  }

  private async insert(tx: TenantTx, form: CheckedForm, how: { status: 'DRAFT' | 'PUBLISHED'; origin: MneOrigin; packVersion: string | null; actor: string }): Promise<string> {
    const id = randomUUID();
    const revision = await this.table.nextRevision(tx, form.formCode);
    const published = how.status === 'PUBLISHED';
    try {
      await tx.query(
        `insert into machvon.mne_report_form
           (tenant_id, id, form_code, title, report_kind, legal_basis, legal_confirmation_ref, effective_from, effective_until, schema_json, doc_template_code,
            export_formats, revision, status, origin, pack_version, watermark_text, published_at, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date, $9::jsonb, $10, $11::text[], $12, $13, $14, $15, $16,
                 case when $17 then now() end, $18::uuid, $18::uuid)`,
        [
          id,
          form.formCode,
          form.title,
          form.reportKind,
          form.legalBasis,
          form.legalConfirmationRef,
          form.effectiveFrom,
          form.effectiveUntil,
          JSON.stringify(form.schemaJson),
          form.docTemplateCode,
          form.exportFormats,
          revision,
          how.status,
          how.origin,
          how.packVersion,
          form.watermarkText,
          published,
          how.actor,
        ],
      );
    } catch (error) {
      throw this.table.asOverlap(error);
    }
    return id;
  }

  private async reread(tx: TenantTx, id: string): Promise<MneFormRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the form vanished after its write');
    return row;
  }
}
