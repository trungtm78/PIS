import { randomUUID } from 'node:crypto';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { ResourceRef } from '@machvon/kernel';
import { PROJECT_READ_PERMISSION, accessOf, holdsOver, idOf, memberStanding } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification } from './prj-project-store.ts';
import { dateOf, invalid, lockProject, reasonOf, usableDocumentId } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Who answers for a project (ST-PRJ-005, PRJ 3.1 F9, BR-PRJ-10; Directive 162/CD-TTg): a leader in charge, a deputy and a focal officer, each for a
 * period, on the strength of a document. At most one leader in charge is ACTIVE for a project, and the periods of one role of one project never overlap, so
 * every day has one named person. An assignment is never edited: it is ended with a date and a reason and a new one is made, so the history shows who was
 * answerable on any day. The audit row and the event are written by the caller from the stored values.
 */

export const ACCOUNTABILITY_ROLES = ['LEADER_IN_CHARGE', 'DEPUTY_LEADER', 'FOCAL_OFFICER'] as const;
export type AccountabilityRole = (typeof ACCOUNTABILITY_ROLES)[number];
export type AssignmentStatus = 'ACTIVE' | 'ENDED';

export const LEADER_ASSIGNED_EVENT = 'project.leader_assigned.v1';
export const LEADER_UNASSIGNED_EVENT = 'project.leader_unassigned.v1';

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const ONE_LEADER_INDEX = 'project_accountability_leader_uq';
const NO_OVERLAP_CONSTRAINT = 'project_accountability_no_overlap';
const SAVEPOINT = 'accountability_assign';
const PROJECT_RESOURCE = 'project';
/** The sort key of an assignment inside a project is the number of days to this far date, so the latest period comes first, the leader in charge before the deputy and the focal officer. */
const FAR_DATE = '2999-12-31';

export interface AssignRequest {
  projectId: string;
  leaderMembershipId: string;
  role: string;
  validFrom: string;
  assignmentDocumentId?: string | undefined;
  actor: string;
  scopes: StageScopes;
  /** The day in Viet Nam: an assignment starts today at the latest, so what the register shows as in force is in force. */
  today: string;
  now: Date;
}

export interface EndRequest {
  assignmentId: string;
  expectedVersion: number;
  validUntil: string;
  endReason: string;
  actor: string;
  scopes: StageScopes;
  today: string;
}

/** What a command left, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface AssignmentChange {
  id: string;
  projectId: string;
  /** The internal code of the project. */
  projectCode: string;
  classification: ProjectClassification;
  /** The version the project has (it is not changed by an assignment): the aggregate version of the event. */
  projectVersion: number;
  leaderMembershipId: string;
  role: AccountabilityRole;
  validFrom: string;
  validUntil: string | null;
  status: AssignmentStatus;
  assignmentDocumentId: string | null;
  endReason: string | null;
  version: number;
}

interface AssignmentSql {
  id: string;
  project_id: string;
  leader_membership_id: string;
  accountability_role: AccountabilityRole;
  assignment_document_id: string | null;
  valid_from: string;
  valid_until: string | null;
  status: AssignmentStatus;
  end_reason: string | null;
  version: string;
}

const ASSIGNMENT_COLUMNS = `a.id, a.project_id, a.leader_membership_id, a.accountability_role, a.assignment_document_id, a.valid_from::text as valid_from,
  a.valid_until::text as valid_until, a.status, a.end_reason, a.version::text as version`;

/** One row of the register of assignments, as PRJ-17 shows it. */
export interface AssignmentLine {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  leader: { membershipId: string; displayName: string | null };
  role: AccountabilityRole;
  assignmentDocumentId: string | null;
  validFrom: string;
  validUntil: string | null;
  status: AssignmentStatus;
  endReason: string | null;
  version: number;
  /** The ordering key of the register and of its cursor. */
  codeKey: string;
}

export interface AssignmentFilter {
  projectId?: string | undefined;
  status?: AssignmentStatus | undefined;
}

interface LineSql extends AssignmentSql {
  project_code: string;
  project_name: string;
  leader_name: string | null;
  rank_key: string;
}

const isRole = (value: string): value is AccountabilityRole => (ACCOUNTABILITY_ROLES as readonly string[]).includes(value);

