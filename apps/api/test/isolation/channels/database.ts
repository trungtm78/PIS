import { PERMISSIONS } from '@machvon/contracts';
import type { TenantDatabase } from '@machvon/db';
import { Client } from 'pg';
import { AUDIT_EVENT_FIXTURES, CERTIFICATE_FIXTURES, DOCUMENT_FIXTURES, GRANT_FIXTURES, LEGAL_HOLD_FIXTURES, MASTER_FIXTURES, MASTER_IMPORT_FIXTURES, CROSSWALK_FIXTURES, DATASET_FIXTURES, GLOSSARY_FIXTURES, MEMBERSHIP_FIXTURES, NOTIFICATION_FIXTURES, POLICY_FIXTURES, ROLE_FIXTURES, TENANT_IDS, UNIT_FIXTURES } from '../suite';
import { SLA_POLICY_FIXTURES, WORK_CALENDAR_FIXTURES } from '../suite';
import { TEMPLATE_FIXTURES } from '../suite';
import { MNE_FIXTURES } from '../suite';
import { PERMIT_TYPE_FIXTURES } from '../suite';
import { PROJECT_FIXTURES } from '../suite';
import { CONTRACTOR_FIXTURES } from '../suite';
import { CONTRACT_FIXTURES } from '../suite';
import { DOA_FIXTURES } from '../suite';
import { RETENTION_FIXTURES } from '../suite';
import { INTEGRATION_FIXTURES } from '../suite';
import { APPROPRIATION_FIXTURES } from '../suite';
import { PERIOD_FIXTURES } from '../suite';
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
  'get_resources_data_retention_policy',
  'get_resources_data_retention_policy_id',
  'get_resources_retention_review_item',
  'get_resources_retention_review_item_id',
  'get_resources_integration_connector',
  'get_resources_integration_connector_id',
  'get_resources_integration_event_inbox',
  'get_resources_integration_event_inbox_id',
  'registerSigningCertificate',
  'revokeSigningCertificate',
  'get_resources_signing_certificate',
  'get_resources_signing_certificate_id',
  'createSecurityPolicyVersion',
  'publishSecurityPolicy',
  'get_resources_security_policy_version',
  'get_resources_security_policy_version_id',
  'get_resources_work_calendar_version',
  'get_resources_work_calendar_version_id',
  'get_resources_doa_matrix_version',
  'get_resources_doa_matrix_version_id',
  'createWorkCalendarVersion',
  'publishWorkCalendar',
  'createDoaMatrixDraft',
  'updateDoaMatrixDraft',
  'submitDoaMatrix',
  'decideDoaMatrix',
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
  'recordMasterSuccession',
  'getMasterRecordAsOf',
  'getMasterRecordSuccessors',
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
  'createMasterCrosswalk',
  'retireMasterCrosswalk',
  'listMasterCrosswalks',
  'resetIntegrationCursor',
  'upsertIssueSlaPolicy',
  'retireIssueSlaPolicy',
  'listIssueSlaPolicies',
  'publishPermitType',
  'retirePermitType',
  'get_resources_permit_type',
  'get_resources_permit_type_id',
  'get_resources_integration_cursor',
  'get_resources_integration_cursor_id',
  'generateReportingPeriods',
  'softCloseReportingPeriod',
  'lockReportingPeriod',
  'get_resources_reporting_period',
  'get_resources_reporting_period_id',
  'registerAppropriation',
  'decideAppropriation',
  'listAppropriations',
  'listDocumentTemplates',
  'getDocumentTemplate',
  'createDocumentTemplateRevision',
  'publishDocumentTemplate',
  'confirmDocumentTemplateLegalBasis',
  'retireDocumentTemplate',
  'registerDataset',
  'assignDatasetOwnership',
  'searchCatalog',
  'proposeGlossaryTerm',
  'submitGlossaryTerm',
  'decideGlossaryTerm',
  'publishGlossaryTerm',
  'listGlossaryTerms',
  'createProject',
  'updateProjectProfile',
  'createRetentionPolicyVersion',
  'publishRetentionPolicy',
  'createIntegrationConnector',
  'updateIntegrationConnector',
  'replayInboxEvent',
  'get_resources_project',
  'get_resources_project_id',
  'registerContractor',
  'verifyContractor',
  'recordContractorRestriction',
  'get_resources_contractor',
  'get_resources_contractor_id',
  'createContract',
  'reviseContractDraft',
  'replaceContractParties',
  'cancelContractDraft',
  'get_resources_contract',
  'get_resources_contract_id',
  'get_resources_contract_revision',
  'get_resources_contract_revision_id',
  'createMneFormVersion',
  'publishMneForm',
  'listMneForms',
  'createMneObligationRule',
  'publishMneObligationRule',
  'listMneObligationRules',
  'generateMneObligations',
  'listMneObligations',
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

