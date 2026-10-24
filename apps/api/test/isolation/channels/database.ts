import { PERMISSIONS } from '@machvon/contracts';
import type { TenantDatabase } from '@machvon/db';
import { Client } from 'pg';
import { AUDIT_EVENT_FIXTURES, CERTIFICATE_FIXTURES, DOCUMENT_FIXTURES, GRANT_FIXTURES, LEGAL_HOLD_FIXTURES, MASTER_FIXTURES, MASTER_IMPORT_FIXTURES, MEMBERSHIP_FIXTURES, NOTIFICATION_FIXTURES, POLICY_FIXTURES, ROLE_FIXTURES, TENANT_IDS, UNIT_FIXTURES } from '../suite';
import type { IsolationChannel, TenantName } from '../suite';

const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000000f1';
const USER_ID = '00000000-0000-4000-8000-000000000061';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000f0';

/** The operations whose permissions the TNT-A test role holds: every id-bearing operation the isolation suite aims at TNT-B. */
export const FULL_RIGHTS_OPERATIONS = [
  'get_resources_membership_id',
  'get_resources_organization_unit',
  'get_resources_organization_unit_id',
  'createOrganizationUnit',
  'updateOrganizationUnit',
  'moveOrganizationUnit',
  'createCustomRole',
  'updateCustomRole',
  'grantRole',
  'revokeRoleGrant',
  'inviteMember',
  'suspendMembership',
  'reactivateMembership',
  'endMembership',
  'get_resources_role_grant',
  'get_resources_role_grant_id',
  'get_resources_role_definition',
  'get_resources_role_definition_id',
  'listMyNotifications',
  'getMyEffectiveAccess',
  'markNotificationRead',
  'acknowledgeNotification',
  'get_resources_notification_instance',
  'get_resources_notification_instance_id',
  'get_resources_audit_event',
  'get_resources_audit_event_id',
  'get_resources_legal_hold',
  'get_resources_legal_hold_id',
  'registerSigningCertificate',
  'revokeSigningCertificate',
  'get_resources_signing_certificate',
  'get_resources_signing_certificate_id',
  'createSecurityPolicyVersion',
  'publishSecurityPolicy',
  'get_resources_security_policy_version',
  'get_resources_security_policy_version_id',
  'placeLegalHold',
  'releaseLegalHold',
  'searchGlobal',
  'renderDocumentPreview',
  'defineDocumentType',
  'getDocumentVersionDownload',
  'getDocumentSignatureReport',
  'verifyDocumentSignatures',
  'get_resources_document_version',
  'get_resources_document_version_id',
  'openDocumentNumberRegister',
  'closeDocumentNumberRegister',
  'listDocumentNumberRegisters',
  'listDocumentRegisterEntries',
  'listOutgoingDocuments',
  'getOutgoingDocument',
  'startLeaderSigning',
  'completeSigningSession',
  'assignOutgoingDocumentNumber',
  'startOrganizationSeal',
  'proposeMasterRecord',
  'createMasterChangeRequest',
  'submitMasterChangeRequest',
  'decideMasterChangeRequest',
  'post_master_records_id_publish',
  'searchMasterRecords',
  'getMasterRecordUsages',
  'listMasterChangeRequests',
  'listMasterTypePolicies',
  'getMasterChangeRequest',
  'get_resources_master_record_version',
  'get_resources_master_record_version_id',
  'uploadMasterImportFile',
  'stageMasterImport',
  'applyMasterImport',
  'decideMasterImport',
  'publishMasterImport',
  'listMasterImports',
  'getMasterImport',
] as const;

const PERMISSION_OF = PERMISSIONS as Readonly<Record<string, string>>;
const FULL_RIGHTS = [...new Set(FULL_RIGHTS_OPERATIONS.map((operation) => PERMISSION_OF[operation] ?? ''))];

const INSERT_UNIT = `insert into machvon.organization_unit (tenant_id, id, code, name, valid_from)
  values ($1, $2, $3, $4, date '2026-01-01') on conflict do nothing`;

/** Inserts the fixture units of a tenant as machvon_owner (row-level security still applies, so the tenant is set). */
export async function seedTenantUnits(ownerUrl: string, tenant: TenantName): Promise<void> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [TENANT_IDS[tenant]]);
    for (const unit of UNIT_FIXTURES[tenant]) {
      await client.query(INSERT_UNIT, [TENANT_IDS[tenant], unit.id, unit.code, unit.name]);
    }
    await client.query('commit');
  } finally {
    await client.end();
  }
}

export function contextOf(tenant: TenantName): { tenantId: string; membershipId: string; scopeVersion: number } {
  return { tenantId: TENANT_IDS[tenant], membershipId: MEMBERSHIP_ID, scopeVersion: 1 };
}

