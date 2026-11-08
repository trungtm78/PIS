import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the investigation and the screening of contractors (VND-3) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorInvestigationFixture {
  scanId: string;
  leadId: string;
  importId: string;
  entryId: string;
  runId: string;
  hitId: string;
}

const make = (variant: 'a0' | 'b0'): VendorInvestigationFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d4-${String(n).padStart(12, '0')}`;
  return { scanId: id(1), leadId: id(2), importId: id(3), entryId: id(4), runId: id(5), hitId: id(6) };
};

export const VENDOR_INVESTIGATION_FIXTURES: Readonly<Record<TenantName, VendorInvestigationFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** Seeds one scan with a lead, and one list import with an entry, a run and a hit, for a tenant. */
export async function seedVendorInvestigationFixtures(client: Client, tenant: TenantName, context: { tenantId: string; contractorId: string; membershipId: string }): Promise<void> {
  const f = VENDOR_INVESTIGATION_FIXTURES[tenant];
  const { tenantId, contractorId, membershipId } = context;
  await client.query(
    `insert into machvon.vendor_link_scan (tenant_id, id, trigger_kind, started_at, finished_at, parties, links, clusters, ignored_keys, packages, leads_new, leads_reopened, leads_updated, policy_versions)
     values ($1, $2, 'JOB', now(), now(), 1, 0, 0, 0, 0, 1, 0, 0, '{}'::jsonb) on conflict do nothing`,
    [tenantId, f.scanId],
  );
  await client.query(
    `insert into machvon.vendor_investigation_lead (tenant_id, id, kind, lead_key, contractor_ids, package_ids, rank, evidence, evidence_kinds, status, scan_id)
     values ($1, $2, 'LINK_CLUSTER', $3, array[$4]::uuid[], '{}', 80, '{}'::jsonb, array['ADDRESS'], 'NEW', $5) on conflict do nothing`,
    [tenantId, f.leadId, hash(tenant === 'TNT-A' ? '5' : '6'), contractorId, f.scanId],
  );
  await client.query(
    `insert into machvon.screening_list_import (tenant_id, id, source, as_of, reference, content_sha256, entry_count, imported_by)
     values ($1, $2, 'WORLD_BANK', date '2026-11-01', $3, $4, 1, $5) on conflict do nothing`,
    [tenantId, f.importId, `Isolation list of ${tenant}`, hash(tenant === 'TNT-A' ? '7' : '8'), membershipId],
  );
  await client.query(
    `insert into machvon.screening_list_entry (tenant_id, id, source, source_ref, name, tax_code, row_hash, import_id)
     values ($1, $2, 'WORLD_BANK', 'ISO-1', $3, '0199999999', $4, $5) on conflict do nothing`,
    [tenantId, f.entryId, `Isolation listed party of ${tenant}`, hash('9'), f.importId],
  );
  await client.query(
    `insert into machvon.screening_run (tenant_id, id, trigger_kind, started_at, finished_at, contractors, entries, hits_new, hits_reopened, hits_resolved, holds, policy_version)
     values ($1, $2, 'MANUAL', now(), now(), 1, 1, 1, 0, 0, 0, 'builtin') on conflict do nothing`,
    [tenantId, f.runId],
  );
  await client.query(
    `insert into machvon.screening_hit (tenant_id, id, contractor_id, source, entry_ref, list_entry_id, entry_row_hash, entry_name, score, basis, hold, status, run_id)
     values ($1, $2, $3, 'WORLD_BANK', 'ISO-1', $4, $5, $6, 60, array['NAME'], false, 'PENDING', $7) on conflict do nothing`,
    [tenantId, f.hitId, contractorId, f.entryId, hash('9'), `Isolation listed party of ${tenant}`, f.runId],
  );
}
