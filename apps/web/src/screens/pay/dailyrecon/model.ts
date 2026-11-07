import { isUuid } from '../../ctr/change/model';

export { describeProblem, differenceText, vndText } from '../recon/model';
export type { MemberOption, Refusal, Resolution } from '../recon/model';

/** PAY-20: the daily reconciliation with the Treasury by project code and fund (G4-4). */
export const DAILY_PATH = '/pay/pay-20';
export const READ_PERMISSION = 'treasury.daily_recon.read';
export const RUN_PERMISSION = 'treasury.daily_recon.run';
export const ASSIGN_PERMISSION = 'treasury.daily_recon.assign';
export const RESOLVE_PERMISSION = 'treasury.daily_recon.resolve';
export const MEMBER_READ_PERMISSION = 'membership.read';

export const RUN_STATUSES = ['COMPLETE', 'PARTIAL'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const PARTIAL_REASONS = ['STATEMENT_MISSING', 'SOURCE_UNREADABLE'] as const;
export type PartialReason = (typeof PARTIAL_REASONS)[number];
export const LINE_KINDS = ['TIMING', 'UNMATCHED', 'MISSING_ON_TREASURY', 'MISSING_INTERNAL', 'AMOUNT'] as const;
export type LineKind = (typeof LINE_KINDS)[number];
export const ITEM_STATUSES = ['OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED', 'AUTO_CLEARED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const DAY_STATES = ['NO_RUN', 'COMPLETE', 'PARTIAL'] as const;
export type DayState = (typeof DAY_STATES)[number];

const SIGNED = /^-?(0|[1-9][0-9]{0,23})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const signed = (value: unknown): string | undefined => (typeof value === 'string' && SIGNED.test(value) ? value : undefined);
const nullableSigned = (value: unknown): string | null => signed(value) ?? null;

/** The thresholds the pass used (or, for the page, those in force today) and whether the numbers are a starting value nobody confirmed. */
export interface ReconRule {
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  thresholdVnd: string;
  thresholdPct: number | null;
  dueDays: number;
  partialAfterDays: number;
}

export function toRule(raw: unknown): ReconRule | undefined {
  const row = asRecord(raw);
  const version = whole(row?.version);
  const source = row?.source === 'RULE' || row?.source === 'DEFAULT' ? row.source : undefined;
  const threshold = signed(row?.threshold_vnd);
  const dueDays = whole(row?.due_days);
  const partial = whole(row?.partial_after_days);
  if (row === undefined || version === undefined || source === undefined || threshold === undefined || dueDays === undefined || partial === undefined) return undefined;
  return { version, source, unverified: row.unverified === true, thresholdVnd: threshold, thresholdPct: typeof row.threshold_pct === 'number' ? row.threshold_pct : typeof row.threshold_pct === 'string' ? Number(row.threshold_pct) : null, dueDays, partialAfterDays: partial };
}

export interface Run {
  id: string;
  reconDate: string;
  runNo: number;
  status: RunStatus;
  partialReason: PartialReason | null;
  statementImports: number;
  transactionCount: number;
  lineCount: number;
  differenceLineCount: number;
  openedItems: number;
  clearedItems: number;
  /** Null for a reader who sees only a part of the projects. */
  booksTotalVnd: string | null;
  treasuryTotalVnd: string | null;
  rule: ReconRule;
  calendarBasis: 'WORK_CALENDAR' | 'WEEKDAYS_ASSUMED';
  origin: 'JOB' | 'MANUAL';
  createdAt: string;
}

export function toRun(raw: unknown): Run | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const reconDate = text(row?.recon_date);
  const runNo = whole(row?.run_no);
  const status = RUN_STATUSES.find((candidate) => candidate === row?.status);
  const rule = toRule(row?.rule);
  if (row === undefined || id === undefined || reconDate === undefined || !DAY.test(reconDate) || runNo === undefined || status === undefined || rule === undefined) return undefined;
  return {
    id,
    reconDate,
    runNo,
    status,
    partialReason: PARTIAL_REASONS.find((candidate) => candidate === row.partial_reason) ?? null,
    statementImports: whole(row.statement_imports) ?? 0,
    transactionCount: whole(row.transaction_count) ?? 0,
    lineCount: whole(row.line_count) ?? 0,
    differenceLineCount: whole(row.difference_line_count) ?? 0,
    openedItems: whole(row.opened_items) ?? 0,
    clearedItems: whole(row.cleared_items) ?? 0,
    booksTotalVnd: nullableSigned(row.books_total_vnd),
    treasuryTotalVnd: nullableSigned(row.treasury_total_vnd),
    rule,
    calendarBasis: row.calendar_basis === 'WEEKDAYS_ASSUMED' ? 'WEEKDAYS_ASSUMED' : 'WORK_CALENDAR',
    origin: row.origin === 'MANUAL' ? 'MANUAL' : 'JOB',
    createdAt: text(row.created_at) ?? '',
  };
}

export interface Line {
  id: string;
  projectId: string;
  projectCode: string;
  fundKey: string;
  fundLabel: string | null;
  booksVnd: string;
  treasuryVnd: string;
  differenceVnd: string;
  booksCount: number;
  treasuryCount: number;
  kind: LineKind | null;
  opensItem: boolean;
}

export function toLine(raw: unknown): Line | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const fundKey = text(row?.fund_key);
  const books = signed(row?.books_vnd);
  const treasury = signed(row?.treasury_vnd);
  const difference = signed(row?.difference_vnd);
  if (row === undefined || id === undefined || projectId === undefined || fundKey === undefined || books === undefined || treasury === undefined || difference === undefined) return undefined;
  return {
    id,
    projectId,
    projectCode: text(row.project_code) ?? '',
    fundKey,
    fundLabel: nullableText(row.fund_label),
    booksVnd: books,
    treasuryVnd: treasury,
    differenceVnd: difference,
    booksCount: whole(row.books_count) ?? 0,
    treasuryCount: whole(row.treasury_count) ?? 0,
    kind: LINE_KINDS.find((candidate) => candidate === row.kind) ?? null,
    opensItem: row.opens_item === true,
  };
}

