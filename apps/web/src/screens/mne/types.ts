/** The permissions of MNE F1 and F2 (x-permission in openapi.json): the catalogue and the calendar are read with `mne.read`. */
export const READ_PERMISSION = 'mne.read';
export const MANAGE_FORMS_PERMISSION = 'mne.form.manage';
export const APPROVE_FORMS_PERMISSION = 'mne.form.approve';
export const MANAGE_CALENDAR_PERMISSION = 'mne.calendar.manage';
export const APPROVE_CALENDAR_PERMISSION = 'mne.calendar.approve';

export const REPORT_KINDS = ['OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL', 'PROJECT_START', 'PROJECT_ADJUST', 'PROJECT_COMPLETION', 'PROJECT_PERIODIC', 'EVALUATION', 'WEEKLY_QUICK'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const EXPORT_FORMATS = ['XLSX', 'PDF', 'XML', 'CSV'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const REPORTING_ROLES = ['INVESTOR', 'PROJECT_OWNER_AGENCY', 'PROVINCIAL_PEOPLE_COMMITTEE', 'PLANNING_AGENCY'] as const;
export type ReportingRole = (typeof REPORTING_ROLES)[number];
export const FORM_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];
export const FREQUENCIES = ['WEEKLY', 'SEMIANNUAL', 'ANNUAL', 'EVENT'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const REPORT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** One revision of a report form as `listMneForms` returns it (MNE-02). */
export interface FormView {
  id: string;
  formCode: string;
  revision: number;
  title: string;
  reportKind: ReportKind;
  legalBasis: string;
  /** The reference of the confirmation of the legal basis; null while the revision is a working assumption that waits for it. */
  legalConfirmationRef: string | null;
  awaitingConfirmation: boolean;
  /** The confirmations the legal basis and the watermark name, e.g. `CXN-10`. */
  cxnRefs: string[];
  watermarkText: string | null;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  docTemplateCode: string;
  /** The DOC template of that code in force on the first day of the revision; null when DOC has none. */
  docTemplateId: string | null;
  exportFormats: ExportFormat[];
  status: FormStatus;
  origin: 'PLATFORM_PACK' | 'TENANT';
  version: number;
  createdBy: string;
  approvedBy: string | null;
}

/** One revision of an obligation rule as `listMneObligationRules` returns it (MNE-02). */
export interface RuleView {
  id: string;
  ruleCode: string;
  revision: number;
  formId: string;
  formCode: string;
  reportingRole: ReportingRole;
  recipient: string;
  frequency: Frequency;
  /** The formula of the deadline, as data. */
  dueRule: Record<string, unknown>;
  legalBasis: string;
  legalConfirmationRef: string | null;
  awaitingConfirmation: boolean;
  cxnRefs: string[];
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: FormStatus;
  version: number;
  createdBy: string;
  approvedBy: string | null;
}

/** One obligation of the calendar as `listMneObligations` returns it (MNE-01). */
export interface ObligationView {
  reportId: string;
  ruleCode: string;
  ruleRevision: number;
  reportingRole: ReportingRole;
  recipient: string;
  formCode: string;
  formRevision: number;
  formTitle: string;
  reportYear: number;
  periodLabel: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  dueDate: string;
  status: ReportStatus;
  isLate: boolean;
  /** Days past the due date; null for a filed report whose filing day is not known. */
  daysLate: number | null;
  legalBasis: string;
  awaitingConfirmation: boolean;
  cxnRefs: string[];
}

export interface ObligationPage {
  items: ObligationView[];
  nextCursor: string | undefined;
}

/** What the generation of a year answered. */
export interface GenerationResult {
  created: number;
  existing: number;
  periods: number;
  unresolvedRoles: ReportingRole[];
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find((candidate) => candidate === value);

/** A row of `listMneForms` as a FormView, or undefined when it lacks what the screen needs (the screen shows what it can trust). */
export function toForm(raw: unknown): FormView | undefined {
  if (!isRecord(raw)) return undefined;
  const reportKind = oneOf(raw.report_kind, REPORT_KINDS);
  const status = oneOf(raw.status, FORM_STATUSES);
  const id = text(raw.id);
  const formCode = text(raw.form_code);
  if (reportKind === undefined || status === undefined || id === '' || formCode === '') return undefined;
  const reference = nullableText(raw.legal_confirmation_ref);
  return {
    id,
    formCode,
    revision: count(raw.revision),
    title: text(raw.title),
    reportKind,
    legalBasis: text(raw.legal_basis),
    legalConfirmationRef: reference,
    // The server says it; a row without the flag waits for its confirmation unless it carries one.
    awaitingConfirmation: typeof raw.awaiting_confirmation === 'boolean' ? raw.awaiting_confirmation : reference === null,
    cxnRefs: texts(raw.cxn_refs),
    watermarkText: nullableText(raw.watermark_text),
    effectiveFrom: text(raw.effective_from),
    effectiveUntil: nullableText(raw.effective_until),
    docTemplateCode: text(raw.doc_template_code),
    docTemplateId: nullableText(raw.doc_template_id),
    exportFormats: texts(raw.export_formats).flatMap((format) => oneOf(format, EXPORT_FORMATS) ?? []),
    status,
    origin: raw.origin === 'TENANT' ? 'TENANT' : 'PLATFORM_PACK',
    version: count(raw.version),
    createdBy: text(raw.created_by),
    approvedBy: nullableText(raw.approved_by),
  };
}

/** A row of `listMneObligationRules` as a RuleView, or undefined when it lacks what the screen needs. */
export function toRule(raw: unknown): RuleView | undefined {
  if (!isRecord(raw)) return undefined;
  const reportingRole = oneOf(raw.reporting_role, REPORTING_ROLES);
  const frequency = oneOf(raw.frequency, FREQUENCIES);
  const status = oneOf(raw.status, FORM_STATUSES);
  const id = text(raw.id);
  const ruleCode = text(raw.rule_code);
  if (reportingRole === undefined || frequency === undefined || status === undefined || id === '' || ruleCode === '') return undefined;
  const reference = nullableText(raw.legal_confirmation_ref);
  return {
    id,
    ruleCode,
    revision: count(raw.revision),
    formId: text(raw.form_id),
    formCode: text(raw.form_code),
    reportingRole,
    recipient: text(raw.recipient),
    frequency,
    dueRule: isRecord(raw.due_rule_json) ? raw.due_rule_json : {},
    legalBasis: text(raw.legal_basis),
    legalConfirmationRef: reference,
    awaitingConfirmation: typeof raw.awaiting_confirmation === 'boolean' ? raw.awaiting_confirmation : reference === null,
    cxnRefs: texts(raw.cxn_refs),
    effectiveFrom: text(raw.effective_from),
    effectiveUntil: nullableText(raw.effective_until),
    status,
    version: count(raw.version),
    createdBy: text(raw.created_by),
    approvedBy: nullableText(raw.approved_by),
  };
}

/** A row of `listMneObligations` as an ObligationView, or undefined when it lacks what the screen needs. */
export function toObligation(raw: unknown): ObligationView | undefined {
  if (!isRecord(raw)) return undefined;
  const reportingRole = oneOf(raw.reporting_role, REPORTING_ROLES);
  const status = oneOf(raw.status, REPORT_STATUSES);
  const reportId = text(raw.mne_report_id);
  const dueDate = text(raw.due_date);
  if (reportingRole === undefined || status === undefined || reportId === '' || dueDate === '') return undefined;
  return {
    reportId,
    ruleCode: text(raw.rule_code),
    ruleRevision: count(raw.rule_revision),
    reportingRole,
    recipient: text(raw.recipient),
    formCode: text(raw.form_code),
    formRevision: count(raw.form_revision),
    formTitle: text(raw.form_title),
    reportYear: count(raw.report_year),
    periodLabel: text(raw.period_label),
    unitId: text(raw.scope_unit_id),
    unitCode: text(raw.unit_code),
    unitName: text(raw.unit_name),
    dueDate,
    status,
    isLate: raw.is_late === true,
    daysLate: typeof raw.days_late === 'number' && Number.isFinite(raw.days_late) ? raw.days_late : null,
    legalBasis: text(raw.legal_basis),
    awaitingConfirmation: raw.awaiting_confirmation !== false,
    cxnRefs: texts(raw.cxn_refs),
  };
}

export function toObligationPage(raw: unknown): ObligationPage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(page.items) ? page.items.flatMap((item) => toObligation(item) ?? []) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}

export function toGeneration(raw: unknown): GenerationResult {
  const answer: Raw = isRecord(raw) ? raw : {};
  return {
    created: count(answer.created),
    existing: count(answer.existing),
    periods: count(answer.periods),
    unresolvedRoles: texts(answer.unresolved_roles).flatMap((role) => oneOf(role, REPORTING_ROLES) ?? []),
  };
}

// ---- the report of MNE-03 ----

export const PREPARE_REPORT_PERMISSION = 'mne.report.prepare';
export const FIELD_KINDS = ['MONEY', 'PERCENT', 'INTEGER', 'TEXT'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const SOURCE_KINDS = ['SNAPSHOT_METRIC', 'PROJECT_COUNT', 'WARNING_COUNT', 'APPROPRIATION_TOTAL'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Where a locked cell comes from: the kind of source and the one detail that names it (a metric, a stage, a severity or a plan year). */
export interface FieldSource {
  kind: SourceKind;
  detail: string | null;
}

/** One cell of the form of a report: filled by the system and locked when it has a source, written by hand otherwise. */
export interface ReportField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  locked: boolean;
  source: FieldSource | null;
  /** What the cell holds as the server writes it (a decimal text for money and rates, a number for a count, a text), null while empty. */
  value: string | number | null;
}

/** A report as `getMneReport` returns it (MNE-03). */
export interface ReportView {
  id: string;
  formCode: string;
  formRevision: number;
  formTitle: string;
  awaitingConfirmation: boolean;
  cxnRefs: string[];
  watermarkText: string | null;
  periodLabel: string;
  reportYear: number;
  unitCode: string;
  unitName: string;
  dueDate: string;
  status: ReportStatus;
  isLate: boolean;
  snapshotId: string | null;
  asOfDate: string | null;
  fields: ReportField[];
  attachments: string[];
  /** The frozen snapshots a draft may be attached to, newest first. */
  snapshotOptions: Array<{ id: string; asOfDate: string }>;
  version: number;
}

/** What a command on a report answered: the status and the version the next command is sent with. */
export interface ReportCommandResult {
  status: string;
  version: number;
}

/** A cell as `getMneReport` writes it, or undefined when it lacks what the screen needs. */
function toReportField(raw: unknown): ReportField | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = oneOf(raw.kind, FIELD_KINDS);
  const key = text(raw.key);
  if (kind === undefined || key === '') return undefined;
  const source = isRecord(raw.source) ? oneOf(raw.source.kind, SOURCE_KINDS) : undefined;
  const detail = isRecord(raw.source) ? (raw.source.metric ?? raw.source.stage ?? raw.source.severity ?? raw.source.plan_year ?? null) : null;
  const value = raw.value;
  return {
    key,
    label: text(raw.label) === '' ? key : text(raw.label),
    kind,
    required: raw.required === true,
    locked: raw.locked === true,
    source: source === undefined ? null : { kind: source, detail: typeof detail === 'string' || typeof detail === 'number' ? String(detail) : null },
    value: typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null,
  };
}

/** A report as the screen reads it, or undefined when the answer lacks what the screen needs (the screen shows what it can trust). */
export function toReport(raw: unknown): ReportView | undefined {
  if (!isRecord(raw) || !isRecord(raw.form) || !isRecord(raw.scope_unit)) return undefined;
  const status = oneOf(raw.status, REPORT_STATUSES);
  const id = text(raw.id);
  if (status === undefined || id === '') return undefined;
  const snapshot = isRecord(raw.snapshot) ? raw.snapshot : undefined;
  return {
    id,
    formCode: text(raw.form.code),
    formRevision: count(raw.form.revision),
    formTitle: text(raw.form.title),
    awaitingConfirmation: typeof raw.awaiting_confirmation === 'boolean' ? raw.awaiting_confirmation : raw.form.legal_confirmation_ref === null,
    cxnRefs: texts(raw.cxn_refs),
    watermarkText: nullableText(raw.form.watermark_text),
    periodLabel: text(raw.period_label),
    reportYear: count(raw.report_year),
    unitCode: text(raw.scope_unit.code),
    unitName: text(raw.scope_unit.name),
    dueDate: text(raw.due_date),
    status,
    isLate: raw.is_late === true,
    snapshotId: snapshot === undefined ? null : nullableText(snapshot.id),
    asOfDate: snapshot === undefined ? null : nullableText(snapshot.as_of_date),
    fields: (Array.isArray(raw.fields) ? raw.fields : []).flatMap((field) => toReportField(field) ?? []),
    attachments: texts(raw.attachments),
    snapshotOptions: (Array.isArray(raw.snapshot_options) ? raw.snapshot_options : []).flatMap((option) => (isRecord(option) && text(option.id) !== '' && text(option.as_of_date) !== '' ? [{ id: text(option.id), asOfDate: text(option.as_of_date) }] : [])),
    version: count(raw.version),
  };
}

/** The answer of a command: the status and the version of the resource. */
export function toReportResult(raw: unknown): ReportCommandResult {
  const answer = isRecord(raw) ? raw : {};
  return { status: text(answer.status), version: count(answer.resource_version) };
}
