import { ApiError } from '@machvon/api-client';
import type { Tone } from '../../../ui';

/** The read models of PRJ-31 to PRJ-34 as the API answers them (the controllers of apps/api/src/modules/prj name every field). */

export interface NoticeView {
  state: 'NOT_STARTED' | 'PENDING' | 'DUE_SOON' | 'OVERDUE' | 'SENT_ON_TIME' | 'SENT_LATE';
  due_on: string | null;
  days_left: number | null;
  days_late: number | null;
  sent_on: string | null;
  sent_by: string | null;
  note: string | null;
}

export interface SummaryView {
  feedback_total: number;
  open: number;
  overdue: number;
  answered_on_time_pct: number | null;
}

export interface FileView {
  id: string;
  project_id: string;
  project_code: string | null;
  project_name: string | null;
  status: 'OPEN' | 'CLOSED';
  trigger: { kind: string; on: string | null; reason: string | null } | null;
  notice_days: number | null;
  notice_rule_version: number | null;
  notice: NoticeView;
  closed_at: string | null;
  version: number;
}

export interface FileListItem extends FileView {
  summary: SummaryView;
}

export interface FileList {
  as_of: string;
  items: FileListItem[];
  has_more: boolean;
}

export interface PackItem {
  id: string;
  item: string;
  document_id: string;
  document_kind: string;
  title: string;
  sha256: string | null;
  added_at: string;
}

export interface ResponseView {
  state: 'NOT_DUE' | 'DUE_SOON' | 'OVERDUE' | 'ON_TIME' | 'LATE';
  due_on: string;
  days_left: number | null;
  days_late: number | null;
}

export interface FeedbackView {
  id: string;
  file_id: string;
  reference: string;
  received_on: string;
  channel: string;
  topic: string;
  from_label: string | null;
  summary: string;
  status: 'RECEIVED' | 'IN_REVIEW' | 'RESPONDED' | 'CLOSED' | 'OUT_OF_SCOPE';
  response_days: number;
  rule_version: number;
  owner_id: string | null;
  response_text: string | null;
  responded_on: string | null;
  responded_by: string | null;
  closed_by: string | null;
  declined_reason: string | null;
  response: ResponseView;
  version: number;
}

export interface RuleView {
  version: number;
  unverified: boolean;
  notice_days_now: number;
  response_days_now: number;
  reminder_days: number;
}

export interface FileDetail extends FileView {
  as_of: string;
  pack: { present: string[]; missing: string[]; required_missing: string[]; complete: boolean; items: PackItem[] };
  summary: SummaryView;
  feedback: FeedbackView[];
  rule: RuleView;
}

export interface PortalSettings {
  slug: string;
  enabled: boolean;
  whistle_enabled: boolean;
  title: string;
  publisher_name: string;
  id_prefix: string;
  license_uri: string;
  policy_uri: string;
  allowed_fields: string[];
  rate_per_minute: number;
  page_size_max: number;
  policy_rule_version: number;
  whistle: { acknowledge_days: number; resolve_days: number; rate_per_hour: number; rule_version: number };
  updated_at: string;
  version: number;
}

export interface PortalSettingsRead {
  as_of: string;
  settings: PortalSettings | null;
  catalogue: string[];
  rule: { version: number; unverified: boolean; allowed_fields: string[]; rate_per_minute: number; page_size_max: number };
}

export interface PortalRecord {
  project_id: string;
  public_code: string;
  fields: Record<string, string | number | null>;
  fields_sha256: string;
  revision: number;
  published_at: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  version: number;
}

export interface PortalRecordList {
  as_of: string;
  items: PortalRecord[];
  has_more: boolean;
}

export interface Oc4idsIssue {
  path: string;
  problem: 'MISSING' | 'WRONG_TYPE' | 'NOT_IN_CODELIST';
}

export interface Oc4idsExport {
  as_of: string;
  version: string;
  required_fields: string[];
  lists: { source: string; legal_status: string };
  complete: boolean;
  issues: Oc4idsIssue[];
  package: { projects: unknown[] } & Record<string, unknown>;
}

export interface PublicPortalInfo {
  as_of: string;
  title: string;
  publisher: string;
  license_uri: string;
  publication_policy_uri: string;
  record_count: number;
  last_published_at: string | null;
  fields: string[];
  reports_open: boolean;
  oc4ids_version: string;
}

export interface PublicProject {
  code: string;
  revision: number;
  published_at: string;
  fields: Record<string, string | number | null>;
}

export interface PublicProjects {
  as_of: string;
  items: PublicProject[];
  next_after: string | null;
}

export interface PublicOc4ids {
  as_of: string;
  package: Record<string, unknown>;
  next_after: string | null;
}

export interface SubmittedReport {
  access_code: string;
  received_on: string;
  acknowledge_due_on: string;
  resolve_due_on: string;
  shown_once: boolean;
}

export interface ReportStatus {
  as_of: string;
  category: string;
  status: string;
  received_on: string;
  acknowledged_on: string | null;
  closed_on: string | null;
  note: string | null;
  acknowledge_due_on: string | null;
  resolve_due_on: string | null;
  thread: Array<{ seq: number; from: 'HANDLER' | 'YOU'; body: string; sent_on: string }>;
}

