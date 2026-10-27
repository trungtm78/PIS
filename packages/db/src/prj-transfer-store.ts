import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, TRANSFER_DECISIONS, TRANSFER_SCOPES, UNTRANSFERABLE_PROJECT_STATUSES, decidedStatus, isDueToday, stillFromUnit, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TransferDecision, TransferScope, TransferStatus } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { grantViewOf } from './effective-access-store.ts';
import type { GrantRow } from './effective-access-store.ts';
import { holdsOver, idOf, textOf } from './prj-accountability-support.ts';
import { dateOf, invalid, lockProject, projectInScope, usableDocumentId } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import { enqueueOutbox } from './outbox.ts';
import { bumpScopeVersion, membershipsAffectedByUnits } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const TRANSFER_RESOURCE = 'project_transfer';
export const PROJECT_TRANSFERRED_EVENT = 'project.transferred.v1';
export const TRANSFER_DUE_METRIC = 'prj_transfer_applied_total';

const UNIQUE_VIOLATION = '23505';
const OPEN_INDEX = 'project_transfer_open_uq';
const SAVEPOINT = 'transfer_write';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const READ_PERMISSION = 'project.read';
/** How many members the preview looks at: a tenant with more is told the preview is partial rather than made to wait. */
const PREVIEW_MEMBER_CAP = 2000;

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const FROM = `machvon.project_transfer t
  join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  join machvon.organization_unit fu on fu.tenant_id = t.tenant_id and fu.id = t.from_unit_id
  join machvon.organization_unit tu on tu.tenant_id = t.tenant_id and tu.id = t.to_unit_id`;

const COLUMNS = `t.id, t.project_id, p.code as project_code, p.name as project_name, t.from_unit_id, fu.name as from_unit_name, t.to_unit_id, tu.name as to_unit_name, t.transfer_scope, t.effective_date::text as effective_date,
  t.decision_document_id, t.reason, t.status, t.approved_by, t.decision_reason, ${ISO('t.decided_at')} as decided_at, ${ISO('t.applied_at')} as applied_at, ${ISO('t.created_at')} as created_at, t.created_by, t.version::text as version`;

