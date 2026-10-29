import { ApiError } from '@machvon/api-client';

export const INCIDENT_STATUSES = ['OPEN', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type WorkStatus = 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED_PENDING_VERIFICATION';
export type ExceptionStatus = 'OPEN' | 'RESOLVED' | 'WAIVED';

export const MEMBERS_PERMISSION = 'membership.read';
/** The longest a record may be waived for, in days (BR-DGV-06). */
export const MAX_WAIVER_DAYS = 180;
const MIN_TEXT = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IncidentEvent {
  id: string;
  kind: string;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  occurredAt: string;
}

export interface IncidentView {
  id: string;
  title: string;
  datasetId: string;
  datasetCode: string;
  ruleCode: string;
  severity: Severity;
  status: IncidentStatus;
  ownerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: string;
  slaHours: number | null;
  isOverdue: boolean;
  rootCause: string | null;
  remediation: string | null;
  verifiedAt: string | null;
  reopenedCount: number;
  version: number;
  actions: { assign: boolean; advance: WorkStatus | null; verify: boolean };
  events: IncidentEvent[];
}

export interface ExceptionView {
  id: string;
  datasetCode: string;
  incidentId: string | null;
  recordReference: unknown;
  masked: boolean;
  reason: string;
  status: ExceptionStatus;
  waiverReason: string | null;
  waiverExpiresAt: string | null;
  reopenedFromId: string | null;
  version: number;
  canDecide: boolean;
}

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export function toIncident(raw: unknown): IncidentView | undefined {
  const row = record(raw);
  if (row === undefined) return undefined;
  const dataset = record(row.dataset);
  const rule = record(row.rule);
  const status = oneOf(INCIDENT_STATUSES, row.status);
  const severity = oneOf(SEVERITIES, row.severity);
  const id = text(row.id);
  if (id === undefined || status === undefined || severity === undefined || typeof row.version !== 'number' || dataset === undefined) return undefined;
  const assignee = record(row.assignee);
  const owner = record(row.owner);
  const actions = record(row.actions) ?? {};
  const events = Array.isArray(row.events) ? row.events.flatMap((entry) => toEvent(entry) ?? []) : [];
  return {
    id,
    title: text(row.title) ?? id,
    datasetId: text(dataset.id) ?? '',
    datasetCode: text(dataset.code) ?? '',
    ruleCode: text(rule?.code) ?? '',
    severity,
    status,
    ownerName: text(owner?.name) ?? null,
    assigneeId: text(assignee?.id) ?? null,
    assigneeName: text(assignee?.name) ?? null,
    dueAt: text(row.due_at) ?? '',
    slaHours: typeof row.sla_hours === 'number' ? row.sla_hours : null,
    isOverdue: row.is_overdue === true,
    rootCause: text(row.root_cause) ?? null,
    remediation: text(row.remediation) ?? null,
    verifiedAt: text(row.verified_at) ?? null,
    reopenedCount: typeof row.reopened_count === 'number' ? row.reopened_count : 0,
    version: row.version,
    actions: { assign: actions.assign === true, advance: oneOf(['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION'] as const, actions.advance) ?? null, verify: actions.verify === true },
    events,
  };
}

function toEvent(raw: unknown): IncidentEvent | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const occurredAt = text(row?.occurred_at);
  if (row === undefined || id === undefined || occurredAt === undefined) return undefined;
  return { id, kind: text(row.kind) ?? '', actorName: text(record(row.actor)?.name) ?? null, fromStatus: text(row.from_status) ?? null, toStatus: text(row.to_status) ?? null, note: text(row.note) ?? null, occurredAt };
}

export function toException(raw: unknown): ExceptionView | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const status = oneOf(['OPEN', 'RESOLVED', 'WAIVED'] as const, row?.status);
  if (row === undefined || id === undefined || status === undefined || typeof row.version !== 'number') return undefined;
  return {
    id,
    datasetCode: text(record(row.dataset)?.code) ?? '',
    incidentId: text(row.incident_id) ?? null,
    recordReference: row.record_reference ?? null,
    masked: row.masked === true,
    reason: text(row.reason) ?? '',
    status,
    waiverReason: text(row.waiver_reason) ?? null,
    waiverExpiresAt: text(row.waiver_expires_at) ?? null,
    reopenedFromId: text(row.reopened_from_id) ?? null,
    version: row.version,
    canDecide: record(row.actions)?.decide === true,
  };
}

// ---- filter ----------------------------------------------------------------------------------------------------------------------

export interface IncidentFilter {
  status: string;
  severity: string;
  overdue: boolean;
  mine: boolean;
}

export const NO_FILTER: IncidentFilter = { status: '', severity: '', overdue: false, mine: false };

/** What the list asks of the server: only what was chosen; `me` is the membership of the viewer. */
export function filterQuery(filter: IncidentFilter, me: string | undefined): Record<string, string> {
  const query: Record<string, string> = {};
  if (INCIDENT_STATUSES.some((status) => status === filter.status)) query.status = filter.status;
  if (SEVERITIES.some((severity) => severity === filter.severity)) query.severity = filter.severity;
  if (filter.overdue) query.overdue = 'true';
  if (filter.mine && me !== undefined) query.assignee_id = me;
  return query;
}

