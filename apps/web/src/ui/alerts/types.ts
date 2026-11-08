export type Severity = 'URGENT' | 'ACTION' | 'WATCH';
export type AlertView = 'mine' | 'scope';
export type Lifecycle = 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
export type WorkSource = 'APPROVAL' | 'EXPLANATION' | 'EXPLANATION_CONCLUDE' | 'REPORT' | 'OBLIGATION' | 'EARLY_WARNING' | 'ADVANCE' | 'PERMIT' | 'AUDIT_RECOMMENDATION' | 'ISSUE' | 'SITE_DIARY' | 'GUARANTEE' | 'MONEY_CONTROL' | 'DIRECTIVE' | 'CLOCK' | 'PROCUREMENT_WORKFLOW' | 'TREASURY_RECON' | 'CROSS_TOTAL' | 'SOD_EXCEPTION' | 'PAYMENT_INTEGRITY' | 'DISBURSEMENT_EXCEPTION' | 'PROJECT_GOVERNANCE' | 'CONNECTOR' | 'EGP_POSTING';

export const SEVERITIES: readonly Severity[] = ['URGENT', 'ACTION', 'WATCH'];
export const LIFECYCLES: readonly Lifecycle[] = ['NEW', 'CLAIMED', 'IN_PROGRESS', 'RESOLVED'];
export const WORK_SOURCES: readonly WorkSource[] = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'EGP_POSTING'];
export type WorkSource = 'APPROVAL' | 'EXPLANATION' | 'EXPLANATION_CONCLUDE' | 'REPORT' | 'OBLIGATION' | 'EARLY_WARNING' | 'ADVANCE' | 'PERMIT' | 'AUDIT_RECOMMENDATION' | 'ISSUE' | 'SITE_DIARY' | 'GUARANTEE' | 'MONEY_CONTROL' | 'DIRECTIVE' | 'CLOCK' | 'PROCUREMENT_WORKFLOW' | 'TREASURY_RECON' | 'CROSS_TOTAL' | 'SOD_EXCEPTION' | 'PAYMENT_INTEGRITY' | 'DISBURSEMENT_EXCEPTION' | 'PROJECT_GOVERNANCE' | 'CONNECTOR' | 'VENDOR';

export const SEVERITIES: readonly Severity[] = ['URGENT', 'ACTION', 'WATCH'];
export const LIFECYCLES: readonly Lifecycle[] = ['NEW', 'CLAIMED', 'IN_PROGRESS', 'RESOLVED'];
export const WORK_SOURCES: readonly WorkSource[] = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'VENDOR'];
export type WorkSource = 'APPROVAL' | 'EXPLANATION' | 'EXPLANATION_CONCLUDE' | 'REPORT' | 'OBLIGATION' | 'EARLY_WARNING' | 'ADVANCE' | 'PERMIT' | 'AUDIT_RECOMMENDATION' | 'ISSUE' | 'SITE_DIARY' | 'GUARANTEE' | 'MONEY_CONTROL' | 'DIRECTIVE' | 'CLOCK' | 'PROCUREMENT_WORKFLOW' | 'TREASURY_RECON' | 'CROSS_TOTAL' | 'SOD_EXCEPTION' | 'PAYMENT_INTEGRITY' | 'DISBURSEMENT_EXCEPTION' | 'PROJECT_GOVERNANCE' | 'CONNECTOR' | 'CONTRACT_CLAIM' | 'CONTRACT_EARLY_WARNING';

export const SEVERITIES: readonly Severity[] = ['URGENT', 'ACTION', 'WATCH'];
export const LIFECYCLES: readonly Lifecycle[] = ['NEW', 'CLAIMED', 'IN_PROGRESS', 'RESOLVED'];
export const WORK_SOURCES: readonly WorkSource[] = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING'];
export type WorkSource = 'APPROVAL' | 'EXPLANATION' | 'EXPLANATION_CONCLUDE' | 'REPORT' | 'OBLIGATION' | 'EARLY_WARNING' | 'ADVANCE' | 'PERMIT' | 'AUDIT_RECOMMENDATION' | 'ISSUE' | 'SITE_DIARY' | 'GUARANTEE' | 'MONEY_CONTROL' | 'DIRECTIVE' | 'CLOCK' | 'PROCUREMENT_WORKFLOW' | 'TREASURY_RECON' | 'CROSS_TOTAL' | 'SOD_EXCEPTION' | 'PAYMENT_INTEGRITY' | 'DISBURSEMENT_EXCEPTION' | 'PROJECT_GOVERNANCE' | 'CONNECTOR' | 'RED_FLAG' | 'CONTRACT_CLOCK' | 'DOC_REVIEW' | 'DATA_FRESHNESS' | 'ANOMALY' | 'ALERT_FEEDBACK';

