import { randomUUID } from 'node:crypto';
import { AuditWriter, EgpMilestoneHook, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, EgpMilestoneResult, OutboxDelivery, TenantDatabase, TenantTx } from '@machvon/db';
import { NOOP_METRICS, asUuid, message } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const BID_EGP_MILESTONE_CONSUMER = 'bid-egp-milestone';
export const EGP_MAPPING_DECIDED_EVENT = 'bid.egp.mapping.decided.v1';
export const EGP_IMPORT_APPLIED_EVENT = 'bid.egp.import.applied.v1';
export const EGP_MILESTONE_FILLED_EVENT = 'bid.egp.milestone.filled.v1';
/** Dates the consumer met, by what became of them (`filled`, `same_day`, `kept_ours`, `order_refused`, `in_the_future`, `package_closed`). */
export const EGP_MILESTONE_METRIC = 'bid_egp_milestone_total';

const RESOURCE_TYPE = 'procurement_milestone';
const CLASSIFICATION = 'INTERNAL';

export interface EgpMilestoneConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'schemaVersion' | 'payload'>;

/**
 * The consumer of what the national procurement network said about a package (EGP-2, the hook EGP-1 left; `docs/egp-connector.md` section 12). `bid.egp.mapping.decided.v1` (an APPROVE of a mapping of a package, a
 * notice or a result) and `bid.egp.import.applied.v1` (a file of notices or of results was applied) make the dates held in `egp_record` the actual dates of the milestones of the package that a person approved the
 * mapping for, where it has none, and the workflow of the package completes the items those milestones carry (`EgpMilestoneHook`). The milestones are written for the person who acted (the approver or the loader),
 * never for a person who did not; the audit rows and events are the system's, in the transaction of the inbox row, so a delivery repeated after a crash adds nothing, and a second pass over the same records changes nothing.
 */
export class EgpMilestoneConsumer {
  private readonly hook = new EgpMilestoneHook();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: EgpMilestoneConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return BID_EGP_MILESTONE_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== EGP_MAPPING_DECIDED_EVENT && delivery.type !== EGP_IMPORT_APPLIED_EVENT) return 'ignored';
    if (delivery.schemaVersion !== 1) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const actor = asUuid(delivery.payload.actor_id);
    if (actor === undefined) return 'ignored';
    if (delivery.type === EGP_MAPPING_DECIDED_EVENT) {
      if (delivery.payload.decision !== 'APPROVE' || !['PACKAGE', 'NOTICE', 'RESULT'].includes(String(delivery.payload.subject_type))) return 'ignored';
      const mappingId = asUuid(delivery.payload.mapping_id);
      if (mappingId === undefined) return 'ignored';
      return consumeOnce(this.deps.database, delivery, BID_EGP_MILESTONE_CONSUMER, (tx) => this.fromMapping(tx, delivery, mappingId, actor), this.deps.security);
    }
    if (!['TBMT', 'RESULT'].includes(String(delivery.payload.kind))) return 'ignored';
    const importId = asUuid(delivery.payload.import_id);
    if (importId === undefined) return 'ignored';
    return consumeOnce(this.deps.database, delivery, BID_EGP_MILESTONE_CONSUMER, (tx) => this.fromImport(tx, delivery, importId, actor), this.deps.security);
  }

  private async fromMapping(tx: TenantTx, delivery: Delivery, mappingId: string, actor: string): Promise<void> {
    const found = await this.hook.packageOfMapping(tx, mappingId);
    if (found === undefined) return;
    await this.apply(tx, delivery, found.packageId, actor);
  }

  private async fromImport(tx: TenantTx, delivery: Delivery, importId: string, actor: string): Promise<void> {
    for (const packageId of await this.hook.packagesOfImport(tx, importId)) await this.apply(tx, delivery, packageId, actor);
  }

  private async apply(tx: TenantTx, delivery: Delivery, packageId: string, actor: string): Promise<void> {
    const done = await this.hook.applyToPackage(tx, packageId, actor, new Date());
    if (done !== undefined) await this.record(tx, delivery, done, actor);
  }

  private async record(tx: TenantTx, delivery: Delivery, done: EgpMilestoneResult, actor: string): Promise<void> {
    for (const fill of done.fills) {
      this.metrics.increment(EGP_MILESTONE_METRIC, { outcome: fill.outcome.toLowerCase() });
      if (fill.outcome !== 'FILLED' || fill.milestoneId === null) continue;
      const correlationId = randomUUID();
      const diff = { package_id: fill.packageId, package_code: fill.packageCode, milestone_kind: fill.kind, actual_at: fill.at, source: 'IMPORT', external_type: fill.externalType, external_code: fill.externalCode, import_id: fill.importId, event_id: delivery.id, acted_by: actor };
      await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
        action: 'bid.egp_milestone_filled',
        resourceType: RESOURCE_TYPE,
        resourceId: fill.milestoneId,
        classification: CLASSIFICATION,
        reason: message('bid.egp.milestone.reason'),
        diff,
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: fill.milestoneId,
        aggregateVersion: 1,
        type: EGP_MILESTONE_FILLED_EVENT,
        schemaVersion: 1,
        payload: { tenant_id: delivery.tenantId, ...diff, project_id: fill.projectId, items_completed: done.itemsCompleted, occurred_at: new Date().toISOString(), source_module: 'BID' },
        eventKey: `${RESOURCE_TYPE}:${fill.milestoneId}:egp-filled`,
        correlationId,
        causationId: delivery.id,
      });
    }
  }
}