const INSERT_PERMIT_TYPE = `insert into machvon.permit_type
  (tenant_id, id, code, name, category, authority_text, legal_basis, cxn_ref, effective_from, applies_to_rule, status, created_by, updated_by)
  values ($1, $2, $3, 'Isolation permit type', 'OTHER', 'Isolation authority', $4, 'CXN-EXE-03', date '2026-01-01', '{}'::jsonb, 'PUBLISHED', $5, $5) on conflict do nothing`;

const INSERT_PERIOD = `insert into machvon.reporting_period
  (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
  values ($1, $2, $3, 1, date '2026-01-03', date '2026-01-09', timestamptz '2026-01-09T03:00:00Z', 'DEFAULT', 'WEEK', 2026, 'OPEN', $4, $5, $5) on conflict do nothing`;

const INSERT_APPROPRIATION = `insert into machvon.appropriation
  (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, decision_document_id, issuing_authority, source_year, revision, status, created_by, updated_by)
  values ($1, $2, $3, 2026, 'LOCAL_ADDED', 'LOCAL', 1000, $4, $5, 2026, 1, 'DRAFT', $6, $6) on conflict do nothing`;

const INSERT_WORK_CALENDAR = `insert into machvon.work_calendar_version
  (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, version)
  values ($1, $2, $3, 2026, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4, 'Draft', $5, 1) on conflict do nothing`;

const INSERT_DOA_MATRIX = `insert into machvon.doa_matrix_version
  (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
  values ($1, $2, 1, 'Draft', date '2026-01-01', $3, $4, $4, 1) on conflict do nothing`;
const INSERT_DOA_RULE = `insert into machvon.doa_rule
  (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
  select $1, gen_random_uuid(), $2, $3, $4, 0, null, $5 where not exists (select 1 from machvon.doa_rule where matrix_version_id = $2)`;

const INSERT_RETENTION_POLICY = `insert into machvon.data_retention_policy
  (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, version)
  values ($1, $2, $3, 1, 10, 'FROM_CLOSED', $4, 'REVIEW_FOR_DESTRUCTION', date '2026-01-01', 'Draft', $5, 1) on conflict do nothing`;

const INSERT_REVIEW_ITEM = `insert into machvon.retention_review_item
  (tenant_id, id, record_class, resource_type, resource_id, policy_id, basis_date, due_on, end_action)
  values ($1, $2, $3, 'project', gen_random_uuid(), $4, date '2015-01-01', date '2025-01-01', 'REVIEW_FOR_DESTRUCTION') on conflict do nothing`;

const INSERT_CONNECTOR =`insert into machvon.integration_connector
  (tenant_id, id, connector_code, adapter_status, mode, config_json, status, version)
  values ($1, $2, $3, 'PROPOSED', 'FILE_IMPORT', jsonb_build_object('endpoint', $4::text), 'Draft', 1) on conflict do nothing`;
const INSERT_INBOX_EVENT = `insert into machvon.integration_event_inbox
  (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, error_code)
  values ($1, $2, 'ISOLATION', $3, repeat('c', 64), $4, '2026-01-01T00:00:00Z', 'FAILED', 'k1', 3, 'PROVIDER_DOWN') on conflict do nothing`;

const INSERT_MASTER_RECORD = `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
  values ($1, $2, 'TENANT', 'ISOLATION', $3, 'EFFECTIVE', $4, $4) on conflict do nothing`;
const INSERT_MASTER_VERSION = `insert into machvon.master_record_version
  (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
  values ($1, $2, $3, 'ISOLATION', $4, 1, $5, '{}'::jsonb, '2026-01-01', 'EFFECTIVE', 'TENANT', $6, $6) on conflict do nothing`;
