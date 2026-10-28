import { randomUUID } from 'node:crypto';
import { DocIncomingStore, WORKER_MEMBERSHIP_ID, WorkCalendarStore, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { AuditWriter, IncomingRecord, TenantTx } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf, workingDaysLate } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { PERMISSIONS } from '@machvon/contracts';
import { calendarFor } from './incoming.controller';
import { mayActOnUnit } from './unit-scope';

export const INCOMING_OVERDUE_METRIC = 'doc_incoming_overdue_total';
const RESOURCE_TYPE = 'incoming_document';
// The notification consumer asks for the right `${type}.read` over the resource: the right to read incoming letters is `doc.incoming.read`.
const NOTIFICATION_RESOURCE = 'doc.incoming';

export interface IncomingJobDeps {
  store?: DocIncomingStore;
  calendars?: WorkCalendarStore;
  audit?: AuditWriter;
  metrics?: MetricsSink;
}

/**
 * The hourly job `doc.incoming-overdue` (DOC.md F10, BR-DOC-18) for the tenant of the transaction: a letter that is assigned or being processed and whose deadline passed on a working day (by the work calendar of the tenant, and
 * by the weekdays where no calendar is published) is marked overdue, once, and `doc.incoming_overdue.v1` goes to NOT with the days it is late. A letter already marked, one without a deadline and one in time are left as they are, so
 * that running the job again, or every hour, announces nothing twice. Returns the letters that became overdue now.
 */
export async function markOverdueIncoming(tx: TenantTx, tenantId: string, now: Date, deps: IncomingJobDeps = {}): Promise<IncomingRecord[]> {
  const store = deps.store ?? new DocIncomingStore();
  const calendars = deps.calendars ?? new WorkCalendarStore();
  const audit = deps.audit;
  const today = vietnamDateOf(now);
  const oldest = await store.oldestOpenDue(tx);
  const source = await calendarFor(calendars, tx, now, [oldest ?? null]);
  const marked = await store.markOverdue(tx, today, WORKER_MEMBERSHIP_ID, (dueOn) => workingDaysLate(dueOn, today, source) > 0);
  for (const letter of marked) {
    const lateDays = workingDaysLate(letter.dueOn as string, today, source);
    // The reminder goes to the handler, by every membership they hold; a letter given to a unit with no one named goes to the memberships that may work letters in that unit.
    const recipients = letter.assigneeUserId === null ? await processorsOf(tx, store, letter, now) : await store.membershipsOf(tx, letter.assigneeUserId);
    const correlationId = randomUUID();
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: letter.id,
      aggregateVersion: letter.version,
      type: 'doc.incoming_overdue.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: tenantId,
        document_id: letter.documentId,
        incoming_document_id: letter.id,
        version: letter.version,
        status: letter.status,
        due_on: letter.dueOn,
        late_days: lateDays,
        assigned_unit_id: letter.assignedUnitId,
        assignee_user_id: letter.assigneeUserId,
        actor_id: WORKER_MEMBERSHIP_ID,
        occurred_at: now.toISOString(),
        notification: {
          resource: { type: NOTIFICATION_RESOURCE, id: letter.id, ownerUnitId: letter.assignedUnitId, ownerUnitPath: letter.assignedUnitPath },
          deepLink: `/doc/doc-13?id=${letter.id}`,
          ...(recipients.length === 0 ? {} : { recipients }),
        },
      },
      // One per episode: marking bumps the version, and a reassignment clears the mark so that the new deadline can be announced again.
      eventKey: `${RESOURCE_TYPE}:${letter.id}:overdue:${letter.version}`,
      correlationId,
    });
    await audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'incoming_document.overdue',
      resourceType: RESOURCE_TYPE,
      resourceId: letter.id,
      classification: 'INTERNAL',
      diff: { due_on: letter.dueOn, late_days: lateDays, status: letter.status },
      correlationId,
      requestId: correlationId,
    });
    (deps.metrics ?? NOOP_METRICS).increment(INCOMING_OVERDUE_METRIC);
  }
  return marked;
}

/** The active memberships that hold the right to work letters over the unit a letter was given to. */
async function processorsOf(tx: TenantTx, store: DocIncomingStore, letter: IncomingRecord, now: Date): Promise<string[]> {
  if (letter.assignedUnitId === null || letter.assignedUnitPath === null) return [];
  const unit = { id: letter.assignedUnitId, path: letter.assignedUnitPath };
  const found: string[] = [];
  for (const membershipId of await store.activeMemberships(tx)) {
    const access = await loadAccessIn(tx, membershipId);
    if (access.membershipActive && mayActOnUnit(access, PERMISSIONS.startIncomingDocumentProcessing, unit, now)) found.push(membershipId);
  }
  return found;
}
