import { randomUUID } from 'node:crypto';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { CapReservationStore, RESERVATION_RESOURCE } from './cap-reservation-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The event that tells a reservation was closed and its capital returned: by a person (`RELEASED`) or by the job (`EXPIRED`). */
export const RESERVATION_RELEASED_EVENT = 'capital.reservation_released.v1';
export const RESERVATION_EXPIRED_METRIC = 'cap_reservation_expired_total';

export interface ReservationExpirySummary {
  expired: number;
}

/**
 * The job `capital.reservation-expiry` (ST-CAP-011, CAP 3.1 F4, UAT-AC227), every fifteen minutes: a reservation still ACTIVE whose last instant has passed becomes EXPIRED and its capital returns to the line with one RELEASE
 * entry. The pass takes only what is due and not locked by a person releasing it, closes each reservation under its own lock and leaves the rest as it is, so running it twice (or two at once) writes one entry and announces
 * one event for each reservation.
 */
export class CapReservationExpiryJob {
  private readonly reservations = new CapReservationStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<ReservationExpirySummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    // A backlog (an outage of the worker, a burst of reservations that run out together) is closed in the one pass, under the locks of all its balances taken together.
    const closed = await this.reservations.expireDue(tx, now, actor);
    for (const reservation of closed) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'capital.reservation_expired',
        resourceType: RESERVATION_RESOURCE,
        resourceId: reservation.id,
        reason: reservation.reason,
        diff: { allocation_line_id: reservation.allocationLineId, project_id: reservation.projectId, amount_vnd: reservation.amountVnd, ledger_entry_id: reservation.entryId },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: RESERVATION_RESOURCE,
        aggregateId: reservation.id,
        aggregateVersion: reservation.version,
        type: RESERVATION_RELEASED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          reservation_id: reservation.id,
          allocation_line_id: reservation.allocationLineId,
          appropriation_id: reservation.appropriationId,
          project_id: reservation.projectId,
          plan_year: reservation.planYear,
          actor_id: actor,
          occurred_at: now.toISOString(),
          amount_vnd: reservation.amountVnd,
          status: reservation.status,
          reason: reservation.reason,
          ledger_entry_id: reservation.entryId,
        },
        eventKey: `${RESERVATION_RESOURCE}:${reservation.id}:closed`,
        correlationId,
      });
      this.metrics.increment(RESERVATION_EXPIRED_METRIC);
    }
    return { expired: closed.length };
  }
}
