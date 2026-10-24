import { randomUUID } from 'node:crypto';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { idOf, memberStanding, reachesSubtree, textOf, withinSubtree } from './prj-accountability-support.ts';
import { dateOf, invalid, reasonOf, usableDocumentId } from './prj-stage-support.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The task forces that press the disbursement of the projects of an area (ST-PRJ-005, PRJ 3.1 F9; Directive 162/CD-TTg): a force has a code, a purpose, a
 * lead, a subtree of organisation units that is its scope, and members, each for a term and optionally for one project that the member follows. A member must
 * belong to the tenant and have a grant that reaches into the scope of the force (422 MEMBER_OUT_OF_SCOPE); a member of another tenant does not exist (404).
 * Dissolving a force ends every open term in the same transaction. Nothing is edited or deleted: a term is made and ended, so the history shows who sat
 * in the force on any day. The audit row and the event are written by the caller from the stored values.
 */

export const TASK_FORCE_MEMBER_ROLES = ['LEAD', 'MEMBER', 'SECRETARY'] as const;
export type TaskForceMemberRole = (typeof TASK_FORCE_MEMBER_ROLES)[number];
export type TaskForceStatus = 'ACTIVE' | 'DISSOLVED';

export const TASK_FORCE_CREATED_EVENT = 'taskforce.created.v1';
export const TASK_FORCE_DISSOLVED_EVENT = 'taskforce.dissolved.v1';

const UNIQUE_VIOLATION = '23505';
const CODE_INDEX = 'task_force_code_uq';
const MEMBER_INDEX = 'task_force_member_active_uq';
const SAVEPOINT = 'task_force_write';
const RESOURCE = 'task_force';

/** The scope of a read of the task forces: the forces whose scope unit lies in a subtree the caller holds the permission over (the aliases `u` of the list query). */
export function taskForceScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, first);
}

export interface CreateRequest {
  code: string;
  name: string;
  purpose: string;
  leadMembershipId: string;
  scopeUnitId: string;
  validFrom: string;
  establishmentDocumentId?: string | undefined;
  actor: string;
  today: string;
  now: Date;
}

export interface AddMemberRequest {
  taskForceId: string;
  membershipId: string;
  role: string;
  projectId?: string | undefined;
  validFrom: string;
  actor: string;
  today: string;
  now: Date;
}

export interface DissolveRequest {
  taskForceId: string;
  expectedVersion: number;
  reason: string;
  actor: string;
  today: string;
}

/** What a command left of a task force, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface TaskForceChange {
  id: string;
  code: string;
  scopeUnitId: string;
  leadMembershipId: string;
  status: TaskForceStatus;
  validFrom: string;
  validUntil: string | null;
  establishmentDocumentId: string | null;
  version: number;
  /** The terms in force after the command. */
  openMembers: number;
  /** The terms that the command ended (a dissolution ends them all). */
  endedMembers: number;
  reason: string | null;
}

/** What adding a member left. */
export interface MemberAdded {
  taskForceId: string;
  code: string;
  memberId: string;
  membershipId: string;
  role: TaskForceMemberRole;
  projectId: string | null;
  validFrom: string;
  /** The version of the force after the addition: a change of who sits in it is a change of the force. */
  taskForceVersion: number;
}

interface TaskForceSql {
  id: string;
  code: string;
  name: string;
  purpose: string;
  lead_membership_id: string;
  scope_unit_id: string;
  establishment_document_id: string | null;
  valid_from: string;
  valid_until: string | null;
  status: TaskForceStatus;
  version: string;
}

const FORCE_COLUMNS = `f.id, f.code, f.name, f.purpose, f.lead_membership_id, f.scope_unit_id, f.establishment_document_id, f.valid_from::text as valid_from,
  f.valid_until::text as valid_until, f.status, f.version::text as version`;

export interface TaskForceMemberLine {
  id: string;
  membershipId: string;
  displayName: string | null;
  role: TaskForceMemberRole;
  project: { id: string; code: string; name: string } | null;
  validFrom: string;
  validUntil: string | null;
}

/** One task force with its terms, as PRJ-18 shows it. */
export interface TaskForceLine {
  id: string;
  code: string;
  name: string;
  purpose: string;
  lead: { membershipId: string; displayName: string | null };
  scopeUnit: { id: string; code: string; name: string };
  establishmentDocumentId: string | null;
  validFrom: string;
  validUntil: string | null;
  status: TaskForceStatus;
  version: number;
  members: TaskForceMemberLine[];
  /** The ordering key of the list and of its cursor: the code. */
  codeKey: string;
}

