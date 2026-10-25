import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { ScopeBuilder } from '../../src/scope-version';
import { TENANT_A, id, memberId, unitId } from './authz-fixtures';
import type { AuthzHarness } from './authz-fixtures';

export const PROVINCE = 1;
export const DEPARTMENT = 2;
export const OTHER_PROJECT_UNIT = 3;
const FAMILY = 0x96;

export const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
export const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
/** A scope that reaches exactly the given projects (the aliases of the project register: `p`). */
export const onProjects =
  (...projectIds: string[]): ScopeBuilder =>
  (first) => ({ sql: `p.id = any($${first}::uuid[])`, params: [projectIds] });

/** A moment relative to the real clock, in whole hours (the database judges "released" by its own clock). */
export const hoursFromNow = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

export async function seedAs(harness: AuthzHarness, statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
export const next = (prefix: string): string => `${prefix}-${String((counter += 1)).padStart(4, '0')}`;

export interface SeededPackage {
  projectId: string;
  projectCode: string;
  packageId: string;
  packageCode: string;
}

/** A project with one package; the package is APPROVED (open for bids) unless the options say otherwise. */
export async function seedBidPackage(harness: AuthzHarness, options: { status?: string; projectId?: string; unit?: number; budgetVnd?: string } = {}): Promise<SeededPackage> {
  const projectId = options.projectId ?? randomUUID();
  const projectCode = next('PRJ');
  const packageId = randomUUID();
  const packageCode = next('GT');
  const statements: Array<[string, unknown[]]> = [];
  if (options.projectId === undefined) {
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, projectCode, unitId(options.unit ?? DEPARTMENT), unitId(PROVINCE), id(FAMILY, 90)],
    ]);
  }
  statements.push([
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, $7::numeric, 'OPEN_BIDDING', 1, $5, 'Construction package', $6, 1)`,
    [TENANT_A, packageId, projectId, packageCode, options.status ?? 'APPROVED', memberId(1), options.budgetVnd ?? '100000000'],
  ]);
  await seedAs(harness, statements);
  return { projectId, projectCode, packageId, packageCode };
}

export async function seedMilestone(harness: AuthzHarness, packageId: string, kind: 'BID_OPENING' | 'BID_CLOSING', dates: { planned?: string; actual?: string }): Promise<void> {
  await seedAs(harness, [
    [
      `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, planned_at, actual_at, source, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 'MANUAL', $7, $7, 1)`,
      [TENANT_A, randomUUID(), packageId, kind, dates.planned ?? null, dates.actual ?? null, memberId(1)],
    ],
  ]);
}

export async function seedContractor(harness: AuthzHarness, options: { status?: string; name?: string; restricted?: boolean } = {}): Promise<string> {
  const contractorId = randomUUID();
  const taxId = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [TENANT_A, contractorId, taxId, options.name ?? next('Builders'), options.status ?? 'VERIFIED', id(FAMILY, 91)],
    ],
  ];
  if (options.restricted === true) {
    statements.push([
      `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by)
       values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2020-01-01', $5, $4, $4)`,
      [TENANT_A, randomUUID(), contractorId, memberId(1), id(FAMILY, 92)],
    ]);
  }
  await seedAs(harness, statements);
  return contractorId;
}

export interface SeededProposal {
  id: string;
  versionId: string;
}

/** A proposal row as the receipt would leave it, written past the triggers so a test can set its time and status at will. */
export async function seedProposal(
  harness: AuthzHarness,
  seeded: SeededPackage,
  contractorId: string,
  options: { releasedAt: string; status?: string; revision?: number; price?: string | null },
): Promise<SeededProposal> {
  const proposalId = randomUUID();
  const versionId = randomUUID();
  const documentId = randomUUID();
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, subject_id, created_by, updated_by)
       values ($1, $2, 'ATTACHMENT', 'BID-PROPOSAL-FILE', 'Technical proposal', 'CONFIDENTIAL', 'BID_PROPOSAL', $3, $4, $4)`,
      [TENANT_A, documentId, proposalId, memberId(1)],
    ],
    [
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage, byte_length, created_by)
       values ($1, $2, $3, 1, $4, $5, 'application/pdf', 12, 'CONFIDENTIAL', 'CLEAN', '{}'::jsonb, 'ATTACHMENT', 2048, $6)`,
      [TENANT_A, versionId, documentId, `tenants/${TENANT_A}/document/${randomUUID()}`, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), memberId(1)],
    ],
    [
      `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, created_by, version)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now(), $9::numeric, $10::timestamptz, 'CONFIDENTIAL', $11, 1)`,
      [TENANT_A, proposalId, seeded.projectId, seeded.packageId, contractorId, JSON.stringify([versionId]), options.revision ?? 1, options.status ?? 'RECEIVED', options.price === undefined ? '1234567890' : options.price, options.releasedAt, memberId(1)],
    ],
    [
      `insert into machvon.proposal_document (tenant_id, id, proposal_id, document_version_id, part, received_by) values ($1, $2, $3, $4, 'TECHNICAL', $5)`,
      [TENANT_A, randomUUID(), proposalId, versionId, memberId(1)],
    ],
  ];
  await seedAs(harness, statements);
  return { id: proposalId, versionId };
}
