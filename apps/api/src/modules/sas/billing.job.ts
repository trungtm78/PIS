import { randomUUID } from 'node:crypto';
import { BillingStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, EInvoiceProviderPort, TenantTx } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';

/** What one pass did for a tenant, and the figure of the gauge of the invoices that could not be issued. */
export interface BillingPassResult {
  /** Draft invoices made for the periods that closed (the daily billing). */
  drafted: number;
  /** Invoices the provider answered for in this pass, after an earlier attempt that failed. */
  issued: number;
  /** Invoices asked again and still waiting. */
  waiting: number;
  /** Invoices whose last attempt ended the tries (IssueFailed) in this pass. */
  failedNow: number;
  overdue: number;
  pastDue: number;
  suspensionProposed: number;
  /** All the invoices of the tenant that are IssueFailed after the pass, those of earlier passes included. */
  failed: number;
}

/**
 * The job `einvoice-billing` (SAS.md 3.7, the daily billing, the e-invoice workflow of 24 hours and the reminder of the days): every five minutes, for the tenant it is given, it makes the Draft invoices of
 * the periods that closed (a second pass finds them), asks the provider again for the invoices waiting for another attempt (five attempts in 24 hours, then IssueFailed), and marks the invoices past their due
 * day Overdue and their subscriptions PastDue, with the proposal of a suspension after thirty days. It changes nothing about the tenant or its license: only a System Admin decides a suspension (BR-SAS-04).
 * The pass runs through the control role acting as the tenant (the plans are control-plane rows), under the worker's membership.
 */
export class BillingJob {
  private readonly store = new BillingStore();

  constructor(
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    private readonly provider: EInvoiceProviderPort,
  ) {}

  async run(tx: TenantTx, actor: string, now: Date): Promise<BillingPassResult> {
    const correlationId = randomUUID();
    const effects: ApprovalEffects = {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
    const today = vietnamDateOf(now);
    const billed = await this.store.runClosedPeriods(tx, effects, today);
    const retried = await this.store.retryDue(tx, effects, this.provider, now);
    const swept = await this.store.sweepOverdue(tx, effects, today, now);
    return {
      drafted: billed.created.length,
      issued: retried.filter((entry) => entry.outcome === 'ISSUED').length,
      waiting: retried.filter((entry) => entry.outcome === 'PENDING').length,
      failedNow: retried.filter((entry) => entry.outcome === 'FAILED').length,
      overdue: swept.overdue.length,
      pastDue: swept.pastDue.length,
      suspensionProposed: swept.suspensionProposed.length,
      failed: await this.store.failedCount(tx),
    };
  }
}
