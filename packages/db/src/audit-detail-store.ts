import { DomainError, auditDetailChangedPaths, auditDetailMatches, auditDetailPolicyFindings } from '@machvon/kernel';
import type { AuditDetailFinding } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** The row of a tenant's choice to keep the full before and after of the business objects of a class in the audit trail (audit_detail_policy). */
export interface AuditDetailPolicyRow {
  id: string;
  resourceType: string;
  enabled: boolean;
  maxBytes: number;
  sensitiveKeys: string[];
  reason: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

interface PolicySql {
  id: string;
  resource_type: string;
  enabled: boolean;
  max_bytes: number;
  sensitive_keys: string[];
  reason: string;
  version: string;
  updated_at: string;
  updated_by: string;
}

const POLICY_SELECT = `select id, resource_type, enabled, max_bytes, sensitive_keys, reason, version::text as version,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at, updated_by
  from machvon.audit_detail_policy`;

const policyOf = (row: PolicySql): AuditDetailPolicyRow => ({
  id: row.id,
  resourceType: row.resource_type,
  enabled: row.enabled,
  maxBytes: row.max_bytes,
  sensitiveKeys: row.sensitive_keys,
  reason: row.reason,
  version: Number(row.version),
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

export interface AuditDetailPolicyInput {
  resourceType: string;
  enabled: boolean;
  maxBytes: number;
  sensitiveKeys: readonly string[];
  reason: string;
}

export interface AuditDetailPolicyChange {
  row: AuditDetailPolicyRow;
  before: AuditDetailPolicyRow | undefined;
  action: 'CREATED' | 'ENABLED' | 'DISABLED' | 'CHANGED';
}

/** What the viewer of the trail shows for one audit row that kept its detail. */
export interface AuditDetailView {
  auditEventId: string;
  resourceType: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  sha256: string;
  bytes: number;
  redactedPaths: string[];
  truncated: boolean;
  changedPaths: string[];
  /** Whether the stored values still hash to the value the sealed audit row carries (`safe_diff.detail_ref.sha256`). False means the record was altered or the row carries no reference. */
  matchesSealedRow: boolean;
  createdAt: string;
}

interface DetailSql {
  audit_event_id: string;
  resource_type: string;
  resource_id: string;
  before_value: unknown;
  after_value: unknown;
  detail_sha256: string;
  bytes: number;
  redacted_paths: string[];
  truncated: boolean;
  created_at: string;
  sealed_hash: string | null;
}

const DETAIL_SELECT = `select d.audit_event_id, d.resource_type, d.resource_id, d.before_value, d.after_value, d.detail_sha256, d.bytes, d.redacted_paths, d.truncated,
    to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, e.safe_diff #>> '{detail_ref,sha256}' as sealed_hash
  from machvon.audit_event_detail d join machvon.audit_event e on e.tenant_id = d.tenant_id and e.id = d.audit_event_id`;

const detailOf = (row: DetailSql): AuditDetailView => ({
  auditEventId: row.audit_event_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  before: row.before_value,
  after: row.after_value,
  sha256: row.detail_sha256,
  bytes: row.bytes,
  redactedPaths: row.redacted_paths,
  truncated: row.truncated,
  changedPaths: auditDetailChangedPaths(row.before_value, row.after_value),
  matchesSealedRow: row.sealed_hash === row.detail_sha256 && auditDetailMatches({ before: row.before_value, after: row.after_value }, { sha256: row.detail_sha256 }),
  createdAt: row.created_at,
});

/** Throws 422 VALIDATION_FAILED with the findings in `errors` (the first field in the detail), never a value. */
function assertValid(findings: AuditDetailFinding[]): void {
  const first = findings[0];
  if (first !== undefined) throw new DomainError('VALIDATION_FAILED', 422, first.field, { extensions: { errors: findings } });
}

/**
 * The opt-in per class of business object to keep the full before and after in the audit trail (HT.06). Off by default; each change is a versioned command with a
 * reason, and leaves a row in the append-only history. The writer (`AuditWriter`) reads the policy; nothing here writes an audit row (the command does).
 */
export class AuditDetailPolicyStore {
  async list(tx: TenantTx): Promise<AuditDetailPolicyRow[]> {
    return (await tx.query<PolicySql>(`${POLICY_SELECT} order by resource_type`)).map(policyOf);
  }

  async find(tx: TenantTx, resourceType: string): Promise<AuditDetailPolicyRow | undefined> {
    const [row] = await tx.query<PolicySql>(`${POLICY_SELECT} where resource_type = $1`, [resourceType]);
    return row === undefined ? undefined : policyOf(row);
  }

  /**
   * Creates the policy of a class or changes it. `expectedVersion` is the version the caller saw (0 or undefined for a class that has none): another value is 409 VERSION_CONFLICT.
   * The sensitive keys are kept lower-case and sorted so that the same set is the same value.
   */
  async save(tx: TenantTx, actorId: string, input: AuditDetailPolicyInput, expectedVersion: number): Promise<AuditDetailPolicyChange> {
    const keys = [...new Set(input.sensitiveKeys.map((key) => key.trim().toLowerCase()))].sort();
    assertValid(auditDetailPolicyFindings({ resourceType: input.resourceType, maxBytes: input.maxBytes, sensitiveKeys: keys, reason: input.reason }));
    const [locked] = await tx.query<PolicySql>(`${POLICY_SELECT} where resource_type = $1 for update`, [input.resourceType]);
    const before = locked === undefined ? undefined : policyOf(locked);
    if ((before?.version ?? 0) !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: before?.version ?? 0 } });
    let row: AuditDetailPolicyRow;
    let action: AuditDetailPolicyChange['action'];
    if (before === undefined) {
      const [made] = await tx.query<PolicySql>(
        `insert into machvon.audit_detail_policy (tenant_id, resource_type, enabled, max_bytes, sensitive_keys, reason, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::text[], $5, $6::uuid, $6::uuid)
         returning id, resource_type, enabled, max_bytes, sensitive_keys, reason, version::text as version, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at, updated_by`,
        [input.resourceType, input.enabled, input.maxBytes, keys, input.reason.trim(), actorId],
      );
      if (made === undefined) throw new Error('audit detail policy insert returned no row');
      row = policyOf(made);
      action = 'CREATED';
    } else {
      const [changed] = await tx.query<PolicySql>(
        `update machvon.audit_detail_policy set enabled = $2, max_bytes = $3, sensitive_keys = $4::text[], reason = $5, version = version + 1, updated_at = now(), updated_by = $6::uuid
          where id = $1::uuid
          returning id, resource_type, enabled, max_bytes, sensitive_keys, reason, version::text as version, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at, updated_by`,
        [before.id, input.enabled, input.maxBytes, keys, input.reason.trim(), actorId],
      );
      if (changed === undefined) throw new Error('audit detail policy update returned no row');
      row = policyOf(changed);
      action = before.enabled === row.enabled ? 'CHANGED' : row.enabled ? 'ENABLED' : 'DISABLED';
    }
    await tx.query(
      `insert into machvon.audit_detail_policy_event (tenant_id, policy_id, action, reason, actor_id, snapshot, policy_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::jsonb, $6)`,
      [row.id, action, input.reason.trim(), actorId, JSON.stringify({ resource_type: row.resourceType, enabled: row.enabled, max_bytes: row.maxBytes, sensitive_keys: row.sensitiveKeys }), row.version],
    );
    return { row, before, action };
  }
}

/** Reads of the stored details. The caller needs the right to read the audit trail; the detail is as confidential as the row it belongs to. */
export class AuditDetailReads {
  async forEvent(tx: TenantTx, auditEventId: string): Promise<AuditDetailView | undefined> {
    const [row] = await tx.query<DetailSql>(`${DETAIL_SELECT} where d.audit_event_id = $1::uuid`, [auditEventId]);
    return row === undefined ? undefined : detailOf(row);
  }

  /** The details kept for one business object, newest first. */
  async forResource(tx: TenantTx, resourceType: string, resourceId: string, limit: number): Promise<AuditDetailView[]> {
    const rows = await tx.query<DetailSql>(`${DETAIL_SELECT} where d.resource_type = $1 and d.resource_id = $2::uuid order by d.created_at desc, d.audit_event_id desc limit $3`, [resourceType, resourceId, limit]);
    return rows.map(detailOf);
  }
}
