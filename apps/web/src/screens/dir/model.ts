/**
 * The view-models of the directives of the steering meetings (lane DIR-1, DIR-01 to DIR-05): what the API answers (snake_case) turned into plain objects, and the small pure rules the screens share
 * (order of the board, the shape of an id and of a day, who may press what). Nothing here reads a clock or a server.
 */
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean => value === true;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});

// -- Constants ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The statuses a reader sees (OVERDUE is an open directive past its due day: it is not stored). */
export const STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'OVERDUE', 'CANCELLED'] as const;
export type DirectiveStatus = (typeof STATUSES)[number];
/** The columns of the board: what is late first, then what is being done, then what has ended. */
export const BOARD_ORDER: readonly DirectiveStatus[] = ['OVERDUE', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
export const MEETING_TYPES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'EXTRAORDINARY', 'SITE_VISIT', 'OTHER'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];
export type Phase = 'DUE_LATER' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'ESCALATED' | 'ENDED';
const PHASES: readonly Phase[] = ['DUE_LATER', 'DUE_SOON', 'DUE_TODAY', 'OVERDUE', 'ESCALATED', 'ENDED'];
export const PAGE_SIZE = 20;
export const COLUMN_PAGE_SIZE = 10;

export const DIRECTIVE_PATH = '/dir/dir-04';
export const MEETING_PATH = '/dir/dir-02';
export const MEETING_LIST_PATH = '/dir/dir-01';
export const BOARD_PATH = '/dir/dir-03';
export const PERIOD_PATH = '/dir/dir-05';
export const directivePath = (id: string): string => `${DIRECTIVE_PATH}?directive=${id}`;
export const meetingPath = (id: string): string => `${MEETING_PATH}?meeting=${id}`;

/** The permissions of the commands, as the contract names them (x-permission). */
export const PERMISSION = { meeting: 'directive.meeting.manage', manage: 'directive.manage' } as const;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

// -- Shapes -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface Unit {
  id: string;
  code: string;
  name: string;
}
export interface Person {
  membershipId: string;
  displayName: string;
}

export interface Policy {
  code: string;
  version: number | null;
  source: 'DEFAULT' | 'RULE';
  /** The numbers are the built-in starting values nobody confirmed. */
  unverified: boolean;
  reminderDaysBefore: number[];
  escalateAfterOverdueDays: number;
  maxExtensions: number;
  maxExtensionDays: number;
  closeRequiresEvidence: boolean;
}

export interface DirectiveLine {
  id: string;
  code: string;
  seq: number;
  meeting: { id: string; code: string; meetingDate: string; title: string };
  scopeKind: 'PROJECT' | 'UNIT';
  project: { id: string; code: string; name: string } | null;
  scopeUnit: Unit;
  text: string;
  assigneeUnit: Unit;
  assignee: Person | null;
  originalDueOn: string;
  dueOn: string;
  extensionCount: number;
  status: DirectiveStatus;
  storedStatus: string;
  phase: Phase;
  daysToDue: number | null;
  overdueDays: number | null;
  reminderToday: boolean;
  escalatesOn: string | null;
  closedAt: string | null;
  evidenceCount: number;
  openExtension: { id: string; proposedDueOn: string; requestedBy: string; version: number } | null;
  createdBy: Person;
  createdAt: string;
  version: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | undefined;
  asOf: string;
}

export interface MeetingLine {
  id: string;
  code: string;
  meetingDate: string;
  meetingType: MeetingType;
  title: string;
  summary: string | null;
  unit: Unit;
  minutesDocumentVersionId: string | null;
  version: number;
  total: number;
  byStatus: Record<DirectiveStatus, number>;
}

export interface TimelineEvent {
  id: string;
  type: string;
  actor: Person;
  occurredAt: string;
  note: string | null;
  progressPct: number | null;
  fromAssigneeUnit: Unit | null;
  toAssigneeUnit: Unit | null;
  fromDueOn: string | null;
  toDueOn: string | null;
  extensionId: string | null;
  approver: Person | null;
}

