import { ApiError } from '@machvon/api-client';
import type { ConclusionFormProblem } from '../conclusion/model';
import { isDay } from '../model';
import type { EngagementDetail, ScopeItem } from '../model';
import { toRate } from '../recovery/model';
import type { Rate } from '../recovery/model';

/** AUD-10: the report of the results of the recommendations that DOC issues, and the closure of the engagement (ST-AUD-005, AUD 3.6). */
export const REPORT_PATH = '/aud/aud-10';

/** The permissions that gate the buttons; the server decides again on every request. */
export const REPORT_PERMISSION = 'aud.report.issue';
export const CLOSE_PERMISSION = 'aud.engagement.close';

export const REPORT_STATUSES = ['DRAFT', 'ISSUE_REQUESTED', 'ISSUED', 'REJECTED', 'RECALLED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The reasons DOC gives for a request it refused (and the one a cancelled draft carries); any other reason is shown as "another reason". */
export const REJECT_CODES = ['DOC_TEMPLATE_MISSING', 'TEMPLATE_NOT_EFFECTIVE', 'PAYLOAD_HASH_MISMATCH', 'PAYLOAD_SCHEMA_INVALID', 'STATE_SECRET_NOT_SUPPORTED'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

const PLACE_MAX = 100;
const HASH = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value : undefined);

/** The figures frozen with a report: counts by group on the day, the money, and the two rates each with their numerator and denominator (BR-AUD-04). */
export interface ReportTotals {
  asOfDate: string;
  total: number;
  closed: number;
  inProgress: number;
  open: number;
  disputed: number;
  amountVnd: string;
  recoveredVnd: string;
  remainingVnd: string;
  moneyRate: Rate;
  countRate: Rate;
}

export function toTotals(raw: unknown): ReportTotals | undefined {
  const row = asRecord(raw);
  const asOfDate = text(row?.as_of_date);
  const total = whole(row?.total);
  const closed = whole(row?.closed);
  const inProgress = whole(row?.in_progress);
  const open = whole(row?.open);
  const disputed = whole(row?.disputed);
  const amount = dong(row?.amount);
  const recovered = dong(row?.recovered);
  const remaining = dong(row?.remaining);
  const moneyRate = toRate(row?.money_rate);
  const countRate = toRate(row?.count_rate);
  if (row === undefined || asOfDate === undefined || total === undefined || closed === undefined || inProgress === undefined || open === undefined || disputed === undefined) return undefined;
  if (amount === undefined || recovered === undefined || remaining === undefined || moneyRate === undefined || countRate === undefined) return undefined;
  return { asOfDate, total, closed, inProgress, open, disputed, amountVnd: amount, recoveredVnd: recovered, remainingVnd: remaining, moneyRate, countRate };
}

export interface Person {
  id: string;
  displayName: string;
}

const toPerson = (raw: unknown): Person | undefined => {
  const row = asRecord(raw);
  const id = text(row?.id);
  return row === undefined || id === undefined ? undefined : { id, displayName: text(row.display_name) ?? '' };
};

/** A report as AUD-10 lists it. */
export interface ReportLine {
  id: string;
  conclusionId: string;
  conclusionSymbol: string | null;
  asOfDate: string;
  revision: number;
  status: ReportStatus;
  totals: ReportTotals;
  payloadSha256: string;
  documentId: string | null;
  rejectCode: string | null;
  requestedBy: Person;
  approvedBy: Person | null;
  requestedAt: string;
  issuedAt: string | null;
  version: number;
}

/** A report the screen cannot read is dropped rather than shown half. */
export function toReport(raw: unknown): ReportLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const conclusionId = text(row?.conclusion_id);
  const asOfDate = text(row?.as_of_date);
  const revision = whole(row?.revision);
  const status = oneOf(REPORT_STATUSES, row?.status);
  const totals = toTotals(row?.totals);
  const hash = text(row?.payload_sha256);
  const requestedBy = toPerson(row?.requested_by);
  const requestedAt = text(row?.requested_at);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || conclusionId === undefined || asOfDate === undefined || revision === undefined || status === undefined || totals === undefined) return undefined;
  if (hash === undefined || !HASH.test(hash) || requestedBy === undefined || requestedAt === undefined || version === undefined) return undefined;
  return {
    id,
    conclusionId,
    conclusionSymbol: nullableText(row.conclusion_symbol),
    asOfDate,
    revision,
    status,
    totals,
    payloadSha256: hash,
    documentId: nullableText(row.report_document_id),
    rejectCode: nullableText(row.reject_code),
    requestedBy,
    approvedBy: row.approved_by === null || row.approved_by === undefined ? null : (toPerson(row.approved_by) ?? null),
    requestedAt,
    issuedAt: nullableText(row.issued_at),
    version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The button that asks for a report: the permission to issue it, in a tenant that is not read only. */
export const canRequestReport = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(REPORT_PERMISSION)) && mode !== 'READ_ONLY';

