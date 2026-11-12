import { randomUUID } from 'node:crypto';
import {
  DIRECTIVE_STATUSES,
  DomainError,
  activeGrants,
  addDirectiveDays,
  assertCloseEvidence,
  assertDirectiveCloser,
  assertExtension,
  assertExtensionDecider,
  directiveClock,
  directiveScopeKindOf,
  directiveStatusOf,
  isDirectiveDay,
  meetingTypeOf,
  nextDirectiveStatus,
  periodCounts,
  permissionMatches,
  periodFacts,
  versionConflict,
} from '@machvon/kernel';
import type { DirectiveClock, DirectiveEventType, EffectiveAccess, DirectiveHistory, DirectivePolicy, DirectiveScopeKind, DirectiveStatus, MeetingType, PeriodCounts, PeriodDirectiveFacts, StoredDirectiveStatus } from '@machvon/kernel';
import { decisionDocument } from './ctr-decision-document.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { projectScope } from './prj-project-store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const MAX_TEXT = 2000;
const MAX_TITLE = 300;
const MAX_SUMMARY = 4000;
const MAX_EVIDENCE = 20;
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const NAME_OF = (membership: string): string => `(select u.display_name from machvon.tenant_user_directory u where u.tenant_id = d.tenant_id and u.membership_id = ${membership})`;
/** The most directives one read gives: a report or a summary that hits it says so (`truncated`), never a silent cut. */
export const DIRECTIVE_READ_LIMIT = 5000;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string | undefined | null, field: string): string => {
  if (value === undefined || value === null || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: unknown, field: string, max = MAX_TEXT): string => {
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) throw invalid(field);
  return trimmed;
};
const dayOf = (value: unknown, field: string): string => {
  if (!isDirectiveDay(value)) throw invalid(field);
  return value;
};
const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

// -- Scope ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The directive with the places its scope is judged by: the project and its two units, the unit it is about (`su`) and the unit that must do it (`au`). */
const SCOPE_JOINS = `left join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id
  left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  join machvon.organization_unit su on su.tenant_id = d.tenant_id and su.id = d.scope_unit_id
  join machvon.organization_unit au on au.tenant_id = d.tenant_id and au.id = d.assignee_unit_id`;

export const DIRECTIVE_FROM = `machvon.directive d
  join machvon.steering_meeting m on m.tenant_id = d.tenant_id and m.id = d.meeting_id
  ${SCOPE_JOINS}
  left join machvon.directive_extension x on x.tenant_id = d.tenant_id and x.directive_id = d.id and x.status = 'REQUESTED'`;

/**
 * The scope of a directive for a permission: it is in scope when the unit it is about or the unit that must do it lies in a scope of a grant that carries the permission, or when the project it is about does
 * (the owner unit, the investor unit or a grant that names the project). Compiled over the aliases of `DIRECTIVE_FROM`; the parameters are numbered from `first`.
 */
export function directiveScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const about = scopePredicate(access, permission, now, { unitPath: 'su.path', unitId: 'su.id' }, first);
    if (about.sql === 'true') return about;
    const doing = scopePredicate(access, permission, now, { unitPath: 'au.path', unitId: 'au.id' }, first + about.params.length);
    if (doing.sql === 'true') return doing;
    const projects = projectScope(access, permission, now)(first + about.params.length + doing.params.length);
    const params = [...about.params, ...doing.params, ...projects.params];
    return { sql: `(${about.sql} or ${doing.sql} or (d.project_id is not null and ${projects.sql}))`, params };
  };
}

/** The units a meeting is judged by: the unit that held it (`mu`), or any directive of it that the caller reaches. */
export function meetingScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const held = scopePredicate(access, permission, now, { unitPath: 'mu.path', unitId: 'mu.id' }, first);
    if (held.sql === 'true') return held;
    const inner = directiveScope(access, permission, now)(first + held.params.length);
    const given = `exists (select 1 from machvon.directive d ${SCOPE_JOINS} where d.tenant_id = m.tenant_id and d.meeting_id = m.id and ${inner.sql})`;
    return { sql: `(${held.sql} or ${given})`, params: [...held.params, ...inner.params] };
  };
}

/** The units the caller holds a permission over (alias `su`). */
export function directiveUnitScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => scopePredicate(access, permission, now, { unitPath: 'su.path', unitId: 'su.id' }, first);
}

/** Whether a grant of the permission is held at all (a caller with none sees nothing, whatever the filter). */
export function holdsDirectivePermission(access: EffectiveAccess, permission: string, now: Date): boolean {
  return activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));
}

// -- Shapes -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface UnitRef {
  id: string;
  code: string;
  name: string;
}

export interface DirectiveLine {
  id: string;
  code: string;
  seq: number;
  meeting: { id: string; code: string; meetingDate: string; title: string };
  scopeKind: DirectiveScopeKind;
  project: { id: string; code: string; name: string } | null;
  scopeUnit: UnitRef;
  text: string;
  assigneeUnit: UnitRef;
  assignee: { membershipId: string; displayName: string } | null;
  originalDueOn: string;
  dueOn: string;
  extensionCount: number;
  storedStatus: StoredDirectiveStatus;
  closedAt: string | null;
  closedBy: string | null;
  evidenceCount: number;
  /** The latest progress that was reported (0 to 100), null when no note of progress carried one: never 0 for "nothing reported". */
  progressPct: number | null;
  /** When that progress was reported. */
  progressReportedAt: string | null;
  openExtension: { id: string; proposedDueOn: string; requestedBy: string; version: number } | null;
  createdBy: { membershipId: string; displayName: string };
  createdAt: string;
  version: number;
  clock: DirectiveClock;
  /** Where the directive lies for the test of a permission: the units it is about and that must do it, and its project. */
  places: Array<{ ownerUnitId: string; ownerUnitPath: string; projectId?: string }>;
}

export interface MeetingLine {
  id: string;
  code: string;
  meetingDate: string;
  meetingType: MeetingType;
  title: string;
  summary: string | null;
  unit: UnitRef;
  unitPath: string;
  minutesDocumentVersionId: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
  counts: DirectiveCounts;
}

export interface DirectiveCounts {
  total: number;
  /** By the status a reader sees, every status present with 0 where there is none. */
  byStatus: Readonly<Record<DirectiveStatus, number>>;
}

export interface DirectiveEventView {
  id: string;
  type: DirectiveEventType;
  actor: { membershipId: string; displayName: string };
  occurredAt: string;
  note: string | null;
  progressPct: number | null;
  fromAssigneeUnit: UnitRef | null;
  toAssigneeUnit: UnitRef | null;
  fromAssigneeMembershipId: string | null;
  toAssigneeMembershipId: string | null;
  fromDueOn: string | null;
  toDueOn: string | null;
  extensionId: string | null;
  approver: { membershipId: string; displayName: string } | null;
  directiveVersion: number;
}

