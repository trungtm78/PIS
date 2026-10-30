import { randomUUID } from 'node:crypto';
import { DomainError, activeGrants, canonicalJson, effectivePermissions, holdsPermission, isWorkingDay, permissionMatches, sha256Hex, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, WorkCalendarSource } from '@machvon/kernel';
import { IssSlaDeadlines } from './iss-sla-deadline.ts';
import { ISSUE_CATEGORY_TYPE, SLA_SEVERITIES } from './iss-sla-policy-store.ts';
import type { SlaSeverity } from './iss-sla-policy-store.ts';
import { grantViewOf } from './effective-access-store.ts';
import type { GrantRow } from './effective-access-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { MyAccessStore } from './my-access-store.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

export const ISSUE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SOURCES = ['MANUAL', 'LND', 'PMT', 'QMS', 'PAY', 'CTR', 'DIS', 'AST', 'AUD', 'PRJ'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

export type IssueEventKind =
  | 'CREATED'
  | 'ASSIGNED'
  | 'REASSIGNED'
  | 'TRANSFERRED'
  | 'STARTED'
  | 'COMMENTED'
  | 'EVIDENCE_ADDED'
  | 'EXTENSION_REQUESTED'
  | 'EXTENDED'
  | 'ESCALATED'
  | 'ESCALATION_ACCEPTED'
  | 'VERIFICATION_REQUESTED'
  | 'CLOSED'
  | 'REOPENED'
  | 'SLA_BREACHED'
  | 'SOURCE_UPDATED';

/** The permission an assignee must hold over the issue (ISS 2: the person who works it). */
export const ISSUE_WORK_PERMISSION = 'issue.work';
/** The permission to read what a land complaint says: its text can name a household, so an issue from that source shows it only to those who hold it. */
export const LAND_HOUSEHOLD_PERMISSION = 'land.household.read';
/** The longest title and note; the contract allows 2000 characters. */
export const MAX_ISSUE_TEXT = 2000;
/** A position less accurate than this many metres is shown with a warning (BR-ISS-06). */
export const LOW_ACCURACY_METRES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LATITUDE = /^-?\d{1,2}(\.\d{1,15})?$/;
const LONGITUDE = /^-?\d{1,3}(\.\d{1,15})?$/;
const ACCURACY = /^\d{1,6}(\.\d{1,15})?$/;
const SEVERITIES: ReadonlySet<string> = new Set(SLA_SEVERITIES);
const SOURCES: ReadonlySet<string> = new Set(ISSUE_SOURCES);
const ASSIGNABLE: ReadonlySet<IssueStatus> = new Set(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED', 'PENDING_VERIFICATION']);
const MAX_OVERDUE_SCAN_DAYS = 3660;
const DAY_MS = 86_400_000;

const ISSUE_OWNER_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;

/**
 * A scope builder for a permission over issues: the issue is in scope when its owner unit lies in a scope of a grant that carries the
 * permission, or the grant names its project or its contract. With `reporter` the person who reported an issue also reaches their own
 * (ISS 2: the reporter works and reads the issue they reported), provided they hold the permission somewhere. Compiled over the aliases
 * `i` (issue) and `ou` (its owner unit); the parameters are numbered from `first`.
 */
export function issueScope(access: EffectiveAccess, permission: string, now: Date, options: { reporter?: string } = {}): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const owner = scopePredicate(access, permission, now, ISSUE_OWNER_COLUMNS, first);
    if (owner.sql === 'true') return owner;
    const params: unknown[] = [...owner.params];
    const alternatives: string[] = owner.sql === 'false' ? [] : [owner.sql];
    const projectIds = new Set<string>();
    const contractIds = new Set<string>();
    let holds = false;
    for (const grant of activeGrants(access, now)) {
      if (!grant.permissions.some((held) => permissionMatches(held, permission))) continue;
      holds = true;
      if (grant.scope.kind === 'PROJECT') for (const id of grant.scope.refIds) projectIds.add(id);
      if (grant.scope.kind === 'CONTRACT') for (const id of grant.scope.refIds) contractIds.add(id);
    }
    if (projectIds.size > 0) {
      params.push([...projectIds].sort());
      alternatives.push(`i.project_id = any($${first + params.length - 1}::uuid[])`);
    }
    if (contractIds.size > 0) {
      params.push([...contractIds].sort());
      alternatives.push(`i.contract_id = any($${first + params.length - 1}::uuid[])`);
    }
    if (holds && options.reporter !== undefined) {
      params.push(options.reporter);
      alternatives.push(`i.reported_by = $${first + params.length - 1}::uuid`);
    }
    return alternatives.length === 0 ? { sql: 'false', params: [] } : { sql: `(${alternatives.join(' or ')})`, params };
  };
}

/** Where an issue lies for the test of a permission: the unit that owns it, its project and its contract. */
export interface IssuePlace extends ResourceRef {
  projectId: string;
  contractId?: string;
}

/** What narrows the list of the issues: a unit, a group, a status; with `week`, the status each issue had at that moment (the end of a week) and only the issues that existed then. */
export interface IssueFilter {
  ownerUnitId?: string | undefined;
  categoryVersionId?: string | undefined;
  status?: IssueStatus | undefined;
  /** Only the issues that are open (not closed), at the moment of the week when there is one: the ones the closing of a cell of the weekly matrix counts. */
  open?: boolean | undefined;
  /** The moment the week ended, or now while it runs: the status is read before it. */
  week?: { at: string } | undefined;
}

