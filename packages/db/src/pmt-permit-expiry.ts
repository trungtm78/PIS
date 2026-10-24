import { randomUUID } from 'node:crypto';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import { PmtDossierStore, SCOPE_JOINS } from './pmt-dossier-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The days before the last day on which the person in charge is told: levels 1 to 4 of `alert_level_sent` (BR-PMT-06). */
export const EXPIRY_ALERT_DAYS = [60, 30, 15, 0] as const;
export type ExpiryAlertDays = (typeof EXPIRY_ALERT_DAYS)[number];
export const MAX_WITHIN_DAYS = 365;
export const DEFAULT_WITHIN_DAYS = 60;
const RESOURCE_TYPE = 'permit';
const CLASSIFICATION = 'INTERNAL';

/** The level of alert a permit has reached with `daysLeft` days to its last day (0 when it is still more than 60 days away; a lapsed permit is at the last level). */
export function alertLevelOf(daysLeft: number): 0 | 1 | 2 | 3 | 4 {
  if (daysLeft <= EXPIRY_ALERT_DAYS[3]) return 4;
  if (daysLeft <= EXPIRY_ALERT_DAYS[2]) return 3;
  if (daysLeft <= EXPIRY_ALERT_DAYS[1]) return 2;
  if (daysLeft <= EXPIRY_ALERT_DAYS[0]) return 1;
  return 0;
}

/** The threshold of a level of alert (60, 30, 15 or 0 days), or null for no alert. */
export const thresholdOfLevel = (level: number): ExpiryAlertDays | null => EXPIRY_ALERT_DAYS[level - 1] ?? null;

/** What one pass of the job did for a tenant, and the figures the gauge `pmt_permit_expiring{days}` is made of. */
export interface PermitExpiryResult {
  /** Reminders sent: one per permit and level of alert, never twice. */
  alerted: number;
  /** Permits that became EXPIRED in this pass (each opens one issue through the event). */
  expired: number;
  /** The ISSUED permits that are within each threshold of their last day now (after the pass). */
  expiring: Record<ExpiryAlertDays, number>;
}

interface DueSql {
  id: string;
  dossier_id: string;
  permit_type_code: string | null;
  permit_no: string | null;
  valid_until: string;
  days_left: number;
  alert_level_sent: number;
  version: string;
  responsible_membership_id: string | null;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
}

const EMPTY: Record<ExpiryAlertDays, number> = { 60: 0, 30: 0, 15: 0, 0: 0 };

/**
 * The job `permit-expiry` (PMT 3.1 step 5, BR-PMT-06): every ISSUED permit with an end that is 60, 30, 15 or 0 days from its last day (calendar days in
 * Vietnam) gets one reminder for the level it has reached, remembered in `alert_level_sent` so a second pass the same day sends nothing and a missed day
 * sends the level of today and not the stale ones; the day after the last day the permit becomes EXPIRED, once, with the event that the issue intake of ISS
 * answers by opening one issue, and the readiness of its dossier is counted again. The job never renews or extends a permit: a renewal is a new permit that
 * replaces the old one. The pass takes the clock as an argument, so a test turns it by hand.
 */