export interface Extension {
  id: string;
  fromDueOn: string;
  proposedDueOn: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  requestedBy: Person;
  requestedAt: string;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface Evidence {
  id: string;
  documentVersionId: string;
  title: string | null;
  addedBy: Person;
  addedAt: string;
}

export interface DirectiveActions {
  assign: boolean;
  recordProgress: boolean;
  requestExtension: boolean;
  decideExtension: boolean;
  close: boolean;
  cancel: boolean;
  reopen: boolean;
}

export interface DirectiveDetail {
  directive: DirectiveLine;
  timeline: TimelineEvent[];
  extensions: Extension[];
  evidence: Evidence[];
  policy: Policy;
  actions: DirectiveActions;
  asOf: string;
}

export interface MeetingDetail {
  meeting: MeetingLine;
  directives: DirectiveLine[];
  truncated: boolean;
  actions: { addDirective: boolean; attachMinutes: boolean };
  policy: Policy;
  asOf: string;
}

export interface Summary {
  total: number;
  byStatus: Record<DirectiveStatus, number>;
  dueSoon: number;
  escalated: number;
  byUnit: Array<{ unit: Unit; total: number; open: number; overdue: number; done: number }>;
  truncated: boolean;
  definitions: Record<string, string>;
  policy: Policy;
  asOf: string;
}

export interface ReportItem {
  id: string;
  code: string;
  meeting: { id: string; code: string; meetingDate: string };
  scopeKind: 'PROJECT' | 'UNIT';
  project: { id: string; code: string; name: string } | null;
  text: string;
  assigneeUnit: Unit;
  dueOnAtEnd: string;
  statusAtEnd: DirectiveStatus;
  raisedInPeriod: boolean;
  closedInPeriod: boolean;
  extendedInPeriod: boolean;
  openAtEnd: boolean;
  lastNote: string | null;
  lastNoteOn: string | null;
}

export interface Report {
  from: string;
  to: string;
  counts: { total: number; raised: number; closed: number; extended: number; openAtEnd: number; overdueAtEnd: number; byStatus: Record<DirectiveStatus, number> };
  items: ReportItem[];
  truncated: boolean;
  definitions: Record<string, string>;
  asOf: string;
}

export interface Widget {
  counts: { overdue: number; dueSoon: number; escalated: number; open: number };
  items: DirectiveLine[];
  truncated: boolean;
  definitions: Record<string, string>;
  policy: Policy;
  asOf: string;
}

// -- Parsers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const toUnit = (raw: unknown): Unit => {
  const row = rec(raw);
  return { id: str(row.id), code: str(row.code), name: str(row.name) };
};
const toUnitOrNull = (raw: unknown): Unit | null => (isRecord(raw) && str(raw.id) !== '' ? toUnit(raw) : null);
const toPerson = (raw: unknown): Person => {
  const row = rec(raw);
  return { membershipId: str(row.membership_id), displayName: str(row.display_name) };
};
const toPersonOrNull = (raw: unknown): Person | null => (isRecord(raw) && str(raw.membership_id) !== '' ? toPerson(raw) : null);

export const emptyCounts = (): Record<DirectiveStatus, number> => ({ OPEN: 0, IN_PROGRESS: 0, DONE: 0, OVERDUE: 0, CANCELLED: 0 });

function toCounts(raw: unknown): Record<DirectiveStatus, number> {
  const row = rec(raw);
  const counts = emptyCounts();
  for (const status of STATUSES) counts[status] = num(row[status]);
  return counts;
}

export function toPolicy(raw: unknown): Policy {
  const row = rec(raw);
  return {
    code: str(row.code) || 'DEFAULT',
    version: numOrNull(row.version),
    source: row.source === 'RULE' ? 'RULE' : 'DEFAULT',
    unverified: row.unverified !== false,
    reminderDaysBefore: Array.isArray(row.reminder_days_before) ? row.reminder_days_before.filter((value): value is number => typeof value === 'number') : [],
    escalateAfterOverdueDays: num(row.escalate_after_overdue_days),
    maxExtensions: num(row.max_extensions),
    maxExtensionDays: num(row.max_extension_days),
    closeRequiresEvidence: row.close_requires_evidence !== false,
  };
}

