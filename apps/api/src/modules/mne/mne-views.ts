import type { MneFormRow, MneObligationRow, MnePackageRow, MneReportRow, MneRuleRow } from '@machvon/db';
import type { MneFieldSource } from '@machvon/kernel';

/** The legal confirmations a text names, as the ledger writes them: `[CXN-10]`, `[CXN-11]`. */
const CXN_TAG = /\[(CXN-[A-Z0-9-]+)\]/g;

/** The labels a screen shows next to a legal parameter: the confirmations its texts wait for (BR-MNE-01), sorted and without duplicates. */
export function cxnRefsOf(...texts: ReadonlyArray<string | null>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(CXN_TAG)) found.add(match[1] ?? '');
  }
  return [...found].sort();
}

/**
 * A form revision as MNE-02 lists it. A revision waits for its legal confirmation until it carries the reference of that
 * confirmation; the exported files carry `watermark_text` meanwhile (BR-MNE-01). The structure of the form (`schema_json`) is not listed.
 */
export function formViewOf(row: MneFormRow): Record<string, unknown> {
  return {
    id: row.id,
    form_code: row.formCode,
    revision: row.revision,
    title: row.title,
    report_kind: row.reportKind,
    legal_basis: row.legalBasis,
    legal_confirmation_ref: row.legalConfirmationRef,
    awaiting_confirmation: row.legalConfirmationRef === null,
    cxn_refs: cxnRefsOf(row.legalBasis, row.watermarkText),
    watermark_text: row.watermarkText,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    doc_template_code: row.docTemplateCode,
    doc_template_id: row.docTemplateId,
    export_formats: row.exportFormats,
    status: row.status,
    origin: row.origin,
    pack_version: row.packVersion,
    version: row.version,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
  };
}

/** A rule revision as the list of rules shows it (MNE-02): the formula as data, the confirmation it waits for, and who made and approved it. */
export function ruleViewOf(row: MneRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    rule_code: row.ruleCode,
    revision: row.revision,
    form_id: row.formId,
    form_code: row.formCode,
    reporting_role: row.reportingRole,
    recipient: row.recipient,
    frequency: row.frequency,
    due_rule_json: row.dueRuleJson,
    legal_basis: row.legalBasis,
    legal_confirmation_ref: row.legalConfirmationRef,
    awaiting_confirmation: row.legalConfirmationRef === null,
    cxn_refs: cxnRefsOf(row.legalBasis),
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    status: row.status,
    origin: row.origin,
    pack_version: row.packVersion,
    version: row.version,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
  };
}

/** An obligation rule revision as the audit trail and the events describe it. */
export function ruleDiffOf(row: MneRuleRow): Record<string, unknown> {
  return {
    rule_code: row.ruleCode,
    revision: row.revision,
    form_id: row.formId,
    form_code: row.formCode,
    reporting_role: row.reportingRole,
    frequency: row.frequency,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
  };
}

/**
 * An obligation of the calendar (MNE-01): the fields of the contract, and what the screen shows next to them: the unit, the period, the
 * level (the reporting role), the recipient and the legal basis with the confirmations it waits for.
 */
export function obligationViewOf(row: MneObligationRow): Record<string, unknown> {
  return {
    mne_report_id: row.id,
    obligation_rule_id: row.obligationRuleId,
    rule_code: row.ruleCode,
    rule_revision: row.ruleRevision,
    reporting_role: row.reportingRole,
    recipient: row.recipient,
    form_id: row.formId,
    form_code: row.formCode,
    form_revision: row.formRevision,
    form_title: row.formTitle,
    report_year: row.reportYear,
    period_label: row.periodLabel,
    scope_unit_id: row.scopeUnitId,
    unit_code: row.unitCode,
    unit_name: row.unitName,
    due_date: row.dueDate,
    status: row.status,
    is_late: row.isLate,
    days_late: row.daysLate,
    legal_basis: row.ruleLegalBasis,
    awaiting_confirmation: row.ruleLegalConfirmationRef === null || row.formLegalConfirmationRef === null,
    cxn_refs: cxnRefsOf(row.ruleLegalBasis),
  };
}

/**
 * A report as MNE-03 shows it: the cells of its form with the value each holds and whether it is locked (filled from a source), the snapshot it rests on, and the confirmations its form waits for. The figures
 * come from the snapshot named in `snapshot`, so the screen can open the drill behind each cell; `snapshot_options` are the frozen snapshots a draft may be attached to.
 */
const SETTLED: readonly string[] = ['SUBMITTED_EXTERNAL', 'SUPERSEDED'];
const DAY_MS = 86_400_000;

