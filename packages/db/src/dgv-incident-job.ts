import { randomUUID } from 'node:crypto';
import type { AuditWriter } from './audit-writer.ts';
import { DgvIncidentStore } from './dgv-incident-store.ts';
import type { IncidentRecord } from './dgv-incident-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const INCIDENT_SLA_BREACHED_EVENT = 'dgv.incident.sla_breached.v1';
export const EXCEPTION_REOPENED_EVENT = 'dgv.exception.reopened.v1';
export const INCIDENT_SLA_BREACHED_METRIC = 'dgv_incident_sla_breached_total';
export const EXCEPTION_REOPENED_METRIC = 'dgv_exception_reopened_total';
const INCIDENT_RESOURCE = 'quality_incident';
const EXCEPTION_RESOURCE = 'quality_exception';

export interface DgvSweepSummary {
  breached: number;
  reopened: number;
}

/**
 * The sweep of the quality incidents of a tenant (DGV.md F4, BR-DGV-05, BR-DGV-06): an incident that is not resolved and is past its due time is marked, once, and its owner is told (the SLA is broken and the matter goes up);
 * a waiver that has ended is followed by a new OPEN exception that points at it, the closed incident behind it is reopened and its handler told. Running it again, or every few minutes, announces nothing twice.
 */
export class DgvIncidentSweepJob {
  private readonly store = new DgvIncidentStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<DgvSweepSummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const result = await this.store.sweep(tx, now, actor);
    for (const incident of result.breached) await this.announceBreach(tx, tenantId, incident, actor, now);
    for (const entry of result.reopened) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'dgv.quality_exception_reopened',
        resourceType: EXCEPTION_RESOURCE,
        resourceId: entry.exceptionId,
        reason: 'waiver_expired',
        diff: { reopened_from_id: entry.reopenedFromId, incident_id: entry.incidentId },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: EXCEPTION_RESOURCE,
        aggregateId: entry.exceptionId,
        aggregateVersion: 1,
        type: EXCEPTION_REOPENED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          exception_id: entry.exceptionId,
          reopened_from_id: entry.reopenedFromId,
          incident_id: entry.incidentId,
          occurred_at: now.toISOString(),
          // The handler of the incident is told; an exception with no incident, or none handled, has nobody to tell.
          notification: {
            resource: { type: INCIDENT_RESOURCE, id: entry.incidentId ?? entry.exceptionId },
            deepLink: `/dgv/dgv-08?incident=${entry.incidentId ?? ''}`,
            ...(entry.incident?.assigneeId == null ? {} : { recipients: [entry.incident.assigneeId] }),
          },
        },
        eventKey: `${EXCEPTION_RESOURCE}:${entry.exceptionId}:reopened`,
        correlationId,
      });
      this.metrics.increment(EXCEPTION_REOPENED_METRIC);
    }
    return { breached: result.breached.length, reopened: result.reopened.length };
  }

  private async announceBreach(tx: TenantTx, tenantId: string, incident: IncidentRecord, actor: string, now: Date): Promise<void> {
    const correlationId = randomUUID();
    await this.audit.recordInTx(tx, actor, {
      action: 'dgv.quality_incident_sla_breached',
      resourceType: INCIDENT_RESOURCE,
      resourceId: incident.id,
      diff: { dataset_id: incident.datasetId, severity: incident.severity, due_at: incident.dueAt, status: incident.status },
      correlationId,
      requestId: correlationId,
    });
    await enqueueOutbox(tx, {
      aggregateType: INCIDENT_RESOURCE,
      aggregateId: incident.id,
      aggregateVersion: incident.version,
      type: INCIDENT_SLA_BREACHED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: tenantId,
        incident_id: incident.id,
        dataset_id: incident.datasetId,
        severity: incident.severity,
        due_at: incident.dueAt,
        status: incident.status,
        occurred_at: now.toISOString(),
        // The matter goes up to the owner of the dataset, and the handler is reminded too.
        notification: {
          resource: { type: INCIDENT_RESOURCE, id: incident.id },
          deepLink: `/dgv/dgv-08?incident=${incident.id}`,
          recipients: [...new Set([incident.ownerId, ...(incident.assigneeId === null ? [] : [incident.assigneeId])])],
        },
      },
      // One per time it is late: a new due time (a reassignment, a reopening) can break the SLA again.
      eventKey: `${INCIDENT_RESOURCE}:${incident.id}:sla_breached:${incident.version}`,
      correlationId,
    });
    this.metrics.increment(INCIDENT_SLA_BREACHED_METRIC);
  }
}
