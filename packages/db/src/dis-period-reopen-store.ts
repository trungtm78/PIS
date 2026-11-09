import { randomUUID } from 'node:crypto';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { AuditEntry } from './audit-writer.ts';
import { DisPeriodStore, REOPEN_SELECT, readReopens } from './dis-period-store.ts';
import type { PeriodReopenRow, PeriodRow, ReopenScopeKind, ReopenSqlRow } from './dis-period-store.ts';
import type { OutboxEventInput } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The resource type of the audit rows of a request to reopen a period. */
export const REOPEN_RESOURCE = 'period_reopen';
/** The metric of a step of a request: requested, approved, rejected, or expired (counted by the command and by the job). */
export const DIS_PERIOD_REOPEN_METRIC = 'dis_period_reopen_total';
export const reopenLabels = (outcome: ReopenOutcome): { outcome: string } => ({ outcome });
/** What the audit trail says for a window that ended: a code, not prose, as the job has no person to explain to. */
export const REOPEN_EXPIRY_REASON = 'AUTO_REOPEN_WINDOW_ENDED';

export const MIN_REOPEN_REASON = 20;
export const MAX_REOPEN_REASON = 2000;
export const MIN_DECISION_REASON = 5;
/** The longest window the contract allows (168 hours, DIS 3 F4), for a request and for a grant. */
export const MAX_WINDOW_HOURS = 168;
export const MAX_REOPEN_PROJECTS = 500;
const MS_PER_HOUR = 3_600_000;

export type ReopenOutcome = 'requested' | 'approved' | 'rejected' | 'expired';

/** A project with the units its scope is judged by (the owner and the investor), as the request needs to test the reach of the requester. */
export interface ProjectPlace {
  id: string;
  code: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

export interface ReopenRequest {
  periodId: string;
  scopeKind: ReopenScopeKind;
  /** Required for PROJECTS, absent for PERIOD. */
  projectIds: readonly string[];
  reason: string;
  windowHours: number;
}

export interface ReopenDecision {
  decision: 'approve' | 'reject';
  reason: string;
  /** The window granted, in hours; an approval without it grants the window that was asked for, a rejection takes none. */
  windowHours?: number | undefined;
}

export interface ReopenWithPeriod {
  reopen: PeriodReopenRow;
  period: PeriodRow;
}

interface PlaceSql {
  id: string;
  code: string;
  owner_id: string;
  owner_path: string;
  investor_id: string | null;
  investor_path: string | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The ids as the lower-case text the database writes, each once, in the order they came. */
function distinctIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/**
 * The reopening of a locked reporting period (ST-DIS-002, DIS 3 F4). A maker asks, with a reason of at least 20 characters, for the whole
 * period or for named projects and a window of at most 168 hours; somebody else decides (separation of duties: the table refuses an
 * approver who is the requester too). An approval opens the window for exactly that scope from the moment of the decision, and the submit
 * guard (DisPeriodStore.judge) lets a report through only inside it. The period itself is never changed: it stays LOCKED, so the
 * window ending needs no write to close it, and the job that stores the expiry is only the memory of it.
 */
export class DisPeriodReopenStore {
  private readonly periods: DisPeriodStore;

  constructor(periods: DisPeriodStore = new DisPeriodStore()) {
    this.periods = periods;
  }

  /** A request by id, its status judged at `now`; locked for update when a decision is about to be made. */
  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<PeriodReopenRow | undefined> {
    const rows = await tx.query<ReopenSqlRow>(`${REOPEN_SELECT} where r.id = $2::uuid${lock ? ' for update of r' : ''}`, [now.toISOString(), id]);
    return (await readReopens(tx, rows))[0];
  }

  /** The projects with the units their scope is judged by; the ones that do not exist in the tenant are simply not in the answer. */
  async projectPlaces(tx: TenantTx, ids: readonly string[]): Promise<ProjectPlace[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<PlaceSql>(
      `select p.id, p.code, ou.id as owner_id, ou.path as owner_path, iu.id as investor_id, iu.path as investor_path
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where p.id = any($1::uuid[])`,
      [[...ids]],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      ownerUnit: { id: row.owner_id, path: row.owner_path },
      investorUnit: row.investor_id === null || row.investor_path === null ? null : { id: row.investor_id, path: row.investor_path },
    }));
  }