export interface RunDetail {
  run: Run;
  lines: Line[];
  hiddenLines: number;
}

export function toRunDetail(value: unknown): RunDetail | undefined {
  const run = toRun(value);
  const row = asRecord(value);
  if (run === undefined || row === undefined) return undefined;
  return { run, lines: (Array.isArray(row.lines) ? row.lines : []).flatMap((line) => toLine(line) ?? []), hiddenLines: whole(row.hidden_lines) ?? 0 };
}

export interface DayRow {
  reconDate: string;
  state: DayState;
  partialReason: PartialReason | null;
  runNo: number | null;
  runId: string | null;
}

export interface RunsPage {
  items: Run[];
  today: string;
  rule: ReconRule | undefined;
  /** The state of each day of the range asked for, including the days that have no pass (the screen says so). */
  days: Array<{ reconDate: string; status: RunStatus; partialReason: PartialReason | null; runNo: number; runId: string }>;
}

export function toRunsPage(value: unknown): RunsPage {
  const row = asRecord(value);
  return {
    items: (Array.isArray(row?.items) ? row.items : []).flatMap((run) => toRun(run) ?? []),
    today: text(row?.today) ?? '',
    rule: toRule(row?.rule),
    days: (Array.isArray(row?.days) ? row.days : []).flatMap((entry) => {
      const day = asRecord(entry);
      const reconDate = text(day?.recon_date);
      const status = RUN_STATUSES.find((candidate) => candidate === day?.status);
      const runNo = whole(day?.run_no);
      const runId = text(day?.run_id);
      return day === undefined || reconDate === undefined || status === undefined || runNo === undefined || runId === undefined
        ? []
        : [{ reconDate, status, partialReason: PARTIAL_REASONS.find((candidate) => candidate === day.partial_reason) ?? null, runNo, runId }];
    }),
  };
}

