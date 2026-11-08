import { randomUUID } from 'node:crypto';
import { compareDecimal, valueFloorVnd, vietnamDateOf } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { CONTRACT_ADJUSTMENT_RECORDED_EVENT, CONTRACT_ADJUSTMENT_RESOURCE, CtrAdjustmentStore } from './ctr-adjustment-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'contract_revision';
const CLASSIFICATION = 'INTERNAL';
/** The number of days a pending revision may be past its first day before it is told as overdue: one night's job missed is not yet a fault. */
const OVERDUE_DAYS = 1;

/** What one pass did for a tenant, and the figures the gauge of the job is made of. */
export interface RevisionPass {
  /** Revisions that took over in this pass. */
  activated: number;
  /** Revisions that are due and could not take over: the contract is not being performed, or the value is below what was accepted or paid. */
  blocked: number;
  /** Pending revisions more than a day past their first day after the pass: `ctr_revision_overdue`. */
  overdue: number;
}

interface DueSql {
  id: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  revision: number;
  amount_vnd: string;
  valid_from: string;
  change_request_id: string | null;
  accepted_total_vnd: string;
  advance_paid_vnd: string;
  paid_total_vnd: string;
  advance_recovered_vnd: string;
  allocation_line_id: string | null;
}

/** What putting a revision in force did. */
export interface RevisionTakeover {
  /** The revision that was in force and ends where the new one begins; null when none was. */
  supersededId: string | null;
  /** The value of the contract before the revision. */
  fromValueVnd: string;
  /** The version of the contract after it. */
  version: number;
}

/**
 * Puts a pending revision in force (CTR 3.3 step 5): the revision in force is superseded and ends where the new one begins, the new one is EFFECTIVE, and the value and the current revision
 * of the contract follow. The job `revision-effective` does it when the day of the revision comes; the retroactive adjustment (ST-CTR-016) does it in its own transaction, because the ledger it
 * adjusts is judged against the value the contract has after the change. The caller holds the lock of the contract.
 */