interface LineSql extends TaskForceSql {
  lead_name: string | null;
  unit_code: string;
  unit_name: string;
}

interface MemberSql {
  id: string;
  task_force_id: string;
  membership_id: string;
  display_name: string | null;
  member_role: TaskForceMemberRole;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  valid_from: string;
  valid_until: string | null;
}

const isMemberRole = (value: string): value is TaskForceMemberRole => (TASK_FORCE_MEMBER_ROLES as readonly string[]).includes(value);

export class PrjTaskForceStore {
  /**
   * Founds a task force with its lead as the first member. The scope unit must be a unit of the tenant (another tenant's is 404), the lead a member of the
   * tenant whose grants reach into the scope (422 MEMBER_OUT_OF_SCOPE), the founding document one that still stands, the day not later than today. A code is
   * used once in a tenant (409 TASK_FORCE_CODE_DUPLICATE), also when two forces with it are founded at the same time.
   */
  async create(tx: TenantTx, request: CreateRequest): Promise<TaskForceChange> {
    const code = textOf(request.code, 'code', { min: 1, max: 30 });
    const name = textOf(request.name, 'name', { min: 3, max: 300 });
    const purpose = textOf(request.purpose, 'purpose', { min: 10, max: 2000, multiline: true });
    const leadId = idOf(request.leadMembershipId, 'lead_membership_id');
    const unitId = idOf(request.scopeUnitId, 'scope_unit_id');
    const validFrom = dateOf(request.validFrom, 'valid_from');
    if (validFrom > request.today) throw invalid('valid_from');
    const unit = await this.unitOf(tx, unitId);
    const document = request.establishmentDocumentId === undefined ? null : await usableDocumentId(tx, request.establishmentDocumentId, 'establishment_document_id');
    await this.assertReaches(tx, leadId, unit.path, request.now, 'lead_membership_id');
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.task_force
           (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, establishment_document_id, valid_from, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::date, 'ACTIVE', $9::uuid, $9::uuid)`,
        [id, code, name, purpose, leadId, unitId, document, validFrom, request.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== CODE_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('TASK_FORCE_CODE_DUPLICATE', 409, 'code');
    }
    await this.insertMember(tx, { forceId: id, membershipId: leadId, role: 'LEAD', projectId: null, validFrom, actor: request.actor });
    return { id, code, scopeUnitId: unitId, leadMembershipId: leadId, status: 'ACTIVE', validFrom, validUntil: null, establishmentDocumentId: document, version: 1, openMembers: 1, endedMembers: 0, reason: null };
  }

  /**
   * Seats a member in a force, for a term from a day on, optionally to follow one project. The force must be active (409 TASK_FORCE_DISSOLVED); the member must
   * belong to the tenant (404 otherwise) and have a grant that reaches into the scope of the force (422 MEMBER_OUT_OF_SCOPE); the project, when named, must
   * belong to the tenant and be owned by a unit inside the scope of the force. The lead sits from the foundation, so no other member takes the role LEAD.
   * The same member for the same project twice at once is 409 DUPLICATE_KEY. The force's version goes up: who sits in it is part of what it is.
   */
  async addMember(tx: TenantTx, request: AddMemberRequest): Promise<MemberAdded> {
    const forceId = idOf(request.taskForceId, 'id');
    const membershipId = idOf(request.membershipId, 'membership_id');
    if (!isMemberRole(request.role) || request.role === 'LEAD') throw invalid('member_role');
    const projectId = request.projectId === undefined ? null : idOf(request.projectId, 'project_id');
    const validFrom = dateOf(request.validFrom, 'valid_from');
    if (validFrom > request.today) throw invalid('valid_from');
    const force = await this.lock(tx, forceId);
    if (force.status !== 'ACTIVE') throw new DomainError('TASK_FORCE_DISSOLVED', 409);
    if (validFrom < force.valid_from) throw invalid('valid_from');
    const unit = await this.unitOf(tx, force.scope_unit_id);
    await this.assertReaches(tx, membershipId, unit.path, request.now, 'membership_id');
    if (projectId !== null) await this.assertFollowable(tx, projectId, unit.path);
    const memberId = await this.insertMember(tx, { forceId, membershipId, role: request.role, projectId, validFrom, actor: request.actor });
    const version = Number(force.version) + 1;
    await tx.query('update machvon.task_force set updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid', [forceId, request.actor, version]);
    return { taskForceId: forceId, code: force.code, memberId, membershipId, role: request.role, projectId, validFrom, taskForceVersion: version };
  }

  /**
   * Dissolves a force under the version the caller saw: the force ends today and every open term ends with it, in the same transaction. A force that is
   * dissolved already is 409 TASK_FORCE_DISSOLVED.
   */
  async dissolve(tx: TenantTx, request: DissolveRequest): Promise<TaskForceChange> {
    const forceId = idOf(request.taskForceId, 'id');
    const force = await this.lock(tx, forceId);
    if (Number(force.version) !== request.expectedVersion) throw versionConflict(Number(force.version));
    if (force.status !== 'ACTIVE') throw new DomainError('TASK_FORCE_DISSOLVED', 409);
    const reason = reasonOf(request.reason);
    const today = request.today;
    const ended = await tx.query<{ id: string }>(
      `update machvon.task_force_member set valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where task_force_id = $1::uuid and valid_until is null returning id`,
      [forceId, today, request.actor],
    );
    const version = Number(force.version) + 1;
    await tx.query(`update machvon.task_force set status = 'DISSOLVED', valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = $4::bigint where id = $1::uuid`, [
      forceId,
      today,
      request.actor,
      version,
    ]);
    return {
      id: forceId,
      code: force.code,
      scopeUnitId: force.scope_unit_id,
      leadMembershipId: force.lead_membership_id,
      status: 'DISSOLVED',
      validFrom: force.valid_from,
      validUntil: today,
      establishmentDocumentId: force.establishment_document_id,
      version,
      openMembers: 0,
      endedMembers: ended.length,
      reason,
    };
  }

  /** The task forces whose scope unit lies in the scope, by code, one page after the anchor, each with its terms (the open ones first). */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { status?: TaskForceStatus | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<TaskForceLine[]> {
    const predicate = scope(5);
    const forces = await tx.query<LineSql>(
      `select ${FORCE_COLUMNS}, lu.display_name as lead_name, u.code as unit_code, u.name as unit_name
         from machvon.task_force f
         join machvon.organization_unit u on u.tenant_id = f.tenant_id and u.id = f.scope_unit_id
         left join machvon.tenant_user_directory lu on lu.tenant_id = f.tenant_id and lu.membership_id = f.lead_membership_id
        where ($1::text is null or f.status = $1::text) and ($2::text is null or (f.code collate "C", f.id) > ($2::text collate "C", $3::uuid)) and ${predicate.sql}
        order by f.code collate "C", f.id limit $4`,
      [filter.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, ...predicate.params],
    );
    if (forces.length === 0) return [];
    const members = await tx.query<MemberSql>(
      `select m.id, m.task_force_id, m.membership_id, d.display_name, m.member_role, m.project_id, p.code as project_code, p.name as project_name,
              m.valid_from::text as valid_from, m.valid_until::text as valid_until
         from machvon.task_force_member m
         left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.membership_id
         left join machvon.project p on p.tenant_id = m.tenant_id and p.id = m.project_id
        where m.task_force_id = any($1::uuid[])
        order by (m.valid_until is not null), m.valid_from, m.created_at, m.id`,
      [forces.map((force) => force.id)],
    );
    return forces.map((force) => ({
      id: force.id,
      code: force.code,
      name: force.name,
      purpose: force.purpose,
      lead: { membershipId: force.lead_membership_id, displayName: force.lead_name },
      scopeUnit: { id: force.scope_unit_id, code: force.unit_code, name: force.unit_name },
      establishmentDocumentId: force.establishment_document_id,
      validFrom: force.valid_from,
      validUntil: force.valid_until,
      status: force.status,
      version: Number(force.version),
      members: members.filter((member) => member.task_force_id === force.id).map(memberLineOf),
      codeKey: force.code,
    }));
  }

  private async lock(tx: TenantTx, forceId: string): Promise<TaskForceSql> {
    const rows = await tx.query<TaskForceSql>(`select ${FORCE_COLUMNS} from machvon.task_force f where f.id = $1::uuid for update`, [forceId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  /** A unit of the tenant; one of another tenant is invisible, so it does not exist. */
  private async unitOf(tx: TenantTx, unitId: string): Promise<{ id: string; path: string }> {
    const rows = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  /** The member exists in the tenant (404) and takes part in the work of the subtree (422 MEMBER_OUT_OF_SCOPE). */
  private async assertReaches(tx: TenantTx, membershipId: string, unitPath: string, now: Date, field: string): Promise<void> {
    const member = await memberStanding(tx, membershipId);
    if (!(await reachesSubtree(tx, member, { path: unitPath }, now))) throw new DomainError('MEMBER_OUT_OF_SCOPE', 422, field);
  }

  /** A project that a force may follow: of the tenant (404), and owned by a unit inside the scope of the force (422 MEMBER_OUT_OF_SCOPE). */
  private async assertFollowable(tx: TenantTx, projectId: string, scopePath: string): Promise<void> {
    const rows = await tx.query<{ path: string }>('select ou.path from machvon.project p join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id where p.id = $1::uuid', [projectId]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!withinSubtree(rows[0].path, scopePath)) throw new DomainError('MEMBER_OUT_OF_SCOPE', 422, 'project_id');
  }

  private async insertMember(tx: TenantTx, term: { forceId: string; membershipId: string; role: TaskForceMemberRole; projectId: string | null; validFrom: string; actor: string }): Promise<string> {
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}_member`);
    try {
      await tx.query(
        `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, project_id, valid_from, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::date, $7::uuid, $7::uuid)`,
        [id, term.forceId, term.membershipId, term.role, term.projectId, term.validFrom, term.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}_member`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== MEMBER_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}_member`);
      throw new DomainError('DUPLICATE_KEY', 409, 'membership_id');
    }
    return id;
  }
}

