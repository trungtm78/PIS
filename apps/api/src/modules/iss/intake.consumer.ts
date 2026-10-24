import { randomUUID } from 'node:crypto';
import { AuditWriter, INTAKE_EVENT_TYPES, IssIntake, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox, readIntake } from '@machvon/db';
import type { ConsumeSecurity, IntakeOutcome, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { issueEventPayload } from './issue-event';

export const ISS_INTAKE_CONSUMER = 'iss-intake';
/** Events read and not acted on, by why: `not_wanted` (the event asks for no issue), `invalid` (not a well formed request), `project_unknown`. */
export const INTAKE_IGNORED_METRIC = 'iss_intake_ignored_total';
/** Issues opened by the intake, by source module. */
export const INTAKE_OPENED_METRIC = 'iss_intake_opened_total';
/** The second event for a source object that already has an issue that is not closed (BR-ISS-07), by source module: `iss_source_dedupe_total` of ISS 9. */
export const SOURCE_DEDUPE_METRIC = 'iss_source_dedupe_total';
/** Events whose reference could have been personal data, so the issue carries the start of the source id instead. */
export const INTAKE_REFERENCE_REPLACED_METRIC = 'iss_intake_reference_replaced_total';
const RESOURCE_TYPE = 'issue';
const CLASSIFICATION = 'INTERNAL';

export interface IssIntakeConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'schemaVersion' | 'payload' | 'correlationId'>;

/**
 * The system consumer of the events that ask ISS for an issue (ISS 3.1 step 8, ST-ISS-005): `ctr.guarantee.expired.v1` (when an advance is still owed),
 * `pmt.permit.expired.v1`, `pay.advance.overdue.v1`, `pay.reconciliation.overdue.v1`, `lnd.complaint.filed.v1` and `lnd.deadline.breached.v1`. Once per delivery
 * (the inbox row is written with the work), once per source object that has no issue yet (BR-ISS-07: the second event finds the first and changes nothing), and
 * without personal data: only ids and a reference code are read from the payload, and a reference that could be a person's data is replaced by the start of the source
 * id. The issue is opened in the name of the system, with its audit row and `iss.issue.opened.v1` in the same transaction.
 */
export class IssIntakeConsumer {
  private readonly intake = new IssIntake();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: IssIntakeConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  get name(): string {
    return ISS_INTAKE_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (!INTAKE_EVENT_TYPES.includes(delivery.type) || delivery.schemaVersion !== 1) return 'ignored';
    const reading = readIntake(delivery.type, delivery.payload);
    if (reading.kind !== 'REQUEST') {
      this.metrics.increment(INTAKE_IGNORED_METRIC, { reason: reading.kind === 'NOT_WANTED' ? 'not_wanted' : 'invalid' });
      return 'ignored';
    }
    const { request } = reading;
    let outcome: IntakeOutcome | undefined;
    const result = await consumeOnce(
      this.deps.database,
      delivery,
      ISS_INTAKE_CONSUMER,
      async (tx) => {
        const now = new Date();
        outcome = await this.intake.open(tx, request, delivery.id, WORKER_MEMBERSHIP_ID, now);
        if (outcome.kind !== 'OPENED') return;
        const { issue } = outcome;
        const correlationId = delivery.correlationId ?? randomUUID();
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'iss.issue_opened',
          resourceType: RESOURCE_TYPE,
          resourceId: issue.id,
          classification: CLASSIFICATION,
          diff: {
            code: issue.code,
            project_id: issue.projectId,
            owner_unit_id: issue.ownerUnitId,
            severity: issue.severity,
            source_module: issue.sourceModule,
            sla_policy_id: issue.policyId,
            response_due_at: issue.responseDueAt,
            due_at: issue.dueAt,
            geo_recorded: false,
            intake_event_type: delivery.type,
          },
          correlationId,
          requestId: randomUUID(),
        });
        await enqueueOutbox(tx, {
          aggregateType: RESOURCE_TYPE,
          aggregateId: issue.id,
          aggregateVersion: issue.version,
          type: 'iss.issue.opened.v1',
          schemaVersion: 1,
          payload: issueEventPayload({ tenant: { tenantId: delivery.tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 } }, issue, now, {
            response_due_at: issue.responseDueAt,
            sla_policy_id: issue.policyId,
            source_module: issue.sourceModule,
          }),
          eventKey: `${RESOURCE_TYPE}:${issue.id}:${issue.version}`,
          correlationId,
          causationId: delivery.id,
        });
      },
      this.deps.security,
    );
    // The inbox row and the issue are committed: now the telemetry counts what happened.
    if (result === 'duplicate' || outcome === undefined) return result;
    const done: IntakeOutcome = outcome;
    if (done.kind === 'OPENED') {
      this.metrics.increment(INTAKE_OPENED_METRIC, { source: request.spec.sourceModule });
      if (request.referenceReplaced) this.metrics.increment(INTAKE_REFERENCE_REPLACED_METRIC, { source: request.spec.sourceModule });
    } else if (done.kind === 'DUPLICATE') {
      this.metrics.increment(SOURCE_DEDUPE_METRIC, { source: request.spec.sourceModule });
    } else {
      this.metrics.increment(INTAKE_IGNORED_METRIC, { reason: 'project_unknown' });
    }
    return result;
  }
}