export const SEVERITIES: readonly Severity[] = ['URGENT', 'ACTION', 'WATCH'];
export const LIFECYCLES: readonly Lifecycle[] = ['NEW', 'CLAIMED', 'IN_PROGRESS', 'RESOLVED'];
export const WORK_SOURCES: readonly WorkSource[] = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'CONNECTOR', 'RED_FLAG', 'CONTRACT_CLOCK', 'DOC_REVIEW', 'DATA_FRESHNESS', 'ANOMALY', 'ALERT_FEEDBACK'];

export interface AlertEscalation {
  level: number;
  of: number;
  next_at: string | null;
  chain: string[];
}

export const CLOCK_STATES = ['RUNNING', 'PAUSED', 'MET', 'MET_LATE', 'BREACHED'] as const;
export type ClockState = (typeof CLOCK_STATES)[number];
export const CLOCK_BASES = ['WORKING_TIME', 'CALENDAR_UNAVAILABLE', 'NO_START'] as const;
export type ClockBasis = (typeof CLOCK_BASES)[number];
export const NOTICE_KINDS = ['REMINDER', 'RECLAIM_NOTICE', 'SNOOZE_FINAL_NOTICE'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** One clock of an item, counted in working hours on the published calendar. */
export interface Clock {
  state: ClockState;
  started_at: string | null;
  due_at: string;
  met_at: string | null;
}

export interface Person {
  id: string;
  name: string;
}

/** A pause of the clock of an item: who stopped it, why, who allowed it, until when. */
export interface Pause {
  from: string;
  until: string;
  resumed_at: string | null;
  reason_code: string;
  reason: string;
  allowed_by: Person | null;
  by: Person | null;
}

export interface WorkClocks {
  basis: ClockBasis;
  claim: Clock | null;
  resolve: Clock | null;
  paused: Pause | null;
  needs_reclaim: { since: string } | null;
}

/** The snooze that holds an item: who, until when, why, and which one of the allowed run it is. */
export interface SnoozeInfo {
  id: string;
  by: Person | null;
  until: string;
  at: string | null;
  reason_code: string | null;
  note: string | null;
  ordinal: number | null;
  of: number | null;
  final: boolean;
  policy_version: string | null;
}

export interface Reminders {
  sent: number;
  last_at: string | null;
  next_at: string | null;
  due: boolean;
  exhausted: boolean;
  every_working_hours: number | null;
}

export interface Notice {
  kind: NoticeKind;
  at: string;
}

/** The clock the module already keeps (DIS-20, PAY-12, …): shown as one line, never replaced. */
export interface ExistingClock {
  code: string;
  module: string;
  basis: 'CALENDAR_DAYS' | 'WORKING_TIME' | string;
  starts: string;
  stops: string;
  pauses: string;
  migrated: boolean;
}

/** One item of the alert centre as `GET /home/my-work` returns it (snake_case, see design.md). */
export interface AlertItem {
  id: string;
  kind: string;
  source: WorkSource | string;
  severity: Severity;
  title: string;
  subtitle: string | null;
  status: string;
  due_on: string | null;
  original_due_on: string | null;
  bucket: string;
  overdue: boolean;
  days_late: number;
  target: { screen: string; id: string };
  lifecycle: Lifecycle;
  claimed_by: { id: string; name: string; at: string } | null;
  assignee: { id: string; name: string; due_on: string | null } | null;
  escalation: AlertEscalation | null;
  consequence: string | null;
  snoozed_until: string | null;
  started_at: string | null;
  expected_action: string | null;
  /** Only the items of the source CLOCK carry the type of their obligation clock. */
  clock_type: string | null;
  policy_version: string | null;
  /** The native clocks of the item; null when it has none (the day-based deadline `due_on` is then what is shown). */
  clocks: WorkClocks | null;
  /** Taken up, then silent past the threshold: the claim button reads "Take back". */
  needs_reclaim: boolean;
  snooze: SnoozeInfo | null;
  snooze_count: number;
  pause: Pause | null;
  pauses: Pause[];
  reminders: Reminders | null;
  notices: Notice[];
  existing_clock: ExistingClock | null;
  /** G2-7: the person whose alert it is, when the reader holds it as their deputy. */
  on_behalf_of?: Person | null;
  /** G2-3: the severity the item came from when the escalation raised it one step (an item to be watched that aged untouched). */
  promoted_from?: Severity | null;
}

export interface AlertCounts {
  urgent: number;
  action: number;
  watch: number;
  total: number;
  /** Items taken up and then silent; present when the API counts them. */
  needs_reclaim?: number;
  /** Items held by a snooze; present when the API counts them. */
  snoozed?: number;
}

export interface AlertCountsAnswer {
  view: AlertView;
  counts: AlertCounts;
  unavailable_sources: string[];
  as_of: string | null;
}

export interface AlertListAnswer {
  view: AlertView;
  items: AlertItem[];
  /** The counts of the whole list (the API's `counts`), when it sends them. */
  counts: AlertCounts | null;
  unavailable_sources: string[];
  as_of: string | null;
  next_cursor: string | null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' ? allowed.find((entry) => entry === value) : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []);

function toEscalation(raw: unknown): AlertEscalation | null {
  if (!isRecord(raw)) return null;
  const level = count(raw.level);
  if (level === 0) return null;
  return { level, of: Math.max(count(raw.of), level), next_at: nullableText(raw.next_at), chain: strings(raw.chain) };
}

const person = (raw: unknown): Person | null => (isRecord(raw) && text(raw.name) !== '' ? { id: text(raw.id), name: text(raw.name) } : null);
const optionalCount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

function toClock(raw: unknown): Clock | null {
  if (!isRecord(raw)) return null;
  const dueAt = text(raw.due_at);
  if (dueAt === '') return null;
  return { state: oneOf(raw.state, CLOCK_STATES) ?? 'RUNNING', started_at: nullableText(raw.started_at), due_at: dueAt, met_at: nullableText(raw.met_at) };
}

export function toPause(raw: unknown): Pause | null {
  if (!isRecord(raw)) return null;
  const until = text(raw.until);
  if (until === '') return null;
  return {
    from: text(raw.from),
    until,
    resumed_at: nullableText(raw.resumed_at),
    reason_code: text(raw.reason_code),
    reason: text(raw.reason),
    allowed_by: person(raw.allowed_by),
    by: person(raw.by),
  };
}

function toWorkClocks(raw: unknown): WorkClocks | null {
  if (!isRecord(raw)) return null;
  const reclaim = isRecord(raw.needs_reclaim) && text(raw.needs_reclaim.since) !== '' ? { since: text(raw.needs_reclaim.since) } : null;
  return { basis: oneOf(raw.basis, CLOCK_BASES) ?? 'WORKING_TIME', claim: toClock(raw.claim), resolve: toClock(raw.resolve), paused: toPause(raw.paused), needs_reclaim: reclaim };
}

export function toSnoozeInfo(raw: unknown): SnoozeInfo | null {
  if (!isRecord(raw)) return null;
  const until = text(raw.until);
  if (until === '') return null;
  return {
    id: text(raw.id),
    by: person(raw.by),
    until,
    at: nullableText(raw.at),
    reason_code: nullableText(raw.reason_code),
    note: nullableText(raw.note),
    ordinal: optionalCount(raw.ordinal),
    of: optionalCount(raw.of),
    final: raw.final === true,
    policy_version: nullableText(raw.policy_version),
  };
}

function toReminders(raw: unknown): Reminders | null {
  if (!isRecord(raw)) return null;
  return { sent: count(raw.sent), last_at: nullableText(raw.last_at), next_at: nullableText(raw.next_at), due: raw.due === true, exhausted: raw.exhausted === true, every_working_hours: optionalCount(raw.every_working_hours) };
}

function toNotices(raw: unknown): Notice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Notice[] => {
    if (!isRecord(entry)) return [];
    const kind = oneOf(entry.kind, NOTICE_KINDS);
    return kind !== undefined && text(entry.at) !== '' ? [{ kind, at: text(entry.at) }] : [];
  });
}

