import { ApiError } from '@machvon/api-client';
import type { ReportField, ReportView } from './types';
import { APPROVE_REPORT_PERMISSION, EXPORT_REPORT_PERMISSION, ISSUE_REPORT_PERMISSION, PREPARE_REPORT_PERMISSION } from './types';
import type { PackageView } from './types';

// ---- what a person may do with a report ----

/** Whether the report can be written now: a draft, for a person who prepares reports, outside the read-only mode. */
export function isEditable(report: Pick<ReportView, 'status'>, permissions: readonly string[] | undefined, frozen: boolean): boolean {
  return report.status === 'DRAFT' && !frozen && (permissions === undefined || permissions.includes(PREPARE_REPORT_PERMISSION));
}

// ---- who may decide and ask for issue (MNE-05) ----

/** Whether the person may approve or return the report now: it is in review, they hold the right, the system is not read-only, and they neither wrote it nor handed it in (the server judges it again). */
export function mayDecide(report: Pick<ReportView, 'status' | 'createdBy' | 'submittedBy'>, permissions: readonly string[] | undefined, frozen: boolean, memberId: string | undefined): boolean {
  if (report.status !== 'IN_REVIEW' || frozen) return false;
  if (permissions !== undefined && !permissions.includes(APPROVE_REPORT_PERMISSION)) return false;
  return memberId === undefined || (memberId !== report.createdBy && memberId !== report.submittedBy);
}

/** Whether the person who holds the right to approve is kept from it because they wrote the report or handed it in. */
export function isOwnReport(report: Pick<ReportView, 'createdBy' | 'submittedBy'>, memberId: string | undefined): boolean {
  return memberId !== undefined && (memberId === report.createdBy || memberId === report.submittedBy);
}

/** Whether the person may ask DOC to issue the report: it is approved, they hold the right and the system is not read-only. */
export function mayRequestIssue(report: Pick<ReportView, 'status'>, permissions: readonly string[] | undefined, frozen: boolean): boolean {
  return report.status === 'APPROVED' && !frozen && (permissions === undefined || permissions.includes(ISSUE_REPORT_PERMISSION));
}

/** The reason of a decision is five characters at least once trimmed (the server says the same). */
export const REASON_MIN = 5;
export const hasReason = (reason: string): boolean => reason.trim().length >= REASON_MIN;

// ---- the files of an issued report (MNE-06) ----

/** Whether the person may make files of the report and write down their filing: the report is issued (and not recalled), they hold the right and the system is not read-only. */
export function mayExport(report: Pick<ReportView, 'status' | 'recalledAt'>, permissions: readonly string[] | undefined, frozen: boolean): boolean {
  return (report.status === 'ISSUED' || report.status === 'EXPORTED' || report.status === 'SUBMITTED_EXTERNAL') && report.recalledAt === null && !frozen && (permissions === undefined || permissions.includes(EXPORT_REPORT_PERMISSION));
}