export function toDirective(raw: unknown): DirectiveLine | undefined {
  if (!isRecord(raw) || str(raw.id) === '') return undefined;
  const status = oneOf(raw.status, STATUSES);
  if (status === undefined) return undefined;
  const meeting = rec(raw.meeting);
  const project = isRecord(raw.project) ? raw.project : undefined;
  const extension = isRecord(raw.open_extension) ? raw.open_extension : undefined;
  return {
    id: str(raw.id),
    code: str(raw.code),
    seq: num(raw.seq),
    meeting: { id: str(meeting.id), code: str(meeting.code), meetingDate: str(meeting.meeting_date), title: str(meeting.title) },
    scopeKind: raw.scope_kind === 'UNIT' ? 'UNIT' : 'PROJECT',
    project: project === undefined ? null : { id: str(project.id), code: str(project.code), name: str(project.name) },
    scopeUnit: toUnit(raw.scope_unit),
    text: str(raw.text),
    assigneeUnit: toUnit(raw.assignee_unit),
    assignee: toPersonOrNull(raw.assignee),
    originalDueOn: str(raw.original_due_on),
    dueOn: str(raw.due_on),
    extensionCount: num(raw.extension_count),
    status,
    storedStatus: str(raw.stored_status),
    phase: oneOf(raw.phase, PHASES) ?? 'DUE_LATER',
    daysToDue: numOrNull(raw.days_to_due),
    overdueDays: numOrNull(raw.overdue_days),
    reminderToday: bool(raw.reminder_today),
    escalatesOn: strOrNull(raw.escalates_on),
    closedAt: strOrNull(raw.closed_at),
    evidenceCount: num(raw.evidence_count),
    openExtension: extension === undefined ? null : { id: str(extension.id), proposedDueOn: str(extension.proposed_due_on), requestedBy: str(extension.requested_by), version: num(extension.version) },
    createdBy: toPerson(raw.created_by),
    createdAt: str(raw.created_at),
    version: num(raw.version),
  };
}

function page<T>(raw: unknown, parse: (item: unknown) => T | undefined): Page<T> {
  const row = rec(raw);
  return { items: (Array.isArray(row.items) ? row.items : []).flatMap((item) => parse(item) ?? []), nextCursor: strOrNull(row.next_cursor) ?? undefined, asOf: str(row.as_of) };
}

export const toDirectivePage = (raw: unknown): Page<DirectiveLine> => page(raw, toDirective);

export function toMeeting(raw: unknown): MeetingLine | undefined {
  if (!isRecord(raw) || str(raw.id) === '') return undefined;
  const type = oneOf(raw.meeting_type, MEETING_TYPES) ?? 'OTHER';
  const counts = rec(raw.counts);
  return {
    id: str(raw.id),
    code: str(raw.code),
    meetingDate: str(raw.meeting_date),
    meetingType: type,
    title: str(raw.title),
    summary: strOrNull(raw.summary),
    unit: toUnit(raw.unit),
    minutesDocumentVersionId: strOrNull(raw.minutes_document_version_id),
    version: num(raw.version),
    total: num(counts.total),
    byStatus: toCounts(counts.by_status),
  };
}

export const toMeetingPage = (raw: unknown): Page<MeetingLine> => page(raw, toMeeting);

export function toMeetingDetail(raw: unknown): MeetingDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const meeting = toMeeting(raw.meeting);
  if (meeting === undefined) return undefined;
  const actions = rec(raw.actions);
  return {
    meeting,
    directives: (Array.isArray(raw.directives) ? raw.directives : []).flatMap((item) => toDirective(item) ?? []),
    truncated: bool(raw.truncated),
    actions: { addDirective: bool(actions.add_directive), attachMinutes: bool(actions.attach_minutes) },
    policy: toPolicy(raw.policy),
    asOf: str(raw.as_of),
  };
}

function toEvent(raw: Raw): TimelineEvent {
  return {
    id: str(raw.id),
    type: str(raw.type),
    actor: toPerson(raw.actor),
    occurredAt: str(raw.occurred_at),
    note: strOrNull(raw.note),
    progressPct: numOrNull(raw.progress_pct),
    fromAssigneeUnit: toUnitOrNull(raw.from_assignee_unit),
    toAssigneeUnit: toUnitOrNull(raw.to_assignee_unit),
    fromDueOn: strOrNull(raw.from_due_on),
    toDueOn: strOrNull(raw.to_due_on),
    extensionId: strOrNull(raw.extension_id),
    approver: toPersonOrNull(raw.approver),
  };
}

function toExtension(raw: Raw): Extension {
  const status = oneOf(raw.status, ['REQUESTED', 'APPROVED', 'REJECTED'] as const) ?? 'REQUESTED';
  return {
    id: str(raw.id),
    fromDueOn: str(raw.from_due_on),
    proposedDueOn: str(raw.proposed_due_on),
    reason: str(raw.reason),
    status,
    requestedBy: toPerson(raw.requested_by),
    requestedAt: str(raw.requested_at),
    decidedBy: toPersonOrNull(raw.decided_by),
    decidedAt: strOrNull(raw.decided_at),
    decisionReason: strOrNull(raw.decision_reason),
    version: num(raw.version),
  };
}

