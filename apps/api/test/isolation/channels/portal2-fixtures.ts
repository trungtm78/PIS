import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the registry-bound portal access and of the petition outcome (PORTAL-2) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface Portal2Fixture {
  invitationId: string;
  outcomeId: string;
  attachmentId: string;
  documentId: string;
  versionId: string;
}

const make = (variant: 'a1' | 'b1'): Portal2Fixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d6-${String(n).padStart(12, '0')}`;
  return { invitationId: id(1), outcomeId: id(2), attachmentId: id(3), documentId: id(4), versionId: id(5) };
};

export const PORTAL2_FIXTURES: Readonly<Record<TenantName, Portal2Fixture>> = { 'TNT-A': make('a1'), 'TNT-B': make('b1') };

/** Seeds one proposed invitation, one proposed outcome of the petition of the tenant and one portal file of the contractor. */
export async function seedPortal2Fixtures(
  client: Client,
  tenant: TenantName,
  context: { tenantId: string; contractorId: string; membershipId: string; unitId: string; petitionId: string },
): Promise<void> {
  const f = PORTAL2_FIXTURES[tenant];
  const { tenantId, contractorId, membershipId, unitId, petitionId } = context;
  await client.query(
    `insert into machvon.contractor_portal_invitation (tenant_id, id, contractor_id, tax_identifier, contact_email, contact_name, contact_basis, basis_reference, status, unit_id, proposed_by, proposal_expires_at)
     values ($1, $2, $3, '0100000001', $4, 'Isolation contact', 'OTHER_EVIDENCE', 'Isolation evidence', 'PROPOSED', $5, $6, now() + interval '30 days') on conflict do nothing`,
    [tenantId, f.invitationId, contractorId, `isolation-${tenant.toLowerCase()}@example.test`, unitId, membershipId],
  );
  await client.query(
    `insert into machvon.procurement_petition_outcome (tenant_id, id, petition_id, outcome, decision_ref, decision_on, status, recorded_by)
     values ($1, $2, $3, 'REJECTED', 'Isolation decision', date '2026-01-02', 'PROPOSED', $4) on conflict do nothing`,
    [tenantId, f.outcomeId, petitionId, membershipId],
  );
  await client.query(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, subject_id, created_by, updated_by)
     values ($1, $2, 'ATTACHMENT', 'VND-PORTAL-ATTACHMENT', 'Isolation portal file', 'CONFIDENTIAL', 'VND_PORTAL', $3, $4, $4) on conflict do nothing`,
    [tenantId, f.documentId, contractorId, membershipId],
  );
  await client.query(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage, byte_length, created_by)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'CONFIDENTIAL', 'CLEAN', '{}'::jsonb, 'ATTACHMENT', 100, $5) on conflict do nothing`,
    [tenantId, f.versionId, f.documentId, `tenants/${tenantId}/document/${f.versionId}`, membershipId],
  );
  await client.query(
    `insert into machvon.portal_attachment (tenant_id, id, contractor_id, document_id, document_version_id, purpose, title, mime, size_bytes, sha256, scan_verdict, uploaded_by)
     values ($1, $2, $3, $4, $5, 'OTHER', 'Isolation portal file', 'application/pdf', 100, repeat('a', 64), 'CLEAN', $6) on conflict do nothing`,
    [tenantId, f.attachmentId, contractorId, f.documentId, f.versionId, membershipId],
  );
}