const memberLineOf = (member: MemberSql): TaskForceMemberLine => ({
  id: member.id,
  membershipId: member.membership_id,
  displayName: member.display_name,
  role: member.member_role,
  project: member.project_id === null || member.project_code === null || member.project_name === null ? null : { id: member.project_id, code: member.project_code, name: member.project_name },
  validFrom: member.valid_from,
  validUntil: member.valid_until,
});

/** The audit row and the event of a force that was founded. */
export function taskForceCreatedRecord(change: TaskForceChange, tenantId: string, actorId: string, occurredAt: Date) {
  return {
    audit: {
      action: 'taskforce.created',
      resourceType: RESOURCE,
      resourceId: change.id,
      diff: {
        code: change.code,
        scope_unit_id: change.scopeUnitId,
        lead_membership_id: change.leadMembershipId,
        valid_from: change.validFrom,
        establishment_document_id: change.establishmentDocumentId,
      },
    },
    event: eventOf(TASK_FORCE_CREATED_EVENT, change, tenantId, actorId, occurredAt, { valid_from: change.validFrom }),
  };
}

/** The audit row and the event of a force that was dissolved. */
export function taskForceDissolvedRecord(change: TaskForceChange, tenantId: string, actorId: string, occurredAt: Date) {
  return {
    audit: {
      action: 'taskforce.dissolved',
      resourceType: RESOURCE,
      resourceId: change.id,
      ...(change.reason === null ? {} : { reason: change.reason }),
      diff: { code: change.code, scope_unit_id: change.scopeUnitId, valid_until: change.validUntil, ended_members: change.endedMembers },
    },
    event: eventOf(TASK_FORCE_DISSOLVED_EVENT, change, tenantId, actorId, occurredAt, { valid_until: change.validUntil, ended_members: change.endedMembers }),
  };
}

/** The audit row of a member that was seated: the change of the force is the audit of the force, with the term in the diff. */
export function memberAddedRecord(added: MemberAdded) {
  return {
    action: 'taskforce.member_added',
    resourceType: RESOURCE,
    resourceId: added.taskForceId,
    diff: { code: added.code, member_id: added.memberId, membership_id: added.membershipId, member_role: added.role, project_id: added.projectId, valid_from: added.validFrom },
  };
}

function eventOf(type: string, change: TaskForceChange, tenantId: string, actorId: string, occurredAt: Date, own: Record<string, unknown>) {
  return {
    aggregateType: RESOURCE,
    aggregateId: change.id,
    aggregateVersion: change.version,
    type,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      task_force_id: change.id,
      version: change.version,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      code: change.code,
      scope_unit_id: change.scopeUnitId,
      lead_membership_id: change.leadMembershipId,
      ...own,
    },
    eventKey: `${RESOURCE}:${change.id}:${change.version}`,
  };
}
