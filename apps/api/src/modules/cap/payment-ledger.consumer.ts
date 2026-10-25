import { randomUUID } from 'node:crypto';
import { AuditWriter, CapPaymentLedgerStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, PaymentFacts, PostingResult, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const CAP_PAYMENT_LEDGER_CONSUMER = 'cap-payment-ledger';
export const PAYMENT_SUBMITTED_EVENT = 'pay.payment_request.submitted.v1';
export const PAYMENT_RETURNED_EVENT = 'pay.payment_request.returned.v1';
export const PAYMENT_CANCELLED_EVENT = 'pay.payment_request.cancelled.v1';
export const PAYMENT_SETTLED_EVENT = 'pay.payment.settled.v2';
export const PAYMENT_REVERSED_EVENT = 'pay.payment.reversed.v1';
/** Postings of the consumer, by the event and what became of it (`posted`, `covered`, `unchanged`, `stale`, `no_line`). */
export const CAP_POSTING_METRIC = 'cap_payment_posting_total';
/** The alert for a rule of the capital ledger that the database had to refuse: the checks of the store let something through. */
export const CAP_LEDGER_CHECK_ALERT = 'CAP_LEDGER_CHECK_VIOLATION';
/** The event that tells the other modules which entries a payment put on the capital ledger. */
export const CAP_LEDGER_POSTED_EVENT = 'cap.ledger.payment_posted.v1';

const RESOURCE_TYPE = 'capital_ledger';
const CHECK_VIOLATION = '23514';
const HANDLED = [PAYMENT_SUBMITTED_EVENT, PAYMENT_RETURNED_EVENT, PAYMENT_CANCELLED_EVENT, PAYMENT_SETTLED_EVENT, PAYMENT_REVERSED_EVENT] as const;

export interface PaymentLedgerConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'schemaVersion' | 'payload'>;

const malformed = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A string of the payload that is a whole number of VND above zero. */
function amountOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,23}$/.test(value)) throw malformed(field);
  return value;
}

function instantOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) throw malformed(field);
  return new Date(value).toISOString();
}

function uuidOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw malformed(field);
  return id;
}

/**
 * The system consumer of the payment events of PAY (ST-CAP-006, CAP 3.4): a request that is sent commits its net unless the contract holds the commitment, a request that is returned or cancelled gives it
 * back, a payment the Treasury confirmed becomes a disbursement dated by the day the Treasury paid, and the refund of a reversed payment takes the disbursement back. The postings, the audit row and
 * `cap.ledger.payment_posted.v1` are written in the transaction of the inbox row, in the name of the system, so a delivery repeated after a crash adds nothing; a posting the balance cannot take fails the
 * delivery with 409 `BALANCE_INSUFFICIENT` and leaves no entry, and the relay tries it again until it is delivered or dead (`OUTBOX_EVENT_DEAD`).
 */
export class PaymentLedgerConsumer {
  private readonly ledger = new CapPaymentLedgerStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: PaymentLedgerConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return CAP_PAYMENT_LEDGER_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (!(HANDLED as readonly string[]).includes(delivery.type)) return 'ignored';
    const wanted = delivery.type === PAYMENT_SETTLED_EVENT ? 2 : 1;
    if (delivery.schemaVersion !== wanted) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    // An event of a request that is drawn on no line of capital (a request the plan does not fund) has nothing to post.
    const line = delivery.payload.allocation_line_id;
    if (line === null || line === undefined) {
      this.metrics.increment(CAP_POSTING_METRIC, { event: delivery.type, outcome: 'no_line' });
      return 'ignored';
    }
    try {
      return await consumeOnce(
        this.deps.database,
        delivery,
        CAP_PAYMENT_LEDGER_CONSUMER,
        async (tx) => {
          const result = await this.post(tx, delivery);
          this.metrics.increment(CAP_POSTING_METRIC, { event: delivery.type, outcome: result.outcome });
          if (result.outcome === 'posted') await this.record(tx, delivery, result);
        },
        this.deps.security,
      );
    } catch (error) {
      // A rule of the ledger that only the database refused means the store let a wrong entry through: that is a defect to be found, not a delivery to be retried into silence.
      if ((error as { code?: string }).code === CHECK_VIOLATION) this.deps.security.alerts?.raise(CAP_LEDGER_CHECK_ALERT, { tenantId: delivery.tenantId, eventType: delivery.type, eventId: delivery.id });
      throw error;
    }
  }

  private post(tx: TenantTx, delivery: Delivery): Promise<PostingResult> {
    const payload = delivery.payload;
    const facts = (amountField: string): PaymentFacts => ({
      paymentRequestId: uuidOf(payload.payment_request_id, 'payment_request_id'),
      contractId: uuidOf(payload.contract_id, 'contract_id'),
      allocationLineId: uuidOf(payload.allocation_line_id, 'allocation_line_id'),
      planYear: typeof payload.plan_year === 'number' && Number.isInteger(payload.plan_year) ? payload.plan_year : undefined,
      amountVnd: amountOf(payload[amountField], amountField),
    });
    switch (delivery.type) {
      case PAYMENT_SUBMITTED_EVENT:
        return this.ledger.commit(tx, facts('net_vnd'), WORKER_MEMBERSHIP_ID);
      case PAYMENT_RETURNED_EVENT:
      case PAYMENT_CANCELLED_EVENT:
        return this.ledger.release(tx, facts('net_vnd'), WORKER_MEMBERSHIP_ID);
      case PAYMENT_SETTLED_EVENT:
        return this.ledger.disburse(tx, { ...facts('amount_vnd'), transactionId: uuidOf(payload.transaction_id, 'transaction_id'), confirmedAt: instantOf(payload.confirmed_at, 'confirmed_at') }, WORKER_MEMBERSHIP_ID);
      default:
        return this.ledger.reverse(
          tx,
          {
            ...facts('amount_vnd'),
            settledTransactionId: uuidOf(payload.settled_transaction_id, 'settled_transaction_id'),
            refundTransactionId: uuidOf(payload.refund_transaction_id, 'refund_transaction_id'),
            refundConfirmedAt: instantOf(payload.refund_confirmed_at, 'refund_confirmed_at'),
          },
          WORKER_MEMBERSHIP_ID,
        );
    }
  }

  private async record(tx: TenantTx, delivery: Delivery, result: PostingResult): Promise<void> {
    const paymentRequestId = uuidOf(delivery.payload.payment_request_id, 'payment_request_id');
    const correlationId = randomUUID();
    const entries = result.entries.map((entry) => ({ id: entry.id, entry_type: entry.type, amount_vnd: entry.amountVnd }));
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'capital_ledger.payment_posted',
      resourceType: RESOURCE_TYPE,
      resourceId: paymentRequestId,
      classification: 'CONFIDENTIAL',
      correlationId,
      requestId: randomUUID(),
      diff: { event_type: delivery.type, allocation_line_id: delivery.payload.allocation_line_id, entries },
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: paymentRequestId,
      aggregateVersion: 1,
      type: CAP_LEDGER_POSTED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: delivery.tenantId,
        payment_request_id: paymentRequestId,
        allocation_line_id: delivery.payload.allocation_line_id,
        source_event_type: delivery.type,
        entries,
        actor_id: WORKER_MEMBERSHIP_ID,
        occurred_at: new Date().toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${paymentRequestId}:${delivery.id}`,
      correlationId,
      causationId: delivery.id,
    });
  }
}