function toExistingClock(raw: unknown): ExistingClock | null {
  if (!isRecord(raw) || text(raw.code) === '') return null;
  return { code: text(raw.code), module: text(raw.module), basis: text(raw.basis), starts: text(raw.starts), stops: text(raw.stops), pauses: text(raw.pauses), migrated: raw.migrated === true };
}

/** One item; a row that has not the shape of an item is dropped rather than shown half-filled. */
export function toAlertItem(raw: unknown): AlertItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  if (id === '' || text(raw.title) === '') return undefined;
  const claimed = isRecord(raw.claimed_by) && text(raw.claimed_by.name) !== '' ? { id: text(raw.claimed_by.id), name: text(raw.claimed_by.name), at: text(raw.claimed_by.at) } : null;
  const assignee = isRecord(raw.assignee) && text(raw.assignee.name) !== '' ? { id: text(raw.assignee.id), name: text(raw.assignee.name), due_on: nullableText(raw.assignee.due_on) } : null;
  const target = isRecord(raw.target) ? { screen: text(raw.target.screen), id: text(raw.target.id) } : { screen: '', id: '' };
  return {
    id,
    kind: text(raw.kind),
    source: text(raw.source) || text(raw.kind),
    severity: oneOf(raw.severity, SEVERITIES) ?? 'ACTION',
    title: text(raw.title),
    subtitle: nullableText(raw.subtitle),
    status: text(raw.status),
    due_on: nullableText(raw.due_on),
    original_due_on: nullableText(raw.original_due_on),
    bucket: text(raw.bucket),
    overdue: raw.overdue === true,
    days_late: count(raw.days_late),
    target,
    lifecycle: oneOf(raw.lifecycle, LIFECYCLES) ?? 'NEW',
    claimed_by: claimed,
    assignee,
    escalation: toEscalation(raw.escalation),
    consequence: nullableText(raw.consequence),
    snoozed_until: nullableText(raw.snoozed_until),
    started_at: nullableText(raw.started_at),
    expected_action: nullableText(raw.expected_action),
    clock_type: nullableText(raw.clock_type),
    policy_version: nullableText(raw.policy_version),
    clocks: toWorkClocks(raw.clocks),
    needs_reclaim: raw.needs_reclaim === true,
    snooze: toSnoozeInfo(raw.snooze),
    snooze_count: count(raw.snooze_count),
    pause: toPause(raw.pause),
    pauses: Array.isArray(raw.pauses) ? raw.pauses.flatMap((entry) => toPause(entry) ?? []) : [],
    reminders: toReminders(raw.reminders),
    notices: toNotices(raw.notices),
    existing_clock: toExistingClock(raw.existing_clock),
    on_behalf_of: isRecord(raw.on_behalf_of) && text(raw.on_behalf_of.id) !== '' ? { id: text(raw.on_behalf_of.id), name: text(raw.on_behalf_of.name) || text(raw.on_behalf_of.id) } : null,
    promoted_from: oneOf(raw.promoted_from, SEVERITIES) ?? null,
  };
}

