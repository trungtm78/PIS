import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { ISSUE_ESCALATED_EVENT, escalatedEventKey, escalatedPayload } from './iss-escalation-event.ts';
import { AUTO_ESCALATION_REASONS, IssEscalationStore } from './iss-escalation-store.ts';
import type { EscalatableIssue, RaisedEscalation } from './iss-escalation-store.ts';
import { IssIssueStore, LOCK_COLUMNS, SCOPE_FROM, iso } from './iss-issue-store.ts';
import { IssSlaDeadlines } from './iss-sla-deadline.ts';
import type { CalendarCache } from './iss-sla-deadline.ts';
import { SLA_SEVERITIES } from './iss-sla-policy-store.ts';
import type { SlaSeverity } from './iss-sla-policy-store.ts';
import { TaskForceDirectory } from './iss-task-force-directory.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The most issues one pass of one tenant looks at; the rest wait for the next pass (15 minutes), the oldest deadline first. */
export const SLA_PASS_LIMIT = 500;
/** The counter of the breaches the job found: by what it did about them (`overdue`, `2`, `3`). */
export const SLA_BREACH_METRIC = 'iss_sla_breach_total';
/** The gauges of the issues that are not closed, by severity, and of the escalations that wait for their receiver. */
export const OPEN_ISSUES_GAUGE = 'iss_open_total';
export const PENDING_ESCALATIONS_GAUGE = 'iss_escalation_pending';
const RESOURCE_TYPE = 'issue';
const CLASSIFICATION = 'INTERNAL';
const MINUTES_PER_HOUR = 60;
const WORKING_STATUSES = "('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED')";

/** What one pass did for a tenant, and the figures the gauges of the job are made of. */
export interface SlaPassResult {
  /** Issues whose day of becoming overdue was written (BR-ISS-04). */
  overdueMarked: number;
  escalated: Record<2 | 3, number>;
  /** Issues that reached the task force threshold while no task force answered for them: they wait for the next pass. */
  withoutTaskForce: number;
  /** Issues whose thresholds could not be counted because a year of their calendar is not published (a deadline is never guessed). */
  withoutCalendar: number;
  /** The issues that are not closed, by severity, after the pass. */
  open: Record<SlaSeverity, number>;
  /** The escalations that wait for their receiver after the pass. */
  pending: number;
}

interface CandidateSql extends EscalatableIssue {
  opened_at: string;
  overdue_since: string | null;
  resolve_hours: number;
  escalate_l2_pct: number;
  escalate_l3_pct: number;
  has_l2: boolean;
  has_l3: boolean;
}

export interface SlaJobOptions {
  metrics?: MetricsSink;
  deadlines?: IssSlaDeadlines;
}

/**
 * The job `issue-sla` (ISS 3.2, BR-ISS-03, BR-ISS-04): every 15 minutes, for the issues that are being worked, it writes the day an issue became overdue
 * (the deadline that was missed, once, with `SLA_BREACHED` in its timeline) and raises the escalations whose threshold the working time has reached:
 * level 2 to the unit at `escalate_l2_pct` and level 3 to the task force at `escalate_l3_pct` (100 and 150 by default) of the resolution time of the SLA the
 * issue was opened under. A threshold at or above 100 percent is counted from the current deadline, so an extension moves it; one below 100 is counted
 * from the day the issue was opened. An escalation exists once per level while it is open or accepted, so the pass is idempotent, and it never closes the
 * original issue. An issue a command is acting on at that moment is left to the next pass.
 */
