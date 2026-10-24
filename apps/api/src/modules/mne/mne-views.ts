import type { MneFormRow, MneObligationRow, MneRuleRow } from '@machvon/db';

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
