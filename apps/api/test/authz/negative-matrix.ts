import { PERMISSIONS } from '@machvon/contracts';
import type { SystemRole } from '@machvon/db';
import { holdsPermission } from '@machvon/kernel';

/** Ids in tenant A that the command fixtures act on; the test seeds them. */
export interface MatrixTargets {
  unit2: string;
  unit3: string;
  customRoleId: string;
  /** The seeded system role MEMBER (lowest rank, so every real grantor could grant it). */
  memberRoleId: string;
  recipientMembershipId: string;
  grantToRevoke: string;
  /** A notification of RECIPIENT: the notification commands name it in the path. */
  notificationId: string;
  /** An Active tenant-wide legal hold of tenant A. */
  legalHoldId: string;
  /** An open document number register of tenant A (counter 0, version 1). */
  registerId: string;
  /** The seeded system role GUEST_CONTRACTOR, a contractor of tenant A and one of its Active contracts. */
  guestRoleId: string;
  contractorId: string;
  contractId: string;
  /** A project of unit 2 of tenant A with an approved capital plan, a package of it awarded to `contractorId`, a DRAFT joint-venture contract of value 1000 under that package (version 1) and a second verified contractor to share it. */
  contractProjectId: string;
  contractPackageId: string;
  draftContractId: string;
  contractMemberId: string;
  /** An UNVERIFIED contractor of tenant A made by someone other than the callers (version 1). */
  contractorToVerifyId: string;
  /** A clean PDF version of tenant A: the signature verification names it in the path. */
  documentVersionId: string;
  /** An Active signing certificate of tenant A (version 1). */
  certificateId: string;
  /** A security policy draft of tenant A made by someone other than the callers (version 1). */
  policyId: string;
  /** A working calendar draft of tenant A (version 1). */
  workCalendarId: string;
  /** A DoA matrix draft and one waiting for approval of tenant A, both made by someone other than the callers (version 1). */
  doaDraftId: string;
  doaPendingId: string;
  /** An outgoing document of tenant A in SUBMITTED (version 1) and an open leader signing session of it (version 1). */
  outgoingDocumentId: string;
  signingSessionId: string;
  /** An EFFECTIVE master record of tenant A (version 1), a DRAFT change request of another record and an IN_REVIEW one of a third. */
  masterRecordId: string;
  masterDraftChangeId: string;
  masterReviewChangeId: string;
  /** An IN_REVIEW import batch of tenant A. */
  masterImportId: string;
  /** An ACTIVE crosswalk and a FAILED integration cursor of tenant A (both version 1). */
  masterCrosswalkId: string;
  integrationCursorId: string;
  /** The version in force of an issue category of tenant A, and an ACTIVE SLA policy written for it (version 1). */
  issueCategoryVersionId: string;
  slaPolicyId: string;
  /** A DRAFT dataset of tenant A (version 1). */
  datasetId: string;
  /** A DRAFT retention policy version of tenant A made by someone other than the callers (version 1). */
  retentionDraftId: string;
  /** A draft integration connector and a FAILED inbox event of tenant A (both version 1). */
  connectorId: string;
  inboxEventId: string;
  /** An active member of tenant A who owns the glossary terms below, and a DRAFT, an IN_REVIEW and an APPROVED term of it (all version 1). */
  glossaryOwnerId: string;
  glossaryDraftTermId: string;
  glossaryReviewTermId: string;
  glossaryApprovedTermId: string;
  /** A CONCEPT project of unit 2 of tenant A (version 1) and the area version in force that it names. */
  projectId: string;
  projectAreaVersionId: string;
  /** A document of tenant A, named as the decision that authorises a publication. */
  decisionDocumentId: string;
  /** A DRAFT template revision of tenant A made by someone other than the callers (version 1), and the published layout profile it uses. */
  templateId: string;
  layoutProfileId: string;
  /** A PUBLISHED permit type version of tenant A (version 1, open-ended). */
  permitTypeId: string;
  /** The version in force of a fund source of tenant A, and a DRAFT appropriation of it made by someone other than the callers (version 1). */
  fundSourceVersionId: string;
  appropriationId: string;
  /** Reporting periods of tenant A past their deadline: one OPEN and one SOFT_CLOSED (both version 1). */
  periodOpenId: string;
  periodSoftClosedId: string;
  /** A DRAFT report form and a DRAFT obligation rule of it in tenant A, made by someone other than the callers (both version 1). */
  mneFormId: string;
  mneRuleId: string;
}