const DAY_MS = 86_400_000;
export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The days of the range ending `today`, the latest first, each with the state of its latest pass; a day with no pass is NO_RUN, never "no difference". */
export function dayRows(page: RunsPage, length: number): DayRow[] {
  if (page.today === '') return [];
  const known = new Map(page.days.map((day) => [day.reconDate, day]));
  return Array.from({ length }, (_, index) => {
    const reconDate = addDays(page.today, -index);
    const found = known.get(reconDate);
    return found === undefined
      ? { reconDate, state: 'NO_RUN' as const, partialReason: null, runNo: null, runId: null }
      : { reconDate, state: found.status, partialReason: found.partialReason, runNo: found.runNo, runId: found.runId };
  });
}

export interface ReconItem {
  id: string;
  projectId: string;
  projectCode: string;
  fundKey: string;
  fundLabel: string | null;
  reconDate: string;
  kind: Exclude<LineKind, 'TIMING'>;
  status: ItemStatus;
  booksVnd: string;
  treasuryVnd: string;
  differenceVnd: string;
  latestDifferenceVnd: string;
  ownerMembershipId: string;
  ownerName: string | null;
  dueOn: string;
  overdue: boolean;
  resolutionNote: string | null;
  approvalDocumentVersionId: string | null;
  issueId: string | null;
  version: number;
  actions: { assign: boolean; explain: boolean; resolve: boolean; writeOff: boolean };
}

export function toItem(raw: unknown): ReconItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const fundKey = text(row?.fund_key);
  const reconDate = text(row?.recon_date);
  const kind = LINE_KINDS.find((candidate) => candidate === row?.kind && candidate !== 'TIMING') as ReconItem['kind'] | undefined;
  const status = ITEM_STATUSES.find((candidate) => candidate === row?.status);
  const books = signed(row?.books_vnd);
  const treasury = signed(row?.treasury_vnd);
  const difference = signed(row?.difference_vnd);
  const latest = signed(row?.latest_difference_vnd);
  const owner = text(row?.owner_membership_id);
  const dueOn = text(row?.due_on);
  const version = whole(row?.version);
  const actions = asRecord(row?.actions);
  if (row === undefined || id === undefined || projectId === undefined || fundKey === undefined || reconDate === undefined || kind === undefined || status === undefined || books === undefined || treasury === undefined || difference === undefined || latest === undefined || owner === undefined || dueOn === undefined || version === undefined || actions === undefined) return undefined;
  return {
    id,
    projectId,
    projectCode: text(row.project_code) ?? '',
    fundKey,
    fundLabel: nullableText(row.fund_label),
    reconDate,
    kind,
    status,
    booksVnd: books,
    treasuryVnd: treasury,
    differenceVnd: difference,
    latestDifferenceVnd: latest,
    ownerMembershipId: owner,
    ownerName: nullableText(row.owner_name),
    dueOn,
    overdue: row.overdue === true,
    resolutionNote: nullableText(row.resolution_note),
    approvalDocumentVersionId: nullableText(row.approval_document_version_id),
    issueId: nullableText(row.issue_id),
    version,
    actions: { assign: actions.assign === true, explain: actions.explain === true, resolve: actions.resolve === true, writeOff: actions.write_off === true },
  };
}

export interface ItemSummary {
  waiting: number;
  overdue: number;
  waitingDifferenceVnd: string;
}

export interface ItemsPage {
  items: ReconItem[];
  summary: ItemSummary;
}

export function toItemsPage(value: unknown): ItemsPage {
  const row = asRecord(value);
  const summary = asRecord(row?.summary);
  return {
    items: (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toItem(item) ?? []),
    summary: summary === undefined ? { waiting: 0, overdue: 0, waitingDifferenceVnd: '0' } : { waiting: whole(summary.waiting) ?? 0, overdue: whole(summary.overdue) ?? 0, waitingDifferenceVnd: signed(summary.waiting_difference_vnd) ?? '0' },
  };
}

export interface RunAnswer {
  id: string;
  reconDate: string;
  runStatus: RunStatus | null;
  partialReason: PartialReason | null;
  reused: boolean;
  lineCount: number;
  openedItems: number;
  clearedItems: number;
}

