export type Severity = 'URGENT' | 'ACTION' | 'WATCH';
export type AlertView = 'mine' | 'scope';
export type Lifecycle = 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
export type WorkSource = 'APPROVAL' | 'EXPLANATION' | 'EXPLANATION_CONCLUDE' | 'REPORT' | 'OBLIGATION' | 'EARLY_WARNING' | 'ADVANCE' | 'PERMIT' | 'AUDIT_RECOMMENDATION' | 'ISSUE' | 'SITE_DIARY' | 'GUARANTEE';

export const SEVERITIES: readonly Severity[] = ['URGENT', 'ACTION', 'WATCH'];
export const LIFECYCLES: readonly Lifecycle[] = ['NEW', 'CLAIMED', 'IN_PROGRESS', 'RESOLVED'];
export const WORK_SOURCES: readonly WorkSource[] = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE'];

export interface AlertEscalation {
  level: number;
  of: number;
  next_at: string | null;
  chain: string[];
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
}

export interface AlertCounts {
  urgent: number;
  action: number;
  watch: number;
  total: number;
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
  };
}

export function toAlertCounts(raw: unknown): AlertCounts | null {
  if (!isRecord(raw)) return null;
  const urgent = count(raw.urgent);
  const action = count(raw.action);
  const watch = count(raw.watch);
  return { urgent, action, watch, total: typeof raw.total === 'number' ? count(raw.total) : urgent + action + watch };
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