interface Row {
  id: string;
  code: string;
  name: string;
}

function toResult(rows: Row[], emptyStatus: number): { status: number; body: string } {
  return { status: rows.length > 0 ? 200 : emptyStatus, body: JSON.stringify(rows) };
}

/** Reads organization units straight through TenantDatabase as machvon_app, so only row-level security isolates tenants. */
export function createDatabaseChannel(options: { ownerUrl: string; database: TenantDatabase }): IsolationChannel {
  return {
    name: 'database',
    seed: async (tenant) => {
      await seedTenantUnits(options.ownerUrl, tenant);
      await seedTenantAuthz(options.ownerUrl, tenant);
    },
    async readAs(user, target) {
      const targetId = UNIT_FIXTURES[target][0]?.id;
      const rows = await options.database.withTenant(contextOf(user), (tx) =>
        tx.query<Row>('select id, code, name from machvon.organization_unit where id = $1', [targetId]),
      );
      return toResult(rows, 404);
    },
    async listAs(user) {
      const rows = await options.database.withTenant(contextOf(user), (tx) =>
        tx.query<Row>('select id, code, name from machvon.organization_unit order by code'),
      );
      return { status: 200, body: JSON.stringify(rows) };
    },
    async foreignAttempts(user) {
      const role = await options.database.withTenant(contextOf(user), (tx) =>
        tx.query<Row>('select id, code, name from machvon.role_definition where id = $1', [ROLE_FIXTURES['TNT-B'].id]),
      );
      const grant = await options.database.withTenant(contextOf(user), (tx) =>
        tx.query<{ id: string }>('select id from machvon.role_grant where id = $1', [GRANT_FIXTURES['TNT-B'].id]),
      );
      return [
        { operation: 'database:role_definition', ...toResult(role, 404) },
        { operation: 'database:role_grant', ...toResult(grant as Row[], 404) },
      ];
    },
  };
}

const INSERT_USER = `insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status)
  values ($1, 'isolation-subject', 'isolation@example.test', 'Isolation Tester', 'Active') on conflict do nothing`;
const INSERT_MEMBER_USER = `insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status)
  values ($1, $2, $3, $4, 'Active') on conflict do nothing`;
const INSERT_MEMBERSHIP = `insert into machvon.membership (tenant_id, id, user_id, organization_id, status)
  values ($1, $2, $3, $4, 'Active') on conflict do nothing`;
const INSERT_ROLE = `insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by)
  values ($1, $2, $3, $4, $5, $6, 'Active', $7) on conflict do nothing`;
const INSERT_GRANT = `insert into machvon.role_grant
  (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
  values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'isolation fixture')
  on conflict do nothing`;

const INSERT_LEGAL_HOLD = `insert into machvon.legal_hold
  (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
  values ($1, $2, '{"kind":"TENANT","ids":[]}'::jsonb, $3, 'isolation fixture hold', '2026-01-01T00:00:00Z', 'AUDIT', 'Active', $4, 1) on conflict do nothing`;

const INSERT_CERTIFICATE = `insert into machvon.signing_certificate
  (tenant_id, id, kind, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by, version)
  values ($1, $2, 'ORGANIZATION', $3, $4, 'CN=Isolation CA', 'CN=Isolation unit', 'ISOLATION-CA', now() - interval '1 day', now() + interval '1 year', $5, 'Active', $6, 1) on conflict do nothing`;
const INSERT_POLICY = `insert into machvon.security_policy_version (tenant_id, id, revision, policy_json, status, created_by, version)
  values ($1, $2, 1, jsonb_build_object('mfa_required_roles', '[]'::jsonb, 'session_idle_minutes', 30, 'session_max_hours', 8, 'ip_allowlist', jsonb_build_array($3::text)), 'Draft', $4, 1) on conflict do nothing`;

const INSERT_MASTER_RECORD = `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
  values ($1, $2, 'TENANT', 'ISOLATION', $3, 'EFFECTIVE', $4, $4) on conflict do nothing`;
const INSERT_MASTER_VERSION = `insert into machvon.master_record_version
  (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
  values ($1, $2, $3, 'ISOLATION', $4, 1, $5, '{}'::jsonb, '2026-01-01', 'EFFECTIVE', 'TENANT', $6, $6) on conflict do nothing`;
const SET_MASTER_CURRENT = 'update machvon.master_record set current_version_id = $2 where id = $1';
const INSERT_MASTER_CHANGE = `insert into machvon.master_change_request
  (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, impact_json, effective_from, status, created_by, updated_by)
  values ($1, $2, 'UPDATE', 'ISOLATION', $3, jsonb_build_object('label', $4::text), 'isolation fixture change', '{"counts":{},"total":0,"computed_at":"2026-01-01T00:00:00.000Z"}'::jsonb,
          '2026-06-01', 'DRAFT', $5, $5) on conflict do nothing`;

