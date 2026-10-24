import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'permit_gate_waiver';
const CLASSIFICATION = 'INTERNAL';

/** What one pass of the job did for a tenant, and the figure the gauge `pmt_waiver_active` is made of. */
export interface WaiverExpiryResult {
  /** Waivers that became EXPIRED in this pass. */
  expired: number;
  /** The waivers still in force after the pass. */
  active: number;
}

interface DueSql {
  id: string;
  project_id: string;
  gate_code: string;
  permit_type_code: string | null;
  valid_until: string;
  version: string;
}

/**
 * The job `gate-waiver-expiry` (PMT 3.2 step 4): the day after its last day a waiver in force becomes EXPIRED, once, with an audit row and the event
 * `pmt.gate_waiver.expired.v1`. The gate itself did not wait for the job: the evaluation reads the last day, so a waiver that lapsed at midnight no
 * longer lets anything through even if the job has not run yet; the job stores what is already true. A waiver that a command is acting on at that
 * moment is left to the next pass. The pass takes the clock as an argument, so a test turns it by hand.
 */
export class PmtWaiverExpiry {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<WaiverExpiryResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = await this.tenantOf(tx);
    const due = await tx.query<DueSql>(
      `select id, project_id, gate_code, permit_type_code, valid_until::text as valid_until, version::text as version
         from machvon.permit_gate_waiver where status = 'ACTIVE' and valid_until < $1::date order by valid_until, id for update skip locked`,
      [today],
    );
    for (const waiver of due) {
      const version = Number(waiver.version) + 1;
      await tx.query("update machvon.permit_gate_waiver set status = 'EXPIRED', updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid", [waiver.id, actor, version]);
      await this.audit.recordInTx(tx, actor, {
        action: 'pmt.gate_waiver_expired',
        resourceType: RESOURCE_TYPE,
        resourceId: waiver.id,
        classification: CLASSIFICATION,
        diff: { project_id: waiver.project_id, gate_code: waiver.gate_code, permit_type_code: waiver.permit_type_code, from_status: 'ACTIVE', to_status: 'EXPIRED', valid_until: waiver.valid_until },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: waiver.id,
        aggregateVersion: version,
        type: 'pmt.gate_waiver.expired.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          gate_waiver_id: waiver.id,
          project_id: waiver.project_id,
          gate_code: waiver.gate_code,
          permit_type_code: waiver.permit_type_code,
          status: 'EXPIRED',
          valid_until: waiver.valid_until,
          occurred_at: now.toISOString(),
        },
        eventKey: `${RESOURCE_TYPE}:${waiver.id}:expired`,
        correlationId,
      });
    }
    const active = await tx.query<{ n: string }>("select count(*)::text as n from machvon.permit_gate_waiver where status = 'ACTIVE'");
    return { expired: due.length, active: Number(active[0]?.n ?? 0) };
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ tenant_id: string }>(`select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id`);
    const id = rows[0]?.tenant_id;
    if (id === undefined) throw new Error('the job ran outside a tenant');
    return id;
  }
}
