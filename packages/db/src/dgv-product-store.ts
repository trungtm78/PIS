import { DomainError, assertProductDecision, nextProductStatus, versionConflict } from '@machvon/kernel';
import type { ProductDecisionInput, ProductStatus } from '@machvon/kernel';
import { DATASET_VISIBLE, LATEST_RUN_JOIN, QUALITY_BADGE_SQL } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The data products and their certification (ST-DGV-009, DGV 3.1 F9, DGV-18). A product is a set of datasets; somebody other than its owner certifies it, and only while every dataset of it has a published contract and
 * a latest run that passed. A certification has a last day; the day after it the product is PROVISIONAL again (`expire`, the job `dgv-product-cert-expiry`).
 */
export const DATA_PRODUCT_RESOURCE = 'data_product';
const VIETNAM_DAY = "(now() at time zone 'Asia/Ho_Chi_Minh')::date::text";

export interface CertifiedProduct {
  id: string;
  code: string;
  datasetIds: string[];
  previous: ProductStatus;
  status: ProductStatus;
  expiresOn: string | null;
  evidenceCount: number;
  version: number;
}

export interface LapsedProduct {
  id: string;
  code: string;
  ownerId: string;
  expiredOn: string;
  version: number;
}

export interface ProductDataset {
  id: string;
  datasetCode: string;
  title: string;
  contractPublished: boolean;
  qualityBadge: string;
}

export interface ProductLine {
  id: string;
  code: string;
  title: string;
  owner: { membershipId: string; displayName: string | null };
  datasets: ProductDataset[];
  /** Datasets of the product that the caller may not see: counted, never named. */
  datasetsHidden: number;
  status: ProductStatus;
  certifiedBy: { membershipId: string; displayName: string | null } | null;
  certifiedAt: string | null;
  expiresOn: string | null;
  evidenceCount: number;
  revokeReason: string | null;
  version: number;
}

interface LockedSql {
  code: string;
  owner_user_id: string;
  dataset_ids: string[];
  certification_status: ProductStatus;
  version: string;
  today: string;
}

interface GateSql {
  id: string;
  dataset_code: string;
  published: boolean;
  badge: string;
}

interface LineSql {
  id: string;
  code: string;
  title: string;
  owner_user_id: string;
  owner_name: string | null;
  dataset_ids: string[];
  certification_status: ProductStatus;
  certified_by: string | null;
  certified_name: string | null;
  certified_at: string | null;
  certification_expires_on: string | null;
  evidence_count: number;
  revoke_reason: string | null;
  version: string;
}

interface DatasetSql {
  id: string;
  dataset_code: string;
  title: string;
  published: boolean;
  badge: string;
}

const PUBLISHED_CONTRACT_SQL = "exists (select 1 from machvon.dataset_contract c where c.tenant_id = d.tenant_id and c.dataset_id = d.id and c.status = 'PUBLISHED')";