/** The status an issue had at the moment `$6`, read from its history: the status the last event up to then moved it to; none for an issue that did not exist yet. */
const STATUS_AT =
  '(select e.to_status from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.to_status is not null and e.created_at < $6::timestamptz order by e.created_at desc, e.id desc limit 1)';

export interface IssueLine {
  id: string;
  code: string;
  title: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  categoryVersionId: string;
  categoryLabel: string;
  severity: SlaSeverity;
  status: IssueStatus;
  ownerUnitId: string;
  ownerUnitName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  reportedBy: string;
  reporterName: string | null;
  sourceModule: IssueSource;
  sourceRefId: string | null;
  contractId: string | null;
  escalationLevel: number;
  openedAt: string;
  responseDueAt: string;
  respondedAt: string | null;
  dueAt: string;
  overdueSince: string | null;
  closedAt: string | null;
  reopenCount: number;
  slaPolicyId: string;
  version: number;
  /** The calendar the deadline was counted on: the days of an overdue issue are counted on it. */
  calendarCode: string;
  codeKey: string;
}

export interface IssueDetail extends IssueLine {
  description: string;
  resolvedAt: string | null;
  closedBy: string | null;
  verifierId: string | null;
  geoConsent: boolean;
  geoLat: string | null;
  geoLng: string | null;
  geoAccuracyM: string | null;
  /** How many times the deadline has been extended (ST-ISS-003). */
  extensionCount: number;
  policy: { code: string; revision: number; responseHours: number; resolveHours: number; requireEvidence: boolean; requireIndependentVerifier: boolean };
  place: IssuePlace;
}

/** A person an issue may be given to. */
export interface AssigneeOption {
  membershipId: string;
  displayName: string;
}

export interface IssueEventRow {
  id: string;
  kind: IssueEventKind;
  fromStatus: string | null;
  toStatus: string | null;
  fromAssigneeId: string | null;
  fromAssigneeName: string | null;
  toAssigneeId: string | null;
  toAssigneeName: string | null;
  note: string | null;
  documentVersionId: string | null;
  payload: Record<string, unknown>;
  createdBy: string;
  actorName: string | null;
  createdAt: string;
  createdAtKey: string;
}

export interface NewIssue {
  projectId: string;
  categoryVersionId: string;
  severity: string;
  title: string;
  description: string;
  contractId?: string | undefined;
  ownerUnitId: string;
  sourceModule?: string | undefined;
  sourceRefId?: string | undefined;
  geoConsent?: boolean | undefined;
  geoLat?: string | undefined;
  geoLng?: string | undefined;
  geoAccuracyM?: string | undefined;
  clientOperationId: string;
}

/** What a command changed on an issue, as the audit row and the event of the command name it: ids, status and dates, never the text. */
export interface IssueHeader {
  id: string;
  code: string;
  projectId: string;
  ownerUnitId: string;
  severity: SlaSeverity;
  status: IssueStatus;
  assigneeId: string | null;
  escalationLevel: number;
  dueAt: string;
  version: number;
}

export interface CreatedIssue extends IssueHeader {
  /** The create had been answered before (the same client operation id): nothing was written. */
  replayed: boolean;
  sourceModule: IssueSource;
  responseDueAt: string;
  policyId: string;
  /** Whether a position was stored: the audit row says that, never where. */
  geoRecorded: boolean;
}

export interface TransferredIssue extends IssueHeader {
  fromUnitId: string;
}

export interface AssignedIssue extends IssueHeader {
  previousAssigneeId: string | null;
  previousStatus: IssueStatus;
}

export interface CommentedIssue extends IssueHeader {
  eventId: string;
  attachedDocument: boolean;
}

/** The scopes a command works in: where the caller may act, and where they may at least read (a miss is 404, a read without the right is 403). */
export interface IssueScopes {
  act: ScopeBuilder;
  read: ScopeBuilder;
}

interface LineSql {
  id: string;
  code: string;
  title: string;
  project_id: string;
  project_code: string;
  project_name: string;
  category_version_id: string;
  category_label: string;
  severity: SlaSeverity;
  status: IssueStatus;
  owner_unit_id: string;
  owner_unit_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  reported_by: string;
  reporter_name: string | null;
  source_module: IssueSource;
  source_ref_id: string | null;
  contract_id: string | null;
  escalation_level: number;
  opened_at: string;
  response_due_at: string;
  responded_at: string | null;
  due_at: string;
  overdue_since: string | null;
  closed_at: string | null;
  reopen_count: number;
  sla_policy_id: string;
  version: string;
  calendar_code: string;
}

interface DetailSql extends LineSql {
  description: string;
  resolved_at: string | null;
  closed_by: string | null;
  verifier_id: string | null;
  geo_consent: boolean;
  geo_lat: string | null;
  geo_lng: string | null;
  geo_accuracy_m: string | null;
  extension_count: number;
  policy_code: string;
  policy_revision: number;
  response_hours: number;
  resolve_hours: number;
  require_evidence: boolean;
  require_independent_verifier: boolean;
  owner_unit_path: string;
}

interface EventSql {
  id: string;
  event_kind: IssueEventKind;
  from_status: string | null;
  to_status: string | null;
  from_assignee_id: string | null;
  from_assignee_name: string | null;
  to_assignee_id: string | null;
  to_assignee_name: string | null;
  note: string | null;
  document_version_id: string | null;
  payload: Record<string, unknown>;
  created_by: string;
  actor_name: string | null;
  created_at: string;
  created_at_key: string;
}

