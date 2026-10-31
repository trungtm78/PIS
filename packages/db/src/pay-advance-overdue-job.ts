import { randomUUID } from 'node:crypto';
import { DomainError, advanceAlert, recoveryPlan, vietnamDateOf } from '@machvon/kernel';
import type { AdvanceAlertLevel } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { ISSUE_ESCALATED_EVENT, escalatedEventKey, escalatedPayload } from './iss-escalation-event.ts';
import { IssEscalationStore } from './iss-escalation-store.ts';
import type { EscalatableIssue, RaisedEscalation } from './iss-escalation-store.ts';
import { IssIssueStore, LOCK_COLUMNS, SCOPE_FROM as ISSUE_SCOPE_FROM } from './iss-issue-store.ts';
import { IssSlaDeadlines } from './iss-sla-deadline.ts';
import type { CalendarCache } from './iss-sla-deadline.ts';
import { TaskForceDirectory } from './iss-task-force-directory.ts';
import { PayAdvanceStore } from './pay-advance-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The advances that are overdue and still owed, summed over the tenants by the sweep (gauge; the alert `PAY_ADVANCE_OVERDUE` watches it). */
export const PAY_ADVANCE_OVERDUE_METRIC = 'pay_advance_overdue';
/** The event that asks ISS for an issue about an advance that is overdue (the common contract of the issue intake, ISS-11). */
export const ADVANCE_OVERDUE_EVENT = 'pay.advance.overdue.v1';
/** The event of every other level of the alert: seven days before the deadline, the deadline, and the day the advance is raised to the leader. */
export const ADVANCE_ALERT_EVENT = 'pay.advance.alert.v1';
/** The code the escalation of the issue of an overdue advance is raised with. */
export const ADVANCE_ESCALATION_REASON = 'ADVANCE_OVERDUE_ESCALATED';

const RESOURCE_TYPE = 'contract_advance';
const CLASSIFICATION = 'CONFIDENTIAL';
const WORKING_STATUSES = "('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED')";

export interface AdvanceOverdueResult {
  /** The alerts raised by this pass, by level. */
  alerted: Record<AdvanceAlertLevel, number>;
  /** The issues escalated to the leader by this pass. */
  escalated: number;
  /** The advances that are overdue and owed now, whether or not this pass reported them. */
  overdue: number;
}

interface CandidateSql {
  id: string;
  tenant_id: string;
  kind: 'CONTRACT' | 'GPMB';
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  party_id: string;
  tranche_no: number;
  paid_vnd: string;
  recovered_vnd: string;
  outstanding_vnd: string;
  work_value_vnd: string;
  recovery_threshold_pct: string;
  paid_on: string;
  recovery_deadline: string | null;
  overdue_since: string | null;
  last_alert_level: number;
  created_by: string;
}

/**
 * The job `advance-overdue` (ST-PAY-011, PAY 3.2 step 4, BR-PAY-11, UAT-AC328, UAT-AC329): every morning an advance that is owed is looked at. A land clearance advance is warned seven days before its deadline (level 1), on the
 * deadline (2), the day after it (3: the day it became overdue is written and one issue is asked for) and seven days after it (4: the issue is escalated to the leader). An advance of a contract is overdue from the day its member
 * has asked to be paid up to the threshold of recovery and still owes it, or from the day the contract ended, and is escalated a week later. The level that went is remembered on the advance, so a second pass sends nothing more;
 * an advance that is first found late gets the level it is at and the ones it missed are not sent after the fact. Nothing here marks an advance as recovered.
 */
