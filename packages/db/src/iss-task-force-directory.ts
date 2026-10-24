import type { TenantTx } from './tenant-database.ts';

/** A task force as the escalation of an issue needs it: who it is and who answers for it. */
export interface TaskForceRef {
  id: string;
  code: string;
  name: string;
  leadMembershipId: string;
  /** The lead and the members in force on the day, each once. */
  memberIds: string[];
}

/** Where an issue lies for the choice of its task force: the project and the path of the unit that owns it, on a Vietnam date (`YYYY-MM-DD`). */
export interface TaskForcePlace {
  projectId: string;
  ownerUnitPath: string;
  on: string;
}

/**
 * What the escalation finds when it asks whether a task force may answer for an issue: it is not known to the tenant, it is no longer (or not yet) active,
 * it has nothing to do with the issue, or it may.
 */
export type TaskForceVerdict = 'UNKNOWN' | 'NOT_ACTIVE' | 'UNRELATED' | 'RELEVANT';

interface ForceSql {
  id: string;
  code: string;
  name: string;
  lead_membership_id: string;
  status: string;
  active: boolean;
  relevant: boolean;
}

interface ForceDepthSql extends ForceSql {
  depth: number;
}

const COLUMNS = `tf.id, tf.code, tf.name, tf.lead_membership_id, tf.status,
  (tf.status = 'ACTIVE' and tf.valid_from <= $3::date and (tf.valid_until is null or tf.valid_until >= $3::date)) as active,
  (exists (select 1 from machvon.task_force_member m
            where m.tenant_id = tf.tenant_id and m.task_force_id = tf.id and m.project_id = $1::uuid
              and m.valid_from <= $3::date and (m.valid_until is null or m.valid_until >= $3::date))
   or exists (select 1 from machvon.organization_unit su where su.tenant_id = tf.tenant_id and su.id = tf.scope_unit_id and $2::text like su.path || '%')) as relevant`;

/**
 * The task forces that answer for an issue (ISS 3.2, R-ISS-03). PRJ owns `task_force`, `task_force_member` and `project_accountability`; until PRJ publishes the
 * interface `activeTaskForce(project, unit, at)` this port reads them, read-only, and nothing else of PRJ. A task force answers for an issue when it is ACTIVE
 * on the day, and either one of its members is assigned to the project of the issue or its scope unit is the unit that owns the issue or one above it.
 * The last day of a task force, of a member and of an accountability is a day they are still in force (inclusive, like the other dates of PRJ).
 */
export class TaskForceDirectory {
  /** The task force that answers for the place: one with a member on the project first, then the one with the deepest scope unit, then by code. */
  async activeFor(tx: TenantTx, place: TaskForcePlace): Promise<TaskForceRef | undefined> {
    const rows = await tx.query<ForceDepthSql>(
      `select ${COLUMNS}, coalesce((select su.depth from machvon.organization_unit su where su.tenant_id = tf.tenant_id and su.id = tf.scope_unit_id), 0) as depth
         from machvon.task_force tf order by tf.code`,
      [place.projectId, place.ownerUnitPath, place.on],
    );
    const found = rows.filter((row) => row.active && row.relevant);
    if (found.length === 0) return undefined;
    const direct = await this.projectMemberForces(tx, place);
    const chosen =
      found.find((row) => direct.has(row.id)) ??
      [...found].sort((left, right) => (right.depth - left.depth) || left.code.localeCompare(right.code))[0];
    return chosen === undefined ? undefined : this.refOf(tx, chosen, place.on);
  }

  /** Whether the task force may answer for the place, and if so who it is. */
  async judge(tx: TenantTx, taskForceId: string, place: TaskForcePlace): Promise<{ verdict: TaskForceVerdict; force?: TaskForceRef }> {
    const rows = await tx.query<ForceSql>(`select ${COLUMNS} from machvon.task_force tf where tf.id = $4::uuid`, [place.projectId, place.ownerUnitPath, place.on, taskForceId]);
    const row = rows[0];
    if (row === undefined) return { verdict: 'UNKNOWN' };
    if (!row.active) return { verdict: 'NOT_ACTIVE' };
    if (!row.relevant) return { verdict: 'UNRELATED' };
    return { verdict: 'RELEVANT', force: await this.refOf(tx, row, place.on) };
  }

  /** The task forces of which the person is the lead or a member in force on the day. */
  async membershipsOf(tx: TenantTx, membershipId: string, on: string): Promise<Set<string>> {
    const rows = await tx.query<{ id: string }>(
      `select tf.id from machvon.task_force tf
        where tf.status = 'ACTIVE' and tf.valid_from <= $2::date and (tf.valid_until is null or tf.valid_until >= $2::date)
          and (tf.lead_membership_id = $1::uuid
               or exists (select 1 from machvon.task_force_member m
                           where m.tenant_id = tf.tenant_id and m.task_force_id = tf.id and m.membership_id = $1::uuid
                             and m.valid_from <= $2::date and (m.valid_until is null or m.valid_until >= $2::date)))`,
      [membershipId, on],
    );
    return new Set(rows.map((row) => row.id));
  }

  /** The people who answer for a project on the day: its leader in charge and the deputy (PRJ accountability), sorted. */
  async leadersOf(tx: TenantTx, projectId: string, on: string): Promise<string[]> {
    const rows = await tx.query<{ leader_membership_id: string }>(
      `select distinct leader_membership_id from machvon.project_accountability
        where project_id = $1::uuid and status = 'ACTIVE' and accountability_role in ('LEADER_IN_CHARGE', 'DEPUTY_LEADER')
          and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)
        order by leader_membership_id`,
      [projectId, on],
    );
    return rows.map((row) => row.leader_membership_id);
  }

  private async projectMemberForces(tx: TenantTx, place: TaskForcePlace): Promise<Set<string>> {
    const rows = await tx.query<{ task_force_id: string }>(
      `select distinct task_force_id from machvon.task_force_member
        where project_id = $1::uuid and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)`,
      [place.projectId, place.on],
    );
    return new Set(rows.map((row) => row.task_force_id));
  }

  private async refOf(tx: TenantTx, row: ForceSql, on: string): Promise<TaskForceRef> {
    const members = await tx.query<{ membership_id: string }>(
      `select distinct membership_id from machvon.task_force_member
        where task_force_id = $1::uuid and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)`,
      [row.id, on],
    );
    const memberIds = [...new Set([row.lead_membership_id, ...members.map((member) => member.membership_id)])].sort();
    return { id: row.id, code: row.code, name: row.name, leadMembershipId: row.lead_membership_id, memberIds };
  }
}
