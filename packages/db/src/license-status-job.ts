import { randomUUID } from 'node:crypto';
import type { AuditWriter } from './audit-writer.ts';
import { recordCurrentEntitlementVersion } from './entitlement-store.ts';
import type { EntitlementCause } from './entitlement-store.ts';
import type { LicenseStatus } from './license-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const LICENSE_STATUS_CHANGED_EVENT = 'sas.license.status_changed.v1';
const RESOURCE_TYPE = 'license';

/** The statuses the clock moves: Suspended is the decision of a person, so the job leaves it until it is reinstated (BR-SAS-12). */
const TIMED: readonly LicenseStatus[] = ['Issued', 'Active', 'Grace'];

interface DueRow {
  id: string;
  serial: string;
  revision: number;
  status: LicenseStatus;
  valid_from: Date;
  valid_until: Date;
  grace_until: Date;
  version: string;
}

export interface LicenseStatusChange {
  licenseId: string;
  serial: string;
  revision: number;
  from: LicenseStatus;
  to: LicenseStatus;
}

export interface LicenseStatusResult {
  changes: LicenseStatusChange[];
}

/**
 * The next status of a license by the clock, one step of the chain Issued -> Active -> Grace -> Expired (SAS 3.8): `Active` from `valid_from` (the window is
 * `[valid_from, valid_until)`), `Grace` from `valid_until` while there is any grace, `Expired` from `grace_until` (or from `valid_until` when there is none).
 */
export function nextLicenseStatus(row: Pick<DueRow, 'status' | 'valid_from' | 'valid_until' | 'grace_until'>, now: Date): LicenseStatus | undefined {
  const at = now.getTime();
  switch (row.status) {
    case 'Issued':
      return at >= row.valid_from.getTime() ? 'Active' : undefined;
    case 'Active':
      if (at < row.valid_until.getTime()) return undefined;
      return row.grace_until.getTime() > row.valid_until.getTime() ? 'Grace' : 'Expired';
    case 'Grace':
      return at >= row.grace_until.getTime() ? 'Expired' : undefined;
    default:
      return undefined;
  }
}

/**
 * ST-SAS-003, the minutely status job: moves the licenses of the tenant of the transaction along Issued -> Active -> Grace -> Expired by the clock of the
 * server (never a client's), one step and one `sas.license.status_changed.v1` with one audit row per transition, so a pass that finds a license several
 * steps behind (a stopped process) tells each step. The tenant gets a new entitlement version once for what the clock changed. A second pass changes nothing.
 * It runs through the control role acting as the tenant, like the other jobs over control-plane tables.
 */
export class LicenseStatusJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<LicenseStatusResult> {
    const correlationId = randomUUID();
    const [tenant] = await tx.query<{ tenant_id: string | null }>("select nullif(current_setting('app.tenant_id', true), '')::uuid::text as tenant_id");
    if (tenant?.tenant_id === undefined || tenant.tenant_id === null) throw new Error('the job ran outside a tenant');
    const tenantId = tenant.tenant_id;
    const due = await tx.query<DueRow>(
      `select id, serial, revision, status, valid_from, valid_until, grace_until, version::text as version
         from machvon.license_revision where status = any($1::text[]) order by serial, revision for update skip locked`,
      [[...TIMED]],
    );
    const changes: LicenseStatusChange[] = [];
    const causes = new Set<EntitlementCause>();
    for (const row of due) {
      let current = row;
      for (let next = nextLicenseStatus(current, now); next !== undefined; next = nextLicenseStatus(current, now)) {
        const [updated] = await tx.query<DueRow>(
          `update machvon.license_revision set status = $2, version = version + 1 where id = $1::uuid
           returning id, serial, revision, status, valid_from, valid_until, grace_until, version::text as version`,
          [current.id, next],
        );
        if (updated === undefined) throw new Error('license revision was not updated');
        const change: LicenseStatusChange = { licenseId: current.id, serial: current.serial, revision: current.revision, from: current.status, to: next };
        await this.announce(tx, { tenantId, actor, correlationId, now, change, row: updated });
        changes.push(change);
        causes.add(next === 'Active' ? 'LICENSE_CHANGE' : 'EXPIRY');
        current = updated;
      }
    }
    // The mode of the license is part of what the tenant may do: the sessions are told once for each cause that this pass met.
    for (const cause of causes) await recordCurrentEntitlementVersion(tx, cause, correlationId);
    return { changes };
  }

  private async announce(tx: TenantTx, pass: { tenantId: string; actor: string; correlationId: string; now: Date; change: LicenseStatusChange; row: DueRow }): Promise<void> {
    const { change, row } = pass;
    await this.audit.recordInTx(tx, pass.actor, {
      action: 'sas.license_status_changed',
      resourceType: RESOURCE_TYPE,
      resourceId: change.licenseId,
      classification: 'INTERNAL',
      diff: { serial: change.serial, revision: change.revision, from_status: change.from, to_status: change.to },
      correlationId: pass.correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: change.licenseId,
      aggregateVersion: Number(row.version),
      type: LICENSE_STATUS_CHANGED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: pass.tenantId,
        license_id: change.licenseId,
        serial: change.serial,
        revision: change.revision,
        from: change.from,
        to: change.to,
        valid_until: row.valid_until.toISOString(),
        grace_until: row.grace_until.toISOString(),
        occurred_at: pass.now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${change.licenseId}:status:${change.to}`,
      correlationId: pass.correlationId,
    });
  }
}
