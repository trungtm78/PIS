import { DomainError, overrideIssues, versionConflict } from '@machvon/kernel';
import type { OverrideIssue } from '@machvon/kernel';
import { recordCurrentEntitlementVersion } from './entitlement-store.ts';
import type { TenantTx } from './tenant-database.ts';

export type OverrideStatus = 'PendingApproval' | 'Active' | 'Revoked' | 'Expired' | 'Rejected';
export type OverrideDecision = 'approve' | 'reject';

export interface OverrideRow {
  id: string;
  featureCode: string;
  enabled: boolean;
  limitValue: string | null;
  reason: string;
  validFrom: Date;
  validUntil: Date;
  status: OverrideStatus;
  requestedBy: string;
  approvedBy: string | null;
  version: number;
}

export interface RequestOverrideInput {
  featureCode: string;
  enabled: boolean;
  limitValue?: string | undefined;
  validFrom: Date;
  validUntil: Date;
  reason: string;
  requestedBy: string;
  now: Date;
}

export interface DecideOverrideInput {
  overrideId: string;
  decision: OverrideDecision;
  decidedBy: string;
  expectedVersion: number;
  now: Date;
}

export interface OverrideCycleOutcome {
  /** Overrides that were in force and ran out. */
  expired: number;
  /** Requests that waited for a decision until their window ended. */
  lapsed: number;
}

interface OverrideDbRow {
  id: string;
  feature_code: string;
  enabled: boolean;
  limit_value: string | null;
  reason: string;
  valid_from: Date;
  valid_until: Date;
  status: OverrideStatus;
  requested_by: string;
  approved_by: string | null;
  version: string;
}

const COLUMNS = 'id, feature_code, enabled, trim_scale(limit_value)::text as limit_value, reason, valid_from, valid_until, status, requested_by, approved_by, version::text as version';
const INSERT_SQL = `insert into machvon.entitlement_override
    (tenant_id, id, feature_code, enabled, limit_value, reason, valid_from, valid_until, status, requested_by)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::numeric, $4, $5, $6, 'PendingApproval', $7::uuid)
  returning ${COLUMNS}`;
const LOCK_ONE_SQL = `select ${COLUMNS} from machvon.entitlement_override where id = $1::uuid for update`;
const ONE_SQL = `select ${COLUMNS} from machvon.entitlement_override where id = $1::uuid`;
const LIST_SQL = `select ${COLUMNS} from machvon.entitlement_override o
  where ($1::uuid is null or (o.valid_from, o.id) < (select a.valid_from, a.id from machvon.entitlement_override a where a.id = $1::uuid))
  order by o.valid_from desc, o.id desc limit $2`;
const APPROVE_SQL = `update machvon.entitlement_override set status = 'Active', approved_by = $2::uuid, version = version + 1 where id = $1::uuid returning ${COLUMNS}`;
const SET_STATUS_SQL = `update machvon.entitlement_override set status = $2, version = version + 1 where id = $1::uuid returning ${COLUMNS}`;
const DUE_SQL = `select id, status from machvon.entitlement_override where status in ('PendingApproval', 'Active') and valid_until <= $1 order by valid_until, id for update`;

const overrideOf = (row: OverrideDbRow): OverrideRow => ({
  id: row.id,
  featureCode: row.feature_code,
  enabled: row.enabled,
  limitValue: row.limit_value,
  reason: row.reason,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
  version: Number(row.version),
});

/** 422 for the first thing wrong with a request: FEATURE_UNKNOWN for a feature no plan sells, VALIDATION_FAILED naming the field for the rest; every problem in `issues`. */
export function overrideInvalid(issues: readonly OverrideIssue[]): DomainError {
  const first = issues[0];
  const code = first?.reason === 'FEATURE_UNKNOWN' ? 'FEATURE_UNKNOWN' : 'VALIDATION_FAILED';
  return new DomainError(code, 422, first?.field, { extensions: { reason: first?.reason, issues: issues.map((issue) => ({ field: issue.field, reason: issue.reason })) } });
}

/**
 * The entitlement overrides of a tenant (ST-SAS-009, SAS.md BR-SAS-10): an exception to the plan for a time, asked for by one administrator and decided by another
 * (the database refuses an approver who is the requester). Every method runs in the transaction it is given, which acts as the tenant. An override takes effect
 * when it is approved and within its window (the entitlement gate reads the overrides in force), and every change of what is in force records a new entitlement version,
 * which tells the sessions of the tenant (\`sas.entitlement.changed.v1\`), so the exception is in force within the minute the cache lives.
 */