/** An issue row locked for update by a command: what every command of the issue module reads before it acts. */
export interface LockedSql {
  id: string;
  code: string;
  version: string;
  status: IssueStatus;
  assignee_id: string | null;
  owner_unit_id: string;
  owner_unit_path: string;
  project_id: string;
  contract_id: string | null;
  reported_by: string;
  severity: SlaSeverity;
  escalation_level: number;
  due_at: string;
}

export const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const SCOPE_FROM = `machvon.issue i join machvon.organization_unit ou on ou.tenant_id = i.tenant_id and ou.id = i.owner_unit_id`;

const LINE_FROM = `${SCOPE_FROM}
  join machvon.project p on p.tenant_id = i.tenant_id and p.id = i.project_id
  join machvon.master_record_version cv on cv.tenant_id = i.tenant_id and cv.id = i.category_version_id
  join machvon.issue_sla_policy pol on pol.tenant_id = i.tenant_id and pol.id = i.sla_policy_id
  left join machvon.tenant_user_directory au on au.tenant_id = i.tenant_id and au.membership_id = i.assignee_id
  left join machvon.tenant_user_directory ru on ru.tenant_id = i.tenant_id and ru.membership_id = i.reported_by`;

const LINE_COLUMNS = `i.id, i.code, i.title, i.project_id, p.code as project_code, p.name as project_name, i.category_version_id, cv.label as category_label,
  i.severity, i.status, i.owner_unit_id, ou.name as owner_unit_name, i.assignee_id, au.display_name as assignee_name, i.reported_by, ru.display_name as reporter_name,
  i.source_module, i.source_ref_id, i.contract_id, i.escalation_level, ${iso('i.opened_at')} as opened_at, ${iso('i.response_due_at')} as response_due_at,
  ${iso('i.responded_at')} as responded_at, ${iso('i.due_at')} as due_at, ${iso('i.overdue_since')} as overdue_since, ${iso('i.closed_at')} as closed_at,
  i.reopen_count, i.sla_policy_id, i.version::text as version, pol.calendar_code`;

const DETAIL_COLUMNS = `${LINE_COLUMNS}, i.description, ${iso('i.resolved_at')} as resolved_at, i.closed_by, i.verifier_id, i.geo_consent,
  i.geo_lat::text as geo_lat, i.geo_lng::text as geo_lng, i.geo_accuracy_m::text as geo_accuracy_m, i.extension_count, pol.code as policy_code, pol.revision as policy_revision,
  pol.response_hours, pol.resolve_hours, pol.require_evidence, pol.require_independent_verifier, ou.path as owner_unit_path`;

const toLine = (row: LineSql): IssueLine => ({
  id: row.id,
  code: row.code,
  title: row.title,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  categoryVersionId: row.category_version_id,
  categoryLabel: row.category_label,
  severity: row.severity,
  status: row.status,
  ownerUnitId: row.owner_unit_id,
  ownerUnitName: row.owner_unit_name,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_name,
  reportedBy: row.reported_by,
  reporterName: row.reporter_name,
  sourceModule: row.source_module,
  sourceRefId: row.source_ref_id,
  contractId: row.contract_id,
  escalationLevel: row.escalation_level,
  openedAt: row.opened_at,
  responseDueAt: row.response_due_at,
  respondedAt: row.responded_at,
  dueAt: row.due_at,
  overdueSince: row.overdue_since,
  closedAt: row.closed_at,
  reopenCount: row.reopen_count,
  slaPolicyId: row.sla_policy_id,
  version: Number(row.version),
  calendarCode: row.calendar_code,
  codeKey: row.code,
});

