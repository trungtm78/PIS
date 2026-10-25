import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'procurement_petition';
const PACKAGE_RESOURCE_TYPE = 'procurement_package';
const CLASSIFICATION = 'INTERNAL';
const DAY_MS = 86_400_000;

/** What one pass of the job did for a tenant, and the figure the gauge of the job is made of. */
export interface PetitionDueResult {
  /** Reminders sent in this pass: one for each petition, the first time it is found overdue. */
  reminded: number;
  /** The petitions that wait for an answer past the last day of their deadline now (after the pass): `bid_petition_overdue`. */
  overdue: number;
}

interface OverdueSql {
  id: string;
  package_id: string;
  petition_kind: string;
  due_on: string;
  overdue_notified_at: string | null;
  version: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
}

/**
 * The job `petition-due` (BID 3 F7, BR-BID-14): a petition that waits for an answer past the last day of its deadline is overdue (the screen and the list read this from the clock); the
 * first pass that finds it overdue sends one reminder to the people who handle the petitions of its package and writes an audit row, remembered in `overdue_notified_at` so a second
 * pass sends nothing. The job never answers a petition and never moves the deadline. The pass takes the clock as an argument, so a test turns it by hand; it is idempotent for the same day.
 */
export class BidPetitionDue {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  /** One pass for the tenant of the transaction. A petition that a command is acting on at that moment is left to the next pass. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<PetitionDueResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = (await tx.query<{ tenant_id: string }>(`select nullif(current_setting('app.tenant_id', true), '')::uuid as tenant_id`))[0]?.tenant_id ?? '';
    const due = await tx.query<OverdueSql>(
      `select t.id, t.package_id, t.petition_kind, t.due_on::text as due_on, t.overdue_notified_at::text as overdue_notified_at, t.version::text as version,
              p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_petition t on t.tenant_id = k.tenant_id and t.package_id = k.id
        where t.status in ('RECEIVED', 'PROCESSING') and t.due_on < $1::date
        order by t.due_on, t.id
        for update of t skip locked`,
      [today],
    );
    let reminded = 0;
    for (const petition of due) {
      if (petition.overdue_notified_at !== null) continue;
      await this.remind(tx, petition, { tenantId, actor, correlationId, today, now });
      reminded += 1;
    }
    return { reminded, overdue: due.length };
  }

  private async remind(tx: TenantTx, petition: OverdueSql, pass: { tenantId: string; actor: string; correlationId: string; today: string; now: Date }): Promise<void> {
    // A reminder is not a change of the petition: its version stays, so an answer written from a screen read this morning is not turned away by it.
    await tx.query('update machvon.procurement_petition set overdue_notified_at = $2::timestamptz where id = $1::uuid', [petition.id, pass.now.toISOString()]);
    const daysOverdue = Math.max(1, Math.round((Date.parse(`${pass.today}T00:00:00Z`) - Date.parse(`${petition.due_on}T00:00:00Z`)) / DAY_MS));
    await this.audit.recordInTx(tx, pass.actor, {
      action: 'petition.overdue',
      resourceType: RESOURCE_TYPE,
      resourceId: petition.id,
      classification: CLASSIFICATION,
      diff: { package_id: petition.package_id, petition_kind: petition.petition_kind, due_on: petition.due_on, days_overdue: daysOverdue },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: petition.id,
      aggregateVersion: Number(petition.version),
      type: 'bid.petition.overdue.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        petition_id: petition.id,
        package_id: petition.package_id,
        petition_kind: petition.petition_kind,
        due_on: petition.due_on,
        days_overdue: daysOverdue,
        occurred_at: pass.now.toISOString(),
        notification: {
          resource: { type: PACKAGE_RESOURCE_TYPE, id: petition.package_id, ownerUnitId: petition.owner_unit_id, ownerUnitPath: petition.owner_unit_path, projectId: petition.project_id },
          deepLink: `/bid/bid-20?package=${petition.package_id}`,
        },
      },
      eventKey: `${RESOURCE_TYPE}:${petition.id}:overdue`,
      correlationId: pass.correlationId,
    });
  }
}