export class PmtPermitExpiry {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  /** One pass for the tenant of the transaction. A permit that a command is acting on at that moment is left to the next pass. */
  async run(tx: TenantTx, actor: string, now: Date): Promise<PermitExpiryResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const tenantId = await this.tenantOf(tx);
    const result: PermitExpiryResult = { alerted: 0, expired: 0, expiring: { ...EMPTY } };
    // The readiness of a dossier is counted on the day of the pass, not on the clock of the machine.
    const dossiers = new PmtDossierStore({ today: () => today });
    const due = await tx.query<DueSql>(
      `select x.id, x.dossier_id, x.permit_type_code, x.permit_no, x.valid_until::text as valid_until, (x.valid_until - $1::date) as days_left, x.alert_level_sent,
              x.version::text as version, x.responsible_membership_id, d.project_id, du.id as owner_unit_id, du.path as owner_unit_path
         from machvon.permit x
         join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id
         join machvon.organization_unit du on du.tenant_id = d.tenant_id and du.id = d.owner_unit_id
        where x.status = 'ISSUED' and not x.no_expiry and x.valid_until is not null and (x.valid_until - $1::date) <= $2::int
        order by x.valid_until, x.id
        for update of x skip locked`,
      [today, EXPIRY_ALERT_DAYS[0]],
    );
    for (const permit of due) {
      if (permit.days_left < 0) {
        await this.expire(tx, permit, { tenantId, actor, correlationId, now, dossiers });
        result.expired += 1;
        continue;
      }
      const level = alertLevelOf(permit.days_left);
      if (level > permit.alert_level_sent) {
        await this.alert(tx, permit, level, { tenantId, correlationId, now });
        result.alerted += 1;
      }
      for (const days of EXPIRY_ALERT_DAYS) if (permit.days_left <= days) result.expiring[days] += 1;
    }
    return result;
  }

  private async alert(tx: TenantTx, permit: DueSql, level: number, pass: { tenantId: string; correlationId: string; now: Date }): Promise<void> {
    // A reminder is not a change of the permit: its version stays, so a command on a screen read this morning is not turned away by it.
    await tx.query('update machvon.permit set alert_level_sent = $2::smallint where id = $1::uuid', [permit.id, level]);
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: permit.id,
      aggregateVersion: Number(permit.version),
      type: 'pmt.permit.expiring.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        permit_id: permit.id,
        dossier_id: permit.dossier_id,
        project_id: permit.project_id,
        permit_type_code: permit.permit_type_code,
        valid_until: permit.valid_until,
        days_left: permit.days_left,
        threshold_days: thresholdOfLevel(level),
        occurred_at: pass.now.toISOString(),
        notification: {
          resource: { type: RESOURCE_TYPE, id: permit.id, ownerUnitId: permit.owner_unit_id, ownerUnitPath: permit.owner_unit_path, projectId: permit.project_id },
          deepLink: `/pmt/pmt-05?permit=${permit.id}`,
          ...(permit.responsible_membership_id === null ? {} : { recipients: [permit.responsible_membership_id] }),
        },
      },
      eventKey: `${RESOURCE_TYPE}:${permit.id}:alert:${level}`,
      correlationId: pass.correlationId,
    });
  }

  private async expire(tx: TenantTx, permit: DueSql, pass: { tenantId: string; actor: string; correlationId: string; now: Date; dossiers: PmtDossierStore }): Promise<void> {
    const { actor } = pass;
    const version = Number(permit.version) + 1;
    await tx.query(`update machvon.permit set status = 'EXPIRED', alert_level_sent = 4, updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid`, [permit.id, actor, version]);
    // An expired permit no longer covers its type: the readiness of the dossier is counted again, in the same transaction.
    const readiness = await pass.dossiers.refreshReadiness(tx, permit.dossier_id, actor);
    await this.audit.recordInTx(tx, actor, {
      action: 'pmt.permit_expired',
      resourceType: RESOURCE_TYPE,
      resourceId: permit.id,
      classification: CLASSIFICATION,
      diff: { dossier_id: permit.dossier_id, permit_type_code: permit.permit_type_code, from_status: 'ISSUED', to_status: 'EXPIRED', valid_until: permit.valid_until, readiness_pct: readiness.readinessPct },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    // The members of the common contract of the issue intake (ISS-11) come first: the source object, its reference code (the permit number) and the project.
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: permit.id,
      aggregateVersion: version,
      type: 'pmt.permit.expired.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        source_ref_id: permit.id,
        reference_code: permit.permit_no,
        project_id: permit.project_id,
        owner_unit_id: permit.owner_unit_id,
        permit_id: permit.id,
        dossier_id: permit.dossier_id,
        permit_type_code: permit.permit_type_code,
        status: 'EXPIRED',
        valid_until: permit.valid_until,
        occurred_at: pass.now.toISOString(),
        source_module: 'PMT',
      },
      eventKey: `${RESOURCE_TYPE}:${permit.id}:expired`,
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

export interface ExpiringPermitRow {
  id: string;
  dossierId: string;
  permitTypeCode: string | null;
  permitTypeName: string;
  permitNo: string | null;
  status: 'ISSUED' | 'EXPIRED';
  validUntil: string;
  /** Days to the last day by the Vietnam date of the read; negative for a permit past it. */
  daysLeft: number;
  /** The level of alert the permit has reached (0 to 4); an expired one is at the last. */
  alertLevel: number;
  project: { id: string; code: string; name: string };
  responsible: { membershipId: string; displayName: string } | null;
  version: number;
}

interface ExpiringSql {
  id: string;
  dossier_id: string;
  permit_type_code: string | null;
  permit_type_name: string;
  permit_no: string | null;
  status: 'ISSUED' | 'EXPIRED';
  valid_until: string;
  days_left: number;
  alert_level_sent: number;
  project_id: string;
  project_code: string;
  project_name: string;
  responsible_membership_id: string | null;
  responsible_name: string | null;
  version: string;
}

const toRow = (row: ExpiringSql): ExpiringPermitRow => ({
  id: row.id,
  dossierId: row.dossier_id,
  permitTypeCode: row.permit_type_code,
  permitTypeName: row.permit_type_name,
  permitNo: row.permit_no,
  status: row.status,
  validUntil: row.valid_until,
  daysLeft: row.days_left,
  alertLevel: row.status === 'EXPIRED' ? 4 : Math.max(row.alert_level_sent, alertLevelOf(row.days_left)),
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  responsible: row.responsible_membership_id === null ? null : { membershipId: row.responsible_membership_id, displayName: row.responsible_name ?? '' },
  version: Number(row.version),
});

/**
 * The permits that need attention (PMT-05): the ISSUED ones whose last day is within `withinDays` days (or already past, until the job has marked them),
 * and the EXPIRED ones that no renewal has replaced yet, the ones that ran out first. A permit without an end never appears. Only the permits of the
 * dossiers in the scope of the caller are read.
 */
export class PmtExpiringPermits {
  private readonly today: () => string;

  constructor(options: { today?: () => string } = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
  }

  async list(tx: TenantTx, scope: ScopeBuilder, filter: { withinDays: number }, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ExpiringPermitRow[]> {
    if (!Number.isInteger(filter.withinDays) || filter.withinDays < 0 || filter.withinDays > MAX_WITHIN_DAYS) throw new DomainError('VALIDATION_FAILED', 422, 'within_days');
    if (request.after !== undefined) {
      const day = new Date(`${request.after.code}T00:00:00.000Z`);
      const real = /^\d{4}-\d{2}-\d{2}$/.test(request.after.code) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === request.after.code;
      if (!real || asUuid(request.after.id) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    }
    const predicate = scope(6);
    const rows = await tx.query<ExpiringSql>(
      `select x.id, x.dossier_id, x.permit_type_code, t.name as permit_type_name, x.permit_no, x.status, x.valid_until::text as valid_until, (x.valid_until - $1::date) as days_left,
              x.alert_level_sent, p.id as project_id, p.code as project_code, p.name as project_name, x.responsible_membership_id, rm.display_name as responsible_name, x.version::text as version
         from machvon.permit x
         join machvon.permit_type t on t.tenant_id = x.tenant_id and t.id = x.permit_type_id
         join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id ${SCOPE_JOINS}
         left join machvon.tenant_user_directory rm on rm.tenant_id = x.tenant_id and rm.membership_id = x.responsible_membership_id
        where not x.no_expiry and x.valid_until is not null
          and ((x.status = 'ISSUED' and (x.valid_until - $1::date) <= $2::int)
            or (x.status = 'EXPIRED' and not exists (select 1 from machvon.permit s where s.tenant_id = x.tenant_id and s.supersedes_id = x.id)))
          and ($3::date is null or (x.valid_until, x.id) > ($3::date, $4::uuid)) and ${predicate.sql}
        order by x.valid_until, x.id limit $5`,
      [this.today(), filter.withinDays, request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toRow);
  }
}
