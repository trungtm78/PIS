import { randomUUID } from 'node:crypto';
import { AudRecoveryStore, AuditWriter, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, PayOutcome, TenantDatabase, TenantTx } from '@machvon/db';
import { NOOP_METRICS, asUuid, readRecordedRecovery, readReversedRecovery } from '@machvon/kernel';
import type { MetricsSink, PayRecoveryFacts } from '@machvon/kernel';

export const AUD_PAY_RECOVERY_CONSUMER = 'aud-pay-recovery';
export const PAY_RECOVERY_RECORDED_EVENT = 'pay.recovery.recorded.v1';
export const PAY_RECOVERY_REVERSED_EVENT = 'pay.recovery.reversed.v1';
/** Postings of the consumer, by the event and what became of it (`linked`, `reversed`, `duplicate`, `ignored`, `exception`). */
export const AUD_RECOVERY_POSTING_METRIC = 'aud_pay_recovery_total';
/** The alert for a recommendation that went back to work because a recovery of PAY was reversed. */
export const AUD_REOPENED_ALERT = 'AUD_RECOMMENDATION_REOPENED';

const RESOURCE_TYPE = 'audit_recovery_link';
const RECOMMENDATION_TYPE = 'audit_recommendation';
const CLASSIFICATION = 'CONFIDENTIAL';

export interface PayRecoveryConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'schemaVersion' | 'payload'>;

/**
 * The system consumer of the recoveries PAY reports (ST-AUD-004, AUD 3.4): `pay.recovery.recorded.v1` puts a line in the ledger of the recommendation it names, and `pay.recovery.reversed.v1`
 * puts a line of the opposite sign against it, taking a recommendation that was closed back to work when it is no longer recovered in full. What the ledger cannot take (more than was recommended,
 * a reversal of what was never linked, a recommendation that takes no money) is kept as an exception for the accountant and changes no figure. The lines, the audit row and the events are written
 * in the transaction of the inbox row, in the name of the system, so a delivery repeated after a crash adds nothing; a recovery delivered twice, or reported under two events, is linked once.
 */
export class PayRecoveryConsumer {
  private readonly store = new AudRecoveryStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: PayRecoveryConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return AUD_PAY_RECOVERY_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== PAY_RECOVERY_RECORDED_EVENT && delivery.type !== PAY_RECOVERY_REVERSED_EVENT) return 'ignored';
    if (delivery.schemaVersion !== 1) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const recorded = delivery.type === PAY_RECOVERY_RECORDED_EVENT;
    const facts = recorded ? readRecordedRecovery(delivery.payload) : readReversedRecovery(delivery.payload);
    return consumeOnce(
      this.deps.database,
      delivery,
      AUD_PAY_RECOVERY_CONSUMER,
      async (tx) => {
        const result = recorded ? await this.store.applyPayRecovery(tx, facts, delivery.id, WORKER_MEMBERSHIP_ID) : await this.store.applyPayReversal(tx, facts, delivery.id, WORKER_MEMBERSHIP_ID);
        this.metrics.increment(AUD_RECOVERY_POSTING_METRIC, { event: delivery.type, outcome: result.outcome });
        await this.record(tx, delivery, facts, result);
      },
      this.deps.security,
    );
  }

  private async record(tx: TenantTx, delivery: Delivery, facts: PayRecoveryFacts, result: PayOutcome): Promise<void> {
    if (result.outcome === 'duplicate' || result.outcome === 'ignored') return;
    const correlationId = randomUUID();
    const common = { tenant_id: delivery.tenantId, recommendation_id: facts.recommendationId, recovery_id: facts.recoveryId, source_kind: facts.sourceKind, amount_vnd: facts.amountVnd, recorded_on: facts.day };
    if (result.outcome === 'exception') {
      await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
        action: 'aud.recovery_exception_kept',
        resourceType: RECOMMENDATION_TYPE,
        resourceId: facts.recommendationId,
        classification: CLASSIFICATION,
        diff: { ...common, kind: result.kind, event_id: delivery.id },
        correlationId,
        requestId: randomUUID(),
      });
      return;
    }
    const linked = result.outcome === 'linked';
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: linked ? 'aud.recovery_linked' : 'aud.recovery_reversed',
      resourceType: RESOURCE_TYPE,
      resourceId: result.linkId,
      classification: CLASSIFICATION,
      diff: { ...common, event_id: delivery.id, recovered_vnd: result.recoveredVnd, reopened: result.reopened },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: result.linkId,
      aggregateVersion: 1,
      type: linked ? 'aud.recovery.linked.v1' : 'aud.recovery.reversed.v1',
      schemaVersion: 1,
      payload: { ...common, link_id: result.linkId, recovered_vnd: result.recoveredVnd, occurred_at: new Date().toISOString(), source_module: 'AUD' },
      eventKey: `${RESOURCE_TYPE}:${result.linkId}:${linked ? 'linked' : 'reversed'}`,
      correlationId,
      causationId: delivery.id,
    });
    if (!result.reopened) return;
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'aud.recommendation_reopened',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: facts.recommendationId,
      classification: CLASSIFICATION,
      diff: { recovery_id: facts.recoveryId, recovered_vnd: result.recoveredVnd, from_status: 'CLOSED', to_status: 'IN_PROGRESS' },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: facts.recommendationId,
      aggregateVersion: 1,
      type: 'aud.recommendation.reopened.v1',
      schemaVersion: 1,
      payload: { tenant_id: delivery.tenantId, recommendation_id: facts.recommendationId, recovery_id: facts.recoveryId, recovered_vnd: result.recoveredVnd, occurred_at: new Date().toISOString(), source_module: 'AUD' },
      eventKey: `${RECOMMENDATION_TYPE}:${facts.recommendationId}:reopened:${result.linkId}`,
      correlationId,
      causationId: delivery.id,
    });
    this.deps.security.alerts?.raise(AUD_REOPENED_ALERT, { tenantId: delivery.tenantId, recommendationId: facts.recommendationId, eventId: delivery.id });
  }
}
