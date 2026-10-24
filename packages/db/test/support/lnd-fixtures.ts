import { Client } from 'pg';
import { id, memberId, unitId } from './authz-fixtures';

/** The rows that land clearance stands on: a project of two units, a contract of it, clean and unclean documents and the territory a parcel names. */
export interface LndWorld {
  project: string;
  otherProject: string;
  contract: string;
  /** A contract of another project of the same tenant. */
  foreignContract: string;
  /** A document version that the scan found clean, and one that is still pending. */
  cleanDocument: string;
  pendingDocument: string;
  /** A published ward in force, and one whose record is retired. */
  ward: string;
  retiredWard: string;
  /** A published version of a master entry that is not a territory. */
  notAWard: string;
}

export function lndWorld(family: number): LndWorld {
  return {
    project: id(family, 1),
    otherProject: id(family, 2),
    contract: id(family, 3),
    foreignContract: id(family, 4),
    cleanDocument: id(family, 31),
    pendingDocument: id(family, 32),
    ward: id(family, 41),
    retiredWard: id(family, 42),
    notAWard: id(family, 43),
  };
}

/**
 * Seeds the world of land clearance for a tenant as the superuser, with the foreign keys to the modules that land clearance only reads switched
 * off. `actor` is the membership that wrote the rows; `owner` and `investor` are the numbers of the units of the projects.
 */
export async function seedLndWorld(adminUrl: string, tenant: string, family: number, actor: number, owner: number, investor: number): Promise<LndWorld> {
  const world = lndWorld(family);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [project, code] of [
      [world.project, 'PRJ-L-001'],
      [world.otherProject, 'PRJ-L-002'],
    ] as const) {
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Project with land clearance', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, project, code, unitId(owner), unitId(investor), id(family, 44)],
      );
    }
    await client.query('insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, $4, $5, $6)', [
      tenant,
      id(family, 50),
      '0100000050',
      'Land Builders',
      'VERIFIED',
      id(family, 47),
    ]);
    for (const [contract, project, code] of [
      [world.contract, world.project, 'HD-L-001'],
      [world.foreignContract, world.otherProject, 'HD-L-002'],
    ] as const) {
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, date '2026-01-01', date '2026-01-01', date '2027-06-30')`,
        [tenant, contract, project, id(family, 51), id(family, 50), code],
      );
    }
    await client.query(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'TB', 'Recovery notice', 'INTERNAL', $3, $3)`, [
      tenant,
      id(family, 47),
      memberId(actor),
    ]);
    for (const [version, scan, key] of [
      [world.cleanDocument, 'CLEAN', 'notice'],
      [world.pendingDocument, 'PENDING', 'pending'],
    ] as const) {
      await client.query(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, $5, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', $6, '{}'::jsonb, 'RENDERED_FINAL')`,
        [tenant, version, id(family, 47), `tenants/lnd/${key}.pdf`, scan === 'CLEAN' ? 1 : 2, scan],
      );
    }
    for (const [version, type, status, key] of [
      [world.ward, 'ADMIN_UNIT', 'EFFECTIVE', 'WARD-1'],
      [world.retiredWard, 'ADMIN_UNIT', 'RETIRED', 'WARD-OLD'],
      [world.notAWard, 'SECTOR', 'EFFECTIVE', 'SECTOR-1'],
    ] as const) {
      await client.query(
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, $5, $6, $6)`,
        [tenant, version, type, key, status, memberId(actor)],
      );
      await client.query(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $2, $3, $4, 1, $4, '{}'::jsonb, date '2020-01-01', 'EFFECTIVE', 'TENANT', now(), $5, $5)`,
        [tenant, version, type, key, memberId(actor)],
      );
    }
  } finally {
    await client.end();
  }
  return world;
}
