import { randomUUID } from 'node:crypto';
import { AuditWriter, PLAN_PUBLISHED_EVENT, PRJ_STAGE_TRANSITION_METRIC, PrjStageStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox, stageChangeRecord } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, StageChange, TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';

export const PRJ_PLAN_PUBLISHED_CONSUMER = 'prj-plan-published';

export interface PlanPublishedConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
  /** The cache of the project bank of this process; the pages of the tenant are dropped when a project moved. */
  cache?: PipelineCache;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

const malformed = (): DomainError => new DomainError('VALIDATION_FAILED', 422, 'payload');

/** The identifiers of the event as lower-case canonical uuids; an event that does not carry them cannot be acted on and is not retried into success. */
function planOf(payload: Record<string, unknown>): { capitalPlanId: string; projectIds: string[] } {
  const capitalPlanId = asUuid(payload.capital_plan_id);
  if (capitalPlanId === undefined || !Array.isArray(payload.project_ids)) throw malformed();
  const projectIds = (payload.project_ids as unknown[]).map((candidate) => asUuid(candidate));
  if (projectIds.some((candidate) => candidate === undefined)) throw malformed();
  return { capitalPlanId, projectIds: [...new Set(projectIds as string[])].sort() };
}

/**
 * The system consumer of `capital.plan_published.v1` (ST-PRJ-002, PRJ 3.1 F3): a project of the pipeline that has a funded line in the
 * published plan becomes BUDGETED, once, whoever delivers the event and however often. The inbox row of the delivery is written with the
 * moves, so a redelivery after a crash is a counted duplicate; the moves leave their audit rows and `project.stage_changed.v1` events in the
 * same transaction, in the name of the system.
 */
export class PlanPublishedConsumer {
  private readonly stages = new PrjStageStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly cache: PipelineCache;

  constructor(private readonly deps: PlanPublishedConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.cache = deps.cache ?? SHARED_PIPELINE_CACHE;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== PLAN_PUBLISHED_EVENT) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const plan = planOf(delivery.payload);
    const moved: StageChange[] = [];
    const outcome = await consumeOnce(
      this.deps.database,
      delivery,
      PRJ_PLAN_PUBLISHED_CONSUMER,
      async (tx) => {
        const correlationId = randomUUID();
        const changes = await this.stages.budgetFromPublishedPlan(tx, { ...plan, eventId: delivery.id, actor: WORKER_MEMBERSHIP_ID });
        for (const change of changes) {
          const record = stageChangeRecord(change, delivery.tenantId, new Date());
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, { ...record.audit, correlationId, requestId: randomUUID() });
          await enqueueOutbox(tx, { ...record.event, correlationId, causationId: delivery.id });
        }
        moved.push(...changes);
      },
      this.deps.security,
    );
    // The inbox row and the moves are committed: now the telemetry counts them and the pages of the project bank are dropped.
    for (const change of moved) this.metrics.increment(PRJ_STAGE_TRANSITION_METRIC, { to: change.to });
    if (moved.length > 0) await this.cache.invalidate(delivery.tenantId);
    return outcome;
  }
}
