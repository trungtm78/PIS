import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, reconAddDays, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import {
  TREASURY_DAILY_RECON_OVERDUE_EVENT,
  TREASURY_DAILY_RECON_PARTIAL_METRIC,
  TREASURY_RECON_ALERT_TYPE,
  TREASURY_RECON_ITEM_RESOURCE,
  TreasuryDailyReconStore,
  reconRunRecord,
} from './pay-treasury-daily-recon-store.ts';
import type { TenantTx } from './tenant-database.ts';

export interface DailyReconJobResult {
  /** The days that were looked at, the passes written (a pass that found the very lines of the latest pass writes nothing) and the ones that were PARTIAL. */
  days: number;
  written: number;
  partial: number;
  opened: number;
  cleared: number;
  /** Items past their day that were reported in this pass (each asks ISS for one issue), and what waits now. */
  overdueReported: number;
  waiting: number;
  overdue: number;
}

/**
 * The job `treasury-daily-recon` (G4-4): every pass of the tick it reconciles the days that may still change with the Treasury: yesterday and the days back to `partial_after_days` + 1 days ago. A statement that is not due yet
 * (a day inside the grace days with no statement and no transaction) is not judged; one that is due and missing makes the day PARTIAL, once, with its reason. The pass is idempotent (the lines of a pass are hashed), so a tick
 * that finds nothing new writes nothing. Then every live item past its day is reported once with the event the issue intake of ISS answers by opening an issue, and the item remembers that it was reported. The clock is an argument.
 */
export class TreasuryDailyReconJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly store: TreasuryDailyReconStore;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS, store?: TreasuryDailyReconStore) {
    this.audit = audit;
    this.metrics = metrics;
    this.store = store ?? new TreasuryDailyReconStore(metrics);
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<DailyReconJobResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const rule = await this.store.rule(tx, today);
    const result: DailyReconJobResult = { days: 0, written: 0, partial: 0, opened: 0, cleared: 0, overdueReported: 0, waiting: 0, overdue: 0 };
    for (let age = 1; age <= rule.policy.partialAfterDays + 1; age += 1) {
      const day = reconAddDays(today, -age);
      result.days += 1;
      const outcome = await this.store.runDay(tx, { day, actor, now, origin: 'JOB', judgeMissing: age > rule.policy.partialAfterDays });
      if (outcome.notDue || outcome.run === null || outcome.reused) continue;
      result.written += 1;
      result.opened += outcome.openedItemIds.length;
      result.cleared += outcome.clearedItemIds.length;
      if (outcome.run.status === 'PARTIAL') {
        result.partial += 1;
        this.metrics.increment(TREASURY_DAILY_RECON_PARTIAL_METRIC, { reason: outcome.run.partialReason ?? 'UNKNOWN' });
      }
      const record = reconRunRecord({ ...outcome, run: outcome.run }, await this.tenantOf(tx), actor, now);
      await this.audit.recordInTx(tx, actor, { ...record.audit, correlationId, requestId: randomUUID() });
      await enqueueOutbox(tx, { ...record.event, correlationId });
    }
    result.overdueReported = await this.reportOverdue(tx, actor, today, now, correlationId);
    const gauges = await this.store.refreshGauges(tx, now);
    result.waiting = gauges.waiting;
    result.overdue = gauges.overdue;
    return result;
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const [row] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    return row?.tenant_id ?? '';
  }

  /** A live item past its day is reported once: the event carries the members of the common contract of the issue intake (ids, a reference code, a severity, never a name or a text) and the code of its alert type. */
  private async reportOverdue(tx: TenantTx, actor: string, today: string, now: Date, correlationId: string): Promise<number> {
    const due = await tx.query<{ id: string; tenant_id: string; project_id: string; owner_unit_id: string; fund_key: string; kind: string; status: string; due_on: string; recon_date: string; owner_membership_id: string; latest_difference_vnd: string }>(
      `select i.id, i.tenant_id::text as tenant_id, i.project_id, p.owner_unit_id, i.fund_key, i.kind, i.status, i.due_on::text as due_on, i.recon_date::text as recon_date, i.owner_membership_id,
              i.latest_difference_vnd::text as latest_difference_vnd
         from machvon.treasury_daily_recon_item i join machvon.project p on p.tenant_id = i.tenant_id and p.id = i.project_id
        where i.status in ('OPEN', 'EXPLAINED') and i.due_on < $1::date and i.overdue_flagged_at is null
        order by i.due_on, i.id
        for update of i skip locked`,
      [today],
    );
    for (const item of due) {
      await tx.query('update machvon.treasury_daily_recon_item set overdue_flagged_at = $2::timestamptz where id = $1::uuid', [item.id, now.toISOString()]);
      await this.audit.recordInTx(tx, actor, {
        action: 'pay.treasury_daily_recon_overdue',
        resourceType: TREASURY_RECON_ITEM_RESOURCE,
        resourceId: item.id,
        classification: 'CONFIDENTIAL',
        diff: { project_id: item.project_id, fund_key: item.fund_key, kind: item.kind, status: item.status, recon_date: item.recon_date, due_on: item.due_on, alert_type: TREASURY_RECON_ALERT_TYPE },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: TREASURY_RECON_ITEM_RESOURCE,
        aggregateId: item.id,
        aggregateVersion: 1,
        type: TREASURY_DAILY_RECON_OVERDUE_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: item.tenant_id,
          source_ref_id: item.id,
          reference_code: `TR-${item.id.slice(0, 8)}`,
          project_id: item.project_id,
          owner_unit_id: item.owner_unit_id,
          owner_membership_id: item.owner_membership_id,
          severity: 'MEDIUM',
          kind: item.kind,
          fund_key: item.fund_key,
          recon_date: item.recon_date,
          status: item.status,
          due_on: item.due_on,
          difference_vnd: item.latest_difference_vnd,
          alert_type: TREASURY_RECON_ALERT_TYPE,
          occurred_at: now.toISOString(),
          source_module: 'PAY',
        },
        eventKey: `${TREASURY_RECON_ITEM_RESOURCE}:${item.id}:overdue`,
        correlationId,
      });
    }
    return due.length;
  }
}

/** The issue that ISS opened for an item past its day is remembered on the item (the intake calls this in the transaction that opens it); the first one stays. */
export async function linkTreasuryReconIssue(tx: TenantTx, itemId: string, issueId: string): Promise<void> {
  await tx.query('update machvon.treasury_daily_recon_item set issue_id = $2::uuid where id = $1::uuid and issue_id is null', [itemId, issueId]);
}
