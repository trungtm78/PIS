import { Client } from 'pg';
import { id, memberId, unitId } from './authz-fixtures';

/** The rows a contract of the register stands on: a project with an approved plan, an awarded package, two verified contractors and two documents. */
export interface CtrWorld {
  project: string;
  packageId: string;
  lead: string;
  second: string;
  /** The document version a contract draft is written from. */
  document: string;
  /** Another clean document version: the evidence of a verification or of a release. */
  evidence: string;
  secondEvidence: string;
}

export function ctrWorld(family: number): CtrWorld {
  return {
    project: id(family, 1),
    packageId: id(family, 11),
    lead: id(family, 21),
    second: id(family, 22),
    document: id(family, 31),
    evidence: id(family, 32),
    secondEvidence: id(family, 33),
  };
}

/**
 * Seeds the world of a contract for a tenant as the superuser, with the foreign keys to the modules that the register only reads switched
 * off. `actor` is the membership that wrote the documents; `owner` and `investor` are the numbers of the units of the project.
 */
export async function seedCtrWorld(adminUrl: string, tenant: string, family: number, actor: number, owner: number, investor: number): Promise<CtrWorld> {
  const world = ctrWorld(family);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $4), ($1, $3, '0100000002', 'Second Builders', 'VERIFIED', $4)`,
        [tenant, world.lead, world.second, id(family, 40)],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-A-001', 'Project with a plan', $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, world.project, unitId(owner), unitId(investor), id(family, 42)],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
         values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now())`,
        [tenant, id(family, 43), world.project, id(family, 44)],
      ],
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status)
         values ($1, $2, $3, 'PKG-A-020', 50000000000, 'OPEN', 1, 'AWARDED')`,
        [tenant, world.packageId, world.project],
      ],
      [
        `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, now(), $6, $6)`,
        [tenant, id(family, 51), world.packageId, world.lead, id(family, 47), memberId(actor), memberId(actor + 1)],
      ],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract draft', 'INTERNAL', $3, $3)`, [tenant, id(family, 47), memberId(actor)]],
    ];
    for (const [version, key] of [
      [world.document, 'draft'],
      [world.evidence, 'evidence'],
      [world.secondEvidence, 'evidence-2'],
    ] as const) {
      statements.push([
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, $5, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [tenant, version, id(family, 47), `tenants/ctr/${key}.pdf`, statements.length],
      ]);
    }
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
  return world;
}
