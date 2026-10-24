import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { id, memberId, unitId } from './authz-fixtures';

/** The rows a Treasury statement stands on: two projects, a Treasury office entry mapped by a crosswalk, a contract, and two documents. */
export interface PayWorld {
  projectA: string;
  projectCodeA: string;
  projectB: string;
  projectCodeB: string;
  /** The entry of MDM-16 that the code `KB-1` is mapped to. */
  office: string;
  /** An entry of another kind (a sector) that the code `KB-SECTOR` is wrongly mapped to. */
  sector: string;
  contractA: string;
  contractB: string;
  /** A clean document version: the evidence of a manual confirmation. */
  evidence: string;
  infectedEvidence: string;
}

export function payWorld(family: number, tenant: string): PayWorld {
  const suffix = tenant.slice(-1);
  return {
    projectA: id(family, 1),
    projectCodeA: `PRJ-PAY-A-${suffix}`,
    projectB: id(family, 2),
    projectCodeB: `PRJ-PAY-B-${suffix}`,
    office: id(family, 11),
    sector: id(family, 12),
    contractA: id(family, 21),
    contractB: id(family, 22),
    evidence: id(family, 31),
    infectedEvidence: id(family, 32),
  };
}

export interface PaymentRequestSpec {
  id: string;
  project: string;
  contract: string;
  acceptance: string;
  status?: string;
  netVnd: string;
  createdBy?: number | null;
  submittedBy?: number | null;
  allocationLine?: string | null;
  planYear?: number | null;
}

async function withAdmin(adminUrl: string, work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, contracts, documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Seeds the world of a statement for a tenant as the superuser: project A is owned by `ownerUnit` and project B by `otherUnit` (so a grant on
 * one subtree reads one of them), the office entry and the wrongly mapped sector entry are EFFECTIVE, and the crosswalk maps `KB-1` to the office.
 */
export async function seedPayWorld(adminUrl: string, tenant: string, family: number, actor: number, ownerUnit: number, otherUnit: number): Promise<PayWorld> {
  const world = payWorld(family, tenant);
  await withAdmin(adminUrl, async (client) => {
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $4, 'Bridge', $6, $8, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, $5, 'Road', $7, $8, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, world.projectA, world.projectB, world.projectCodeA, world.projectCodeB, unitId(ownerUnit), unitId(otherUnit), id(family, 40)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $6, $6, $7, 'LUMP_SUM', 'VND', 'DRAFT', 1), ($1, $4, $5, $6, $6, $8, 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [tenant, world.contractA, world.projectA, world.contractB, world.projectB, id(family, 41), `HD-PAY-A-${tenant.slice(-1)}`, `HD-PAY-B-${tenant.slice(-1)}`],
      ],
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'TREASURY_OFFICE', 'KBNN-HN', 'EFFECTIVE', $4, $4), ($1, $3, 'TENANT', 'SECTOR', 'SEC-PAY', 'EFFECTIVE', $4, $4)`,
        [tenant, world.office, world.sector, memberId(actor)],
      ],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CT', 'Treasury evidence', 'INTERNAL', $3, $3)`, [tenant, id(family, 42), memberId(actor)]],
    ];
    for (const [version, scan, key] of [
      [world.evidence, 'CLEAN', 'evidence'],
      [world.infectedEvidence, 'INFECTED', 'infected'],
    ] as const) {
      statements.push([
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, $5, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', $6, '{}'::jsonb, 'RENDERED_FINAL')`,
        [tenant, version, id(family, 42), `tenants/pay/${key}.pdf`, statements.length, scan],
      ]);
    }
    for (const [sql, params] of statements) await client.query(sql, params);
  });
  await seedCrosswalk(adminUrl, tenant, actor, world.office, 'KB-1');
  await seedCrosswalk(adminUrl, tenant, actor, world.sector, 'KB-SECTOR');
  return world;
}

/** Maps a Treasury office code to an entry, as the superuser, in force from 2024-01-01 (ACTIVE). */
export async function seedCrosswalk(adminUrl: string, tenant: string, actor: number, record: string, code: string, validFrom = '2024-01-01'): Promise<string> {
  const crosswalk = randomUUID();
  await withAdmin(adminUrl, async (client) => {
    await client.query(
      `insert into machvon.master_crosswalk (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
       values ($1, $2, $3, 'TREASURY', 'AGENCY_CODE', $4, $5::date, 'MANUAL', 'ACTIVE', $6, $6)`,
      [tenant, crosswalk, record, code, validFrom, memberId(actor)],
    );
  });
  return crosswalk;
}

/** A payment request of a contract, as the superuser. A request in SENT_TREASURY (or later) holds its acceptance, as the table demands. */
export async function seedPaymentRequest(adminUrl: string, tenant: string, spec: PaymentRequestSpec): Promise<void> {
  const status = spec.status ?? 'SENT_TREASURY';
  const claims = ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'].includes(status);
  await withAdmin(adminUrl, async (client) => {
    await client.query(
      `insert into machvon.payment_request
         (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version,
          claims_acceptance, request_no, created_by, submitted_by, allocation_line_id, plan_year)
       values ($1, $2, $3, $4, $5, 'VND', $6::numeric, 0, 0, 0, $6::numeric, $7, 1, $8, $9, $10, $11, $12, $13)`,
      [
        tenant,
        spec.id,
        spec.project,
        spec.contract,
        spec.acceptance,
        spec.netVnd,
        status,
        claims,
        `HS-${spec.id.slice(-6)}`,
        spec.createdBy === undefined || spec.createdBy === null ? null : memberId(spec.createdBy),
        spec.submittedBy === undefined || spec.submittedBy === null ? null : memberId(spec.submittedBy),
        spec.allocationLine ?? null,
        spec.planYear ?? null,
      ],
    );
  });
}