  /**
   * Records a request. The period must exist and be LOCKED (409 PERIOD_STATE_INVALID otherwise: an open or soft-closed period takes reports
   * anyway). The reason is kept trimmed and must then be 20 characters (422 REOPEN_REASON_REQUIRED). A request for projects names projects
   * of the tenant (422 on project_ids otherwise) and each must be within `mayReach`, the reach of the requester (403 SCOPE_DENIED).
   */
  async request(tx: TenantTx, request: ReopenRequest, actor: string, now: Date, mayReach: (place: ProjectPlace) => boolean): Promise<ReopenWithPeriod> {
    const reason = request.reason.trim();
    if (reason.length < MIN_REOPEN_REASON || reason.length > MAX_REOPEN_REASON) throw new DomainError('REOPEN_REASON_REQUIRED', 422, 'reason');
    if (!Number.isInteger(request.windowHours) || request.windowHours < 1 || request.windowHours > MAX_WINDOW_HOURS) throw invalid('window_hours');
    const projectIds = distinctIds(request.projectIds);
    if (request.scopeKind === 'PERIOD' ? projectIds.length > 0 : projectIds.length === 0 || projectIds.length > MAX_REOPEN_PROJECTS) throw invalid('project_ids');
    const period = await this.periods.find(tx, request.periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (period.status !== 'LOCKED') throw new DomainError('PERIOD_STATE_INVALID', 409, 'status');
    if (request.scopeKind === 'PROJECTS') {
      const places = await this.projectPlaces(tx, projectIds);
      if (places.length !== projectIds.length) throw invalid('project_ids');
      if (!places.every(mayReach)) throw new DomainError('SCOPE_DENIED', 403);
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.period_reopen
         (tenant_id, id, period_id, scope_kind, scope_project_ids, reason, requested_by, requested_window_hours, status, created_at, created_by, updated_at, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid[], $5, $6::uuid, $7::int, 'REQUESTED', $8::timestamptz, $6::uuid, $8::timestamptz, $6::uuid)`,
      [id, period.id, request.scopeKind, request.scopeKind === 'PERIOD' ? null : projectIds, reason, actor, request.windowHours, now.toISOString()],
    );
    return { reopen: await this.reloaded(tx, id, now), period };
  }

  /**
   * Decides a request that waits. Whoever asked does not decide (403 SELF_APPROVAL_DENIED, answered before anything else about the request is
   * told); the version the decider saw must be the current one (409 VERSION_CONFLICT); a request that was decided already is 409
   * PERIOD_STATE_INVALID. An approval opens the window from `now` for the hours granted (the hours asked for when none is given); a
   * rejection grants nothing and takes no hours.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: ReopenDecision, actor: string, now: Date): Promise<ReopenWithPeriod> {
    const reason = decision.reason.trim();
    if (reason.length < MIN_DECISION_REASON || reason.length > MAX_REOPEN_REASON) throw invalid('reason');
    if (decision.windowHours !== undefined && (decision.decision === 'reject' || !Number.isInteger(decision.windowHours) || decision.windowHours < 1 || decision.windowHours > MAX_WINDOW_HOURS)) {
      throw invalid('window_hours');
    }
    const current = await this.find(tx, id, now, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.requestedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'REQUESTED') throw new DomainError('PERIOD_STATE_INVALID', 409, 'status');
    if (decision.decision === 'approve') {
      const windowUntil = new Date(now.getTime() + (decision.windowHours ?? current.requestedWindowHours) * MS_PER_HOUR).toISOString();
      await tx.query(
        `update machvon.period_reopen set status = 'APPROVED', approved_by = $2::uuid, decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4, window_until = $5::timestamptz,
           updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [id, actor, now.toISOString(), reason, windowUntil],
      );
    } else {
      await tx.query(
        `update machvon.period_reopen set status = 'REJECTED', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4,
           updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [id, actor, now.toISOString(), reason],
      );
    }
    const reopen = await this.reloaded(tx, id, now);
    return { reopen, period: await this.periodOf(tx, reopen) };
  }

  /**
   * Stores the end of the approved windows that have ended (APPROVED to EXPIRED), oldest first. A request a command is deciding or reading
   * for update at that moment is left to the next run. This is the work of the job `dis.reopen-expiry`; nothing depends on it for the
   * rule itself, which is judged by the time (see DisPeriodStore.judge).
   */
  async expireDue(tx: TenantTx, actor: string, now: Date): Promise<ReopenWithPeriod[]> {
    const due = await tx.query<{ id: string }>(
      `select id from machvon.period_reopen where status = 'APPROVED' and window_until <= $1::timestamptz order by window_until, id for update skip locked`,
      [now.toISOString()],
    );
    const expired: ReopenWithPeriod[] = [];
    for (const { id } of due) {
      await tx.query(`update machvon.period_reopen set status = 'EXPIRED', updated_at = $2::timestamptz, updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [id, now.toISOString(), actor]);
      const reopen = await this.reloaded(tx, id, now);
      expired.push({ reopen, period: await this.periodOf(tx, reopen) });
    }
    return expired;
  }

