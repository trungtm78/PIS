import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import { ALERT_THRESHOLDS, thresholdFor } from './ctr-guarantee-store.ts';
import type { AlertThreshold, GuaranteeKind } from './ctr-guarantee-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The first day (counting back from the expiry) on which the holders of a contract are told. */
const FIRST_ALERT_DAYS = 30;
const VIETNAM_DATE = `(g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date`;
const RESOURCE_TYPE = 'guarantee';
const CLASSIFICATION = 'INTERNAL';

/** What one pass of the job did for a tenant, and the figures the gauges of the job are made of. */
export interface ExpiryResult {
  /** Reminders sent: one per guarantee and threshold, never twice. */
  alerted: number;
  /** Guarantees that became EXPIRED in this pass. */
  expired: number;
  /** The ACTIVE guarantees that are within each threshold of their expiry now (after the pass): `ctr_guarantee_expiring{days}`. */
  expiring: Record<AlertThreshold, number>;
  /** ADVANCE guarantees within 30 days of the expiry while the contract still owes an advance: `ctr_advance_guarantee_at_risk`. */
  advanceAtRisk: number;
}

interface DueSql {
  id: string;
  contract_id: string;
  kind: GuaranteeKind;
  amount_vnd: string;
  expires_at: string;
  expires_on: string;
  days_left: number;
  last_alert_days: AlertThreshold | null;
  version: string;
  advance_outstanding_vnd: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
}

const EMPTY: Record<AlertThreshold, number> = { 0: 0, 7: 0, 15: 0, 30: 0 };

/**
 * The job `guarantee-expiry` (CTR 3.5, BR-CTR-10): every ACTIVE guarantee that is 30, 15, 7 or 0 days from its expiry (counted in calendar
 * days in Vietnam) gets one reminder per threshold, remembered in `last_alert_days` so a second pass the same day sends nothing; the day after
 * the expiry it becomes EXPIRED, once, with the event that the issue intake of ISS answers by opening one issue. A guarantee is never
 * renewed or extended by the job. The pass takes the clock as an argument, so a test turns it by hand; it is idempotent for the same day.
 */
export class CtrGuaranteeExpiry {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  /** One pass for the tenant of the transaction. A guarantee that a command is acting on at that moment is left to the next pass. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<ExpiryResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = await this.tenantOf(tx);
    const result: ExpiryResult = { alerted: 0, expired: 0, expiring: { ...EMPTY }, advanceAtRisk: 0 };
    const due = await tx.query<DueSql>(
      `select g.id, g.contract_id, g.kind, g.amount_vnd::text as amount_vnd, ${TIMESTAMP('g.expires_at')} as expires_at, ${VIETNAM_DATE}::text as expires_on,
              (${VIETNAM_DATE} - $1::date) as days_left, g.last_alert_days, g.version::text as version, c.advance_outstanding_vnd::text as advance_outstanding_vnd,
              p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path
         from machvon.guarantee g join ${SCOPE_FROM} on c.tenant_id = g.tenant_id and c.id = g.contract_id
        where g.status = 'ACTIVE' and (${VIETNAM_DATE} - $1::date) <= $2::int
        order by g.expires_at, g.id
        for update of g skip locked`,
      [today, FIRST_ALERT_DAYS],
    );
    for (const guarantee of due) {
      if (guarantee.days_left < 0) {
        await this.expire(tx, guarantee, { tenantId, actor, correlationId, now });
        result.expired += 1;
        continue;
      }
      const threshold = thresholdFor(guarantee.days_left);
      if (threshold === undefined) continue;
      if (guarantee.last_alert_days === null || threshold < guarantee.last_alert_days) {
        await this.alert(tx, guarantee, threshold, { tenantId, correlationId, now });
        result.alerted += 1;
      }
      for (const level of ALERT_THRESHOLDS) if (guarantee.days_left <= level) result.expiring[level] += 1;
      if (guarantee.kind === 'ADVANCE' && guarantee.advance_outstanding_vnd !== '0') result.advanceAtRisk += 1;
    }
    return result;
  }

  private async alert(tx: TenantTx, guarantee: DueSql, threshold: AlertThreshold, pass: { tenantId: string; correlationId: string; now: Date }): Promise<void> {
    // A reminder is not a change of the guarantee: its version stays, so a command on a screen read this morning is not turned away by it.
    await tx.query(`update machvon.guarantee set last_alert_days = $2::int where id = $1::uuid`, [guarantee.id, threshold]);
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: guarantee.id,
      aggregateVersion: Number(guarantee.version),
      type: 'ctr.guarantee.expiring.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        guarantee_id: guarantee.id,
        contract_id: guarantee.contract_id,
        kind: guarantee.kind,
        expires_on: guarantee.expires_on,
        days_left: guarantee.days_left,
        threshold_days: threshold,
        occurred_at: pass.now.toISOString(),
        notification: {
          resource: { type: RESOURCE_TYPE, id: guarantee.id, ownerUnitId: guarantee.owner_unit_id, ownerUnitPath: guarantee.owner_unit_path, projectId: guarantee.project_id, contractId: guarantee.contract_id },
          deepLink: `/ctr/ctr-05?id=${guarantee.id}`,
        },
      },
      eventKey: `${RESOURCE_TYPE}:${guarantee.id}:alert:${threshold}`,
      correlationId: pass.correlationId,
    });
  }

  private async expire(tx: TenantTx, guarantee: DueSql, pass: { tenantId: string; actor: string; correlationId: string; now: Date }): Promise<void> {
    const { actor } = pass;
    const version = Number(guarantee.version) + 1;
    await tx.query(`update machvon.guarantee set status = 'EXPIRED', updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid`, [guarantee.id, actor, version]);
    // Only an advance guarantee that expires while an advance is still owed opens an issue; the event tells the intake which case this is.
    const issueRequired = guarantee.kind === 'ADVANCE' && guarantee.advance_outstanding_vnd !== '0';
    await this.audit.recordInTx(tx, actor, {
      action: 'guarantee.expired',
      resourceType: RESOURCE_TYPE,
      resourceId: guarantee.id,
      classification: CLASSIFICATION,
      diff: { contract_id: guarantee.contract_id, kind: guarantee.kind, from_status: 'ACTIVE', to_status: 'EXPIRED', expires_on: guarantee.expires_on, issue_required: issueRequired },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: guarantee.id,
      aggregateVersion: version,
      type: 'ctr.guarantee.expired.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        guarantee_id: guarantee.id,
        contract_id: guarantee.contract_id,
        project_id: guarantee.project_id,
        kind: guarantee.kind,
        amount_vnd: guarantee.amount_vnd,
        expires_on: guarantee.expires_on,
        advance_outstanding_vnd: guarantee.advance_outstanding_vnd,
        issue_required: issueRequired,
        occurred_at: pass.now.toISOString(),
        source_module: 'CTR',
        source_reference: guarantee.id,
      },
      eventKey: `${RESOURCE_TYPE}:${guarantee.id}:expired`,
      correlationId: pass.correlationId,
    });
  }

  private async tenantOf(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ tenant_id: string }>(`select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id`);
    const id = rows[0]?.tenant_id;
    if (id === undefined) throw new Error('the job ran outside a tenant');
    return id;
  }
}
