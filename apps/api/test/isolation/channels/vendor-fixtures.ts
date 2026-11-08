import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the management of contractors (VND-1) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorFixture {
  otherContractorId: string;
  ownerId: string;
  duplicateId: string;
  bankChangeId: string;
  bankAccountId: string;
  qualificationId: string;
  keyStaffId: string;
  caseId: string;
  eventId: string;
  ventureId: string;
}

const make = (variant: 'a0' | 'b0'): VendorFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d1-${String(n).padStart(12, '0')}`;
  return { otherContractorId: id(1), ownerId: id(2), duplicateId: id(3), bankChangeId: id(4), bankAccountId: id(5), qualificationId: id(6), keyStaffId: id(7), caseId: id(8), eventId: id(9), ventureId: id(10) };
};

export const VENDOR_FIXTURES: Readonly<Record<TenantName, VendorFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

export interface VendorSeedContext {
  tenantId: string;
  contractorId: string;
  actorId: string;
  membershipId: string;
  documentId: string;
}

/** Seeds one object of each kind for a tenant. The contractor itself is the one the contractor fixture made. */
export async function seedVendorFixtures(client: Client, tenant: TenantName, context: VendorSeedContext): Promise<void> {
  const f = VENDOR_FIXTURES[tenant];
  const { tenantId, contractorId, actorId, membershipId, documentId } = context;
  const lowFirst = contractorId < f.otherContractorId;
  await client.query(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by)
     values ($1, $2, $3, $4, 'UNVERIFIED', $5, $6, $6) on conflict do nothing`,
    [tenantId, f.otherContractorId, tenant === 'TNT-A' ? '0155555555' : '0166666666', `Isolation second contractor of ${tenant}`, documentId, actorId],
  );
  await client.query(
    `insert into machvon.contractor_owner (tenant_id, id, contractor_id, owner_kind, owner_name, name_key, share_pct, beneficial_owner, created_by, updated_by)
     values ($1, $2, $3, 'PERSON', $4, $5, 10, false, $6, $6) on conflict do nothing`,
    [tenantId, f.ownerId, contractorId, `Isolation owner of ${tenant}`, hash('1'), actorId],
  );
  await client.query(
    `insert into machvon.contractor_duplicate_suggestion (tenant_id, id, contractor_a_id, contractor_b_id, score, signals)
     values ($1, $2, $3, $4, 70, array['ADDRESS', 'PHONE']) on conflict do nothing`,
    [tenantId, f.duplicateId, lowFirst ? contractorId : f.otherContractorId, lowFirst ? f.otherContractorId : contractorId],
  );
  await client.query(
    `insert into machvon.contractor_bank_change_request (tenant_id, id, contractor_id, bank_name, account_holder, holder_matches_legal_name, account_no_enc, account_no_masked, account_no_key, reason, evidence_document_id, requested_by, expires_at)
     values ($1, $2, $3, 'Isolation bank', $4, true, decode('00', 'hex'), '****0000', $5, 'Isolation change of account of the contractor', $6, $7, now() + interval '30 days') on conflict do nothing`,
    [tenantId, f.bankChangeId, contractorId, `Isolation holder of ${tenant}`, hash('2'), documentId, membershipId],
  );
  await client.query(
    `insert into machvon.contractor_bank_account (tenant_id, id, contractor_id, bank_name, account_holder, holder_matches_legal_name, account_no_enc, account_no_masked, account_no_key, state, effective_after, change_request_id, created_by)
     values ($1, $2, $3, 'Isolation bank', $4, true, decode('00', 'hex'), '****0000', $5, 'ACTIVE', now(), $6, $7) on conflict do nothing`,
    [tenantId, f.bankAccountId, contractorId, `Isolation holder of ${tenant}`, hash('3'), f.bankChangeId, actorId],
  );
  await client.query(
    `insert into machvon.contractor_qualification (tenant_id, id, contractor_id, kind, certificate_no, grade, issuer, issued_on, expires_on, document_id, created_by, updated_by)
     values ($1, $2, $3, 'CONSTRUCTION_ACTIVITY', $4, 'II', 'Isolation issuer', date '2025-01-01', date '2030-01-01', $5, $6, $6) on conflict do nothing`,
    [tenantId, f.qualificationId, contractorId, `ISO-CERT-${tenant}`, documentId, actorId],
  );
  await client.query(
    `insert into machvon.contractor_key_staff (tenant_id, id, contractor_id, staff_role, person_name, person_key, qualification_title, issued_on, expires_on, document_id, created_by, updated_by)
     values ($1, $2, $3, 'PROJECT_MANAGER', $4, $5, 'Isolation qualification', date '2025-01-01', date '2030-01-01', $6, $7, $7) on conflict do nothing`,
    [tenantId, f.keyStaffId, contractorId, `Isolation person of ${tenant}`, hash('4'), documentId, actorId],
  );
  await client.query(
    `insert into machvon.restriction_case (tenant_id, id, case_no, subject_kind, contractor_id, trigger_kind, violation_groups, violation_summary, violation_on, proposed_by, received_on, decide_by, policy_version)
     values ($1, $2, 'RC-2026-00001', 'CONTRACTOR', $3, 'OWN_INITIATIVE', array['GROUP_3'], 'Isolation case of a debarment of the contractor', date '2026-10-01', $4, date '2026-10-02', now() + interval '10 days', 'builtin') on conflict do nothing`,
    [tenantId, f.caseId, contractorId, membershipId],
  );
  await client.query(
    `insert into machvon.contractor_reputation_event (tenant_id, id, contractor_id, behaviour_code, event_on, description, recorded_by, post_due_at, deadline_policy_version)
     values ($1, $2, $3, 'NO_BID_SECURITY', date '2026-10-01', 'Isolation event of bid conduct of the contractor', $4, now() + interval '5 days', 'builtin') on conflict do nothing`,
    [tenantId, f.eventId, contractorId, membershipId],
  );
  await client.query(`insert into machvon.joint_venture (tenant_id, id, name, lead_contractor_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) on conflict do nothing`, [tenantId, f.ventureId, `Isolation venture of ${tenant}`, contractorId, actorId]);
  // Both members in one statement: the check of the shares is deferred to the end of the transaction of the statement.
  await client.query(
    `insert into machvon.joint_venture_member (tenant_id, id, joint_venture_id, contractor_id, share_pct, is_lead) values ($1, gen_random_uuid(), $2, $3, 60, true), ($1, gen_random_uuid(), $2, $4, 40, false) on conflict do nothing`,
    [tenantId, f.ventureId, contractorId, f.otherContractorId],
  );
}