export function toAlertCounts(raw: unknown): AlertCounts | null {
  if (!isRecord(raw)) return null;
  const urgent = count(raw.urgent);
  const action = count(raw.action);
  const watch = count(raw.watch);
  return {
    urgent,
    action,
    watch,
    total: typeof raw.total === 'number' ? count(raw.total) : urgent + action + watch,
    ...(typeof raw.needs_reclaim === 'number' ? { needs_reclaim: count(raw.needs_reclaim) } : {}),
    ...(typeof raw.snoozed === 'number' ? { snoozed: count(raw.snoozed) } : {}),
  };
}

const viewOf = (value: unknown, fallback: AlertView): AlertView => oneOf(value, ['mine', 'scope'] as const) ?? fallback;

/** The answer of `getMyWorkCounts`; undefined when it carries no counts. */
export function toCountsAnswer(raw: unknown, view: AlertView): AlertCountsAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  const counts = toAlertCounts(raw.counts);
  if (counts === null) return undefined;
  return { view: viewOf(raw.view, view), counts, unavailable_sources: strings(raw.unavailable_sources), as_of: nullableText(raw.as_of) };
}

/** The answer of `getMyWork`. */
export function toListAnswer(raw: unknown, view: AlertView): AlertListAnswer {
  const body = isRecord(raw) ? raw : {};
  return {
    view: viewOf(body.view, view),
    items: Array.isArray(body.items) ? body.items.flatMap((entry) => toAlertItem(entry) ?? []) : [],
    counts: toAlertCounts(body.counts),
    unavailable_sources: strings(body.unavailable_sources),
    as_of: nullableText(body.as_of),
    next_cursor: nullableText(body.next_cursor),
  };
}

/** The weight of a level for ordering: urgent first. */
export const severityRankOf = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** The reasons and limits of the snooze as the policy of the tenant publishes them (never hard-coded in a screen). */
export interface SnoozePolicy {
  version: string;
  unverified: boolean;
  reasons: string[];
  note_required_for: string[];
  max_days_by_severity: Record<Severity, number>;
  max_consecutive: number;
  final_notifies_next_level: boolean;
}

