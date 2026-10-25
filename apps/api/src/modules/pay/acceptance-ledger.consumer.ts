import { randomUUID } from 'node:crypto';
import { AuditWriter, PayLedgerStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, LedgerOutcome, OutboxDelivery, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { SHARED_LEDGER_CACHE, ledgerCachePrefix } from './ledger-cache';
import type { LedgerCache } from './ledger-cache';

export const PAY_ACCEPTANCE_LEDGER_CONSUMER = 'pay-acceptance-ledger';
export const ACCEPTANCE_APPROVED_EVENT = 'ctr.acceptance.approved.v1';
export const ACCEPTANCE_REVOKED_EVENT = 'ctr.acceptance.revoked.v1';
/** The alert for a rule of the ledger that the database had to refuse: the checks of the store let something through. */
export const PAY_LEDGER_CHECK_ALERT = 'PAY_LEDGER_CHECK_VIOLATION';

const RESOURCE_TYPE = 'cumulative_ledger';
const CHECK_VIOLATION = '23514';

export interface AcceptanceLedgerConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
  /** The pages of the ledger this process keeps; the contract of an event is dropped from it. */
  cache?: LedgerCache;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

const malformed = (): DomainError => new DomainError('VALIDATION_FAILED', 422, 'payload');

/**
 * The system consumer of the approval and of the revocation of an acceptance (ST-PAY-001, PAY 3.1, BR-PAY-01): the approved acceptance is recognised on the cumulative ledger of its contract,
 * one entry for each item, and a revoked one is taken back by the opposite entries. Whoever delivers the event and however often, the ledger ends up the same: the state of the acceptance is
 * read under the lock of the contract (not the order of the events), the inbox row is written with the entries, and an acceptance is recognised once on each balance. The entries leave their
 * audit row and `pay.ledger.*` event in the same transaction, in the name of the system.
 */
export class AcceptanceLedgerConsumer {
  private readonly ledger: PayLedgerStore;
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly cache: LedgerCache;

  constructor(private readonly deps: AcceptanceLedgerConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.cache = deps.cache ?? SHARED_LEDGER_CACHE;
    this.ledger = new PayLedgerStore(this.metrics);
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    const approved = delivery.type === ACCEPTANCE_APPROVED_EVENT;
    const payEvent = delivery.type.startsWith('pay.');
    if (!approved && delivery.type !== ACCEPTANCE_REVOKED_EVENT && !payEvent) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const contractId = asUuid(delivery.payload.contract_id);
    // An event of PAY that does not say which contract it is about has nothing to drop from the cache.
    if (contractId === undefined && payEvent) return 'ignored';
    if (contractId === undefined) throw malformed();
    // A `pay.*` event about the contract (an entry of the ledger, a payment) means the pages kept for it may be out of date, whatever version they carry.
    if (payEvent) {
      const outcome = await consumeOnce(this.deps.database, delivery, PAY_ACCEPTANCE_LEDGER_CONSUMER, async () => undefined, this.deps.security);
      this.cache.deletePrefix(ledgerCachePrefix(delivery.tenantId, contractId.toLowerCase()));
      return outcome;
    }
    const acceptanceId = asUuid(delivery.payload.acceptance_id);
    if (acceptanceId === undefined) throw malformed();
    try {
      const result = await consumeOnce(
        this.deps.database,
        delivery,
        PAY_ACCEPTANCE_LEDGER_CONSUMER,
        async (tx) => {
          const input = { acceptanceId, requestId: delivery.id, actor: WORKER_MEMBERSHIP_ID };
          const outcome = approved ? await this.ledger.recognize(tx, input) : await this.ledger.revoke(tx, input);
          if (outcome.outcome === 'posted') await this.record(tx, delivery, { acceptanceId, contractId, approved, outcome });
        },
        this.deps.security,
      );
      this.cache.deletePrefix(ledgerCachePrefix(delivery.tenantId, contractId.toLowerCase()));
      return result;
    } catch (error) {
      // A rule of the ledger that only the database refused means the store let a wrong entry through: that is a defect to be found, not a delivery to be retried into silence.
      if ((error as { code?: string }).code === CHECK_VIOLATION) this.deps.security.alerts?.raise(PAY_LEDGER_CHECK_ALERT, { tenantId: delivery.tenantId, acceptanceId, eventType: delivery.type });
      throw error;
    }
  }

  private async record(
    tx: TenantTx,
    delivery: Delivery,
    done: { acceptanceId: string; contractId: string; approved: boolean; outcome: LedgerOutcome },
  ): Promise<void> {
    const correlationId = randomUUID();
    const action = done.approved ? 'ledger.acceptance_recognized' : 'ledger.acceptance_revoked';
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.contractId,
      classification: 'INTERNAL',
      correlationId,
      requestId: randomUUID(),
      diff: { acceptance_id: done.acceptanceId, entries: done.outcome.entries, accepted_vnd: done.outcome.acceptedVnd },
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.contractId,
      aggregateVersion: 1,
      type: done.approved ? 'pay.ledger.acceptance_recognized.v1' : 'pay.ledger.acceptance_revoked.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: delivery.tenantId,
        contract_id: done.contractId,
        acceptance_id: done.acceptanceId,
        entries: done.outcome.entries,
        accepted_vnd: done.outcome.acceptedVnd,
        actor_id: WORKER_MEMBERSHIP_ID,
        occurred_at: new Date().toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.contractId}:${action}:${done.acceptanceId}`,
      correlationId,
      causationId: delivery.id,
    });
  }
}
