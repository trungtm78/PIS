import { DomainError, retentionFinding, validateRetentionPolicy, versionConflict } from '@machvon/kernel';
import type { RetentionPolicyContent } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type RetentionPolicyStatus = 'Draft' | 'Published' | 'Superseded';

export interface RetentionPolicyRow {
  id: string;
  recordClass: string;
  revision: number;
  retentionYears: number | null;
  retentionBasis: RetentionPolicyContent['retention_basis'];
  legalBasisRef: string;
  endAction: RetentionPolicyContent['end_action'];
  effectiveFrom: string;
  status: RetentionPolicyStatus;
  createdBy: string;
  approvedBy: string | null;
  publishedAt: string | null;
  version: number;
}

interface Row {
  id: string;
  record_class: string;
  revision: number;
  retention_years: number | null;
  retention_basis: RetentionPolicyRow['retentionBasis'];
  legal_basis_ref: string;
  end_action: RetentionPolicyRow['endAction'];
  effective_from: string;
  status: RetentionPolicyStatus;
  created_by: string;
  approved_by: string | null;
  published_at: string | null;
  version: string;
}

const COLUMNS = `id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from::text as effective_from, status,
  created_by, approved_by, to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at, version::text as version`;

const toRow = (row: Row): RetentionPolicyRow => ({
  id: row.id,
  recordClass: row.record_class,
  revision: row.revision,
  retentionYears: row.retention_years,
  retentionBasis: row.retention_basis,
  legalBasisRef: row.legal_basis_ref,
  endAction: row.end_action,
  effectiveFrom: row.effective_from,
  status: row.status,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  publishedAt: row.published_at,
  version: Number(row.version),
});

/** What the platform's own catalogue says about the period of a class of data (master data RETENTION_POLICY, ST-MDM-005). */
export interface PlatformBaseline {
  years: number | undefined;
  permanent: boolean;
}

/** The ordering key of the last row of a page: the class, then the newest revision first, kept as `class` and `id`. */
export interface RetentionPageAnchor {
  code: string;
  id: string;
}

/**
 * Retention policy versions (ST-ADM-017, ADM 3.12). A version is drafted by one person and published by another; publishing it makes it
 * the one rule a job reads for its record class and supersedes the version it replaces. Every query runs inside the caller's tenant
 * transaction, so row-level security keeps tenants apart.
 *
 * Relation to master data: the platform publishes `RETENTION_POLICY` (DGV, platform only) as the baseline period of a class of data. That
 * catalogue is never executed by a job; this table is. A tenant policy for a class the catalogue names (the key in lower case) can not keep
 * the class for less than the platform does: the tenant may lengthen a period, never shorten it.
 */
export class RetentionPolicyStore {
  /**
   * Writes the next revision of a record class as a draft. A draft that is still open for the class is replaced (superseded): at most
   * one draft per class is alive, so the one a publisher sees is the latest word of the author. Fails with 422 RETENTION_POLICY_INVALID.
   */
  async createDraft(tx: TenantTx, content: RetentionPolicyContent, actor: string): Promise<{ row: RetentionPolicyRow; replacedDraftId: string | undefined }> {
    validateRetentionPolicy(content);
    await this.assertAtLeastPlatformBaseline(tx, content);
    // Two drafts of one class race for the same revision number: they take turns.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('retention:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [content.record_class]);
    const replaced = await tx.query<{ id: string }>(
      "update machvon.data_retention_policy set status = 'Superseded', version = version + 1 where record_class = $1 and status = 'Draft' returning id",
      [content.record_class],
    );
    const inserted = await tx.query<Row>(
      `insert into machvon.data_retention_policy
         (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1,
         (select coalesce(max(revision), 0) + 1 from machvon.data_retention_policy where record_class = $1),
         $2, $3, $4, $5, $6::date, 'Draft', $7::uuid, 1)
       returning ${COLUMNS}`,
      [content.record_class, content.retention_years ?? null, content.retention_basis, content.legal_basis_ref.trim(), content.end_action, content.effective_from, actor],
    );
    return { row: toRow(inserted[0] as Row), replacedDraftId: replaced[0]?.id };
  }

