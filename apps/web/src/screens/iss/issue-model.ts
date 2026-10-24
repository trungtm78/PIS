import { ApiError } from '@machvon/api-client';
import { SEVERITIES } from './model';
import type { Severity } from './model';

/** The permissions that gate the buttons of the issue screens; the server decides again on every request (the scope included). */
export const ISSUE_READ_PERMISSION = 'issue.read';
export const ISSUE_CREATE_PERMISSION = 'issue.create';
export const ISSUE_ASSIGN_PERMISSION = 'issue.assign';
export const ISSUE_WORK_PERMISSION = 'issue.work';

export const LIST_PATH = '/iss/iss-01';
export const CREATE_PATH = '/iss/iss-02';
export const WORKSPACE_PATH = '/iss/iss-03';

export const ISSUE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SOURCES = ['MANUAL', 'LND', 'PMT', 'QMS', 'PAY', 'CTR', 'DIS', 'AST', 'AUD', 'PRJ'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

export const EVENT_KINDS = [
  'CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'TRANSFERRED',
  'STARTED',
  'COMMENTED',
  'EVIDENCE_ADDED',
  'EXTENSION_REQUESTED',
  'EXTENDED',
  'ESCALATED',
  'ESCALATION_ACCEPTED',
  'VERIFICATION_REQUESTED',
  'CLOSED',
  'REOPENED',
  'SLA_BREACHED',
  'SOURCE_UPDATED',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The states in which an issue is still being worked: the ones a person may be assigned, may start, comment on or move. */
export const ASSIGNABLE_STATUSES: readonly IssueStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'];

export const TITLE_MAX_LENGTH = 200;
export const TEXT_MAX_LENGTH = 2000;
const DAY_MS = 86_400_000;
const LATITUDE = /^-?\d{1,2}(\.\d{1,15})?$/;
const LONGITUDE = /^-?\d{1,3}(\.\d{1,15})?$/;
const ACCURACY = /^\d{1,6}(\.\d{1,15})?$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => text(value) ?? null;
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find((candidate) => candidate === value);

export interface PersonView {
  id: string;
  name: string;
}

function personOf(value: unknown): PersonView | null {
  const row = asRecord(value);
  const id = text(row?.membership_id);
  return row === undefined || id === undefined ? null : { id, name: text(row.display_name) ?? '' };
}

/** One issue of the list (ISS-01). */
export interface IssueLine {
  id: string;
  code: string;
  title: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  categoryLabel: string;
  severity: Severity;
  status: IssueStatus;
  ownerUnitId: string;
  ownerUnitName: string;
  assignee: PersonView | null;
  reporter: PersonView | null;
  sourceModule: IssueSource;
  escalationLevel: number;
  openedAt: string;
  responseDueAt: string;
  respondedAt: string | null;
  dueAt: string;
  overdueSince: string | null;
  /** The working days the issue has been overdue; null when it is not, or when the days cannot be counted. */
  overdueDays: number | null;
  closedAt: string | null;
  version: number;
}

export function toIssueLine(raw: unknown): IssueLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const code = text(row.code);
  const title = text(row.title);
  const projectId = text(row.project_id);
  const severity = oneOf(row.severity, SEVERITIES);
  const status = oneOf(row.status, ISSUE_STATUSES);
  const ownerUnitId = text(row.owner_unit_id);
  const openedAt = text(row.opened_at);
  const responseDueAt = text(row.response_due_at);
  const dueAt = text(row.due_at);
  const version = whole(row.version);
  if (
    id === undefined || code === undefined || title === undefined || projectId === undefined || severity === undefined || status === undefined ||
    ownerUnitId === undefined || openedAt === undefined || responseDueAt === undefined || dueAt === undefined || version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    code,
    title,
    projectId,
    projectCode: text(row.project_code) ?? '',
    projectName: text(row.project_name) ?? '',
    categoryLabel: text(row.category_label) ?? '',
    severity,
    status,
    ownerUnitId,
    ownerUnitName: text(row.owner_unit_name) ?? '',
    assignee: personOf(row.assignee),
    reporter: personOf(row.reported_by),
    sourceModule: oneOf(row.source_module, ISSUE_SOURCES) ?? 'MANUAL',
    escalationLevel: whole(row.escalation_level) ?? 0,
    openedAt,
    responseDueAt,
    respondedAt: nullableText(row.responded_at),
    dueAt,
    overdueSince: nullableText(row.overdue_since),
    overdueDays: whole(row.overdue_days) ?? null,
    closedAt: nullableText(row.closed_at),
    version,
  };
}

export interface IssueEventView {
  id: string;
  kind: EventKind;
  fromStatus: string | null;
  toStatus: string | null;
  fromAssignee: PersonView | null;
  toAssignee: PersonView | null;
  note: string | null;
  actor: PersonView | null;
  createdAt: string;
  documentAttached: boolean;
  /** The unit an issue came from and went to, for a transfer. */
  fromUnitId: string | null;
  toUnitId: string | null;
}

export function toEvent(raw: unknown): IssueEventView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = oneOf(row?.kind, EVENT_KINDS);
  const createdAt = text(row?.created_at);
  if (row === undefined || id === undefined || kind === undefined || createdAt === undefined) return undefined;
  const payload = asRecord(row.payload);
  return {
    id,
    kind,
    fromStatus: nullableText(row.from_status),
    toStatus: nullableText(row.to_status),
    fromAssignee: personOf(row.from_assignee),
    toAssignee: personOf(row.to_assignee),
    note: nullableText(row.note),
    actor: personOf(row.actor),
    createdAt,
    documentAttached: text(row.document_version_id) !== undefined,
    fromUnitId: nullableText(payload?.from_unit_id),
    toUnitId: nullableText(payload?.to_unit_id),
  };
}

