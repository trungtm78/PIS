import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** The project a section or a parcel lies in: its stage and the two units its scope is judged by. */
export interface LandProjectRef {
  id: string;
  status: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

/** The kinds of master entry that name a ward or an area: the territory of MDM a parcel lies in. */
export const WARD_MASTER_TYPES: readonly string[] = ['ADMIN_UNIT', 'AREA'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * What land clearance reads of the modules it builds on, and nothing it writes there: the project register (PRJ), the units of the organisation
 * (ADM), the contract register (CTR), the territory of the master data (MDM) and the documents (DOC). Every read is by id and by tenant (row-level
 * security); each answers one question the commands of LND ask, so a change in those modules lands in one place.
 */
export class LndLandSource {
  /** The project with the units its scope is judged by; undefined when it does not exist in the tenant. */
  async projectRef(tx: TenantTx, projectId: string): Promise<LandProjectRef | undefined> {
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

  /** An active unit of the organisation with the path its scope is judged by; undefined when it does not exist in the tenant or is not active. */
  async unitRef(tx: TenantTx, unitId: string): Promise<{ id: string; path: string } | undefined> {
    const rows = await tx.query<{ id: string; path: string }>("select id, path from machvon.organization_unit where id = $1::uuid and status = 'Active'", [unitId]);
    return rows[0];
  }

  /** The active unit that has this code, for a file that names its units by code. */
  async unitByCode(tx: TenantTx, code: string): Promise<{ id: string; path: string } | undefined> {
    const rows = await tx.query<{ id: string; path: string }>("select id, path from machvon.organization_unit where code = $1 and status = 'Active'", [code]);
    return rows[0];
  }

  /** A contract is fit to receive a section when it exists and is a contract of the same project. */
  async assertContractOfProject(tx: TenantTx, contractId: string, projectId: string, field: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.contract where id = $1::uuid and project_id = $2::uuid', [contractId, projectId]);
    // A contract of another tenant or another project is indistinguishable from one that does not exist.
    if (rows[0] === undefined) throw invalid(field);
  }

  /** A compensation plan is fit to be named by a stage when it exists and is a plan of the same project. */
  async assertPlanOfProject(tx: TenantTx, planId: string, projectId: string, field: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.compensation_plan where id = $1::uuid and project_id = $2::uuid', [planId, projectId]);
    if (rows[0] === undefined) throw invalid(field);
  }

  /** The section of a project that has this code; undefined when there is none. */
  async sectionByCode(tx: TenantTx, projectId: string, code: string): Promise<{ id: string } | undefined> {
    const rows = await tx.query<{ id: string }>('select id from machvon.land_handover_section where project_id = $1::uuid and code = $2', [projectId, code]);
    return rows[0];
  }

  /** The section of a project by its id; undefined when it does not exist in the project. */
  async sectionOfProject(tx: TenantTx, projectId: string, sectionId: string): Promise<{ id: string } | undefined> {
    const rows = await tx.query<{ id: string }>('select id from machvon.land_handover_section where project_id = $1::uuid and id = $2::uuid', [projectId, sectionId]);
    return rows[0];
  }

  /**
   * The territory entry a parcel names: a published version of a ward or an area that is in force on `today` and whose record is not retired.
   * A version that does not exist or is of another type is a fault of the request; one that is no longer in force is MASTER_NOT_EFFECTIVE.
   */
  async assertWardInForce(tx: TenantTx, versionId: string, today: string, field: string): Promise<void> {
    const rows = await tx.query<{ master_type: string; record_status: string; status: string; published: boolean; in_range: boolean }>(
      `select r.master_type, r.status as record_status, v.status, (v.published_at is not null) as published,
              (v.valid_from <= $2::date and (v.valid_until is null or v.valid_until > $2::date)) as in_range
         from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id
        where v.id = $1::uuid`,
      [versionId, today],
    );
    const row = rows[0];
    if (row === undefined || !WARD_MASTER_TYPES.includes(row.master_type)) throw invalid(field);
    const inForce = row.published && row.in_range && ['APPROVED', 'EFFECTIVE'].includes(row.status) && !['RETIRED', 'MERGED'].includes(row.record_status);
    if (!inForce) throw new DomainError('MASTER_NOT_EFFECTIVE', 422, field);
  }

  /** A document version of the tenant that the scan found clean; the notice of a recovery names one as its evidence. */
  async assertCleanDocumentVersion(tx: TenantTx, documentVersionId: string, field: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (rows[0] === undefined) throw invalid(field);
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, field);
  }
}
