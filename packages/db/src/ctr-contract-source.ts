import type { TenantTx } from './tenant-database.ts';

/** The project a contract is written under: its stage and the two units its scope is judged by. */
export interface ProjectRef {
  id: string;
  status: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

/** What procurement decided for a package: the contractor that won and the price that was awarded. */
export interface PackageAward {
  contractorId: string;
  priceVnd: string;
}

/** The facts of a package that a contract depends on. */
export interface PackageFacts {
  id: string;
  projectId: string;
  /** The price of the package as approved: an exact decimal string in VND, the ceiling of a contract under it (BR-CTR-01). */
  budgetVnd: string;
  /** Null until a result of procurement that awarded the package has been approved. */
  award: PackageAward | null;
}

interface PackageSql {
  id: string;
  project_id: string;
  budget_vnd: string;
  winner_contractor_id: string | null;
  award_price_vnd: string | null;
}

/**
 * What the contract register reads of the modules it depends on, and nothing it writes there: the project (PRJ), the package and its approved
 * result (BID) and the plan of capital of the project (CAP). The reads are by id and by tenant (row-level security), and each answers one
 * question the commands of the register ask, so a change in those modules lands in one place.
 */
export class CtrContractSource {
  /** The project with the units its scope is judged by; undefined when it does not exist in the tenant. */
  async projectRef(tx: TenantTx, projectId: string): Promise<ProjectRef | undefined> {
    const rows = await tx.query<{ id: string; status: string; owner_id: string; owner_path: string; investor_id: string | null; investor_path: string | null }>(
      `select p.id, p.status, ou.id as owner_id, ou.path as owner_path, iu.id as investor_id, iu.path as investor_path
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where p.id = $1::uuid`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      status: row.status,
      ownerUnit: { id: row.owner_id, path: row.owner_path },
      investorUnit: row.investor_id === null || row.investor_path === null ? null : { id: row.investor_id, path: row.investor_path },
    };
  }

  /**
   * The package with the result that awarded it. The result counts only when it is APPROVED as AWARDED (a draft, a rejected or a cancelled
   * result awards nothing); when several were approved over time the latest decides.
   */
  async packageFacts(tx: TenantTx, packageId: string): Promise<PackageFacts | undefined> {
    const rows = await tx.query<PackageSql>(
      `select pk.id, pk.project_id, pk.budget_vnd::text as budget_vnd, r.winner_contractor_id, r.award_price_vnd::text as award_price_vnd
         from machvon.procurement_package pk
         left join lateral (
           select winner_contractor_id, award_price_vnd
             from machvon.procurement_result
            where tenant_id = pk.tenant_id and package_id = pk.id and outcome = 'AWARDED' and status = 'APPROVED'
            order by approved_at desc nulls last, id desc
            limit 1
         ) r on true
        where pk.id = $1::uuid`,
      [packageId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const award = row.winner_contractor_id === null || row.award_price_vnd === null ? null : { contractorId: row.winner_contractor_id, priceVnd: row.award_price_vnd };
    return { id: row.id, projectId: row.project_id, budgetVnd: row.budget_vnd, award };
  }

  /** Whether the capital plan of the project is approved: a version of the plan for it that is APPROVED or already PUBLISHED. */
  async hasApprovedCapitalPlan(tx: TenantTx, projectId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>(
      `select exists (select 1 from machvon.plan_version where project_id = $1::uuid and status in ('APPROVED', 'PUBLISHED')) as found`,
      [projectId],
    );
    return rows[0]?.found === true;
  }

  /** Whether a version of a document exists in the tenant and the scan of its file found it clean: what a guarantee or its check may rest on (a file still waiting for the scan, or infected, is no evidence). */
  async cleanDocumentVersionExists(tx: TenantTx, documentVersionId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>("select exists (select 1 from machvon.document_version where id = $1::uuid and scan_status = 'CLEAN') as found", [documentVersionId]);
    return rows[0]?.found === true;
  }

  /** Whether a version of a document exists in the tenant. */
  async documentVersionExists(tx: TenantTx, documentVersionId: string): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.document_version where id = $1::uuid) as found', [documentVersionId]);
    return rows[0]?.found === true;
  }
}