const INSERT_SLA_POLICY = `insert into machvon.issue_sla_policy
  (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
  values ($1, $2, $3, 1, $4, $5, 'HIGH', 'WORKDAY_VN', 4, 72, '2026-01-01', 'ACTIVE', $6, $6) on conflict do nothing`;
const SET_MASTER_CURRENT ='update machvon.master_record set current_version_id = $2 where id = $1';
const INSERT_MASTER_CHANGE = `insert into machvon.master_change_request
  (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, impact_json, effective_from, status, created_by, updated_by)
  values ($1, $2, 'UPDATE', 'ISOLATION', $3, jsonb_build_object('label', $4::text), 'isolation fixture change', '{"counts":{},"total":0,"computed_at":"2026-01-01T00:00:00.000Z"}'::jsonb,
          '2026-06-01', 'DRAFT', $5, $5) on conflict do nothing`;

const INSERT_MASTER_IMPORT = `insert into machvon.master_import_batch
  (tenant_id, id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, created_by, updated_by)
  values ($1, $2, 'ISOLATION', $3, $4, '{}'::jsonb, 'ATOMIC', 'IN_REVIEW', 0, 0, '[]'::jsonb, $5, $5) on conflict do nothing`;

const INSERT_CROSSWALK = `insert into machvon.master_crosswalk
  (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
  values ($1, $2, $3, 'ISOLATION', 'ISOLATION_CODE', $4, '2026-01-01', 'MANUAL', 'ACTIVE', $5, $5) on conflict do nothing`;
const INSERT_CURSOR = `insert into machvon.integration_cursor
  (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, last_file_sha256)
  values ($1, $2, 'ISOLATION_FILE', $3, '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', $4) on conflict do nothing`;

const INSERT_DATASET = `insert into machvon.dataset
  (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
  values ($1, $2, $3, $4, 'ISOLATION', 'one row per isolation case', 'PAY', $5, $5, 'PUBLIC', false, 3600, 'DRAFT', $6, $6) on conflict do nothing`;

const INSERT_GLOSSARY_TERM =`insert into machvon.glossary_term
  (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, created_by, updated_by)
  values ($1, $2, $3, 'Isolation fixture term', $4, 'ISOLATION', $5, 1, 'IN_REVIEW', $6, $6) on conflict do nothing`;

const INSERT_CONTRACTOR = `insert into machvon.contractor
  (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by)
  values ($1, $2, $3, $4, 'UNVERIFIED', $5, $6, $6) on conflict do nothing`;

const INSERT_PACKAGE = `insert into machvon.procurement_package
  (tenant_id, id, project_id, code, budget_vnd, method, revision, status)
  values ($1, $2, $3, $4, 1000, 'OPEN', 1, 'AWARDED') on conflict do nothing`;

const INSERT_CONTRACT = `insert into machvon.contract
  (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, created_by, updated_by)
  values ($1, $2, $3, $4, $5, $6, $7, 'LUMP_SUM', 'VND', 'DRAFT', 1, 1000, 1000, $8, $8) on conflict do nothing`;

const INSERT_CONTRACT_REVISION = `insert into machvon.contract_revision
  (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
  values ($1, $2, $3, 1, 1000, $4, date '2026-01-01', 'DRAFT', 'BASE', 1, $5, $5) on conflict do nothing`;

const INSERT_PROJECT = `insert into machvon.project
  (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
  values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'CONCEPT', 1, $7, $7) on conflict do nothing`;

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
const INSERT_TEMPLATE = `insert into machvon.document_template
  (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text, origin, content_sha256, effective_from, status, created_by, updated_by)
  values ($1, $2, $3, 1, 'OTHER', 'QD', 'Isolation fixture template', $4, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb, $5, 'Waiting for confirmation', 'PLATFORM_PACK', repeat('f', 64), date '2026-01-01', 'PUBLISHED', $6, $6) on conflict do nothing`;
const INSERT_MNE_FORM = `insert into machvon.mne_report_form
  (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, origin, pack_version, published_at, created_by, updated_by)
  values ($1, $2, $3, 'Isolation report form', 'OVERALL_SEMIANNUAL', $4, date '2026-01-01', '{}'::jsonb, 'ISOLATION-TEMPLATE', array['XLSX'], 1, 'PUBLISHED', 'PLATFORM_PACK', 'isolation', now(), $5, $5) on conflict do nothing`;
