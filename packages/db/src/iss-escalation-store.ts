import { randomUUID } from 'node:crypto';
import { DomainError, effectivePermissions, holdsPermission, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { IssSlaDeadlines } from './iss-sla-deadline.ts';
import type { CalendarCache } from './iss-sla-deadline.ts';
import { IssIssueStore, LOCK_COLUMNS, SCOPE_FROM, issueText, iso, toHeader } from './iss-issue-store.ts';
import type { IssueHeader, IssueScopes, IssueStatus, LockedSql } from './iss-issue-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import { TaskForceDirectory } from './iss-task-force-directory.ts';
import type { TaskForceRef } from './iss-task-force-directory.ts';
import type { TenantTx } from './tenant-database.ts';
import type { SlaSeverity } from './iss-sla-policy-store.ts';

/** The permission of the receiving unit or task force to accept an escalation (ISS 2). */
export const ESCALATION_ACCEPT_PERMISSION = 'issue.escalation.accept';
/**
 * How long the receiver of an escalation has to accept it, in working hours of the calendar of the policy of the issue. A working assumption of the tenant
 * rules (R-ISS-01): the design asks for "a determined deadline" and gives no figure.
 */
export const ESCALATION_ACCEPT_HOURS = 8;
const MINUTES_PER_HOUR = 60;
/** The reasons the job writes: codes, not sentences, so the screens translate them and no personal data can be in them. */
export const AUTO_ESCALATION_REASONS = { 2: 'SLA_L2_THRESHOLD_REACHED', 3: 'SLA_L3_THRESHOLD_REACHED' } as const;
/** The states in which an issue can be escalated by a command (the machine of ISS 4: ASSIGNED or IN_PROGRESS to ESCALATED). */
const ESCALATABLE: ReadonlySet<IssueStatus> = new Set(['ASSIGNED', 'IN_PROGRESS']);

export type EscalationLevel = 1 | 2 | 3;
export type EscalationTrigger = 'SLA_AUTO' | 'MANUAL';
export type EscalationStatus = 'OPEN' | 'ACCEPTED' | 'RESOLVED' | 'CANCELLED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** One escalation of an issue as the workspace and the board show it. */
export interface EscalationRow {
  id: string;
  issueId: string;
  level: EscalationLevel;
  trigger: EscalationTrigger;
  targetUnitId: string | null;
  targetUnitName: string | null;
  taskForceId: string | null;
  taskForceCode: string | null;
  taskForceName: string | null;
  reason: string;
  /** The moment by which the receiver has to accept. */
  dueAt: string;
  status: EscalationStatus;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

/** A line of the board of ISS-10: the escalation with the issue it is about. */
export interface BreachLine extends EscalationRow {
  issueCode: string;
  issueTitle: string;
  issueStatus: IssueStatus;
  severity: SlaSeverity;
  projectCode: string;
  ownerUnitName: string;
  issueDueAt: string;
  overdueSince: string | null;
  calendarCode: string;
  /** The caller may accept it now: it is open and addressed to a task force they belong to or to a unit they answer for. */
  acceptable: boolean;
  createdKey: string;
}

/** What an escalation leaves for the audit row, the event and the notification of the command or the job that raised it: ids, the level, the dates, never the text. */
export interface RaisedEscalation extends IssueHeader {
  escalationId: string;
  level: EscalationLevel;
  trigger: EscalationTrigger;
  targetUnitId: string | null;
  taskForceId: string | null;
  acceptDueAt: string;
  previousStatus: IssueStatus;
  /** The people the receiving side names: the task force, or those who answer for the project. */
  recipients: string[];
  ownerUnitPath: string;
}

export interface AcceptedEscalation extends IssueHeader {
  escalationId: string;
  level: EscalationLevel;
  previousStatus: IssueStatus;
}

export interface EscalationInput {
  level: number;
  targetUnitId?: string | undefined;
  taskForceId?: string | undefined;
  reason: string;
}

/** An issue locked by the job or a command together with what the escalation needs of its policy. */
export interface EscalatableIssue extends LockedSql {
  calendar_code: string;
}

interface EscalationSql {
  id: string;
  issue_id: string;
  level: EscalationLevel;
  trigger: EscalationTrigger;
  target_unit_id: string | null;
  target_unit_name: string | null;
  task_force_id: string | null;
  task_force_code: string | null;
  task_force_name: string | null;
  reason: string;
  due_at: string;
  status: EscalationStatus;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

interface BreachSql extends EscalationSql {
  issue_code: string;
  issue_title: string;
  issue_status: IssueStatus;
  severity: SlaSeverity;
  project_code: string;
  owner_unit_name: string;
  issue_due_at: string;
  overdue_since: string | null;
  calendar_code: string;
  target_unit_path: string | null;
  project_id: string;
  created_key: string;
}

const ESCALATION_COLUMNS = `e.id, e.issue_id, e.level, e."trigger", e.target_unit_id, tu.name as target_unit_name, e.task_force_id, tf.code as task_force_code, tf.name as task_force_name,
  e.reason, ${iso('e.due_at')} as due_at, e.status, e.accepted_by, ${iso('e.accepted_at')} as accepted_at, ${iso('e.created_at')} as created_at`;

const ESCALATION_FROM = `machvon.issue_escalation e
  left join machvon.organization_unit tu on tu.tenant_id = e.tenant_id and tu.id = e.target_unit_id
  left join machvon.task_force tf on tf.tenant_id = e.tenant_id and tf.id = e.task_force_id`;

const toRow = (row: EscalationSql): EscalationRow => ({
  id: row.id,
  issueId: row.issue_id,
  level: row.level,
  trigger: row.trigger,
  targetUnitId: row.target_unit_id,
  targetUnitName: row.target_unit_name,
  taskForceId: row.task_force_id,
  taskForceCode: row.task_force_code,
  taskForceName: row.task_force_name,
  reason: row.reason,
  dueAt: row.due_at,
  status: row.status,
  acceptedBy: row.accepted_by,
  acceptedAt: row.accepted_at,
  createdAt: row.created_at,
});

/**
 * The escalation of an issue (ST-ISS-004, ISS 3.2): the job and the command `escalateIssue` raise it to the unit or the task force, the receiver accepts it,
 * and the board of ISS-10 lists it. An escalation never closes the issue: it moves an assigned or working issue to ESCALATED, and the receiver's acceptance
 * puts it back to IN_PROGRESS. At most one escalation per level is open or accepted for an issue (issue_escalation_open_uq).
 */
export class IssEscalationStore {
  private readonly issues: IssIssueStore;
  private readonly deadlines: IssSlaDeadlines;
  private readonly forces: TaskForceDirectory;

  constructor(issues: IssIssueStore = new IssIssueStore(), deadlines: IssSlaDeadlines = new IssSlaDeadlines(), forces: TaskForceDirectory = new TaskForceDirectory()) {
    this.issues = issues;
    this.deadlines = deadlines;
    this.forces = forces;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  /** The escalations of an issue the caller has already been shown, newest first (the higher level first when one pass raised two). */
  async forIssue(tx: TenantTx, issueId: string): Promise<EscalationRow[]> {
    const rows = await tx.query<EscalationSql>(`select ${ESCALATION_COLUMNS} from ${ESCALATION_FROM} where e.issue_id = $1::uuid order by e.created_at desc, e.level desc, e.id desc`, [issueId]);
    return rows.map(toRow);
  }

  /**
   * The open and accepted escalations of the issues that are not closed, newest first (ISS-10, `listIssueSlaBreaches`). The caller sees the escalations of the
   * issues in their read scope, and the ones addressed to a unit they answer for (`issue.escalation.accept` over it) or to a task force they belong to, whether
   * or not their grants reach the issue: the receiver of an escalation must see it.
   */
  async breaches(
    tx: TenantTx,
    request: { level?: number | undefined; limit: number; after: { code: string; id: string } | undefined },
    reads: ScopeBuilder,
    access: EffectiveAccess,
    now: Date,
  ): Promise<BreachLine[]> {
    assertTimestampCursor(request.after?.code);
    const today = vietnamDateOf(now);
    const forces = [...(await this.forces.membershipsOf(tx, access.membershipId, today))].sort();
    const read = reads(5);
    const params: unknown[] = [request.level ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit, ...read.params];
    const alternatives = [read.sql];
    const accept = scopePredicate(access, ESCALATION_ACCEPT_PERMISSION, now, { unitPath: 'tu.path', unitId: 'tu.id' }, params.length + 1);
    if (accept.sql !== 'false') {
      alternatives.push(`(e.task_force_id is null and ${accept.sql})`);
      params.push(...accept.params);
    }
    if (forces.length > 0) {
      params.push(forces);
      alternatives.push(`e.task_force_id = any($${params.length}::uuid[])`);
    }
    const rows = await tx.query<BreachSql>(
      `select ${ESCALATION_COLUMNS}, ${timestampKey('e.created_at')} as created_key, tu.path as target_unit_path, i.code as issue_code, i.title as issue_title, i.status as issue_status, i.severity,
              i.project_id, p.code as project_code, ou.name as owner_unit_name, ${iso('i.due_at')} as issue_due_at, ${iso('i.overdue_since')} as overdue_since, pol.calendar_code
         from ${ESCALATION_FROM}
         join machvon.issue i on i.tenant_id = e.tenant_id and i.id = e.issue_id
         join machvon.organization_unit ou on ou.tenant_id = i.tenant_id and ou.id = i.owner_unit_id
         join machvon.project p on p.tenant_id = i.tenant_id and p.id = i.project_id
         join machvon.issue_sla_policy pol on pol.tenant_id = i.tenant_id and pol.id = i.sla_policy_id
        where e.status in ('OPEN', 'ACCEPTED') and i.status <> 'CLOSED' and ($1::smallint is null or e.level = $1::smallint)
          and ($2::text is null or (${timestampKey('e.created_at')}, e.id) < ($2::text, $3::uuid)) and (${alternatives.join(' or ')})
        order by e.created_at desc, e.id desc limit $4`,
      params,
    );
    return rows.map((row) => ({
      ...toRow(row),
      issueCode: row.issue_code,
      issueTitle: row.issue_title,
      issueStatus: row.issue_status,
      severity: row.severity,
      projectCode: row.project_code,
      ownerUnitName: row.owner_unit_name,
      issueDueAt: row.issue_due_at,
      overdueSince: row.overdue_since,
      calendarCode: row.calendar_code,
      createdKey: row.created_key,
      acceptable:
        row.status === 'OPEN' &&
        (row.task_force_id === null
          ? row.target_unit_id !== null &&
            row.target_unit_path !== null &&
            holdsPermission(effectivePermissions(access, now, { ownerUnitId: row.target_unit_id, ownerUnitPath: row.target_unit_path, projectId: row.project_id }), ESCALATION_ACCEPT_PERMISSION)
          : forces.includes(row.task_force_id)),
    }));
  }

  /** The task force that answers for the issue today, for the screen that offers the escalation to level 3; undefined when there is none. */
  async activeTaskForceOf(tx: TenantTx, issue: { projectId: string; ownerUnitPath: string }, now: Date): Promise<TaskForceRef | undefined> {
    return this.forces.activeFor(tx, { projectId: issue.projectId, ownerUnitPath: issue.ownerUnitPath, on: vietnamDateOf(now) });
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /**
   * Raises an issue to a unit or to the task force by hand (ISS 3.2, `escalateIssue`), under the rules of the job: the level must be above the one the issue
   * has reached, levels 1 and 2 name a unit (the owner unit when none is given) and level 3 names an active task force that answers for the issue.
   * The original issue stays open and keeps its deadline; ASSIGNED or IN_PROGRESS become ESCALATED.
   */
  async escalate(tx: TenantTx, id: string, expectedVersion: number, input: EscalationInput, actor: string, scopes: IssueScopes, now: Date): Promise<RaisedEscalation> {
    const lockedRow = await this.issues.lock(tx, id, scopes);
    if (!ESCALATABLE.has(lockedRow.status)) throw new DomainError('ISSUE_STATE_INVALID', 409);
    if (Number(lockedRow.version) !== expectedVersion) throw versionConflict(Number(lockedRow.version));
    const reason = issueText(input.reason, 'reason');
    if (input.level !== 1 && input.level !== 2 && input.level !== 3) throw new DomainError('ESCALATION_LEVEL_INVALID', 422);
    const level: EscalationLevel = input.level;
    if (level <= lockedRow.escalation_level) throw new DomainError('ESCALATION_LEVEL_INVALID', 422);
    if (level < 3 && input.taskForceId !== undefined) throw new DomainError('ESCALATION_LEVEL_INVALID', 422);
    const targetUnitId = input.targetUnitId === undefined ? undefined : this.uuidOf(input.targetUnitId, 'target_unit_id');
    const placeRows = await tx.query<{ path: string; calendar_code: string }>(
      `select ou.path, pol.calendar_code from machvon.organization_unit ou, machvon.issue_sla_policy pol
        where ou.id = $1::uuid and pol.id = (select sla_policy_id from machvon.issue where id = $2::uuid)`,
      [lockedRow.owner_unit_id, id],
    );
    const place = placeRows[0] as { path: string; calendar_code: string };
    let force: TaskForceRef | null = null;
    if (level === 3) {
      if (input.taskForceId === undefined) throw invalid('task_force_id');
      const judged = await this.forces.judge(tx, this.uuidOf(input.taskForceId, 'task_force_id'), { projectId: lockedRow.project_id, ownerUnitPath: place.path, on: vietnamDateOf(now) });
      if (judged.verdict === 'NOT_ACTIVE') throw new DomainError('TASK_FORCE_NOT_ACTIVE', 422);
      if (judged.force === undefined) throw invalid('task_force_id');
      force = judged.force;
    }
    const target = level === 3 ? (targetUnitId ?? null) : (targetUnitId ?? lockedRow.owner_unit_id);
    if (target !== null && target !== lockedRow.owner_unit_id) {
      const units = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [target]);
      // A unit of another tenant is indistinguishable from one that does not exist.
      if (units[0] === undefined) throw invalid('target_unit_id');
    }
    await tx.query('savepoint issue_escalate');
    try {
      const raised = await this.raise(tx, { ...lockedRow, calendar_code: place.calendar_code }, { level, trigger: 'MANUAL', targetUnitId: target, force, reason, note: reason }, actor, now, place.path);
      await tx.query('release savepoint issue_escalate');
      return raised;
    } catch (error) {
      const { code: sqlState, constraint } = error as { code?: string; constraint?: string };
      if (sqlState !== '23505' || constraint !== 'issue_escalation_open_uq') throw error;
      await tx.query('rollback to savepoint issue_escalate');
      throw new DomainError('ESCALATION_LEVEL_INVALID', 422);
    }
  }

  /**
   * Raises an issue the way the job does and the command does: one escalation row, the issue to ESCALATED when its state allows (the escalation of an OPEN or
   * REOPENED issue is recorded and the issue stays as it is: the machine has no edge for it), the level and the time on the issue, and the event of the
   * timeline. The caller has the issue locked, writes the audit row and the outbox event from the answer, and says how many people the receiver has.
   */
  async raise(
    tx: TenantTx,
    issue: EscalatableIssue,
    spec: { level: EscalationLevel; trigger: EscalationTrigger; targetUnitId: string | null; force: TaskForceRef | null; reason: string; note: string | null },
    actor: string,
    now: Date,
    ownerUnitPath: string,
    cache?: CalendarCache,
  ): Promise<RaisedEscalation> {
    const acceptDueAt = await this.deadlines.addMinutes(tx, issue.calendar_code, now, ESCALATION_ACCEPT_HOURS * MINUTES_PER_HOUR, cache);
    const escalationId = randomUUID();
    const nowText = now.toISOString();
    await tx.query(
      `insert into machvon.issue_escalation
         (tenant_id, id, issue_id, level, "trigger", target_unit_id, task_force_id, reason, due_at, status, created_at, created_by, updated_at, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::smallint, $4, $5::uuid, $6::uuid, $7, $8::timestamptz, 'OPEN', $9::timestamptz, $10::uuid, $9::timestamptz, $10::uuid, 1)`,
      [escalationId, issue.id, spec.level, spec.trigger, spec.targetUnitId, spec.force?.id ?? null, spec.reason, acceptDueAt.toISOString(), nowText, actor],
    );
    const status: IssueStatus = ESCALATABLE.has(issue.status) ? 'ESCALATED' : issue.status;
    const level = Math.max(issue.escalation_level, spec.level);
    await tx.query(
      `update machvon.issue set escalation_level = $2::smallint, escalated_at = $3::timestamptz, escalated_task_force_id = coalesce($4::uuid, escalated_task_force_id), status = $5,
              updated_at = $3::timestamptz, updated_by = $6::uuid, version = version + 1 where id = $1::uuid`,
      [issue.id, level, nowText, spec.force?.id ?? null, status, actor],
    );
    await this.issues.record(tx, issue.id, actor, {
      kind: 'ESCALATED',
      fromStatus: issue.status,
      toStatus: status,
      note: spec.note,
      payload: { escalation_id: escalationId, level: spec.level, trigger: spec.trigger, target_unit_id: spec.targetUnitId, task_force_id: spec.force?.id ?? null },
    });
    const recipients = spec.force === null ? await this.forces.leadersOf(tx, issue.project_id, vietnamDateOf(now)) : spec.force.memberIds;
    return {
      ...toHeader(issue, { status, escalationLevel: level, version: Number(issue.version) + 1 }),
      escalationId,
      level: spec.level,
      trigger: spec.trigger,
      targetUnitId: spec.targetUnitId,
      taskForceId: spec.force?.id ?? null,
      acceptDueAt: acceptDueAt.toISOString(),
      previousStatus: issue.status,
      recipients,
      ownerUnitPath,
    };
  }

  /**
   * The receiver accepts an escalation (ISS 3.2, `acceptIssueEscalation`): a member of the task force it names, or a person who answers for the unit it names
   * (`issue.escalation.accept` over that unit). The escalation becomes ACCEPTED and an issue that was ESCALATED goes back to IN_PROGRESS; the issue is never
   * closed by it. An escalation that is not open is 409 ESCALATION_STATE_INVALID; one the caller may not accept is 403 SCOPE_DENIED, or 404 when they cannot
   * read its issue either.
   */
  async accept(tx: TenantTx, escalationId: string, input: { note?: string | undefined }, actor: string, access: EffectiveAccess, reads: ScopeBuilder, now: Date): Promise<AcceptedEscalation> {
    const found = await tx.query<{ issue_id: string }>('select issue_id from machvon.issue_escalation where id = $1::uuid', [escalationId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The issue is locked first, like every command that touches both, so that closing and accepting cannot wait for each other.
    const issueRows = await tx.query<EscalatableIssue>(
      `select ${LOCK_COLUMNS}, '' as calendar_code from ${SCOPE_FROM} where i.id = $1::uuid for update of i`,
      [found[0].issue_id],
    );
    const issue = issueRows[0] as EscalatableIssue;
    const rows = await tx.query<EscalationSql & { target_unit_path: string | null }>(
      `select ${ESCALATION_COLUMNS}, tu.path as target_unit_path from ${ESCALATION_FROM} where e.id = $1::uuid for update of e`,
      [escalationId],
    );
    const escalation = rows[0] as EscalationSql & { target_unit_path: string | null };
    const note = input.note === undefined ? null : issueText(input.note, 'note');
    if (!(await this.mayAccept(tx, escalation, issue, access, now))) {
      const readable = reads(2);
      const seen = await tx.query<{ id: string }>(`select i.id from ${SCOPE_FROM} where i.id = $1::uuid and ${readable.sql}`, [issue.id, ...readable.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    if (escalation.status !== 'OPEN') throw new DomainError('ESCALATION_STATE_INVALID', 409);
    const nowText = now.toISOString();
    await tx.query(
      `update machvon.issue_escalation set status = 'ACCEPTED', accepted_by = $2::uuid, accepted_at = $3::timestamptz, updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [escalationId, actor, nowText],
    );
    const status: IssueStatus = issue.status === 'ESCALATED' ? 'IN_PROGRESS' : issue.status;
    const version = status === issue.status ? Number(issue.version) : Number(issue.version) + 1;
    if (status !== issue.status) {
      await tx.query(`update machvon.issue set status = $2, updated_at = $3::timestamptz, updated_by = $4::uuid, version = version + 1 where id = $1::uuid`, [issue.id, status, nowText, actor]);
    }
    await this.issues.record(tx, issue.id, actor, {
      kind: 'ESCALATION_ACCEPTED',
      fromStatus: issue.status,
      toStatus: status,
      note,
      payload: { escalation_id: escalationId, level: escalation.level },
    });
    return { ...toHeader(issue, { status, version }), escalationId, level: escalation.level, previousStatus: issue.status };
  }

  /** Whether the caller is the receiver of the escalation: a member of its task force, or the person who answers for its unit. */
  private async mayAccept(tx: TenantTx, escalation: EscalationSql & { target_unit_path: string | null }, issue: { project_id: string }, access: EffectiveAccess, now: Date): Promise<boolean> {
    if (escalation.task_force_id !== null) return (await this.forces.membershipsOf(tx, access.membershipId, vietnamDateOf(now))).has(escalation.task_force_id);
    if (escalation.target_unit_id === null || escalation.target_unit_path === null) return false;
    return holdsPermission(
      effectivePermissions(access, now, { ownerUnitId: escalation.target_unit_id, ownerUnitPath: escalation.target_unit_path, projectId: issue.project_id }),
      ESCALATION_ACCEPT_PERMISSION,
    );
  }

  private uuidOf(value: string, field: string): string {
    if (!UUID.test(value)) throw invalid(field);
    return value.toLowerCase();
  }
}