export interface ExtensionView {
  id: string;
  fromDueOn: string;
  proposedDueOn: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  requestedBy: { membershipId: string; displayName: string };
  requestedAt: string;
  decidedBy: { membershipId: string; displayName: string } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface EvidenceView {
  id: string;
  documentVersionId: string;
  title: string | null;
  addedBy: { membershipId: string; displayName: string };
  addedAt: string;
  eventId: string;
}

export interface DirectiveDetail {
  directive: DirectiveLine;
  events: DirectiveEventView[];
  extensions: ExtensionView[];
  evidence: EvidenceView[];
}

export interface MeetingDetail {
  meeting: MeetingLine;
  directives: DirectiveLine[];
  truncated: boolean;
}

export interface DirectiveFilter {
  status?: DirectiveStatus | undefined;
  meetingId?: string | undefined;
  projectId?: string | undefined;
  /** The unit that must do it, with the units below it. */
  unitId?: string | undefined;
  assigneeMembershipId?: string | undefined;
  /** Open and past its due day. */
  overdue?: boolean | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
  q?: string | undefined;
}

export interface DirectiveSummary {
  total: number;
  byStatus: Readonly<Record<DirectiveStatus, number>>;
  /** Open directives that are due within the reminder days or today. */
  dueSoon: number;
  /** Overdue by at least the escalation days: raised to the head of the unit. */
  escalated: number;
  byUnit: Array<{ unit: UnitRef; total: number; open: number; overdue: number; done: number }>;
  truncated: boolean;
}

export interface MeetingInput {
  meetingDate: string;
  meetingType: string;
  title: string;
  summary?: string | undefined;
  unitId: string;
  minutesDocumentVersionId?: string | undefined;
}

export interface DirectiveInput {
  scopeKind: string;
  projectId?: string | undefined;
  unitId?: string | undefined;
  text: string;
  assigneeUnitId: string;
  assigneeMembershipId?: string | undefined;
  dueOn: string;
}

export interface AssignInput {
  assigneeUnitId?: string | undefined;
  /** `null` takes the person off, leaving the unit; undefined leaves the person as it is. */
  assigneeMembershipId?: string | null | undefined;
  note?: string | undefined;
}

export interface ProgressInput {
  note: string;
  progressPct?: number | undefined;
  evidenceDocumentVersionIds?: readonly string[] | undefined;
}

export interface ExtensionInput {
  proposedDueOn: string;
  reason: string;
}

export interface CloseInput {
  note: string;
  evidenceDocumentVersionIds?: readonly string[] | undefined;
}

/** What a command on a directive moved, for the audit row, the event of the outbox and the answer. */
export interface DirectiveCommandResult {
  id: string;
  directiveId: string;
  meetingId: string;
  projectId: string | null;
  code: string;
  version: number;
  status: string;
  storedStatus: StoredDirectiveStatus;
  dueOn: string;
  assigneeUnitId: string;
  eventId: string | null;
  extensionId: string | null;
}

export interface MeetingCommandResult {
  id: string;
  code: string;
  unitId: string;
  version: number;
  status: string;
  meetingDate: string;
  minutesDocumentVersionId: string | null;
}

export interface ReportItem {
  id: string;
  code: string;
  meeting: { id: string; code: string; meetingDate: string };
  scopeKind: DirectiveScopeKind;
  project: { id: string; code: string; name: string } | null;
  text: string;
  assigneeUnit: UnitRef;
  /** The due day on the last day of the period (an extension approved later is not counted). */
  dueOnAtEnd: string;
  statusAtEnd: DirectiveStatus;
  facts: PeriodDirectiveFacts;
  /** The latest note of progress, closing or cancelling on or before the last day. */
  lastNote: string | null;
  lastNoteOn: string | null;
}

export interface ReportView {
  from: string;
  to: string;
  counts: PeriodCounts;
  items: ReportItem[];
  truncated: boolean;
}

interface DirectiveSql {
  id: string;
  code: string;
  seq: number;
  meeting_id: string;
  meeting_code: string;
  meeting_date: string;
  meeting_title: string;
  scope_kind: DirectiveScopeKind;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  scope_unit_id: string;
  scope_unit_code: string;
  scope_unit_name: string;
  scope_unit_path: string;
  directive_text: string;
  assignee_unit_id: string;
  assignee_unit_code: string;
  assignee_unit_name: string;
  assignee_unit_path: string;
  assignee_membership_id: string | null;
  assignee_name: string | null;
  original_due_on: string;
  due_on: string;
  extension_count: number;
  status: StoredDirectiveStatus;
  closed_at: string | null;
  closed_by: string | null;
  evidence_count: number;
  progress_pct: number | null;
  progress_reported_at: string | null;
  extension_id: string | null;
  extension_proposed_due_on: string | null;
  extension_requested_by: string | null;
  extension_version: string | null;
  created_by: string;
  created_name: string | null;
  created_at: string;
  version: string;
}

const DIRECTIVE_COLUMNS = `d.id, d.code, d.seq, d.meeting_id, m.code as meeting_code, m.meeting_date::text as meeting_date, m.title as meeting_title,
  d.scope_kind, d.project_id, p.code as project_code, p.name as project_name,
  d.scope_unit_id, su.code as scope_unit_code, su.name as scope_unit_name, su.path as scope_unit_path,
  d.directive_text, d.assignee_unit_id, au.code as assignee_unit_code, au.name as assignee_unit_name, au.path as assignee_unit_path,
  d.assignee_membership_id, ${NAME_OF('d.assignee_membership_id')} as assignee_name,
  d.original_due_on::text as original_due_on, d.due_on::text as due_on, d.extension_count, d.status, ${ISO('d.closed_at')} as closed_at, d.closed_by,
  (select count(*) from machvon.directive_evidence e where e.tenant_id = d.tenant_id and e.directive_id = d.id)::int as evidence_count,
  (select ev.progress_pct from machvon.directive_event ev where ev.tenant_id = d.tenant_id and ev.directive_id = d.id and ev.progress_pct is not null order by ev.occurred_at desc, ev.id desc limit 1) as progress_pct,
  (select ${ISO('ev.occurred_at')} from machvon.directive_event ev where ev.tenant_id = d.tenant_id and ev.directive_id = d.id and ev.progress_pct is not null order by ev.occurred_at desc, ev.id desc limit 1) as progress_reported_at,
  x.id as extension_id, x.proposed_due_on::text as extension_proposed_due_on, x.requested_by as extension_requested_by, x.version::text as extension_version,
  d.created_by, ${NAME_OF('d.created_by')} as created_name, ${ISO('d.created_at')} as created_at, d.version::text as version`;

function toLine(row: DirectiveSql, today: string, policy: DirectivePolicy): DirectiveLine {
  return {
    id: row.id,
    code: row.code,
    seq: row.seq,
    meeting: { id: row.meeting_id, code: row.meeting_code, meetingDate: row.meeting_date, title: row.meeting_title },
    scopeKind: row.scope_kind,
    project: row.project_id === null ? null : { id: row.project_id, code: row.project_code ?? '', name: row.project_name ?? '' },
    scopeUnit: { id: row.scope_unit_id, code: row.scope_unit_code, name: row.scope_unit_name },
    text: row.directive_text,
    assigneeUnit: { id: row.assignee_unit_id, code: row.assignee_unit_code, name: row.assignee_unit_name },
    assignee: row.assignee_membership_id === null ? null : { membershipId: row.assignee_membership_id, displayName: row.assignee_name ?? '' },
    originalDueOn: row.original_due_on,
    dueOn: row.due_on,
    extensionCount: row.extension_count,
    storedStatus: row.status,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    evidenceCount: row.evidence_count,
    progressPct: row.progress_pct,
    progressReportedAt: row.progress_reported_at,
    openExtension: row.extension_id === null ? null : { id: row.extension_id, proposedDueOn: row.extension_proposed_due_on ?? '', requestedBy: row.extension_requested_by ?? '', version: Number(row.extension_version) },
    createdBy: { membershipId: row.created_by, displayName: row.created_name ?? '' },
    createdAt: row.created_at,
    version: Number(row.version),
    clock: directiveClock(row.status, row.due_on, today, policy),
    places: [
      { ownerUnitId: row.scope_unit_id, ownerUnitPath: row.scope_unit_path, ...(row.project_id === null ? {} : { projectId: row.project_id }) },
      { ownerUnitId: row.assignee_unit_id, ownerUnitPath: row.assignee_unit_path, ...(row.project_id === null ? {} : { projectId: row.project_id }) },
    ],
  };
}

const emptyByStatus = (): Record<DirectiveStatus, number> => ({ OPEN: 0, IN_PROGRESS: 0, DONE: 0, OVERDUE: 0, CANCELLED: 0 });

/** SQL that says what a reader sees of a directive on the day `today` (a parameter): an open directive past its due day is OVERDUE. */
const EFFECTIVE_STATUS = (today: string): string => `(case when d.status in ('OPEN', 'IN_PROGRESS') and d.due_on < ${today}::date then 'OVERDUE' else d.status end)`;

/**
 * The steering meetings and their directives (customer requirements CN.03 and QT.02, governance deepening lane DIR-1). A meeting is recorded with its day, type, convening unit and minutes; a directive is given in a
 * meeting about a project or a unit, to a unit and optionally a person, with a due day, and is followed on a timeline that is never edited. Closing needs evidence (where the policy says so) and a person who is
 * neither the one who recorded the directive nor the one who must do it; moving the due day is asked for with a reason and decided by someone other than who asked, within the days and the number of times the
 * policy gives. Every command takes the lock of its row, checks the version where it is versioned, and writes one event of the timeline; the audit row and the event of the outbox are the controller's.
 */
export class DirDirectiveStore {
  // -- Meetings ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Records a meeting held on a day (not in the future) by a unit within the scope of the caller; its code is `GB-<year>-<number>`, numbered in the year. */
  async createMeeting(tx: TenantTx, input: MeetingInput, actor: string, unitScope: ScopeBuilder, today: string): Promise<MeetingCommandResult> {
    const meetingDate = dayOf(input.meetingDate, 'meeting_date');
    if (meetingDate > today) throw invalid('meeting_date', 'IN_THE_FUTURE');
    const type = meetingTypeOf(input.meetingType);
    if (type === undefined) throw invalid('meeting_type');
    const title = textOf(input.title, 'title', MAX_TITLE);
    const summary = input.summary === undefined ? null : textOf(input.summary, 'summary', MAX_SUMMARY);
    const unitId = idOf(input.unitId, 'unit_id');
    await this.assertUnit(tx, unitId, unitScope, 'unit_id');
    const minutes = input.minutesDocumentVersionId === undefined ? null : (await decisionDocument(tx, input.minutesDocumentVersionId, 'minutes_document_version_id')).versionId;
    const year = Number(meetingDate.slice(0, 4));
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('steering_meeting:' || ${TENANT}::text || ':' || $1::text, 0))`, [year]);
    const [next] = await tx.query<{ seq: number }>('select (coalesce(max(seq), 0) + 1)::int as seq from machvon.steering_meeting where meeting_year = $1::smallint', [year]);
    const seq = next?.seq ?? 1;
    const code = `GB-${year}-${pad(seq, 3)}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.steering_meeting (tenant_id, id, code, meeting_year, seq, meeting_date, meeting_type, title, summary, unit_id, minutes_document_version_id, created_by)
       values (${TENANT}, $1::uuid, $2, $3::smallint, $4, $5::date, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid)`,
      [id, code, year, seq, meetingDate, type, title, summary, unitId, minutes, actor],
    );
    return { id, code, unitId, version: 1, status: 'RECORDED', meetingDate, minutesDocumentVersionId: minutes };
  }

  /** Attaches (or replaces) the minutes of a meeting: a version of a file of the tenant that is not infected. */
  async attachMinutes(tx: TenantTx, meetingId: string, expectedVersion: number, documentVersionId: string, scope: ScopeBuilder): Promise<MeetingCommandResult> {
    const id = idOf(meetingId, 'id');
    const row = await this.lockMeeting(tx, id, scope);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const document = await decisionDocument(tx, documentVersionId, 'document_version_id');
    await tx.query('update machvon.steering_meeting set minutes_document_version_id = $2::uuid, version = version + 1, updated_at = now() where id = $1::uuid', [id, document.versionId]);
    return { id, code: row.code, unitId: row.unit_id, version: Number(row.version) + 1, status: 'MINUTES_ATTACHED', meetingDate: row.meeting_date, minutesDocumentVersionId: document.versionId };
  }

  private async lockMeeting(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<{ id: string; code: string; unit_id: string; meeting_date: string; version: string }> {
    const predicate = scope(2);
    const [row] = await tx.query<{ id: string; code: string; unit_id: string; meeting_date: string; version: string }>(
      `select m.id, m.code, m.unit_id, m.meeting_date::text as meeting_date, m.version::text as version
         from machvon.steering_meeting m join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.unit_id
        where m.id = $1::uuid and ${predicate.sql} for update of m`,
      [id, ...predicate.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async assertUnit(tx: TenantTx, unitId: string, unitScope: ScopeBuilder | undefined, field: string): Promise<void> {
    const [exists] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (exists === undefined) throw invalid(field, 'NOT_A_UNIT');
    if (unitScope === undefined) return;
    const predicate = unitScope(2);
    const [reached] = await tx.query<{ id: string }>(`select su.id from machvon.organization_unit su where su.id = $1::uuid and ${predicate.sql}`, [unitId, ...predicate.params]);
    if (reached === undefined) throw new DomainError('SCOPE_DENIED', 403, field);
  }

  // -- Directives -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Gives a directive in a meeting about a project (in the scope of the caller) or a unit (the same), to a unit and optionally a person, due on a day not before the meeting. */
  async addDirective(
    tx: TenantTx,
    meetingId: string,
    input: DirectiveInput,
    actor: string,
    scopes: { meeting: ScopeBuilder; project: ScopeBuilder; unit: ScopeBuilder },
  ): Promise<DirectiveCommandResult> {
    const mid = idOf(meetingId, 'id');
    const kind = directiveScopeKindOf(input.scopeKind);
    if (kind === undefined) throw invalid('scope_kind');
    const text = textOf(input.text, 'text');
    const dueOn = dayOf(input.dueOn, 'due_on');
    const assigneeUnitId = idOf(input.assigneeUnitId, 'assignee_unit_id');
    const meeting = await this.lockMeeting(tx, mid, scopes.meeting);
    if (dueOn < meeting.meeting_date) throw invalid('due_on', 'BEFORE_THE_MEETING');
    let projectId: string | null = null;
    let scopeUnitId: string;
    if (kind === 'PROJECT') {
      if (input.unitId !== undefined) throw invalid('unit_id', 'NOT_FOR_A_PROJECT');
      projectId = idOf(input.projectId, 'project_id');
      const predicate = scopes.project(2);
      const [project] = await tx.query<{ owner_unit_id: string }>(
        `select p.owner_unit_id from machvon.project p
           join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
           left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
          where p.id = $1::uuid and ${predicate.sql}`,
        [projectId, ...predicate.params],
      );
      if (project === undefined) {
        const [exists] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [projectId]);
        if (exists === undefined) throw invalid('project_id', 'NOT_A_PROJECT');
        throw new DomainError('SCOPE_DENIED', 403, 'project_id');
      }
      scopeUnitId = project.owner_unit_id;
    } else {
      if (input.projectId !== undefined) throw invalid('project_id', 'NOT_FOR_A_UNIT');
      scopeUnitId = idOf(input.unitId, 'unit_id');
      await this.assertUnit(tx, scopeUnitId, scopes.unit, 'unit_id');
    }
    await this.assertUnit(tx, assigneeUnitId, undefined, 'assignee_unit_id');
    const assigneeMembershipId = input.assigneeMembershipId === undefined ? null : idOf(input.assigneeMembershipId, 'assignee_membership_id');
    if (assigneeMembershipId !== null) await this.assertMembership(tx, assigneeMembershipId, 'assignee_membership_id');
    const [next] = await tx.query<{ seq: number }>('select (coalesce(max(seq), 0) + 1)::int as seq from machvon.directive where meeting_id = $1::uuid', [mid]);
    const seq = next?.seq ?? 1;
    const code = `${meeting.code}/CD-${pad(seq, 2)}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.directive (tenant_id, id, meeting_id, seq, code, scope_kind, project_id, scope_unit_id, directive_text, assignee_unit_id, assignee_membership_id, original_due_on, due_on, created_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9::uuid, $10::uuid, $11::date, $11::date, $12::uuid)`,
      [id, mid, seq, code, kind, projectId, scopeUnitId, text, assigneeUnitId, assigneeMembershipId, dueOn, actor],
    );
    const eventId = await this.writeEvent(tx, id, 'CREATED', actor, 1, { to_assignee_unit_id: assigneeUnitId, to_assignee_membership_id: assigneeMembershipId, to_due_on: dueOn, note: null });
    return { id, directiveId: id, meetingId: mid, projectId, code, version: 1, status: 'OPEN', storedStatus: 'OPEN', dueOn, assigneeUnitId, eventId, extensionId: null };
  }

  /** Gives the directive to another unit or person (or takes the person off): the new assignee is written on the timeline with the old one. */
  async assign(tx: TenantTx, directiveId: string, expectedVersion: number, input: AssignInput, actor: string, scope: ScopeBuilder): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    nextDirectiveStatus(row.status, 'ASSIGN');
    if (input.assigneeUnitId === undefined && input.assigneeMembershipId === undefined) throw invalid('assignee_unit_id', 'NOTHING_TO_ASSIGN');
    const unitId = input.assigneeUnitId === undefined ? row.assignee_unit_id : idOf(input.assigneeUnitId, 'assignee_unit_id');
    const membershipId = input.assigneeMembershipId === undefined ? row.assignee_membership_id : input.assigneeMembershipId === null ? null : idOf(input.assigneeMembershipId, 'assignee_membership_id');
    if (unitId === row.assignee_unit_id && membershipId === row.assignee_membership_id) throw invalid('assignee_unit_id', 'NO_CHANGE');
    if (unitId !== row.assignee_unit_id) await this.assertUnit(tx, unitId, undefined, 'assignee_unit_id');
    if (membershipId !== null && membershipId !== row.assignee_membership_id) await this.assertMembership(tx, membershipId, 'assignee_membership_id');
    const note = input.note === undefined ? null : textOf(input.note, 'note');
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set assignee_unit_id = $2::uuid, assignee_membership_id = $3::uuid, version = $4, updated_at = now() where id = $1::uuid', [row.id, unitId, membershipId, version]);
    const eventId = await this.writeEvent(tx, row.id, 'ASSIGNED', actor, version, {
      from_assignee_unit_id: row.assignee_unit_id,
      to_assignee_unit_id: unitId,
      from_assignee_membership_id: row.assignee_membership_id,
      to_assignee_membership_id: membershipId,
      note,
    });
    return { ...resultOf(row), version, assigneeUnitId: unitId, eventId };
  }

  /** A note of progress (and documents, if any): the first note takes an open directive to in progress. */
  async recordProgress(tx: TenantTx, directiveId: string, input: ProgressInput, actor: string, scope: ScopeBuilder): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    const next = nextDirectiveStatus(row.status, 'PROGRESS');
    const note = textOf(input.note, 'note');
    if (input.progressPct !== undefined && (!Number.isInteger(input.progressPct) || input.progressPct < 0 || input.progressPct > 100)) throw invalid('progress_pct');
    const evidence = await this.checkedEvidence(tx, input.evidenceDocumentVersionIds, 'evidence_document_version_ids');
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set status = $2, version = $3, updated_at = now() where id = $1::uuid', [row.id, next, version]);
    const eventId = await this.writeEvent(tx, row.id, 'PROGRESS', actor, version, { note, progress_pct: input.progressPct ?? null });
    await this.addEvidence(tx, row.id, eventId, evidence, actor);
    return { ...resultOf(row), version, status: next, storedStatus: next, eventId };
  }

  /** Asks to move the due day: one request open at a time, within the days and the number of times the policy gives. */
  async requestExtension(tx: TenantTx, directiveId: string, input: ExtensionInput, actor: string, scope: ScopeBuilder, policy: DirectivePolicy): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    nextDirectiveStatus(row.status, 'REQUEST_EXTENSION');
    const proposed = dayOf(input.proposedDueOn, 'proposed_due_on');
    const reason = textOf(input.reason, 'reason');
    if (row.extension_id !== null) throw new DomainError('DIRECTIVE_EXTENSION_PENDING', 409, 'proposed_due_on', { extensions: { extension_id: row.extension_id } });
    assertExtension(policy, { currentDueOn: row.due_on, proposedDueOn: proposed, extensionCount: row.extension_count });
    const extensionId = randomUUID();
    await tx.query(
      `insert into machvon.directive_extension (tenant_id, id, directive_id, from_due_on, proposed_due_on, reason, requested_by) values (${TENANT}, $1::uuid, $2::uuid, $3::date, $4::date, $5, $6::uuid)`,
      [extensionId, row.id, row.due_on, proposed, reason, actor],
    );
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set version = $2, updated_at = now() where id = $1::uuid', [row.id, version]);
    const eventId = await this.writeEvent(tx, row.id, 'EXTENSION_REQUESTED', actor, version, { extension_id: extensionId, from_due_on: row.due_on, to_due_on: proposed, note: reason });
    return { ...resultOf(row), version, status: 'EXTENSION_REQUESTED', eventId, extensionId };
  }

  /** Decides a request to move the due day: by someone other than who asked; approving moves the day and counts the extension, rejecting leaves everything and ends the request with its reason. */
  async decideExtension(
    tx: TenantTx,
    extensionId: string,
    expectedVersion: number,
    input: { decision: string; reason: string },
    actor: string,
    scope: ScopeBuilder,
    policy: DirectivePolicy,
  ): Promise<DirectiveCommandResult> {
    const decision = input.decision === 'approve' || input.decision === 'reject' ? input.decision : undefined;
    if (decision === undefined) throw invalid('decision');
    const reason = textOf(input.reason, 'reason');
    const id = idOf(extensionId, 'id');
    const [peek] = await tx.query<{ directive_id: string }>('select directive_id from machvon.directive_extension where id = $1::uuid', [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.lockDirective(tx, peek.directive_id, scope);
    const [extension] = await tx.query<{ status: string; requested_by: string; from_due_on: string; proposed_due_on: string; version: string }>(
      'select status, requested_by, from_due_on::text as from_due_on, proposed_due_on::text as proposed_due_on, version::text as version from machvon.directive_extension where id = $1::uuid for update',
      [id],
    );
    if (extension === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(extension.version) !== expectedVersion) throw versionConflict(Number(extension.version));
    if (extension.status !== 'REQUESTED') throw new DomainError('DIRECTIVE_EXTENSION_STATE_INVALID', 409, 'status', { extensions: { extension_status: extension.status } });
    nextDirectiveStatus(row.status, 'DECIDE_EXTENSION');
    assertExtensionDecider(actor, extension.requested_by);
    const version = Number(row.version) + 1;
    if (decision === 'approve') {
      // The day and the count are looked at again as they stand now: what was allowed when it was asked for is what the decision rests on.
      assertExtension(policy, { currentDueOn: row.due_on, proposedDueOn: extension.proposed_due_on, extensionCount: row.extension_count });
      await tx.query("update machvon.directive_extension set status = 'APPROVED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, version = version + 1 where id = $1::uuid", [id, actor, reason]);
      await tx.query('update machvon.directive set due_on = $2::date, extension_count = extension_count + 1, version = $3, updated_at = now() where id = $1::uuid', [row.id, extension.proposed_due_on, version]);
      const eventId = await this.writeEvent(tx, row.id, 'EXTENSION_APPROVED', actor, version, { extension_id: id, from_due_on: row.due_on, to_due_on: extension.proposed_due_on, approver_id: actor, note: reason });
      return { ...resultOf(row), id, version: Number(extension.version) + 1, status: 'APPROVED', dueOn: extension.proposed_due_on, eventId, extensionId: id };
    }
    await tx.query("update machvon.directive_extension set status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, version = version + 1 where id = $1::uuid", [id, actor, reason]);
    await tx.query('update machvon.directive set version = $2, updated_at = now() where id = $1::uuid', [row.id, version]);
    const eventId = await this.writeEvent(tx, row.id, 'EXTENSION_REJECTED', actor, version, { extension_id: id, approver_id: actor, note: reason });
    return { ...resultOf(row), id, version: Number(extension.version) + 1, status: 'REJECTED', eventId, extensionId: id };
  }

  /** Closes a directive as done: by someone other than who recorded it and who must do it, with evidence where the policy says so; an open request to move the due day is decided first. */
  async close(tx: TenantTx, directiveId: string, expectedVersion: number, input: CloseInput, actor: string, scope: ScopeBuilder, policy: DirectivePolicy): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const next = nextDirectiveStatus(row.status, 'CLOSE');
    const note = textOf(input.note, 'note');
    assertDirectiveCloser(actor, { createdBy: row.created_by, assigneeMembershipId: row.assignee_membership_id });
    this.assertNoOpenExtension(row);
    const evidence = await this.checkedEvidence(tx, input.evidenceDocumentVersionIds, 'evidence_document_version_ids');
    const fresh = await this.newEvidenceCount(tx, row.id, evidence);
    assertCloseEvidence(policy, row.evidence_count + fresh);
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set status = $2, closed_by = $3::uuid, closed_at = now(), version = $4, updated_at = now() where id = $1::uuid', [row.id, next, actor, version]);
    const eventId = await this.writeEvent(tx, row.id, 'CLOSED', actor, version, { note });
    await this.addEvidence(tx, row.id, eventId, evidence, actor);
    return { ...resultOf(row), version, status: next, storedStatus: next, eventId };
  }

  /** Cancels a directive that is no longer to be done, with the reason; an open request to move the due day is decided first. */
  async cancel(tx: TenantTx, directiveId: string, expectedVersion: number, reasonInput: string, actor: string, scope: ScopeBuilder): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const next = nextDirectiveStatus(row.status, 'CANCEL');
    const reason = textOf(reasonInput, 'reason');
    this.assertNoOpenExtension(row);
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set status = $2, closed_by = $3::uuid, closed_at = now(), version = $4, updated_at = now() where id = $1::uuid', [row.id, next, actor, version]);
    const eventId = await this.writeEvent(tx, row.id, 'CANCELLED', actor, version, { note: reason });
    return { ...resultOf(row), version, status: next, storedStatus: next, eventId };
  }

  /** Reopens a done directive (back to in progress) or a cancelled one (back to open), with the reason. */
  async reopen(tx: TenantTx, directiveId: string, expectedVersion: number, reasonInput: string, actor: string, scope: ScopeBuilder): Promise<DirectiveCommandResult> {
    const row = await this.lockDirective(tx, directiveId, scope);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const next = nextDirectiveStatus(row.status, 'REOPEN');
    const reason = textOf(reasonInput, 'reason');
    const version = Number(row.version) + 1;
    await tx.query('update machvon.directive set status = $2, closed_by = null, closed_at = null, version = $3, updated_at = now() where id = $1::uuid', [row.id, next, version]);
    const eventId = await this.writeEvent(tx, row.id, 'REOPENED', actor, version, { note: reason });
    return { ...resultOf(row), version, status: next, storedStatus: next, eventId };
  }

  // -- Reads ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The directives in the scope of the caller, the ones that are late first: ordered by whether the directive is overdue, then due day, then id; the cursor is the position of the last line. The filters narrow the
   * list; the status filter is the status a reader sees (OVERDUE is an open directive past its due day).
   */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: DirectiveFilter,
    request: { limit: number; after: { rank: number; dueOn: string; id: string } | undefined },
    today: string,
    policy: DirectivePolicy,
  ): Promise<DirectiveLine[]> {
    const where = this.whereOf(filter, scope, today, 1);
    const params = [...where.params];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const after = request.after === undefined ? '' : `where (q.rk, q.due_on, q.id) > (${next(request.after.rank)}::int, ${next(request.after.dueOn)}::text,${next(request.after.id)}::uuid)`;
    const limit = next(request.limit);
    const rows = await tx.query<DirectiveSql & { rk: number }>(
      `select * from (
         select ${DIRECTIVE_COLUMNS}, (case when d.status in ('OPEN', 'IN_PROGRESS') and d.due_on < $${where.todayIndex}::date then 0 when d.status in ('OPEN', 'IN_PROGRESS') then 1 else 2 end) as rk
           from ${DIRECTIVE_FROM} where ${where.sql}
       ) q ${after} order by q.rk, q.due_on, q.id limit ${limit}`,
      params,
    );
    return rows.map((row) => toLine(row, today, policy));
  }

  /** The anchor of the cursor after a line: its position in the order of `list`. */
  anchorOf(line: DirectiveLine, today: string): { rank: number; dueOn: string; id: string } {
    const live = line.storedStatus === 'OPEN' || line.storedStatus === 'IN_PROGRESS';
    return { rank: live ? (line.dueOn < today ? 0 : 1) : 2, dueOn: line.dueOn, id: line.id };
  }

  /** One directive with its timeline, its requests to move the due day and its evidence; undefined when the caller does not reach it. */
  async detail(tx: TenantTx, directiveId: string, scope: ScopeBuilder, today: string, policy: DirectivePolicy): Promise<DirectiveDetail | undefined> {
    const id = idOf(directiveId, 'id');
    const predicate = scope(2);
    const [row] = await tx.query<DirectiveSql>(`select ${DIRECTIVE_COLUMNS} from ${DIRECTIVE_FROM} where d.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (row === undefined) return undefined;
    const events = await tx.query<{
      id: string;
      event_type: DirectiveEventType;
      actor_id: string;
      actor_name: string | null;
      occurred_at: string;
      note: string | null;
      progress_pct: number | null;
      from_unit_id: string | null;
      from_unit_code: string | null;
      from_unit_name: string | null;
      to_unit_id: string | null;
      to_unit_code: string | null;
      to_unit_name: string | null;
      from_assignee_membership_id: string | null;
      to_assignee_membership_id: string | null;
      from_due_on: string | null;
      to_due_on: string | null;
      extension_id: string | null;
      approver_id: string | null;
      approver_name: string | null;
      directive_version: string;
    }>(
      `select d.id, d.event_type, d.actor_id, ${NAME_OF('d.actor_id')} as actor_name, ${ISO('d.occurred_at')} as occurred_at, d.note, d.progress_pct,
              fu.id as from_unit_id, fu.code as from_unit_code, fu.name as from_unit_name, tu.id as to_unit_id, tu.code as to_unit_code, tu.name as to_unit_name,
              d.from_assignee_membership_id, d.to_assignee_membership_id, d.from_due_on::text as from_due_on, d.to_due_on::text as to_due_on, d.extension_id, d.approver_id, ${NAME_OF('d.approver_id')} as approver_name, d.directive_version::text as directive_version
         from machvon.directive_event d
         left join machvon.organization_unit fu on fu.tenant_id = d.tenant_id and fu.id = d.from_assignee_unit_id
         left join machvon.organization_unit tu on tu.tenant_id = d.tenant_id and tu.id = d.to_assignee_unit_id
        where d.directive_id = $1::uuid order by d.occurred_at, d.id`,
      [id],
    );
    const extensions = await tx.query<{
      id: string;
      from_due_on: string;
      proposed_due_on: string;
      reason: string;
      status: ExtensionView['status'];
      requested_by: string;
      requested_name: string | null;
      requested_at: string;
      decided_by: string | null;
      decided_name: string | null;
      decided_at: string | null;
      decision_reason: string | null;
      version: string;
    }>(
      `select d.id, d.from_due_on::text as from_due_on, d.proposed_due_on::text as proposed_due_on, d.reason, d.status, d.requested_by, ${NAME_OF('d.requested_by')} as requested_name, ${ISO('d.requested_at')} as requested_at,
              d.decided_by, ${NAME_OF('d.decided_by')} as decided_name, ${ISO('d.decided_at')} as decided_at, d.decision_reason, d.version::text as version
         from machvon.directive_extension d where d.directive_id = $1::uuid order by d.requested_at, d.id`,
      [id],
    );
    const evidence = await tx.query<{ id: string; document_version_id: string; title: string | null; added_by: string; added_name: string | null; added_at: string; event_id: string }>(
      `select d.id, d.document_version_id, doc.title, d.added_by, ${NAME_OF('d.added_by')} as added_name, ${ISO('d.added_at')} as added_at, d.event_id
         from machvon.directive_evidence d
         left join machvon.document_version v on v.tenant_id = d.tenant_id and v.id = d.document_version_id
         left join machvon.document doc on doc.tenant_id = v.tenant_id and doc.id = v.document_id
        where d.directive_id = $1::uuid order by d.added_at, d.id`,
      [id],
    );
    const unit = (unitId: string | null, code: string | null, name: string | null): UnitRef | null => (unitId === null ? null : { id: unitId, code: code ?? '', name: name ?? '' });
    return {
      directive: toLine(row, today, policy),
      events: events.map((event) => ({
        id: event.id,
        type: event.event_type,
        actor: { membershipId: event.actor_id, displayName: event.actor_name ?? '' },
        occurredAt: event.occurred_at,
        note: event.note,
        progressPct: event.progress_pct,
        fromAssigneeUnit: unit(event.from_unit_id, event.from_unit_code, event.from_unit_name),
        toAssigneeUnit: unit(event.to_unit_id, event.to_unit_code, event.to_unit_name),
        fromAssigneeMembershipId: event.from_assignee_membership_id,
        toAssigneeMembershipId: event.to_assignee_membership_id,
        fromDueOn: event.from_due_on,
        toDueOn: event.to_due_on,
        extensionId: event.extension_id,
        approver: event.approver_id === null ? null : { membershipId: event.approver_id, displayName: event.approver_name ?? '' },
        directiveVersion: Number(event.directive_version),
      })),
      extensions: extensions.map((extension) => ({
        id: extension.id,
        fromDueOn: extension.from_due_on,
        proposedDueOn: extension.proposed_due_on,
        reason: extension.reason,
        status: extension.status,
        requestedBy: { membershipId: extension.requested_by, displayName: extension.requested_name ?? '' },
        requestedAt: extension.requested_at,
        decidedBy: extension.decided_by === null ? null : { membershipId: extension.decided_by, displayName: extension.decided_name ?? '' },
        decidedAt: extension.decided_at,
        decisionReason: extension.decision_reason,
        version: Number(extension.version),
      })),
      evidence: evidence.map((item) => ({ id: item.id, documentVersionId: item.document_version_id, title: item.title, addedBy: { membershipId: item.added_by, displayName: item.added_name ?? '' }, addedAt: item.added_at, eventId: item.event_id })),
    };
  }

