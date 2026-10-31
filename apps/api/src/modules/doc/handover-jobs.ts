import { randomUUID } from 'node:crypto';
import { DocDossierStore, WORKER_MEMBERSHIP_ID, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { AuditWriter, TenantTx } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { PERMISSIONS } from '@machvon/contracts';
import { mayActOnUnit } from './unit-scope';

export const HANDOVER_DUE_METRIC = 'doc_handover_due_total';
const RESOURCE_TYPE = 'dossier';
// The notification consumer asks for the right `${type}.read` over the resource: the right to read dossiers is `doc.dossier.read`.
const NOTIFICATION_RESOURCE = 'doc.dossier';

export interface HandoverJobDeps {
  store?: DocDossierStore;
  audit?: AuditWriter;
  metrics?: MetricsSink;
}

export interface HandoverReminder {
  dossierId: string;
  daysLeft: number;
  stage: 30 | 7 | 1;
}

/**
 * The hourly job `doc.handover-due` (DOC.md F11) for the tenant of the transaction: the archivists of the unit of a closed dossier whose handover falls due are reminded 30, 7 and 1 days ahead, once for each stage (the day
 * that has passed counts as the last stage), by `doc.handover_due.v1` to NOT. The stage that was sent is kept on the dossier, so running the job again, or every hour, announces nothing twice, and a dossier that was handed
 * over is left alone. The version of the dossier does not move. Returns the reminders sent now.
 */
export async function remindHandoverDue(tx: TenantTx, tenantId: string, now: Date, deps: HandoverJobDeps = {}): Promise<HandoverReminder[]> {
  const store = deps.store ?? new DocDossierStore();
  const due = await store.dueForHandoverReminder(tx, vietnamDateOf(now));
  if (due.length === 0) return [];
  const members = await store.activeMemberships(tx);
  // One after the other: the queries of a transaction share a connection.
  const accesses: Array<{ membershipId: string; access: Awaited<ReturnType<typeof loadAccessIn>> }> = [];
  for (const membershipId of members) accesses.push({ membershipId, access: await loadAccessIn(tx, membershipId) });
  const sent: HandoverReminder[] = [];
  for (const { record, daysLeft, stage } of due) {
    const unit = { id: record.organizationUnitId, path: record.unitPath };
    // The reminder goes to the memberships that may hand a dossier over in the unit; with none, the event is still recorded, for the audit and for the metrics.
    const recipients = accesses.filter(({ access }) => access.membershipActive && mayActOnUnit(access, PERMISSIONS.handoverDossierToArchive, unit, now)).map(({ membershipId }) => membershipId);
    await store.markHandoverReminded(tx, record.id, stage);
    const correlationId = randomUUID();
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: record.id,
      aggregateVersion: record.version,
      type: 'doc.handover_due.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: tenantId,
        dossier_id: record.id,
        dossier_code: record.dossierCode,
        version: record.version,
        handover_due_on: record.handoverDueOn,
        days_left: daysLeft,
        stage,
        organization_unit_id: record.organizationUnitId,
        actor_id: WORKER_MEMBERSHIP_ID,
        occurred_at: now.toISOString(),
        notification: {
          resource: { type: NOTIFICATION_RESOURCE, id: record.id, ownerUnitId: record.organizationUnitId, ownerUnitPath: record.unitPath },
          deepLink: `/doc/doc-17?id=${record.id}`,
          ...(recipients.length === 0 ? {} : { recipients }),
        },
      },
      // One per stage: the stage only gets smaller, so a stage is announced once.
      eventKey: `${RESOURCE_TYPE}:${record.id}:handover-due:${stage}`,
      correlationId,
    });
    await deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'dossier.handover_due',
      resourceType: RESOURCE_TYPE,
      resourceId: record.id,
      classification: 'INTERNAL',
      diff: { handover_due_on: record.handoverDueOn, days_left: daysLeft, stage },
      correlationId,
      requestId: correlationId,
    });
    (deps.metrics ?? NOOP_METRICS).increment(HANDOVER_DUE_METRIC);
    sent.push({ dossierId: record.id, daysLeft, stage });
  }
  return sent;
}
