import { ApiError } from '@machvon/api-client';

/**
 * BID-33, "Reconciliation": the pure part. The answer of the API is read defensively, the filters live in the address, and the rules of a resolution are checked here before the server checks them again.
 * A difference is a field on which our register and what a file of the national procurement network said disagree; it has an owner who did not make the record, and one of four resolutions.
 */

export const SUBJECTS = ['PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACTOR'] as const;
export type ReconcileSubject = (typeof SUBJECTS)[number];

export const STATES = ['OPEN', 'RESOLVED'] as const;
export type ItemState = (typeof STATES)[number];

export const RESOLUTIONS = ['ACCEPT_EXTERNAL', 'CORRECT_OURS', 'DISPUTE', 'WAIVE'] as const;
export type ResolutionKind = (typeof RESOLUTIONS)[number];

export type DifferenceKind = 'VALUE_MISMATCH' | 'MISSING_OURS' | 'MISSING_THEIRS';

/** What a person must hold to run the reconciliation and to settle an item; the server tells per page and per row (`actions`). */
export const RECONCILE_PERMISSION = 'bid.egp.reconcile';
export const PAGE_SIZE = 50;
export const MAX_EVIDENCE = 200;
export const MAX_REASON = 1000;
/** A waiver is looked at again within a year at most (`EGP_WAIVER_MAX_DAYS` of the kernel). */
export const WAIVER_MAX_DAYS = 365;
/** The shortest reason of each resolution: a sentence to leave a difference or to contest it, a few words for the other two. */
export const MIN_REASON: Readonly<Record<ResolutionKind, number>> = { ACCEPT_EXTERNAL: 10, CORRECT_OURS: 10, DISPUTE: 20, WAIVE: 20 };

export interface Resolution {
  kind: ResolutionKind;
  resolvedByName: string | null;
  resolvedAt: string | null;
  reason: string;
  evidenceRef: string | null;
  reviewOn: string | null;
  followUp: string;
}

export interface ReconcileItem {
  id: string;
  subjectType: ReconcileSubject;
  subjectCode: string;
  externalCode: string;
  field: string;
  differenceKind: DifferenceKind;
  ours: string | null;
  theirs: string | null;
  delta: string | null;
  state: ItemState;
  ownerName: string | null;
  openedAt: string;
  dueAt: string;
  overdue: boolean;
  resolution: Resolution | null;
  version: number;
  isMaker: boolean;
  canResolve: boolean;
}

export interface DueRule {
  days: number;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  legalStatus: string;
  formula: string;
  sourceText: string;
  asOf: string;
}

export interface ReconcileCounts {
  open: number;
  resolved: number;
  overdue: number;
  waiversDue: number;
  byResolution: Record<ResolutionKind, number>;
}

export interface ReconcilePage {
  items: ReconcileItem[];
  nextCursor: string | null;
  counts: ReconcileCounts;
  dueRule: DueRule;
  formula: string;
  source: string;
  acceptance: string;
  canRun: boolean;
  asOf: string;
}

export interface RunResult {
  examined: number;
  differences: number;
  opened: number;
  unchanged: number;
  settledAlready: number;
  noOwner: number;
}

// ---- reading the answer ---------------------------------------------------------------------------------------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const oneOf = <T extends string>(value: unknown, list: readonly T[]): T | undefined => list.find((item) => item === value);

function toResolution(raw: unknown): Resolution | null {
  const one = record(raw);
  const kind = oneOf(one.kind, RESOLUTIONS);
  if (kind === undefined) return null;
  return {
    kind,
    resolvedByName: text(one.resolved_by_name),
    resolvedAt: text(one.resolved_at),
    reason: text(one.reason) ?? '',
    evidenceRef: text(one.evidence_ref),
    reviewOn: text(one.review_on),
    followUp: text(one.follow_up) ?? '',
  };
}

export function toItem(raw: unknown): ReconcileItem[] {
  const row = record(raw);
  const id = text(row.id);
  const subjectType = oneOf(row.subject_type, SUBJECTS);
  const state = oneOf(row.state, STATES);
  const field = text(row.field);
  const externalCode = text(row.external_code);
  if (id === null || subjectType === undefined || state === undefined || field === null || externalCode === null) return [];
  const actions = record(row.actions);
  return [
    {
      id,
      subjectType,
      subjectCode: text(row.subject_code) ?? '',
      externalCode,
      field,
      differenceKind: oneOf(row.difference_kind, ['VALUE_MISMATCH', 'MISSING_OURS', 'MISSING_THEIRS'] as const) ?? 'VALUE_MISMATCH',
      ours: text(row.ours),
      theirs: text(row.theirs),
      delta: text(row.delta),
      state,
      ownerName: text(row.owner_name),
      openedAt: text(row.opened_at) ?? '',
      dueAt: text(row.due_at) ?? '',
      overdue: row.overdue === true,
      resolution: toResolution(row.resolution),
      version: typeof row.version === 'number' ? row.version : 0,
      isMaker: row.is_maker === true,
      canResolve: actions.resolve === true,
    },
  ];
}