/** The button that closes an engagement. */
export const canCloseEngagement = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(CLOSE_PERMISSION)) && mode !== 'READ_ONLY';

/** A report is asked for, and the engagement closed, while the engagement is being followed up. */
export const reportable = (engagement: Pick<EngagementDetail, 'status'>): boolean => engagement.status === 'FOLLOW_UP';

/** A report that is waiting for DOC, or issued, holds its conclusion and day: another one for them is refused until it is rejected or recalled. */
export const holdsDay = (report: Pick<ReportLine, 'status'>): boolean => report.status === 'DRAFT' || report.status === 'ISSUE_REQUESTED' || report.status === 'ISSUED';

/** The short form of a hash for a table: the first 12 characters. The whole hash is always at hand as the title of the cell. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

/** The units the engagement is about: the ones that can draft its report. */
export const scopeUnits = (scope: readonly ScopeItem[]): ScopeItem[] => scope.filter((item) => item.kind === 'UNIT');

type Problems<F> = Partial<Record<keyof F, ConclusionFormProblem>>;

export interface RequestForm {
  conclusionId: string;
  asOfDate: string;
  place: string;
  draftingUnitId: string;
}

export const EMPTY_REQUEST_FORM: RequestForm = { conclusionId: '', asOfDate: '', place: '', draftingUnitId: '' };

/** The report is as of a day from the day the conclusion was received to today; the place is the locality the head of the document carries. */
export function validateRequest(form: RequestForm, bounds: { today: string; receivedOn: string | undefined }): Problems<RequestForm> {
  const problems: Problems<RequestForm> = {};
  if (form.conclusionId === '') problems.conclusionId = 'required';
  const day = form.asOfDate.trim();
  if (day === '') problems.asOfDate = 'required';
  else if (!isDay(day)) problems.asOfDate = 'invalid';
  else if (day > bounds.today) problems.asOfDate = 'future';
  else if (bounds.receivedOn !== undefined && day < bounds.receivedOn) problems.asOfDate = 'early';
  const place = form.place.trim();
  if (place === '') problems.place = 'required';
  else if (place.length > PLACE_MAX) problems.place = 'tooLong';
  else if (CONTROL.test(place)) problems.place = 'invalid';
  // The unit is chosen among the ones the server named, never typed: only a missing choice is a problem here.
  if (form.draftingUnitId === '') problems.draftingUnitId = 'required';
  return problems;
}

export interface RequestBody {
  conclusion_id: string;
  as_of_date: string;
  place: string;
  drafting_unit_id: string;
}

export const requestBody = (form: RequestForm): RequestBody => ({
  conclusion_id: form.conclusionId,
  as_of_date: form.asOfDate.trim(),
  place: form.place.trim(),
  drafting_unit_id: form.draftingUnitId.trim().toLowerCase(),
});

export interface CloseForm {
  onDate: string;
}

export const EMPTY_CLOSE_FORM: CloseForm = { onDate: '' };

/** The day of the closure is from the start of the engagement to today. */
export function validateClose(form: CloseForm, bounds: { today: string; startedOn: string | null }): Problems<CloseForm> {
  const day = form.onDate.trim();
  if (day === '') return { onDate: 'required' };
  if (!isDay(day)) return { onDate: 'invalid' };
  if (day > bounds.today) return { onDate: 'future' };
  if (bounds.startedOn !== null && day < bounds.startedOn) return { onDate: 'early' };
  return {};
}

export interface CloseBody {
  on_date: string;
}

export const closeBody = (form: CloseForm): CloseBody => ({ on_date: form.onDate.trim() });

export type ReportProblem =
  | 'exists'
  | 'engagementState'
  | 'conclusionReplaced'
  | 'templateMissing'
  | 'providerUnavailable'
  | 'openRecommendations'
  | 'reportMissing'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ReportProblem>> = {
  FOLLOW_UP_REPORT_EXISTS: 'exists',
  ENGAGEMENT_STATE_INVALID: 'engagementState',
  CONCLUSION_REVISION_INVALID: 'conclusionReplaced',
  DOC_TEMPLATE_MISSING: 'templateMissing',
  PROVIDER_UNAVAILABLE: 'providerUnavailable',
  OPEN_RECOMMENDATIONS_REMAIN: 'openRecommendations',
  FOLLOW_UP_REPORT_MISSING: 'reportMissing',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface DescribedReport {
  problem: ReportProblem;
  /** How many recommendations are still open, when that is what stopped the closure. */
  open: number | undefined;
}

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeReport(error: unknown): DescribedReport {
  if (!(error instanceof ApiError)) return { problem: 'general', open: undefined };
  return { problem: PROBLEM_BY_CODE[error.code] ?? 'general', open: error.code === 'OPEN_RECOMMENDATIONS_REMAIN' ? whole(error.extensions.open_recommendations) : undefined };
}
