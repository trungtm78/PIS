import { randomUUID } from 'node:crypto';
import { AuditWriter, DisRegistrationStore, WORKER_MEMBERSHIP_ID, consumeOnce } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const DIS_REGISTRATION_CONSUMER = 'dis-registration';
/** The event of the DIS module that a report was accepted (DIS section 9). */
const REPORT_ACCEPTED_EVENT = 'report.accepted.v1';
const SCHEDULE_RESOURCE = 'disbursement_schedule_line';

export interface RegistrationConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The job `dis.registration` (ST-DIS-004, ST-DIS-017, CAP task TK-CAP-009-2): when a report is accepted, the registration for next month that its cells carry becomes the REGISTERED rows of the month after the
 * period, a new revision of each key. The inbox row of the delivery is written with the registration, so a redelivery after a crash is a counted duplicate; a report that is no longer the accepted one registers
 * nothing. The audit row names the month and the amounts that changed, never a person.
 */
export class RegistrationConsumer {
  private readonly registrations = new DisRegistrationStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: RegistrationConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== REPORT_ACCEPTED_EVENT) return 'ignored';
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const reportId = asUuid(delivery.payload.report_id);
    if (reportId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      DIS_REGISTRATION_CONSUMER,
      async (tx) => {
        const done = await this.registrations.registerFromAcceptedReport(tx, reportId, WORKER_MEMBERSHIP_ID, new Date());
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'dis.registration_made',
          resourceType: SCHEDULE_RESOURCE,
          resourceId: reportId,
          diff: {
            report_id: reportId,
            month: done.month,
            skipped: done.skipped ?? null,
            superseded: done.superseded,
            registered: done.registered.map((row) => ({ bucket: row.bucket, budget_level: row.budgetLevel, revision: row.revision, amount_vnd: row.amountVnd, previous_amount_vnd: row.previousAmountVnd })),
            event_id: delivery.id,
          },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      },
      this.deps.security,
    );
  }
}