export interface GeoView {
  lat: string;
  lng: string;
  accuracyM: string | null;
  lowAccuracy: boolean;
}

export interface SlaView {
  policyCode: string;
  policyRevision: number;
  calendarCode: string;
  responseHours: number;
  resolveHours: number;
  requireEvidence: boolean;
  requireIndependentVerifier: boolean;
}

/** The workspace of one issue (ISS-03): the line, the text, the SLA it was opened under, the position and the timeline. */
export interface IssueView extends IssueLine {
  /** Null when the reader may not read it (an issue from a land complaint, a guest). */
  description: string | null;
  sla: SlaView | null;
  geoConsent: boolean;
  geo: GeoView | null;
  events: IssueEventView[];
}

function slaOf(value: unknown): SlaView | null {
  const row = asRecord(value);
  const policyCode = text(row?.policy_code);
  const policyRevision = whole(row?.policy_revision);
  const responseHours = whole(row?.response_hours);
  const resolveHours = whole(row?.resolve_hours);
  if (row === undefined || policyCode === undefined || policyRevision === undefined || responseHours === undefined || resolveHours === undefined) return null;
  return {
    policyCode,
    policyRevision,
    calendarCode: text(row.calendar_code) ?? '',
    responseHours,
    resolveHours,
    requireEvidence: row.require_evidence === true,
    requireIndependentVerifier: row.require_independent_verifier === true,
  };
}

function geoOf(value: unknown): GeoView | null {
  const row = asRecord(value);
  const lat = text(row?.lat);
  const lng = text(row?.lng);
  if (row === undefined || lat === undefined || lng === undefined) return null;
  return { lat, lng, accuracyM: nullableText(row.accuracy_m), lowAccuracy: row.low_accuracy === true };
}

export function toIssueView(raw: unknown): IssueView | undefined {
  const line = toIssueLine(raw);
  const row = asRecord(raw);
  if (line === undefined || row === undefined) return undefined;
  const events = Array.isArray(row.events) ? row.events.flatMap((event) => toEvent(event) ?? []) : [];
  return { ...line, description: nullableText(row.description), sla: slaOf(row.sla), geoConsent: row.geo_consent === true, geo: geoOf(row.geo), events };
}

/** The next page of the timeline of an issue: the events and the cursor of the page after it. */
export function eventsPageOf(raw: unknown): { events: IssueEventView[]; nextCursor: string | undefined } {
  const row = asRecord(raw);
  const events = Array.isArray(row?.events) ? row.events.flatMap((event) => toEvent(event) ?? []) : [];
  return { events, nextCursor: text(row?.next_cursor) };
}

export interface AssigneeOption {
  id: string;
  name: string;
}

/** A person the issue may be given to (listIssueAssignees): the server lists only those the command accepts. */
export function toAssigneeOption(raw: unknown): AssigneeOption[] {
  const row = asRecord(raw);
  const id = text(row?.membership_id);
  if (row === undefined || id === undefined) return [];
  return [{ id, name: text(row.display_name) ?? id }];
}

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