export interface TransferRow {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  fromUnitId: string;
  fromUnitName: string;
  toUnitId: string;
  toUnitName: string;
  scope: TransferScope;
  effectiveDate: string;
  decisionDocumentId: string | null;
  reason: string;
  status: TransferStatus;
  approvedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface TransferSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  from_unit_id: string;
  from_unit_name: string;
  to_unit_id: string;
  to_unit_name: string;
  transfer_scope: TransferScope;
  effective_date: string;
  decision_document_id: string | null;
  reason: string;
  status: TransferStatus;
  approved_by: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const rowOf = (row: TransferSql): TransferRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  fromUnitId: row.from_unit_id,
  fromUnitName: row.from_unit_name,
  toUnitId: row.to_unit_id,
  toUnitName: row.to_unit_name,
  scope: row.transfer_scope,
  effectiveDate: row.effective_date,
  decisionDocumentId: row.decision_document_id,
  reason: row.reason,
  status: row.status,
  approvedBy: row.approved_by,
  decisionReason: row.decision_reason,
  decidedAt: row.decided_at,
  appliedAt: row.applied_at,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

export interface RequestInput {
  projectId: string;
  /** The version of the project the asker saw: a project that moved since (a profile, a stage, another transfer) is 409 VERSION_CONFLICT. */
  expectedVersion: number;
  toUnitId: string;
  scope: string;
  effectiveDate: string;
  reason: string;
  decisionDocumentId?: string | undefined;
  actor: string;
  today: string;
  scopes: StageScopes;
}

export interface DecideInput {
  id: string;
  expectedVersion: number;
  decision: string;
  reason: string;
  actor: string;
  now: Date;
  /** The scopes of `project.transfer.approve` (act) and `project.read` (read). */
  scopes: StageScopes;
}

export interface TransferChange {
  row: TransferRow;
  previousStatus: TransferStatus | null;
  /** The transfer was made (the project has its new unit). */
  applied: boolean;
  /** The version the project reached when it was made; null when it was not. */
  projectVersion: number | null;
  /** The project stood on another unit than the transfer started from, so it was closed and nothing was changed. */
  stale: boolean;
}

export interface ImpactInput {
  projectId: string;
  toUnitId: string;
  scope: string;
  scopes: StageScopes;
  now: Date;
}

export interface TransferImpact {
  projectId: string;
  scope: TransferScope;
  fromUnit: { id: string; name: string };
  toUnit: { id: string; name: string };
  /** The reports and the snapshot lines of the project stay with the unit that held it on their day; plan lines follow the project. */
  reports: number;
  snapshotLines: number;
  planLines: number;
  usersGaining: number;
  usersLosing: number;
  /** The members looked at, and whether the tenant has more than the preview reads. */
  membersChecked: number;
  partial: boolean;
}

interface ProjectUnits {
  owner_unit_id: string;
  investor_unit_id: string | null;
  status: string;
}

/**
 * The transfer of a project between units (ST-PRJ-007, PRJ 3.1 F10): a request (to a unit of the same tenant: one of another tenant does not exist, 404) with the day it takes effect; a decision by someone who did
 * not ask (403 SELF_APPROVAL_DENIED); the change itself on that day, or at once when the day has come, which sets `owner_unit_id` or `investor_unit_id`, raises the version and the scope version of whoever
 * gains or loses sight of the project. A report or a snapshot before the day keeps the unit it was made under (the lines of a snapshot store their unit when they are built). One request is open at a time for a
 * project and a scope (409 TRANSFER_PENDING_EXISTS).
 */
export class PrjTransferStore {
  /** A request for a project the caller may transfer, to a unit that exists, is in force and is not the unit the project has. */
  async request(tx: TenantTx, input: RequestInput): Promise<TransferChange> {
    const projectId = idOf(input.projectId, 'id');
    const toUnitId = idOf(input.toUnitId, 'to_unit_id');
    if (!(TRANSFER_SCOPES as readonly string[]).includes(input.scope)) throw invalid('transfer_scope');
    const scope = input.scope as TransferScope;
    const effectiveDate = dateOf(input.effectiveDate, 'effective_date');
    if (effectiveDate < input.today) throw invalid('effective_date');
    const reason = textOf(input.reason, 'reason', { min: 10, max: 2000, multiline: true });
    const locked = await lockProject(tx, projectId, input.scopes);
    if (locked.version !== input.expectedVersion) throw versionConflict(locked.version);
    if (UNTRANSFERABLE_PROJECT_STATUSES.includes(locked.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'id', { extensions: { project_status: locked.status } });
    const units = await this.unitsOf(tx, projectId);
    const fromUnitId = scope === 'OWNER_UNIT' ? units.owner_unit_id : units.investor_unit_id;
    if (fromUnitId === null) throw invalid('transfer_scope');
    const [exists] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [toUnitId]);
    if (exists === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'to_unit_id');
    if (!(await this.receivingUnitUsable(tx, toUnitId, effectiveDate))) throw invalid('to_unit_id');
    if (toUnitId === fromUnitId) throw invalid('to_unit_id');
    const document = input.decisionDocumentId === undefined ? null : await usableDocumentId(tx, input.decisionDocumentId, 'decision_document_id');
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.project_transfer (tenant_id, id, project_id, from_unit_id, to_unit_id, transfer_scope, effective_date, decision_document_id, reason, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7::uuid, $8, 'REQUESTED', $9::uuid, $9::uuid)`,
        [id, projectId, fromUnitId, toUnitId, scope, effectiveDate, document, reason, input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== OPEN_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('TRANSFER_PENDING_EXISTS', 409, 'transfer_scope');
    }
    return { row: await this.read(tx, id), previousStatus: null, applied: false, projectVersion: null, stale: false };
  }

  /**
   * The decision on a request that waits: approve, reject or return, with the reason. The one who asked cannot decide (403 SELF_APPROVAL_DENIED, before the version is looked at); the project must be in the
   * scope of the caller. An approval whose day has come is applied in the same transaction.
   */
  async decide(tx: TenantTx, input: DecideInput): Promise<TransferChange> {
    const id = idOf(input.id, 'id');
    const [owner] = await tx.query<{ project_id: string }>('select project_id from machvon.project_transfer where id = $1::uuid', [id]);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await lockProject(tx, owner.project_id, input.scopes);
    await tx.query('select id from machvon.project_transfer where id = $1::uuid for update', [id]);
    const current = await this.read(tx, id);
    if (current.createdBy === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (!(TRANSFER_DECISIONS as readonly string[]).includes(input.decision)) throw invalid('decision');
    const decision = input.decision as TransferDecision;
    const status = decidedStatus(current.status, decision);
    const reason = textOf(input.reason, 'reason', { min: 5, max: 2000, multiline: true });
    await tx.query(
      `update machvon.project_transfer set status = $2, approved_by = $3::uuid, decision_reason = $4, decided_at = $5::timestamptz, updated_at = now(), updated_by = $6::uuid, version = version + 1 where id = $1::uuid`,
      [id, status, decision === 'approve' ? input.actor : null, reason, input.now.toISOString(), input.actor],
    );
    const decided = await this.read(tx, id);
    if (status === 'APPROVED' && isDueToday(decided.effectiveDate, vietnamDateOf(input.now))) {
      return this.apply(tx, decided, input.actor, input.now, current.status);
    }
    return { row: decided, previousStatus: current.status, applied: false, projectVersion: null, stale: false };
  }

  /** The approved transfers whose day has come, each applied; the ones whose project changed unit meanwhile are closed. */
  async applyDue(tx: TenantTx, actor: string, now: Date): Promise<TransferChange[]> {
    const today = vietnamDateOf(now);
    const due = await tx.query<{ id: string; project_id: string }>(
      `select id, project_id from machvon.project_transfer where status = 'APPROVED' and effective_date <= $1::date order by effective_date, created_at, id`,
      [today],
    );
    const done: TransferChange[] = [];
    for (const item of due) {
      // The project first and the transfer after it, as a decision does, so the two never wait for each other; what another transaction holds is left for the next pass.
      const [project] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid for update skip locked', [item.project_id]);
      if (project === undefined) continue;
      const [held] = await tx.query<{ id: string }>(`select id from machvon.project_transfer where id = $1::uuid and status = 'APPROVED' for update skip locked`, [item.id]);
      if (held === undefined) continue;
      done.push(await this.apply(tx, await this.read(tx, item.id), actor, now, 'APPROVED'));
    }
    return done;
  }

  private async apply(tx: TenantTx, transfer: TransferRow, actor: string, now: Date, previous: TransferStatus): Promise<TransferChange> {
    const units = await this.unitsOf(tx, transfer.projectId);
    const current = transfer.scope === 'OWNER_UNIT' ? units.owner_unit_id : units.investor_unit_id;
    // What was true when the request was made is judged again on the day: the project must still be one that can be transferred and still have the unit the transfer starts from.
    const closed = UNTRANSFERABLE_PROJECT_STATUSES.includes(units.status);
    const changedUnit = !stillFromUnit(current, transfer.fromUnitId);
    const receiving = closed || changedUnit ? true : await this.receivingUnitUsable(tx, transfer.toUnitId, transfer.effectiveDate);
    if (closed || changedUnit || !receiving) {
      const why = closed ? ' (the project was closed before the day)' : changedUnit ? ' (the unit of the project changed before the day)' : ' (the receiving unit was no longer in force on the day)';
      await tx.query(`update machvon.project_transfer set status = 'CANCELLED', decision_reason = left(decision_reason, 1940) || $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [transfer.id, actor, why]);
      return { row: await this.read(tx, transfer.id), previousStatus: previous, applied: false, projectVersion: null, stale: true };
    }
    const column = transfer.scope === 'OWNER_UNIT' ? 'owner_unit_id' : 'investor_unit_id';
    await tx.query(`update machvon.project set ${column} = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [transfer.projectId, transfer.toUnitId, actor]);
    await tx.query(`update machvon.project_transfer set status = 'APPLIED', applied_at = $2::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [transfer.id, now.toISOString(), actor]);
    // Whoever gains or loses sight of the project through its units has a new scope version, so the next decision on their access is made on the new tree.
    await bumpScopeVersion(tx, await membershipsAffectedByUnits(tx, [transfer.fromUnitId, transfer.toUnitId]));
    const [moved] = await tx.query<{ version: string }>('select version::text as version from machvon.project where id = $1::uuid', [transfer.projectId]);
    return { row: await this.read(tx, transfer.id), previousStatus: previous, applied: true, projectVersion: Number(moved?.version ?? 0), stale: false };
  }

  async find(tx: TenantTx, id: string): Promise<TransferRow | undefined> {
    const rows = await tx.query<TransferSql>(`select ${COLUMNS} from ${FROM} where t.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  /** The requests for the projects in the scope of the caller, the newest first, one page after the anchor (`createdAt|id`). */
  async list(tx: TenantTx, filter: { projectId?: string | undefined; status?: string | undefined }, scope: ScopeBuilder, page: { limit: number; after?: { createdAt: string; id: string } | undefined }): Promise<TransferRow[]> {
    const predicate = scope(5);
    const rows = await tx.query<TransferSql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::uuid is null or t.project_id = $1::uuid) and ($2::text is null or t.status = $2)
          and ($3::timestamptz is null or (t.created_at, t.id) < ($3::timestamptz, $4::uuid)) and (${predicate.sql})
        order by t.created_at desc, t.id desc limit ${Math.trunc(page.limit) + 1}`,
      [filter.projectId ?? null, filter.status ?? null, page.after?.createdAt ?? null, page.after?.id ?? NIL_UUID, ...predicate.params],
    );
    return rows.map(rowOf);
  }

  /**
   * What a transfer would change, counted before it is asked for: the reports, the lines of snapshots and the plan lines of the project, and the members who would gain or lose the sight of the project through the
   * unit (a member is judged by the grants in force and by the permission `project.read` over the project with its units before and after).
   */
  async impact(tx: TenantTx, input: ImpactInput): Promise<TransferImpact> {
    const projectId = idOf(input.projectId, 'id');
    const toUnitId = idOf(input.toUnitId, 'to_unit_id');
    if (!(TRANSFER_SCOPES as readonly string[]).includes(input.scope)) throw invalid('transfer_scope');
    const scope = input.scope as TransferScope;
    if (!(await projectInScope(tx, projectId, input.scopes.read))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!(await projectInScope(tx, projectId, input.scopes.act))) throw new DomainError('SCOPE_DENIED', 403);
    const units = await this.unitsOf(tx, projectId);
    const fromUnitId = scope === 'OWNER_UNIT' ? units.owner_unit_id : units.investor_unit_id;
    if (fromUnitId === null) throw invalid('transfer_scope');
    const places = await tx.query<{ id: string; name: string; path: string }>('select id, name, path from machvon.organization_unit where id = any($1::uuid[])', [[fromUnitId, toUnitId, units.owner_unit_id, ...(units.investor_unit_id === null ? [] : [units.investor_unit_id])]]);
    const byId = new Map(places.map((place) => [place.id, place]));
    const from = byId.get(fromUnitId);
    const to = byId.get(toUnitId);
    if (to === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'to_unit_id');
    if (from === undefined || toUnitId === fromUnitId) throw invalid('to_unit_id');
    const [counts] = await tx.query<{ reports: string; snapshot_lines: string; plan_lines: string }>(
      `select (select count(*) from machvon.report_revision where project_id = $1::uuid and deleted_at is null)::text as reports,
              (select count(*) from machvon.period_snapshot_line where project_id = $1::uuid)::text as snapshot_lines,
              (select count(*) from machvon.allocation_line where project_id = $1::uuid)::text as plan_lines`,
      [projectId],
    );
    const owner = byId.get(units.owner_unit_id);
    const investor = units.investor_unit_id === null ? undefined : byId.get(units.investor_unit_id);
    const sees = (access: EffectiveAccess, ownerUnit: { id: string; path: string } | undefined, investorUnit: { id: string; path: string } | undefined): boolean =>
      [ownerUnit, investorUnit].some((unit) => unit !== undefined && holdsOver(access, READ_PERMISSION, { ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId }, input.now));
    // The members and their grants are read in two statements (not one for each member), and the sight of the project is judged in memory.
    const members = await tx.query<{ id: string }>(
      `select id from machvon.membership where status = 'Active' and membership_type = 'STAFF' and valid_from <= now() and (valid_until is null or valid_until > now()) order by id limit ${PREVIEW_MEMBER_CAP + 1}`,
    );
    const checked = members.slice(0, PREVIEW_MEMBER_CAP).map((member) => member.id);
    const grantRows = await tx.query<GrantRow & { membership_id: string }>(
      `select g.membership_id, r.code, r.rank, r.permissions, g.scope_kind, g.scope_ref_ids, g.status, g.effective_from, g.effective_until,
              coalesce((select array_agg(u.path order by u.path) from machvon.organization_unit u where u.id = any(g.scope_ref_ids)), '{}') as unit_paths
         from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
        where g.membership_id = any($1::uuid[]) and g.status = 'Active'`,
      [checked],
    );
    const accessOf = new Map<string, EffectiveAccess>();
    for (const row of grantRows) {
      const held = accessOf.get(row.membership_id) ?? { membershipId: row.membership_id, scopeVersion: 0, membershipActive: true, grants: [] };
      accessOf.set(row.membership_id, { ...held, grants: [...held.grants, grantViewOf(row)] });
    }
    let gaining = 0;
    let losing = 0;
    for (const access of accessOf.values()) {
      const before = scope === 'OWNER_UNIT' ? sees(access, from, investor) : sees(access, owner, from);
      const after = scope === 'OWNER_UNIT' ? sees(access, to, investor) : sees(access, owner, to);
      if (!before && after) gaining += 1;
      if (before && !after) losing += 1;
    }
    return {
      projectId,
      scope,
      fromUnit: { id: from.id, name: from.name },
      toUnit: { id: to.id, name: to.name },
      reports: Number(counts?.reports ?? 0),
      snapshotLines: Number(counts?.snapshot_lines ?? 0),
      planLines: Number(counts?.plan_lines ?? 0),
      usersGaining: gaining,
      usersLosing: losing,
      membersChecked: checked.length,
      partial: members.length > PREVIEW_MEMBER_CAP,
    };
  }

  private async read(tx: TenantTx, id: string): Promise<TransferRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /**
   * Whether a unit can own a project from a day: it is active (a dissolved or superseded unit cannot, as the register says) and in force on that day (a unit planned for a later day is allowed for that day, one that
   * ended before it is not).
   */
  private async receivingUnitUsable(tx: TenantTx, unitId: string, day: string): Promise<boolean> {
    const [unit] = await tx.query<{ ok: boolean }>(
      `select (status = 'Active' and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)) as ok from machvon.organization_unit where id = $1::uuid`,
      [unitId, day],
    );
    return unit?.ok === true;
  }

  private async unitsOf(tx: TenantTx, projectId: string): Promise<ProjectUnits> {
    const [row] = await tx.query<ProjectUnits>('select owner_unit_id, investor_unit_id, status from machvon.project where id = $1::uuid', [projectId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }
}

/** The audit row of a request. The reason and the units are told, never a person. */
export function transferRequestedRecord(change: TransferChange) {
  const { row } = change;
  return {
    action: 'prj.transfer_requested',
    resourceType: TRANSFER_RESOURCE,
    resourceId: row.id,
    diff: { project_id: row.projectId, from_unit_id: row.fromUnitId, to_unit_id: row.toUnitId, transfer_scope: row.scope, effective_date: row.effectiveDate, decision_document_id: row.decisionDocumentId },
  };
}

/** The audit row of a decision (the reason is kept on the request, not copied here). */
export function transferDecidedRecord(change: TransferChange) {
  const { row } = change;
  return {
    action: change.stale ? 'prj.transfer_closed_stale' : `prj.transfer_${row.status === 'APPROVED' || row.status === 'APPLIED' ? 'approved' : row.status === 'REJECTED' ? 'rejected' : 'returned'}`,
    resourceType: TRANSFER_RESOURCE,
    resourceId: row.id,
    diff: { project_id: row.projectId, transfer_scope: row.scope, effective_date: row.effectiveDate, from_status: change.previousStatus, status: row.status, applied: change.applied, stale: change.stale },
  };
}

/** The audit row and the event of a transfer that was made. */
export function transferAppliedRecord(change: TransferChange, tenantId: string, actor: string, occurredAt: Date) {
  const { row } = change;
  return {
    audit: {
      action: 'prj.transfer_applied',
      resourceType: TRANSFER_RESOURCE,
      resourceId: row.id,
      diff: { project_id: row.projectId, from_unit_id: row.fromUnitId, to_unit_id: row.toUnitId, transfer_scope: row.scope, effective_date: row.effectiveDate },
    },
    event: {
      aggregateType: 'project',
      aggregateId: row.projectId,
      aggregateVersion: change.projectVersion ?? row.version,
      type: PROJECT_TRANSFERRED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: tenantId,
        project_id: row.projectId,
        transfer_id: row.id,
        version: change.projectVersion ?? row.version,
        actor_id: actor,
        occurred_at: occurredAt.toISOString(),
        transfer_scope: row.scope,
        from_unit_id: row.fromUnitId,
        to_unit_id: row.toUnitId,
        effective_date: row.effectiveDate,
      },
      eventKey: `${TRANSFER_RESOURCE}:${row.id}:applied`,
    },
  };
}

/**
 * The job `prj.transfer-apply` (ST-PRJ-007): the approved transfers whose day has come (by the date in Vietnam) are made, each with its audit row and its event, and the ones whose project changed unit meanwhile are
 * closed with a row that says so. The pass is idempotent: a transfer that was made is not approved any more.
 */
export class PrjTransferApplyJob {
  private readonly store = new PrjTransferStore();
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, tenantId: string, actor: string, now: Date): Promise<{ applied: number; closed: number }> {
    const done = await this.store.applyDue(tx, actor, now);
    const correlationId = randomUUID();
    let applied = 0;
    let closed = 0;
    for (const change of done) {
      if (change.applied) {
        applied += 1;
        const record = transferAppliedRecord(change, tenantId, actor, now);
        await this.audit.recordInTx(tx, actor, { ...record.audit, correlationId, requestId: randomUUID() });
        await enqueueOutbox(tx, { ...record.event, correlationId });
      } else {
        closed += 1;
        await this.audit.recordInTx(tx, actor, { ...transferDecidedRecord(change), action: 'prj.transfer_closed_stale', correlationId, requestId: randomUUID() });
      }
    }
    if (applied > 0) this.metrics.increment(TRANSFER_DUE_METRIC, {});
    return { applied, closed };
  }
}
