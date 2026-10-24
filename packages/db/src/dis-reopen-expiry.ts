import { randomUUID } from 'node:crypto';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { DIS_PERIOD_REOPEN_METRIC, DisPeriodReopenStore, REOPEN_EXPIRY_REASON, reopenLabels, reopenRecord } from './dis-period-reopen-store.ts';
import type { TenantTx } from './tenant-database.ts';

export interface ReopenExpiryResult {
  expired: number;
}

export interface ReopenExpiryOptions {
  store?: DisPeriodReopenStore;
  metrics?: MetricsSink;
}

/**
 * The job `dis-reopen-expiry` (DIS 3 F4, "hết window_until → EXPIRED"). It stores the end of the reopening windows that have ended
 * (APPROVED to EXPIRED) and leaves the audit row of each, so the history of a request ends with its expiry and the screens and reports
 * read a stored fact. It is NOT what ends a window: the submit guard judges the window by the time alone (DisPeriodStore.judge), and the
 * reads show an elapsed window as EXPIRED from its last instant, so a late or failed run changes what is stored, never who may submit.
 * Running it again at the same moment does nothing more.
 */
export class DisReopenExpiry {
  private readonly store: DisPeriodReopenStore;
  private readonly metrics: MetricsSink;
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, options: ReopenExpiryOptions = {}) {
    this.audit = audit;
    this.store = options.store ?? new DisPeriodReopenStore();
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  /** One pass for the tenant of the transaction. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<ReopenExpiryResult> {
    const correlationId = randomUUID();
    const expired = await this.store.expireDue(tx, actor, now);
    for (const { reopen, period } of expired) {
      const record = reopenRecord('expired', reopen, period, REOPEN_EXPIRY_REASON);
      await this.audit.recordInTx(tx, actor, { ...record.audit, correlationId, requestId: randomUUID() });
      this.metrics.increment(DIS_PERIOD_REOPEN_METRIC, reopenLabels('expired'));
    }
    return { expired: expired.length };
  }
}