export function toRunAnswer(value: unknown): RunAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const reconDate = text(row?.recon_date);
  if (row === undefined || id === undefined || reconDate === undefined) return undefined;
  return {
    id,
    reconDate,
    runStatus: RUN_STATUSES.find((candidate) => candidate === row.run_status) ?? null,
    partialReason: PARTIAL_REASONS.find((candidate) => candidate === row.partial_reason) ?? null,
    reused: row.reused === true,
    lineCount: whole(row.line_count) ?? 0,
    openedItems: whole(row.opened_items) ?? 0,
    clearedItems: whole(row.cleared_items) ?? 0,
  };
}

export interface ItemAnswer {
  id: string;
  status: string;
  version: number;
}

export function toItemAnswer(value: unknown): ItemAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  if (row === undefined || id === undefined || version === undefined) return undefined;
  return { id, status: text(row.status) ?? '', version };
}

// ---- the commands -----------------------------------------------------------------------------------------------------------------

export type DailyProblem = 'required' | 'tooLong' | 'uuid' | 'invalid' | 'past' | 'future';

const isRealDay = (value: string): boolean => DAY.test(value) && new Date(Date.parse(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;

/** The day of a manual pass: a real day, not after today (Vietnam time). */
export function validateRunDay(day: string, today: string): DailyProblem | undefined {
  if (day.trim() === '') return 'required';
  if (!isRealDay(day.trim())) return 'invalid';
  return day.trim() > today ? 'future' : undefined;
}

export interface AssignForm {
  ownerId: string;
  dueOn: string;
}

export const EMPTY_ASSIGN: AssignForm = { ownerId: '', dueOn: '' };

export function validateAssign(form: AssignForm, today: string): Partial<Record<keyof AssignForm, DailyProblem>> {
  const problems: Partial<Record<keyof AssignForm, DailyProblem>> = {};
  if (form.ownerId.trim() === '') problems.ownerId = 'required';
  else if (!isUuid(form.ownerId.trim())) problems.ownerId = 'uuid';
  const due = form.dueOn.trim();
  if (due === '') problems.dueOn = 'required';
  else if (!isRealDay(due)) problems.dueOn = 'invalid';
  else if (due < today) problems.dueOn = 'past';
  return problems;
}

export const assignBody = (form: AssignForm): { owner_membership_id: string; due_on: string } => ({ owner_membership_id: form.ownerId.trim(), due_on: form.dueOn.trim() });

export interface ResolveForm {
  note: string;
  approvalDocumentVersionId: string;
}

export const EMPTY_RESOLVE: ResolveForm = { note: '', approvalDocumentVersionId: '' };

export function validateResolve(form: ResolveForm, resolution: 'EXPLAINED' | 'RESOLVED' | 'WRITTEN_OFF'): Partial<Record<keyof ResolveForm, DailyProblem>> {
  const problems: Partial<Record<keyof ResolveForm, DailyProblem>> = {};
  const note = form.note.trim();
  if (note === '') problems.note = 'required';
  else if (note.length > MAX_TEXT) problems.note = 'tooLong';
  if (resolution === 'WRITTEN_OFF') {
    const document = form.approvalDocumentVersionId.trim();
    if (document === '') problems.approvalDocumentVersionId = 'required';
    else if (!isUuid(document)) problems.approvalDocumentVersionId = 'uuid';
  }
  return problems;
}

export const resolveBody = (form: ResolveForm, resolution: 'EXPLAINED' | 'RESOLVED' | 'WRITTEN_OFF'): { resolution: typeof resolution; note: string; approval_document_version_id?: string } => ({
  resolution,
  note: form.note.trim(),
  ...(resolution === 'WRITTEN_OFF' ? { approval_document_version_id: form.approvalDocumentVersionId.trim() } : {}),
});

/** Whether an item still waits for a person. */
export const isWaiting = (item: Pick<ReconItem, 'status'>): boolean => item.status === 'OPEN' || item.status === 'EXPLAINED';

/** The lines that hold a difference to explain (a timing pair nets out and is not one). */
export const differingLines = (lines: readonly Line[]): Line[] => lines.filter((line) => line.kind !== null && line.kind !== 'TIMING');