export class PrjAccountabilityStore {
  /**
   * Gives a project a leader, a deputy or a focal officer from a day on. The caller acts on the project inside the scope of the command (readable but not
   * actionable is 403, out of sight 404). The person must be a member of the tenant (another tenant's is 404) who is in force, is on the staff and can read the
   * project (422 LEADER_NOT_ELIGIBLE). The period must not overlap another one of the same role of the project (409 LEADER_ALREADY_ASSIGNED): a second leader in
   * charge entered at the same time as the first loses on the unique rule of the database and is told the same.
   */
  async assign(tx: TenantTx, request: AssignRequest): Promise<AssignmentChange> {
    const leaderId = idOf(request.leaderMembershipId, 'leader_membership_id');
    if (!isRole(request.role)) throw invalid('accountability_role');
    const validFrom = dateOf(request.validFrom, 'valid_from');
    if (validFrom > request.today) throw invalid('valid_from');
    const project = await lockProject(tx, request.projectId, request.scopes);
    const document = request.assignmentDocumentId === undefined ? null : await usableDocumentId(tx, request.assignmentDocumentId, 'assignment_document_id');
    await this.assertEligible(tx, leaderId, project.id, request.now);
    await this.assertFree(tx, project.id, request.role, validFrom);
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.project_accountability
           (tenant_id, id, project_id, leader_membership_id, accountability_role, assignment_document_id, valid_from, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::date, 'ACTIVE', $7::uuid, $7::uuid)`,
        [id, project.id, leaderId, request.role, document, validFrom, request.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const lost = (failure.code === UNIQUE_VIOLATION && failure.constraint === ONE_LEADER_INDEX) || (failure.code === EXCLUSION_VIOLATION && failure.constraint === NO_OVERLAP_CONSTRAINT);
      if (!lost) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('LEADER_ALREADY_ASSIGNED', 409, 'accountability_role');
    }
    return {
      id,
      projectId: project.id,
      projectCode: project.code,
      classification: project.classification,
      projectVersion: project.version,
      leaderMembershipId: leaderId,
      role: request.role,
      validFrom,
      validUntil: null,
      status: 'ACTIVE',
      assignmentDocumentId: document,
      endReason: null,
      version: 1,
    };
  }

  /**
   * Ends an assignment on a day, with the reason, under the version the caller saw. The day lies between the start of the assignment and today. An
   * assignment that has ended cannot end again (409 STAGE_TRANSITION_DENIED); the project it belongs to must lie in the scope of the command.
   */
  async end(tx: TenantTx, request: EndRequest): Promise<AssignmentChange> {
    const assignmentId = idOf(request.assignmentId, 'id');
    const owner = await tx.query<{ project_id: string }>('select project_id from machvon.project_accountability where id = $1::uuid', [assignmentId]);
    if (owner[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, owner[0].project_id, request.scopes);
    const rows = await tx.query<AssignmentSql>(`select ${ASSIGNMENT_COLUMNS} from machvon.project_accountability a where a.id = $1::uuid for update`, [assignmentId]);
    const current = rows[0];
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(current.version) !== request.expectedVersion) throw versionConflict(Number(current.version));
    if (current.status !== 'ACTIVE') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const validUntil = dateOf(request.validUntil, 'valid_until');
    if (validUntil < current.valid_from || validUntil > request.today) throw invalid('valid_until');
    const endReason = reasonOf(request.endReason, 'end_reason');
    const version = Number(current.version) + 1;
    await tx.query(
      `update machvon.project_accountability set status = 'ENDED', valid_until = $2::date, end_reason = $3, updated_at = now(), updated_by = $4::uuid, version = $5::bigint where id = $1::uuid`,
      [assignmentId, validUntil, endReason, request.actor, version],
    );
    return {
      id: assignmentId,
      projectId: project.id,
      projectCode: project.code,
      classification: project.classification,
      projectVersion: project.version,
      leaderMembershipId: current.leader_membership_id,
      role: current.accountability_role,
      validFrom: current.valid_from,
      validUntil,
      status: 'ENDED',
      assignmentDocumentId: current.assignment_document_id,
      endReason,
      version,
    };
  }

  /**
   * The assignments of the projects in the scope, a project's code first and its latest period first, one page after the anchor; a page of one project when the
   * filter names it. A project outside the scope has no line, as it has no row in the register.
   */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: AssignmentFilter, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<AssignmentLine[]> {
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `select * from (
         select ${ASSIGNMENT_COLUMNS}, p.code as project_code, p.name as project_name, lu.display_name as leader_name,
                (p.code || '|' || lpad((date '${FAR_DATE}' - a.valid_from)::text, 7, '0') || '|' || case a.accountability_role when 'LEADER_IN_CHARGE' then '1' when 'DEPUTY_LEADER' then '2' else '3' end) collate "C" as rank_key
           from ${SCOPE_FROM}
           join machvon.project_accountability a on a.tenant_id = p.tenant_id and a.project_id = p.id
           left join machvon.tenant_user_directory lu on lu.tenant_id = p.tenant_id and lu.membership_id = a.leader_membership_id
          where ($1::uuid is null or p.id = $1::uuid) and ($2::text is null or a.status = $2::text) and ${predicate.sql}
       ) listed
       where ($3::text is null or (listed.rank_key, listed.id) > ($3::text collate "C", $4::uuid))
       order by listed.rank_key, listed.id limit $5`,
      [filter.projectId ?? null, filter.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectCode: row.project_code,
      projectName: row.project_name,
      leader: { membershipId: row.leader_membership_id, displayName: row.leader_name },
      role: row.accountability_role,
      assignmentDocumentId: row.assignment_document_id,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      status: row.status,
      endReason: row.end_reason,
      version: Number(row.version),
      codeKey: row.rank_key,
    }));
  }

  /** A person who answers for a project is on the staff, in force, and able to read the project: the unit that owns it or the unit that invests in it. */
  private async assertEligible(tx: TenantTx, leaderId: string, projectId: string, now: Date): Promise<void> {
    const member = await memberStanding(tx, leaderId);
    const places = await tx.query<{ owner_id: string; owner_path: string; investor_id: string | null; investor_path: string | null }>(
      `select ou.id as owner_id, ou.path as owner_path, iu.id as investor_id, iu.path as investor_path from ${SCOPE_FROM} where p.id = $1::uuid`,
      [projectId],
    );
    const place = places[0];
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const access = await accessOf(tx, member);
    const refs: ResourceRef[] = [{ ownerUnitId: place.owner_id, ownerUnitPath: place.owner_path, projectId }];
    if (place.investor_id !== null && place.investor_path !== null) refs.push({ ownerUnitId: place.investor_id, ownerUnitPath: place.investor_path, projectId });
    if (!member.active || !member.staff || !refs.some((ref) => holdsOver(access, PROJECT_READ_PERMISSION, ref, now))) throw new DomainError('LEADER_NOT_ELIGIBLE', 422, 'leader_membership_id');
  }

  /** The role of the project is free from the day on: no period of the same role, ended or not, reaches that day or later. */
  private async assertFree(tx: TenantTx, projectId: string, role: AccountabilityRole, validFrom: string): Promise<void> {
    const taken = await tx.query<{ id: string }>(
      `select id from machvon.project_accountability where project_id = $1::uuid and accountability_role = $2 and daterange(valid_from, valid_until, '[]') && daterange($3::date, null, '[]')`,
      [projectId, role, validFrom],
    );
    if (taken[0] !== undefined) throw new DomainError('LEADER_ALREADY_ASSIGNED', 409, 'accountability_role');
  }
}

/** The audit row and the event of an assignment that was made. */
export function assignmentMadeRecord(change: AssignmentChange, tenantId: string, actorId: string, occurredAt: Date) {
  return {
    audit: {
      action: 'project.leader_assigned',
      resourceType: PROJECT_RESOURCE,
      resourceId: change.projectId,
      classification: change.classification,
      diff: {
        assignment_id: change.id,
        code: change.projectCode,
        leader_membership_id: change.leaderMembershipId,
        accountability_role: change.role,
        valid_from: change.validFrom,
        assignment_document_id: change.assignmentDocumentId,
      },
    },
    event: eventOf(LEADER_ASSIGNED_EVENT, change, tenantId, actorId, occurredAt, { valid_from: change.validFrom, assignment_document_id: change.assignmentDocumentId }),
  };
}

/** The audit row and the event of an assignment that was ended. */
export function assignmentEndedRecord(change: AssignmentChange, tenantId: string, actorId: string, occurredAt: Date) {
  return {
    audit: {
      action: 'project.leader_unassigned',
      resourceType: PROJECT_RESOURCE,
      resourceId: change.projectId,
      classification: change.classification,
      ...(change.endReason === null ? {} : { reason: change.endReason }),
      diff: {
        assignment_id: change.id,
        code: change.projectCode,
        leader_membership_id: change.leaderMembershipId,
        accountability_role: change.role,
        valid_from: change.validFrom,
        valid_until: change.validUntil,
      },
    },
    event: eventOf(LEADER_UNASSIGNED_EVENT, change, tenantId, actorId, occurredAt, { valid_until: change.validUntil }),
  };
}

function eventOf(type: string, change: AssignmentChange, tenantId: string, actorId: string, occurredAt: Date, own: Record<string, unknown>) {
  return {
    aggregateType: PROJECT_RESOURCE,
    aggregateId: change.projectId,
    aggregateVersion: change.projectVersion,
    type,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      project_id: change.projectId,
      version: change.projectVersion,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      assignment_id: change.id,
      leader_membership_id: change.leaderMembershipId,
      accountability_role: change.role,
      ...own,
    },
    // One event per assignment and per version of it: the same command repeated writes nothing a second time.
    eventKey: `${PROJECT_RESOURCE}:${change.projectId}:assignment:${change.id}:${change.version}`,
  };
}