export interface MatrixRequest {
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  ifMatch?: string;
}

export interface CommandFixture {
  /** A request that would succeed (and change state) if the guard let it through. */
  build(targets: MatrixTargets): MatrixRequest;
  /**
   * The request names ids of tenant A. A caller of another tenant must then get 403 or 404; a command that names no
   * foreign id (createCustomRole) legitimately works inside the caller's own tenant, so only tenant A must stay untouched.
   */
  referencesTenantIds: boolean;
}

const REASON = 'negative authorization matrix';

/**
 * One fixture per implemented command. The list of keys is mirrored in matrix-commands.json, which
 * `npm run commands:check` compares with the commands found in the source, so a new command cannot ship
 * without a row here.
 */
export const COMMAND_FIXTURES: Readonly<Record<string, CommandFixture>> = {
  createOrganizationUnit: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/org-units',
      body: { code: 'MATRIX-NEW', name: 'Matrix unit', parent_id: t.unit2, unit_type: 'DEPARTMENT', valid_from: '2026-01-01' },
    }),
  },
  updateOrganizationUnit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'PUT', path: `/org-units/${t.unit3}`, ifMatch: '"1"', body: { name: 'Renamed by matrix' } }),
  },
  moveOrganizationUnit: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/org-units/${t.unit3}/move`,
      ifMatch: '"1"',
      body: { new_parent_id: t.unit2, effective_from: '2026-01-01', reason: REASON },
    }),
  },
  createCustomRole: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/roles',
      body: { code: 'MATRIX_ROLE', name: 'Matrix role', permissions: ['iam.unit.manage'], rank: 10 },
    }),
  },
  updateCustomRole: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'PUT', path: `/roles/${t.customRoleId}`, ifMatch: '"1"', body: { permissions: ['iam.unit.manage'], reason: REASON } }),
  },
  grantRole: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/role-grants',
      body: { membership_id: t.recipientMembershipId, role_id: t.memberRoleId, scope_kind: 'TENANT', reason: REASON },
    }),
  },
  revokeRoleGrant: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/role-grants/${t.grantToRevoke}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The profile document is looked up in the caller's own tenant: one of another tenant is refused as 422 naming the field, like one that does not exist.
  registerContractor: {
    referencesTenantIds: false,
    build: (t) => ({ method: 'POST', path: '/contractors', body: { tax_identifier: '0100000088', legal_name: 'Matrix new contractor', profile_document_id: t.decisionDocumentId } }),
  },
  verifyContractor: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contractors/${t.contractorToVerifyId}/verification`,
      ifMatch: '"1"',
      body: { decision: 'VERIFIED', verification_evidence_document_id: t.decisionDocumentId },
    }),
  },
  recordContractorRestriction: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contractors/${t.contractorId}/restrictions`,
      body: { kind: 'WARNING', effective_from: '2026-01-01', decision_document_id: t.decisionDocumentId },
    }),
  },
  inviteGuestContractor: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/guest-memberships',
      body: { email: 'matrix-guest@example.test', contractor_id: t.contractorId, contract_ids: [t.contractId], role_id: t.guestRoleId, valid_until: '2027-01-01T00:00:00Z' },
    }),
  },
  inviteMember: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/memberships/invitations', body: { email: 'matrix-invitee@example.test', organization_unit_id: t.unit2 } }),
  },
  suspendMembership: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/memberships/${t.recipientMembershipId}/suspend`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  reactivateMembership: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/memberships/${t.recipientMembershipId}/reactivate`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  endMembership: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/memberships/${t.recipientMembershipId}/end`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  placeLegalHold: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/legal-holds',
      body: { hold_kind: 'AUDIT', resource_scope: { kind: 'TENANT', ids: [] }, authority_reference: 'MATRIX-HOLD-REF', reason: REASON },
    }),
  },
  exportAuditLog: {
    // An export names no id: it works inside the caller's own tenant, and only there.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/audit-exports', body: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', format: 'JSONL' } }),
  },
  createIntegrationConnector: {
    // A connector names no id: it works inside the caller's own tenant, and only there.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/integration-connectors', body: { connector_code: 'matrix-connector', mode: 'FILE_IMPORT', adapter_status: 'PROPOSED', config: {} } }),
  },
  updateIntegrationConnector: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'PUT', path: `/integration-connectors/${t.connectorId}`, ifMatch: '"1"', body: { reason: REASON, status: 'Disabled' } }),
  },
  replayInboxEvent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/integration-inbox/${t.inboxEventId}/replay`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createRetentionPolicyVersion: {
    // A policy names no id: it works inside the caller's own tenant, and only there.
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/retention-policies',
      body: { record_class: 'project_dossier', retention_years: 10, retention_basis: 'FROM_CLOSED', legal_basis_ref: 'Matrix fixture basis', end_action: 'REVIEW_FOR_DESTRUCTION', effective_from: '2026-01-01' },
    }),
  },
  publishRetentionPolicy: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/retention-policies/${t.retentionDraftId}/publish`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  releaseLegalHold: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/legal-holds/${t.legalHoldId}/release`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  registerSigningCertificate: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/signing-certificates',
      body: { kind: 'ORGANIZATION', organization_unit_id: t.unit2, certificate_pem: '-----BEGIN CERTIFICATE-----\nMATRIX\n-----END CERTIFICATE-----', provider_code: 'MATRIX-CA' },
    }),
  },
  revokeSigningCertificate: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/signing-certificates/${t.certificateId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createSecurityPolicyVersion: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/security-policies', body: { mfa_required_roles: [], session_idle_minutes: 30, session_max_hours: 8 } }),
  },
  publishSecurityPolicy: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/security-policies/${t.policyId}/publish`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createDoaMatrixDraft: {
    // A unit or role that does not exist in the caller's tenant is a 422 (like a missing reference of any command), not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/doa-matrices',
      body: {
        effective_from: '2026-01-01',
        legal_basis_ref: 'Matrix regulation 01',
        rules: [{ document_type: 'MATRIX', unit_id: t.unit2, amount_min_vnd: '0', approver_role_id: t.memberRoleId }],
      },
    }),
  },
  updateDoaMatrixDraft: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'PUT',
      path: `/doa-matrices/${t.doaDraftId}`,
      ifMatch: '"1"',
      body: {
        effective_from: '2026-01-01',
        legal_basis_ref: 'Matrix regulation 02',
        rules: [{ document_type: 'MATRIX', unit_id: t.unit2, amount_min_vnd: '0', approver_role_id: t.memberRoleId }],
      },
    }),
  },
  submitDoaMatrix: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/doa-matrices/${t.doaDraftId}/submit`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  decideDoaMatrix: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/doa-matrices/${t.doaPendingId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  createWorkCalendarVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/work-calendars',
      body: { calendar_code: 'MATRIX-CAL', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-05-01', name: 'Labour Day' }], legal_basis_ref: 'Labour Code 2019 art. 112' },
    }),
  },
  publishWorkCalendar: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/work-calendars/${t.workCalendarId}/publish`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  openDocumentNumberRegister: {
    // A unit that does not exist in the caller's tenant is a 422 (like a missing reference of any command), not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/document-number-registers',
      body: { register_code: 'MATRIX-REG', name: 'Matrix register', direction: 'OUTGOING', organization_unit_id: t.unit2, year: 2026, scope_doc_types: ['QD'] },
    }),
  },
  closeDocumentNumberRegister: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-number-registers/${t.registerId}/closure`, ifMatch: '"1"', body: { reason: 'negative authorization matrix' } }),
  },
  defineDocumentType: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/document-types',
      body: { code: 'MATRIX', name: 'Matrix type', symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}', register_code: 'MATRIX-REG', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    }),
  },
  startLeaderSigning: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/leader-signing-sessions`, ifMatch: '"1"', body: {} }),
  },
  completeSigningSession: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/signing-sessions/${t.signingSessionId}/completion`, ifMatch: '"1"', body: {} }),
  },
  assignOutgoingDocumentNumber: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/numbering`, ifMatch: '"1"', body: { register_id: t.registerId } }),
  },
  startOrganizationSeal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/organization-seal-sessions`, ifMatch: '"1"', body: {} }),
  },
  verifyDocumentSignatures: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-versions/${t.documentVersionId}/signature-verifications`, body: {} }),
  },
  renderDocumentPreview: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/document-renders',
      body: { template_code: 'QD-DEFAULT', as_of_date: '2026-10-23', payload: { title: 'Matrix', body: 'Matrix', agency: 'Matrix agency', place: 'Cao Bang' } },
    }),
  },
  proposeMasterRecord: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/master-records',
      body: { namespace: 'TENANT', master_type: 'MATRIX', business_key: 'MX-NEW', label: 'Matrix entry', attributes: {}, valid_from: '2026-01-01', reason: REASON },
    }),
  },
  createMasterChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/master-change-requests',
      body: { change_kind: 'UPDATE', master_type: 'MATRIX', master_record_id: t.masterRecordId, proposed: { label: 'Renamed by matrix' }, effective_from: '2026-06-01', reason: REASON },
    }),
  },
  recordMasterSuccession: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/master-successions',
      body: { predecessor_record_id: t.masterRecordId, successor_record_id: t.masterCrosswalkId, succession_kind: 'MERGE', effective_date: '2025-07-01', legal_basis: 'Matrix legal basis', reason: REASON },
    }),
  },
  submitMasterChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-change-requests/${t.masterDraftChangeId}/submit`, ifMatch: '"1"', body: {} }),
  },
  decideMasterChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-change-requests/${t.masterReviewChangeId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  post_master_records_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-records/${t.masterRecordId}/publish`, ifMatch: '"1"', body: { decision_document_id: t.decisionDocumentId } }),
  },
  uploadMasterImportFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/master-imports/files', body: {} }),
  },
  stageMasterImport: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/master-imports',
      body: { master_type: 'MATRIX', file_object_key: 'tenants/matrix/import/none', file_sha256: 'a'.repeat(64), mapping: { key: 'code', label: 'name', valid_from: 'from' }, mode: 'ATOMIC' },
    }),
  },
  applyMasterImport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-imports/${t.masterImportId}/apply`, ifMatch: '"1"', body: {} }),
  },
  decideMasterImport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-imports/${t.masterImportId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  publishMasterImport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-imports/${t.masterImportId}/publish`, ifMatch: '"1"', body: { decision_document_id: t.decisionDocumentId } }),
  },
  createMasterCrosswalk: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/master-crosswalks',
      body: { master_record_id: t.masterRecordId, source_system: 'MATRIX', external_type: 'MATRIX_CODE', external_code: 'MX-NEW', valid_from: '2026-01-01', match_method: 'MANUAL' },
    }),
  },
  retireMasterCrosswalk: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-crosswalks/${t.masterCrosswalkId}/retire`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  publishPermitType: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/permit-types',
      body: {
        code: 'MATRIX_PERMIT',
        name: 'Matrix permit type',
        category: 'OTHER',
        authority_text: 'Matrix authority',
        legal_basis: 'Matrix legal basis',
        effective_from: '2026-01-01',
        applies_to_rule: {},
      },
    }),
  },
  registerAppropriation: {
    // The fund source and the document of tenant A do not exist for a caller of tenant B: a 422 (a missing reference of any command), not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/appropriations',
      body: {
        fund_source_version_id: t.fundSourceVersionId,
        plan_year: 2026,
        origin: 'PM_ASSIGNED',
        budget_level: 'CENTRAL',
        amount_vnd: '1000',
        decision_document_id: t.decisionDocumentId,
        issuing_authority: 'Matrix authority',
        source_year: 2026,
      },
    }),
  },
  decideAppropriation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/appropriations/${t.appropriationId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  generateReportingPeriods: {
    // The reporting calendar is the caller's own: a caller of another tenant generates for that tenant (or is told it has no calendar) and never touches tenant A.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/reporting-periods/generate', body: { calendar_code: 'DEFAULT', fiscal_year: 2031, period_type: 'WEEK' } }),
  },
  softCloseReportingPeriod: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reporting-periods/${t.periodOpenId}/soft-close`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  lockReportingPeriod: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reporting-periods/${t.periodSoftClosedId}/lock`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  retirePermitType: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permit-types/${t.permitTypeId}/retire`, body: { effective_until: '2999-12-31' } }),
  },
  createDocumentTemplateRevision: {
    // The layout profile of tenant A does not exist for a caller of tenant B: a 422 (a missing reference of any command), not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/document-templates',
      body: {
        template_code: 'MATRIX-TEMPLATE',
        group_code: 'OTHER',
        doc_type_code: 'QD',
        title: 'Matrix template',
        layout_profile_id: t.layoutProfileId,
        body_blocks: { blocks: [{ kind: 'paragraph', text: '{{body}}' }] },
        placeholder_schema: { required: ['body'] },
        legal_basis: 'Matrix legal basis',
        effective_from: '2026-01-01',
      },
    }),
  },
  publishDocumentTemplate: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-templates/${t.templateId}/publish`, ifMatch: '"1"', body: {} }),
  },
  confirmDocumentTemplateLegalBasis: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/document-templates/${t.templateId}/legal-confirmation`,
      ifMatch: '"1"',
      body: { legal_confirmation_ref: 'CXN-MATRIX', evidence_document_id: t.decisionDocumentId },
    }),
  },
  retireDocumentTemplate: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-templates/${t.templateId}/retirement`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The DOC template named in the body is looked up in the caller's own tenant: a caller of another tenant is refused as 422 DOC_TEMPLATE_MISSING.
  createMneFormVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/mne-forms',
      body: {
        form_code: 'MATRIX-FORM',
        title: 'Matrix report form',
        report_kind: 'OVERALL_SEMIANNUAL',
        legal_basis: 'Matrix legal basis',
        effective_from: '2026-01-01',
        schema_json: {},
        doc_template_code: 'MATRIX-NO-SUCH-TEMPLATE',
        export_formats: ['XLSX'],
      },
    }),
  },
  publishMneForm: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-forms/${t.mneFormId}/publish`, ifMatch: '"1"', body: {} }),
  },
  // The form named in the body belongs to the caller's own tenant: one of another tenant is refused as 422 naming the field, like one that does not exist.
  createMneObligationRule: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/mne-obligation-rules',
      body: {
        rule_code: 'MATRIX-RULE',
        form_id: t.mneFormId,
        reporting_role: 'INVESTOR',
        recipient: 'Matrix recipient',
        frequency: 'SEMIANNUAL',
        due_rule_json: { period: 'H1', month: 7, day: 10 },
        legal_basis: 'Matrix legal basis',
        effective_from: '2026-01-01',
      },
    }),
  },
  publishMneObligationRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-obligation-rules/${t.mneRuleId}/publish`, ifMatch: '"1"', body: {} }),
  },
  // The rules in force and the units are the caller's own: a caller of another tenant has no rule (422 NO_EFFECTIVE_RULE) and never touches tenant A.
  generateMneObligations: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/mne-obligations/generate', body: { report_year: 2026 } }),
  },
  // The category named in the body is looked up in the caller's own tenant: one of another tenant is refused as 422 naming the field, like one that does not exist.
  upsertIssueSlaPolicy: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/issue-sla-policies',
      body: { code: 'MATRIX-SLA', category_version_id: t.issueCategoryVersionId, severity: 'LOW', calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 8, valid_from: '2999-01-01' },
    }),
  },
  retireIssueSlaPolicy: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issue-sla-policies/${t.slaPolicyId}/retire`, body: { valid_until: '2999-12-31' } }),
  },
  // The members named in the body are checked as members of the caller's own tenant: another tenant's member is refused as 422 naming the field, like one that does not exist.
  registerDataset: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/dgv/datasets',
      body: {
        dataset_code: 'DS-MATRIX-NEW',
        title: 'Matrix dataset',
        domain: 'MATRIX',
        grain: 'one row per matrix case',
        producer_module: 'PAY',
        owner_user_id: t.recipientMembershipId,
        steward_user_id: t.recipientMembershipId,
        classification: 'INTERNAL',
        is_critical: false,
        freshness_slo_seconds: 3600,
      },
    }),
  },
  assignDatasetOwnership: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/datasets/${t.datasetId}/ownership`, ifMatch: '"1"', body: { owner_user_id: t.recipientMembershipId, steward_user_id: t.recipientMembershipId, reason: REASON } }),
  },
  createProject: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/projects',
      body: { code: 'MX-NEW-PRJ', name: 'Matrix new project', owner_unit_id: t.unit2, area_master_version_id: t.projectAreaVersionId, total_investment_vnd: '1000' },
    }),
  },
  updateProjectProfile: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/profile`, ifMatch: '"1"', body: { name: 'Renamed by matrix' } }),
  },
  createContract: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/contracts',
      body: {
        project_id: t.contractProjectId,
        package_id: t.contractPackageId,
        contractor_id: t.contractorId,
        code: 'MX-NEW-CONTRACT',
        title: 'Matrix new contract',
        type: 'LUMP_SUM',
        advance_category: 'CONSTRUCTION',
        contract_value_vnd: '1000',
        document_version_id: t.documentVersionId,
      },
    }),
  },
  reviseContractDraft: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/draft`, ifMatch: '"1"', body: { title: 'Renamed by matrix' } }),
  },
  replaceContractParties: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/parties`,
      ifMatch: '"1"',
      body: {
        parties: [
          { contractor_id: t.contractorId, role: 'LEAD', share_pct: '60', work_value_vnd: '600' },
          { contractor_id: t.contractMemberId, role: 'MEMBER', share_pct: '40', work_value_vnd: '400' },
        ],
      },
    }),
  },
  cancelContractDraft: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  resetIntegrationCursor: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/integration-cursors/${t.integrationCursorId}/reset`, ifMatch: '"1"', body: { reason: REASON, cursor_json: {} } }),
  },
  proposeGlossaryTerm: {
    // The owner is a member of tenant A: another tenant's caller is refused as 422 (no such owner for it), never told whose owner it is.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/glossary-terms',
      body: {
        term_code: 'MATRIX_TERM_NEW',
        term_vi: 'Thuật ngữ ma trận',
        definition: 'Định nghĩa của thuật ngữ do ma trận phân quyền tạo ra.',
        domain: 'MATRIX',
        owner_membership_id: t.glossaryOwnerId,
      },
    }),
  },
  submitGlossaryTerm: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/glossary-terms/${t.glossaryDraftTermId}/submit`, ifMatch: '"1"', body: {} }),
  },
  decideGlossaryTerm: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/glossary-terms/${t.glossaryReviewTermId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  publishGlossaryTerm: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/glossary-terms/${t.glossaryApprovedTermId}/publish`, ifMatch: '"1"', body: {} }),
  },
  markNotificationRead: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notifications/${t.notificationId}/read`, body: { opened_via: 'IN_APP' } }),
  },
  acknowledgeNotification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notifications/${t.notificationId}/acknowledge`, body: {} }),
  },
};

export type MatrixCaseKind = 'role' | 'wrong-tenant' | 'control-plane';

export interface MatrixCase {
  id: string;
  operationId: string;
  kind: MatrixCaseKind;
  /** The system role the caller holds alone (kind `role`). */
  roleCode?: string;
}

export interface MatrixOperation {
  operationId: string;
  permission: string;
  plane: string;
}

/** The generated permission, plane of each command, read from the same table the policy guard uses. */
export function operationsOf(operationIds: readonly string[]): MatrixOperation[] {
  return operationIds.map((operationId) => {
    const permission = (PERMISSIONS as Readonly<Record<string, string>>)[operationId];
    if (permission === undefined) throw new Error(`operation ${operationId} has no permission in the generated table`);
    return { operationId, permission, plane: 'tenant' };
  });
}

/**
 * The negative cases of ST-IAM-004 TK-5: for every command, one case per system role whose seeded
 * permissions do not match the command's permission, plus a wrong-tenant caller and a control-plane
 * audience. Order is stable (operations as given, roles by seed order).
 */
export function negativeCasesFor(operations: readonly MatrixOperation[], roles: readonly SystemRole[]): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (const operation of operations) {
    for (const role of roles) {
      if (holdsPermission(new Set(role.permissions), operation.permission)) continue;
      cases.push({ id: `${operation.operationId}:role:${role.code}`, operationId: operation.operationId, kind: 'role', roleCode: role.code });
    }
    cases.push({ id: `${operation.operationId}:wrong-tenant`, operationId: operation.operationId, kind: 'wrong-tenant' });
    cases.push({ id: `${operation.operationId}:control-plane`, operationId: operation.operationId, kind: 'control-plane' });
  }
  return cases;
}

export interface Observation {
  status: number;
  code: unknown;
  text: string;
  /** DENIED audit rows `authz.denied:<operation>` of the caller written by this request. */
  deniedRows: number;
  /** The tenant state fingerprint changed during this request. */
  stateChanged: boolean;
}

/** Failures of a case that must be refused by the policy guard (kinds `role` and `control-plane`, and the step-up replays). */
export function evaluateGuardDenial(observation: Observation, expectedCode = 'SCOPE_DENIED'): string[] {
  const failures: string[] = [];
  if (observation.status !== 403) failures.push(`answered ${observation.status} instead of 403`);
  if (observation.code !== expectedCode) failures.push(`code ${String(observation.code)} instead of ${expectedCode}`);
  if (observation.deniedRows !== 1) failures.push(`${observation.deniedRows} DENIED audit rows instead of 1`);
  if (observation.stateChanged) failures.push('tenant state changed');
  return failures;
}

/**
 * Failures of a wrong-tenant case: nothing of tenant A in the body and nothing changed in tenant A; when the request
 * names ids of tenant A it must also be refused or not found.
 */
export function evaluateWrongTenant(observation: Observation, foreignMarkers: readonly string[], referencesTenantIds = true): string[] {
  const failures: string[] = [];
  if (referencesTenantIds && observation.status !== 403 && observation.status !== 404) failures.push(`answered ${observation.status} instead of 403 or 404`);
  const lowered = observation.text.toLowerCase();
  for (const marker of foreignMarkers) if (lowered.includes(marker.toLowerCase())) failures.push('body exposes data of another tenant');
  if (observation.stateChanged) failures.push('tenant state changed');
  return failures;
}