const toEvent = (row: EventSql): IssueEventRow => ({
  id: row.id,
  kind: row.event_kind,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  fromAssigneeId: row.from_assignee_id,
  fromAssigneeName: row.from_assignee_name,
  toAssigneeId: row.to_assignee_id,
  toAssigneeName: row.to_assignee_name,
  note: row.note,
  documentVersionId: row.document_version_id,
  payload: row.payload,
  createdBy: row.created_by,
  actorName: row.actor_name,
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function uuidOf(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
}

/** A title or a note as it is stored: trimmed, not empty, within its length, without a character the database cannot hold. */
export function issueText(value: string, field: string): string {
  const text = value.trim();
  if (text === '' || text.length > MAX_ISSUE_TEXT || text.includes('\0')) throw invalid(field);
  return text;
}

interface CheckedIssue {
  projectId: string;
  categoryVersionId: string;
  severity: SlaSeverity;
  title: string;
  description: string;
  contractId: string | null;
  ownerUnitId: string;
  sourceModule: IssueSource;
  sourceRefId: string | null;
  geoConsent: boolean;
  geoLat: string | null;
  geoLng: string | null;
  geoAccuracyM: string | null;
  clientOperationId: string;
}

/** The position, when there is one: a pair on the earth, and only with consent (BR-ISS-06). */
function positionOf(input: NewIssue): Pick<CheckedIssue, 'geoConsent' | 'geoLat' | 'geoLng' | 'geoAccuracyM'> {
  const geoConsent = input.geoConsent === true;
  const { geoLat, geoLng, geoAccuracyM } = input;
  if (geoLat === undefined && geoLng === undefined && geoAccuracyM === undefined) return { geoConsent, geoLat: null, geoLng: null, geoAccuracyM: null };
  // A position without consent is refused outright, not dropped: the caller must learn that nothing was stored (UAT-AC355 step 1).
  if (!geoConsent) throw invalid('geo_consent');
  if (geoLat === undefined || geoLng === undefined) throw invalid(geoLat === undefined ? 'geo_lat' : 'geo_lng');
  const lat = LATITUDE.test(geoLat) ? Number(geoLat) : Number.NaN;
  if (!(Math.abs(lat) <= 90)) throw invalid('geo_lat');
  const lng = LONGITUDE.test(geoLng) ? Number(geoLng) : Number.NaN;
  if (!(Math.abs(lng) <= 180)) throw invalid('geo_lng');
  if (geoAccuracyM !== undefined && !ACCURACY.test(geoAccuracyM)) throw invalid('geo_accuracy_m');
  return { geoConsent, geoLat, geoLng, geoAccuracyM: geoAccuracyM ?? null };
}

function checked(input: NewIssue): CheckedIssue {
  if (!SEVERITIES.has(input.severity)) throw invalid('severity');
  const sourceModule = input.sourceModule ?? 'MANUAL';
  if (!SOURCES.has(sourceModule)) throw invalid('source_module');
  const sourceRefId = input.sourceRefId === undefined ? null : uuidOf(input.sourceRefId, 'source_ref_id');
  // A manual issue has no source object and every other source names one (issue_source_chk).
  if ((sourceModule === 'MANUAL') !== (sourceRefId === null)) throw invalid('source_ref_id');
  return {
    projectId: uuidOf(input.projectId, 'project_id'),
    categoryVersionId: uuidOf(input.categoryVersionId, 'category_version_id'),
    severity: input.severity as SlaSeverity,
    title: issueText(input.title, 'title'),
    description: issueText(input.description, 'description'),
    contractId: input.contractId === undefined ? null : uuidOf(input.contractId, 'contract_id'),
    ownerUnitId: uuidOf(input.ownerUnitId, 'owner_unit_id'),
    sourceModule: sourceModule as IssueSource,
    sourceRefId,
    ...positionOf(input),
    clientOperationId: uuidOf(input.clientOperationId, 'client_operation_id'),
  };
}

/** What the retry of a create is compared with: everything the person asked for, so the same id with other content is not taken for a retry. */
const requestHashOf = (issue: CheckedIssue): string => sha256Hex(canonicalJson(issue));

export const toHeader = (row: LockedSql, overrides: Partial<IssueHeader> = {}): IssueHeader => ({
  id: row.id,
  code: row.code,
  projectId: row.project_id,
  ownerUnitId: row.owner_unit_id,
  severity: row.severity,
  status: row.status,
  assigneeId: row.assignee_id,
  escalationLevel: row.escalation_level,
  dueAt: row.due_at,
  version: Number(row.version),
  ...overrides,
});

export const placeOfLocked = (row: LockedSql): IssuePlace => ({
  ownerUnitId: row.owner_unit_id,
  ownerUnitPath: row.owner_unit_path,
  projectId: row.project_id,
  ...(row.contract_id === null ? {} : { contractId: row.contract_id }),
});

export const LOCK_COLUMNS = `i.id, i.code, i.version::text as version, i.status, i.assignee_id, i.owner_unit_id, ou.path as owner_unit_path, i.project_id, i.contract_id,
  i.reported_by, i.severity, i.escalation_level, ${iso('i.due_at')} as due_at`;

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The issues of the issue module (ST-ISS-002, ISS 3.1 and 4): an issue is opened under the SLA policy in force, assigned, started,
 * discussed and moved to another unit, every step a row of its timeline. The deadlines are fixed when the issue is opened and a
 * transfer never moves them or the day the issue became overdue (BR-ISS-04). Reads and commands work inside the scope of the caller:
 * an issue the caller cannot see does not exist for them.
 */
export class IssIssueStore {
  private readonly deadlines: IssSlaDeadlines;
  private readonly access = new MyAccessStore();
  private readonly calendars = new WorkCalendarStore();

  constructor(deadlines: IssSlaDeadlines = new IssSlaDeadlines()) {
    this.deadlines = deadlines;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  /** The issues in the scope of the caller, the newest code first; the cursor is the code and the id of the last line. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined; filter?: IssueFilter }): Promise<IssueLine[]> {
    const predicate = scope(9);
    const filter = request.filter;
    // With a week, the status is the one the issue had when the week ended (read from its history), as the cells of the weekly matrix count it; without one, the status it has now.
    const status = filter?.week === undefined ? 'i.status' : STATUS_AT;
    // The issue is shown with the status it is filtered by, so that a cell of the matrix opens issues that read as the cell says.
    const columns = filter?.week === undefined ? LINE_COLUMNS : LINE_COLUMNS.replace('i.severity, i.status,', `i.severity, ${STATUS_AT} as status,`);
    const rows = await tx.query<LineSql>(
      `select ${columns} from ${LINE_FROM}
        where ($1::text is null or (i.code, i.id) < ($1::text, $2::uuid)) and ($4::uuid is null or i.owner_unit_id = $4::uuid) and ($5::text is null or ${status} = $5::text)
          and ($6::timestamptz is null or ${status} is not null) and ($7::uuid is null or i.category_version_id = $7::uuid) and ($8::boolean is not true or ${status} <> 'CLOSED') and ${predicate.sql}
        order by i.code desc, i.id desc limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, filter?.ownerUnitId ?? null, filter?.status ?? null, filter?.week?.at ?? null, filter?.categoryVersionId ?? null, filter?.open ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /** One issue in the scope of the caller with everything the workspace shows; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<IssueDetail | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<DetailSql>(`select ${DETAIL_COLUMNS} from ${LINE_FROM} where i.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      ...toLine(row),
      description: row.description,
      resolvedAt: row.resolved_at,
      closedBy: row.closed_by,
      verifierId: row.verifier_id,
      geoConsent: row.geo_consent,
      geoLat: row.geo_lat,
      geoLng: row.geo_lng,
      geoAccuracyM: row.geo_accuracy_m,
      extensionCount: row.extension_count,
      policy: {
        code: row.policy_code,
        revision: row.policy_revision,
        responseHours: row.response_hours,
        resolveHours: row.resolve_hours,
        requireEvidence: row.require_evidence,
        requireIndependentVerifier: row.require_independent_verifier,
      },
      place: {
        ownerUnitId: row.owner_unit_id,
        ownerUnitPath: row.owner_unit_path,
        projectId: row.project_id,
        ...(row.contract_id === null ? {} : { contractId: row.contract_id }),
      },
    };
  }

  /** The timeline of an issue the caller has already been shown, the oldest event first; the cursor is the microsecond time and the id of the last event. */
  async events(tx: TenantTx, issueId: string, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<IssueEventRow[]> {
    assertTimestampCursor(request.after?.code);
    const rows = await tx.query<EventSql>(
      `select e.id, e.event_kind, e.from_status, e.to_status, e.from_assignee_id, fa.display_name as from_assignee_name, e.to_assignee_id, ta.display_name as to_assignee_name,
              e.note, e.document_version_id, e.payload, e.created_by, cu.display_name as actor_name, ${iso('e.created_at')} as created_at, ${timestampKey('e.created_at')} as created_at_key
         from machvon.issue_event e
         left join machvon.tenant_user_directory fa on fa.tenant_id = e.tenant_id and fa.membership_id = e.from_assignee_id
         left join machvon.tenant_user_directory ta on ta.tenant_id = e.tenant_id and ta.membership_id = e.to_assignee_id
         left join machvon.tenant_user_directory cu on cu.tenant_id = e.tenant_id and cu.membership_id = e.created_by
        where e.issue_id = $1::uuid and ($2::text is null or (${timestampKey('e.created_at')}, e.id) > ($2::text, $3::uuid))
        order by e.created_at, e.id limit $4`,
      [issueId, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toEvent);
  }

  /**
   * The working days an overdue issue has been overdue (BR-ISS-04): the working days after the day it became overdue, up to the day it
   * was closed or `now`, counted on the working calendar of its policy. Null for an issue that is not overdue, and for one whose count
   * would pass through a year without a published calendar (the count is never guessed).
   */
  async overdueDays(tx: TenantTx, lines: ReadonlyArray<Pick<IssueLine, 'overdueSince' | 'closedAt' | 'calendarCode'>>, now: Date): Promise<Array<number | null>> {
    const overdue = lines.filter((line) => line.overdueSince !== null);
    if (overdue.length === 0) return lines.map(() => null);
    const firstYears = new Map<string, number>();
    for (const line of overdue) {
      const year = Number(vietnamDateOf(new Date(line.overdueSince as string)).slice(0, 4));
      firstYears.set(line.calendarCode, Math.min(year, firstYears.get(line.calendarCode) ?? year));
    }
    const sources = new Map<string, WorkCalendarSource>();
    for (const [calendarCode, year] of firstYears) sources.set(calendarCode, await this.calendars.source(tx, calendarCode, year));
    return lines.map((line) => {
      const source = sources.get(line.calendarCode);
      if (line.overdueSince === null || source === undefined) return null;
      const to = vietnamDateOf(new Date(line.closedAt ?? now.toISOString()));
      let date = vietnamDateOf(new Date(line.overdueSince));
      let days = 0;
      for (let scanned = 0; date < to && scanned < MAX_OVERDUE_SCAN_DAYS; scanned += 1) {
        date = nextDay(date);
        const calendar = source.forYear(Number(date.slice(0, 4)));
        if (calendar === undefined) return null;
        if (isWorkingDay(calendar, date)) days += 1;
      }
      return days;
    });
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /**
   * Opens an issue under the SLA policy in force (ISS 3.1 step 1): the policy, the response and resolution deadlines and the working
   * calendar versions they were counted on are fixed now, in this transaction, and never recounted. `authorize` decides, once the unit,
   * the project and the contract are known to be the tenant's own, whether the caller may open an issue there. The same
   * `client_operation_id` of the same person answers the issue that already exists (an offline phone retrying), and one that asks for
   * something else under that id is refused.
   */
  async create(tx: TenantTx, input: NewIssue, actor: string, now: Date, authorize: (place: IssuePlace) => void): Promise<CreatedIssue> {
    const issue = checked(input);
    const place = await this.placeOf(tx, issue);
    authorize(place);
    const hash = requestHashOf(issue);
    const earlier = await this.operationOf(tx, actor, issue.clientOperationId, hash);
    if (earlier !== undefined) return earlier;
    await this.assertCategory(tx, issue.categoryVersionId);
    const deadline = await this.deadlines.calculate(tx, { categoryVersionId: issue.categoryVersionId, severity: issue.severity, ownerUnitId: issue.ownerUnitId, startAt: now });
    const id = randomUUID();
    const code = await this.nextCode(tx, now);
    await tx.query('savepoint issue_create');
    try {
      await tx.query(
        `insert into machvon.issue
           (tenant_id, id, code, project_id, contract_id, category_version_id, severity, title, description, source_module, source_ref_id, owner_unit_id, sla_policy_id,
            status, version, reported_by, opened_at, response_due_at, due_at, geo_consent, geo_lat, geo_lng, geo_accuracy_m, client_operation_id, client_request_hash,
            created_at, created_by, updated_at, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::uuid, $11::uuid, $12::uuid,
                 'OPEN', 1, $13::uuid, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17, $18::numeric, $19::numeric, $20::numeric, $21::uuid, $22,
                 $14::timestamptz, $13::uuid, $14::timestamptz, $13::uuid)`,
        [
          id, code, issue.projectId, issue.contractId, issue.categoryVersionId, issue.severity, issue.title, issue.description, issue.sourceModule, issue.sourceRefId,
          issue.ownerUnitId, deadline.policy.id, actor, now.toISOString(), deadline.responseDueAt.toISOString(), deadline.dueAt.toISOString(), issue.geoConsent,
          issue.geoLat, issue.geoLng, issue.geoAccuracyM, issue.clientOperationId, hash,
        ],
      );
      await tx.query('release savepoint issue_create');
    } catch (error) {
      const { code: sqlState, constraint } = error as { code?: string; constraint?: string };
      if (sqlState !== '23505') throw error;
      await tx.query('rollback to savepoint issue_create');
      // Two creates under one operation id raced: the unique index let one through, and the other is the retry it was meant to be.
      if (constraint === 'issue_client_operation_uq') {
        const raced = await this.operationOf(tx, actor, issue.clientOperationId, hash);
        if (raced !== undefined) return raced;
      }
      if (constraint === 'issue_open_source_uq') throw new DomainError('DUPLICATE_SOURCE_OPEN', 409);
      throw error;
    }
    // The evidence of how the deadlines were reached stays with the issue: the policy version and the calendar versions that were read.
    await this.record(tx, id, actor, {
      kind: 'CREATED',
      toStatus: 'OPEN',
      payload: {
        sla_policy_id: deadline.policy.id,
        sla_policy_code: deadline.policy.code,
        sla_policy_revision: deadline.policy.revision,
        calendar_version_ids: deadline.calendarVersionIds,
        response_due_at: deadline.responseDueAt.toISOString(),
        due_at: deadline.dueAt.toISOString(),
      },
    });
    return {
      id,
      code,
      projectId: issue.projectId,
      ownerUnitId: issue.ownerUnitId,
      severity: issue.severity,
      status: 'OPEN',
      assigneeId: null,
      escalationLevel: 0,
      dueAt: deadline.dueAt.toISOString(),
      version: 1,
      replayed: false,
      sourceModule: issue.sourceModule,
      responseDueAt: deadline.responseDueAt.toISOString(),
      policyId: deadline.policy.id,
      geoRecorded: issue.geoLat !== null,
    };
  }

  /**
   * Gives the issue to a person who can work it (ISS 3.1 step 2); assigning again changes the person. Giving back an issue that waits for
   * verification is the way the verifier refuses the result (ISS 3.1 step 5): it needs the reason, and the handler's claim of being done is withdrawn.
   */
  async assign(tx: TenantTx, id: string, expectedVersion: number, input: { assigneeId: string; note?: string | undefined }, actor: string, scopes: IssueScopes, now: Date): Promise<AssignedIssue> {
    const locked = await this.lock(tx, id, scopes);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    if (!ASSIGNABLE.has(locked.status)) throw new DomainError('ISSUE_STATE_INVALID', 409);
    const assigneeId = uuidOf(input.assigneeId, 'assignee_id');
    const note = input.note === undefined ? null : issueText(input.note, 'note');
    const refusal = locked.status === 'PENDING_VERIFICATION';
    if (refusal && note === null) throw invalid('note');
    if (!(await this.assigneeHolds(tx, assigneeId, placeOfLocked(locked), now))) throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 422);
    if ((locked.status === 'ASSIGNED' || locked.status === 'IN_PROGRESS') && locked.assignee_id === assigneeId) throw invalid('assignee_id');
    await tx.query(
      `update machvon.issue set assignee_id = $2::uuid, status = 'ASSIGNED', resolved_at = case when status = 'PENDING_VERIFICATION' then null else resolved_at end,
              updated_at = $4::timestamptz, updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, assigneeId, actor, now.toISOString()],
    );
    await this.record(tx, id, actor, {
      kind: locked.assignee_id === null ? 'ASSIGNED' : 'REASSIGNED',
      fromStatus: locked.status,
      toStatus: 'ASSIGNED',
      fromAssigneeId: locked.assignee_id,
      toAssigneeId: assigneeId,
      note,
      ...(refusal ? { payload: { outcome: 'VERIFICATION_REFUSED' } } : {}),
    });
    return { ...toHeader(locked, { status: 'ASSIGNED', assigneeId, version: Number(locked.version) + 1 }), previousAssigneeId: locked.assignee_id, previousStatus: locked.status };
  }

  /** The assignee takes the issue up: the response of the SLA is the moment of the first start (ISS 3.1 step 2). */
  async start(tx: TenantTx, id: string, expectedVersion: number, noteText: string | undefined, actor: string, scopes: IssueScopes, now: Date): Promise<IssueHeader> {
    const locked = await this.lock(tx, id, scopes);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    if (locked.status !== 'ASSIGNED') throw new DomainError('ISSUE_STATE_INVALID', 409);
    // Only the person it was given to starts it, whatever else they may do in the unit.
    if (locked.assignee_id !== actor) throw new DomainError('SCOPE_DENIED', 403);
    const note = noteText === undefined ? null : issueText(noteText, 'note');
    await tx.query(
      `update machvon.issue set status = 'IN_PROGRESS', responded_at = coalesce(responded_at, $3::timestamptz), updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [id, actor, now.toISOString()],
    );
    await this.record(tx, id, actor, { kind: 'STARTED', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS', note });
    return toHeader(locked, { status: 'IN_PROGRESS', version: Number(locked.version) + 1 });
  }

  /** Adds an opinion, with a document that has been scanned clean, to the timeline; the issue itself is not changed, so its version stays for the others who work on it. */
  async comment(tx: TenantTx, id: string, input: { note: string; documentVersionId?: string | undefined }, actor: string, scopes: IssueScopes): Promise<CommentedIssue> {
    const locked = await this.lock(tx, id, scopes);
    if (locked.status === 'CLOSED') throw new DomainError('ISSUE_STATE_INVALID', 409);
    const note = issueText(input.note, 'note');
    const documentVersionId = input.documentVersionId === undefined ? null : uuidOf(input.documentVersionId, 'document_version_id');
    if (documentVersionId !== null) await this.assertClean(tx, documentVersionId);
    const eventId = await this.record(tx, id, actor, { kind: documentVersionId === null ? 'COMMENTED' : 'EVIDENCE_ADDED', fromStatus: locked.status, toStatus: locked.status, note, documentVersionId });
    return { ...toHeader(locked), eventId, attachedDocument: documentVersionId !== null };
  }

  /**
   * Moves the responsibility to another unit (ISS 3.1 step 7). The deadline, the response deadline and the day the issue became overdue stay
   * what they were, so the days overdue go on counting in the new unit (BR-ISS-04); the person it is assigned to stays until the new unit decides.
   */
  async transfer(tx: TenantTx, id: string, expectedVersion: number, input: { targetUnitId: string; reason: string }, actor: string, scopes: IssueScopes, now: Date): Promise<TransferredIssue> {
    const locked = await this.lock(tx, id, scopes);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    if (locked.status === 'CLOSED') throw new DomainError('ISSUE_STATE_INVALID', 409);
    const targetUnitId = uuidOf(input.targetUnitId, 'target_unit_id');
    const reason = issueText(input.reason, 'reason');
    const units = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [targetUnitId]);
    // A unit of another tenant is indistinguishable from one that does not exist.
    if (units[0] === undefined || targetUnitId === locked.owner_unit_id) throw invalid('target_unit_id');
    await tx.query(`update machvon.issue set owner_unit_id = $2::uuid, updated_at = $4::timestamptz, updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [id, targetUnitId, actor, now.toISOString()]);
    await this.record(tx, id, actor, { kind: 'TRANSFERRED', fromStatus: locked.status, toStatus: locked.status, note: reason, payload: { from_unit_id: locked.owner_unit_id, to_unit_id: targetUnitId } });
    return { ...toHeader(locked, { ownerUnitId: targetUnitId, version: Number(locked.version) + 1 }), fromUnitId: locked.owner_unit_id };
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  /**
   * The people the issue may be given to (assignIssue accepts exactly these): the active memberships whose grants carry `issue.work` over the place
   * of the issue, by name. Undefined when the issue does not exist in the scope of the caller. One query reads the grants of every active member.
   */
  async assignees(tx: TenantTx, issueId: string, scope: ScopeBuilder, now: Date): Promise<AssigneeOption[] | undefined> {
    const issue = await this.find(tx, issueId, scope);
    if (issue === undefined) return undefined;
    const rows = await tx.query<GrantRow & { membership_id: string; display_name: string | null }>(
      `select m.id as membership_id, d.display_name, r.code, r.rank, r.permissions, g.scope_kind, g.scope_ref_ids, g.status, g.effective_from, g.effective_until,
              coalesce((select array_agg(u.path order by u.path) from machvon.organization_unit u where u.id = any(g.scope_ref_ids)), '{}') as unit_paths
         from machvon.membership m
         join machvon.role_grant g on g.tenant_id = m.tenant_id and g.membership_id = m.id and g.status = 'Active'
         join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
         left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.id
        where m.status = 'Active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        order by m.id, g.created_at, g.id`,
    );
    const byMember = new Map<string, { name: string; grants: GrantRow[] }>();
    for (const row of rows) {
      const entry = byMember.get(row.membership_id) ?? { name: row.display_name ?? '', grants: [] };
      entry.grants.push(row);
      byMember.set(row.membership_id, entry);
    }
    const people: AssigneeOption[] = [];
    for (const [membershipId, entry] of byMember) {
      const access: EffectiveAccess = { membershipId, scopeVersion: 0, membershipActive: true, grants: entry.grants.map(grantViewOf) };
      if (holdsPermission(effectivePermissions(access, now, issue.place), ISSUE_WORK_PERMISSION)) people.push({ membershipId, displayName: entry.name });
    }
    return people.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.membershipId.localeCompare(right.membershipId));
  }

  /** Whether the membership is a guest contractor: a guest sees less of an issue than the staff do. */
  async isGuest(tx: TenantTx, membershipId: string): Promise<boolean> {
    const rows = await tx.query<{ membership_type: string }>('select membership_type from machvon.membership where id = $1::uuid', [membershipId]);
    return rows[0]?.membership_type === 'GUEST_CONTRACTOR';
  }

  /** Whether a member may work an issue that lies in `place`: an active membership whose grants carry `issue.work` over it. */
  async assigneeHolds(tx: TenantTx, membershipId: string, place: ResourceRef, now: Date): Promise<boolean> {
    const members = await tx.query<{ active: boolean }>(
      `select (status = 'Active' and valid_from <= now() and (valid_until is null or valid_until > now())) as active from machvon.membership where id = $1::uuid`,
      [membershipId],
    );
    if (members[0]?.active !== true) return false;
    const grants = await this.access.grants(tx, membershipId);
    const access: EffectiveAccess = { membershipId, scopeVersion: 0, membershipActive: true, grants: grants.map((grant) => grant.view) };
    return holdsPermission(effectivePermissions(access, now, place), ISSUE_WORK_PERMISSION);
  }

  /** The unit, the project and the contract of a new issue, all of the tenant and consistent with each other. */
  private async placeOf(tx: TenantTx, issue: CheckedIssue): Promise<IssuePlace> {
    const units = await tx.query<{ path: string }>('select path from machvon.organization_unit where id = $1::uuid', [issue.ownerUnitId]);
    const projects = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [issue.projectId]);
    // What belongs to another tenant is indistinguishable from what does not exist.
    if (units[0] === undefined || projects[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (issue.contractId !== null) {
      const contracts = await tx.query<{ id: string }>('select id from machvon.contract where id = $1::uuid and project_id = $2::uuid', [issue.contractId, issue.projectId]);
      if (contracts[0] === undefined) throw invalid('contract_id');
    }
    return { ownerUnitId: issue.ownerUnitId, ownerUnitPath: units[0].path, projectId: issue.projectId, ...(issue.contractId === null ? {} : { contractId: issue.contractId }) };
  }

  /** The category must be an entry of the issue categories that is in use; a version of another tenant or of another kind of entry is refused alike. */
  private async assertCategory(tx: TenantTx, categoryVersionId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>(
      `select v.id from machvon.master_record_version v join machvon.master_record r on r.tenant_id = v.tenant_id and r.id = v.master_record_id
        where v.id = $1::uuid and v.master_type = $2 and r.status = 'EFFECTIVE'`,
      [categoryVersionId, ISSUE_CATEGORY_TYPE],
    );
    if (rows[0] === undefined) throw invalid('category_version_id');
  }

  private async assertClean(tx: TenantTx, documentVersionId: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (rows[0] === undefined) throw invalid('document_version_id');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422);
  }

  /** The issue that an earlier create under this operation id made, when there is one; the same id with another request is a conflict. */
  private async operationOf(tx: TenantTx, actor: string, operationId: string, hash: string): Promise<CreatedIssue | undefined> {
    const rows = await tx.query<LockedSql & { client_request_hash: string; source_module: IssueSource; response_due_at: string; sla_policy_id: string; geo_lat: string | null }>(
      `select ${LOCK_COLUMNS}, i.client_request_hash, i.source_module, ${iso('i.response_due_at')} as response_due_at, i.sla_policy_id, i.geo_lat::text as geo_lat
         from ${SCOPE_FROM} where i.reported_by = $1::uuid and i.client_operation_id = $2::uuid`,
      [actor, operationId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.client_request_hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
    return { ...toHeader(row), replayed: true, sourceModule: row.source_module, responseDueAt: row.response_due_at, policyId: row.sla_policy_id, geoRecorded: row.geo_lat !== null };
  }

  /** The next code of the year for the tenant, VM-yyyy-nnnnnn; one allocation at a time per tenant and year, and the unique index of the code is the last word. */
  private async nextCode(tx: TenantTx, now: Date): Promise<string> {
    const year = vietnamDateOf(now).slice(0, 4);
    await tx.query("select pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':iss-code:' || $1::text, 0))", [year]);
    const rows = await tx.query<{ next: number }>("select coalesce(max(substring(code from 9)::int), 0) + 1 as next from machvon.issue where code like $1", [`VM-${year}-%`]);
    const next = rows[0]?.next ?? 1;
    if (next > 999_999) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    return `VM-${year}-${String(next).padStart(6, '0')}`;
  }

  /** Locks the issue for update inside the scope of the caller; one the caller can read but not act on is a refusal, not a miss. */
  async lock(tx: TenantTx, id: string, scopes: IssueScopes): Promise<LockedSql> {
    const predicate = scopes.act(2);
    const rows = await tx.query<LockedSql>(`select ${LOCK_COLUMNS} from ${SCOPE_FROM} where i.id = $1::uuid and ${predicate.sql} for update of i`, [id, ...predicate.params]);
    const row = rows[0];
    if (row !== undefined) return row;
    const readable = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select i.id from ${SCOPE_FROM} where i.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /**
   * Appends an event to the timeline of an issue and answers its id. The time of the event is the time of the statement, not of the transaction, so the events
   * a job writes for one issue in one pass keep the order in which they happened.
   */
  async record(
    tx: TenantTx,
    issueId: string,
    actor: string,
    event: {
      kind: IssueEventKind;
      fromStatus?: string | null | undefined;
      toStatus?: string | null | undefined;
      fromAssigneeId?: string | null | undefined;
      toAssigneeId?: string | null | undefined;
      note?: string | null | undefined;
      documentVersionId?: string | null | undefined;
      payload?: Record<string, unknown> | undefined;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.issue_event
         (tenant_id, id, issue_id, event_kind, from_status, to_status, from_assignee_id, to_assignee_id, note, document_version_id, payload, created_by, created_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9::uuid, $10::jsonb, $11::uuid, clock_timestamp())`,
      [
        id, issueId, event.kind, event.fromStatus ?? null, event.toStatus ?? null, event.fromAssigneeId ?? null, event.toAssigneeId ?? null, event.note ?? null,
        event.documentVersionId ?? null, JSON.stringify(event.payload ?? {}), actor,
      ],
    );
    return id;
  }
}