  private async periodOf(tx: TenantTx, reopen: PeriodReopenRow): Promise<PeriodRow> {
    const period = await this.periods.find(tx, reopen.periodId);
    if (period === undefined) throw new Error('the period of a reopening vanished');
    return period;
  }

  private async reloaded(tx: TenantTx, id: string, now: Date): Promise<PeriodReopenRow> {
    const row = await this.find(tx, id, now);
    if (row === undefined) throw new Error('the request vanished after its update');
    return row;
  }
}

export interface ReopenRecord {
  audit: Omit<AuditEntry, 'correlationId' | 'requestId'>;
  /** Only an approval is an event: `period.reopened.v1` (DIS 3 F4). */
  event?: Omit<OutboxEventInput, 'correlationId'>;
}

/** The hours between two instants, as the decider granted them (the window starts at the decision). */
const hoursBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_HOUR);

/**
 * The audit row, and for an approval the event, of a step of a request, built once for the commands and the job so that both leave the
 * same trace. The audit row keeps who asked, who approved and the window (AC-ST-DIS-002-1); the event carries ids and times, never the
 * reasons. `row` is the request after the step.
 */
export function reopenRecord(outcome: ReopenOutcome, row: PeriodReopenRow, period: PeriodRow, reason: string): ReopenRecord {
  const base = {
    period_id: period.id,
    period_code: period.code,
    scope_kind: row.scopeKind,
    project_ids: row.projects.map((project) => project.id),
    requested_by: row.requestedBy,
    requested_window_hours: row.requestedWindowHours,
    status: row.status,
  };
  const decided = row.decidedAt === null || row.windowUntil === null ? {} : { approved_by: row.approvedBy, decided_at: row.decidedAt, window_until: row.windowUntil, window_hours: hoursBetween(row.decidedAt, row.windowUntil) };
  // HT.06: when the tenant opted in for `period_reopen`, the audit keeps the whole request before and after the step (the status it left, and the request as it now stands).
  const left = outcome === 'requested' ? null : { status: outcome === 'expired' && row.decidedAt !== null ? 'APPROVED' : 'REQUESTED' };
  const detail = (after: Record<string, unknown>) => ({ before: left, after });
  const audit = { action: `dis.period_reopen_${outcome}`, resourceType: REOPEN_RESOURCE, resourceId: row.id, reason };
  switch (outcome) {
    case 'requested':
      return { audit: { ...audit, diff: base, detail: detail(base) } };
    case 'rejected':
      return { audit: { ...audit, diff: { ...base, decided_by: row.decidedBy, decided_at: row.decidedAt }, detail: detail({ ...base, decided_by: row.decidedBy, decided_at: row.decidedAt, reason }) } };
    case 'expired':
      return { audit: { ...audit, diff: { ...base, ...decided, trigger: 'AUTO' }, detail: detail({ ...base, ...decided, trigger: 'AUTO' }) } };
    case 'approved':
      return {
        audit: { ...audit, diff: { ...base, ...decided }, detail: detail({ ...base, ...decided, reason }) },
        event: {
          aggregateType: REOPEN_RESOURCE,
          aggregateId: row.id,
          aggregateVersion: row.version,
          type: 'period.reopened.v1',
          schemaVersion: 1,
          payload: {
            reopen_id: row.id,
            period_id: period.id,
            period_code: period.code,
            scope_kind: row.scopeKind,
            project_ids: row.projects.map((project) => project.id),
            requested_by: row.requestedBy,
            approved_by: row.approvedBy,
            decided_at: row.decidedAt,
            window_until: row.windowUntil,
          },
          eventKey: `${REOPEN_RESOURCE}:${row.id}:${row.version}`,
        },
      };
  }
}