export interface ClockPolicy {
  version: string;
  unverified: boolean;
  max_pause_days: number;
  pause_reasons: string[];
}

export interface PolicyEntry {
  type: string;
  code: string;
  version: string;
  unverified: boolean;
  formula: string;
  source: string;
  as_of_rule: string;
  legal_status: string;
}

export interface WorkClockPolicies {
  as_of: string | null;
  snooze: SnoozePolicy;
  clock: ClockPolicy | null;
  entries: PolicyEntry[];
}

function toSnoozePolicy(row: Raw): SnoozePolicy | null {
  const params = isRecord(row.params) ? row.params : undefined;
  const days = params !== undefined && isRecord(params.max_days_by_severity) ? params.max_days_by_severity : undefined;
  if (params === undefined || days === undefined) return null;
  const reasons = strings(params.reasons);
  if (reasons.length === 0) return null;
  return {
    version: text(row.version),
    unverified: row.unverified === true,
    reasons,
    note_required_for: strings(params.note_required_for),
    max_days_by_severity: { URGENT: count(days.URGENT), ACTION: count(days.ACTION), WATCH: count(days.WATCH) },
    max_consecutive: count(params.max_consecutive),
    final_notifies_next_level: params.final_notifies_next_level === true,
  };
}

function toClockPolicy(row: Raw): ClockPolicy | null {
  const params = isRecord(row.params) ? row.params : undefined;
  if (params === undefined) return null;
  return { version: text(row.version), unverified: row.unverified === true, max_pause_days: count(params.max_pause_days), pause_reasons: strings(params.pause_reasons) };
}

/** The answer of `getWorkClockPolicies`; undefined when it carries no usable snooze policy (the dialogs cannot be built without it). */
export function toPolicies(raw: unknown): WorkClockPolicies | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.policies)) return undefined;
  const rows = raw.policies.filter(isRecord);
  const snoozeRow = rows.find((row) => row.type === 'SNOOZE_POLICY');
  const clockRow = rows.find((row) => row.type === 'CLOCK_POLICY');
  const snooze = snoozeRow === undefined ? null : toSnoozePolicy(snoozeRow);
  if (snooze === null) return undefined;
  return {
    as_of: nullableText(raw.as_of),
    snooze,
    clock: clockRow === undefined ? null : toClockPolicy(clockRow),
    entries: rows.map((row) => ({
      type: text(row.type),
      code: text(row.code),
      version: text(row.version),
      unverified: row.unverified === true,
      formula: text(row.formula),
      source: text(row.source),
      as_of_rule: text(row.as_of_rule),
      legal_status: text(row.legal_status),
    })),
  };
}

/** One row of the list of snoozed work (HOME-12). */
export interface SnoozedItem {
  source: WorkSource | string;
  source_id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  severity: Severity;
  due_on: string | null;
  target: { screen: string; id: string };
  snooze: SnoozeInfo;
  snooze_count: number;
}

export interface SnoozedAnswer {
  items: SnoozedItem[];
  count: number;
  truncated: boolean;
  unavailable_sources: string[];
  policy_version: string | null;
  as_of: string | null;
}

function toSnoozedItem(raw: unknown): SnoozedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const snooze = toSnoozeInfo(raw.snooze);
  const sourceId = text(raw.source_id);
  if (snooze === null || sourceId === '' || text(raw.title) === '') return undefined;
  const target = isRecord(raw.target) ? { screen: text(raw.target.screen), id: text(raw.target.id) } : { screen: '', id: '' };
  return {
    source: text(raw.source) || text(raw.kind),
    source_id: sourceId,
    kind: text(raw.kind),
    title: text(raw.title),
    subtitle: nullableText(raw.subtitle),
    severity: oneOf(raw.severity, SEVERITIES) ?? 'ACTION',
    due_on: nullableText(raw.due_on),
    target,
    snooze,
    snooze_count: count(raw.snooze_count),
  };
}

/** The answer of `getSnoozedWork`. */
export function toSnoozedAnswer(raw: unknown): SnoozedAnswer {
  const body = isRecord(raw) ? raw : {};
  const items = Array.isArray(body.items) ? body.items.flatMap((entry) => toSnoozedItem(entry) ?? []) : [];
  return {
    items,
    count: typeof body.count === 'number' ? count(body.count) : items.length,
    truncated: body.truncated === true,
    unavailable_sources: strings(body.unavailable_sources),
    policy_version: nullableText(body.policy_version),
    as_of: nullableText(body.as_of),
  };
}