export class PayAdvanceOverdueJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly advances = new PayAdvanceStore();
  private readonly deadlines = new IssSlaDeadlines();
  private readonly escalations: IssEscalationStore;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
    this.escalations = new IssEscalationStore(new IssIssueStore(this.deadlines), this.deadlines, new TaskForceDirectory());
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<AdvanceOverdueResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const cache: CalendarCache = new Map();
    const rows = await tx.query<CandidateSql>(
      `select a.id, a.tenant_id::text as tenant_id, a.kind, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, ou.id as owner_unit_id, ou.path as owner_unit_path,
              iu.id as investor_unit_id, iu.path as investor_unit_path, a.party_id, a.tranche_no, a.paid_vnd::text as paid_vnd, a.recovered_vnd::text as recovered_vnd, a.outstanding_vnd::text as outstanding_vnd,
              cp.work_value_vnd::text as work_value_vnd, a.recovery_threshold_pct::text as recovery_threshold_pct, a.paid_on::text as paid_on, a.recovery_deadline::text as recovery_deadline, a.overdue_since::text as overdue_since,
              a.last_alert_level, a.created_by
         from machvon.contract_advance a
         join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id
         join machvon.contract_party cp on cp.tenant_id = a.tenant_id and cp.id = a.party_id
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where a.status in ('PAID', 'RECOVERING') and a.paid_vnd > a.recovered_vnd
        order by a.id
        for update of a skip locked`,
    );
    const result: AdvanceOverdueResult = { alerted: { 1: 0, 2: 0, 3: 0, 4: 0 }, escalated: 0, overdue: 0 };
    for (const row of rows) {
      const gross = row.kind === 'CONTRACT' ? await this.advances.grossToDate(tx, row.contract_id, row.party_id) : '0';
      const thresholdReached =
        row.kind === 'CONTRACT' &&
        recoveryPlan({ paidVnd: row.paid_vnd, recoveredVnd: row.recovered_vnd, workValueVnd: row.work_value_vnd, thresholdPct: row.recovery_threshold_pct, grossToDateVnd: gross }).remainingToThresholdVnd === '0';
      const alert = advanceAlert(
        { kind: row.kind, outstandingVnd: row.outstanding_vnd, recoveryDeadline: row.recovery_deadline, overdueSince: row.overdue_since, thresholdReached, contractEnded: ['COMPLETED', 'TERMINATED', 'CLOSED'].includes(row.contract_status) },
        today,
      );
      if (alert.level >= 3) result.overdue += 1;
      if (alert.level === 0) continue;
      // The levels only grow, and a level that was missed is not sent after the fact.
      if (alert.level > row.last_alert_level) {
        await tx.query('update machvon.contract_advance set last_alert_level = $2::smallint, overdue_since = coalesce(overdue_since, $3::date) where id = $1::uuid', [row.id, alert.level, alert.overdueSince]);
        await this.report(tx, actor, row, alert.level, today, now, correlationId);
        result.alerted[alert.level] += 1;
      }
      // The escalation is tried at every pass while the advance is at level 4 and its issue has not been escalated for this reason: an issue that was locked, or not yet opened, is raised by a later pass.
      if (alert.level === 4 && (await this.escalate(tx, actor, row, now, correlationId, cache))) result.escalated += 1;
    }
    return result;
  }

  private async report(tx: TenantTx, actor: string, row: CandidateSql, level: AdvanceAlertLevel, today: string, now: Date, correlationId: string): Promise<void> {
    const facts = { contract_id: row.contract_id, project_id: row.project_id, kind: row.kind, tranche_no: row.tranche_no, outstanding_vnd: row.outstanding_vnd, recovery_deadline: row.recovery_deadline, level };
    await this.audit.recordInTx(tx, actor, {
      action: level === 3 ? 'pay.advance_overdue' : 'pay.advance_alerted',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: facts,
      correlationId,
      requestId: randomUUID(),
    });
    const base = { tenant_id: row.tenant_id, project_id: row.project_id, contract_id: row.contract_id, occurred_at: now.toISOString() };
    if (level === 3) {
      // The members of the common contract of the issue intake: ids, a reference code and a severity, never a name or a text. The issue is asked for once, whatever the number of passes.
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: row.id,
        aggregateVersion: 1,
        type: ADVANCE_OVERDUE_EVENT,
        schemaVersion: 1,
        payload: {
          ...base,
          source_ref_id: row.id,
          reference_code: `ADV-${row.id.slice(0, 8)}`,
          owner_unit_id: row.owner_unit_id,
          severity: 'HIGH',
          source_module: 'PAY',
          advance_id: row.id,
          kind: row.kind,
          outstanding_vnd: row.outstanding_vnd,
        },
        eventKey: `${RESOURCE_TYPE}:${row.id}:${row.paid_on}:alert:3`,
        correlationId,
      });
      return;
    }
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: row.id,
      aggregateVersion: 1,
      type: ADVANCE_ALERT_EVENT,
      schemaVersion: 1,
      payload: {
        ...base,
        advance_id: row.id,
        kind: row.kind,
        level,
        outstanding_vnd: row.outstanding_vnd,
        recovery_deadline: row.recovery_deadline,
        notification: {
          resource: {
            type: 'contract',
            id: row.contract_id,
            ownerUnitId: row.owner_unit_id,
            ownerUnitPath: row.owner_unit_path,
            ...(row.investor_unit_id === null || row.investor_unit_path === null ? {} : { investorUnitId: row.investor_unit_id, investorUnitPath: row.investor_unit_path }),
            projectId: row.project_id,
            contractId: row.contract_id,
          },
          deepLink: `/pay/pay-12?contract=${row.contract_id}`,
          recipients: [row.created_by],
        },
      },
      eventKey: `${RESOURCE_TYPE}:${row.id}:${row.paid_on}:alert:${level}`,
      correlationId,
    });
  }

  /**
   * Level 4 raises the issue that level 3 asked for to the leader of the unit that answers for it (the escalation of level 2 of ISS, with the project leaders to tell). An issue that is not there (the intake did not open it yet,
   * or it is closed) is left as it is: the alert of the level was sent and the advance stays on the board.
   */
  private async escalate(tx: TenantTx, actor: string, row: CandidateSql, now: Date, correlationId: string, cache: CalendarCache): Promise<boolean> {
    const [issue] = await tx.query<EscalatableIssue>(
      `select ${LOCK_COLUMNS}, pol.calendar_code
         from ${ISSUE_SCOPE_FROM} join machvon.issue_sla_policy pol on pol.tenant_id = i.tenant_id and pol.id = i.sla_policy_id
        where i.source_module = 'PAY' and i.source_ref_id = $1::uuid and i.status in ${WORKING_STATUSES}
          and not exists (select 1 from machvon.issue_escalation e where e.issue_id = i.id and (e.reason = $2 or (e.level = 2 and e.status in ('OPEN', 'ACCEPTED'))))
        order by i.opened_at desc limit 1
        for update of i skip locked`,
      [row.id, ADVANCE_ESCALATION_REASON],
    );
    if (issue === undefined) return false;
    let raised: RaisedEscalation;
    try {
      raised = await this.escalations.raise(tx, issue, { level: 2, trigger: 'SLA_AUTO', targetUnitId: issue.owner_unit_id, force: null, reason: ADVANCE_ESCALATION_REASON, note: null }, actor, now, issue.owner_unit_path, cache);
    } catch (error) {
      // The time the leader has to accept is counted on the calendar of the issue: a year that is not published leaves the issue as it is, as the job of the SLA does.
      if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
      return false;
    }
    await this.audit.recordInTx(tx, actor, {
      action: 'iss.issue_escalated',
      resourceType: 'issue',
      resourceId: raised.id,
      classification: 'INTERNAL',
      diff: { code: raised.code, level: raised.level, trigger: raised.trigger, from_status: raised.previousStatus, to_status: raised.status, target_unit_id: raised.targetUnitId, task_force_id: raised.taskForceId, accept_due_at: raised.acceptDueAt },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: 'issue',
      aggregateId: raised.id,
      aggregateVersion: raised.version,
      type: ISSUE_ESCALATED_EVENT,
      schemaVersion: 1,
      payload: escalatedPayload(row.tenant_id, raised, actor, now),
      eventKey: escalatedEventKey(raised),
      correlationId,
    });
    return true;
  }
}
