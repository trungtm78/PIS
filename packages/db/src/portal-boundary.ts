import type { TenantTx } from './tenant-database.ts';

/**
 * The boundary of the contractor portal in the database (VND-3, migration V2446; docs/vendor-investigation.md section 5). The portal is a separate access path: it runs in the usual tenant transaction and sets
 * `app.portal_contractor_id` to the contractor its guest membership is bound to (never a value the caller sends). While the setting is present, the tables of ONE contractor answer that contractor's rows only, and
 * the tables of the investigation, the debarment register, the accounts and the reputation ledger answer nothing and accept nothing. Without it (staff and jobs) the policy is true. The lists below are the exact
 * lists of the migration; the catalogue test (`rlsReport`) holds the database to them.
 */
export const PORTAL_SETTING = 'app.portal_contractor_id';
export const PORTAL_POLICY = 'portal_boundary';

/** Tables that hold data of one contractor, and the column that names it. */
export const PORTAL_CONTRACTOR_TABLES: Readonly<Record<string, string>> = {
  contractor: 'id',
  contractor_owner: 'contractor_id',
  contractor_qualification: 'contractor_id',
  contractor_key_staff: 'contractor_id',
  contractor_performance: 'contractor_id',
  contractor_portal_request: 'contractor_id',
  contractor_portal_request_event: 'contractor_id',
  contractor_reconfirmation: 'contractor_id',
  contractor_remediation_plan: 'contractor_id',
  contractor_remediation_action: 'contractor_id',
  contractor_remediation_event: 'contractor_id',
  portal_attachment: 'contractor_id',
};

/** Tables the portal path never reads and never writes. */
export const PORTAL_DENIED_TABLES: readonly string[] = [
  'red_flag_finding',
  'red_flag_review',
  'red_flag_involved',
  'red_flag_scan',
  'vendor_link_scan',
  'contractor_party_link',
  'vendor_investigation_lead',
  'vendor_lead_involved',
  'vendor_lead_review',
  'screening_list_import',
  'screening_list_entry',
  'screening_run',
  'screening_hit',
  'screening_hit_event',
  'proposal_submission_trace',
  'proposal_submission_file',
  'contractor_duplicate_suggestion',
  'contractor_reputation_event',
  'contractor_restriction',
  'restriction_case',
  'restriction_case_member',
  'restriction_case_event',
  'contractor_bank_account',
  'contractor_bank_change_request',
  'contractor_bank_event',
  'egp_record',
  'bid_conflict_declaration',
  'contractor_portal_invitation',
  'document',
  'document_version',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Puts the transaction on the portal path of one contractor: from here to the end of the transaction the database answers that contractor's rows and refuses the tables of the investigation. The value is the contractor of
 * the guest membership read by the portal store, checked to be a uuid here so that nothing else can ever be set.
 */
export async function enterPortalPath(tx: TenantTx, contractorId: string): Promise<void> {
  if (!UUID.test(contractorId)) throw new Error('portal path: the contractor must be a uuid');
  await tx.query('select set_config($1, $2, true)', [PORTAL_SETTING, contractorId.toLowerCase()]);
}

/** Leaves the portal path inside the same transaction (a staff action that runs after a portal step in one request never does; this exists for tests and for the job that closes a transaction). */
export async function leavePortalPath(tx: TenantTx): Promise<void> {
  await tx.query('select set_config($1, $2, true)', [PORTAL_SETTING, '']);
}
