import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The gauge of the nightly check: the number of recommendations whose recovered amount is not what their ledger adds up to; an alert watches it (`AUD_RECOVERY_RECONCILE_MISMATCH`, it must be 0). */
export const AUD_RECOVERY_MISMATCH_METRIC = 'aud_recovery_reconcile_mismatch_total';
/** The type of the event that reports one recommendation whose recovered amount differs from its ledger. */
export const AUD_RECOVERY_MISMATCH_EVENT = 'aud.recovery.reconcile_mismatch.v1';

const RESOURCE_TYPE = 'audit_recommendation';
const CLASSIFICATION = 'CONFIDENTIAL';

export interface RecoveryMismatch {
  recommendationId: string;
  recCode: string;
  engagementId: string;
  /** What the recommendation says was recovered. */
  recoveredVnd: string;
  /** What its ledger adds up to. */
  ledgerVnd: string;
  /** The recommendation less the ledger. */
  differenceVnd: string;
}

export interface RecoveryReconcileResult {
  checked: number;
  mismatches: RecoveryMismatch[];
}

/**
 * The nightly job `aud-recovery-reconcile` (ST-AUD-004, BR-AUD-01, UAT-AC438): for every financial recommendation, `recovered_vnd` is compared with the sum of the lines of its ledger. The table moves
 * the first with every line, so a difference means that something wrote around it. A difference never changes a recommendation or a line (the ledger is the record, and a person finds out which of
 * the two is wrong): the gauge takes the number of recommendations that differ, the audit row and the event `aud.recovery.reconcile_mismatch.v1` say which, once a day for each, and a run with no
 * difference sets the gauge back to nothing.
 */
export class AudRecoveryReconcileJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  /** The recommendations that differ from their ledger, read without changing anything. */
  async mismatches(tx: TenantTx): Promise<RecoveryMismatch[]> {
    const rows = await tx.query<{ id: string; rec_code: string; engagement_id: string; recovered_vnd: string; ledger_vnd: string; difference_vnd: string }>(
      `select r.id, r.rec_code, c.engagement_id, r.recovered_vnd::text as recovered_vnd, coalesce(sum(l.amount_vnd), 0)::text as ledger_vnd,
              (r.recovered_vnd - coalesce(sum(l.amount_vnd), 0))::text as difference_vnd
         from machvon.audit_recommendation r
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
         left join machvon.audit_recovery_link l on l.tenant_id = r.tenant_id and l.recommendation_id = r.id
        where r.rec_type in ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT')
        group by r.id, r.rec_code, c.engagement_id, r.recovered_vnd
       having r.recovered_vnd <> coalesce(sum(l.amount_vnd), 0)
        order by r.rec_code, r.id`,
    );
    return rows.map((row) => ({ recommendationId: row.id, recCode: row.rec_code, engagementId: row.engagement_id, recoveredVnd: row.recovered_vnd, ledgerVnd: row.ledger_vnd, differenceVnd: row.difference_vnd }));
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<RecoveryReconcileResult> {
    const [tenant] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    const tenantId = tenant?.tenant_id ?? '';
    const [counted] = await tx.query<{ checked: string }>("select count(*)::text as checked from machvon.audit_recommendation where rec_type in ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT')");
    const mismatches = await this.mismatches(tx);
    const correlationId = randomUUID();
    const day = vietnamDateOf(now);
    for (const mismatch of mismatches) {
      await this.audit.recordInTx(tx, actor, {
        action: 'aud.recovery_mismatch_detected',
        resourceType: RESOURCE_TYPE,
        resourceId: mismatch.recommendationId,
        classification: CLASSIFICATION,
        diff: { rec_code: mismatch.recCode, engagement_id: mismatch.engagementId, recovered_vnd: mismatch.recoveredVnd, ledger_vnd: mismatch.ledgerVnd, difference_vnd: mismatch.differenceVnd },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: mismatch.recommendationId,
        aggregateVersion: 1,
        type: AUD_RECOVERY_MISMATCH_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          recommendation_id: mismatch.recommendationId,
          engagement_id: mismatch.engagementId,
          rec_code: mismatch.recCode,
          recovered_vnd: mismatch.recoveredVnd,
          ledger_vnd: mismatch.ledgerVnd,
          difference_vnd: mismatch.differenceVnd,
          occurred_at: now.toISOString(),
          source_module: 'AUD',
        },
        eventKey: `${RESOURCE_TYPE}:${mismatch.recommendationId}:mismatch:${day}`,
        correlationId,
      });
    }
    this.metrics.gauge(AUD_RECOVERY_MISMATCH_METRIC, mismatches.length, { tenant_id: tenantId });
    return { checked: Number(counted?.checked ?? 0), mismatches };
  }
}