/** How late a report is, as the calendar says it (BR-MNE-04): an open report by today against its due date, a filed one by what was stored when it was filed. */
function latenessOf(row: MneReportRow, today: string): { isLate: boolean; daysLate: number | null } {
  if (SETTLED.includes(row.status)) return { isLate: row.isLate, daysLate: row.isLate ? null : 0 };
  const days = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.dueDate}T00:00:00Z`)) / DAY_MS));
  return { isLate: days > 0, daysLate: days };
}

/** A package with the link that serves its file, when the reader may export (the link is short-lived and asked for again with each read). */
export interface PackageLink {
  row: MnePackageRow;
  download: { url: string; expires_at: string } | null;
}

export function reportViewOf(row: MneReportRow, snapshotOptions: ReadonlyArray<{ id: string; asOfDate: string }>, today: string, documentState: string | null = null, packages: readonly PackageLink[] = []): Record<string, unknown> {
  const meta = row.payload.meta;
  const late = latenessOf(row, today);
  return {
    id: row.id,
    form: { id: row.formId, code: row.formCode, revision: row.formRevision, title: row.formTitle, legal_confirmation_ref: row.formLegalConfirmationRef, watermark_text: row.watermarkText },
    awaiting_confirmation: row.formLegalConfirmationRef === null,
    cxn_refs: cxnRefsOf(row.watermarkText),
    report_year: row.reportYear,
    period_label: row.periodLabel,
    period_id: row.periodId,
    scope_unit: { id: row.scopeUnitId, code: row.unitCode, name: row.unitName },
    project_id: row.projectId,
    due_date: row.dueDate,
    revision: row.revision,
    status: row.status,
    is_late: late.isLate,
    days_late: late.daysLate,
    snapshot: row.snapshotId === null ? null : { id: row.snapshotId, as_of_date: meta.as_of_date ?? null },
    snapshot_options: snapshotOptions.map((option) => ({ id: option.id, as_of_date: option.asOfDate })),
    fields: row.schema.fields.map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      required: field.required,
      locked: field.source !== null,
      source: field.source === null ? null : sourceViewOf(field.source),
      value: field.source === null ? (row.payload.narrative[field.key] ?? null) : (row.payload.values[field.key] ?? null),
    })),
    attachments: row.payload.attachments,
    payload_sha256: row.payloadSha256,
    doc_document_id: row.docDocumentId,
    document_state: documentState,
    packages: packages.map((entry) => ({ ...packageDiffOf(entry.row), id: entry.row.id, receipt: entry.row.receiptReference === null ? null : { reference: entry.row.receiptReference, document_id: entry.row.receiptDocumentId, recorded_by: entry.row.receiptRecordedBy, recorded_at: entry.row.receiptRecordedAt, submitted_at: entry.row.submittedAt }, created_at: entry.row.createdAt, downloaded_at: entry.row.downloadedAt, version: entry.row.version, download: entry.download })),
    decision: row.decidedBy === null ? null : { by: row.decidedBy, at: row.decidedAt, reason: row.decisionReason },
    issue_requested_at: row.issueRequestedAt,
    issued_at: row.issuedAt,
    recalled_at: row.recalledAt,
    supersedes_id: row.supersedesId,
    correction_reason: row.correctionReason,
    submitted_by: row.submittedBy,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    version: row.version,
  };
}

function sourceViewOf(source: MneFieldSource): Record<string, unknown> {
  switch (source.kind) {
    case 'SNAPSHOT_METRIC':
      return { kind: source.kind, metric: source.metric };
    case 'PROJECT_COUNT':
      return { kind: source.kind, stage: source.stage };
    case 'WARNING_COUNT':
      return { kind: source.kind, severity: source.severity };
    case 'APPROPRIATION_TOTAL':
      return { kind: source.kind, plan_year: source.planYear };
  }
}

/** A report as the audit trail and the events describe it (no cells: the figures are in the snapshot, the words in the report). */
export function reportDiffOf(row: MneReportRow): Record<string, unknown> {
  return { form_code: row.formCode, form_revision: row.formRevision, report_year: row.reportYear, period_label: row.periodLabel, scope_unit_id: row.scopeUnitId, project_id: row.projectId, snapshot_id: row.snapshotId, status: row.status, revision: row.revision };
}

/** A package as the audit trail and the events describe it: what it is and how far the way to its target goes, never the bytes. */
export function packageDiffOf(row: MnePackageRow): Record<string, unknown> {
  return { target_system: row.targetSystem, format: row.format, file_sha256: row.fileSha256, file_size_bytes: row.fileSizeBytes, adapter_status: row.adapterStatus, status: row.status };
}