  async find(tx: TenantTx, id: string): Promise<RetentionPolicyRow | undefined> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.data_retention_policy where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Locks a draft for publication. A version that is not there is 404; one that is not a draft any more (published, or replaced by a newer
   * draft) is 409 VERSION_CONFLICT with the version it has now, whatever the version the caller sent; a stale version is 409 VERSION_CONFLICT.
   */
  async lockDraft(tx: TenantTx, id: string, expectedVersion: number): Promise<RetentionPolicyRow> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.data_retention_policy where id = $1::uuid for update`, [id]);
    const policy = rows[0] === undefined ? undefined : toRow(rows[0]);
    if (policy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (policy.status !== 'Draft' || policy.version !== expectedVersion) throw versionConflict(policy.version);
    return policy;
  }

  /**
   * Publishes a locked draft: the author never publishes (BR-ADM-01), a version that starts in the future waits (it would leave the class
   * with no rule until its day), and the version in force for the class is superseded in the same step.
   */
  async publish(tx: TenantTx, draft: RetentionPolicyRow, actor: string, today: string): Promise<{ version: number; supersededId: string | undefined }> {
    if (actor === draft.createdBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (draft.effectiveFrom > today) {
      throw new DomainError('RETENTION_POLICY_INVALID', 422, 'effective_from', { extensions: { errors: [retentionFinding('effective_from', 'DATE_FUTURE')] } });
    }
    const superseded = await tx.query<{ id: string }>(
      "update machvon.data_retention_policy set status = 'Superseded', version = version + 1 where record_class = $1 and status = 'Published' returning id",
      [draft.recordClass],
    );
    const published = await tx.query<{ version: string }>(
      `update machvon.data_retention_policy set status = 'Published', approved_by = $2::uuid, published_at = now(), version = version + 1
        where id = $1::uuid returning version::text as version`,
      [draft.id, actor],
    );
    return { version: Number((published[0] as { version: string }).version), supersededId: superseded[0]?.id };
  }

  /** Keyset page: by record class, then the newest revision first. The caller asks for one more row than it shows. */
  async list(tx: TenantTx, request: { limit: number; after: RetentionPageAnchor | undefined }): Promise<RetentionPolicyRow[]> {
    const after = request.after;
    if (after !== undefined && !/^[a-z][a-z0-9_]{1,79}\|\d{1,9}$/.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const [afterClass, afterRevision] = after === undefined ? [null, null] : after.code.split('|');
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.data_retention_policy
        where ($1::text is null or (record_class, -revision) > ($1::text, -$2::int))
        order by record_class, revision desc
        limit $3`,
      [afterClass ?? null, afterRevision ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** The cursor of a row of `list`. */
  cursorOf(row: RetentionPolicyRow): RetentionPageAnchor {
    return { code: `${row.recordClass}|${row.revision}`, id: row.id };
  }

  /** The version in force of each record class that has one, by class. */
  async published(tx: TenantTx): Promise<Map<string, RetentionPolicyRow>> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.data_retention_policy where status = 'Published'`);
    return new Map(rows.map((row) => [row.record_class, toRow(row)]));
  }

  /** The platform baseline for a record class (the catalogue key is the class in upper case), or undefined when the catalogue names none. */
  async platformBaseline(tx: TenantTx, recordClass: string): Promise<PlatformBaseline | undefined> {
    const rows = await tx.query<{ attributes: Record<string, unknown> }>(
      `select v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id and v.status = 'EFFECTIVE'
        where r.master_type = 'RETENTION_POLICY' and r.business_key = $1 and r.status = 'EFFECTIVE'
        order by v.revision desc limit 1`,
      [recordClass.toUpperCase()],
    );
    const attributes = rows[0]?.attributes;
    if (attributes === undefined) return undefined;
    const years = typeof attributes.retention_years === 'number' ? attributes.retention_years : undefined;
    return { years, permanent: attributes.permanent === true };
  }

  private async assertAtLeastPlatformBaseline(tx: TenantTx, content: RetentionPolicyContent): Promise<void> {
    const baseline = await this.platformBaseline(tx, content.record_class);
    if (baseline === undefined) return;
    const years = content.retention_years ?? undefined;
    const keepsForEver = content.retention_basis === 'PERMANENT';
    const shorter = baseline.permanent ? !keepsForEver : !keepsForEver && baseline.years !== undefined && (years ?? 0) < baseline.years;
    if (shorter) {
      throw new DomainError('RETENTION_POLICY_INVALID', 422, 'retention_years', { extensions: { errors: [retentionFinding('retention_years', 'BELOW_PLATFORM_BASELINE')] } });
    }
  }
}