  /** The meetings in the scope of the caller, the latest first, each with the counts of its directives by the status a reader sees. */
  async listMeetings(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { unitId?: string | undefined; meetingType?: string | undefined; from?: string | undefined; to?: string | undefined },
    request: { limit: number; after: { code: string; id: string } | undefined },
    today: string,
  ): Promise<MeetingLine[]> {
    const params: unknown[] = [];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions: string[] = [];
    if (filter.unitId !== undefined) conditions.push(`starts_with(mu.path, (select path from machvon.organization_unit where id = ${next(idOf(filter.unitId, 'unit_id'))}::uuid))`);
    if (filter.meetingType !== undefined) {
      const type = meetingTypeOf(filter.meetingType);
      if (type === undefined) throw invalid('meeting_type');
      conditions.push(`m.meeting_type = ${next(type)}`);
    }
    if (filter.from !== undefined) conditions.push(`m.meeting_date >= ${next(dayOf(filter.from, 'from'))}::date`);
    if (filter.to !== undefined) conditions.push(`m.meeting_date <= ${next(dayOf(filter.to, 'to'))}::date`);
    if (request.after !== undefined) conditions.push(`(m.meeting_date, m.id) < (${next(request.after.code)}::date, ${next(request.after.id)}::uuid)`);
    const predicate = scope(params.length + 1);
    params.push(...predicate.params);
    const limit = next(request.limit);
    const rows = await tx.query<MeetingSql>(
      `select ${MEETING_COLUMNS} from machvon.steering_meeting m join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.unit_id
        where ${[...conditions, predicate.sql].join(' and ')} order by m.meeting_date desc, m.id desc limit ${limit}`,
      params,
    );
    return this.withCounts(tx, rows, today);
  }