export async function putRevisionInForce(tx: TenantTx, revision: { contractId: string; revisionId: string; validFrom: string; amountVnd: string; actor: string }): Promise<RevisionTakeover> {
  const superseded = await tx.query<{ id: string }>(
    `update machvon.contract_revision set status = 'SUPERSEDED', valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1
      where contract_id = $1::uuid and status = 'EFFECTIVE' returning id`,
    [revision.contractId, revision.validFrom, revision.actor],
  );
  await tx.query("update machvon.contract_revision set status = 'EFFECTIVE', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [revision.revisionId, revision.actor]);
  const before = await tx.query<{ contract_value_vnd: string }>('select contract_value_vnd::text as contract_value_vnd from machvon.contract where id = $1::uuid', [revision.contractId]);
  const after = await tx.query<{ version: string }>(
    'update machvon.contract set contract_value_vnd = $2::numeric, current_revision_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
    [revision.contractId, revision.amountVnd, revision.revisionId, revision.actor],
  );
  // G1-18: the version that has just taken effect is an adjustment of the contract; what it did to the value and to the baseline of the project is written once, with the class the rule gives it.
  const adjustment = await new CtrAdjustmentStore().record(tx, { contractId: revision.contractId, revisionId: revision.revisionId, actor: revision.actor, now: new Date() });
  if (adjustment !== undefined) {
    await enqueueOutbox(tx, {
      aggregateType: CONTRACT_ADJUSTMENT_RESOURCE,
      aggregateId: adjustment.id,
      aggregateVersion: 1,
      type: CONTRACT_ADJUSTMENT_RECORDED_EVENT,
      schemaVersion: 1,
      payload: { contract_id: adjustment.contract.id, project_id: adjustment.project.id, revision: adjustment.revision, classification: adjustment.classification, review_status: adjustment.reviewStatus },
      eventKey: `${CONTRACT_ADJUSTMENT_RESOURCE}:${adjustment.id}:recorded`,
      correlationId: randomUUID(),
    });
  }
  return { supersededId: superseded[0]?.id ?? null, fromValueVnd: before[0]?.contract_value_vnd ?? '0', version: Number(after[0]?.version ?? '0') };
}

/**
 * The job `revision-effective` (CTR 3.3 step 5, BR-CTR-03): a revision that waits for its day (PENDING_EFFECTIVE) and whose first day has come takes over from the revision in force,
 * which is superseded and ends where the new one begins; the value and the current revision of the contract follow, and the capital is told the new value to commit
 * (`ctr.commitment.changed.v1`). Revisions take over one after the other in the order of their days, so a night that was missed is made good. A revision is not put in force while the
 * contract is not being performed, or while its value is below what was accepted or paid (the floor can have risen since the approval): it waits, is counted, and the gauge tells when it
 * is more than a day late. The pass takes the clock as an argument, so a test turns it by hand; it is idempotent for the same day.
 */
export class CtrRevisionEffective {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  /** One pass for the tenant of the transaction. A contract that a command is acting on at that moment is left to the next pass. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<RevisionPass> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = await this.tenantOf(tx);
    const result: RevisionPass = { activated: 0, blocked: 0, overdue: 0 };
    const due = await tx.query<DueSql>(
      `select r.id, r.contract_id, c.code as contract_code, c.status as contract_status, c.project_id, r.revision, r.amount_vnd::text as amount_vnd,
              r.valid_from::text as valid_from, r.change_request_id, c.accepted_total_vnd::text as accepted_total_vnd,
              c.advance_paid_vnd::text as advance_paid_vnd, c.paid_total_vnd::text as paid_total_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd,
              k.allocation_line_id
         from machvon.contract_revision r
         join machvon.contract c on c.tenant_id = r.tenant_id and c.id = r.contract_id
         left join machvon.procurement_package k on k.tenant_id = c.tenant_id and k.id = c.package_id
        where r.status = 'PENDING_EFFECTIVE' and r.valid_from <= $1::date
        order by c.id, r.valid_from, r.revision
        for update of r, c skip locked`,
      [today],
    );
    for (const revision of due) {
      if (this.blocks(revision)) {
        result.blocked += 1;
        continue;
      }
      await this.takeOver(tx, revision, { tenantId, actor, correlationId, now });
      result.activated += 1;
    }
    result.overdue = await this.overdue(tx, today);
    return result;
  }

  /** Whether the revision cannot take over now. */
  private blocks(revision: DueSql): boolean {
    if (revision.contract_status !== 'ACTIVE' && revision.contract_status !== 'SUSPENDED') return true;
    const floor = valueFloorVnd({
      acceptedTotalVnd: revision.accepted_total_vnd,
      advancePaidVnd: revision.advance_paid_vnd,
      paidTotalVnd: revision.paid_total_vnd,
      advanceRecoveredVnd: revision.advance_recovered_vnd,
    });
    return compareDecimal(revision.amount_vnd, floor) < 0;
  }

  private async takeOver(tx: TenantTx, revision: DueSql, pass: { tenantId: string; actor: string; correlationId: string; now: Date }): Promise<void> {
    const { actor } = pass;
    const { supersededId, fromValueVnd: fromValue, version } = await putRevisionInForce(tx, { contractId: revision.contract_id, revisionId: revision.id, validFrom: revision.valid_from, amountVnd: revision.amount_vnd, actor });
    await this.audit.recordInTx(tx, actor, {
      action: 'contract.revision_effective',
      resourceType: RESOURCE_TYPE,
      resourceId: revision.id,
      classification: CLASSIFICATION,
      diff: {
        contract_id: revision.contract_id,
        code: revision.contract_code,
        revision: revision.revision,
        valid_from: revision.valid_from,
        from_value_vnd: fromValue,
        to_value_vnd: revision.amount_vnd,
        superseded_id: supersededId,
        change_request_id: revision.change_request_id,
      },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    // The capital is told the value the contract now commits; the history of the revision is in the audit row above.
    await enqueueOutbox(tx, {
      aggregateType: 'contract',
      aggregateId: revision.contract_id,
      aggregateVersion: version,
      type: 'ctr.commitment.changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        contract_id: revision.contract_id,
        project_id: revision.project_id,
        allocation_line_id: revision.allocation_line_id,
        committed_vnd: revision.amount_vnd,
        previous_committed_vnd: fromValue,
        revision_id: revision.id,
        revision: revision.revision,
        version,
        occurred_at: pass.now.toISOString(),
      },
      eventKey: `contract:${revision.contract_id}:commitment:revision:${revision.id}`,
      correlationId: pass.correlationId,
    });
  }

  private async overdue(tx: TenantTx, today: string): Promise<number> {
    const rows = await tx.query<{ n: number }>("select count(*)::int as n from machvon.contract_revision where status = 'PENDING_EFFECTIVE' and valid_from < ($1::date - $2::int)", [today, OVERDUE_DAYS]);
    return rows[0]?.n ?? 0;
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ tenant_id: string }>(`select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id`);
    const id = rows[0]?.tenant_id;
    if (id === undefined) throw new Error('the job ran outside a tenant');
    return id;
  }
}
