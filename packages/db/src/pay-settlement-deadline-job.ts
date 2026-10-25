import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, daysBetween, deadlineStage, vietnamDateOf } from '@machvon/kernel';
import type { DeadlineStage, MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The settlements whose verification is past its last day (gauge; the alert `PAY_SETTLEMENT_OVERDUE` watches it). */
export const PAY_SETTLEMENT_OVERDUE_METRIC = 'pay_settlement_overdue';
/** The type of the event that asks ISS for an issue about a settlement that is past its day (the common contract of the issue intake, ISS-11). */
export const SETTLEMENT_OVERDUE_EVENT = 'pay.settlement.overdue.v1';
/** The type of the reminder that a settlement is 30 days, or 7 days, from the last day of its verification. */
export const SETTLEMENT_DEADLINE_EVENT = 'pay.settlement.deadline_approaching.v1';

const RESOURCE_TYPE = 'settlement_revision';
const CLASSIFICATION = 'CONFIDENTIAL';

export interface SettlementDeadlineResult {
  /** The reminders sent by this pass, by stage. */
  reminded: { T30: number; T7: number; OVERDUE: number };
  /** The settlements past their day now, whether or not this pass reported them. */
  overdue: number;
}

interface DueRow {
  id: string;
  tenant_id: string;
  project_id: string;
  contract_id: string | null;
  owner_unit_id: string;
  project_group: string | null;
  status: string;
  verification_due_on: string;
  t30: boolean;
  t7: boolean;
  overdue: boolean;
}

/**
 * The job `settlement-deadline` (ST-PAY-009, PAY 3.5 step 4): a settlement that was sent and is not verified yet is reminded 30 days and 7 days before the last day of its verification, and reported when that day
 * has passed, each once. The reminder is an event with the audit row; the overdue settlement is the event that the issue intake of ISS answers by opening one issue (BR-ISS-07). A settlement that is first found
 * late (the job did not run for a while) is reported as late and the reminders it missed are not sent after the fact. Each stage is remembered on the settlement, so a second pass sends nothing more.
 */
export class PaySettlementDeadlineJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<SettlementDeadlineResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const rows = await tx.query<DueRow>(
      `select sr.id, sr.tenant_id::text as tenant_id, sr.project_id, sr.contract_id, p.owner_unit_id, sr.project_group, sr.status, sr.verification_due_on::text as verification_due_on,
              sr.deadline_t30_sent_at is not null as t30, sr.deadline_t7_sent_at is not null as t7, sr.deadline_overdue_sent_at is not null as overdue
         from machvon.settlement_revision sr join machvon.project p on p.tenant_id = sr.tenant_id and p.id = sr.project_id
        where sr.status in ('SUBMITTED', 'VERIFYING') and sr.verification_due_on is not null
        order by sr.verification_due_on, sr.id
        for update of sr skip locked`,
    );
    const reminded = { T30: 0, T7: 0, OVERDUE: 0 };
    let overdue = 0;
    for (const row of rows) {
      const stage = deadlineStage(row.verification_due_on, today);
      if (stage === 'OVERDUE') overdue += 1;
      if (stage === undefined || this.sent(row, stage)) continue;
      // The stages only grow: a stage that is reached marks the ones before it as sent too.
      await tx.query(
        `update machvon.settlement_revision
            set deadline_t30_sent_at = coalesce(deadline_t30_sent_at, $2::timestamptz), deadline_t7_sent_at = case when $3::text in ('T7', 'OVERDUE') then coalesce(deadline_t7_sent_at, $2::timestamptz) else deadline_t7_sent_at end,
                deadline_overdue_sent_at = case when $3::text = 'OVERDUE' then coalesce(deadline_overdue_sent_at, $2::timestamptz) else deadline_overdue_sent_at end
          where id = $1::uuid`,
        [row.id, now.toISOString(), stage],
      );
      await this.report(tx, actor, row, stage, today, now, correlationId);
      reminded[stage] += 1;
    }
    this.metrics.gauge(PAY_SETTLEMENT_OVERDUE_METRIC, overdue);
    return { reminded, overdue };
  }

  private sent(row: DueRow, stage: DeadlineStage): boolean {
    if (stage === 'OVERDUE') return row.overdue;
    if (stage === 'T7') return row.t7;
    return row.t30;
  }

  private async report(tx: TenantTx, actor: string, row: DueRow, stage: DeadlineStage, today: string, now: Date, correlationId: string): Promise<void> {
    const facts = { project_id: row.project_id, project_group: row.project_group, verification_due_on: row.verification_due_on, status: row.status, stage };
    await this.audit.recordInTx(tx, actor, {
      action: stage === 'OVERDUE' ? 'pay.settlement_overdue' : 'pay.settlement_deadline_approaching',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: facts,
      correlationId,
      requestId: randomUUID(),
    });
    const base = { tenant_id: row.tenant_id, project_id: row.project_id, ...(row.contract_id === null ? {} : { contract_id: row.contract_id }), occurred_at: now.toISOString() };
    if (stage === 'OVERDUE') {
      // The members of the common contract of the issue intake: ids, a reference code and a severity, never a name or a text.
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: row.id,
        aggregateVersion: 1,
        type: SETTLEMENT_OVERDUE_EVENT,
        schemaVersion: 1,
        payload: {
          ...base,
          source_ref_id: row.id,
          reference_code: `SR-${row.id.slice(0, 8)}`,
          owner_unit_id: row.owner_unit_id,
          severity: 'HIGH',
          status: row.status,
          verification_due_on: row.verification_due_on,
          source_module: 'PAY',
        },
        eventKey: `${RESOURCE_TYPE}:${row.id}:deadline:OVERDUE`,
        correlationId,
      });
      return;
    }
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: row.id,
      aggregateVersion: 1,
      type: SETTLEMENT_DEADLINE_EVENT,
      schemaVersion: 1,
      payload: { ...base, settlement_id: row.id, stage, status: row.status, project_group: row.project_group, verification_due_on: row.verification_due_on, days_left: daysBetween(today, row.verification_due_on) },
      eventKey: `${RESOURCE_TYPE}:${row.id}:deadline:${stage}`,
      correlationId,
    });
  }
}