export function toPage(raw: unknown): ReconcilePage {
  const page = record(raw);
  if (!Array.isArray(page.items)) throw new Error('reconciliation-page-invalid');
  const counts = record(page.counts);
  const byResolution = record(counts.by_resolution);
  const due = record(page.due_rule);
  const actions = record(page.actions);
  return {
    items: page.items.flatMap(toItem),
    nextCursor: text(page.next_cursor),
    counts: {
      open: count(counts.open),
      resolved: count(counts.resolved),
      overdue: count(counts.overdue),
      waiversDue: count(counts.waivers_due),
      byResolution: { ACCEPT_EXTERNAL: count(byResolution.ACCEPT_EXTERNAL), CORRECT_OURS: count(byResolution.CORRECT_OURS), DISPUTE: count(byResolution.DISPUTE), WAIVE: count(byResolution.WAIVE) },
    },
    dueRule: {
      days: count(due.days),
      version: count(due.version),
      source: due.source === 'RULE' ? 'RULE' : 'DEFAULT',
      unverified: due.unverified !== false,
      legalStatus: text(due.legal_status) ?? '',
      formula: text(due.formula) ?? '',
      sourceText: text(due.source_text) ?? '',
      asOf: text(due.as_of) ?? '',
    },
    formula: text(page.formula) ?? '',
    source: text(page.source) ?? '',
    acceptance: text(page.acceptance) ?? 'PENDING_EXTERNAL',
    canRun: actions.run === true,
    asOf: text(page.as_of) ?? '',
  };
}

export function toRunResult(raw: unknown): RunResult {
  const result = record(raw);
  return { examined: count(result.examined), differences: count(result.differences), opened: count(result.opened), unchanged: count(result.unchanged), settledAlready: count(result.settled_already), noOwner: count(result.no_owner) };
}

export const totalOf = (counts: ReconcileCounts): number => counts.open + counts.resolved;

// ---- the filters, kept in the address -------------------------------------------------------------------------------------------------------------------------------------------

export interface Filters {
  state?: ItemState;
  subject_type?: ReconcileSubject;
  mine?: true;
  overdue?: true;
}

export function filtersOf(search: URLSearchParams): Filters {
  const filters: Filters = {};
  const state = oneOf(search.get('state'), STATES);
  if (state !== undefined) filters.state = state;
  const subject = oneOf(search.get('subject_type'), SUBJECTS);
  if (subject !== undefined) filters.subject_type = subject;
  if (search.get('mine') === 'true') filters.mine = true;
  if (search.get('overdue') === 'true') filters.overdue = true;
  return filters;
}

export function searchOf(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.state !== undefined) params.set('state', filters.state);
  if (filters.subject_type !== undefined) params.set('subject_type', filters.subject_type);
  if (filters.mine === true) params.set('mine', 'true');
  if (filters.overdue === true) params.set('overdue', 'true');
  return params;
}

export const appliedCount = (filters: Filters): number => Object.keys(filters).length;

/** The query of the list: the filters and the page size; the cursor is added per page. */
export const queryOf = (filters: Filters, cursor?: string): Record<string, string | number> => {
  const query: Record<string, string | number> = { limit: PAGE_SIZE };
  if (filters.state !== undefined) query.state = filters.state;
  if (filters.subject_type !== undefined) query.subject_type = filters.subject_type;
  if (filters.mine === true) query.mine = 'true';
  if (filters.overdue === true) query.overdue = 'true';
  if (cursor !== undefined) query.cursor = cursor;
  return query;
};

// ---- fields, days and numbers ---------------------------------------------------------------------------------------------------------------------------------------------

/** The fields that hold an amount in whole dong, and the ones that hold a day or a moment (shown as the day in Vietnam). */
export const MONEY_FIELDS: readonly string[] = ['estimated_price', 'award_price', 'total_investment', 'contract_price'];
export const DAY_FIELDS: readonly string[] = ['approved_on', 'published_at', 'bid_closing_at', 'bid_opening_at', 'signed_on'];