const INSERT_MNE_RULE = `insert into machvon.mne_obligation_rule
  (tenant_id, id, rule_code, form_id, reporting_role, recipient, frequency, due_rule_json, legal_basis, effective_from, revision, status, origin, pack_version, published_at, created_by, updated_by)
  values ($1, $2, $3, $4, 'INVESTOR', $5, 'SEMIANNUAL', '{"period":"H1","month":7,"day":10}'::jsonb, 'Isolation rule legal basis', date '2026-01-01', 1, 'PUBLISHED', 'PLATFORM_PACK', 'isolation', now(), $6, $6) on conflict do nothing`;
const INSERT_MNE_REPORT = `insert into machvon.mne_report
  (tenant_id, id, form_id, obligation_rule_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, created_by, updated_by)
  values ($1, $2, $3, $4, 2026, 'H1-2026', $5, date '2026-07-10', 1, 'DRAFT', '{}'::jsonb, $6, $6) on conflict do nothing`;
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
    const calendar = WORK_CALENDAR_FIXTURES[tenant];
    await client.query(INSERT_WORK_CALENDAR, [tenantId, calendar.id, calendar.calendarCode, calendar.legalBasis, ACTOR_ID]);
    const doa = DOA_FIXTURES[tenant];
    await client.query(INSERT_DOA_MATRIX, [tenantId, doa.id, doa.legalBasis, ACTOR_ID]);
    await client.query(INSERT_DOA_RULE, [tenantId, doa.id, doa.documentType, home, role.id]);
    const retention = RETENTION_FIXTURES[tenant];
    await client.query(INSERT_RETENTION_POLICY, [tenantId, retention.id, retention.recordClass, retention.legalBasis, ACTOR_ID]);
    await client.query(INSERT_REVIEW_ITEM, [tenantId, retention.reviewId, retention.recordClass, retention.id]);
    const integration = INTEGRATION_FIXTURES[tenant];
    await client.query(INSERT_CONNECTOR, [tenantId, integration.connectorId, integration.connectorCode, integration.endpoint]);
    await client.query(INSERT_INBOX_EVENT, [tenantId, integration.eventId, integration.eventKey, integration.payloadReference]);
    const master = MASTER_FIXTURES[tenant];
    await client.query(INSERT_MASTER_RECORD, [tenantId, master.recordId, master.businessKey, ACTOR_ID]);
    await client.query(INSERT_MASTER_VERSION, [tenantId, master.versionId, master.recordId, master.businessKey, master.label, ACTOR_ID]);
    await client.query(SET_MASTER_CURRENT, [master.recordId, master.versionId]);
    const permitType = PERMIT_TYPE_FIXTURES[tenant];
    await client.query(INSERT_PERMIT_TYPE, [tenantId, permitType.id, permitType.code, permitType.legalBasis, ACTOR_ID]);
    const period = PERIOD_FIXTURES[tenant];
    await client.query(INSERT_PERIOD, [tenantId, period.id, period.code, master.versionId, ACTOR_ID]);
    const slaPolicy = SLA_POLICY_FIXTURES[tenant];
    await client.query(INSERT_SLA_POLICY, [tenantId, slaPolicy.id, slaPolicy.code, master.versionId, master.recordId, ACTOR_ID]);
    await client.query(INSERT_MASTER_CHANGE, [tenantId, master.changeId, master.recordId, `${master.label} renamed`, ACTOR_ID]);
    const batch = MASTER_IMPORT_FIXTURES[tenant];
    await client.query(INSERT_MASTER_IMPORT, [tenantId, batch.id, batch.fileObjectKey, batch.fileSha256, ACTOR_ID]);
    const crosswalk = CROSSWALK_FIXTURES[tenant];
    await client.query(INSERT_CROSSWALK, [tenantId, crosswalk.crosswalkId, master.recordId, crosswalk.externalCode, ACTOR_ID]);
    await client.query(INSERT_CURSOR, [tenantId, crosswalk.cursorId, crosswalk.sourceScope, crosswalk.fileSha256]);
    const project = PROJECT_FIXTURES[tenant];
    await client.query(INSERT_PROJECT, [tenantId, project.id, project.code, project.name, home, master.versionId, ACTOR_ID]);
    const dataset = DATASET_FIXTURES[tenant];
    await client.query(INSERT_DATASET, [tenantId, dataset.id, dataset.datasetCode, dataset.title, MEMBERSHIP_ID, ACTOR_ID]);
    const term = GLOSSARY_FIXTURES[tenant];
    await client.query(INSERT_GLOSSARY_TERM, [tenantId, term.termId, term.termCode, term.definition, MEMBERSHIP_ID, ACTOR_ID]);
    const documents = DOCUMENT_FIXTURES[tenant];
    await client.query(INSERT_REGISTER, [tenantId, documents.registerId, documents.registerCode, home, ACTOR_ID]);
    await client.query(INSERT_DOCUMENT, [tenantId, documents.documentId, ACTOR_ID]);
    const appropriation = APPROPRIATION_FIXTURES[tenant];
    await client.query(INSERT_APPROPRIATION, [tenantId, appropriation.id, master.versionId, documents.documentId, appropriation.issuingAuthority, ACTOR_ID]);
    const contractor = CONTRACTOR_FIXTURES[tenant];
    await client.query(INSERT_CONTRACTOR, [tenantId, contractor.id, contractor.taxIdentifier, contractor.legalName, documents.documentId, ACTOR_ID]);
    await client.query(INSERT_DOCUMENT_VERSION, [tenantId, documents.versionId, documents.documentId, documents.objectKey]);
    const draft = CONTRACT_FIXTURES[tenant];
    await client.query(INSERT_PACKAGE, [tenantId, draft.packageId, project.id, `${draft.code}-PKG`]);
    await client.query(INSERT_CONTRACT, [tenantId, draft.id, project.id, draft.packageId, contractor.id, draft.code, draft.title, ACTOR_ID]);
    await client.query(INSERT_CONTRACT_REVISION, [tenantId, draft.revisionId, draft.id, documents.versionId, ACTOR_ID]);
    await client.query(INSERT_LAYOUT_PROFILE, [tenantId, documents.layoutProfileId, ACTOR_ID]);
    const template = TEMPLATE_FIXTURES[tenant];
    await client.query(INSERT_TEMPLATE, [tenantId, template.id, template.templateCode, documents.layoutProfileId, template.legalBasis, ACTOR_ID]);
    const mne = MNE_FIXTURES[tenant];
    await client.query(INSERT_MNE_FORM, [tenantId, mne.formId, mne.formCode, mne.formLegalBasis, ACTOR_ID]);
    await client.query(INSERT_MNE_RULE, [tenantId, mne.ruleId, mne.ruleCode, mne.formId, mne.ruleRecipient, ACTOR_ID]);
    await client.query(INSERT_MNE_REPORT, [tenantId, mne.reportId, mne.formId, mne.ruleId, home, ACTOR_ID]);
    await client.query(INSERT_OUTGOING, [tenantId, documents.outgoingId, documents.documentId, documents.layoutProfileId, home, MEMBERSHIP_ID]);
    await client.query(INSERT_SIGNING_SESSION, [tenantId, documents.sessionId, documents.outgoingId, MEMBERSHIP_ID, documents.versionId]);
    await client.query('commit');
  } finally {
    await client.end();
  }
}

const SNAPSHOT_TABLES = ['organization_unit', 'role_definition', 'role_grant', 'membership', 'notification_instance', 'legal_hold', 'signing_certificate', 'security_policy_version', 'work_calendar_version', 'doa_matrix_version', 'doa_rule', 'data_retention_policy', 'retention_review_item', 'integration_connector', 'integration_event_inbox', 'audit_event', 'document_number_register', 'document', 'document_version', 'document_layout_profile', 'document_template', 'outgoing_document', 'doc_signing_session', 'master_record', 'master_record_version', 'master_change_request', 'master_import_batch', 'master_crosswalk', 'integration_cursor', 'reporting_period', 'issue_sla_policy', 'glossary_term', 'dataset', 'project', 'project_revision', 'contractor', 'contractor_restriction', 'appropriation', 'procurement_package', 'contract', 'contract_revision', 'mne_report_form', 'mne_obligation_rule', 'mne_report'] as const;

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