  /** One meeting with its directives; undefined when the caller does not reach it. The directives are those the caller reaches. */
  async meetingDetail(tx: TenantTx, meetingId: string, meetingScopeBuilder: ScopeBuilder, directives: ScopeBuilder, today: string, policy: DirectivePolicy): Promise<MeetingDetail | undefined> {
    const id = idOf(meetingId, 'id');
    const predicate = meetingScopeBuilder(2);
    const rows = await tx.query<MeetingSql>(
      `select ${MEETING_COLUMNS} from machvon.steering_meeting m join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.unit_id where m.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    if (rows[0] === undefined) return undefined;
    const [meeting] = await this.withCounts(tx, rows, today);
    if (meeting === undefined) return undefined;
    const lines = await this.list(tx, directives, { meetingId: id }, { limit: DIRECTIVE_READ_LIMIT + 1, after: undefined }, today, policy);
    return { meeting, directives: lines.slice(0, DIRECTIVE_READ_LIMIT).sort((a, b) => a.seq - b.seq), truncated: lines.length > DIRECTIVE_READ_LIMIT };
  }

  private async withCounts(tx: TenantTx, rows: MeetingSql[], today: string): Promise<MeetingLine[]> {
    const counts = new Map<string, Record<DirectiveStatus, number>>();
    if (rows.length > 0) {
      // What the meeting gave, whoever may read the directives: the counts are the meeting's own, the lines are the reader's.
      const grouped = await tx.query<{ meeting_id: string; status: DirectiveStatus; n: number }>(
        `select d.meeting_id, ${EFFECTIVE_STATUS('$2')} as status, count(*)::int as n from machvon.directive d where d.meeting_id = any($1::uuid[]) group by 1, 2`,
        [rows.map((row) => row.id), today],
      );
      for (const group of grouped) {
        const entry = counts.get(group.meeting_id) ?? emptyByStatus();
        entry[group.status] = group.n;
        counts.set(group.meeting_id, entry);
      }
    }
    return rows.map((row) => {
      const byStatus = counts.get(row.id) ?? emptyByStatus();
      return {
        id: row.id,
        code: row.code,
        meetingDate: row.meeting_date,
        meetingType: row.meeting_type,
        title: row.title,
        summary: row.summary,
        unit: { id: row.unit_id, code: row.unit_code, name: row.unit_name },
        unitPath: row.unit_path,
        minutesDocumentVersionId: row.minutes_document_version_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        version: Number(row.version),
        counts: { total: DIRECTIVE_STATUSES.reduce((sum, status) => sum + byStatus[status], 0), byStatus },
      };
    });
  }

  /** The counts of the directives in the scope of the caller: by the status a reader sees, those due soon and escalated, and for each unit that must do them. */
  async summary(tx: TenantTx, scope: ScopeBuilder, filter: DirectiveFilter, today: string, policy: DirectivePolicy): Promise<DirectiveSummary> {
    const where = this.whereOf(filter, scope, today, 1);
    const rows = await tx.query<{ status: DirectiveStatus; stored: StoredDirectiveStatus; due_on: string; unit_id: string; unit_code: string; unit_name: string }>(
      `select ${EFFECTIVE_STATUS(`$${where.todayIndex}`)} as status, d.status as stored, d.due_on::text as due_on, au.id as unit_id, au.code as unit_code, au.name as unit_name
         from ${DIRECTIVE_FROM} where ${where.sql} limit ${DIRECTIVE_READ_LIMIT + 1}`,
      where.params,
    );
    const shown = rows.slice(0, DIRECTIVE_READ_LIMIT);
    const byStatus = emptyByStatus();
    const units = new Map<string, { unit: UnitRef; total: number; open: number; overdue: number; done: number }>();
    let dueSoon = 0;
    let escalated = 0;
    for (const row of shown) {
      byStatus[row.status] += 1;
      const clock = directiveClock(row.stored, row.due_on, today, policy);
      if (clock.phase === 'DUE_SOON' || clock.phase === 'DUE_TODAY') dueSoon += 1;
      if (clock.phase === 'ESCALATED') escalated += 1;
      const entry = units.get(row.unit_id) ?? { unit: { id: row.unit_id, code: row.unit_code, name: row.unit_name }, total: 0, open: 0, overdue: 0, done: 0 };
      entry.total += 1;
      if (row.status === 'OPEN' || row.status === 'IN_PROGRESS') entry.open += 1;
      if (row.status === 'OVERDUE') entry.overdue += 1;
      if (row.status === 'DONE') entry.done += 1;
      units.set(row.unit_id, entry);
    }
    const byUnit = [...units.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total || a.unit.code.localeCompare(b.unit.code, 'en') || a.unit.id.localeCompare(b.unit.id, 'en'));
    return { total: shown.length, byStatus, dueSoon, escalated, byUnit, truncated: rows.length > DIRECTIVE_READ_LIMIT };
  }

  /**
   * The directives of a period for the narrative of the next report (BR-DIR-07; `directivesForReport(period)` of DIS and MNE): every directive in the scope of the caller that was raised in `[from, to]`, closed or
   * extended in it, or was still open at its end (and had not ended before it began), with its state on the last day replayed from its timeline and the counts that the list adds up to.
   */
  async forReport(tx: TenantTx, scope: ScopeBuilder, period: { from: string; to: string }, filter: Pick<DirectiveFilter, 'projectId' | 'unitId'> = {}): Promise<ReportView> {
    const from = dayOf(period.from, 'from');
    const to = dayOf(period.to, 'to');
    if (to < from) throw invalid('to', 'BEFORE_FROM');
    const where = this.whereOf(filter, scope, to, 1);
    where.params.push(from);
    // `$todayIndex` is the last day of the period here: the candidates are the directives that existed by then and had not ended before the period began.
    const rows = await tx.query<DirectiveSql>(
      `select ${DIRECTIVE_COLUMNS} from ${DIRECTIVE_FROM}
        where ${where.sql} and m.meeting_date <= $${where.todayIndex}::date and (d.status in ('OPEN', 'IN_PROGRESS') or d.closed_at >= $${where.params.length}::date)
        order by m.meeting_date desc, d.code limit ${DIRECTIVE_READ_LIMIT + 1}`,
      where.params,
    );
    const shown = rows.slice(0, DIRECTIVE_READ_LIMIT);
    const history = new Map<string, DirectiveHistory['events'][number][]>();
    const notes = new Map<string, { note: string; day: string }>();
    if (shown.length > 0) {
      const events = await tx.query<{ directive_id: string; event_type: DirectiveEventType; day: string; to_due_on: string | null; note: string | null }>(
        `select e.directive_id, e.event_type, (e.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date::text as day, e.to_due_on::text as to_due_on, e.note
           from machvon.directive_event e where e.directive_id = any($1::uuid[]) and e.event_type in ('CREATED', 'PROGRESS', 'EXTENSION_APPROVED', 'CLOSED', 'CANCELLED', 'REOPENED')
          order by e.occurred_at, e.id`,
        [shown.map((row) => row.id)],
      );
      for (const event of events) {
        const list = history.get(event.directive_id) ?? [];
        list.push({ type: event.event_type, day: event.day, toDueOn: event.to_due_on });
        history.set(event.directive_id, list);
        if (event.day <= to && event.note !== null && ['PROGRESS', 'CLOSED', 'CANCELLED'].includes(event.event_type)) notes.set(event.directive_id, { note: event.note, day: event.day });
      }
    }
    const items: ReportItem[] = [];
    const allFacts: PeriodDirectiveFacts[] = [];
    for (const row of shown) {
      const events = history.get(row.id) ?? [];
      const record: DirectiveHistory = { raisedOn: row.meeting_date, originalDueOn: row.original_due_on, events };
      const facts = periodFacts(record, from, to);
      if (facts === undefined) continue;
      // The due day on the last day: replay without the extensions approved afterwards.
      let dueOnAtEnd = row.original_due_on;
      for (const event of events) if (event.type === 'EXTENSION_APPROVED' && event.day <= to && event.toDueOn !== null) dueOnAtEnd = event.toDueOn;
      const note = notes.get(row.id);
      allFacts.push(facts);
      items.push({
        id: row.id,
        code: row.code,
        meeting: { id: row.meeting_id, code: row.meeting_code, meetingDate: row.meeting_date },
        scopeKind: row.scope_kind,
        project: row.project_id === null ? null : { id: row.project_id, code: row.project_code ?? '', name: row.project_name ?? '' },
        text: row.directive_text,
        assigneeUnit: { id: row.assignee_unit_id, code: row.assignee_unit_code, name: row.assignee_unit_name },
        dueOnAtEnd,
        statusAtEnd: facts.statusAtEnd,
        facts,
        lastNote: note?.note ?? null,
        lastNoteOn: note?.day ?? null,
      });
    }
    return { from, to, counts: periodCounts(allFacts), items, truncated: rows.length > DIRECTIVE_READ_LIMIT };
  }

  /** `directivesForReport(period)`: the name that DIS and MNE read the directives of a period by when they build the narrative input of the next report; the same as `forReport`. */
  directivesForReport(tx: TenantTx, scope: ScopeBuilder, period: { from: string; to: string }, filter: Pick<DirectiveFilter, 'projectId' | 'unitId'> = {}): Promise<ReportView> {
    return this.forReport(tx, scope, period, filter);
  }

  // -- Internals --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The filter as SQL over the aliases of `DIRECTIVE_FROM`, after the scope; `todayIndex` is the parameter that holds the day the status is read on. */
  private whereOf(filter: Pick<DirectiveFilter, 'status' | 'meetingId' | 'projectId' | 'unitId' | 'assigneeMembershipId' | 'overdue' | 'dueFrom' | 'dueTo' | 'q'>, scope: ScopeBuilder, today: string, first: number): { sql: string; params: unknown[]; todayIndex: number } {
    const params: unknown[] = [today];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${first + params.length - 1}`;
    };
    const todayParam = `$${first}`;
    const predicate = scope(first + params.length);
    params.push(...predicate.params);
    const conditions: string[] = [predicate.sql];
    if (filter.status !== undefined) {
      const status = directiveStatusOf(filter.status);
      if (status === undefined) throw invalid('status');
      conditions.push(`${EFFECTIVE_STATUS(todayParam)} = ${next(status)}`);
    }
    if (filter.overdue === true) conditions.push(`d.status in ('OPEN', 'IN_PROGRESS') and d.due_on < ${todayParam}::date`);
    if (filter.meetingId !== undefined) conditions.push(`d.meeting_id = ${next(idOf(filter.meetingId, 'meeting_id'))}::uuid`);
    if (filter.projectId !== undefined) conditions.push(`d.project_id = ${next(idOf(filter.projectId, 'project_id'))}::uuid`);
    if (filter.unitId !== undefined) conditions.push(`starts_with(au.path, (select path from machvon.organization_unit where id = ${next(idOf(filter.unitId, 'unit_id'))}::uuid))`);
    if (filter.assigneeMembershipId !== undefined) conditions.push(`d.assignee_membership_id = ${next(idOf(filter.assigneeMembershipId, 'assignee_membership_id'))}::uuid`);
    if (filter.dueFrom !== undefined) conditions.push(`d.due_on >= ${next(dayOf(filter.dueFrom, 'due_from'))}::date`);
    if (filter.dueTo !== undefined) conditions.push(`d.due_on <= ${next(dayOf(filter.dueTo, 'due_to'))}::date`);
    if (filter.q !== undefined) {
      const pattern = next(likePattern(textOf(filter.q, 'q', 200)));
      conditions.push(`(d.directive_text ilike ${pattern} escape '\\' or d.code ilike ${pattern} escape '\\' or m.title ilike ${pattern} escape '\\')`);
    }
    return { sql: conditions.join(' and '), params, todayIndex: first };
  }

  private async lockDirective(tx: TenantTx, directiveId: string, scope: ScopeBuilder): Promise<DirectiveRow> {
    const id = idOf(directiveId, 'id');
    const predicate = scope(2);
    const [row] = await tx.query<DirectiveRow>(
      `select d.id, d.code, d.meeting_id, d.project_id, d.status, d.due_on::text as due_on, d.original_due_on::text as original_due_on, d.extension_count, d.assignee_unit_id, d.assignee_membership_id, d.created_by, d.version::text as version,
              x.id as extension_id,
              (select count(*) from machvon.directive_evidence e where e.tenant_id = d.tenant_id and e.directive_id = d.id)::int as evidence_count
         from ${DIRECTIVE_FROM} where d.id = $1::uuid and ${predicate.sql} for update of d`,
      [id, ...predicate.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private assertNoOpenExtension(row: DirectiveRow): void {
    if (row.extension_id !== null) throw new DomainError('DIRECTIVE_EXTENSION_PENDING', 409, 'status', { extensions: { extension_id: row.extension_id } });
  }

  private async assertMembership(tx: TenantTx, membershipId: string, field: string): Promise<void> {
    const [row] = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [membershipId]);
    if (row === undefined) throw invalid(field, 'NOT_A_MEMBER');
  }

  /** The documents a command brings as evidence: distinct, at most `MAX_EVIDENCE`, each a version of a file of the tenant that is not infected. */
  private async checkedEvidence(tx: TenantTx, ids: readonly string[] | undefined, field: string): Promise<string[]> {
    if (ids === undefined || ids.length === 0) return [];
    if (ids.length > MAX_EVIDENCE) throw invalid(field, 'TOO_MANY');
    const distinct = [...new Set(ids.map((value) => idOf(value, field)))];
    const checked: string[] = [];
    for (const versionId of distinct) checked.push((await decisionDocument(tx, versionId, field)).versionId);
    return checked;
  }

  private async newEvidenceCount(tx: TenantTx, directiveId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const [row] = await tx.query<{ n: number }>('select count(*)::int as n from machvon.directive_evidence where directive_id = $1::uuid and document_version_id = any($2::uuid[])', [directiveId, ids]);
    return ids.length - (row?.n ?? 0);
  }

  private async addEvidence(tx: TenantTx, directiveId: string, eventId: string, ids: readonly string[], actor: string): Promise<void> {
    for (const versionId of ids) {
      await tx.query(
        `insert into machvon.directive_evidence (tenant_id, id, directive_id, event_id, document_version_id, added_by) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid) on conflict (tenant_id, directive_id, document_version_id) do nothing`,
        [randomUUID(), directiveId, eventId, versionId, actor],
      );
    }
  }

  private async writeEvent(
    tx: TenantTx,
    directiveId: string,
    type: DirectiveEventType,
    actor: string,
    directiveVersion: number,
    fields: Partial<Record<'note' | 'progress_pct' | 'from_assignee_unit_id' | 'to_assignee_unit_id' | 'from_assignee_membership_id' | 'to_assignee_membership_id' | 'from_due_on' | 'to_due_on' | 'extension_id' | 'approver_id', string | number | null>>,
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.directive_event (tenant_id, id, directive_id, event_type, actor_id, note, progress_pct, from_assignee_unit_id, to_assignee_unit_id, from_assignee_membership_id, to_assignee_membership_id, from_due_on, to_due_on, extension_id, approver_id, directive_version)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::smallint, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::date, $12::date, $13::uuid, $14::uuid, $15::bigint)`,
      [
        id,
        directiveId,
        type,
        actor,
        fields.note ?? null,
        fields.progress_pct ?? null,
        fields.from_assignee_unit_id ?? null,
        fields.to_assignee_unit_id ?? null,
        fields.from_assignee_membership_id ?? null,
        fields.to_assignee_membership_id ?? null,
        fields.from_due_on ?? null,
        fields.to_due_on ?? null,
        fields.extension_id ?? null,
        fields.approver_id ?? null,
        directiveVersion,
      ],
    );
    return id;
  }
}

interface DirectiveRow {
  id: string;
  code: string;
  meeting_id: string;
  project_id: string | null;
  status: StoredDirectiveStatus;
  due_on: string;
  original_due_on: string;
  extension_count: number;
  assignee_unit_id: string;
  assignee_membership_id: string | null;
  created_by: string;
  version: string;
  extension_id: string | null;
  evidence_count: number;
}

const resultOf = (row: DirectiveRow): DirectiveCommandResult => ({
  id: row.id,
  directiveId: row.id,
  meetingId: row.meeting_id,
  projectId: row.project_id,
  code: row.code,
  version: Number(row.version),
  status: row.status,
  storedStatus: row.status,
  dueOn: row.due_on,
  assigneeUnitId: row.assignee_unit_id,
  eventId: null,
  extensionId: null,
});

interface MeetingSql {
  id: string;
  code: string;
  meeting_date: string;
  meeting_type: MeetingType;
  title: string;
  summary: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  unit_path: string;
  minutes_document_version_id: string | null;
  created_by: string;
  created_at: string;
  version: string;
}

const MEETING_COLUMNS = `m.id, m.code, m.meeting_date::text as meeting_date, m.meeting_type, m.title, m.summary, m.unit_id, mu.code as unit_code, mu.name as unit_name, mu.path as unit_path,
  m.minutes_document_version_id, m.created_by, ${ISO('m.created_at')} as created_at, m.version::text as version`;

/** Days before `day`, for the callers that show a window; re-exported so the controller has one place for day arithmetic. */
export const dayBefore = (day: string, days: number): string => addDirectiveDays(day, -days);