/** The day (Vietnam time) of today, as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dayNumber = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);

/** The number of whole days from `today` to `day`. */
export const daysBetween = (today: string, day: string): number => dayNumber(day) - dayNumber(today);

// ---- the resolution ---------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ResolveForm {
  kind: ResolutionKind;
  reason: string;
  evidenceRef: string;
  reviewOn: string;
}

export const EMPTY_RESOLVE: ResolveForm = { kind: 'ACCEPT_EXTERNAL', reason: '', evidenceRef: '', reviewOn: '' };

export type ResolveField = 'reason' | 'evidenceRef' | 'reviewOn';
export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'day' | 'notFuture' | 'tooFar';
export type FormErrors = Partial<Record<ResolveField, FieldProblem>>;

/** The rules of `resolveReconciliationItem` that can be checked without the data: the reason is long enough for the kind, a dispute names its letter, a waiver names a day after today and within a year. */
export function validateResolve(form: ResolveForm, today: string): FormErrors {
  const errors: FormErrors = {};
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < MIN_REASON[form.kind]) errors.reason = 'tooShort';
  else if (reason.length > MAX_REASON) errors.reason = 'tooLong';
  if (form.kind === 'DISPUTE') {
    const evidence = form.evidenceRef.trim();
    if (evidence === '') errors.evidenceRef = 'required';
    else if (evidence.length > MAX_EVIDENCE) errors.evidenceRef = 'tooLong';
  }
  if (form.kind === 'WAIVE') {
    if (form.reviewOn === '') errors.reviewOn = 'required';
    else if (!isDay(form.reviewOn)) errors.reviewOn = 'day';
    else if (form.reviewOn <= today) errors.reviewOn = 'notFuture';
    else if (daysBetween(today, form.reviewOn) > WAIVER_MAX_DAYS) errors.reviewOn = 'tooFar';
  }
  return errors;
}

export interface ResolveBody {
  kind: ResolutionKind;
  reason: string;
  evidence_ref?: string;
  review_on?: string;
}

export function resolveBody(form: ResolveForm, reason: string): ResolveBody {
  return {
    kind: form.kind,
    reason: reason.trim(),
    ...(form.kind === 'DISPUTE' ? { evidence_ref: form.evidenceRef.trim() } : {}),
    ...(form.kind === 'WAIVE' ? { review_on: form.reviewOn } : {}),
  };
}

// ---- what a refusal of the server means -------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind = 'selfApproval' | 'versionConflict' | 'stateInvalid' | 'validation' | 'calendar' | 'forbidden' | 'notFound' | 'general';

export interface Problem {
  kind: ProblemKind;
  /** The field of the form a VALIDATION_FAILED names, when it names one. */
  field: 'reason' | 'evidenceRef' | 'reviewOn' | 'kind' | 'subject' | 'owner' | undefined;
}

const FIELD_NAMES: ReadonlyArray<[string, NonNullable<Problem['field']>]> = [
  ['evidence_ref', 'evidenceRef'],
  ['review_on', 'reviewOn'],
  ['reason', 'reason'],
  ['kind', 'kind'],
  ['subject_type', 'subject'],
  ['owner_id', 'owner'],
];

export const fieldOfDetail = (detail: string | undefined): Problem['field'] => {
  const lower = (detail ?? '').toLowerCase();
  let best: { at: number; field: NonNullable<Problem['field']> } | undefined;
  for (const [name, field] of FIELD_NAMES) {
    const at = lower.indexOf(name);
    if (at >= 0 && (best === undefined || at < best.at)) best = { at, field };
  }
  return best?.field;
};

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined };
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return { kind: 'selfApproval', field: undefined };
    case 'VERSION_CONFLICT':
      return { kind: 'versionConflict', field: undefined };
    case 'EGP_RECONCILIATION_STATE_INVALID':
      return { kind: 'stateInvalid', field: undefined };
    case 'CALENDAR_NOT_EFFECTIVE':
      return { kind: 'calendar', field: undefined };
    case 'VALIDATION_FAILED':
      return { kind: 'validation', field: fieldOfDetail(error.detail) };
    case 'RESOURCE_NOT_FOUND':
      return { kind: 'notFound', field: undefined };
    default:
      return { kind: error.status === 403 ? 'forbidden' : 'general', field: undefined };
  }
}
