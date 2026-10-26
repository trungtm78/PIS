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
  /** A Granted SMS consent of RECIPIENT (version 1): the withdrawal names it in the path. */
  consentId: string;
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
  /** The DRAFT base revision of that contract (version 1, amount 1000) and a PENDING_VERIFICATION guarantee of it made by someone other than the callers (version 1). */
  draftRevisionId: string;
  guaranteeId: string;
  /** A SUBMITTED change event (CE-001, version 1) of that contract, raised by someone other than the callers. */
  changeRequestId: string;
  /** A SUBMITTED measurement (version 1) of that contract, recorded and sent by someone other than the callers, with the item, the line and the period it was recorded against. */
  measurementId: string;
  /** An acceptance of work in DRAFT (version 1) of that contract with one line, drafted by someone other than the callers. */
  workAcceptanceId: string;
  /** A payment request for an approved acceptance of that contract, SUBMITTED (version 1), drawn up by someone other than the callers. */
  paymentRequestId: string;
  /** The approved acceptance that request is for, and that a new request is drawn from. */
  paymentAcceptanceId: string;
  /** A clean version of a file of the tenant. */
  paymentDocumentVersionId: string;
  /** An advance of the contract: the ids of the commands on it need no row to be refused. */
  advanceId: string;
  /** A Treasury transaction and an item of difference: the commands that name them in the path need no row to be refused. */
  treasuryTransactionId: string;
  reconciliationItemId: string;
  /** A settlement of a project: the commands that name it in the path need no row to be refused. */
  settlementId: string;
  /** A non-conformance and one of its corrective actions: the commands that name them in the path need no row to be refused. */
  nonconformanceId: string;
  correctiveActionId: string;
  /** A handover and one of its punch items: the commands that name them in the path need no row to be refused. */
  handoverId: string;
  punchItemId: string;
  /** An asset of a handover: the command that names it in the path needs no row to be refused. */
  assetId: string;
  /** A warranty obligation of a handover: the command that names it in the path needs no row to be refused. */
  warrantyId: string;
  /** A hold of retention: the command that names it in the path needs no row to be refused. */
  retentionHoldId: string;
  /** A household affected by a land recovery: the command that names it in the path needs no row to be refused. */
  householdId: string;
  /** An inventory record of a household: the command that names it in the path needs no row to be refused. */
  inventoryId: string;
  /** A plan of compensation: the command that names it in the path needs no row to be refused. */
  planId: string;
  boqItemId: string;
  periodId: string;
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
  /** A distribution of that document, SENT (version 1). */
  distributionId: string;
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
  /** An OPEN issue of unit 2 of tenant A under that policy (version 1), reported by someone other than the callers. */
  issueId: string;
  /** An OPEN escalation (level 2, to unit 2) of that issue. */
  issueEscalationId: string;
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
  /** A SUBMITTED appraisal sheet (version 1) of a project of tenant A that is in APPRAISAL, made by someone other than the callers. */
  appraisalId: string;
  /** A document of tenant A, named as the decision that authorises a publication. */
  decisionDocumentId: string;
  /** A DRAFT template revision of tenant A made by someone other than the callers (version 1), and the published layout profile it uses. */
  templateId: string;
  layoutProfileId: string;
  /** A PUBLISHED permit type version of tenant A (version 1, open-ended). */
  permitTypeId: string;
  /** A PUBLISHED gate rule of tenant A on that permit type (version 1, open-ended). */
  gateRuleId: string;
  /** An ACTIVE waiver of the HANDOVER gate of the CONCEPT project of unit 2 of tenant A for that permit type (version 1). */
  gateWaiverId: string;
  /** The permit dossier of the CONCEPT project of unit 2 of tenant A (version 1) and a permit in it, IN_APPRAISAL (version 1). */
  permitDossierId: string;
  permitId: string;
  /** The version in force of a fund source of tenant A, and a DRAFT appropriation of it made by someone other than the callers (version 1). */
  fundSourceVersionId: string;
  appropriationId: string;
  /** A DRAFT capital plan of tenant A, annual 2026, made by someone other than the callers (version 1). */
  capitalPlanId: string;
  /** A line of a plan of tenant A and a request to carry capital of it over to the next year, made by someone other than the callers (version 1). */
  allocationLineId: string;
  allocationExtensionId: string;
  /** Reporting periods of tenant A past their deadline: one OPEN and one SOFT_CLOSED (both version 1). */
  periodOpenId: string;
  periodSoftClosedId: string;
  /** A LOCKED reporting period of tenant A, and a request to reopen it made by someone other than the callers (version 1). */
  periodLockedId: string;
  reopenRequestId: string;
  /** A DRAFT report form and a DRAFT obligation rule of it in tenant A, made by someone other than the callers (both version 1). */
  mneFormId: string;
  mneRuleId: string;
  /** A SURVEYED land parcel of the CONCEPT project of unit 2 of tenant A, answered for by unit 2 (version 1). */
  parcelId: string;
  /** A land section of the same project with no contract and nothing handed over (version 1). */
  sectionId: string;
  /** A PIPELINE project of unit 2 of tenant A with a line of capital in a published plan, a DRAFT procurement plan of it (version 1) and an IN_REVIEW one of another such project (version 2), made by someone other than the callers. */
  bidPlanProjectId: string;
  bidPlanLineId: string;
  bidPlanDraftId: string;
  bidPlanInReviewId: string;
  /** A package of an approved plan in a project of unit 2 of tenant A, and a DRAFT version of criteria (version 1) for it, made by the actor of the seed. */
  criteriaPackageId: string;
  criteriaDraftId: string;
  /** A declaration of conflict of interest of that package that is waiting for a decision (version 1), made by the actor of the seed. */
  conflictDeclarationId: string;
  /** A SUBMITTED result of that package, submitted by someone other than the callers (version 1). */
  resultId: string;
  /** A RECEIVED petition of a contractor (version 1) on that package, logged by someone other than the callers. */
  petitionId: string;
  /** A REQUESTED inspection (version 1) of the draft contract, asked for by someone other than the callers. */
  inspectionId: string;
  /** Quality acceptance minutes in DRAFT (version 1) of the draft contract, drafted by someone other than the callers. */
  acceptanceId: string;
  /** A DIS dataset of tenant A with its working contract, a DRAFT quality rule of it made by someone other than the callers (version 1), and a frozen snapshot of the open period. */
  qualityContractId: string;
  qualityRuleId: string;
  qualitySnapshotId: string;
  /** A DRAFT availability control policy of tenant A made by someone other than the callers (version 1). */
  avcPolicyId: string;
  /** An ACTIVE deputy-leader assignment of the CONCEPT project of unit 2 of tenant A (version 1), and an ACTIVE task force scoped to unit 2 (version 1); both name RECIPIENT. */
  accountabilityId: string;
  taskForceId: string;
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
  uploadDocumentFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/document-files', body: {} }),
  },
  uploadLeaderSignedDocument: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/outgoing-documents/${t.outgoingDocumentId}/signed-uploads`,
      ifMatch: '"1"',
      body: { file_object_key: 'tenants/matrix/document/none', file_sha256: 'a'.repeat(64) },
    }),
  },
  issueOutgoingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/issuance`, ifMatch: '"1"', body: {} }),
  },
  dispatchOutgoingDocument: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/outgoing-documents/${t.outgoingDocumentId}/distributions`,
      ifMatch: '"1"',
      body: { recipients: [{ name: 'Matrix recipient', channel: 'PAPER_HANDOVER' }] },
    }),
  },
  recordDistributionAcknowledgement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-distributions/${t.distributionId}/acknowledgement`, ifMatch: '"1"', body: { acknowledged_at: '2026-01-02T00:00:00Z' } }),
  },
  retryDocumentDistribution: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-distributions/${t.distributionId}/retry`, ifMatch: '"1"', body: {} }),
  },
  registerExternallySignedDocument: {
    // A register or unit of another tenant is a refusal of the request (422), like any reference of a command.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/outgoing-documents/external-registrations',
      body: {
        doc_type_code: 'QD',
        title: 'Matrix external registration',
        file_object_key: 'tenants/matrix/document/none',
        file_sha256: 'a'.repeat(64),
        declared_number: 1,
        declared_symbol: '1/QD-MATRIX',
        declared_issued_on: '2026-01-02',
        register_id: t.registerId,
        drafting_unit_id: t.unit2,
      },
    }),
  },
  requestDocumentIssue: {
    // The payload is looked up by the reference and a template or unit of another tenant is a refusal of the request, not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/document-issue-requests',
      body: {
        source_module: 'MNE',
        source_ref: 'MNE:mne_report:matrix:r1',
        template_code: 'QD-DEFAULT',
        payload_ref: 'tenants/matrix/payloads/none.json',
        payload_sha256: 'a'.repeat(64),
        event_id: '00000000-0000-4000-8000-0000000000ee',
        as_of_date: '2026-10-23',
        signer_hint: { drafting_unit_id: t.unit2 },
      },
    }),
  },
  createOutgoingDocument: {
    // A unit that does not exist in the caller's tenant is a 422 (like a missing reference of any command), not a 404.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/outgoing-documents',
      body: { doc_type_code: 'QD', template_code: 'QD-DEFAULT', title: 'Matrix draft', drafting_unit_id: t.unit2, payload: { agency: 'Matrix agency', place: 'Cao Bang', title: 'Matrix', body: 'Matrix' } },
    }),
  },
  updateOutgoingDocumentDraft: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/draft`, ifMatch: '"1"', body: { title: 'Matrix title' } }),
  },
  submitOutgoingDocumentForReview: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/review-submission`, ifMatch: '"1"', body: {} }),
  },
  recallOutgoingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/recall`, ifMatch: '"1"', body: { reason: 'negative authorization matrix recall' } }),
  },
  voidOutgoingDocumentNumber: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/outgoing-documents/${t.outgoingDocumentId}/number-voiding`,
      ifMatch: '"1"',
      body: { reason: 'negative authorization matrix void', approver_user_id: t.recipientMembershipId },
    }),
  },
  decideOutgoingDocumentReview: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/review-decision`, ifMatch: '"1"', body: { decision: 'RETURN', comment: 'negative authorization matrix' } }),
  },
  returnOutgoingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/return`, ifMatch: '"1"', body: { reason: 'negative authorization matrix' } }),
  },
  cancelOutgoingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/cancellation`, ifMatch: '"1"', body: { reason: 'negative authorization matrix', reject_code: 'CANCELLED_BY_DRAFTER' } }),
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
  uploadReportFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/report-files', body: {} }),
  },
  uploadLandParcelFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/land-parcels/files', body: {} }),
  },
  uploadNationalCodeFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/project-national-code-imports/files', body: {} }),
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
  uploadTreasuryStatementFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/treasury-imports/files', body: {} }),
  },
  importTreasuryStatement: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/treasury-imports',
      body: { file_object_id: '00000000-0000-4000-8000-0000000000e1', file_sha256: 'a'.repeat(64), source_kind: 'STATEMENT_FILE' },
    }),
  },
  confirmTreasuryManually: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/treasury-transactions',
      body: {
        payment_request_id: '00000000-0000-4000-8000-0000000000e2',
        document_no: 'CT-MATRIX',
        document_date: '2026-10-15',
        amount_vnd: '1000',
        confirmed_at: '2026-10-16T02:00:00Z',
        evidence_document_version_id: '00000000-0000-4000-8000-0000000000e3',
      },
    }),
  },
  receiveTreasuryCallback: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/integrations/treasury/callbacks',
      body: {
        provider_event_id: 'matrix-event',
        provider: 'MATRIX',
        document_no: 'CT-MATRIX',
        document_date: '2026-10-15',
        project_code: 'NO-SUCH',
        amount_vnd: '1000',
        direction: 'PAYMENT',
        confirmed_at: '2026-10-16T02:00:00Z',
        signature: 'b'.repeat(64),
      },
    }),
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
  requestAllocationExtension: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/allocation-lines/${t.allocationLineId}/extensions`, body: { amount_vnd: '100', extended_to: '2027-03-31', reason_code: 'GPMB_CHAM' } }),
  },
  decideAllocationExtension: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/allocation-extensions/${t.allocationExtensionId}/decision`, ifMatch: '"1"', body: { decision: 'reject', reason: REASON } }),
  },
  closeFiscalYear: {
    // The year control belongs to the tenant of the caller: a caller of another tenant works on the year of their own tenant, and never touches tenant A.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/fiscal-years/2024/close', ifMatch: '"1"', body: { target_status: 'SOFT_CLOSED', reason: REASON } }),
  },
  reopenFiscalYear: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/fiscal-years/2024/reopen', ifMatch: '"1"', body: { reason: 'Matrix case, the audit found a mistake in the allocation', window_hours: 24 } }),
  },
  createCapitalPlan: {
    // The unit of tenant A does not exist for a caller of tenant B (404).
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/capital-plans', body: { plan_code: 'MX-PLAN', plan_kind: 'ANNUAL', plan_year: 2027, period_from_year: 2027, period_to_year: 2027, scope_unit_id: t.unit2 } }),
  },
  submitCapitalPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/capital-plans/${t.capitalPlanId}/submit`, ifMatch: '"1"', body: {} }),
  },
  decideCapitalPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/capital-plans/${t.capitalPlanId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  post_plans_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/plans/${t.capitalPlanId}/publish`, ifMatch: '"1"', body: { decision_document_id: t.decisionDocumentId } }),
  },
  createCapitalPlanRevision: {
    // A plan of tenant A is not there for a caller of tenant B; for a caller of tenant A without the permission it is refused before the plan is looked at.
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/capital-plans/${t.capitalPlanId}/revisions`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  registerDisbursementSchedule: {
    // The project of tenant A does not exist for a caller of tenant B (404); a caller of tenant A without the permission is refused before the project is looked at.
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/disbursement-schedules',
      body: { project_id: t.projectId, plan_year: 2026, granularity: 'MONTH', month: 10, kind: 'REGISTERED', bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', amount_vnd: '100' },
    }),
  },
  draftCapitalAllocation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/capital-plans/${t.capitalPlanId}/allocations`,
      ifMatch: '"1"',
      body: { lines: [{ project_id: t.projectId, appropriation_id: t.appropriationId, bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: '100' }] },
    }),
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
  post_reports: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/reports',
      body: { project_id: t.projectId, period_id: t.periodOpenId, plan_version_id: t.legalHoldId, measurement_basis: 'YTD', funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1000' }] },
    }),
  },
  post_reports_id_revisions: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/reports/${t.legalHoldId}/revisions`,
      ifMatch: '"1"',
      body: { project_id: t.projectId, period_id: t.periodOpenId, plan_version_id: t.legalHoldId, measurement_basis: 'YTD', funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1000' }] },
    }),
  },
  post_reports_id_submit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/submit`, ifMatch: '"1"', body: {} }),
  },
  post_reports_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: 'Checked against the Treasury.', evidence_ids: [] } }),
  },
  post_reports_id_corrections: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/corrections`, ifMatch: '"1"', body: { amendment_reason: 'The Treasury corrected a payment.' } }),
  },
  requestPeriodReopen: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reporting-periods/${t.periodLockedId}/reopen-requests`, body: { scope_kind: 'PERIOD', reason: 'Matrix request to reopen the locked period', window_hours: 24 } }),
  },
  decidePeriodReopen: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/period-reopens/${t.reopenRequestId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, window_hours: 24 } }),
  },
  retirePermitType: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permit-types/${t.permitTypeId}/retire`, body: { effective_until: '2999-12-31' } }),
  },
  publishPermitGateRule: {
    // The permit type is named in the body: it is looked up in the caller's own tenant, so there is nothing of tenant A to be told apart.
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/permit-gate-rules',
      body: { gate_code: 'HANDOVER', permit_type_id: t.permitTypeId, requirement: 'VALID_PERMIT', applies_to_rule: {}, legal_basis: 'Matrix legal basis', effective_from: '2999-01-01' },
    }),
  },
  grantPermitGateWaiver: {
    // The project, the permit type and the decision are looked up in the caller's own tenant: one of tenant A does not exist for a caller of tenant B.
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/permit-gate-waivers',
      body: {
        project_id: t.projectId,
        gate_code: 'START_CONSTRUCTION',
        permit_type_id: t.permitTypeId,
        reason: REASON,
        decision_document_version_id: t.documentVersionId,
        valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      },
    }),
  },
  revokePermitGateWaiver: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permit-gate-waivers/${t.gateWaiverId}/revoke`, body: { reason: REASON } }),
  },
  retirePermitGateRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permit-gate-rules/${t.gateRuleId}/retire`, body: { effective_until: '2999-12-31' } }),
  },
  // The project, the dossier and the permit are looked up in the caller's own tenant: one of tenant A does not exist for a caller of tenant B (404).
  createPermitDossier: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/permit-dossiers`, body: { owner_unit_id: t.unit2 } }),
  },
  addPermit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permit-dossiers/${t.permitDossierId}/permits`, body: { permit_type_id: t.permitTypeId } }),
  },
  recordPermitMilestone: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permits/${t.permitId}/milestones`, ifMatch: '"1"', body: { step_code: 'APPRAISAL_MEETING', planned_on: '2999-01-01' } }),
  },
  recordPermitDecision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permits/${t.permitId}/decision`, ifMatch: '"1"', body: { outcome: 'REJECTED', reason: REASON } }),
  },
  renewPermit: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/permits/${t.permitId}/renew`,
      ifMatch: '"1"',
      body: { new_permit_no: 'MATRIX-RENEWED', new_valid_until: '2999-12-31', document_version_id: t.documentVersionId },
    }),
  },
  revokePermit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/permits/${t.permitId}/revoke`, ifMatch: '"1"', body: { reason: REASON, decision_document_version_id: t.documentVersionId } }),
  },
  declarePermitExemption: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/permits/${t.permitId}/exempt`,
      ifMatch: '"1"',
      body: { exemption_basis: 'Negative authorization matrix', exemption_decision_document_version_id: t.documentVersionId },
    }),
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
  // The project, the unit and the category named in the body are looked up in the caller's own tenant: those of tenant A do not exist for a caller of another tenant (404 or 422).
  createIssue: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/issues',
      body: {
        project_id: t.projectId,
        category_version_id: t.issueCategoryVersionId,
        severity: 'HIGH',
        title: 'Matrix issue',
        description: 'Matrix issue description',
        owner_unit_id: t.unit2,
        client_operation_id: '00000000-0000-4000-8000-0000000000e1',
      },
    }),
  },
  assignIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/assign`, ifMatch: '"1"', body: { assignee_id: t.recipientMembershipId } }),
  },
  startIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/start`, ifMatch: '"1"', body: {} }),
  },
  commentIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/comments`, body: { note: REASON } }),
  },
  transferIssueUnit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/transfer`, ifMatch: '"1"', body: { target_unit_id: t.unit3, reason: REASON } }),
  },
  requestIssueVerification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/request-verification`, ifMatch: '"1"', body: { result_note: REASON, evidence_document_version_ids: [t.documentVersionId] } }),
  },
  closeIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/close`, ifMatch: '"1"', body: { verification_note: REASON } }),
  },
  reopenIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/reopen`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  escalateIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/escalate`, ifMatch: '"1"', body: { level: 1, reason: REASON } }),
  },
  acceptIssueEscalation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issue-escalations/${t.issueEscalationId}/accept`, body: { note: REASON } }),
  },
  extendIssueDeadline: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/issues/${t.issueId}/extend`, ifMatch: '"1"', body: { new_due_at: '2999-01-01T00:00:00.000Z', reason: REASON } }),
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
  // The contract named in the body is checked as a contract of the caller's own tenant: another tenant's contract is refused as 422 naming the field, like one that does not exist.
  createQualityRuleVersion: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/dgv/quality-rules',
      body: {
        contract_id: t.qualityContractId,
        code: 'R-MATRIX-NEW',
        dimension: 'COMPLETENESS',
        expression_ast: { op: 'not_null', field: 'project_id' },
        severity: 'MEDIUM',
        threshold_json: { min_pass_rate_pct: '100' },
        action_on_fail: 'QUARANTINE',
        criticality_weight: 1,
      },
    }),
  },
  approveQualityRuleVersion: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/quality-rules/${t.qualityRuleId}/approval`, ifMatch: '"1"', body: {} }),
  },
  // An internal-plane command: a tenant token is the wrong plane for it, so every caller of the matrix is refused, the owner (who may grant the permission to a service account) included.
  recordUsageEvent: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/internal/usage-events',
      body: { meter: 'notification.zns', external_event_key: 'matrix-negative', quantity: '1', occurred_at: '2026-01-01T00:00:00Z', source_reference: 'negative authorization matrix' },
    }),
  },
  createAvcPolicyVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/avc-policies',
      body: { policy_code: 'MX-NEGATIVE', scope_kind: 'TENANT', control_object: 'ALLOCATION_LINE', warn_pct: '90', block_pct: '100', legal_basis: 'negative authorization matrix', effective_from: '2026-01-01' },
    }),
  },
  publishAvcPolicy: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/avc-policies/${t.avcPolicyId}/publish`, ifMatch: '"1"', body: {} }),
  },
  runQualityChecks: {
    referencesTenantIds: false,
    build: (t) => ({ method: 'POST', path: '/dgv/quality-runs', body: { dataset_contract_id: t.qualityContractId, snapshot_id: t.qualitySnapshotId, trigger: 'MANUAL' } }),
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
  // The stage commands name the CONCEPT project of tenant A and the decision document of the matrix: a caller without the permission is refused before
  // any lookup, and a caller of another tenant finds no such project; the project is never moved.
  startProjectImplementation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/implementation-start`, ifMatch: '"1"', body: { reason: REASON, investment_decision_document_id: t.decisionDocumentId } }),
  },
  suspendProject: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/suspension`, ifMatch: '"1"', body: { reason: REASON, decision_document_id: t.decisionDocumentId } }),
  },
  resumeProject: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/resumption`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  completeProject: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/completion`, ifMatch: '"1"', body: { reason: REASON, decision_document_id: t.decisionDocumentId } }),
  },
  closeProject: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/closure`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  cancelProject: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/cancellation`, ifMatch: '"1"', body: { reason: REASON, decision_document_id: t.decisionDocumentId } }),
  },
  // The national code commands: the code of the CONCEPT project is not set by a caller that is refused, and a file of tenant A is not read for another tenant.
  assignNationalProjectCode: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/national-code`, ifMatch: '"1"', body: { national_project_code: '9900001', evidence_document_id: t.decisionDocumentId } }),
  },
  // The procurement milestones and the file of the national bidding system: the package of the approved plan is not touched by a caller that is refused, and no file is read.
  recordProcurementMilestone: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-packages/${t.criteriaPackageId}/milestones`, ifMatch: '"1"', body: { milestone_kind: 'BID_OPENING', actual_at: '2026-09-01T03:00:00Z' } }),
  },
  importProcurementFile: {
    referencesTenantIds: true,
    build: () => ({
      method: 'POST',
      path: '/procurement-imports',
      body: { file_object_key: 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64), mode: 'DRY_RUN' },
    }),
  },
  uploadProcurementFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/procurement-imports/files', body: {} }),
  },
  // The sealed proposal and the declaration of conflict of interest: no proposal is received, no conflict declared and none decided by a caller that is refused.
  receiveProposal: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/proposals',
      body: {
        package_id: t.criteriaPackageId,
        contractor_id: t.contractorId,
        submitted_at: '2026-09-01T03:00:00Z',
        documents: [
          { part: 'TECHNICAL', title: 'Matrix volume', file_object_key: 'tenants/00000000-0000-4000-8000-00000000000a/document/00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64) },
        ],
      },
    }),
  },
  uploadProposalFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/proposals/files', body: {} }),
  },
  declareConflictOfInterest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-packages/${t.criteriaPackageId}/conflict-declarations`, body: { has_conflict: false } }),
  },
  submitProcurementResult: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/procurement-results', body: { package_id: t.criteriaPackageId, outcome: 'CANCELLED', evaluation_report_id: t.documentVersionId } }),
  },
  // The petitions of contractors: a caller that is refused logs none and answers none.
  // The inspections: a caller that is refused requests none, schedules none, records no result and cancels none.
  requestInspection: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/inspections', body: { contract_id: t.draftContractId, inspection_type: 'SAFETY', title: REASON, requested_for: '2026-12-31' } }),
  },
  scheduleInspection: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/inspections/${t.inspectionId}/schedule`, ifMatch: '"1"', body: { scheduled_at: '2999-01-01T00:00:00Z', participant_membership_ids: [t.recipientMembershipId] } }),
  },
  recordInspectionResult: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/inspections/${t.inspectionId}/result`, ifMatch: '"1"', body: { result: 'PASS', result_note: REASON, checklist: [] } }),
  },
  cancelInspection: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/inspections/${t.inspectionId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The quality acceptance minutes: a caller that is refused drafts none, signs none, decides none and revokes none.
  createQualityAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/inspections/${t.inspectionId}/quality-acceptances`, body: { acceptance_scope: 'WORK_ITEM', record_no: 'QA-MX-NEW', document_version_id: t.draftContractId } }),
  },
  signQualityAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/quality-acceptances/${t.acceptanceId}/sign`, ifMatch: '"1"', body: { signer_role: 'OWNER', signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e5' } }),
  },
  decideQualityAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/quality-acceptances/${t.acceptanceId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  revokeQualityAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/quality-acceptances/${t.acceptanceId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  receiveProcurementPetition: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/procurement-petitions',
      body: { package_id: t.criteriaPackageId, contractor_id: t.contractorId, petition_kind: 'PROCESS', received_on: '2026-10-25', petition_document_id: t.documentVersionId },
    }),
  },
  resolveProcurementPetition: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-petitions/${t.petitionId}/resolution`, ifMatch: '"1"', body: { outcome: 'RESOLVED', resolution_document_id: t.documentVersionId } }),
  },
  decideProcurementResult: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-results/${t.resultId}/decision`, ifMatch: '"1"', body: { decision: 'REJECT', comment: 'Matrix decision of a refused call.' } }),
  },
  decideConflictOfInterest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/bid-conflict-declarations/${t.conflictDeclarationId}/decision`, ifMatch: '"1"', body: { decision: 'ALLOWED', decision_reason: 'Matrix decision of a refused caller.' } }),
  },
  importNationalProjectCodes: {
    referencesTenantIds: true,
    build: () => ({
      method: 'POST',
      path: '/project-national-code-imports',
      body: { file_object_key: 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64), dry_run: true },
    }),
  },
  // The appraisal commands: the CONCEPT project is not moved by a caller that is refused, and the sheet is never decided.
  submitProjectForAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/appraisal-submissions`, ifMatch: '"1"', body: { reason: REASON, policy_proposal_document_id: t.decisionDocumentId } }),
  },
  recordProjectAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/projects/${t.projectId}/appraisals`,
      body: { criteria_set_version_id: t.appraisalId, scores: [{ criterion_code: 'A', score: 4 }], recommendation: 'ADMIT' },
    }),
  },
  decideProjectAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/project-appraisals/${t.appraisalId}/decision`,
      ifMatch: '"1"',
      body: { decision: 'ADMIT', reason: REASON, decision_document_id: t.decisionDocumentId, project_group: 'B' },
    }),
  },
  createProcurementPlan: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/procurement-plans',
      body: {
        project_id: t.bidPlanProjectId,
        title: 'Matrix procurement plan',
        legal_basis: 'Matrix legal basis',
        packages: [
          {
            code: 'MX-NEW-PKG',
            title: 'Matrix package',
            budget_vnd: '100',
            method: 'OPEN_BIDDING',
            contract_type: 'LUMP_SUM',
            bidding_form: 'ONLINE',
            allocation_line_id: t.bidPlanLineId,
            planned_start_period: '2026-Q4',
            duration_days: 30,
          },
        ],
      },
    }),
  },
  createSupportTicket: {
    // The ticket names nothing of tenant A: a caller of tenant B who holds the right raises a ticket of their own.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/support-tickets', body: { category: 'OTHER', subject: 'Negative authorization matrix', description: 'A ticket raised by the negative authorization matrix.' } }),
  },
  createCriteriaVersion: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/criteria-versions',
      body: {
        package_id: t.criteriaPackageId,
        criteria_json: { criteria: [{ code: 'MX1', name: 'Matrix criterion', kind: 'SCORED', weight: 100, max_score: 10, threshold: 5, mandatory: false, required_evidence: [] }] },
        legal_basis: 'Matrix legal basis',
      },
    }),
  },
  approveCriteriaVersion: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/criteria-versions/${t.criteriaDraftId}/approval`, ifMatch: '"1"', body: {} }),
  },
  submitProcurementPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-plans/${t.bidPlanDraftId}/submit`, ifMatch: '"1"', body: {} }),
  },
  decideProcurementPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-plans/${t.bidPlanInReviewId}/decision`, ifMatch: '"2"', body: { decision: 'APPROVE', decision_document_id: t.decisionDocumentId } }),
  },
  // The assignment commands are given to the whole tenant: a caller with the permission on a subtree only is refused 403 SCOPE_DENIED, and nothing is written.
  assignProjectLeader: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/projects/${t.projectId}/accountability-assignments`,
      body: { leader_membership_id: t.recipientMembershipId, accountability_role: 'LEADER_IN_CHARGE', valid_from: '2026-01-05' },
    }),
  },
  endProjectLeaderAssignment: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/accountability-assignments/${t.accountabilityId}/end`, ifMatch: '"1"', body: { valid_until: '2026-01-06', end_reason: REASON } }),
  },
  createTaskForce: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/task-forces',
      body: { code: 'MX-TF-NEW', name: 'Matrix task force', purpose: 'Created by the authorization matrix', lead_membership_id: t.recipientMembershipId, scope_unit_id: t.unit2, valid_from: '2026-01-05' },
    }),
  },
  addTaskForceMember: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/task-forces/${t.taskForceId}/members`, body: { membership_id: t.recipientMembershipId, member_role: 'SECRETARY', valid_from: '2026-01-05' } }),
  },
  dissolveTaskForce: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/task-forces/${t.taskForceId}/dissolution`, ifMatch: '"1"', body: { reason: REASON } }),
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
  // The life of a contract: the review, the signing and the activation. A caller that is refused changes no status and signs nothing.
  submitContractForReview: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/submit-review`, ifMatch: '"1"', body: { note: REASON } }),
  },
  returnContractDraft: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/return`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  recordContractSigning: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/sign`, ifMatch: '"1"', body: { signed_on: '2026-10-25', signed_document_version_id: t.documentVersionId } }),
  },
  // The suspension, the resumption and the termination of a contract rest on a decision document; a caller that is refused changes no status and calls no guarantee.
  suspendContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/suspend`, ifMatch: '"1"', body: { reason: REASON, decision_document_version_id: t.documentVersionId, suspended_from: '2026-10-25' } }),
  },
  resumeContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/resume`, ifMatch: '"1"', body: { reason: REASON, decision_document_version_id: t.documentVersionId, resumed_on: '2026-10-25' } }),
  },
  terminateContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/terminate`, ifMatch: '"1"', body: { reason: REASON, decision_document_version_id: t.documentVersionId, terminated_on: '2026-10-25', guarantee_action: 'HOLD' } }),
  },
  completeContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/complete`, ifMatch: '"1"', body: { completion_quality_acceptance_id: t.documentVersionId, completed_on: '2026-10-25' } }),
  },
  closeContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/close`, ifMatch: '"1"', body: { settlement_revision_id: t.settlementId, note: REASON } }),
  },
  // The chain of changes: a caller that is refused sets no tiers, raises no request and moves none along the chain.
  setChangeChainTiers: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.contractProjectId}/change-chain-config`, body: { tier_count: 2 } }),
  },
  createChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/change-requests`, body: { stage: 'EVENT', baseline_revision_id: t.draftRevisionId, reason: REASON } }),
  },
  promoteChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/change-requests/${t.changeRequestId}/promote`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  evaluateChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/change-requests/${t.changeRequestId}/evaluate`, ifMatch: '"1"', body: { evaluated_delta_vnd: '0', schedule_impact_days: 0, funding_impact_note: REASON } }),
  },
  post_contract_changes_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contract-changes/${t.changeRequestId}/decision`, ifMatch: '"1"', body: { decision: 'return', reason: REASON, evidence_ids: [] } }),
  },
  // The measurements: a caller that is refused records no quantity, sends none, decides none and corrects none.
  recordMeasurement: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/measurements`,
      body: { contract_revision_id: t.draftRevisionId, boq_item_id: t.boqItemId, period_id: t.periodId, quantity_period: '1', reference_no: 'MX-REF', evidence_refs: [] },
    }),
  },
  submitMeasurement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/measurements/${t.measurementId}/submit`, ifMatch: '"1"', body: {} }),
  },
  post_measurements_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/measurements/${t.measurementId}/decision`, ifMatch: '"1"', body: { decision: 'return', reason: REASON, evidence_ids: [] } }),
  },
  correctMeasurement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/measurements/${t.measurementId}/correct`, ifMatch: '"1"', body: { quantity_period: '1', correction_reason: REASON, evidence_refs: [] } }),
  },
  // The acceptance of work: a caller that is refused drafts none, sends none, decides none and revokes none.
  createAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/acceptances`, body: { measurement_ids: [t.measurementId], period_id: t.periodId, document_version_id: t.draftContractId } }),
  },
  submitAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/acceptances/${t.workAcceptanceId}/submit`, ifMatch: '"1"', body: { signer_refs: [{ name: 'Matrix signer' }] } }),
  },
  post_acceptances_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/acceptances/${t.workAcceptanceId}/decision`, ifMatch: '"1"', body: { decision: 'return', reason: REASON, evidence_ids: [] } }),
  },
  revokeAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/acceptances/${t.workAcceptanceId}/revoke`, ifMatch: '"1"', body: { reason: REASON, approval_document_version_id: t.draftContractId } }),
  },
  // The draft of a payment request: a caller that is refused draws none up, revises none, attaches no document and cancels none.
  createPaymentRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/payment-requests', body: { contract_id: t.draftContractId, request_kind: 'INTERIM', acceptance_id: t.paymentAcceptanceId, allocation_line_id: t.draftContractId, request_no: 'DNTT-MX-NEW' } }),
  },
  revisePaymentDraft: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/draft`, ifMatch: '"1"', body: { request_no: 'DNTT-MX-REV' } }),
  },
  attachPaymentDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/documents`, body: { document_version_id: t.paymentDocumentVersionId, doc_kind: 'OTHER' } }),
  },
  cancelPaymentRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The Treasury forms of a checked request and the record that the file was sent.
  generatePaymentForms: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/forms`, body: { form_codes: ['03.a/TT'], place: 'Cao Bằng' } }),
  },
  markPaymentSentToTreasury: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/send-treasury`, ifMatch: '"1"', body: { treasury_submitted_on: '2026-10-25', form_instance_ids: [t.paymentRequestId] } }),
  },
  // The advance of a contract: asked for, cancelled and recovered outside the payments.
  requestAdvance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/advances`, body: { party_id: t.draftContractId, kind: 'GPMB', amount_vnd: '1', allocation_line_id: t.draftContractId } }),
  },
  cancelAdvance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/advances/${t.advanceId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  recordAdvanceRecovery: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/advances/${t.advanceId}/recoveries`, ifMatch: '"1"', body: { amount_vnd: '1', basis: 'REFUND', evidence_document_version_id: t.paymentDocumentVersionId } }),
  },
  // Matching a Treasury transaction to a payment, and the work on a difference.
  matchTreasuryTransaction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/treasury-transactions/${t.treasuryTransactionId}/match`, body: { payment_request_id: t.paymentRequestId } }),
  },
  assignReconciliationItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reconciliation-items/${t.reconciliationItemId}/assign`, ifMatch: '"1"', body: { owner_membership_id: t.paymentRequestId, due_at: '2030-01-01T00:00:00Z' } }),
  },
  resolveReconciliationItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reconciliation-items/${t.reconciliationItemId}/resolve`, ifMatch: '"1"', body: { resolution: 'EXPLAINED', note: REASON } }),
  },
  // The handover of a work and its punch list: a caller that is refused drafts none, lists no defect, answers none, verifies none, waives none and decides none.
  createHandover: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/handovers', body: { project_id: t.contractProjectId, contract_id: t.draftContractId, recipient_unit_id: t.recipientMembershipId, handover_kind: 'COMPLETION', handover_no: REASON, quality_acceptance_id: t.draftContractId, document_version_id: t.documentVersionId } }),
  },
  addPunchItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/handovers/${t.handoverId}/punch-items`, ifMatch: '"1"', body: { description: REASON, severity: 'MINOR', due_on: '2999-01-01' } }),
  },
  markPunchItemFixed: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/punch-items/${t.punchItemId}/fixed`, body: { evidence_document_version_id: t.documentVersionId, note: REASON } }),
  },
  verifyPunchItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/punch-items/${t.punchItemId}/verify`, body: { outcome: 'VERIFIED', note: REASON } }),
  },
  waivePunchItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/punch-items/${t.punchItemId}/waive`, body: { waiver_reason: REASON } }),
  },
  post_handovers_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/handovers/${t.handoverId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [], as_built_document_version_id: t.documentVersionId } }),
  },
  // The assets a work produces: a caller that is refused registers none and transfers none.
  registerAsset: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/asset-records', body: { project_id: t.contractProjectId, handover_id: t.handoverId, asset_code: REASON, name: REASON, recipient_unit_id: t.recipientMembershipId, value_vnd: '1', value_basis: 'CONTRACT_VALUE' } }),
  },
  transferAsset: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/asset-records/${t.assetId}/transfer`, ifMatch: '"1"', body: { transferred_on: '2026-10-25', commissioning_document_version_id: t.documentVersionId } }),
  },
  // The households of a land recovery: a caller that is refused registers none and links none to a parcel.
  registerAffectedHousehold: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/affected-households',
      body: { project_id: t.projectId, owner_unit_id: t.unit2, head_name: 'Matrix head of household', legal_basis: 'PUBLIC_TASK_LAND_LAW', legal_basis_ref: REASON, retention_until: '2036-12-31' },
    }),
  },
  draftCompensationPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/compensation-plans', body: { project_id: t.projectId, executor_unit_id: t.unit2, executor_kind: 'LAND_FUND_CENTRE', plan_code: 'MX-PLAN' } }),
  },
  addCompensationPlanItems: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/compensation-plans/${t.planId}/items`,
      ifMatch: '"1"',
      body: { items: [{ household_id: t.householdId, item_kind: 'SUPPORT_LIVELIHOOD', amount_vnd: '1', legal_basis: REASON }] },
    }),
  },
  revisePlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/revise`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  postCompensationPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/post`, ifMatch: '"1"', body: { posting_started_on: '2026-10-20', posting_place_text: REASON } }),
  },
  recordPlanFeedback: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/feedback`, body: { summary: REASON, channel: 'LETTER' } }),
  },
  handlePlanFeedback: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/feedback/${t.planId}/handle`, body: { handling_note: REASON } }),
  },
  closePlanPosting: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/close-posting`, ifMatch: '"1"', body: { feedback_summary: REASON } }),
  },
  approveCompensationPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/approve`, ifMatch: '"1"', body: { approved_on: '2026-10-20', decision_document_version_id: t.documentVersionId } }),
  },
  scheduleCompensationPayments: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-plans/${t.planId}/payments`, ifMatch: '"1"', body: { payments: [{ household_id: t.householdId, amount_vnd: '1' }] } }),
  },
  confirmCompensationPayment: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-payments/${t.planId}/confirm`, ifMatch: '"1"', body: { paid_on: '2026-10-20', method: 'BANK_TRANSFER', voucher_document_version_id: t.documentVersionId } }),
  },
  depositCompensationPayment: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/compensation-payments/${t.planId}/deposit`, ifMatch: '"1"', body: { deposit_reason: REASON, voucher_document_version_id: t.documentVersionId, paid_on: '2026-10-20' } }),
  },
  createAuditEngagement: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/audit-engagements',
      body: {
        engagement_code: 'AUD-MATRIX-1',
        engagement_type: 'STATE_AUDIT',
        authority_kind: 'STATE_AUDIT_OFFICE',
        authority_name: 'Matrix authority',
        decision_document_id: t.documentVersionId,
        title: 'Matrix engagement',
        period_from: '2025-01-01',
        period_to: '2025-12-31',
        coordinator_user_id: t.recipientMembershipId,
        scope: [{ kind: 'UNIT', id: t.unit2 }],
      },
    }),
  },
  recordAuditConclusion: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/audit-engagements/${t.legalHoldId}/conclusions`,
      ifMatch: '"1"',
      body: {
        conclusion_kind: 'AUDIT_REPORT',
        conclusion_document_id: t.documentVersionId,
        issued_on: '2026-10-10',
        received_on: '2026-10-15',
        summary: 'Negative matrix conclusion summary',
        total_financial_vnd: '1000000',
      },
    }),
  },
  recordAuditFinding: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/audit-conclusions/${t.legalHoldId}/findings`,
      body: { finding_code: 'F-MATRIX-1', category: 'FINANCIAL', description: 'Negative matrix finding description', severity: 'HIGH', project_id: t.projectId },
    }),
  },
  createAuditRecommendation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/audit-conclusions/${t.legalHoldId}/recommendations`,
      body: { rec_code: 'R-MATRIX-1', rec_type: 'FINANCIAL_RECOVERY', description: 'Negative matrix recommendation description', amount_vnd: '1000' },
    }),
  },
  assignAuditRecommendation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/assignment`, ifMatch: '"1"', body: { owner_unit_id: t.unit2, due_on: '2026-12-01' } }),
  },
  planRemediationAction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/actions`, ifMatch: '"1"', body: { action_code: 'A-MATRIX-1', description: 'Negative matrix action', planned_on: '2026-12-01' } }),
  },
  completeRemediationAction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-remediation-actions/${t.legalHoldId}/completion`, ifMatch: '"1"', body: { completed_on: '2026-10-20', evidence_document_id: t.documentVersionId } }),
  },
  submitRecommendationForVerification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/verification-request`, ifMatch: '"1"', body: {} }),
  },
  verifyAuditRecommendation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/verification`, ifMatch: '"1"', body: { decision: 'CLOSE' } }),
  },
  disputeAuditRecommendation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/dispute`, ifMatch: '"1"', body: { dispute_reason: 'Negative matrix dispute explanation of the owner', dispute_document_id: t.documentVersionId } }),
  },
  recordAuditDisputeDecision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recommendations/${t.legalHoldId}/dispute-decision`, ifMatch: '"1"', body: { outcome: 'REJECTED_BY_AUTHORITY', authority_document_id: t.documentVersionId } }),
  },
  attachAuditEvidence: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/audit-evidence', body: { owner_kind: 'ENGAGEMENT', owner_id: t.legalHoldId, document_id: t.documentVersionId } }),
  },
  linkAuditRecovery: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/audit-recommendations/${t.legalHoldId}/recoveries`,
      ifMatch: '"1"',
      body: { source_kind: 'MANUAL_EVIDENCE', amount_vnd: '1000', recorded_on: '2026-10-20', evidence_document_id: t.documentVersionId },
    }),
  },
  reverseAuditRecovery: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-recovery-links/${t.legalHoldId}/reversal`, body: { reason: 'Negative matrix reversal of a recovery' } }),
  },
  startAuditEngagement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-engagements/${t.legalHoldId}/start`, ifMatch: '"1"', body: { started_on: '2026-10-20', place_legal_hold: false } }),
  },
  endAuditFieldwork: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-engagements/${t.legalHoldId}/fieldwork-end`, ifMatch: '"1"', body: { on_date: '2026-10-20' } }),
  },
  cancelAuditEngagement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-engagements/${t.legalHoldId}/cancellation`, ifMatch: '"1"', body: { on_date: '2026-10-20', reason: REASON } }),
  },
  closeAuditEngagement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-engagements/${t.legalHoldId}/closure`, ifMatch: '"1"', body: { on_date: '2026-10-20' } }),
  },
  requestAuditFollowUpReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/audit-engagements/${t.legalHoldId}/follow-up-reports`, ifMatch: '"1"', body: { conclusion_id: t.planId, as_of_date: '2026-10-20' } }),
  },
  fileLandComplaint: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/land-complaints', body: { project_id: t.projectId, household_id: t.householdId, owner_unit_id: t.unit2, channel: 'LETTER', subject: 'PRICE', description: REASON, filed_on: '2026-10-20' } }),
  },
  resolveLandComplaint: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/land-complaints/${t.planId}/resolve`, ifMatch: '"1"', body: { outcome: 'ESCALATED', resolved_on: '2026-10-20', note: REASON } }),
  },
  recordInventory: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/land-inventory-records',
      body: { household_id: t.householdId, parcel_id: t.parcelId, item_kind: 'HOUSE', description: 'Matrix house', quantity: '1', unit_code: 'M2', unit_price_vnd: '1', price_decision_ref: 'QD-MATRIX', surveyed_on: '2026-06-20' },
    }),
  },
  confirmInventory: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/land-inventory-records/${t.inventoryId}/confirm`, ifMatch: '"1"', body: { outcome: 'CONFIRMED', household_confirmed_on: '2026-07-01' } }),
  },
  handleHouseholdDataRequest: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/affected-households/${t.householdId}/data-requests`,
      body: { request_kind: 'ACCESS', requester_verified: true, outcome: 'FULFILLED', reason: REASON },
    }),
  },
  linkHouseholdParcel: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/affected-households/${t.householdId}/parcels`, body: { parcel_id: t.parcelId, right_kind: 'OWNER' } }),
  },
  // The retention held back from the payments: a caller that is refused releases none of it.
  releaseRetention: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/retention-holds/${t.retentionHoldId}/release`, ifMatch: '"1"', body: { amount_vnd: '1', reason: REASON } }),
  },
  // The warranty of a work: a caller that is refused creates no obligation and closes none.
  createWarrantyObligation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/warranty-obligations', body: { contract_id: t.contractId, handover_id: t.handoverId, scope_description: REASON, starts_on: '2026-10-25', period_months: 12, construction_grade: 'II', retention_amount_vnd: '1' } }),
  },
  closeWarrantyObligation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/warranty-obligations/${t.warrantyId}/close`, body: { note: REASON } }),
  },
  // The non-conformances of the work: a caller that is refused raises none, assigns no action, answers none, verifies none, closes none and reopens none.
  raiseNonconformance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/nonconformances', body: { contract_id: t.draftContractId, severity: 'MINOR', title: REASON, description: REASON, source_kind: 'SELF_REPORT', action_owner_id: t.recipientMembershipId, due_at: '2999-01-01T00:00:00Z' } }),
  },
  assignCorrectiveAction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/nonconformances/${t.nonconformanceId}/corrective-actions`, ifMatch: '"1"', body: { description: REASON, owner_membership_id: t.recipientMembershipId, due_at: '2999-01-01T00:00:00Z' } }),
  },
  submitCorrectiveEvidence: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/corrective-actions/${t.correctiveActionId}/evidence`, body: { evidence_document_version_id: t.documentVersionId, note: REASON } }),
  },
  verifyCorrectiveAction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/corrective-actions/${t.correctiveActionId}/verify`, body: { outcome: 'VERIFIED', verification_note: REASON } }),
  },
  closeNonconformance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/nonconformances/${t.nonconformanceId}/close`, ifMatch: '"1"', body: { closure_note: REASON } }),
  },
  reopenNonconformance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/nonconformances/${t.nonconformanceId}/reopen`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The settlement of a project: opened, read again, sent, verified, excepted and closed.
  openSettlement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/settlements', body: { project_id: t.projectId, settlement_scope: 'PROJECT' } }),
  },
  refreshSettlementFigures: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/refresh`, ifMatch: '"1"', body: { note: REASON } }),
  },
  submitSettlement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/submit`, ifMatch: '"1"', body: { submitted_on: '2026-10-25' } }),
  },
  recordSettlementVerification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/verification`, ifMatch: '"1"', body: { outcome: 'VERIFYING', findings: REASON } }),
  },
  approveSettlementException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/exception-approval`, ifMatch: '"1"', body: { reason: REASON, approval_document_version_id: t.paymentDocumentVersionId } }),
  },
  post_settlements_id_close: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/close`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [], decision_document_version_id: t.paymentDocumentVersionId } }),
  },
  // Reversing a payment that was settled, against the refund the Treasury confirmed.
  reversePayment: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/reverse`, ifMatch: '"1"', body: { reason: REASON, approval_document_version_id: t.paymentDocumentVersionId, refund_treasury_transaction_id: t.treasuryTransactionId } }),
  },
  // Sending a payment request, checking it and giving it back.
  post_payment_requests_id_submit: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/submit`, ifMatch: '"1"', body: { expected_gross_vnd: '1', expected_net_vnd: '1' } }),
  },
  verifyPaymentRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/verify`, ifMatch: '"1"', body: {} }),
  },
  returnPaymentRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/return`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  withdrawChangeRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/change-requests/${t.changeRequestId}/withdraw`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  post_contracts_id_activate: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.draftContractId}/activate`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [], effective_from: '2026-10-25' } }),
  },
  // Land clearance: a section and a parcel of the CONCEPT project, the notice of a parcel and the import of a parcel list.
  createLandSection: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/land-sections', body: { project_id: t.projectId, code: 'MX-SECTION', name: 'Matrix section', required_area_m2: '100' } }),
  },
  createLandParcel: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/land-parcels',
      body: { project_id: t.projectId, owner_unit_id: t.unit2, parcel_code: 'MX-NEW-PARCEL', land_use_group: 'AGRICULTURAL', area_total_m2: '100', area_affected_m2: '50' },
    }),
  },
  reportLandStageProgress: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/land-stage-progress/report',
      body: {
        project_id: t.projectId,
        section_id: '00000000-0000-4000-8000-0000000000bb',
        stage_code: 'SURVEY',
        executor_kind: 'LAND_FUND_CENTRE',
        executor_unit_id: t.unit2,
        mode: 'TRACKED_EXTERNAL',
        parcels_total: 10,
        parcels_done: 0,
      },
    }),
  },
  importLandParcels: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/land-parcels/import', body: { project_id: t.projectId, file_object_id: '00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64) } }),
  },
  recordRecoveryNotice: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/land-parcels/${t.parcelId}/recovery-notice`, ifMatch: '"1"', body: { notice_on: '2026-07-01', notice_document_version_id: t.documentVersionId } }),
  },
  recordSectionHandover: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/land-sections/${t.sectionId}/handover`,
      ifMatch: '"1"',
      body: { handed_area_m2: '10', handed_over_on: '2026-10-20', handover_document_version_id: t.documentVersionId },
    }),
  },
  importBoqLines: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contract-revisions/${t.draftRevisionId}/boq-lines`,
      ifMatch: '"1"',
      body: { mode: 'REPLACE', lines: [{ business_key: 'MX-B01', description: 'Matrix item', unit_code: 'M3', quantity: '1', unit_price: '1000' }] },
    }),
  },
  registerGuarantee: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/guarantees`,
      body: { kind: 'PERFORMANCE', issuer: 'Matrix bank', guarantee_no: 'MX-NEW-GUARANTEE', amount_vnd: '1000', valid_from: '2026-01-01', expires_at: '2099-01-01T00:00:00Z', document_version_id: t.documentVersionId },
    }),
  },
  verifyGuarantee: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/guarantees/${t.guaranteeId}/verify`, ifMatch: '"1"', body: { outcome: 'VERIFIED', method: 'Matrix check', evidence_document_version_id: t.documentVersionId } }),
  },
  extendGuarantee: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/guarantees/${t.guaranteeId}/extend`,
      ifMatch: '"1"',
      body: { new_expires_at: '2100-01-01T00:00:00Z', new_guarantee_no: 'MX-EXTENDED', document_version_id: t.documentVersionId },
    }),
  },
  releaseGuarantee: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/guarantees/${t.guaranteeId}/release`, ifMatch: '"1"', body: { release_evidence_id: t.documentVersionId, reason: REASON } }),
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
  post_notifications_id_replay: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notifications/${t.notificationId}/replay`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  cancelNotification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notifications/${t.notificationId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  updateMyNotificationPreferences: {
    referencesTenantIds: false,
    build: () => ({ method: 'PUT', path: '/me/notification-preferences', ifMatch: '"0"', body: { items: [{ event_category: 'report', channel: 'SMS', enabled: false }], quiet_start: '22:00', quiet_end: '06:00' } }),
  },
  grantMyConsent: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/me/consents', body: { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', consent_text_version: 'matrix-1', capture_method: 'IN_APP' } }),
  },
  withdrawMyConsent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/me/consents/${t.consentId}/withdraw`, ifMatch: '"1"', body: { reason: REASON } }),
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
