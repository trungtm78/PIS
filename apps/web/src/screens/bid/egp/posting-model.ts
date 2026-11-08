import { ApiError } from '@machvon/api-client';

/**
 * BID-32, "Posting obligations": the pure part. The answer of the API is read defensively, the filters live in the address, and the rules of each command are checked here before the server checks them again.
 * A duty is something the investor must post on the national procurement network by a deadline; a person posts by hand and writes down what the network answered. The platform never posts.
 */

export const KINDS = ['PLAN', 'NOTICE', 'RESULT', 'CONTRACT_INFO', 'CONTRACTOR_PERFORMANCE', 'VIOLATION', 'REPUTATION_EVENT', 'CONTRACTOR_RESPONSE'] as const;
export type PostingKind = (typeof KINDS)[number];

export const STATES = ['DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED'] as const;
export type PostingState = (typeof STATES)[number];

export const GROUPS = ['OPEN', 'SUBMITTED', 'CLOSED'] as const;
export type PostingGroup = (typeof GROUPS)[number];

export const CLOCKS = ['OVERDUE', 'DUE_SOON'] as const;
export type ClockFilter = (typeof CLOCKS)[number];

export type ClockStatus = 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'MET' | 'MET_LATE' | 'CANCELLED';
export type Severity = 'URGENT' | 'ACTION';

/** The kinds whose packet is the file of the contractor export of CTR-24 (the evaluation of the contractor and its violations). */
export const EXPORT_KINDS: readonly PostingKind[] = ['CONTRACTOR_PERFORMANCE', 'VIOLATION'];
export const PREPARE_PERMISSION = 'bid.egp.post.prepare';
export const SUBMIT_PERMISSION = 'bid.egp.post.submit';
export const PAGE_SIZE = 50;
export const MIN_REJECT_REASON = 10;
export const MIN_CANCEL_REASON = 20;
export const MAX_REASON = 1000;
export const MAX_FIELD = 2000;
export const MAX_RECEIPT = 100;
export const MAX_CODE = 100;
export const CTR_EXPORT_PATH = '/ctr/ctr-24';

export interface PostingRow {
  id: string;
  kind: PostingKind;
  obligation: string | null;
  subjectCode: string;
  dueAt: string;
  remindBeforeDays: number;
  ruleVersion: number;
  ruleSource: 'RULE' | 'DEFAULT';
  legalStatus: 'UNVERIFIED' | 'VERIFIED';
  state: PostingState;
  clock: ClockStatus;
  msToDue: number | null;
  alert: string | null;
  severity: Severity | null;
  ownerName: string | null;
  preparedByName: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
  receiptRef: string | null;
  receiptedAt: string | null;
  packetSha256: string | null;
  exportBatchId: string | null;
  exportBatchStatus: string | null;
  version: number;
  actions: { prepare: boolean; submit: boolean; receipt: boolean; reject: boolean; cancel: boolean };
}

export interface PostingCounts {
  total: number;
  byState: Record<PostingState, number>;
  overdue: number;
  dueSoon: number;
  met: number;
  metLate: number;
}

export interface Provenance {
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  legalStatus: string;
  formula: string;
  sourceText: string;
  asOf: string;
}

export interface PostingPage {
  items: PostingRow[];
  nextCursor: string | null;
  counts: PostingCounts;
  onTime: { met: number; metLate: number; overdue: number; rateBp: number | null; formula: string; source: string };
  severityRule: Provenance & { urgentWithinHours: number };
  acceptance: string;
  actions: { sweep: boolean; open: boolean; prepare: boolean; submit: boolean };
  asOf: string;
}

export interface HistoryLine {
  id: string;
  action: string;
  actorName: string | null;
  reason: string | null;
  stateAfter: string;
  occurredAt: string;
}

export interface PostingDetail {
  obligation: PostingRow;
  history: HistoryLine[];
  requiredFields: string[];
  suggestedFields: Record<string, string>;
  deadlineRule: Provenance & { dueIn: number | null; dueUnit: string };
  asOf: string;
}

