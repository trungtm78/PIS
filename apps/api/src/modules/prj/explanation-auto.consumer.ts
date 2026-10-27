import { randomUUID } from 'node:crypto';
import { AuditWriter, PrjExplanationStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox, explanationRequestedRecord } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const PRJ_EXPLANATION_AUTO_CONSUMER = 'prj-explanation-auto';
/** The event of the DIS module that an early warning was opened (DIS section 9). */
const WARNING_OPENED_EVENT = 'warning.opened.v1';
const RESOURCE = 'explanation_request';
/** The most working days a rule may give to answer. */
const MAX_DUE_WORKING_DAYS = 30;

export interface ExplanationAutoConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  clock?: () => Date;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The job `prj.explanation-auto` (ST-PRJ-006, rule EW-02 and the others with `auto_explanation`): when a warning is opened by a rule that asks for an explanation by itself, one request goes to the leader in
 * charge of the project, due in three working days. The inbox row of the delivery is written with the request, and the warning has one request however often its event is delivered; a warning that is no
 * longer open, or a project with no leader in charge, is skipped and the audit row says why.
 */
export class ExplanationAutoConsumer {
  private readonly store = new PrjExplanationStore();
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;

  constructor(private readonly deps: ExplanationAutoConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== WARNING_OPENED_EVENT) return 'ignored';
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    if (delivery.payload.auto_explanation !== true) return 'ignored';
    const warningId = asUuid(delivery.payload.warning_id);
    if (warningId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    const now = this.clock();
    // What the rule asked for travels with the event: its days to answer (a whole number of working days, up to a month) and the moment the warning was opened.
    const days = delivery.payload.explanation_due_days;
    const dueWorkingDays = typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_DUE_WORKING_DAYS ? days : undefined;
    const opened = typeof delivery.payload.occurred_at === 'string' ? new Date(delivery.payload.occurred_at) : undefined;
    const eventAt = opened !== undefined && !Number.isNaN(opened.getTime()) ? opened : undefined;
    return consumeOnce(
      this.deps.database,
      delivery,
      PRJ_EXPLANATION_AUTO_CONSUMER,
      async (tx) => {
        const done = await this.store.requestForWarning(tx, warningId, WORKER_MEMBERSHIP_ID, now, { eventAt, dueWorkingDays });
        const correlationId = randomUUID();
        if (done.outcome === 'CREATED' && done.explanation !== undefined) {
          const record = explanationRequestedRecord({ row: done.explanation, previousStatus: null, warning: undefined }, delivery.tenantId, WORKER_MEMBERSHIP_ID, now);
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, { ...record.audit, diff: { ...record.audit.diff, auto: true, calendar: done.calendar ?? null, event_id: delivery.id }, correlationId, requestId: randomUUID() });
          await enqueueOutbox(tx, { ...record.event, correlationId });
          return;
        }
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'prj.explanation_auto_skipped',
          resourceType: RESOURCE,
          resourceId: done.explanation?.id ?? warningId,
          diff: { warning_id: warningId, outcome: done.outcome, reason: done.reason ?? null, event_id: delivery.id },
          correlationId,
          requestId: randomUUID(),
        });
      },
      this.deps.security,
    );
  }
}