// ---- forms ----------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooShort' | 'invalidId' | 'invalidDate' | 'pastDate' | 'tooFar';

const words = (value: string): number => value.normalize('NFC').trim().length;

export interface AssignForm {
  assigneeId: string;
  dueAt: string;
  note: string;
}
export const emptyAssign = (): AssignForm => ({ assigneeId: '', dueAt: '', note: '' });

/** The due time is a local date and time; it must be after now. */
export function validateAssign(form: AssignForm, now: Date): Partial<Record<keyof AssignForm, FormProblem>> {
  const problems: Partial<Record<keyof AssignForm, FormProblem>> = {};
  if (form.assigneeId === '') problems.assigneeId = 'required';
  else if (!UUID.test(form.assigneeId)) problems.assigneeId = 'invalidId';
  if (form.dueAt === '') problems.dueAt = 'required';
  else {
    const due = new Date(form.dueAt);
    if (Number.isNaN(due.getTime())) problems.dueAt = 'invalidDate';
    else if (due.getTime() <= now.getTime()) problems.dueAt = 'pastDate';
  }
  return problems;
}

export const assignBody = (form: AssignForm) => ({ assignee_user_id: form.assigneeId, due_at: new Date(form.dueAt).toISOString(), ...(form.note.trim() === '' ? {} : { note: form.note.trim() }) });

export interface ResolveForm {
  rootCause: string;
  remediation: string;
}
export const emptyResolve = (): ResolveForm => ({ rootCause: '', remediation: '' });

export function validateResolve(form: ResolveForm): Partial<Record<keyof ResolveForm, FormProblem>> {
  const problems: Partial<Record<keyof ResolveForm, FormProblem>> = {};
  for (const field of ['rootCause', 'remediation'] as const) {
    if (words(form[field]) === 0) problems[field] = 'required';
    else if (words(form[field]) < MIN_TEXT) problems[field] = 'tooShort';
  }
  return problems;
}

export interface VerifyForm {
  decision: 'CLOSE' | 'REOPEN';
  note: string;
}
export const emptyVerify = (): VerifyForm => ({ decision: 'CLOSE', note: '' });

export function validateVerify(form: VerifyForm): Partial<Record<'note', FormProblem>> {
  if (words(form.note) === 0) return { note: 'required' };
  return words(form.note) < MIN_TEXT ? { note: 'tooShort' } : {};
}

export interface DecisionForm {
  decision: 'RESOLVED' | 'WAIVED';
  reason: string;
  /** The last day of a waiver (a date, Vietnam). */
  waiverUntil: string;
}
export const emptyDecision = (): DecisionForm => ({ decision: 'RESOLVED', reason: '', waiverUntil: '' });

const DAY = 86_400_000;
/** The end of a waiver is the last minute of the day chosen, in Vietnam (UTC+7). */
export const waiverEnd = (day: string): Date => new Date(`${day}T23:59:00+07:00`);

export function validateDecision(form: DecisionForm, now: Date): Partial<Record<'reason' | 'waiverUntil', FormProblem>> {
  const problems: Partial<Record<'reason' | 'waiverUntil', FormProblem>> = {};
  if (words(form.reason) === 0) problems.reason = 'required';
  else if (words(form.reason) < MIN_TEXT) problems.reason = 'tooShort';
  if (form.decision === 'WAIVED') {
    if (form.waiverUntil === '') problems.waiverUntil = 'required';
    else {
      const end = waiverEnd(form.waiverUntil);
      if (Number.isNaN(end.getTime())) problems.waiverUntil = 'invalidDate';
      else if (end.getTime() <= now.getTime()) problems.waiverUntil = 'pastDate';
      else if (end.getTime() > now.getTime() + MAX_WAIVER_DAYS * DAY) problems.waiverUntil = 'tooFar';
    }
  }
  return problems;
}

export const decisionBody = (form: DecisionForm) => ({ decision: form.decision, reason: form.reason.trim(), ...(form.decision === 'WAIVED' ? { waiver_expires_at: waiverEnd(form.waiverUntil).toISOString() } : {}) });

// ---- the refusals -------------------------------------------------------------------------------------------------------------

export type Problem = 'rootCause' | 'rerunNotPassed' | 'selfApproval' | 'stateInvalid' | 'exceptionDecided' | 'notAssignee' | 'outOfScope' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'ROOT_CAUSE_REQUIRED':
      return 'rootCause';
    case 'RERUN_NOT_PASSED':
      return 'rerunNotPassed';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'INCIDENT_STATE_INVALID':
      return 'stateInvalid';
    case 'EXCEPTION_STATE_INVALID':
      return 'exceptionDecided';
    case 'NOT_ASSIGNEE':
      return 'notAssignee';
    case 'ASSIGNEE_OUT_OF_SCOPE':
      return 'outOfScope';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}

/** The values of a record reference as short lines, `key: value`, for the list of an exception. */
export function referenceLines(reference: unknown): string[] {
  const row = record(reference);
  if (row === undefined) return [];
  return Object.entries(row).map(([key, value]) => `${key}: ${typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`);
}