export interface SweepResult {
  sinceOn: string;
  opened: number;
  existing: number;
  truncated: boolean;
}

// ---- reading the answer ---------------------------------------------------------------------------------------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const oneOf = <T extends string>(value: unknown, list: readonly T[]): T | undefined => list.find((item) => item === value);

export function toRow(raw: unknown): PostingRow[] {
  const row = record(raw);
  const id = text(row.id);
  const kind = oneOf(row.kind, KINDS);
  const state = oneOf(row.state, STATES);
  const dueAt = text(row.due_at);
  if (id === null || kind === undefined || state === undefined || dueAt === null) return [];
  const clock = record(row.clock);
  const actions = record(row.actions);
  return [
    {
      id,
      kind,
      obligation: text(row.obligation),
      subjectCode: text(row.subject_code) ?? '',
      dueAt,
      remindBeforeDays: count(row.remind_before_days),
      ruleVersion: count(row.rule_version),
      ruleSource: row.rule_source === 'RULE' ? 'RULE' : 'DEFAULT',
      legalStatus: row.legal_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
      state,
      clock: oneOf(clock.status, ['ON_TIME', 'DUE_SOON', 'OVERDUE', 'MET', 'MET_LATE', 'CANCELLED'] as const) ?? 'ON_TIME',
      msToDue: typeof clock.ms_to_due === 'number' ? clock.ms_to_due : null,
      alert: text(row.alert),
      severity: oneOf(row.severity, ['URGENT', 'ACTION'] as const) ?? null,
      ownerName: text(row.owner_name),
      preparedByName: text(row.prepared_by_name),
      submittedByName: text(row.submitted_by_name),
      submittedAt: text(row.submitted_at),
      rejectionReason: text(row.rejection_reason),
      cancelReason: text(row.cancel_reason),
      receiptRef: text(row.receipt_ref),
      receiptedAt: text(row.receipted_at),
      packetSha256: text(row.packet_sha256),
      exportBatchId: text(row.export_batch_id),
      exportBatchStatus: text(row.export_batch_status),
      version: typeof row.version === 'number' ? row.version : 0,
      actions: { prepare: actions.prepare === true, submit: actions.submit === true, receipt: actions.receipt === true, reject: actions.reject === true, cancel: actions.cancel === true },
    },
  ];
}

const provenanceOf = (raw: unknown): Provenance => {
  const one = record(raw);
  return {
    version: count(one.version),
    source: one.source === 'RULE' ? 'RULE' : 'DEFAULT',
    unverified: one.unverified !== false,
    legalStatus: text(one.legal_status) ?? '',
    formula: text(one.formula) ?? '',
    sourceText: text(one.source_text) ?? '',
    asOf: text(one.as_of) ?? '',
  };
};

export function toPage(raw: unknown): PostingPage {
  const page = record(raw);
  if (!Array.isArray(page.items)) throw new Error('posting-page-invalid');
  const counts = record(page.counts);
  const byState = record(counts.by_state);
  const onTime = record(page.on_time);
  const severity = record(page.severity_rule);
  const actions = record(page.actions);
  return {
    items: page.items.flatMap(toRow),
    nextCursor: text(page.next_cursor),
    counts: {
      total: count(counts.total),
      byState: Object.fromEntries(STATES.map((state) => [state, count(byState[state])])) as Record<PostingState, number>,
      overdue: count(counts.overdue),
      dueSoon: count(counts.due_soon),
      met: count(counts.met),
      metLate: count(counts.met_late),
    },
    onTime: { met: count(onTime.met), metLate: count(onTime.met_late), overdue: count(onTime.overdue), rateBp: typeof onTime.rate_bp === 'number' ? onTime.rate_bp : null, formula: text(onTime.formula) ?? '', source: text(onTime.source) ?? '' },
    severityRule: { ...provenanceOf(severity), urgentWithinHours: count(severity.urgent_within_hours) },
    acceptance: text(page.acceptance) ?? 'PENDING_EXTERNAL',
    actions: { sweep: actions.sweep === true, open: actions.open === true, prepare: actions.prepare === true, submit: actions.submit === true },
    asOf: text(page.as_of) ?? '',
  };
}