export class DgvProductStore {
  /**
   * Records the decision of somebody on a product, against the version they read. The order of the refusals: 404 (no such product), 409 `VERSION_CONFLICT`, 409 `PRODUCT_STATE_INVALID`, 403 `SELF_APPROVAL_DENIED`,
   * 422 on the fields, then for a certification 422 `CONTRACT_NOT_PUBLISHED` (a dataset of the product has no published contract) and 422 `QUALITY_NOT_PASSED` (the latest finished run of a dataset did not
   * pass, or there is none, or it is older than the freshness the dataset promises). The answer counts the datasets in default and names none: the person who certifies may not see them all.
   */
  async certify(tx: TenantTx, id: string, expectedVersion: number, input: ProductDecisionInput, actor: string): Promise<CertifiedProduct> {
    const rows = await tx.query<LockedSql>(
      `select code, owner_user_id, dataset_ids, certification_status, version::text as version, ${VIETNAM_DAY} as today from machvon.data_product where id = $1::uuid for update`,
      [id],
    );
    const locked = rows[0];
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const version = Number(locked.version);
    if (version !== expectedVersion) throw versionConflict(version);
    const status = nextProductStatus(locked.certification_status, input.decision);
    assertProductDecision(input, locked.owner_user_id, actor, locked.today);
    if (input.decision === 'CERTIFIED') await this.assertReady(tx, locked.dataset_ids);
    const certified = input.decision === 'CERTIFIED';
    await tx.query(
      `update machvon.data_product
          set certification_status = $2,
              certified_by = case when $3::boolean then $4::uuid else certified_by end,
              certified_at = case when $3::boolean then now() else certified_at end,
              certification_expires_on = case when $3::boolean then $5::date else certification_expires_on end,
              evidence_refs = case when $2 <> 'REVOKED' then $6::jsonb else evidence_refs end,
              revoke_reason = case when $2 = 'REVOKED' then $7 else revoke_reason end,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, status, certified, actor, input.expiresOn ?? null, JSON.stringify(input.evidenceRefs), input.reason.trim()],
    );
    const evidence = status === 'REVOKED' ? await this.evidenceCount(tx, id) : input.evidenceRefs.length;
    return { id, code: locked.code, datasetIds: locked.dataset_ids, previous: locked.certification_status, status, expiresOn: certified ? (input.expiresOn ?? null) : null, evidenceCount: evidence, version: version + 1 };
  }

  /**
   * The products whose last day has gone, in Vietnamese time, become PROVISIONAL again; the certifier, the day and the evidence stay on the row for whoever asks. Returns the ones changed now, so that running it again
   * (or every hour) announces nothing twice.
   */
  async expire(tx: TenantTx, now: Date, actor: string): Promise<LapsedProduct[]> {
    const rows = await tx.query<{ id: string; code: string; owner_user_id: string; expired_on: string; version: string }>(
      `update machvon.data_product
          set certification_status = 'PROVISIONAL', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where certification_status = 'CERTIFIED' and certification_expires_on < ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date
        returning id, code, owner_user_id, certification_expires_on::text as expired_on, version::text as version`,
      [now.toISOString(), actor],
    );
    return rows.map((row) => ({ id: row.id, code: row.code, ownerId: row.owner_user_id, expiredOn: row.expired_on, version: Number(row.version) }));
  }

  /** The products by code, each with the datasets the caller may see and what stands between them and a certification (a published contract, a passing run). */
  async list(tx: TenantTx, viewer: DatasetViewer): Promise<ProductLine[]> {
    const products = await tx.query<LineSql>(
      `select p.id, p.code, p.title, p.owner_user_id, od.display_name as owner_name, p.dataset_ids, p.certification_status, p.certified_by, cd.display_name as certified_name,
              to_char(p.certified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as certified_at, p.certification_expires_on::text, jsonb_array_length(p.evidence_refs) as evidence_count,
              p.revoke_reason, p.version::text as version
         from machvon.data_product p
         left join machvon.tenant_user_directory od on od.tenant_id = p.tenant_id and od.membership_id = p.owner_user_id
         left join machvon.tenant_user_directory cd on cd.tenant_id = p.tenant_id and cd.membership_id = p.certified_by
        order by p.code, p.id`,
    );
    const wanted = [...new Set(products.flatMap((product) => product.dataset_ids))];
    const datasets =
      wanted.length === 0
        ? []
        : await tx.query<DatasetSql>(
            `select d.id, d.dataset_code, d.title, ${PUBLISHED_CONTRACT_SQL} as published, ${QUALITY_BADGE_SQL} as badge
               from machvon.dataset d ${LATEST_RUN_JOIN}
              where d.id = any($3::uuid[]) and ${DATASET_VISIBLE}`,
            [viewer.membershipId, [...viewer.roleCodes], wanted],
          );
    const seen = new Map(datasets.map((row) => [row.id, { id: row.id, datasetCode: row.dataset_code, title: row.title, contractPublished: row.published, qualityBadge: row.badge }]));
    return products.map((row) => {
      const visible = row.dataset_ids.flatMap((datasetId) => seen.get(datasetId) ?? []);
      return {
        id: row.id,
        code: row.code,
        title: row.title,
        owner: { membershipId: row.owner_user_id, displayName: row.owner_name },
        datasets: visible,
        datasetsHidden: row.dataset_ids.length - visible.length,
        status: row.certification_status,
        certifiedBy: row.certified_by === null ? null : { membershipId: row.certified_by, displayName: row.certified_name },
        certifiedAt: row.certified_at,
        expiresOn: row.certification_expires_on,
        evidenceCount: row.evidence_count,
        revokeReason: row.revoke_reason,
        version: Number(row.version),
      };
    });
  }

  private async assertReady(tx: TenantTx, datasetIds: readonly string[]): Promise<void> {
    const rows = await tx.query<GateSql>(
      `select d.id, d.dataset_code, ${PUBLISHED_CONTRACT_SQL} as published, ${QUALITY_BADGE_SQL} as badge
         from machvon.dataset d ${LATEST_RUN_JOIN}
        where d.id = any($1::uuid[])`,
      [datasetIds],
    );
    const found = new Set(rows.map((row) => row.id));
    const unnamed = datasetIds.filter((datasetId) => !found.has(datasetId));
    const withoutContract = [...unnamed, ...rows.filter((row) => !row.published).map((row) => row.dataset_code)];
    if (withoutContract.length > 0) throw new DomainError('CONTRACT_NOT_PUBLISHED', 422, 'dataset_ids', { extensions: { datasets: withoutContract.length } });
    const notPassed = rows.filter((row) => row.badge !== 'PASSED').map((row) => row.dataset_code);
    if (notPassed.length > 0) throw new DomainError('QUALITY_NOT_PASSED', 422, 'dataset_ids', { extensions: { datasets: notPassed.length } });
  }

  private async evidenceCount(tx: TenantTx, id: string): Promise<number> {
    const rows = await tx.query<{ count: number }>('select jsonb_array_length(evidence_refs) as count from machvon.data_product where id = $1::uuid', [id]);
    return rows[0]?.count ?? 0;
  }
}
