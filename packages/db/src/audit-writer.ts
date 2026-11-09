import { auditDetailRef, prepareAuditDetail, safeDiff } from '@machvon/kernel';
import type { AuditDetailInput, PreparedAuditDetail } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';
export type AuditClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId: string;
  diff: Record<string, unknown>;
  sensitiveKeys?: readonly string[];
  reason?: string;
  correlationId: string;
  requestId: string;
  classification?: AuditClassification;
  impersonatorId?: string;
  onBehalfOfId?: string;
  ipHash?: string;
  /**
   * The full values of a business object before and after the command (HT.06). Stored only when the tenant opted in for `resourceType` (audit_detail_policy):
   * they are redacted and bounded, kept in audit_event_detail, and the sealed diff carries their SHA-256 as `detail_ref`. Without an opt-in the entry is written as before.
   */
  detail?: AuditDetailInput;
}

/** Resource id of a denied command that never reached a resource (audit_event.resource_id is NOT NULL). */
export const NIL_RESOURCE_ID = '00000000-0000-4000-8000-000000000000';

const DEFAULT_CLASSIFICATION: AuditClassification = 'INTERNAL';

// Writers share this lock until they commit; the sealer takes it exclusively. A sealed window therefore
// never receives a row with a lower seq later, although audit_event_seq is global and commits out of order.
export const AUDIT_LOCK_KEY_SQL = "hashtextextended('audit:' || current_setting('app.tenant_id'), 0)";

const INSERT_SQL = `insert into machvon.audit_event
  (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, reason, correlation_id, request_id,
   occurred_at, outcome, classification, impersonator_id, on_behalf_of_id, ip_hash)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8,
   clock_timestamp(), $9, $10, $11, $12, $13)
  returning id`;

const DETAIL_INSERT_SQL = `insert into machvon.audit_event_detail
  (tenant_id, audit_event_id, resource_type, resource_id, before_value, after_value, detail_sha256, bytes, redacted_paths, truncated)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::text[], $9)`;

/** The detail of an entry as the tenant's policy for its class allows it; undefined when the entry carries none or the class is not opted in. */
async function detailOf(tx: TenantTx, entry: AuditEntry): Promise<PreparedAuditDetail | undefined> {
  if (entry.detail === undefined) return undefined;
  const [policy] = await tx.query<{ enabled: boolean; max_bytes: number; sensitive_keys: string[] }>(
    'select enabled, max_bytes, sensitive_keys from machvon.audit_detail_policy where resource_type = $1',
    [entry.resourceType],
  );
  if (policy === undefined || !policy.enabled) return undefined;
  return prepareAuditDetail(entry.detail, { enabled: true, maxBytes: policy.max_bytes, sensitiveKeys: policy.sensitive_keys });
}

async function insertEntry(tx: TenantTx, actorId: string, outcome: AuditOutcome, entry: AuditEntry): Promise<string> {
  await tx.query(`select pg_advisory_xact_lock_shared(${AUDIT_LOCK_KEY_SQL})`);
  const detail = await detailOf(tx, entry);
  const rows = await tx.query<{ id: string }>(INSERT_SQL, [
    actorId,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    JSON.stringify(safeDiff(detail === undefined ? entry.diff : { ...entry.diff, detail_ref: auditDetailRef(detail) }, { sensitiveKeys: entry.sensitiveKeys })),
    entry.reason ?? null,
    entry.correlationId,
    entry.requestId,
    outcome,
    entry.classification ?? DEFAULT_CLASSIFICATION,
    entry.impersonatorId ?? null,
    entry.onBehalfOfId ?? null,
    entry.ipHash ?? null,
  ]);
  const [row] = rows;
  if (row === undefined) throw new Error('audit insert returned no row');
  if (detail !== undefined) {
    await tx.query(DETAIL_INSERT_SQL, [row.id, entry.resourceType, entry.resourceId, JSON.stringify(detail.before), JSON.stringify(detail.after), detail.sha256, detail.bytes, detail.redactedPaths, detail.truncated]);
  }
  return row.id;
}

/** Writes audit_event rows: the success row inside the command transaction, a denial in its own. */
export class AuditWriter {
  private readonly database: TenantDatabase;

  constructor(database: TenantDatabase) {
    this.database = database;
  }

  /** Outcome SUCCESS, committed or rolled back together with the caller's transaction. Returns the audit id. */
  recordInTx(tx: TenantTx, actorId: string, entry: AuditEntry): Promise<string> {
    return insertEntry(tx, actorId, 'SUCCESS', entry);
  }

  /** Outcome SUCCESS in a transaction of its own, for what happened outside a command and still must leave a trace (the use of a support access grant). */
  record(ctx: TenantContext, entry: AuditEntry): Promise<string> {
    return this.database.withTenant(ctx, (tx) => insertEntry(tx, ctx.membershipId, 'SUCCESS', entry));
  }

  /** Outcome DENIED in a separate transaction, so it survives the rollback of the denied command. */
  recordDenied(ctx: TenantContext, entry: AuditEntry): Promise<string> {
    return this.database.withTenant(ctx, (tx) => insertEntry(tx, ctx.membershipId, 'DENIED', entry));
  }
}