export class IssSlaJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly deadlines: IssSlaDeadlines;
  private readonly escalations: IssEscalationStore;
  private readonly issues: IssIssueStore;
  private readonly forces: TaskForceDirectory;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, options: SlaJobOptions = {}) {
    this.audit = audit;
    this.deadlines = options.deadlines ?? new IssSlaDeadlines();
    this.issues = new IssIssueStore(this.deadlines);
    this.forces = new TaskForceDirectory();
    this.escalations = new IssEscalationStore(this.issues, this.deadlines, this.forces);
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<SlaPassResult> {
    const correlationId = randomUUID();
    const tenantId = await this.tenantOf(tx);
    const cache: CalendarCache = new Map();
    const result: SlaPassResult = { overdueMarked: 0, escalated: { 2: 0, 3: 0 }, withoutTaskForce: 0, withoutCalendar: 0, open: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }, pending: 0 };
    const candidates = await tx.query<CandidateSql>(
      `select ${LOCK_COLUMNS}, ${iso('i.opened_at')} as opened_at, ${iso('i.overdue_since')} as overdue_since, pol.calendar_code, pol.resolve_hours, pol.escalate_l2_pct, pol.escalate_l3_pct,
              exists (select 1 from machvon.issue_escalation e where e.issue_id = i.id and e.level = 2 and e.status in ('OPEN', 'ACCEPTED')) as has_l2,
              exists (select 1 from machvon.issue_escalation e where e.issue_id = i.id and e.level = 3 and e.status in ('OPEN', 'ACCEPTED')) as has_l3
         from ${SCOPE_FROM} join machvon.issue_sla_policy pol on pol.tenant_id = i.tenant_id and pol.id = i.sla_policy_id
        where i.status in ${WORKING_STATUSES}
          and (i.due_at <= $1::timestamptz or pol.escalate_l2_pct < 100 or pol.escalate_l3_pct < 100)
          and (i.overdue_since is null
               or not exists (select 1 from machvon.issue_escalation e where e.issue_id = i.id and e.level = 2 and e.status in ('OPEN', 'ACCEPTED'))
               or not exists (select 1 from machvon.issue_escalation e where e.issue_id = i.id and e.level = 3 and e.status in ('OPEN', 'ACCEPTED')))
        order by i.due_at, i.id limit $2
        for update of i skip locked`,
      [now.toISOString(), SLA_PASS_LIMIT],
    );
    for (const issue of candidates) await this.work(tx, issue, { tenantId, actor, correlationId, now, cache }, result);
    const open = await tx.query<{ severity: SlaSeverity; n: string }>("select severity, count(*)::text as n from machvon.issue where status <> 'CLOSED' group by severity");
    for (const severity of SLA_SEVERITIES) result.open[severity] = Number(open.find((row) => row.severity === severity)?.n ?? 0);
    result.pending = Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.issue_escalation where status = 'OPEN'"))[0]?.n ?? 0);
    return result;
  }

  private async work(tx: TenantTx, row: CandidateSql, pass: { tenantId: string; actor: string; correlationId: string; now: Date; cache: CalendarCache }, result: SlaPassResult): Promise<void> {
    const { now } = pass;
    let issue: EscalatableIssue = row;
    if (row.overdue_since === null && Date.parse(row.due_at) < now.getTime()) {
      await this.markOverdue(tx, row, pass);
      result.overdueMarked += 1;
    }
    let uncounted = false;
    for (const level of [2, 3] as const) {
      if (level === 2 ? row.has_l2 : row.has_l3) continue;
      let threshold: Date;
      try {
        threshold = await this.thresholdOf(tx, row, level === 2 ? row.escalate_l2_pct : row.escalate_l3_pct, pass.cache);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
        // A year of the calendar is not published: the threshold is not guessed, and the level waits for a pass that can count it.
        if (!uncounted) result.withoutCalendar += 1;
        uncounted = true;
        continue;
      }
      if (now.getTime() < threshold.getTime()) continue;
      const force = level === 3 ? await this.forces.activeFor(tx, { projectId: row.project_id, ownerUnitPath: row.owner_unit_path, on: vietnamDateOf(now) }) : undefined;
      if (level === 3 && force === undefined) {
        result.withoutTaskForce += 1;
        continue;
      }
      let raised: RaisedEscalation;
      try {
        raised = await this.escalations.raise(
          tx,
          issue,
          { level, trigger: 'SLA_AUTO', targetUnitId: issue.owner_unit_id, force: force ?? null, reason: AUTO_ESCALATION_REASONS[level], note: null },
          pass.actor,
          now,
          row.owner_unit_path,
          pass.cache,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
        // The time the receiver has to accept is counted on the calendar too; nothing was written before it was counted.
        if (!uncounted) result.withoutCalendar += 1;
        uncounted = true;
        continue;
      }
      await this.announce(tx, raised, pass);
      result.escalated[level] += 1;
      this.metrics.increment(SLA_BREACH_METRIC, { level: String(level) });
      // The next level of the same issue works on what this one left.
      issue = { ...issue, status: raised.status, version: String(raised.version), escalation_level: raised.escalationLevel };
    }
  }

  /** The instant at which the working time has reached `pct` percent of the resolution time of the policy (BR-ISS-03). */
  private thresholdOf(tx: TenantTx, row: CandidateSql, pct: number, cache: CalendarCache): Promise<Date> {
    if (pct >= 100) return this.deadlines.addMinutes(tx, row.calendar_code, new Date(row.due_at), Math.round((row.resolve_hours * MINUTES_PER_HOUR * (pct - 100)) / 100), cache);
    return this.deadlines.addMinutes(tx, row.calendar_code, new Date(row.opened_at), Math.round((row.resolve_hours * MINUTES_PER_HOUR * pct) / 100), cache);
  }

  /**
   * Writes the day the issue became overdue: the deadline it missed, not the moment the job noticed (BR-ISS-04), so a pass that runs late says the same as one that
   * runs on time. The version of the issue does not move, like the reminder of a guarantee: the deadline is the issue's own and nobody's screen is stale for it.
   */
  private async markOverdue(tx: TenantTx, row: CandidateSql, pass: { actor: string; correlationId: string; now: Date }): Promise<void> {
    await tx.query('update machvon.issue set overdue_since = due_at where id = $1::uuid and overdue_since is null', [row.id]);
    await this.issues.record(tx, row.id, pass.actor, { kind: 'SLA_BREACHED', fromStatus: row.status, toStatus: row.status, payload: { overdue_since: row.due_at, due_at: row.due_at } });
    await this.audit.recordInTx(tx, pass.actor, {
      action: 'iss.issue_overdue_marked',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: { code: row.code, status: row.status, overdue_since: row.due_at },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    this.metrics.increment(SLA_BREACH_METRIC, { level: 'overdue' });
  }

  private async announce(tx: TenantTx, raised: RaisedEscalation, pass: { tenantId: string; actor: string; correlationId: string; now: Date }): Promise<void> {
    await this.audit.recordInTx(tx, pass.actor, {
      action: 'iss.issue_escalated',
      resourceType: RESOURCE_TYPE,
      resourceId: raised.id,
      classification: CLASSIFICATION,
      diff: {
        code: raised.code,
        level: raised.level,
        trigger: raised.trigger,
        from_status: raised.previousStatus,
        to_status: raised.status,
        target_unit_id: raised.targetUnitId,
        task_force_id: raised.taskForceId,
        accept_due_at: raised.acceptDueAt,
      },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: raised.id,
      aggregateVersion: raised.version,
      type: ISSUE_ESCALATED_EVENT,
      schemaVersion: 1,
      payload: escalatedPayload(pass.tenantId, raised, pass.actor, pass.now),
      eventKey: escalatedEventKey(raised),
      correlationId: pass.correlationId,
    });
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id");
    const id = rows[0]?.tenant_id;
    if (id === undefined) throw new Error('the job ran outside a tenant');
    return id;
  }
}