export function toDetail(raw: unknown): PostingDetail {
  const detail = record(raw);
  const rows = toRow(detail.obligation);
  if (rows[0] === undefined) throw new Error('posting-detail-invalid');
  const rule = record(detail.deadline_rule);
  const params = record(rule.params);
  const suggested = record(detail.suggested_fields);
  return {
    obligation: rows[0],
    history: (Array.isArray(detail.history) ? detail.history : []).flatMap((entry): HistoryLine[] => {
      const line = record(entry);
      const id = text(line.id);
      return id === null ? [] : [{ id, action: text(line.action) ?? '', actorName: text(line.actor_name), reason: text(line.reason), stateAfter: text(line.state_after) ?? '', occurredAt: text(line.occurred_at) ?? '' }];
    }),
    requiredFields: (Array.isArray(detail.required_fields) ? detail.required_fields : []).flatMap((name) => (typeof name === 'string' ? [name] : [])),
    suggestedFields: Object.fromEntries(Object.entries(suggested).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : []))),
    deadlineRule: { ...provenanceOf(rule), dueIn: typeof params.due_in === 'number' ? params.due_in : null, dueUnit: text(params.due_unit) ?? '' },
    asOf: text(detail.as_of) ?? '',
  };
}

export function toSweepResult(raw: unknown): SweepResult {
  const result = record(raw);
  const outcomes = Array.isArray(result.outcomes) ? result.outcomes : [];
  return { sinceOn: text(result.since_on) ?? '', opened: count(result.opened), existing: count(result.existing), truncated: outcomes.some((outcome) => record(outcome).truncated === true) };
}

// ---- the filters, kept in the address -------------------------------------------------------------------------------------------------------------------------------------------

export interface Filters {
  group?: PostingGroup;
  kind?: PostingKind;
  clock?: ClockFilter;
  mine?: true;
}

export function filtersOf(search: URLSearchParams): Filters {
  const filters: Filters = {};
  const group = oneOf(search.get('group'), GROUPS);
  if (group !== undefined) filters.group = group;
  const kind = oneOf(search.get('kind'), KINDS);
  if (kind !== undefined) filters.kind = kind;
  const clock = oneOf(search.get('clock'), CLOCKS);
  if (clock !== undefined) filters.clock = clock;
  if (search.get('mine') === 'true') filters.mine = true;
  return filters;
}

export function searchOf(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.group !== undefined) params.set('group', filters.group);
  if (filters.kind !== undefined) params.set('kind', filters.kind);
  if (filters.clock !== undefined) params.set('clock', filters.clock);
  if (filters.mine === true) params.set('mine', 'true');
  return params;
}

export const appliedCount = (filters: Filters): number => Object.keys(filters).length;

/** The query of the list: the filters and the page size; the cursor is added per page. */
export const queryOf = (filters: Filters, cursor?: string): Record<string, string | number> => {
  const query: Record<string, string | number> = { limit: PAGE_SIZE };
  if (filters.group !== undefined) query.group = filters.group;
  if (filters.kind !== undefined) query.kind = filters.kind;
  if (filters.clock !== undefined) query.clock = filters.clock;
  if (filters.mine === true) query.mine = 'true';
  if (cursor !== undefined) query.cursor = cursor;
  return query;
};

// ---- days, times and numbers ----------------------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** The day (Vietnam time) of today, as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date): string => new Date(now.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
export const dayText = (day: string): string => (/^\d{4}-\d{2}-\d{2}/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day);
/** The day (Vietnam time) of an instant, as `dd/mm/yyyy`. */
export const instantDay = (instant: string): string => {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? instant : dayText(new Date(at + VIETNAM_OFFSET_MS).toISOString().slice(0, 10));
};
export const instantTime = (instant: string): string => {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? '' : new Date(at + VIETNAM_OFFSET_MS).toISOString().slice(11, 16);
};
export const stamp = (instant: string): string => (instant === '' ? '' : `${instantDay(instant)} ${instantTime(instant)}`.trim());