/** The hash as a screen shows it: the first twelve characters and the last four, the whole of it in the title of the cell. */
export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 12)}…${hash.slice(-4)}`;
}

/** A file can take its receipt while it is offered: made or downloaded, not yet filed, refused or expired. */
export const canFile = (item: Pick<PackageView, 'status'>): boolean => item.status === 'GENERATED' || item.status === 'DOWNLOADED';

/** The moment of a filing written in a form field (a local date and time) as the instant the server takes, or undefined when it is not a date. */
export function instantOf(local: string): string | undefined {
  const time = Date.parse(local);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

// ---- the document DOC makes of the report ----

export const DOC_STAGES = ['drafting', 'awaitingSignature', 'numbered', 'published'] as const;
export type DocStage = (typeof DOC_STAGES)[number] | 'none' | 'withdrawn';

/** Where the document stands, from the state DOC keeps it in: being drafted, waiting for the signature, signed and numbered, or issued; none while DOC has made no draft, withdrawn when it was cancelled or recalled. */
export function docStageOf(state: string | null): DocStage {
  switch (state) {
    case null:
      return 'none';
    case 'DRAFT':
    case 'IN_REVIEW':
      return 'drafting';
    case 'SUBMITTED':
      return 'awaitingSignature';
    case 'SIGNED':
    case 'NUMBERED':
    case 'SEALED':
      return 'numbered';
    case 'ISSUED':
    case 'DELIVERED':
    case 'ACKNOWLEDGED':
    case 'FILED':
    case 'ARCHIVED':
      return 'published';
    default:
      return 'withdrawn';
  }
}

/** The text of each cell that is written by hand, as the form shows it. */
export type Drafts = Readonly<Record<string, string>>;

export function draftsOf(report: Pick<ReportView, 'fields'>): Drafts {
  return Object.fromEntries(report.fields.filter((field) => !field.locked).map((field) => [field.key, field.value === null ? '' : String(field.value)]));
}

/** What the person changed: the cells whose text differs from the report, an emptied cell as null. A cell that has a source is never sent. */
export function narrativeChanges(report: Pick<ReportView, 'fields'>, drafts: Drafts): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const field of report.fields) {
    if (field.locked) continue;
    const before = field.value === null ? '' : String(field.value);
    const after = drafts[field.key] ?? before;
    if (after.trim() !== before.trim()) changes[field.key] = after.trim() === '' ? null : after.trim();
  }
  return changes;
}

/** The required cells that would still be empty once the draft is saved (the server says the same when the report is handed in). */
export function missingCells(report: Pick<ReportView, 'fields'>, drafts: Drafts): string[] {
  return report.fields
    .filter((field) => field.required)
    .filter((field) => (field.locked ? field.value === null : (drafts[field.key] ?? '').trim() === ''))
    .map((field) => field.key);
}

// ---- how a cell is shown ----

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** Whole dong with a dot between thousands, as the Vietnamese write them; a negative amount keeps its sign. */
export function dong(amount: string): string {
  return amount.startsWith('-') ? `-${dong(amount.slice(1))}` : amount.replace(GROUP, '.');
}

/** A locked or written value in the form of its kind; an empty cell is null so that the screen says it is empty. */
export function shown(field: ReportField): string | null {
  if (field.value === null) return null;
  switch (field.kind) {
    case 'MONEY':
      return typeof field.value === 'string' ? dong(field.value) : String(field.value);
    case 'PERCENT':
      return `${String(field.value)}%`;
    case 'INTEGER':
    case 'TEXT':
      return String(field.value);
  }
}

/** The page behind a locked cell (HOME-10, the context of a figure and its trace to the source): the metric and the snapshot it came from. */
export function drillPath(report: Pick<ReportView, 'snapshotId'>, field: Pick<ReportField, 'key' | 'source'>): string | undefined {
  if (field.source === null || report.snapshotId === null) return undefined;
  const query = new URLSearchParams({ source: field.source.kind, snapshot: report.snapshotId, ...(field.source.detail === null ? {} : { detail: field.source.detail }), field: field.key });
  return `/home/home-10?${query.toString()}`;
}

// ---- why a command failed ----

export type ReportReason =
  | 'conflict'
  | 'receiptRequired'
  | 'notIssued'
  | 'formatUnsupported'
  | 'packageState'
  | 'selfApproval'
  | 'templateMissing'
  | 'stateInvalid'
  | 'snapshotRequired'
  | 'snapshotNotFrozen'
  | 'locked'
  | 'missing'
  | 'formNotEffective'
  | 'exists'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ReportProblem {
  reason: ReportReason;
  /** The cells the problem is about, when the server named them. */
  fields: string[];
}

const REASON_BY_CODE: Readonly<Record<string, ReportReason>> = {
  VERSION_CONFLICT: 'conflict',
  RECEIPT_REQUIRED: 'receiptRequired',
  REPORT_NOT_ISSUED: 'notIssued',
  EXPORT_FORMAT_UNSUPPORTED: 'formatUnsupported',
  PACKAGE_STATE_INVALID: 'packageState',
  SELF_APPROVAL_DENIED: 'selfApproval',
  DOC_TEMPLATE_MISSING: 'templateMissing',
  REPORT_STATE_INVALID: 'stateInvalid',
  SNAPSHOT_REQUIRED: 'snapshotRequired',
  SNAPSHOT_NOT_FROZEN: 'snapshotNotFrozen',
  FIELD_SOURCE_LOCKED: 'locked',
  FORM_NOT_EFFECTIVE: 'formNotEffective',
  REPORT_EXISTS: 'exists',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** Maps the failure of a command on a report to what the screen says; a VALIDATION_FAILED that lists missing cells is `missing`. */
export function describeReportProblem(error: unknown): ReportProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', fields: [] };
  const missing = textsOf(error.extensions.missing_fields);
  if (error.code === 'VALIDATION_FAILED' && missing.length > 0) return { reason: 'missing', fields: missing };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', fields: textsOf(error.extensions.fields) };
}