export function toDirectiveDetail(raw: unknown): DirectiveDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const directive = toDirective(raw.directive);
  if (directive === undefined) return undefined;
  const actions = rec(raw.actions);
  return {
    directive,
    timeline: list(raw.timeline).map(toEvent),
    extensions: list(raw.extensions).map(toExtension),
    evidence: list(raw.evidence).map((item) => ({ id: str(item.id), documentVersionId: str(item.document_version_id), title: strOrNull(item.title), addedBy: toPerson(item.added_by), addedAt: str(item.added_at) })),
    policy: toPolicy(raw.policy),
    actions: {
      assign: bool(actions.assign),
      recordProgress: bool(actions.record_progress),
      requestExtension: bool(actions.request_extension),
      decideExtension: bool(actions.decide_extension),
      close: bool(actions.close),
      cancel: bool(actions.cancel),
      reopen: bool(actions.reopen),
    },
    asOf: str(raw.as_of),
  };
}

const toDefinitions = (raw: unknown): Record<string, string> => {
  const row = rec(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) if (typeof value === 'string') out[key] = value;
  return out;
};

export function toSummary(raw: unknown): Summary | undefined {
  if (!isRecord(raw) || typeof raw.total !== 'number') return undefined;
  return {
    total: raw.total,
    byStatus: toCounts(raw.by_status),
    dueSoon: num(raw.due_soon),
    escalated: num(raw.escalated),
    byUnit: list(raw.by_unit).map((row) => ({ unit: toUnit(row.unit), total: num(row.total), open: num(row.open), overdue: num(row.overdue), done: num(row.done) })),
    truncated: bool(raw.truncated),
    definitions: toDefinitions(raw.definitions),
    policy: toPolicy(raw.policy),
    asOf: str(raw.as_of),
  };
}

export function toReport(raw: unknown): Report | undefined {
  if (!isRecord(raw) || !isRecord(raw.counts) || !isRecord(raw.period)) return undefined;
  const counts = raw.counts;
  return {
    from: str(raw.period.from),
    to: str(raw.period.to),
    counts: { total: num(counts.total), raised: num(counts.raised), closed: num(counts.closed), extended: num(counts.extended), openAtEnd: num(counts.open_at_end), overdueAtEnd: num(counts.overdue_at_end), byStatus: toCounts(counts.by_status) },
    items: list(raw.items).flatMap((item): ReportItem[] => {
      const status = oneOf(item.status_at_end, STATUSES);
      if (status === undefined || str(item.id) === '') return [];
      const meeting = rec(item.meeting);
      const project = isRecord(item.project) ? item.project : undefined;
      return [
        {
          id: str(item.id),
          code: str(item.code),
          meeting: { id: str(meeting.id), code: str(meeting.code), meetingDate: str(meeting.meeting_date) },
          scopeKind: item.scope_kind === 'UNIT' ? 'UNIT' : 'PROJECT',
          project: project === undefined ? null : { id: str(project.id), code: str(project.code), name: str(project.name) },
          text: str(item.text),
          assigneeUnit: toUnit(item.assignee_unit),
          dueOnAtEnd: str(item.due_on_at_end),
          statusAtEnd: status,
          raisedInPeriod: bool(item.raised_in_period),
          closedInPeriod: bool(item.closed_in_period),
          extendedInPeriod: bool(item.extended_in_period),
          openAtEnd: bool(item.open_at_end),
          lastNote: strOrNull(item.last_note),
          lastNoteOn: strOrNull(item.last_note_on),
        },
      ];
    }),
    truncated: bool(raw.truncated),
    definitions: toDefinitions(raw.definitions),
    asOf: str(raw.as_of),
  };
}

export function toWidget(raw: unknown): Widget | undefined {
  if (!isRecord(raw) || !isRecord(raw.counts)) return undefined;
  const counts = raw.counts;
  return {
    counts: { overdue: num(counts.overdue), dueSoon: num(counts.due_soon), escalated: num(counts.escalated), open: num(counts.open) },
    items: (Array.isArray(raw.items) ? raw.items : []).flatMap((item) => toDirective(item) ?? []),
    truncated: bool(raw.truncated),
    definitions: toDefinitions(raw.definitions),
    policy: toPolicy(raw.policy),
    asOf: str(raw.as_of),
  };
}

export interface LookupOption {
  id: string;
  label: string;
}

/** A unit, a project or a member of a lookup list (`get_resources_*`): rows without an id are dropped. */
export function toLookup(raw: unknown, kind: 'unit' | 'project' | 'member'): LookupOption[] {
  if (!isRecord(raw) || str(raw.id) === '') return [];
  const label = kind === 'member' ? str(raw.display_name) : [str(raw.code), str(raw.name)].filter((part) => part !== '').join(' · ');
  return label === '' ? [] : [{ id: str(raw.id), label }];
}

