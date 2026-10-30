import type { TenantTx } from './tenant-database.ts';

export interface SystemRole {
  code: string;
  /** i18n key of the display name; the UI translates it, the database never stores user-facing prose. */
  name: string;
  rank: number;
  /** Exact permissions or `prefix.*` patterns, as the IAM role table writes them. Never `system.*`. */
  permissions: readonly string[];
  guestAllowed: boolean;
}

// First segment of every permission that a tenant-plane operation of openapi.json requires (system.* is control plane). internal.* belongs to the service accounts of a
// tenant: its owner holds it, so that the owner can grant it (a role cannot hold what its maker does not), and the plane of the token keeps an owner from using it.
// TENANT_OWNER holds "all tenant-plane permissions"; system-roles.test.ts proves the list covers the whole catalogue.
const TENANT_PLANE_PREFIXES: readonly string[] = [
  'acceptance', 'adm', 'advance', 'advance_ledger_entry', 'ai', 'ai_eval_run', 'allocation_line', 'analysis_finding', 'analysis_run',
  'approval', 'approval_task', 'asset', 'asset_record', 'aud', 'audit', 'audit_event', 'bi', 'bid', 'boq', 'boq_line', 'budget_reservation',
  'capital', 'change', 'change_request', 'channel_account', 'channel_message', 'contact', 'contact_consent', 'contract', 'contract_revision',
  'contractor', 'conversation', 'criteria_version', 'dashboard_version', 'data', 'data_contract_version', 'dataset_contract',
  'delivery_attempt', 'device_registration', 'diary', 'disbursement', 'doc', 'document_version', 'drill_context', 'evaluation', 'explanation',
  'funding_snapshot_line', 'glossary', 'guarantee', 'handover', 'home', 'iam', 'inspection', 'integration', 'integration_cursor', 'internal', 'invitation',
  'invoice_line', 'issue', 'land', 'ledger', 'legal_hold', 'license_revision', 'llm', 'llm_attempt', 'lnd', 'master', 'master_record_version',
  'material', 'maturity_assessment', 'maturity_evidence', 'measurement', 'membership', 'metric_definition', 'mne', 'model_profile_version',
  'ncr', 'notification', 'notification_instance', 'notification_template_version', 'omni', 'organization_unit', 'outbox_event', 'payment',
  'payment_request', 'period', 'permit', 'photo', 'plan', 'plan_version', 'procurement_package', 'profile', 'progress_snapshot', 'project',
  'proposal', 'qacceptance', 'quality_exception', 'quality_incident', 'quality_nonconformance', 'quality_rule_version', 'quality_run',
  'reconciliation', 'report', 'report_revision', 'reporting_period', 'retention', 'role_grant', 'search', 'session', 'settlement',
  'settlement_revision', 'site_diary', 'snapshot', 'subscription', 'support', 'support_access_grant', 'sync', 'taskforce', 'tenant',
  'treasury', 'treasury_transaction', 'usage_meter_event', 'warning', 'warranty', 'workflow_instance', 'workflow_version',
];

const key = (code: string): string => `iam.role.${code}.name`;

/**
 * The system roles of IAM section 2, seeded per tenant at provisioning. Permissions are taken verbatim from the
 * "typical permissions" column; what the table leaves open is an empty list until the business owner signs the matrix
 * (PENDING SIGN-OFF): SPECIALIST, INVESTOR_OFFICER, and the read and export rights of LEADER, AUDITOR and GUEST_CONTRACTOR.
 */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  { code: 'TENANT_OWNER', name: key('TENANT_OWNER'), rank: 99, permissions: TENANT_PLANE_PREFIXES.map((prefix) => `${prefix}.*`), guestAllowed: false },
  { code: 'TENANT_ADMIN', name: key('TENANT_ADMIN'), rank: 90, permissions: ['iam.*', 'adm.*', 'audit.read', 'tenant.support.approve', 'support_access_grant.read'], guestAllowed: false },
  { code: 'SECURITY_ADMIN', name: key('SECURITY_ADMIN'), rank: 85, permissions: ['adm.security.*', 'audit.*', 'legal_hold.manage'], guestAllowed: false },
  { code: 'UNIT_ADMIN', name: key('UNIT_ADMIN'), rank: 70, permissions: ['iam.member.*', 'iam.role.grant', 'iam.unit.manage'], guestAllowed: false },
  // PENDING SIGN-OFF: "read business records within scope" names no permission.
  { code: 'LEADER', name: key('LEADER'), rank: 60, permissions: ['approval.decide'], guestAllowed: false },
  { code: 'NOTIFICATION_ADMIN', name: key('NOTIFICATION_ADMIN'), rank: 50, permissions: ['notification.*', 'notification_template_version.read'], guestAllowed: false },
  { code: 'OMNI_SUPERVISOR', name: key('OMNI_SUPERVISOR'), rank: 50, permissions: ['omni.*', 'channel_account.read'], guestAllowed: false },
  // PENDING SIGN-OFF: "appraise, return/accept" names no permission.
  { code: 'SPECIALIST', name: key('SPECIALIST'), rank: 40, permissions: [], guestAllowed: false },
  { code: 'OMNI_AGENT', name: key('OMNI_AGENT'), rank: 35, permissions: ['omni.conversation.*'], guestAllowed: false },
  // PENDING SIGN-OFF: "create/edit/submit records (maker)" names no permission.
  { code: 'INVESTOR_OFFICER', name: key('INVESTOR_OFFICER'), rank: 30, permissions: [], guestAllowed: false },
  // PENDING SIGN-OFF: "read/export" names no permission besides audit.read.
  { code: 'AUDITOR', name: key('AUDITOR'), rank: 25, permissions: ['audit.read'], guestAllowed: false },
  { code: 'BILLING_VIEWER', name: key('BILLING_VIEWER'), rank: 20, permissions: ['subscription.read', 'invoice_line.read'], guestAllowed: false },
  // PENDING SIGN-OFF: sending diaries, quantities and payment files names no permission.
  { code: 'GUEST_CONTRACTOR', name: key('GUEST_CONTRACTOR'), rank: 10, permissions: ['contract.read'], guestAllowed: true },
  // PENDING SIGN-OFF: the table names the notification box and the personal profile; the help of IAM-08 is asked for by every member (ST-IAM-007), so they raise and read their own support tickets.
  { code: 'MEMBER', name: key('MEMBER'), rank: 5, permissions: ['notification.self', 'profile.self', 'session.self', 'support.ticket.create', 'support.ticket.read', 'tenant.theme.read'], guestAllowed: true },
];

const SEED_SQL = `insert into machvon.role_definition
    (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by)
  select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), r.code, r.name, r.permissions, r.rank, true,
         r.guest_allowed, 'Active', $2::uuid
  from jsonb_to_recordset($1::jsonb) as r(code text, name text, permissions text[], rank int, guest_allowed boolean)
  on conflict (tenant_id, code) do nothing
  returning id`;

/** Seeds the system roles of the tenant of the transaction. Idempotent: roles that exist are left untouched. */
export async function seedSystemRoles(tx: TenantTx, createdBy: string): Promise<{ inserted: number }> {
  const payload = SYSTEM_ROLES.map((role) => ({
    code: role.code,
    name: role.name,
    permissions: role.permissions,
    rank: role.rank,
    guest_allowed: role.guestAllowed,
  }));
  const rows = await tx.query<{ id: string }>(SEED_SQL, [JSON.stringify(payload), createdBy]);
  return { inserted: rows.length };
}