/** "12.5" for 12.5 hours; whole hours otherwise: the time left to a deadline, in the unit a person reads it in. */
export function timeLeft(ms: number): { unit: 'days' | 'hours' | 'minutes'; value: number } {
  const abs = Math.abs(ms);
  if (abs >= 86_400_000) return { unit: 'days', value: Math.floor(abs / 86_400_000) };
  if (abs >= 3_600_000) return { unit: 'hours', value: Math.floor(abs / 3_600_000) };
  return { unit: 'minutes', value: Math.max(1, Math.floor(abs / 60_000)) };
}

/** The on-time rate as a percentage with two decimals, from ten-thousandths: `6666` is `66,66%`. */
export function rateText(rateBp: number | null, locale: string): string | null {
  if (rateBp === null) return null;
  return `${(rateBp / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export const shortHash = (hash: string): string => `${hash.slice(0, 12)}…`;

// ---- the commands: what can be checked without the server -------------------------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'control' | 'day' | 'future' | 'time';
/** A control character other than the white space of a text (tab, line feed, carriage return). */
const hasControl = (value: string): boolean => [...value].some((char) => { const code = char.charCodeAt(0); return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127; });

export interface PrepareForm {
  fields: Record<string, string>;
  exportBatchId: string;
}

export type PrepareErrors = Record<string, FieldProblem>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A packet is the fields the kind needs, every one filled; or, for the contractor evaluation and the violations, the id of a batch of the export. The two are never both. */
export function validatePrepare(kind: PostingKind, required: readonly string[], form: PrepareForm, useBatch: boolean): PrepareErrors {
  const errors: PrepareErrors = {};
  if (useBatch) {
    if (!UUID.test(form.exportBatchId.trim())) errors.export_batch_id = form.exportBatchId.trim() === '' ? 'required' : 'tooShort';
    return errors;
  }
  for (const name of required) {
    const value = (form.fields[name] ?? '').trim();
    if (value === '') errors[name] = 'required';
    else if (value.length > MAX_FIELD) errors[name] = 'tooLong';
    else if (hasControl(value)) errors[name] = 'control';
  }
  return errors;
}

export function prepareBody(required: readonly string[], form: PrepareForm, useBatch: boolean): { fields?: Record<string, string>; export_batch_id?: string } {
  if (useBatch) return { export_batch_id: form.exportBatchId.trim().toLowerCase() };
  return { fields: Object.fromEntries(required.map((name) => [name, (form.fields[name] ?? '').trim()])) };
}

export interface ReceiptForm {
  receiptRef: string;
  /** `datetime-local` text in Vietnam time, or empty for "now". */
  receiptedAt: string;
}

export type ReceiptErrors = Partial<Record<'receiptRef' | 'receiptedAt', FieldProblem>>;

/** The instant a `datetime-local` text in Vietnam time stands for, or undefined. */
export function instantOfLocal(local: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (match === null || !isDay(match[1] as string)) return undefined;
  const at = new Date(`${match[1]}T${match[2]}:${match[3]}:00.000Z`);
  return Number.isNaN(at.getTime()) ? undefined : new Date(at.getTime() - VIETNAM_OFFSET_MS);
}

export function validateReceipt(form: ReceiptForm, now: Date, submittedAt: string | null): ReceiptErrors {
  const errors: ReceiptErrors = {};
  const ref = form.receiptRef.trim();
  if (ref === '') errors.receiptRef = 'required';
  else if (ref.length > MAX_RECEIPT) errors.receiptRef = 'tooLong';
  else if (hasControl(ref)) errors.receiptRef = 'control';
  if (form.receiptedAt !== '') {
    const at = instantOfLocal(form.receiptedAt);
    if (at === undefined) errors.receiptedAt = 'time';
    else if (at.getTime() > now.getTime()) errors.receiptedAt = 'future';
    else if (submittedAt !== null && at.getTime() < Date.parse(submittedAt)) errors.receiptedAt = 'day';
  }
  return errors;
}

export function receiptBody(form: ReceiptForm): { receipt_ref: string; receipted_at?: string } {
  const at = form.receiptedAt === '' ? undefined : instantOfLocal(form.receiptedAt);
  return { receipt_ref: form.receiptRef.trim(), ...(at === undefined ? {} : { receipted_at: at.toISOString() }) };
}

export interface OpenForm {
  kind: PostingKind;
  ourCode: string;
  projectCode: string;
  triggeredOn: string;
}

export const EMPTY_OPEN: OpenForm = { kind: 'NOTICE', ourCode: '', projectCode: '', triggeredOn: '' };
export type OpenField = 'ourCode' | 'projectCode' | 'triggeredOn';
export type OpenErrors = Partial<Record<OpenField, FieldProblem>>;
/** The kinds whose subject is a package: two packages of one code are told apart by the code of their project. */
export const PACKAGE_KINDS: readonly PostingKind[] = ['NOTICE', 'RESULT'];

export function validateOpen(form: OpenForm, today: string): OpenErrors {
  const errors: OpenErrors = {};
  const code = form.ourCode.trim();
  if (code === '') errors.ourCode = 'required';
  else if (code.length > MAX_CODE) errors.ourCode = 'tooLong';
  else if (hasControl(code)) errors.ourCode = 'control';
  if (form.projectCode.trim().length > 50) errors.projectCode = 'tooLong';
  if (form.triggeredOn === '') errors.triggeredOn = 'required';
  else if (!isDay(form.triggeredOn)) errors.triggeredOn = 'day';
  else if (form.triggeredOn > today) errors.triggeredOn = 'future';
  return errors;
}

export interface OpenBody {
  kind: PostingKind;
  our_code: string;
  our_project_code?: string;
  triggered_on: string;
}

export function openBody(form: OpenForm): OpenBody {
  const project = form.projectCode.trim();
  return { kind: form.kind, our_code: form.ourCode.trim(), ...(PACKAGE_KINDS.includes(form.kind) && project !== '' ? { our_project_code: project } : {}), triggered_on: form.triggeredOn };
}

export type SweepErrors = Partial<Record<'sinceOn', FieldProblem>>;
export function validateSweep(sinceOn: string, today: string): SweepErrors {
  if (sinceOn === '') return {};
  if (!isDay(sinceOn)) return { sinceOn: 'day' };
  return sinceOn > today ? { sinceOn: 'future' } : {};
}

export function reasonProblem(reason: string, min: number): FieldProblem | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < min) return 'tooShort';
  return trimmed.length > MAX_REASON ? 'tooLong' : undefined;
}

// ---- what a refusal of the server means -------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind = 'selfApproval' | 'versionConflict' | 'stateInvalid' | 'receiptDuplicate' | 'validation' | 'calendar' | 'forbidden' | 'notFound' | 'general';

export interface Problem {
  kind: ProblemKind;
  /** The field the refusal names, in the words of the form (`fields.<name>` for a field of the packet). */
  field: string | undefined;
}

const NAMES: ReadonlyArray<[string, string]> = [
  ['export_batch_id', 'export_batch_id'],
  ['receipt_ref', 'receiptRef'],
  ['receipted_at', 'receiptedAt'],
  ['triggered_on', 'triggeredOn'],
  ['our_project_code', 'projectCode'],
  ['our_code', 'ourCode'],
  ['since_on', 'sinceOn'],
  ['owner_id', 'owner'],
  ['reason', 'reason'],
  ['kind', 'kind'],
];

export function fieldOfDetail(detail: string | undefined): string | undefined {
  const lower = (detail ?? '').toLowerCase();
  const packet = /^fields\.(.+)$/.exec(lower);
  if (packet !== null) return packet[1];
  return NAMES.find(([name]) => lower.includes(name))?.[1];
}

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined };
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return { kind: 'selfApproval', field: undefined };
    case 'VERSION_CONFLICT':
      return { kind: 'versionConflict', field: undefined };
    case 'EGP_OBLIGATION_STATE_INVALID':
      return { kind: 'stateInvalid', field: undefined };
    case 'EGP_RECEIPT_DUPLICATE':
      return { kind: 'receiptDuplicate', field: 'receiptRef' };
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