export const PACK_ITEMS = ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE', 'BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT'] as const;
export const REQUIRED_ITEMS: readonly string[] = ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE'];
export const TRIGGERS = ['INVESTMENT_DECISION', 'WORKS_START', 'MANUAL'] as const;
export const CHANNELS = ['LETTER', 'MEETING', 'HOTLINE', 'EMAIL', 'PORTAL'] as const;
export const TOPICS = ['QUALITY', 'SCHEDULE', 'COST', 'LAND', 'ENVIRONMENT', 'SAFETY', 'OTHER'] as const;
export const SECTORS = ['transport', 'transport.road', 'transport.rail', 'transport.air', 'transport.water', 'energy', 'water', 'sanitation', 'health', 'education', 'housing', 'agriculture', 'telecommunications', 'urban', 'environment', 'other'] as const;
export const PROJECT_TYPES = ['construction', 'expansion', 'maintenance', 'rehabilitation', 'replacement'] as const;
export const PURPOSES = ['social', 'economic', 'environmental', 'other'] as const;
export const REPORT_CATEGORIES = ['CORRUPTION', 'PROCUREMENT_IRREGULARITY', 'WASTE_OF_FUNDS', 'SAFETY', 'CONFLICT_OF_INTEREST', 'RETALIATION', 'OTHER'] as const;
export const REASON_MIN = 5;

/** `ANSWERED_ON_TIME` as `answeredOnTime`, the last segment of a message key. */
export const word = (code: string): string => code.toLowerCase().replace(/[._]([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** `2027-02-15` as `15/02/2027`; the day is a business day in Vietnam and is never converted. */
export function dayText(day: string | null | undefined): string {
  if (day === null || day === undefined || day === '') return '–';
  const [year, month, date] = day.slice(0, 10).split('-');
  return `${date}/${month}/${year}`;
}

/** An ISO instant as day and time in Vietnam. */
export function vietnamDateTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString();
  return `${dayText(shifted.slice(0, 10))} ${shifted.slice(11, 16)}`;
}

/** Whole dong written in groups of three with dots (the form that Vietnamese readers use). */
export function dongText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export const noticeTone = (state: NoticeView['state']): Tone => (state === 'OVERDUE' || state === 'SENT_LATE' ? 'danger' : state === 'DUE_SOON' ? 'warning' : state === 'SENT_ON_TIME' ? 'success' : 'neutral');
export const responseTone = (state: ResponseView['state']): Tone => (state === 'OVERDUE' || state === 'LATE' ? 'danger' : state === 'DUE_SOON' ? 'warning' : state === 'ON_TIME' ? 'success' : 'neutral');
export const feedbackTone = (status: FeedbackView['status']): Tone => (status === 'CLOSED' ? 'success' : status === 'RESPONDED' ? 'info' : status === 'OUT_OF_SCOPE' ? 'neutral' : 'warning');

export interface Refusal {
  code: string;
  status: number;
  detail: string | undefined;
  retryAfter: number | undefined;
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) return { code: error.code, status: error.status, detail: error.detail, retryAfter: typeof error.extensions.retry_after === 'number' ? error.extensions.retry_after : undefined };
  return { code: 'UNKNOWN', status: 0, detail: undefined, retryAfter: undefined };
}

/** The message key (without the head) of the sentence that says why a command or a public call was refused. */
export function refusalKey(error: unknown): string {
  const code = refusalOf(error).code;
  switch (code) {
    case 'VERSION_CONFLICT':
    case 'SCOPE_DENIED':
    case 'SELF_APPROVAL_DENIED':
    case 'VALIDATION_FAILED':
    case 'RATE_LIMIT':
    case 'RESOURCE_NOT_FOUND':
    case 'MONITORING_NOTICE_NOT_STARTED':
    case 'MONITORING_NOTICE_ALREADY_SENT':
    case 'MONITORING_PACK_INCOMPLETE':
    case 'MONITORING_FEEDBACK_STATE_INVALID':
    case 'MONITORING_FILE_CLOSED':
    case 'MONITORING_TRIGGER_SET':
    case 'MONITORING_PACK_DUPLICATE':
    case 'MONITORING_FEEDBACK_OPEN':
    case 'PORTAL_NOT_PUBLISHABLE':
    case 'PORTAL_NOT_CONFIGURED':
    case 'PORTAL_SLUG_TAKEN':
    case 'PORTAL_RECORD_WITHDRAWN':
    case 'WHISTLE_STATE_INVALID':
      return word(code);
    default:
      return 'generic';
  }
}

export const hasRight = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** One move on a community feedback, as `getMonitoringFeedback` writes it (append-only). */
export interface FeedbackEvent {
  id: string;
  move: 'RECEIVED' | 'TAKE' | 'RESPOND' | 'CLOSE' | 'REOPEN' | 'DECLINE';
  from_status: string | null;
  to_status: string;
  actor_id: string;
  reason: string | null;
  at: string;
}

export interface FeedbackHistoryRead extends FeedbackView {
  as_of: string;
  history: FeedbackEvent[];
}