const INSERT_MASTER_IMPORT = `insert into machvon.master_import_batch
  (tenant_id, id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, created_by, updated_by)
  values ($1, $2, 'ISOLATION', $3, $4, '{}'::jsonb, 'ATOMIC', 'IN_REVIEW', 0, 0, '[]'::jsonb, $5, $5) on conflict do nothing`;

const INSERT_REGISTER = `insert into machvon.document_number_register
  (tenant_id, id, register_code, name, direction, organization_unit_id, year, created_by, updated_by)
  values ($1, $2, $3, 'Isolation fixture register', 'OUTGOING', $4, 2026, $5, $5) on conflict do nothing`;
const INSERT_DOCUMENT = `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
  values ($1, $2, 'OUTGOING', 'QD', 'Isolation fixture document', 'INTERNAL', $3, $3) on conflict do nothing`;
const INSERT_DOCUMENT_VERSION = `insert into machvon.document_version
  (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
  values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL') on conflict do nothing`;

const INSERT_LAYOUT_PROFILE = `insert into machvon.document_layout_profile
  (tenant_id, id, profile_code, revision, page_size, margins_mm, font_family, element_styles, signature_layout, number_field_layout, watermark_policy, legal_basis, confirmation_status, effective_from, status, created_by, updated_by)
  values ($1, $2, 'ISOLATION', 1, 'A4', '{}'::jsonb, 'Tinos', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'isolation fixture', 'PENDING_CONFIRMATION', date '2026-01-01', 'PUBLISHED', $3, $3) on conflict do nothing`;
const INSERT_OUTGOING = `insert into machvon.outgoing_document
  (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
  values ($1, $2, $3, $4, 'SUBMITTED', $5, $6, $6, $6, $6) on conflict do nothing`;
const INSERT_SIGNING_SESSION = `insert into machvon.doc_signing_session
  (tenant_id, id, outgoing_document_id, role, signer_user_id, signing_certificate_id, adapter_code, adapter_status, status, base_version_id, digest_hex, byte_range, provider_txn_ref, expires_at, created_by, updated_by)
  values ($1, $2, $3, 'LEADER', $4, null, 'MOCK', 'MOCK', 'AWAITING_SIGNER', $5, repeat('a', 64), '[0,1,2,3]'::jsonb, 'isolation-session', now() + interval '1 day', $4, $4) on conflict do nothing`;

const INSERT_AUDIT_EVENT = `insert into machvon.audit_event
  (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at)
  values ($1, $2, $3, $4, 'isolation_fixture', $2, '{}'::jsonb, $2, $2, '2026-01-01T00:00:00Z') on conflict do nothing`;

const NOTIFICATION_EVENT_TYPE = 'isolation.notification.created';
const INSERT_NOTIFICATION_WORKFLOW = `insert into machvon.workflow_version
  (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
  values ($1, $2, 'NOTIFICATION', 1, '{}'::jsonb, 'Published', 'NOTIFICATION', $3, $4, repeat('a', 64)) on conflict do nothing`;
const INSERT_NOTIFICATION = `insert into machvon.notification_instance
  (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, ack_required)
  values ($1, $2, gen_random_uuid(), $3, $4, 'OPERATIONAL', $5, now() + interval '1 day', 'Delivered', $6, true) on conflict do nothing`;

/**
 * Seeds what the policy guard needs: the test membership of a tenant with a TENANT-wide grant of a fixture role.
 * Both tenants' roles carry the permissions of every operation the suite uses (TNT-A rank 89, so a custom role), so the
 * only thing that can keep TNT-A away from TNT-B is the tenant boundary itself; TNT-B's role has a distinctive name that must never reach TNT-A. Units must be seeded first (the membership belongs to one).
 */