export function toProjectOption(raw: unknown): ProjectOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  return row === undefined || id === undefined || code === undefined ? [] : [{ id, code, name: text(row.name) ?? code }];
}

// ---- the board (ISS-01) ---------------------------------------------------------------------------------

export interface IssueFilter {
  query: string;
  status: IssueStatus | '';
  severity: Severity | '';
  assignedToMe: boolean;
  overdueOnly: boolean;
}

export const EMPTY_FILTER: IssueFilter = { query: '', status: '', severity: '', assignedToMe: false, overdueOnly: false };

const normal = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterIssues(lines: readonly IssueLine[], filter: IssueFilter, membershipId: string | undefined): IssueLine[] {
  const query = normal(filter.query.trim());
  return lines.filter((line) => {
    if (filter.status !== '' && line.status !== filter.status) return false;
    if (filter.severity !== '' && line.severity !== filter.severity) return false;
    if (filter.assignedToMe && (membershipId === undefined || line.assignee?.id !== membershipId)) return false;
    if (filter.overdueOnly && line.overdueSince === null) return false;
    if (query === '') return true;
    return normal(`${line.code} ${line.title} ${line.projectCode} ${line.projectName} ${line.categoryLabel} ${line.ownerUnitName} ${line.assignee?.name ?? ''}`).includes(query);
  });
}

export interface BoardColumn {
  status: IssueStatus;
  lines: IssueLine[];
}

/** The issues by status, in the order of the state machine; every status has a column so that an empty one is seen to be empty. */
export function boardOf(lines: readonly IssueLine[]): BoardColumn[] {
  return ISSUE_STATUSES.map((status) => ({ status, lines: lines.filter((line) => line.status === status) }));
}

export type DueState = 'closed' | 'overdue' | 'dueSoon' | 'onTrack';

/** Where an issue stands against its deadline: a state is told in words, never by colour alone. */
export function dueStateOf(line: Pick<IssueLine, 'status' | 'dueAt' | 'overdueSince'>, now: Date): DueState {
  if (line.status === 'CLOSED') return 'closed';
  const due = Date.parse(line.dueAt);
  if (line.overdueSince !== null || due < now.getTime()) return 'overdue';
  return due - now.getTime() <= DAY_MS ? 'dueSoon' : 'onTrack';
}

/** The address of the workspace of an issue. */
export function workspaceLink(issueId: string): string {
  return `${WORKSPACE_PATH}?${new URLSearchParams({ id: issueId }).toString()}`;
}

// ---- the form (ISS-02) ----------------------------------------------------------------------------------

export interface IssueForm {
  projectId: string;
  ownerUnitId: string;
  categoryVersionId: string;
  severity: Severity;
  title: string;
  description: string;
  geoConsent: boolean;
  geoLat: string;
  geoLng: string;
  geoAccuracy: string;
}

export type IssueField = keyof IssueForm;

export const EMPTY_FORM: IssueForm = {
  projectId: '',
  ownerUnitId: '',
  categoryVersionId: '',
  severity: 'MEDIUM',
  title: '',
  description: '',
  geoConsent: false,
  geoLat: '',
  geoLng: '',
  geoAccuracy: '',
};

export type FieldProblem = 'required' | 'tooLong' | 'invalidLatitude' | 'invalidLongitude' | 'invalidAccuracy' | 'consentRequired' | 'pairRequired' | 'rejected';
export type FormErrors = Partial<Record<IssueField, FieldProblem>>;

