import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { SCOPE_FROM } from './ctr-contract-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'retention_hold';

/** What one pass of the job did for a tenant. */
export interface RetentionDueResult {
  /** Reminders sent: one per hold, never twice. */
  reminded: number;
}

interface DueSql {
  id: string;
  contract_id: string;
  boq_item_id: string;
  release_condition: string;
  release_not_before: string;
  left_vnd: string;
  version: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
}

/**
 * The job `retention-due` (CTR 3.5, BR-CTR-09): on the morning the earliest day of a hold of retention comes, the people who hold the contract are reminded once that the money may be released if its
 * condition is met. The day is remembered on the hold (`due_notified_on`, which is not a change of the hold: its version stays), so a second pass the same day, or the next day, sends nothing. The
 * job releases nothing: a release is a decision of the chief accountant. The pass takes the clock as an argument, so a test turns it by hand.
 */
export class CtrRetentionDue {
  /** One pass for the tenant of the transaction. A hold that a command is acting on at that moment is left to the next pass. */
  async run(tx: TenantTx, now: Date): Promise<RetentionDueResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = (await tx.query<{ tenant_id: string }>(`select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id`))[0]?.tenant_id;
    if (tenantId === undefined) throw new Error('the job ran outside a tenant');
    const due = await tx.query<DueSql>(
      `select h.id, h.contract_id, h.boq_item_id, h.release_condition, h.release_not_before::text as release_not_before, (h.held_vnd - h.released_vnd)::text as left_vnd, h.version::text as version,
              c.project_id, ou.id as owner_unit_id, ou.path as owner_unit_path
         from machvon.retention_hold h join ${SCOPE_FROM} on c.tenant_id = h.tenant_id and c.id = h.contract_id
        where h.status in ('HELD', 'PARTIALLY_RELEASED') and h.release_not_before is not null and h.release_not_before <= $1::date and h.due_notified_on is null
        order by h.release_not_before, h.id
        for update of h skip locked`,
      [today],
    );
    for (const hold of due) {
      await tx.query('update machvon.retention_hold set due_notified_on = $2::date where id = $1::uuid', [hold.id, today]);
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: hold.id,
        aggregateVersion: Number(hold.version),
        type: 'ctr.retention.due.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          hold_id: hold.id,
          contract_id: hold.contract_id,
          boq_item_id: hold.boq_item_id,
          release_condition: hold.release_condition,
          release_not_before: hold.release_not_before,
          left_vnd: hold.left_vnd,
          occurred_at: now.toISOString(),
          notification: {
            resource: { type: RESOURCE_TYPE, id: hold.id, ownerUnitId: hold.owner_unit_id, ownerUnitPath: hold.owner_unit_path, projectId: hold.project_id, contractId: hold.contract_id },
            deepLink: `/ctr/ctr-21?contract=${hold.contract_id}`,
          },
        },
        eventKey: `${RESOURCE_TYPE}:${hold.id}:due`,
        correlationId,
      });
    }
    return { reminded: due.length };
  }
}