export class EntitlementOverrideStore {
  async request(tx: TenantTx, input: RequestOverrideInput): Promise<OverrideRow> {
    const issues = overrideIssues(input, input.now);
    if (issues.length > 0) throw overrideInvalid(issues);
    const [row] = await tx.query<OverrideDbRow>(INSERT_SQL, [input.featureCode, input.enabled, input.limitValue ?? null, input.reason.trim(), input.validFrom, input.validUntil, input.requestedBy]);
    if (row === undefined) throw new Error('override insert returned no row');
    return overrideOf(row);
  }

  /**
   * Decides a request that waits: approved it is in force (a new entitlement version tells the tenant), turned down it never is. 409 VERSION_CONFLICT for a stale
   * version, 409 STAGE_TRANSITION_DENIED for one that is no longer waiting, 403 SELF_APPROVAL_DENIED for the person who asked (whichever way they decide), 422 for a
   * request whose window ended while it waited.
   */
  async decide(tx: TenantTx, input: DecideOverrideInput): Promise<OverrideRow> {
    const current = await this.lock(tx, input.overrideId);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'PendingApproval') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (current.requestedBy.toLowerCase() === input.decidedBy.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.validUntil.getTime() <= input.now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until', { extensions: { reason: 'ALREADY_ENDED' } });
    const [row] = input.decision === 'approve' ? await tx.query<OverrideDbRow>(APPROVE_SQL, [current.id, input.decidedBy]) : await tx.query<OverrideDbRow>(SET_STATUS_SQL, [current.id, 'Rejected']);
    if (row === undefined) throw new Error('override update returned no row');
    if (input.decision === 'approve') await this.announce(tx, 'OVERRIDE');
    return overrideOf(row);
  }

  /** Withdraws a request that waits or ends one that is in force; what was in force is out of force at once and the tenant is told. 409 STAGE_TRANSITION_DENIED for any other. */
  async revoke(tx: TenantTx, overrideId: string, expectedVersion: number): Promise<OverrideRow> {
    const current = await this.lock(tx, overrideId);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'PendingApproval' && current.status !== 'Active') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const [row] = await tx.query<OverrideDbRow>(SET_STATUS_SQL, [current.id, 'Revoked']);
    if (row === undefined) throw new Error('override update returned no row');
    if (current.status === 'Active') await this.announce(tx, 'OVERRIDE');
    return overrideOf(row);
  }

  /**
   * Lets what ran out run out (the minutely job): an override in force whose window has ended becomes Expired and, once for all that ended in this pass, the tenant gets
   * a new entitlement version (cause EXPIRY); a request that waited past the end of its window becomes Expired too and changes nothing a tenant can do.
   */
  async expireDue(tx: TenantTx, now: Date): Promise<OverrideCycleOutcome> {
    const due = await tx.query<{ id: string; status: OverrideStatus }>(DUE_SQL, [now]);
    let expired = 0;
    let lapsed = 0;
    for (const row of due) {
      await tx.query(SET_STATUS_SQL, [row.id, 'Expired']);
      if (row.status === 'Active') expired += 1;
      else lapsed += 1;
    }
    if (expired > 0) await this.announce(tx, 'EXPIRY');
    return { expired, lapsed };
  }

  async find(tx: TenantTx, id: string): Promise<OverrideRow | undefined> {
    const [row] = await tx.query<OverrideDbRow>(ONE_SQL, [id]);
    return row === undefined ? undefined : overrideOf(row);
  }

  /** The overrides of the tenant, the latest to start first; keyset by the last one of the page before. */
  async list(tx: TenantTx, input: { limit: number; after?: string | undefined }): Promise<OverrideRow[]> {
    return (await tx.query<OverrideDbRow>(LIST_SQL, [input.after ?? null, input.limit])).map(overrideOf);
  }

  // The sessions of the tenant are told that what it may do changed. A tenant that has no entitlement version yet has nothing to copy and nobody to tell.
  private async announce(tx: TenantTx, cause: 'OVERRIDE' | 'EXPIRY'): Promise<void> {
    const [any] = await tx.query('select 1 from machvon.entitlement_version limit 1');
    if (any !== undefined) await recordCurrentEntitlementVersion(tx, cause);
  }

  private async lock(tx: TenantTx, overrideId: string): Promise<OverrideRow> {
    const [row] = await tx.query<OverrideDbRow>(LOCK_ONE_SQL, [overrideId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return overrideOf(row);
  }
}