// -- Pure rules ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The shape of an id that the address may carry. */
export function idFrom(value: string | null): string | undefined {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** `2026-11-08T03:00:00.000Z` as `03:00 08/11/2026` (the time the server gave; not converted). */
export function asOfText(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return match === null ? value : `${match[4]}:${match[5]} ${match[3]}/${match[2]}/${match[1]}`;
}

/** `2026-11-08` as `08/11/2026`. */
export function dayText(value: string | null): string {
  if (value === null) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match === null ? value : `${match[3]}/${match[2]}/${match[1]}`;
}

const isDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};
export { isDay };

export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The Vietnam day of an instant. */
export const vietnamDay = (instant: Date): string => new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export const statusTone = (status: DirectiveStatus): Tone => (status === 'OVERDUE' ? 'danger' : status === 'DONE' ? 'success' : status === 'IN_PROGRESS' ? 'info' : status === 'CANCELLED' ? 'neutral' : 'warning');
export const phaseTone = (phase: Phase): Tone => (phase === 'ESCALATED' || phase === 'OVERDUE' ? 'danger' : phase === 'DUE_TODAY' || phase === 'DUE_SOON' ? 'warning' : 'neutral');

/** Whether the person may be offered a command: a read-only session never is; a session whose permissions are not known is (the server decides). */
export function can(permissions: readonly string[] | undefined, mode: string | undefined, permission: string): boolean {
  if (mode === 'READ_ONLY') return false;
  return permissions === undefined || permissions.includes(permission);
}

/** The ids typed in a field, separated by commas, spaces or lines: distinct, lower case; `invalid` lists what is not an id. */
export function parseIds(value: string): { ids: string[]; invalid: string[] } {
  const parts = value.split(/[\s,;]+/).filter((part) => part !== '');
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const id = idFrom(part);
    if (id === undefined) invalid.push(part);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

export interface FilterState {
  status: DirectiveStatus | '';
  unitId: string;
  projectId: string;
  meetingId: string;
  assignedToMe: boolean;
  overdue: boolean;
  q: string;
  dueFrom: string;
  dueTo: string;
}

export const NO_FILTER: FilterState = { status: '', unitId: '', projectId: '', meetingId: '', assignedToMe: false, overdue: false, q: '', dueFrom: '', dueTo: '' };

/** The query of a list read: only what is set. */
export function queryOf(filter: FilterState, extra: Record<string, string | number> = {}): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = { ...extra };
  if (filter.status !== '') query.status = filter.status;
  if (filter.unitId !== '') query.unit_id = filter.unitId;
  if (filter.projectId !== '') query.project_id = filter.projectId;
  if (filter.meetingId !== '') query.meeting_id = filter.meetingId;
  if (filter.assignedToMe) query.assigned_to_me = true;
  if (filter.overdue) query.overdue = true;
  if (filter.q.trim() !== '') query.q = filter.q.trim();
  if (filter.dueFrom !== '') query.due_from = filter.dueFrom;
  if (filter.dueTo !== '') query.due_to = filter.dueTo;
  return query;
}

/** The number of conditions applied. */
export const appliedCount = (filter: FilterState): number => Object.values(filter).filter((value) => value !== '' && value !== false).length;

/** Filters that the summary does not take (it counts by unit, project and meeting only): a column header cannot show the total of the summary when one of these is set. */
export const narrowsBeyondSummary = (filter: FilterState): boolean => filter.assignedToMe || filter.overdue || filter.q.trim() !== '' || filter.dueFrom !== '' || filter.dueTo !== '';

/** The columns a board shows: all of them, or the one the status filter names. */
export const columnsOf = (filter: FilterState): readonly DirectiveStatus[] => (filter.status === '' ? BOARD_ORDER : [filter.status]);

/** Why a proposed day for an extension cannot be sent, as a key suffix; undefined when it can. */
export function extensionProblem(currentDueOn: string, proposed: string, policy: Policy, extensionCount: number): 'day' | 'order' | 'days' | 'limit' | undefined {
  if (!isDay(proposed)) return 'day';
  if (proposed <= currentDueOn) return 'order';
  if (policy.maxExtensionDays > 0 && daysBetween(currentDueOn, proposed) > policy.maxExtensionDays) return 'days';
  if (policy.maxExtensions > 0 && extensionCount >= policy.maxExtensions) return 'limit';
  return undefined;
}

/** The days a period ends on and begins on when none is chosen: the last thirty days up to `today`. */
export const defaultPeriod = (today: string): { from: string; to: string } => ({ from: addDays(today, -30), to: today });