export async function seedTenantAuthz(ownerUrl: string, tenant: TenantName): Promise<void> {
  const tenantId = TENANT_IDS[tenant];
  const home = UNIT_FIXTURES[tenant][0]?.id;
  const role = ROLE_FIXTURES[tenant];
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(INSERT_USER, [USER_ID]);
    await client.query(INSERT_MEMBERSHIP, [tenantId, MEMBERSHIP_ID, USER_ID, home]);
    const member = MEMBERSHIP_FIXTURES[tenant];
    await client.query(INSERT_MEMBER_USER, [member.userId, `isolation-member-${tenant}`, member.email, member.displayName]);
    await client.query(INSERT_MEMBERSHIP, [tenantId, member.id, member.userId, UNIT_FIXTURES[tenant][1]?.id ?? home]);
    await client.query(INSERT_ROLE, [tenantId, role.id, role.code, role.name, FULL_RIGHTS, tenant === 'TNT-A' ? 89 : 40, ACTOR_ID]);
    await client.query(INSERT_GRANT, [tenantId, GRANT_FIXTURES[tenant].id, MEMBERSHIP_ID, role.id, ACTOR_ID]);
    const notification = NOTIFICATION_FIXTURES[tenant];
    await client.query(INSERT_NOTIFICATION_WORKFLOW, [tenantId, notification.workflowId, NOTIFICATION_EVENT_TYPE, ACTOR_ID]);
    await client.query(INSERT_NOTIFICATION, [tenantId, notification.id, notification.workflowId, MEMBERSHIP_ID, `n1:${notification.id.replaceAll('-', '').padEnd(64, '0')}`, NOTIFICATION_EVENT_TYPE]);
    await client.query(INSERT_AUDIT_EVENT, [tenantId, AUDIT_EVENT_FIXTURES[tenant].id, MEMBERSHIP_ID, AUDIT_EVENT_FIXTURES[tenant].action]);
    await client.query(INSERT_LEGAL_HOLD, [tenantId, LEGAL_HOLD_FIXTURES[tenant].id, LEGAL_HOLD_FIXTURES[tenant].authorityReference, MEMBERSHIP_ID]);
    const certificate = CERTIFICATE_FIXTURES[tenant];
    await client.query(INSERT_CERTIFICATE, [tenantId, certificate.id, home, certificate.serial, certificate.fingerprint, ACTOR_ID]);
    await client.query(INSERT_POLICY, [tenantId, POLICY_FIXTURES[tenant].id, POLICY_FIXTURES[tenant].address, ACTOR_ID]);
    const master = MASTER_FIXTURES[tenant];
    await client.query(INSERT_MASTER_RECORD, [tenantId, master.recordId, master.businessKey, ACTOR_ID]);
    await client.query(INSERT_MASTER_VERSION, [tenantId, master.versionId, master.recordId, master.businessKey, master.label, ACTOR_ID]);
    await client.query(SET_MASTER_CURRENT, [master.recordId, master.versionId]);
    await client.query(INSERT_MASTER_CHANGE, [tenantId, master.changeId, master.recordId, `${master.label} renamed`, ACTOR_ID]);
    const batch = MASTER_IMPORT_FIXTURES[tenant];
    await client.query(INSERT_MASTER_IMPORT, [tenantId, batch.id, batch.fileObjectKey, batch.fileSha256, ACTOR_ID]);
    const documents = DOCUMENT_FIXTURES[tenant];
    await client.query(INSERT_REGISTER, [tenantId, documents.registerId, documents.registerCode, home, ACTOR_ID]);
    await client.query(INSERT_DOCUMENT, [tenantId, documents.documentId, ACTOR_ID]);
    await client.query(INSERT_DOCUMENT_VERSION, [tenantId, documents.versionId, documents.documentId, documents.objectKey]);
    await client.query(INSERT_LAYOUT_PROFILE, [tenantId, documents.layoutProfileId, ACTOR_ID]);
    await client.query(INSERT_OUTGOING, [tenantId, documents.outgoingId, documents.documentId, documents.layoutProfileId, home, MEMBERSHIP_ID]);
    await client.query(INSERT_SIGNING_SESSION, [tenantId, documents.sessionId, documents.outgoingId, MEMBERSHIP_ID, documents.versionId]);
    await client.query('commit');
  } finally {
    await client.end();
  }
}

const SNAPSHOT_TABLES = ['organization_unit', 'role_definition', 'role_grant', 'membership', 'notification_instance', 'legal_hold', 'signing_certificate', 'security_policy_version', 'audit_event', 'document_number_register', 'document', 'document_version', 'document_layout_profile', 'outgoing_document', 'doc_signing_session', 'master_record', 'master_record_version', 'master_change_request', 'master_import_batch'] as const;

/** Everything the suite seeded for a tenant as one string; reads as machvon_owner with the tenant set. */
export async function snapshotTenant(ownerUrl: string, tenant: TenantName): Promise<string> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [TENANT_IDS[tenant]]);
    const parts: unknown[] = [];
    for (const table of SNAPSHOT_TABLES) {
      const { rows } = await client.query<{ row: unknown }>(`select to_jsonb(t) as row from machvon.${table} t order by id`);
      parts.push(rows.map((row) => row.row));
    }
    await client.query('commit');
    return JSON.stringify(parts);
  } finally {
    await client.end();
  }
}