/** Every rule of the form that the screen can judge without asking the server; the server judges the rest (the category, the policy, the scope). */
export function validateForm(form: IssueForm): FormErrors {
  const errors: FormErrors = {};
  if (form.projectId === '') errors.projectId = 'required';
  if (form.ownerUnitId === '') errors.ownerUnitId = 'required';
  if (form.categoryVersionId === '') errors.categoryVersionId = 'required';
  const title = form.title.trim();
  if (title === '') errors.title = 'required';
  else if (title.length > TITLE_MAX_LENGTH) errors.title = 'tooLong';
  const description = form.description.trim();
  if (description === '') errors.description = 'required';
  else if (description.length > TEXT_MAX_LENGTH) errors.description = 'tooLong';

  const lat = form.geoLat.trim();
  const lng = form.geoLng.trim();
  const accuracy = form.geoAccuracy.trim();
  if (lat !== '' || lng !== '' || accuracy !== '') {
    // A position without the consent of the person is not sent at all (BR-ISS-06).
    if (!form.geoConsent) errors.geoConsent = 'consentRequired';
    if (lat === '') errors.geoLat = 'pairRequired';
    else if (!LATITUDE.test(lat) || Math.abs(Number(lat)) > 90) errors.geoLat = 'invalidLatitude';
    if (lng === '') errors.geoLng = 'pairRequired';
    else if (!LONGITUDE.test(lng) || Math.abs(Number(lng)) > 180) errors.geoLng = 'invalidLongitude';
    if (accuracy !== '' && !ACCURACY.test(accuracy)) errors.geoAccuracy = 'invalidAccuracy';
    if (accuracy !== '' && lat === '' && lng === '') errors.geoLat = 'pairRequired';
  }
  return errors;
}

/** The body of createIssue for a form that passed `validateForm`; the operation id is the one of this intention, so a retry is the same issue. */
export interface CreateBody {
  project_id: string;
  category_version_id: string;
  severity: Severity;
  title: string;
  description: string;
  owner_unit_id: string;
  geo_consent?: boolean;
  geo_lat?: string;
  geo_lng?: string;
  geo_accuracy_m?: string;
  client_operation_id: string;
}

export function toCreateBody(form: IssueForm, clientOperationId: string): CreateBody {
  const lat = form.geoLat.trim();
  const lng = form.geoLng.trim();
  const accuracy = form.geoAccuracy.trim();
  return {
    project_id: form.projectId,
    category_version_id: form.categoryVersionId,
    severity: form.severity,
    title: form.title.trim(),
    description: form.description.trim(),
    owner_unit_id: form.ownerUnitId,
    ...(form.geoConsent ? { geo_consent: true } : {}),
    // The position travels only with the consent that stores it.
    ...(form.geoConsent && lat !== '' ? { geo_lat: lat, geo_lng: lng } : {}),
    ...(form.geoConsent && lat !== '' && accuracy !== '' ? { geo_accuracy_m: accuracy } : {}),
    client_operation_id: clientOperationId,
  };
}

/** The form field that the server names (the `detail` of a 422), when the screen has one for it. */
export const FIELD_OF_DETAIL: Readonly<Record<string, IssueField>> = {
  project_id: 'projectId',
  owner_unit_id: 'ownerUnitId',
  category_version_id: 'categoryVersionId',
  severity: 'severity',
  title: 'title',
  description: 'description',
  geo_consent: 'geoConsent',
  geo_lat: 'geoLat',
  geo_lng: 'geoLng',
  geo_accuracy_m: 'geoAccuracy',
};

export type ProblemReason =
  | 'noPolicy'
  | 'duplicateSource'
  | 'stateInvalid'
  | 'assigneeOutOfScope'
  | 'documentNotClean'
  | 'versionConflict'
  | 'operationConflict'
  | 'validation'
  | 'denied'
  | 'notFound'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SLA_POLICY_MISSING: 'noPolicy',
  DUPLICATE_SOURCE_OPEN: 'duplicateSource',
  ISSUE_STATE_INVALID: 'stateInvalid',
  ASSIGNEE_OUT_OF_SCOPE: 'assigneeOutOfScope',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  VERSION_CONFLICT: 'versionConflict',
  IDEMPOTENCY_CONFLICT: 'operationConflict',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

/** Maps the failure of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

// ---- the commands of the workspace (ISS-03) --------------------------------------------------------------

export interface WorkspaceRights {
  assign: boolean;
  work: boolean;
}

/** What the signed-in person may do with an issue in its state: the buttons the workspace offers, the server deciding again (scope, assignee). */
export function actionsOf(issue: Pick<IssueLine, 'status' | 'assignee'>, rights: WorkspaceRights, membershipId: string | undefined): { assign: boolean; start: boolean; comment: boolean; transfer: boolean } {
  const open = issue.status !== 'CLOSED';
  return {
    assign: rights.assign && ASSIGNABLE_STATUSES.includes(issue.status),
    start: rights.work && issue.status === 'ASSIGNED' && membershipId !== undefined && issue.assignee?.id === membershipId,
    comment: rights.work && open,
    transfer: rights.assign && open,
  };
}

export function hasPermission(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission);
}
