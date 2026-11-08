import { PERMISSIONS } from '@machvon/contracts';
import type { SystemRole } from '@machvon/db';
import { holdsPermission } from '@machvon/kernel';

/** Ids in tenant A that the command fixtures act on; the test seeds them. */
export interface MatrixTargets {
  /** The tenant of the callers (tenant A): the export names it in the path. */
  tenantId: string;
  unit2: string;
  unit3: string;
  customRoleId: string;
  /** The seeded system role MEMBER (lowest rank, so every real grantor could grant it). */
  memberRoleId: string;
  recipientMembershipId: string;
  grantToRevoke: string;
  /** A notification of RECIPIENT: the notification commands name it in the path. */
  notificationId: string;
  /** The notification workflow in force of tenant A (kind NOTIFICATION): the publication names it in the path. */
  notificationWorkflowId: string;
  /** A Draft template revision of tenant A: the review and the test send name it in the path. */
  notificationTemplateId: string;
  campaignId: string;
  /** A contact of tenant A with a Pending identity: the identity and the verification name them in the path. */
  contactId: string;
  contactIdentityId: string;
  /** A Granted consent of that contact (version 1): the withdrawal names it in the path. */
  contactConsentId: string;
  /** A New conversation of tenant A (version 1): the assignment names it in the path. */
  conversationId: string;
  /** A Draft routing policy and a canned reply of tenant A (version 1): the publication and the change name them in the path. */
  routingPolicyId: string;
  cannedReplyId: string;
  /** A channel account of tenant A (version 1): the verification, the change and the closing name it in the path. */
  channelAccountId: string;
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
  /** An evaluation of a contractor and a violation of one: the command that names it in the path needs no row to be refused. */
  evaluationId: string;
  violationId: string;
  /** A batch of the export of the records of the contractors: the command that names it in the path needs no row to be refused. */
  exportBatchId: string;
  boqItemId: string;
  periodId: string;
  /** An UNVERIFIED contractor of tenant A made by someone other than the callers (version 1). */
  contractorToVerifyId: string;
  /** A clean PDF version of tenant A: the signature verification names it in the path. */
  documentVersionId: string;
  /** An Active signing certificate of tenant A (version 1). */
  certificateId: string;
  /** A support access request of tenant A waiting for its approvers (version 1), asked for by an operator of the platform. */
  supportGrantId: string;
  /** A security policy draft of tenant A made by someone other than the callers (version 1). */
  policyId: string;
  /** A working calendar draft of tenant A (version 1). */
  workCalendarId: string;
  /** A DoA matrix draft and one waiting for approval of tenant A, both made by someone other than the callers (version 1). */
  doaDraftId: string;
  doaPendingId: string;
  /** A governance rule draft and one submitted for approval of tenant A, both made and submitted by someone other than the callers (row version 1). */
  governanceDraftId: string;
  governanceSubmittedId: string;
  /** An outgoing document of tenant A in SUBMITTED (version 1) and an open leader signing session of it (version 1). */
  outgoingDocumentId: string;
  signingSessionId: string;
  /** A distribution of that document, SENT (version 1). */
  distributionId: string;
  /** An EFFECTIVE master record of tenant A (version 1), a DRAFT change request of another record and an IN_REVIEW one of a third. */
  masterRecordId: string;
  /** A second EFFECTIVE entry of the same type that is merged into the first one (an APPLIED merge, version 1), and a DRAFT rule of survivorship: the merge commands act on them. */
  masterMergedRecordId: string;
  masterMergeId: string;
  survivorshipRuleId: string;
  /** A conversion batch of tenant A that passed its dry run (version 1): the commands over a batch act on it. */
  migrationBatchId: string;
  /** A knowledge collection of tenant A: the command that indexes into it acts on it. */
  knowledgeCollectionId: string;
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
  /** A DRAFT report of that form for unit 2 of tenant A, made by someone other than the callers (version 1). */
  mneReportId: string;
  /** A GENERATED package of that report (version 1). */
  mnePackageId: string;
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
  /** A page of OCR of tenant A that waits for a person (a reading at 0.71 on a clean PDF version), read by the pipeline and not yet reviewed. */
  ocrPageId: string;
  /** An analysis run of tenant A that is still running (version 1), asked for by someone other than the callers. */
  analysisRunId: string;
  /** A REQUESTED inspection (version 1) of the draft contract, asked for by someone other than the callers. */
  inspectionId: string;
  /** Quality acceptance minutes in DRAFT (version 1) of the draft contract, drafted by someone other than the callers. */
  acceptanceId: string;
  /** A site diary in DRAFT (version 1) of the draft contract, written by someone other than the callers. */
  diaryId: string;
  /** An incoming document that was only received (version 1), taken in by someone other than the callers. */
  incomingId: string;
  /** An OPEN quality incident of the quality dataset (version 1), and an OPEN quality exception of its run (version 1), both made by someone other than the callers. */
  qualityIncidentId: string;
  qualityExceptionId: string;
  /** A PROPOSED mapping of a field of a source into the quality dataset (version 1), proposed by someone other than the callers, and the dataset itself. */
  sourceMappingId: string;
  /** A live session and a live device of someone other than the callers: the sign-out commands reach neither. */
  otherSessionId: string;
  otherDeviceId: string;
  /** A DRAFT workflow definition (version 1) written by someone other than the callers, and a PENDING approval task (version 1) of a running instance, given to someone other than the callers. */
  workflowDraftId: string;
  approvalTaskId: string;
  workflowInstanceId: string;
  /** An ACTIVE delegation (version 1) from someone other than the callers. */
  delegationId: string;
  /** A reorganisation of units that waits for approval (version 1), proposed by someone other than the callers. */
  reorganizationId: string;
  qualityDatasetId: string;
  /** An OPEN dossier of unit 2 (version 1), opened by someone other than the callers. */
  dossierId: string;
  /** A DIS dataset of tenant A with its working contract, a DRAFT quality rule of it made by someone other than the callers (version 1), and a frozen snapshot of the open period. */
  qualityContractId: string;
  /** A revision of the contract of that dataset in review (version 1) with a breaking change, drafted by someone other than the callers, and a consumer approval of it that waits (version 1): the contract commands act on them. */
  contractRevisionId: string;
  consumerApprovalId: string;
  /** A DRAFT rubric of maturity and a PUBLISHED one, an assessment of the published one in review with a criterion that waits for a reviewer (all version 1), made by someone other than the callers: the maturity commands act on them. */
  rubricDraftId: string;
  rubricPublishedId: string;
  maturityAssessmentId: string;
  maturityEvidenceId: string;
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
      body: {
        record_class: 'project_dossier',
        retention_years: 10,
        retention_basis: 'FROM_CLOSED',
        legal_basis_ref: 'Matrix fixture basis',
        end_action: 'REVIEW_FOR_DESTRUCTION',
        effective_from: '2026-01-01',
      },
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
  post_tenants_id_export: {
    referencesTenantIds: false,
    build: (t) => ({ method: 'POST', path: `/tenants/${t.tenantId}/export`, ifMatch: '"0"', body: { scope: 'FULL', reason: REASON } }),
  },
  post_support_access_id_approve: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/support-access/${t.supportGrantId}/approve`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  revokeSupportAccess: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/support-access/${t.supportGrantId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
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
  // The separation of duties (lane D, G4-1): a caller that is refused asks for no exception, approves none, rejects none and revokes none.
  requestSodException: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/sod-exceptions',
      body: { action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD', subject_id: t.legalHoldId, member_id: t.recipientMembershipId, reason: REASON, valid_from: '2999-01-01', valid_to: '2999-01-02' },
    }),
  },
  approveSodException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/sod-exceptions/${t.legalHoldId}/approve`, ifMatch: '"1"', body: {} }),
  },
  rejectSodException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/sod-exceptions/${t.legalHoldId}/reject`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  revokeSodException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/sod-exceptions/${t.legalHoldId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createGovernanceRuleDraft: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/governance-rules',
      body: {
        rule_type: 'REMINDER_POLICY',
        code: 'MATRIX_PROBE',
        params: { every_working_hours: { URGENT: 4, ACTION: 8, WATCH: 40 }, max_per_item: { URGENT: 40, ACTION: 20, WATCH: 8 } },
        effective_from: '2999-01-01',
        reason: REASON,
      },
    }),
  },
  submitGovernanceRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/governance-rules/${t.governanceDraftId}/submit`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  withdrawGovernanceRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/governance-rules/${t.governanceSubmittedId}/withdraw`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  approveGovernanceRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/governance-rules/${t.governanceSubmittedId}/approve`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  retireGovernanceRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/governance-rules/${t.governanceDraftId}/retire`, ifMatch: '"1"', body: { reason: REASON } }),
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
      body: {
        doc_type_code: 'QD',
        template_code: 'QD-DEFAULT',
        title: 'Matrix draft',
        drafting_unit_id: t.unit2,
        payload: { agency: 'Matrix agency', place: 'Cao Bang', title: 'Matrix', body: 'Matrix' },
      },
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
  createDocumentLayoutProfileRevision: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/document-layout-profiles',
      body: {
        profile_code: 'MX-LAYOUT',
        margins_mm: { top: 20, bottom: 20, left: 30, right: 15 },
        font_family: 'Times New Roman',
        element_styles: {},
        signature_layout: {},
        number_field_layout: {},
        watermark_policy: { text: 'MATRIX' },
        legal_basis: 'Matrix attempt to draft a layout profile',
        effective_from: '2099-01-01',
      },
    }),
  },
  publishDocumentLayoutProfile: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-layout-profiles/${t.legalHoldId}/publish`, ifMatch: '"1"', body: {} }),
  },
  createReplacementDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/outgoing-documents/${t.outgoingDocumentId}/replacements`, ifMatch: '"1"', body: { reason: 'negative authorization matrix replacement' } }),
  },
  createCorrectionDocument: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/outgoing-documents/${t.outgoingDocumentId}/corrections`,
      ifMatch: '"1"',
      body: { correction_text: 'matrix correction text', reason: 'negative authorization matrix correction' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/outgoing-documents/${t.outgoingDocumentId}/cancellation`,
      ifMatch: '"1"',
      body: { reason: 'negative authorization matrix', reject_code: 'CANCELLED_BY_DRAFTER' },
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
      body: {
        predecessor_record_id: t.masterRecordId,
        successor_record_id: t.masterCrosswalkId,
        succession_kind: 'MERGE',
        effective_date: '2025-07-01',
        legal_basis: 'Matrix legal basis',
        reason: REASON,
      },
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
  post_master_records_id_merge: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-records/${t.masterRecordId}/merge`, ifMatch: '"1"', body: { merged_record_id: t.masterMergedRecordId, reason: REASON } }),
  },
  unmergeMasterRecords: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/master-merges/${t.masterMergeId}/unmerge`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createSurvivorshipRuleVersion: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/survivorship-rules', body: { master_type: 'MATRIX', attribute_name: 'phone', strategy: 'SOURCE_PRIORITY', source_priority: ['NATIONAL', 'TENANT'], effective_from: '2026-01-01' } }),
  },
  createAiKnowledgeCollection: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/ai-knowledge-collections', body: { code: 'MATRIX-KB', title: 'Matrix collection', subject_module: 'PRJ', embedding_model_id: t.knowledgeCollectionId, max_classification: 'INTERNAL' } }),
  },
  indexAiKnowledgeItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/ai-knowledge-collections/${t.knowledgeCollectionId}/items`, body: { document_version_id: t.knowledgeCollectionId } }),
  },
  uploadMigrationFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/migration-batches/files', body: {} }),
  },
  registerMigrationBatch: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/migration-batches', body: { source_system: 'LEGACY-ERP', target_entity: 'MATRIX', file_id: t.migrationBatchId, mapping_version: 'GENERIC-1' } }),
  },
  dryRunMigrationBatch: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/migration-batches/${t.migrationBatchId}/dry-run`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  applyMigrationBatch: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/migration-batches/${t.migrationBatchId}/apply`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  rollbackMigrationBatch: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/migration-batches/${t.migrationBatchId}/rollback`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  publishSurvivorshipRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/survivorship-rules/${t.survivorshipRuleId}/publish`, ifMatch: '"1"', body: {} }),
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
    build: (t) => ({
      method: 'POST',
      path: '/capital-plans',
      body: { plan_code: 'MX-PLAN', plan_kind: 'ANNUAL', plan_year: 2027, period_from_year: 2027, period_to_year: 2027, scope_unit_id: t.unit2 },
    }),
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
      body: {
        project_id: t.projectId,
        period_id: t.periodOpenId,
        plan_version_id: t.legalHoldId,
        measurement_basis: 'YTD',
        funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1000' }],
      },
    }),
  },
  post_reports_id_revisions: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/reports/${t.legalHoldId}/revisions`,
      ifMatch: '"1"',
      body: {
        project_id: t.projectId,
        period_id: t.periodOpenId,
        plan_version_id: t.legalHoldId,
        measurement_basis: 'YTD',
        funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1000' }],
      },
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
  withdrawReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/withdrawal`, ifMatch: '"1"', body: { reason: 'The wrong period was reported by mistake.' } }),
  },
  deleteDraftReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/draft-deletion`, ifMatch: '"1"', body: { reason: 'Started in the wrong week.' } }),
  },
  uploadReportImportFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/report-imports/files', body: {} }),
  },
  createReportImport: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/report-imports',
      body: { period_id: t.legalHoldId, file_object_key: 'tenants/matrix/import/none', file_sha256: 'a'.repeat(64), mapping_version: 'DIS-WEEKLY-1' },
    }),
  },
  applyReportImport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/report-imports/${t.legalHoldId}/apply`, ifMatch: '"1"', body: {} }),
  },
  createEarlyWarningRuleVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/early-warning-rules',
      body: {
        rule_code: 'EW-MATRIX',
        name: 'Matrix rule of the negative matrix',
        metric_code: 'YTD_RATE_GAP',
        comparator: 'GTE',
        threshold_json: { points: 10 },
        severity: 'WARNING',
        scope_kind: 'PROJECT',
        legal_basis: 'Matrix legal basis',
        effective_from: '2027-01-01',
      },
    }),
  },
  publishEarlyWarningRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/early-warning-rules/${t.legalHoldId}/publish`, ifMatch: '"1"', body: {} }),
  },
  acknowledgeEarlyWarning: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/early-warnings/${t.legalHoldId}/acknowledge`, ifMatch: '"1"', body: { reason: 'Matrix attempt to acknowledge' } }),
  },
  dismissEarlyWarning: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/early-warnings/${t.legalHoldId}/dismiss`, ifMatch: '"1"', body: { reason: 'Matrix attempt to dismiss' } }),
  },
  requestExplanation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/explanation-requests',
      body: {
        subject_kind: 'PROJECT',
        project_id: t.legalHoldId,
        trigger_code: 'MATRIX',
        question: 'Matrix attempt to ask for an explanation',
        requested_from_membership_id: t.recipientMembershipId,
        due_at: '2099-01-01T00:00:00Z',
      },
    }),
  },
  submitExplanation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/explanation-requests/${t.legalHoldId}/response`, ifMatch: '"1"', body: { response_text: 'Matrix attempt to answer a request for an explanation' } }),
  },
  reviewExplanation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/explanation-requests/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'ACCEPTED', review_note: 'Matrix attempt to conclude' } }),
  },
  requestProjectTransfer: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/projects/${t.legalHoldId}/transfers`,
      ifMatch: '"1"',
      body: { to_unit_id: t.unit2, transfer_scope: 'OWNER_UNIT', effective_date: '2099-01-01', reason: 'Matrix attempt to transfer a project' },
    }),
  },
  addProjectComponent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/components`, body: { code: 'MX-C', name: 'Matrix component', planned_value_vnd: '1', valid_from: '2026-01-01' } }),
  },
  addProjectMilestone: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/milestones`, body: { code: 'MX-M', name: 'Matrix milestone', baseline_date: '2026-02-01', planned_date: '2026-02-02' } }),
  },
  recordMilestoneProgress: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-milestones/${t.legalHoldId}/progress`, ifMatch: '"1"', body: { status: 'CANCELLED', reason: REASON } }),
  },
  setMilestoneDependency: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-milestones/${t.legalHoldId}/dependency`, ifMatch: '"1"', body: { depends_on_milestone_id: null } }),
  },
  proposeProjectRevision: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/projects/${t.projectId}/revisions`,
      ifMatch: '"1"',
      body: { change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '999', reason: 'Matrix attempt to revise a project' },
    }),
  },
  decideProjectRevision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-revisions/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'reject', reason: 'Matrix attempt to decide a revision' } }),
  },
  registerProjectRisk: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/projects/${t.projectId}/risks`,
      body: {
        code: 'MX-RISK',
        category_master_version_id: t.legalHoldId,
        title: 'Matrix risk',
        description: 'Matrix attempt to register a risk',
        likelihood: 3,
        impact: 3,
        owner_membership_id: t.recipientMembershipId,
        mitigation: 'Matrix mitigation',
        due_date: '2099-01-01',
      },
    }),
  },
  updateProjectRisk: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/project-risks/${t.legalHoldId}/update`,
      ifMatch: '"1"',
      body: {
        code: 'MX-RISK',
        category_master_version_id: t.legalHoldId,
        title: 'Matrix risk',
        description: 'Matrix attempt to update a risk',
        likelihood: 3,
        impact: 3,
        owner_membership_id: t.recipientMembershipId,
        mitigation: 'Matrix mitigation',
        due_date: '2099-01-01',
      },
    }),
  },
  closeProjectRisk: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-risks/${t.legalHoldId}/closure`, ifMatch: '"1"', body: { status: 'CLOSED', closed_reason: REASON } }),
  },
  // The money control (lane B2): a caller that is refused fills no reserve, draws nothing, decides no drawdown, sets no exposure and clears no check of the project adjustment.
  setRiskExposure: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-risks/${t.legalHoldId}/exposure`, body: { probability_pct: '10', cost_impact_vnd: '1000000' } }),
  },
  fundProjectReserve: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/reserve-funds`, body: { kind: 'CONTINGENCY', amount_vnd: '1000000', authority_document_version_id: t.documentVersionId, reason: REASON } }),
  },
  requestReserveDrawdown: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/reserve-drawdowns`, body: { kind: 'CONTINGENCY', amount_vnd: '1000', risk_id: t.legalHoldId, reason: REASON } }),
  },
  decideReserveDrawdown: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reserve-drawdowns/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  clearChangeAdjustmentCheck: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/change-requests/${t.changeRequestId}/adjustment-check`, ifMatch: '"1"', body: { basis: REASON, decision_document_version_id: t.documentVersionId } }),
  },
  // The investment appraisal (lane FIN-1): a caller that is refused opens no appraisal, changes no input, computes nothing, submits, approves, returns or exports nothing.
  createInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/investment-appraisals', body: { title: 'Matrix attempt to open an appraisal', kind: 'FINANCIAL', owner_unit_id: t.unit2 } }),
  },
  updateInvestmentAppraisalInputs: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/inputs`, ifMatch: '"1"', body: { title: 'Matrix attempt', period_unit: 'YEAR', discount_rate_pct: '10', convention: 'END', lines: [{ period: 0, capex: '100' }], assumptions: [], scenarios: [], scores: [] } }),
  },
  runInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/runs`, ifMatch: '"1"', body: {} }),
  },
  submitInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/submission`, ifMatch: '"1"', body: {} }),
  },
  approveInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/approval`, ifMatch: '"1"', body: {} }),
  },
  returnInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/return`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  exportInvestmentAppraisal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/investment-appraisals/${t.legalHoldId}/export`, body: { format: 'CSV' } }),
  },
  // The directives of the steering meetings (lane DIR-1): a caller that is refused records no meeting, gives no directive, notes no progress, asks for or decides no extension, and neither closes, cancels nor reopens one.
  createSteeringMeeting: {
    // A unit that does not exist in the caller's tenant is a 422 (like a missing reference of any command), not a 404; the meeting is written in the caller's own tenant otherwise.
    referencesTenantIds: false,
    build: (t) => ({ method: 'POST', path: '/steering-meetings', body: { meeting_date: '2026-11-03', meeting_type: 'WEEKLY', title: 'Matrix attempt to record a meeting', unit_id: t.unit2 } }),
  },
  attachMeetingMinutes: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/steering-meetings/${t.legalHoldId}/minutes`, ifMatch: '"1"', body: { document_version_id: t.documentVersionId } }),
  },
  addDirective: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/steering-meetings/${t.legalHoldId}/directives`, body: { scope_kind: 'PROJECT', project_id: t.projectId, text: 'Matrix attempt to give a directive', assignee_unit_id: t.unit2, due_on: '2026-12-31' } }),
  },
  assignDirective: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/assignment`, ifMatch: '"1"', body: { assignee_unit_id: t.unit2 } }),
  },
  recordDirectiveProgress: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/progress`, body: { note: 'Matrix attempt to note progress' } }),
  },
  requestDirectiveExtension: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/extension-requests`, body: { proposed_due_on: '2027-01-15', reason: REASON } }),
  },
  decideDirectiveExtension: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directive-extensions/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  closeDirective: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/closure`, ifMatch: '"1"', body: { note: 'Matrix attempt to close a directive', evidence_document_version_ids: [t.documentVersionId] } }),
  },
  cancelDirective: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/cancellation`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  reopenDirective: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/directives/${t.legalHoldId}/reopening`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // The lifecycle and the earned value (lane B1): a caller that is refused takes no baseline, decides no re-appraisal, acknowledges no alert and links no contract to a work package.
  captureProjectBaseline: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/baseline`, body: {} }),
  },
  decideReappraisalRequest: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-reappraisals/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'WAIVE', reason: REASON } }),
  },
  acknowledgeGovernanceAlert: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-governance-alerts/${t.legalHoldId}/acknowledgement`, ifMatch: '"1"', body: { note: REASON } }),
  },
  linkContractComponent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/component-contracts`, body: { contract_id: t.contractId, component_id: null } }),
  },
  decideProjectTransfer: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/project-transfers/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: 'Matrix attempt to decide a transfer' } }),
  },
  draftReallocationProposal: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/reallocation-proposals',
      body: {
        code: 'MX-REALLOCATION',
        plan_year: 2027,
        scope_unit_id: t.unit2,
        basis_snapshot_id: t.legalHoldId,
        source_capital_plan_id: t.legalHoldId,
        reason: 'Matrix attempt to draft a reallocation of capital',
        lines: [{ from_allocation_line_id: t.legalHoldId, to_project_id: t.legalHoldId, amount_vnd: '1000' }],
      },
    }),
  },
  createAllocationScenario: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/allocation-scenarios',
      body: {
        code: 'MX-SCENARIO',
        plan_year: 2027,
        base_capital_plan_id: t.legalHoldId,
        constraints: {},
        assumptions: { moves: [{ from_allocation_line_id: t.legalHoldId, to_project_id: t.legalHoldId, amount_vnd: '1000' }] },
      },
    }),
  },
  runAllocationScenario: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/allocation-scenarios/${t.legalHoldId}/run`, ifMatch: '"1"', body: {} }),
  },
  promoteAllocationScenario: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/allocation-scenarios/${t.legalHoldId}/promote`, ifMatch: '"1"', body: {} }),
  },
  createFundReservation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/fund-reservations',
      body: { allocation_line_id: t.legalHoldId, amount_vnd: '1000', purpose: 'OTHER', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    }),
  },
  releaseFundReservation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/fund-reservations/${t.legalHoldId}/release`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  submitReallocationProposal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reallocation-proposals/${t.legalHoldId}/submit`, ifMatch: '"1"', body: {} }),
  },
  decideReallocationProposal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reallocation-proposals/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: 'Matrix attempt to decide a reallocation' } }),
  },
  applyReallocationProposal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reallocation-proposals/${t.legalHoldId}/apply`, ifMatch: '"1"', body: { decision_document_id: t.legalHoldId } }),
  },
  createReportExport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/report-exports', body: { snapshot_id: t.legalHoldId, format: 'CSV' } }),
  },
  buildPeriodSnapshot: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/period-snapshots', body: { period_id: t.periodLockedId, snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: '2026-01-04' } }),
  },
  freezePeriodSnapshot: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/period-snapshots/${t.legalHoldId}/freeze`, ifMatch: '"1"', body: {} }),
  },
  // The daily reconciliation with the Treasury and the cross-total control (lane D, G4-4, G4-5): a caller that is refused runs no pass, assigns and resolves no item and writes no check.
  runTreasuryDailyRecon: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/treasury-daily-recon/runs', body: { recon_date: '2026-01-05' } }),
  },
  assignTreasuryDailyReconItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/treasury-daily-recon/items/${t.reconciliationItemId}/assign`, ifMatch: '"1"', body: { owner_membership_id: t.paymentRequestId, due_on: '2030-01-01' } }),
  },
  resolveTreasuryDailyReconItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/treasury-daily-recon/items/${t.reconciliationItemId}/resolve`, ifMatch: '"1"', body: { resolution: 'EXPLAINED', note: REASON } }),
  },
  evaluateCrossTotal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/period-snapshots/${t.legalHoldId}/cross-total-checks`, body: {} }),
  },
  restoreDraftReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reports/${t.legalHoldId}/draft-restore`, ifMatch: '"1"', body: {} }),
  },
  requestPeriodReopen: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/reporting-periods/${t.periodLockedId}/reopen-requests`,
      body: { scope_kind: 'PERIOD', reason: 'Matrix request to reopen the locked period', window_hours: 24 },
    }),
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
  // The bundle named is looked up in the caller's own tenant: a caller without the right to sync is refused before it is read.
  syncMetricRegistry: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/metric-registry-syncs', body: { source_commit: 'matrix0', bundle_object_key: 'tenants/matrix/document/none', bundle_sha256: 'a'.repeat(64) } }),
  },
  createBiAccessPolicy: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/bi/access-policies',
      body: {
        dataset_id: '00000000-0000-4000-8000-0000000000d1',
        grantee_kind: 'ROLE',
        grantee_ref_id: '00000000-0000-4000-8000-0000000000c3',
        row_predicate_ast: { op: 'unit_in_scope' },
        column_masks: {},
      },
    }),
  },
  createDashboard: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/dashboards', body: { code: 'MATRIX-DASHBOARD', title: 'Matrix probe of a dashboard' } }),
  },
  saveDashboardVersion: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/bi/dashboards/${t.legalHoldId}/versions`,
      ifMatch: '"1"',
      body: { layout_json: { widgets: [] }, breakpoints: {}, metric_versions: [], filter_mappings: {}, dataset_version_policy: 'LATEST_FROZEN' },
    }),
  },
  shareDashboard: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/bi/dashboards/${t.legalHoldId}/shares`, ifMatch: '"1"', body: { grantee_kind: 'USER', grantee_ref_id: t.legalHoldId, permission: 'VIEW' } }),
  },
  revokeDashboardShare: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/bi/dashboard-shares/${t.legalHoldId}/revocation`, ifMatch: '"1"', body: {} }),
  },
  // The metric, the snapshot and the recipients are named in the body, and an id the tenant does not hold is a 422 of the body (as for the query): the answer does not tell a foreign id from one that does not exist.
  // A node that is named by its id and is not one of the tenant is 422 LINEAGE_NODE_INVALID (the answer does not tell another tenant's node from one that does not exist).
  recordLineageBatch: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/dgv/lineage-batches',
      body: {
        run_id: '00000000-0000-4000-8000-0000000000a1',
        transform_version: 'matrix-v1',
        edges: [{ from: { node_id: '00000000-0000-4000-8000-0000000000a2' }, to: { node_id: '00000000-0000-4000-8000-0000000000a3' } }],
      },
    }),
  },
  requestBiExport: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/exports', body: { query_spec: { metric_version_id: '00000000-0000-4000-8000-0000000000a1' }, as_of_period: '2026-10', format: 'CSV' } }),
  },
  createBiExportSchedule: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/bi/export-schedules',
      body: { query_spec: { metric_version_id: '00000000-0000-4000-8000-0000000000a1' }, cron: '0 8 * * 1', format: 'CSV', recipients: ['00000000-0000-4000-8000-0000000000a2'] },
    }),
  },
  submitBiPublication: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/bi/publication-requests', body: { object_kind: 'METRIC', object_id: t.legalHoldId } }),
  },
  decideBiPublication: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/bi/publication-requests/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'APPROVED' } }),
  },
  post_dashboards_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dashboards/${t.legalHoldId}/publish`, ifMatch: '"1"', body: { decision: 'approve', reason: 'Matrix probe', evidence_ids: [] } }),
  },
  // The registry of the AI gateway (ST-LLM-001) is the tenant's: a caller without the right is refused before the body is read.
  registerAiProvider: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-providers',
      body: { provider_code: 'MATRIX-1', name: 'Matrix provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' },
    }),
  },
  activateAiProvider: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-providers/00000000-0000-4000-8000-0000000000e1/activation', ifMatch: '"1"', body: {} }),
  },
  registerAiModel: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-models',
      body: { provider_id: '00000000-0000-4000-8000-0000000000e1', model_id: 'matrix-model', capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' },
    }),
  },
  createAiClassificationPolicy: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-classification-policies',
      body: {
        matrix: { PUBLIC: ['SELF_HOSTED'], INTERNAL: ['SELF_HOSTED'], CONFIDENTIAL: ['SELF_HOSTED'], PERSONAL: ['SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] },
        international_enabled: false,
        legal_basis: 'Matrix basis',
        effective_from: '2026-01-01T00:00:00.000Z',
      },
    }),
  },
  publishAiClassificationPolicy: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-classification-policies/00000000-0000-4000-8000-0000000000e2/publish', ifMatch: '"1"', body: {} }),
  },
  // The virtual keys are the tenant's (ST-LLM-002): a caller without the right is refused before the body is read.
  createAiVirtualKey: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-virtual-keys',
      body: { key_alias: 'matrix-key', scope_kind: 'TENANT', allowed_model_ids: ['00000000-0000-4000-8000-0000000000e3'], expires_at: '2999-01-01T00:00:00.000Z' },
    }),
  },
  rotateAiVirtualKey: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-virtual-keys/00000000-0000-4000-8000-0000000000e4/rotation', ifMatch: '"1"', body: {} }),
  },
  revokeAiVirtualKey: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-virtual-keys/00000000-0000-4000-8000-0000000000e4/revocation', ifMatch: '"1"', body: { reason: 'Matrix probe of the key revocation' } }),
  },
  // The money of the AI gateway is the tenant's (ST-LLM-003): a caller without the right is refused before the body is read.
  createAiBudget: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-budgets', body: { scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '1000', hard_stop: true, effective_from: '2026-01-01' } }),
  },
  reconcileAiInvoice: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-invoices/reconciliations', body: { invoice_ref: 'MATRIX-2026-01', invoice_amount: '1000', currency: 'VND', period_from: '2026-01-01', period_to: '2026-01-31' } }),
  },
  post_budgets_id_reconcile: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/budgets/00000000-0000-4000-8000-0000000000e6/reconcile',
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'Matrix probe of the budget reconciliation', evidence_ids: [] },
    }),
  },
  registerPricingVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-pricing-versions',
      body: {
        provider: 'Matrix provider',
        model_id: 'matrix-model',
        model_ref_id: '00000000-0000-4000-8000-0000000000e5',
        currency: 'USD',
        effective_from: '2026-01-01T00:00:00.000Z',
        input_per_million: '1.00',
        cached_per_million: '0.50',
        output_per_million: '2.00',
        cached_semantics: 'INCLUDED_IN_INPUT',
        reasoning_in_output: true,
        source_url: 'https://matrix.example/pricing',
        fx_rate_to_vnd: '25000',
        fx_source: 'Matrix',
      },
    }),
  },
  // The evaluation gate of the AI gateway is the tenant's (ST-LLM-004): a caller without the right is refused before the body is read.
  approveAiModel: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-models/00000000-0000-4000-8000-0000000000e6/approval', ifMatch: '"1"', body: {} }),
  },
  createAiPromptVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-prompts',
      body: {
        task_type: 'SUMMARY',
        name: 'matrix',
        template_object_key: 'tenants/matrix/prompts/a.txt',
        template_sha256: 'a'.repeat(64),
        input_schema: { type: 'object', properties: { text: { type: 'string' } } },
        output_schema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    }),
  },
  reviseAiPromptVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'PUT',
      path: '/ai-prompts/00000000-0000-4000-8000-0000000000e7',
      ifMatch: '"1"',
      body: {
        task_type: 'SUMMARY',
        name: 'matrix',
        template_object_key: 'tenants/matrix/prompts/a.txt',
        template_sha256: 'a'.repeat(64),
        input_schema: { type: 'object', properties: { text: { type: 'string' } } },
        output_schema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    }),
  },
  approveAiPromptVersion: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-prompts/00000000-0000-4000-8000-0000000000e7/approval', ifMatch: '"1"', body: {} }),
  },
  createAiEvalDataset: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-eval-datasets',
      body: { dataset_code: 'EV-MATRIX', task_type: 'SUMMARY', source: 'SYNTHETIC', cases: [{ case_code: 'c1', input_ref: 'inputs/c1.txt', expected: {} }] },
    }),
  },
  createModelProfileVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/model-profiles',
      body: {
        task_type: 'SUMMARY',
        model_id: 'matrix-model',
        allowed_model_ids: ['00000000-0000-4000-8000-0000000000e6'],
        output_cap: 1000,
        max_input_tokens: 8000,
        timeout_ms: 30000,
        concurrency_limit: 4,
        output_schema: {},
        tool_allowlist: [],
        max_classification: 'PUBLIC',
        routing_policy: { routes: ['SELF_HOSTED'] },
        prompt_version_id: '00000000-0000-4000-8000-0000000000e7',
        retention_days: 90,
      },
    }),
  },
  startAiEvalRun: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-eval-runs',
      body: { profile_version_id: '00000000-0000-4000-8000-0000000000e8', dataset_version_id: '00000000-0000-4000-8000-0000000000e9', route_class: 'SELF_HOSTED' },
    }),
  },
  engageAiKillSwitch: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-kill-switches', body: { scope_kind: 'TENANT', reason: 'Matrix probe of the emergency stop' } }),
  },
  releaseAiKillSwitch: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-kill-switches/00000000-0000-4000-8000-0000000000f1/release', ifMatch: '"1"', body: { release_reason: 'Matrix probe of the release' } }),
  },
  recordAiDecision: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai-decisions',
      body: {
        ai_request_id: '00000000-0000-4000-8000-0000000000f2',
        subject_module: 'PAY',
        subject_kind: 'alert',
        subject_id: '00000000-0000-4000-8000-0000000000f3',
        ai_output_sha256: 'a'.repeat(64),
        action_kind: 'MONEY',
        decision: 'ACCEPTED',
        rationale: 'Matrix probe of the decision record',
      },
    }),
  },
  requestAiCompletion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/ai/requests',
      body: {
        task_type: 'SUMMARY',
        subject_module: 'BID',
        source_refs: [{ document_version_id: '00000000-0000-4000-8000-0000000000f0' }],
        input_ref: 'tenants/x/inputs/matrix-probe',
        input_sha256: 'a'.repeat(64),
      },
    }),
  },
  signAiEvalRun: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/ai-eval-runs/00000000-0000-4000-8000-0000000000ea/signature', ifMatch: '"1"', body: { decision: 'PASS', comment: 'Matrix probe of the signature' } }),
  },
  post_model_profiles_id_publish: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/model-profiles/00000000-0000-4000-8000-0000000000e8/publish',
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'Matrix probe of the release', evidence_ids: [] },
    }),
  },
  post_dashboard_queries: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/dashboard-queries',
      body: { metric_version_id: '00000000-0000-4000-8000-0000000000a1', snapshot_id: '00000000-0000-4000-8000-0000000000a2', dimensions: ['unit'], filters: [] },
    }),
  },
  refreshBiQueryContext: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/query-contexts/refresh', body: { drill_token: 'x'.repeat(40) } }),
  },
  buildBiDatasetVersion: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/datasets/00000000-0000-4000-8000-0000000000d1/versions', body: { as_of_period: '2026-10' } }),
  },
  createTenantMetricDefinition: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/bi/metric-definitions',
      body: {
        code: 't_matrix',
        grain: 'project',
        aggregation_type: 'additive',
        expression_ast: { op: 'sum', args: [{ op: 'field', name: 'A' }] },
        unit: 'VND',
        null_policy: 'NULL_NOT_ZERO',
        dimension_codes: [],
        dataset_id: '00000000-0000-4000-8000-0000000000d1',
        effective_from: '2026-01-01',
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
  // A report is found by its id in the tenant of the caller: one of tenant A is a 404 for anyone else, whatever they hold.
  createMneReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/mne-reports', body: { form_id: t.mneFormId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: t.unit2 } }),
  },
  editMneReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/revisions`, ifMatch: '"1"', body: { narrative: {} } }),
  },
  decideMneReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: 'Matrix check of the decision.' } }),
  },
  correctMneReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/corrections`, ifMatch: '"1"', body: { correction_reason: 'Matrix check of the correction.' } }),
  },
  generateMneExportPackage: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/export-packages`, ifMatch: '"1"', body: { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] } }),
  },
  recordMneSubmissionReceipt: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/mne-export-packages/${t.mnePackageId}/submission-receipt`,
      ifMatch: '"1"',
      body: { receipt_reference: 'MATRIX-RECEIPT', submitted_at: '2026-10-20T08:00:00Z' },
    }),
  },
  requestMneReportIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/issue-requests`, ifMatch: '"1"', body: {} }),
  },
  submitMneReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-reports/${t.mneReportId}/submit`, ifMatch: '"1"', body: {} }),
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
  bindGlossaryTermToDataset: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/datasets/${t.datasetId}/glossary-bindings`, body: { glossary_term_id: t.legalHoldId, column_name: 'amount' } }),
  },
  certifyDataProduct: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/data-products/${t.datasetId}/certification`, ifMatch: '"1"', body: { decision: 'PROVISIONAL', reason: REASON, evidence_refs: [] } }),
  },
  // The dataset named in the body is read as a dataset of the caller's own tenant: another tenant's dataset is as unknown as one that does not exist.
  createDatasetContractRevision: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/dgv/dataset-contracts',
      body: {
        dataset_id: t.datasetId,
        odcs_version: 'v3.0.2',
        odcs_json: {
          apiVersion: 'v3.0.2',
          kind: 'DataContract',
          id: 'matrix',
          version: '1.0.0',
          status: 'active',
          schema: [{ name: 'matrix', properties: [{ name: 'amount', logicalType: 'number' }] }],
        },
        effective_from: '2030-01-01',
      },
    }),
  },
  recordConsumerApproval: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/contract-consumer-approvals/${t.consumerApprovalId}/decision`, ifMatch: '"1"', body: { decision: 'APPROVED' } }),
  },
  publishDatasetContract: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/dataset-contracts/${t.contractRevisionId}/publish`, ifMatch: '"1"', body: { migration_window_until: '2030-12-31' } }),
  },
  post_data_contracts_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/data-contracts/${t.contractRevisionId}/publish`, ifMatch: '"1"', body: { decision: 'reject', reason: REASON, evidence_ids: [] } }),
  },
  createMaturityRubricVersion: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/dgv/maturity-rubrics',
      body: { rubric_code: 'MX-RUBRIC', framework_refs: { DCAM: ['1.1'] }, pillars_json: { pillars: [] }, min_coverage_pct: '70', evidence_ttl_days: 365 },
    }),
  },
  publishMaturityRubric: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/maturity-rubrics/${t.rubricDraftId}/publish`, ifMatch: '"1"', body: {} }),
  },
  // The rubric and the people named in the body are read as those of the caller's own tenant: another tenant's are as unknown as ones that do not exist (422).
  createMaturityAssessment: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/dgv/maturity-assessments',
      body: { period_code: 'MX-2026', rubric_version_id: t.rubricPublishedId, scope_kind: 'TENANT', assessor_user_id: t.rubricPublishedId, reviewer_id: t.rubricDraftId },
    }),
  },
  recordMaturityEvidence: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/dgv/maturity-assessments/${t.maturityAssessmentId}/evidence`,
      ifMatch: '"1"',
      body: { pillar_code: 'QUALITY', criterion_code: 'MX-QUALITY-1', assessment_state: 'NOT_ASSESSED', evidence_refs: [] },
    }),
  },
  reviewMaturityEvidence: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/maturity-evidence/${t.maturityEvidenceId}/review`, ifMatch: '"1"', body: { decision: 'ACCEPTED', note: 'Matrix review of the evidence' } }),
  },
  // The rubric and the people named in the body are read as those of the caller's own tenant: another tenant's are as unknown as ones that do not exist (422).
  createMaturityMilestone: {
    referencesTenantIds: false,
    build: (t) => ({
      method: 'POST',
      path: '/dgv/maturity-milestones',
      body: {
        rubric_version_id: t.rubricPublishedId,
        pillar_code: 'QUALITY',
        target_level: 3,
        due_on: '2030-12-31',
        owner_user_id: t.rubricDraftId,
        exit_criteria: 'The quality score is published',
        evidence_required: [],
      },
    }),
  },
  post_maturity_assessments_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/maturity-assessments/${t.maturityAssessmentId}/publish`, ifMatch: '"1"', body: { decision: 'reject', reason: REASON, evidence_ids: [] } }),
  },
  assignDatasetOwnership: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/dgv/datasets/${t.datasetId}/ownership`,
      ifMatch: '"1"',
      body: { owner_user_id: t.recipientMembershipId, steward_user_id: t.recipientMembershipId, reason: REASON },
    }),
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
      body: {
        policy_code: 'MX-NEGATIVE',
        scope_kind: 'TENANT',
        control_object: 'ALLOCATION_LINE',
        warn_pct: '90',
        block_pct: '100',
        legal_basis: 'negative authorization matrix',
        effective_from: '2026-01-01',
      },
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
  // The review of the OCR of a page: no page is confirmed or corrected, and no text of a correction is stored, by a caller that is refused.
  reviewOcrPage: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-page-ocr/${t.ocrPageId}/review`, body: { decision: 'CONFIRMED' } }),
  },
  // The AI analysis of a proposal: no run is asked for, no model is called and no run is cancelled by a caller that is refused.
  post_analysis_runs: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/analysis-runs', body: { proposal_id: t.analysisRunId, criteria_version_id: t.criteriaDraftId, profile_version_id: t.analysisRunId } }),
  },
  post_analysis_runs_id_cancel: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/analysis-runs/${t.analysisRunId}/cancel`, ifMatch: '"1"', body: { reason: 'Cancelled by the matrix' } }),
  },
  // The review of a finding of the analysis: no decision is recorded for a caller that is refused.
  reviewAnalysisFinding: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/analysis-findings/${t.analysisRunId}/review`, ifMatch: '"1"', body: { to_status: 'CONTRADICTED', reason: 'The contract of the bridge was not accepted by the owner.' } }),
  },
  post_findings_id_review: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/findings/${t.analysisRunId}/review`, ifMatch: '"1"', body: { decision: 'approve', reason: 'The citations are on the pages they name.', evidence_ids: [] } }),
  },
  // The clarification requests to contractors: nothing is asked and nothing is answered for a caller that is refused.
  sendBidClarification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/bid-clarifications', body: { proposal_id: t.analysisRunId, question: 'Explain the unit price of item 7 of the bill of quantities.', due_at: '2099-01-01T00:00:00Z' } }),
  },
  recordClarificationAnswer: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/bid-clarifications/${t.analysisRunId}/answer`, ifMatch: '"1"', body: { answer_document_id: t.documentVersionId } }),
  },
  // The evaluation report: nothing is drafted and nothing is signed for a caller that is refused.
  createEvaluationReport: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/evaluation-reports',
      body: { package_id: t.contractPackageId, criteria_version_id: t.criteriaPackageId, run_ids: [t.analysisRunId], summary: { conclusion: 'The team finds the proposals evaluated on the same criteria.' } },
    }),
  },
  signOffEvaluationReport: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/evaluation-reports/${t.analysisRunId}/sign-off`, ifMatch: '"1"', body: {} }),
  },
  // The messages of the LGSP: nothing is taken in and nothing is sent again for a caller that is refused.
  receiveInteropMessage: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/integrations/lgsp/inbound-messages',
      body: { envelope_object_key: 'tenants/matrix/interop-envelope/none', envelope_sha256: 'a'.repeat(64), external_message_id: 'MATRIX-MESSAGE-1', sender_code: 'MATRIX', signature_key_id: 'matrix-key', signature: 'b'.repeat(64) },
    }),
  },
  retryInteropMessage: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/doc-interop-messages/${t.analysisRunId}/retry`, ifMatch: '"1"', body: {} }),
  },
  uploadOcrCorrectionFile: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/document-page-ocr/files', body: {} }),
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
    build: (t) => ({
      method: 'POST',
      path: `/inspections/${t.inspectionId}/schedule`,
      ifMatch: '"1"',
      body: { scheduled_at: '2999-01-01T00:00:00Z', participant_membership_ids: [t.recipientMembershipId] },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/inspections/${t.inspectionId}/quality-acceptances`,
      body: { acceptance_scope: 'WORK_ITEM', record_no: 'QA-MX-NEW', document_version_id: t.draftContractId },
    }),
  },
  saveSiteDiaryDraft: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/site-diaries',
      body: { contract_id: t.draftContractId, record_date: '2026-10-20', client_operation_id: '00000000-0000-4000-8000-0000000000e6', content: { summary: 'Matrix probe of the diary' } },
    }),
  },
  reviseSiteDiaryDraft: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/draft`,
      ifMatch: '"1"',
      body: { content: { summary: 'Matrix probe of the diary' }, client_operation_id: '00000000-0000-4000-8000-0000000000e6' },
    }),
  },
  signSiteDiaryByContractor: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/contractor-sign`,
      ifMatch: '"1"',
      body: { signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e6' },
    }),
  },
  addSupervisorRemark: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/supervisor-remark`,
      ifMatch: '"1"',
      body: { remark: 'Matrix probe of the remark', signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e6' },
    }),
  },
  confirmSiteDiaryByOwner: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/owner-confirm`,
      ifMatch: '"1"',
      body: { signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e6' },
    }),
  },
  lockSiteDiary: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/site-diaries/${t.diaryId}/lock`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  correctSiteDiary: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/corrections`,
      body: { content: { summary: 'Matrix probe of the correction' }, correction_reason: REASON, client_operation_id: '00000000-0000-4000-8000-0000000000e6' },
    }),
  },
  receiveIncomingDocument: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/incoming-documents',
      body: {
        title: 'Matrix probe of an incoming letter',
        doc_type_code: 'CV',
        channel: 'UPLOAD',
        file_object_key: 'tenants/00000000-0000-4000-8000-000000000001/document/00000000-0000-4000-8000-000000000002',
        file_sha256: 'a'.repeat(64),
        sender_name: 'Matrix sender',
      },
    }),
  },
  registerIncomingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/registration`, ifMatch: '"1"', body: {} }),
  },
  assignIncomingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/assignment`, ifMatch: '"1"', body: { assigned_unit_id: '00000000-0000-4000-8000-0000000000e7' } }),
  },
  startIncomingDocumentProcessing: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/processing`, ifMatch: '"1"', body: {} }),
  },
  resolveIncomingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/resolution`, ifMatch: '"1"', body: { resolution_summary: 'Matrix probe of the resolution' } }),
  },
  rejectIncomingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/rejection`, ifMatch: '"1"', body: { rejection_reason: 'Matrix probe of the rejection of a letter' } }),
  },
  createDossier: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/dossiers',
      body: { dossier_code: 'DS-MATRIX', year: 2026, title: 'Matrix probe of a dossier', organization_unit_id: '00000000-0000-4000-8000-0000000000e7', category_code: 'PROJECT_INVESTMENT' },
    }),
  },
  addDocumentToDossier: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dossiers/${t.dossierId}/items`, ifMatch: '"1"', body: { document_id: '00000000-0000-4000-8000-0000000000e8' } }),
  },
  closeDossier: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dossiers/${t.dossierId}/closure`, ifMatch: '"1"', body: {} }),
  },
  handoverDossierToArchive: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dossiers/${t.dossierId}/handover`, ifMatch: '"1"', body: { archive_ref: 'MATRIX-ARCHIVE-1', handed_over_at: '2026-01-01T00:00:00Z' } }),
  },
  proposeDossierDisposal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dossiers/${t.dossierId}/disposal-proposals`, ifMatch: '"1"', body: { reason: 'Matrix probe of a disposal proposal' } }),
  },
  decideDossierDisposal: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dossiers/${t.dossierId}/disposal-decision`, ifMatch: '"1"', body: { decision: 'REJECT' } }),
  },
  createDocumentRetentionRule: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/document-retention-rules',
      body: {
        rule_set: 'TENANT_CUSTOM',
        category_code: 'MATRIX_CATEGORY',
        class_code: 'Y10',
        retention_years: 10,
        start_basis: 'FROM_CLOSED',
        legal_basis: 'Matrix attempt to draft a retention rule',
        effective_from: '2099-01-01',
      },
    }),
  },
  publishDocumentRetentionRule: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/document-retention-rules/${t.legalHoldId}/publish`, ifMatch: '"1"', body: {} }),
  },
  confirmDocumentRetentionRuleLegalBasis: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/document-retention-rules/${t.legalHoldId}/legal-confirmation`,
      ifMatch: '"1"',
      body: { legal_confirmation_ref: 'CXN-MATRIX', evidence_document_id: '00000000-0000-4000-8000-0000000000e8' },
    }),
  },
  fileIncomingDocument: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/incoming-documents/${t.incomingId}/filing`, ifMatch: '"1"', body: { dossier_id: t.dossierId } }),
  },
  assignWork: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/work-actions/assign', body: { source: 'EARLY_WARNING', source_id: 'matrix-probe', assignee_id: '00000000-0000-4000-8000-0000000000e7', due_on: '2999-01-01' } }),
  },
  claimWork: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/work-actions/claim', body: { source: 'EARLY_WARNING', source_id: 'matrix-probe' } }),
  },
  snoozeWork: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/work-actions/snooze', body: { source: 'EARLY_WARNING', source_id: 'matrix-probe', reason_code: 'WAITING_INFORMATION', snooze_until: '2999-01-01T00:00:00.000Z' } }),
  },
  pauseWorkClock: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/work-actions/pause', body: { source: 'EARLY_WARNING', source_id: 'matrix-probe', reason_code: 'FORCE_MAJEURE', reason: 'Matrix probe, nothing is paused.', allowed_by_id: '00000000-0000-4000-8000-0000000000e7', paused_until: '2999-01-01T00:00:00.000Z' } }),
  },
  resumeWorkClock: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/work-actions/resume', body: { source: 'EARLY_WARNING', source_id: 'matrix-probe' } }),
  },
  acknowledgeAlertEscalation: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/alert-escalations/00000000-0000-4000-8000-0000000000e7/acknowledge', body: {} }),
  },
  updateMyAlertProfile: {
    referencesTenantIds: false,
    build: () => ({ method: 'PUT', path: '/me/alert-profile', ifMatch: '"0"', body: { digest_enabled: true, push_cap_per_day: 1 } }),
  },
  declareAlertAbsence: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/home/alert-absences', body: { kind: 'LEAVE', valid_from: '2999-01-01T00:00:00.000Z', valid_until: '2999-01-05T00:00:00.000Z' } }),
  },
  endAlertAbsence: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/alert-absences/00000000-0000-4000-8000-0000000000e7/end', ifMatch: '"1"', body: { status: 'CANCELLED', reason: 'Negative matrix probe' } }),
  },
  proposeAlertCover: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/alert-absences/00000000-0000-4000-8000-0000000000e7/covers', body: { deputy_id: '00000000-0000-4000-8000-0000000000e7', valid_from: '2999-01-01T00:00:00.000Z', valid_until: '2999-01-03T00:00:00.000Z', scope_kind: 'ALL' } }),
  },
  decideAlertCover: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/alert-covers/00000000-0000-4000-8000-0000000000e7/decision', ifMatch: '"1"', body: { decision: 'APPROVE', note: 'Negative matrix probe' } }),
  },
  revokeAlertCover: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/alert-covers/00000000-0000-4000-8000-0000000000e7/revoke', ifMatch: '"1"', body: { reason: 'Negative matrix probe' } }),
  },
  transitionAnalyticsCertification: {
    // The subject is a built-in metric of every tenant, not an id of tenant A: a caller of another tenant meets the state of its own certification (409), and tenant A must stay untouched.
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/bi/certifications/transitions', body: { subject: 'KPI', key: 'DISBURSEMENT_RATE_PM', version: 1, to: 'CONFIRMED' } }),
  },
  setRagOverride: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/rag/overrides', body: { unit_id: '00000000-0000-4000-8000-0000000000e8', band: 'RED', reason: 'Matrix probe: no unit', until: '2999-01-01' } }),
  },
  revokeRagOverride: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/home/rag/overrides/revoke', body: { unit_id: '00000000-0000-4000-8000-0000000000e8', reason: 'Matrix probe: no unit' } }),
  },
  scoreEarlyWarningWeek: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/home/rag/scores', body: undefined }),
  },
  assignQualityIncident: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/dgv/quality-incidents/${t.qualityIncidentId}/assignment`,
      ifMatch: '"1"',
      body: { assignee_user_id: '00000000-0000-4000-8000-0000000000e7', due_at: '2999-01-01T00:00:00.000Z' },
    }),
  },
  transitionQualityIncident: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/quality-incidents/${t.qualityIncidentId}/transition`, ifMatch: '"1"', body: { to_status: 'ACKNOWLEDGED' } }),
  },
  verifyQualityIncident: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/quality-incidents/${t.qualityIncidentId}/verification`, ifMatch: '"1"', body: { decision: 'REOPEN', note: 'Matrix probe of the verification' } }),
  },
  post_quality_exceptions_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/quality-exceptions/${t.qualityExceptionId}/decision`, ifMatch: '"1"', body: { decision: 'RESOLVED', reason: 'Matrix probe of the decision' } }),
  },
  proposeSourceMapping: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/dgv/source-mappings', body: { dataset_id: t.qualityDatasetId, source_system: 'PAY', source_field: 'so_tien', target_field: 'amount_vnd', unit: 'VND' } }),
  },
  decideSourceMapping: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/dgv/source-mappings/${t.sourceMappingId}/decision`, ifMatch: '"1"', body: { decision: 'CONFIRMED', note: 'Matrix probe of the decision' } }),
  },
  runReconciliation: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/dgv/reconciliations',
      body: { recon_code: 'MATRIX-RECON', source_a: 'PAY.treasury_transaction', source_b: 'DIS.report_accepted', as_of_period: '2026-10', basis: 'VND, ngày Kho bạc thanh toán', tolerance_vnd: '0' },
    }),
  },
  updateMyProfile: {
    referencesTenantIds: false,
    build: () => ({ method: 'PUT', path: '/me/profile', ifMatch: '"1"', body: { display_name: 'Matrix Probe' } }),
  },
  revokeMySession: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/me/sessions/${t.otherSessionId}/revoke`, body: { reason: REASON } }),
  },
  revokeMyDevice: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/me/devices/${t.otherDeviceId}/revoke`, body: { reason: REASON } }),
  },
  createWorkflowDraft: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/workflow-definitions',
      body: {
        business_type: 'report.accept',
        definition: {
          steps: [{ id: 'review', name: 'Rà soát', assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' }],
          terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' },
        },
      },
    }),
  },
  updateWorkflowDraft: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'PUT',
      path: `/workflow-definitions/${t.workflowDraftId}`,
      ifMatch: '"1"',
      body: {
        business_type: 'report.accept',
        definition: {
          steps: [{ id: 'review', name: 'Rà soát', assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' }],
          terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' },
        },
      },
    }),
  },
  publishWorkflowVersion: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/workflow-definitions/${t.workflowDraftId}/publish`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  decideApprovalTask: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/approval-tasks/${t.approvalTaskId}/decision`, ifMatch: '"1"', body: { decision: 'approve' } }),
  },
  proposeUnitReorganization: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/unit-reorganizations',
      body: {
        kind: 'DISSOLVE',
        effective_from: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        legal_basis_ref: 'Matrix legal basis 1',
        predecessor_unit_ids: [t.recipientMembershipId],
        successors: [{ existing_unit_id: t.memberRoleId }],
        mapping: {},
      },
    }),
  },
  decideUnitReorganization: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/unit-reorganizations/${t.reorganizationId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  createDelegation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/delegations',
      body: {
        delegate_membership_id: t.recipientMembershipId,
        permissions: ['approval.decide'],
        scope_kind: 'UNIT_SUBTREE',
        scope_ref_ids: ['00000000-0000-4000-8000-0000000000d1'],
        valid_from: '2099-01-01T00:00:00Z',
        valid_until: '2099-01-08T00:00:00Z',
        reason: REASON,
      },
    }),
  },
  revokeDelegation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/delegations/${t.delegationId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // IAM-2: the permanent delegation, acting on behalf of a person and the period limit of a role; a caller who is refused changes nothing.
  createStandingDelegationRequest: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/standing-delegation-requests',
      body: {
        delegate_membership_id: t.recipientMembershipId,
        permissions: ['approval.decide'],
        scope_kind: 'UNIT_SUBTREE',
        scope_ref_ids: ['00000000-0000-4000-8000-0000000000d1'],
        valid_from: '2099-01-01T00:00:00Z',
        review_due_at: '2099-06-01T00:00:00Z',
        end_condition_kind: 'UNTIL_EVENT',
        end_condition_text: 'Until the deputy director is appointed.',
        reason: REASON,
      },
    }),
  },
  decideStandingDelegationRequest: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/standing-delegation-requests/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'approve' } }) },
  cancelStandingDelegationRequest: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/standing-delegation-requests/00000000-0000-4000-8000-0000000000f1/cancel', ifMatch: '"1"', body: { reason: REASON } }) },
  reviewDelegation: { referencesTenantIds: true, build: (t) => ({ method: 'POST', path: `/delegations/${t.delegationId}/review`, ifMatch: '"1"', body: { review_due_at: '2099-06-01T00:00:00Z' } }) },
  requestActing: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: '/acting-requests', body: { subject_membership_id: t.recipientMembershipId, permissions: ['dis.report.submit'], hours: 4, reason: 'The reporter is away and the report is due today.' } }),
  },
  decideActingRequest: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/acting-requests/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'approve' } }) },
  cancelActingRequest: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/acting-requests/00000000-0000-4000-8000-0000000000f1/cancel', ifMatch: '"1"', body: { reason: REASON } }) },
  revokeActing: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/acting-requests/00000000-0000-4000-8000-0000000000f1/revoke', ifMatch: '"1"', body: { reason: REASON } }) },
  createPeriodScope: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/period-scopes', body: { role_grant_id: '00000000-0000-4000-8000-0000000000f1', period_codes: ['2026-Q3'], reason: REASON } }) },
  liftPeriodScope: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/period-scopes/00000000-0000-4000-8000-0000000000f1/lift', ifMatch: '"1"', body: { reason: REASON } }) },
  reassignApprovalTask: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/approval-tasks/${t.approvalTaskId}/reassign`,
      ifMatch: '"1"',
      body: { new_assignee_membership_id: '00000000-0000-4000-8000-0000000000f1', reason: REASON },
    }),
  },
  cancelWorkflowInstance: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/workflow-instances/${t.workflowInstanceId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  registerSitePhoto: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/site-photos',
      body: {
        client_operation_id: '00000000-0000-4000-8000-0000000000e8',
        project_id: t.projectId,
        object_key: 'tenants/00000000-0000-4000-8000-000000000001/site_photo/00000000-0000-4000-8000-000000000002',
        file_sha256: 'a'.repeat(64),
      },
    }),
  },
  resolveDiaryConflict: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/site-diaries/${t.diaryId}/resolve-conflict`,
      ifMatch: '"1"',
      body: { conflict_diary_id: '00000000-0000-4000-8000-0000000000e7', resolution: 'KEEP_PRIMARY', note: REASON },
    }),
  },
  signQualityAcceptance: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/quality-acceptances/${t.acceptanceId}/sign`,
      ifMatch: '"1"',
      body: { signer_role: 'OWNER', signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e5' },
    }),
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
  // PRC-1: the workflow of a procurement package; a caller who is refused moves nothing.
  startPackageWorkflow: { referencesTenantIds: true, build: (t) => ({ method: 'POST', path: `/procurement-packages/${t.criteriaPackageId}/workflow`, body: {} }) },
  completePackageChecklistItem: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-checklist-items/00000000-0000-4000-8000-0000000000f1/completion', body: { evidence: [{ kind: 'ATTESTATION', note: 'Matrix completion of a refused call.' }] } }) },
  assignPackageChecklistItem: { referencesTenantIds: true, build: (t) => ({ method: 'POST', path: '/package-checklist-items/00000000-0000-4000-8000-0000000000f1/owner', body: { owner_id: t.recipientMembershipId } }) },
  advancePackageStep: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/advance', ifMatch: '"1"', body: {} }) },
  returnPackageStep: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/return', ifMatch: '"1"', body: { to_step: 'DOC_PREPARE', reason: REASON } }) },
  holdPackageWorkflow: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/hold', ifMatch: '"1"', body: { reason: REASON } }) },
  resumePackageWorkflow: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/resume', ifMatch: '"1"', body: {} }) },
  assignPackageWorkflowOwner: { referencesTenantIds: true, build: (t) => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/owner', ifMatch: '"1"', body: { owner_id: t.recipientMembershipId } }) },
  requestPackageStepException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/exceptions', body: { kind: 'SKIP_ITEMS', reason: REASON } }) },
  decidePackageStepException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-step-exceptions/00000000-0000-4000-8000-0000000000f1/decision', body: { decision: 'REJECT', note: REASON } }) },
  cancelPackageWorkflow: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/package-workflows/00000000-0000-4000-8000-0000000000f1/cancel', ifMatch: '"1"', body: { reason: REASON } }) },
  // FND-1: the stored figures of the funding model; a caller who is refused prepares, hands in, accepts or returns nothing.
  proposeFundingFigures: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/funding-figures/batches', body: { project_id: '00000000-0000-4000-8000-0000000000f1', class_code: 'EQUITY', tier_code: 'ALL', measure: 'DISBURSED', figure_kind: 'ESTIMATE', period_grain: 'MONTH', plan_year: 2026, as_of_date: '2026-03-10', entries: [{ period_ordinal: 3, amount_vnd: '100' }] } }) },
  submitFundingFigures: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/funding-figures/batches/00000000-0000-4000-8000-0000000000f1/submission', ifMatch: '"1"', body: {} }) },
  acceptFundingFigures: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/funding-figures/batches/00000000-0000-4000-8000-0000000000f1/acceptance', ifMatch: '"1"', body: {} }) },
  returnFundingFigures: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/funding-figures/batches/00000000-0000-4000-8000-0000000000f1/return', ifMatch: '"1"', body: { reason: REASON } }) },
  withdrawFundingFigures: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/funding-figures/batches/00000000-0000-4000-8000-0000000000f1/withdrawal', ifMatch: '"1"', body: { reason: REASON } }) },
  // EGP-1: the connection of the national procurement network and the codes it carries; a caller who is refused changes nothing and reads no file.
  setEgpConnectionState: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/connection/state', ifMatch: '"1"', body: { enabled: false, reason: REASON } }) },
  uploadEgpFile: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/imports/files', body: {} }) },
  previewEgpFile: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/egp/imports/preview', body: { kind: 'KHLCNT', file_object_key: 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64) } }),
  },
  importEgpFile: {
    referencesTenantIds: true,
    build: () => ({ method: 'POST', path: '/egp/imports', body: { kind: 'KHLCNT', file_object_key: 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa', file_sha256: 'a'.repeat(64) } }),
  },
  proposeEgpMapping: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/mappings', body: { subject_type: 'PACKAGE', our_code: 'GT-0001', external_code: 'PK-0001', reason: REASON } }) },
  decideEgpMapping: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/mappings/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'APPROVE', reason: REASON } }) },
  retireEgpMapping: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/mappings/00000000-0000-4000-8000-0000000000f1/retire', ifMatch: '"1"', body: { reason: REASON } }) },
  // AI-2: the assistant, its checklists and criteria, and the exceptions to where an edition processes; a caller who is refused changes nothing and reads nothing.
  // A source that is not readable is the same refusal (422) whether it is foreign, out of scope or missing: nothing says which, so the case does not look for a 403 or a 404.
  createAiAssistRun: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/ai/assist/runs', body: { kind: 'QA', request_text: 'What is the investment?', sources: [{ kind: 'PROJECT', id: '00000000-0000-4000-8000-0000000000f1' }] } }) },
  decideAiAssistRun: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/assist/runs/00000000-0000-4000-8000-0000000000f1/decision', body: { decision: 'REJECTED', rationale: REASON } }) },
  createAiReviewChecklist: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/ai/review-checklists', body: { code: 'CHK-MATRIX', title: 'Checklist of the matrix', applies_to: 'DIS_REPORT', items: [{ code: 'LEN', label: 'Has some words', kind: 'MIN_WORDS', severity: 'INFO', params: { min: 3 } }] } }) },
  publishAiReviewChecklist: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/review-checklists/00000000-0000-4000-8000-0000000000f1/publish', ifMatch: '"1"', body: {} }) },
  createAiEvalCriteriaSet: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/ai/evaluation-criteria', body: { code: 'SET-MATRIX', title: 'Criteria of the matrix', criteria: [{ code: 'ONLY', label: 'The only criterion', weight_bp: 10000 }] } }) },
  publishAiEvalCriteriaSet: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/evaluation-criteria/00000000-0000-4000-8000-0000000000f1/publish', ifMatch: '"1"', body: {} }) },
  attestAiProvider: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai-providers/00000000-0000-4000-8000-0000000000f1/attestation', ifMatch: '"1"', body: { data_location_country: 'VN', no_training_attested: true, attestation_ref: 'DPA-2026-07' } }) },
  requestAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions', body: { provider_id: '00000000-0000-4000-8000-0000000000f1', max_classification: 'INTERNAL', reason: REASON, valid_days: 7 } }) },
  decideAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'REJECT', note: REASON } }) },
  revokeAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions/00000000-0000-4000-8000-0000000000f1/revocation', ifMatch: '"1"', body: { reason: REASON } }) },
  // RPT-1: the report engine; a caller who is refused makes no draft, signs no step, issues nothing and records no delivery.
  generateReport: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/report-engine/drafts', body: { layout_code: 'DIS-WEEKLY', period: { kind: 'AS_OF', year: 2026, day: '2026-10-18' } } }) },
  checkReport: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/report-engine/drafts/00000000-0000-4000-8000-0000000000f1/check', ifMatch: '"1"', body: {} }) },
  approveReport: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/report-engine/drafts/00000000-0000-4000-8000-0000000000f1/approve', ifMatch: '"1"', body: {} }) },
  issueReport: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/report-engine/drafts/00000000-0000-4000-8000-0000000000f1/issue', ifMatch: '"1"', body: {} }) },
  deliverReport: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/report-engine/issues/00000000-0000-4000-8000-0000000000f1/deliveries', body: { receiver: 'MOF', channel: 'MANUAL' } }) },
  answerReportDelivery: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/report-engine/issues/00000000-0000-4000-8000-0000000000f1/answers', body: { receiver: 'MOF', outcome: 'ACCEPTED' } }) },
  // EGP-2: the duties of posting to the national procurement network and the reconciliation of the fields; a caller who is refused opens, moves and settles nothing.
  openEgpObligation: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/obligations', body: { kind: 'NOTICE', our_code: 'GT-0001', triggered_on: '2026-11-02' } }) },
  sweepEgpObligations: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/obligations/sweep', body: {} }) },
  prepareEgpObligation: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/obligations/00000000-0000-4000-8000-0000000000f1/prepare', ifMatch: '"1"', body: { fields: { plan_name: 'Plan' } } }) },
  submitEgpObligation: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/obligations/00000000-0000-4000-8000-0000000000f1/submit', ifMatch: '"1"', body: {} }) },
  receiptEgpObligation: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/obligations/00000000-0000-4000-8000-0000000000f1/receipt', ifMatch: '"1"', body: { receipt_ref: 'BN-1' } }) },
  rejectEgpObligation: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/obligations/00000000-0000-4000-8000-0000000000f1/reject', ifMatch: '"1"', body: { reason: REASON } }) },
  cancelEgpObligation: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/obligations/00000000-0000-4000-8000-0000000000f1/cancel', ifMatch: '"1"', body: { reason: REASON } }) },
  runEgpReconciliation: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/egp/reconciliation/run', body: {} }) },
  resolveEgpReconciliationItem: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/egp/reconciliation/items/00000000-0000-4000-8000-0000000000f1/resolution', ifMatch: '"1"', body: { kind: 'ACCEPT_EXTERNAL', reason: REASON } }) },
  // VND-1: the management of contractors; a caller who is refused changes nothing, and a caller of another tenant finds nothing.
  updateVendorProfile: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/profile', ifMatch: '"1"', body: {legal_rep_name:'Matrix representative'} }) },
  declareVendorNoOwnerAboveThreshold: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/ownership-declaration', ifMatch: '"1"', body: {} }) },
  addVendorOwner: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/owners', body: {owner_kind:'PERSON',owner_name:'Matrix owner',beneficial_owner:false,share_pct:'10'} }) },
  endVendorOwner: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/owners/00000000-0000-4000-8000-0000000000f1/end', body: {reason:'negative authorization matrix'} }) },
  scanVendorDuplicates: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/duplicate-scan', body: {} }) },
  decideVendorDuplicate: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/duplicates/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: {decision:'DISMISSED',reason:'negative authorization matrix'} }) },
  requestVendorPayeeChange: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/payee-changes', body: {bank_name:'Matrix bank',account_holder:'Matrix holder',account_number:'123456789',reason:'negative authorization matrix',evidence_document_id:'00000000-0000-4000-8000-0000000000d1'} }) },
  approveVendorPayeeChange: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/payee-changes/00000000-0000-4000-8000-0000000000f1/approval', ifMatch: '"1"', body: {role:'CONTRACT_MATCH'} }) },
  recordVendorPayeeCallback: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/payee-changes/00000000-0000-4000-8000-0000000000f1/callback', ifMatch: '"1"', body: {outcome:'CONFIRMED',called_number:'0912000111',used_number_on_file:true} }) },
  cancelVendorPayeeChange: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/payee-changes/00000000-0000-4000-8000-0000000000f1/cancel', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  rejectVendorPayeeChange: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/payee-changes/00000000-0000-4000-8000-0000000000f1/reject', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  closeVendorPayeeAccount: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/payee-accounts/00000000-0000-4000-8000-0000000000f1/close', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  addVendorQualification: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/qualifications', body: {kind:'CONSTRUCTION_ACTIVITY',certificate_no:'MATRIX-1',issuer:'Matrix issuer',issued_on:'2026-01-01'} }) },
  addVendorKeyStaff: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/contractors/00000000-0000-4000-8000-0000000000f1/key-staff', body: {staff_role:'PROJECT_MANAGER',person_name:'Matrix person',qualification_title:'Matrix title',issued_on:'2026-01-01'} }) },
  verifyVendorQualification: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/qualifications/00000000-0000-4000-8000-0000000000f1/verification', ifMatch: '"1"', body: {} }) },
  verifyVendorKeyStaff: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/key-staff/00000000-0000-4000-8000-0000000000f1/verification', ifMatch: '"1"', body: {} }) },
  revokeVendorQualification: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/qualifications/00000000-0000-4000-8000-0000000000f1/revocation', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  revokeVendorKeyStaff: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/key-staff/00000000-0000-4000-8000-0000000000f1/revocation', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  setVendorPackageRequirements: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/packages/00000000-0000-4000-8000-0000000000f1/requirements', body: {requirements:[]} }) },
  openVendorRestrictionCase: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases', body: {subject_kind:'CONTRACTOR',contractor_id:'00000000-0000-4000-8000-0000000000f1',trigger_kind:'OWN_INITIATIVE',violation_groups:['GROUP_3'],violation_summary:'negative authorization matrix of a debarment case',violation_on:'2026-01-01'} }) },
  openVendorRestrictionCaseFromEgpRecord: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases/from-egp-record', body: {egp_record_id:'00000000-0000-4000-8000-0000000000f1',violation_groups:['GROUP_3']} }) },
  advanceVendorRestrictionCase: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases/00000000-0000-4000-8000-0000000000f1/moves', ifMatch: '"1"', body: {move:'SEND_NOTICE'} }) },
  decideVendorRestrictionCase: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: {decision:'DISMISS',reason:'negative authorization matrix'} }) },
  putVendorRestrictionIntoEffect: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases/00000000-0000-4000-8000-0000000000f1/effect', ifMatch: '"1"', body: {} }) },
  liftVendorRestrictionCase: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/restriction-cases/00000000-0000-4000-8000-0000000000f1/lift', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  recordVendorReputationEvent: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/reputation-events', body: {contractor_id:'00000000-0000-4000-8000-0000000000f1',behaviour_code:'NO_BID_SECURITY',event_on:'2026-01-01',description:'negative authorization matrix'} }) },
  postVendorReputationEvent: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/reputation-events/00000000-0000-4000-8000-0000000000f1/posting', ifMatch: '"1"', body: {receipt:'MATRIX-1'} }) },
  retractVendorReputationEvent: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/reputation-events/00000000-0000-4000-8000-0000000000f1/retraction', ifMatch: '"1"', body: {reason:'negative authorization matrix of a retraction'} }) },
  createVendorJointVenture: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/joint-ventures', body: {name:'Matrix venture',members:[{contractor_id:'00000000-0000-4000-8000-0000000000f1',share_pct:'50',lead:true},{contractor_id:'00000000-0000-4000-8000-0000000000d1',share_pct:'50',lead:false}]} }) },
  endVendorJointVenture: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/vendor/joint-ventures/00000000-0000-4000-8000-0000000000f1/end', ifMatch: '"1"', body: {reason:'negative authorization matrix'} }) },
  // GOV-10: the report that an alert is wrong, its review, and the review of the red flags of procurement; a caller who is refused changes and reads nothing.
  reportAlertWrong: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/home/alert-feedback', body: { source: 'GUARANTEE', source_id: 'g-1', reason: 'WRONG_DATA' } }) },
  withdrawAlertFeedback: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/home/alert-feedback/00000000-0000-4000-8000-0000000000f1/withdraw', ifMatch: '"1"', body: {} }) },
  reviewAlertFeedback: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/home/alert-feedback/00000000-0000-4000-8000-0000000000f1/review', ifMatch: '"1"', body: { move: 'REJECT', review_note: REASON } }) },
  scanRedFlags: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/red-flags/scan', body: {} }) },
  takeRedFlag: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/red-flags/00000000-0000-4000-8000-0000000000f1/take', ifMatch: '"1"', body: {} }) },
  proposeClearRedFlag: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/red-flags/00000000-0000-4000-8000-0000000000f1/propose-clear', ifMatch: '"1"', body: { reason: REASON } }) },
  confirmClearRedFlag: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/red-flags/00000000-0000-4000-8000-0000000000f1/confirm-clear', ifMatch: '"1"', body: {} }) },
  rejectClearRedFlag: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/red-flags/00000000-0000-4000-8000-0000000000f1/reject-clear', ifMatch: '"1"', body: { reason: REASON } }) },
  referRedFlag: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/red-flags/00000000-0000-4000-8000-0000000000f1/refer', ifMatch: '"1"', body: { reason: REASON } }) },
  // INT-1: machine accounts, BI logins, certified datasets and project codes; a caller who is refused changes nothing and learns no secret.
  createMachineAccount: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/int/machine-accounts', body: { name: 'Matrix account', scopes: ['open.projects.read'] } }) },
  updateMachineAccount: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/machine-accounts/00000000-0000-4000-8000-0000000000f1/update', ifMatch: '"1"', body: { rate_limit_per_minute: 5, reason: REASON } }) },
  decideMachineAccount: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/machine-accounts/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'SUSPEND', reason: REASON } }) },
  rotateMachineCredential: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/machine-accounts/00000000-0000-4000-8000-0000000000f1/rotate', ifMatch: '"1"', body: { reason: REASON } }) },
  setExportDataset: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/int/export-datasets/state', ifMatch: '"1"', body: { dataset_code: 'DS-DISB', enabled: false, reason: REASON } }) },
  createBiReader: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/int/bi-readers', body: { name: 'Matrix BI login' } }) },
  rotateBiReaderPassword: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/bi-readers/00000000-0000-4000-8000-0000000000f1/password', ifMatch: '"1"', body: { reason: REASON } }) },
  decideBiReader: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/bi-readers/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'SUSPEND', reason: REASON } }) },
  registerSourceSystem: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/int/source-systems', body: { code: 'MATRIX', name: 'Matrix system', kind: 'OTHER' } }) },
  retireSourceSystem: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/source-systems/00000000-0000-4000-8000-0000000000f1/retire', ifMatch: '"1"', body: { reason: REASON } }) },
  proposeProjectCode: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/int/project-codes', body: { source_system: 'MATRIX', our_code: 'PRJ-1', external_code: 'X-1', reason: REASON } }) },
  decideProjectCode: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/project-codes/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'APPROVE', reason: REASON } }) },
  retireProjectCode: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/int/project-codes/00000000-0000-4000-8000-0000000000f1/retire', ifMatch: '"1"', body: { reason: REASON } }) },
  // AI-2: the assistant, its checklists and criteria, and the exceptions to where an edition processes; a caller who is refused changes nothing and reads nothing.
  createAiAssistRun: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/assist/runs', body: { kind: 'QA', request_text: 'What is the investment?', sources: [{ kind: 'PROJECT', id: '00000000-0000-4000-8000-0000000000f1' }] } }) },
  decideAiAssistRun: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/assist/runs/00000000-0000-4000-8000-0000000000f1/decision', body: { decision: 'REJECTED', rationale: REASON } }) },
  createAiReviewChecklist: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/ai/review-checklists', body: { code: 'CHK-MATRIX', title: 'Checklist of the matrix', applies_to: 'DIS_REPORT', items: [{ code: 'LEN', label: 'Has some words', kind: 'MIN_WORDS', severity: 'INFO', params: { min: 3 } }] } }) },
  publishAiReviewChecklist: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/review-checklists/00000000-0000-4000-8000-0000000000f1/publish', ifMatch: '"1"' }) },
  createAiEvalCriteriaSet: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/ai/evaluation-criteria', body: { code: 'SET-MATRIX', title: 'Criteria of the matrix', criteria: [{ code: 'ONLY', label: 'The only criterion', weight_bp: 10000 }] } }) },
  publishAiEvalCriteriaSet: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/evaluation-criteria/00000000-0000-4000-8000-0000000000f1/publish', ifMatch: '"1"' }) },
  attestAiProvider: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai-providers/00000000-0000-4000-8000-0000000000f1/attestation', ifMatch: '"1"', body: { data_location_country: 'VN', no_training_attested: true, attestation_ref: 'DPA-2026-07' } }) },
  requestAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions', body: { provider_id: '00000000-0000-4000-8000-0000000000f1', max_classification: 'INTERNAL', reason: REASON, valid_days: 7 } }) },
  decideAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'REJECT', note: REASON } }) },
  revokeAiExternalException: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/ai/external-exceptions/00000000-0000-4000-8000-0000000000f1/revocation', ifMatch: '"1"', body: { reason: REASON } }) },
  // BAN-1: the committee workspace; a refused caller registers no committee, appoints nobody, records no decision, raises no alert.
  registerCommittee: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/committee/roster', body: { code: 'MATRIX', name: 'Matrix committee' } }) },
  appointCommitteeMember: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/committee/roster/members', body: { committee_id: '00000000-0000-4000-8000-0000000000f1', membership_id: '00000000-0000-4000-8000-0000000000f2', committee_role: 'MEMBER', valid_from: '2026-01-01' } }) },
  endCommitteeMember: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/committee/roster/members/00000000-0000-4000-8000-0000000000f1/ending', ifMatch: '"1"', body: { reason: REASON } }) },
  recordAttentionDecision: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/committee/attention/decisions', body: { project_id: '00000000-0000-4000-8000-0000000000f1', decision: 'ACKNOWLEDGED', note: REASON } }) },
  evaluateCommitteeAlerts: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/committee/alerts/evaluate', body: {} }) },
  acknowledgeCommitteeAlert: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/committee/alerts/00000000-0000-4000-8000-0000000000f1/acknowledgement', ifMatch: '"1"', body: { note: REASON } }) },
  decideProcurementResult: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/procurement-results/${t.resultId}/decision`, ifMatch: '"1"', body: { decision: 'REJECT', comment: 'Matrix decision of a refused call.' } }),
  },
  decideConflictOfInterest: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/bid-conflict-declarations/${t.conflictDeclarationId}/decision`,
      ifMatch: '"1"',
      body: { decision: 'ALLOWED', decision_reason: 'Matrix decision of a refused caller.' },
    }),
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
    build: () => ({
      method: 'POST',
      path: '/support-tickets',
      body: { category: 'OTHER', subject: 'Negative authorization matrix', description: 'A ticket raised by the negative authorization matrix.' },
    }),
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
      body: {
        code: 'MX-TF-NEW',
        name: 'Matrix task force',
        purpose: 'Created by the authorization matrix',
        lead_membership_id: t.recipientMembershipId,
        scope_unit_id: t.unit2,
        valid_from: '2026-01-05',
      },
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
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/suspend`,
      ifMatch: '"1"',
      body: { reason: REASON, decision_document_version_id: t.documentVersionId, suspended_from: '2026-10-25' },
    }),
  },
  resumeContract: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/resume`,
      ifMatch: '"1"',
      body: { reason: REASON, decision_document_version_id: t.documentVersionId, resumed_on: '2026-10-25' },
    }),
  },
  terminateContract: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/terminate`,
      ifMatch: '"1"',
      body: { reason: REASON, decision_document_version_id: t.documentVersionId, terminated_on: '2026-10-25', guarantee_action: 'HOLD' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/change-requests/${t.changeRequestId}/evaluate`,
      ifMatch: '"1"',
      body: { evaluated_delta_vnd: '0', schedule_impact_days: 0, funding_impact_note: REASON },
    }),
  },
  post_contract_changes_id_decision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contract-changes/${t.changeRequestId}/decision`, ifMatch: '"1"', body: { decision: 'return', reason: REASON, evidence_ids: [] } }),
  },
  // The retroactive adjustment: a caller that is refused approves no change order, makes no revision and posts no entry on the ledger.
  approveRetroactiveAdjustment: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/change-requests/${t.changeRequestId}/retroactive-adjustment`,
      ifMatch: '"1"',
      body: { adjustment_basis: REASON, decision_document_version_id: t.documentVersionId, affected_acceptance_ids: [], effective_on: '2026-06-01' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.draftContractId}/acceptances`,
      body: { measurement_ids: [t.measurementId], period_id: t.periodId, document_version_id: t.draftContractId },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: '/payment-requests',
      body: { contract_id: t.draftContractId, request_kind: 'INTERIM', acceptance_id: t.paymentAcceptanceId, allocation_line_id: t.draftContractId, request_no: 'DNTT-MX-NEW' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/payment-requests/${t.paymentRequestId}/send-treasury`,
      ifMatch: '"1"',
      body: { treasury_submitted_on: '2026-10-25', form_instance_ids: [t.paymentRequestId] },
    }),
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
  acknowledgeAdvanceAlert: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/advances/${t.advanceId}/acknowledge-alert`, ifMatch: '"1"', body: { note: REASON, action_plan_due_on: '2999-01-01' } }),
  },
  recordAdvanceRecovery: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/advances/${t.advanceId}/recoveries`,
      ifMatch: '"1"',
      body: { amount_vnd: '1', basis: 'REFUND', evidence_document_version_id: t.paymentDocumentVersionId },
    }),
  },
  // Matching a Treasury transaction to a payment, and the work on a difference.
  matchTreasuryTransaction: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/treasury-transactions/${t.treasuryTransactionId}/match`, body: { payment_request_id: t.paymentRequestId } }),
  },
  assignReconciliationItem: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/reconciliation-items/${t.reconciliationItemId}/assign`,
      ifMatch: '"1"',
      body: { owner_membership_id: t.paymentRequestId, due_at: '2030-01-01T00:00:00Z' },
    }),
  },
  // HUB-1: the Integration Hub; a caller who is refused switches nothing, records no run, opens or closes no incident, writes no snapshot, mapping, reject or agent.
  setHubConnectorState: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/connectors/treasury.statement/state', ifMatch: '"1"', body: { enabled: false, reason: REASON } }) },
  recordHubRun: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/connectors/treasury.statement/runs', body: { kind: 'IMPORT', outcome: 'SUCCEEDED', started_at: '2026-11-08T02:00:00Z', finished_at: '2026-11-08T02:01:00Z' } }) },
  openHubIncident: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/incidents', body: { connector_code: 'treasury.statement', summary: REASON } }) },
  decideHubIncident: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/integration-hub/incidents/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'ACKNOWLEDGE', reason: REASON } }) },
  captureHubSnapshot: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/snapshots', body: {} }) },
  proposeHubMapping: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/connectors/national.project_codes/mappings', body: { pipeline_code: 'PROJECT_CODES', mapping_version: 'M1', fields: [{ source: 'code', target: 'project_code', required: true, transform: { kind: 'UPPER' } }] } }) },
  decideHubMapping: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/integration-hub/mappings/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'APPROVE', reason: REASON } }) },
  decideHubReject: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/integration-hub/rejects/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'DISCARD', reason: REASON } }) },
  registerHubAgent: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/agents', body: { agent_code: 'matrix-agent-01', os: 'linux', cpu_arch: 'arm64', agent_version: '1.0.0', connectors: ['treasury.statement'] } }) },
  heartbeatHubAgent: { referencesTenantIds: false, build: () => ({ method: 'POST', path: '/integration-hub/agents/matrix-agent-01/heartbeat', body: { agent_version: '1.0.0', spool_depth: 0 } }) },
  resolveReconciliationItem: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/reconciliation-items/${t.reconciliationItemId}/resolve`, ifMatch: '"1"', body: { resolution: 'EXPLAINED', note: REASON } }),
  },
  // The handover of a work and its punch list: a caller that is refused drafts none, lists no defect, answers none, verifies none, waives none and decides none.
  createHandover: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/handovers',
      body: {
        project_id: t.contractProjectId,
        contract_id: t.draftContractId,
        recipient_unit_id: t.recipientMembershipId,
        handover_kind: 'COMPLETION',
        handover_no: REASON,
        quality_acceptance_id: t.draftContractId,
        document_version_id: t.documentVersionId,
      },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/handovers/${t.handoverId}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: REASON, evidence_ids: [], as_built_document_version_id: t.documentVersionId },
    }),
  },
  // The enforcement of a land recovery: a caller that is refused opens no case and advances none.
  startEnforcement: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/land-enforcement-cases',
      body: { project_id: t.projectId, parcel_id: t.legalHoldId, owner_unit_id: t.unit2, authority_unit_id: t.unit3, legal_basis: REASON, started_on: '2026-10-25' },
    }),
  },
  advanceEnforcement: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/land-enforcement-cases/${t.legalHoldId}/advance`, ifMatch: '"1"', body: { to_step: 'NOTICE' } }),
  },
  // The investment evaluation of a project: a caller that is refused plans, submits and decides nothing.
  planMneEvaluation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/mne-evaluations',
      body: {
        project_id: t.projectId,
        evaluation_kind: 'AD_HOC',
        evaluator_kind: 'INTERNAL',
        evaluator_name: 'MNE office',
        scope_text: 'The evaluation asked for by the test',
        planned_date: '2026-12-01',
      },
    }),
  },
  submitMneEvaluation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-evaluations/${t.legalHoldId}/submit`, ifMatch: '"1"', body: { findings: [], conclusion: 'SATISFACTORY', completed_date: '2026-10-30' } }),
  },
  decideMneEvaluation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/mne-evaluations/${t.legalHoldId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON } }),
  },
  // The testing of materials: a caller that is refused registers no sample and records no result.
  registerMaterialTest: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/material-tests',
      body: { contract_id: t.contractId, sample_code: 'MATRIX-1', material_kind: REASON, lab_name: REASON, standard_ref: REASON, sampled_on: '2026-10-25' },
    }),
  },
  recordMaterialTestResult: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/material-tests/${t.warrantyId}/result`,
      ifMatch: '"1"',
      body: { result: 'PASS', tested_on: '2026-10-25', result_values: {}, report_document_version_id: t.documentVersionId },
    }),
  },
  // The assets a work produces: a caller that is refused registers none and transfers none.
  registerAsset: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/asset-records',
      body: { project_id: t.contractProjectId, handover_id: t.handoverId, asset_code: REASON, name: REASON, recipient_unit_id: t.recipientMembershipId, value_vnd: '1', value_basis: 'CONTRACT_VALUE' },
    }),
  },
  transferAsset: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/asset-records/${t.assetId}/transfer`, ifMatch: '"1"', body: { transferred_on: '2026-10-25', commissioning_document_version_id: t.documentVersionId } }),
  },
  linkOmPlan: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/asset-records/${t.assetId}/om-link`, body: { operator_unit_id: t.recipientMembershipId } }),
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
    build: (t) => ({
      method: 'POST',
      path: `/compensation-payments/${t.planId}/confirm`,
      ifMatch: '"1"',
      body: { paid_on: '2026-10-20', method: 'BANK_TRANSFER', voucher_document_version_id: t.documentVersionId },
    }),
  },
  depositCompensationPayment: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/compensation-payments/${t.planId}/deposit`,
      ifMatch: '"1"',
      body: { deposit_reason: REASON, voucher_document_version_id: t.documentVersionId, paid_on: '2026-10-20' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/audit-recommendations/${t.legalHoldId}/actions`,
      ifMatch: '"1"',
      body: { action_code: 'A-MATRIX-1', description: 'Negative matrix action', planned_on: '2026-12-01' },
    }),
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
    build: (t) => ({
      method: 'POST',
      path: `/audit-recommendations/${t.legalHoldId}/dispute`,
      ifMatch: '"1"',
      body: { dispute_reason: 'Negative matrix dispute explanation of the owner', dispute_document_id: t.documentVersionId },
    }),
  },
  recordAuditDisputeDecision: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/audit-recommendations/${t.legalHoldId}/dispute-decision`,
      ifMatch: '"1"',
      body: { outcome: 'REJECTED_BY_AUTHORITY', authority_document_id: t.documentVersionId },
    }),
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
  allocateResettlement: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/resettlement-allocations',
      body: { household_id: t.householdId, plan_item_id: t.legalHoldId, owner_unit_id: t.unit2, unit_kind: 'PLOT', unit_code: 'PLOT-1', site_text: 'Resettlement site' },
    }),
  },
  fileLandComplaint: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/land-complaints',
      body: { project_id: t.projectId, household_id: t.householdId, owner_unit_id: t.unit2, channel: 'LETTER', subject: 'PRICE', description: REASON, filed_on: '2026-10-20' },
    }),
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
      body: {
        household_id: t.householdId,
        parcel_id: t.parcelId,
        item_kind: 'HOUSE',
        description: 'Matrix house',
        quantity: '1',
        unit_code: 'M2',
        unit_price_vnd: '1',
        price_decision_ref: 'QD-MATRIX',
        surveyed_on: '2026-06-20',
      },
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
  // The scorecard of a contractor: a caller that is refused evaluates, approves, records and confirms nothing.
  evaluateContractor: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/contracts/${t.contractId}/performance-evaluations`,
      body: { evaluation_kind: 'PERIODIC', period_label: '2026-Q3', score_quality: 80, score_schedule: 70, score_safety_env: 90, score_cooperation: 60, score_financial: 100 },
    }),
  },
  approveContractorEvaluation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/performance-evaluations/${t.evaluationId}/approve`, ifMatch: '"1"', body: {} }),
  },
  recordContractorViolation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contracts/${t.contractId}/violations`, body: { violation_kind: 'DELAY', severity: 'MAJOR', occurred_on: '2026-09-01', description: REASON } }),
  },
  confirmContractorViolation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/violations/${t.violationId}/confirm`, ifMatch: '"1"', body: { penalty_kind: 'NONE' } }),
  },
  // The export of the records of the contractors: a caller that is refused makes no file and writes down no receipt.
  exportContractorRecords: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/contractor-exports', body: { scope: 'BOTH', period_from: '2026-07-01', period_to: '2026-09-30', format: 'CSV' } }),
  },
  markContractorExportSubmitted: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contractor-exports/${t.exportBatchId}/mark-submitted`, body: { submitted_ref: 'MATRIX-0001', submitted_on: '2026-10-01' } }),
  },
  // The warranty of a work: a caller that is refused creates no obligation and closes none.
  createWarrantyObligation: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/warranty-obligations',
      body: { contract_id: t.contractId, handover_id: t.handoverId, scope_description: REASON, starts_on: '2026-10-25', period_months: 12, construction_grade: 'II', retention_amount_vnd: '1' },
    }),
  },
  closeWarrantyObligation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/warranty-obligations/${t.warrantyId}/close`, body: { note: REASON } }),
  },
  // The claims against a warranty: a caller that is refused files none, acknowledges none, records no repair and verifies none.
  fileWarrantyClaim: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/warranty-obligations/${t.warrantyId}/claims`,
      body: { claim_no: 'MATRIX-1', reported_on: '2026-10-25', defect_description: REASON, severity: 'MINOR', responder_contractor_id: t.contractorId },
    }),
  },
  acknowledgeWarrantyClaim: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/warranty-claims/${t.warrantyId}/acknowledge`, ifMatch: '"1"', body: { committed_fix_on: '2026-11-25' } }),
  },
  recordWarrantyFix: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/warranty-claims/${t.warrantyId}/fixed`,
      ifMatch: '"1"',
      body: { fixed_on: '2026-11-25', note: REASON, evidence_document_version_id: t.documentVersionId },
    }),
  },
  verifyWarrantyClaim: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/warranty-claims/${t.warrantyId}/verify`, ifMatch: '"1"', body: { outcome: 'VERIFIED', cost_borne_by: 'CONTRACTOR', note: REASON } }),
  },
  // The trigger of the evaluation after the investment: a caller that is refused sets none and acknowledges none.
  scheduleEvaluationTrigger: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/projects/${t.projectId}/evaluation-triggers`, body: { trigger_kind: 'MANUAL', due_on: '2999-01-01' } }),
  },
  acknowledgeEvaluationTrigger: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/evaluation-triggers/${t.legalHoldId}/acknowledge`, body: { mne_evaluation_id: t.legalHoldId } }),
  },
  // The non-conformances of the work: a caller that is refused raises none, assigns no action, answers none, verifies none, closes none and reopens none.
  raiseNonconformance: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/nonconformances',
      body: {
        contract_id: t.draftContractId,
        severity: 'MINOR',
        title: REASON,
        description: REASON,
        source_kind: 'SELF_REPORT',
        action_owner_id: t.recipientMembershipId,
        due_at: '2999-01-01T00:00:00Z',
      },
    }),
  },
  assignCorrectiveAction: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/nonconformances/${t.nonconformanceId}/corrective-actions`,
      ifMatch: '"1"',
      body: { description: REASON, owner_membership_id: t.recipientMembershipId, due_at: '2999-01-01T00:00:00Z' },
    }),
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
  generateSettlementForms: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/settlements/${t.settlementId}/forms`, body: { form_codes: ['01/QTDA'], place: REASON } }),
  },
  post_settlements_id_close: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/settlements/${t.settlementId}/close`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: REASON, evidence_ids: [], decision_document_version_id: t.paymentDocumentVersionId },
    }),
  },
  // Reversing a payment that was settled, against the refund the Treasury confirmed.
  reversePayment: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/payment-requests/${t.paymentRequestId}/reverse`,
      ifMatch: '"1"',
      body: { reason: REASON, approval_document_version_id: t.paymentDocumentVersionId, refund_treasury_transaction_id: t.treasuryTransactionId },
    }),
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
  // The payment integrity checks and the exceptions to the ceilings of disbursement (lane D, G4-2, G4-5): a caller that is refused checks nothing, asks for no exception and decides none.
  checkPaymentIntegrity: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/integrity-checks`, body: {} }),
  },
  requestDisbursementException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/payment-requests/${t.paymentRequestId}/disbursement-exceptions`, body: { ceiling: 'EXCEEDS_PLAN', allowed_amount_vnd: '1000', valid_to: '2099-12-31', reason: REASON } }),
  },
  approveDisbursementException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/disbursement-exceptions/${t.legalHoldId}/approve`, ifMatch: '"1"', body: {} }),
  },
  rejectDisbursementException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/disbursement-exceptions/${t.legalHoldId}/reject`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  revokeDisbursementException: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/disbursement-exceptions/${t.legalHoldId}/revoke`, ifMatch: '"1"', body: { reason: REASON } }),
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
      body: {
        kind: 'PERFORMANCE',
        issuer: 'Matrix bank',
        guarantee_no: 'MX-NEW-GUARANTEE',
        amount_vnd: '1000',
        valid_from: '2026-01-01',
        expires_at: '2099-01-01T00:00:00Z',
        document_version_id: t.documentVersionId,
      },
    }),
  },
  verifyGuarantee: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: `/guarantees/${t.guaranteeId}/verify`,
      ifMatch: '"1"',
      body: { outcome: 'VERIFIED', method: 'Matrix check', evidence_document_version_id: t.documentVersionId },
    }),
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
  createNotificationWorkflowDraft: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/notification-workflows', body: { event_type: 'matrix.notification', definition: {} } }),
  },
  post_notification_workflows_id_publish: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-workflows/${t.notificationWorkflowId}/publish`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  createCampaign: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/notification-campaigns',
      body: { name: 'Matrix campaign', purpose: 'ANNOUNCEMENT', template_version_id: t.notificationTemplateId, segment: { unit_ids: [t.unit2] } },
    }),
  },
  previewCampaignRecipients: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-campaigns/${t.campaignId}/preview`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  submitCampaign: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-campaigns/${t.campaignId}/submit`, ifMatch: '"1"', body: { preview_hash: 'a'.repeat(64) } }),
  },
  decideCampaign: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-campaigns/${t.campaignId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  cancelCampaign: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-campaigns/${t.campaignId}/cancel`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createContact: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/contacts', body: { display_name: 'Matrix contact', classification: 'CITIZEN' } }),
  },
  addContactIdentity: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contacts/${t.contactId}/identities`, body: { channel: 'EMAIL', external_id: 'matrix@example.com' } }),
  },
  verifyContactIdentity: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contacts/${t.contactId}/identities/${t.contactIdentityId}/verify`, ifMatch: '"1"', body: { method: 'ADMIN_DOCUMENT', document_ref: 'matrix-doc' } }),
  },
  recordContactConsent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contacts/${t.contactId}/consents`, body: { channel: 'EMAIL', purpose: 'REMINDER', consent_text_version: 'matrix-1', capture_method: 'IN_APP' } }),
  },
  withdrawContactConsent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/contact-consents/${t.contactConsentId}/withdraw`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  sendConversationMessage: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/messages`, ifMatch: '"1"', body: { kind: 'INTERNAL_NOTE', channel_account_id: t.conversationId, text: 'Matrix note' } }),
  },
  resolveConversation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/resolve`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  reopenConversation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/reopen`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  linkConversationResource: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/links`, ifMatch: '"1"', body: { resource_type: 'project', resource_id: t.conversationId } }),
  },
  convertConversationToIssue: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/issues`, ifMatch: '"1"', body: { project_id: t.conversationId, issue_type: 'MATRIX', summary: 'Matrix conversion' } }),
  },
  createRoutingPolicyVersion: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/conversation-routing-policies', body: { rules: [], calendar_code: 'MATRIX-CALENDAR', first_response_minutes: 30, resolution_hours: 24 } }),
  },
  publishRoutingPolicy: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversation-routing-policies/${t.routingPolicyId}/publish`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createCannedReply: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/canned-replies', body: { code: 'matrix.reply.new', title: 'Matrix', body_text: 'Matrix reply', channels: ['EMAIL'], classification: 'PUBLIC' } }),
  },
  updateCannedReply: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'PUT',
      path: `/canned-replies/${t.cannedReplyId}`,
      ifMatch: '"1"',
      body: { code: 'matrix.reply.fixture', title: 'Matrix', body_text: 'Matrix reply changed', channels: ['EMAIL'], classification: 'PUBLIC' },
    }),
  },
  assignConversation: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/conversations/${t.conversationId}/assign`, ifMatch: '"1"', body: { assignee_membership_id: t.recipientMembershipId } }),
  },
  mergeContacts: {
    referencesTenantIds: true,
    build: (t) => ({
      method: 'POST',
      path: '/contacts/merges',
      body: { survivor_contact_id: t.contactId, merged_contact_id: t.contactId, shared_verified_identity_id: t.contactIdentityId, reason: REASON },
    }),
  },
  setChannelLimits: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'PUT', path: `/channel-accounts/${t.channelAccountId}/limits`, ifMatch: '"1"', body: { daily_send_cap: 100, reason: REASON } }),
  },
  post_sync_batches: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/sync/batches',
      body: { device_id: '00000000-0000-4000-8000-0000000000a1', items: [{ idempotency_key: 'matrix-sync-key-000001', command_type: 'issue.create', base_server_version: 0, payload: {} }] },
    }),
  },
  post_sync_attachments: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/sync/attachments', body: { device_id: '00000000-0000-4000-8000-0000000000a1', sha256: 'a'.repeat(64), size_bytes: 1024, mime: 'image/jpeg' } }),
  },
  post_sync_attachments_id_complete: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/sync/attachments/00000000-0000-4000-8000-0000000000a2/complete', body: { sha256: 'a'.repeat(64) } }),
  },
  registerDevice: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/devices',
      body: { device_public_id: 'matrix-device-public-0001', platform: 'android', push_token: 'matrix-push-token', permission_state: 'granted', app_version: '1.0.0' },
    }),
  },
  connectChannelAccount: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/channel-accounts',
      body: { channel: 'WHATSAPP', external_account_id: 'matrix-account-0001', display_name: 'Matrix', credential_secret_ref: 'secret://matrix/token', webhook_secret_ref: 'secret://matrix/webhook' },
    }),
  },
  verifyChannelAccount: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/channel-accounts/${t.channelAccountId}/verify`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  updateChannelAccount: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'PUT', path: `/channel-accounts/${t.channelAccountId}`, ifMatch: '"1"', body: { display_name: 'Matrix renamed', reason: REASON } }),
  },
  disableChannelAccount: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/channel-accounts/${t.channelAccountId}/disable`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  createTemplateRevision: {
    referencesTenantIds: false,
    build: () => ({
      method: 'POST',
      path: '/notification-templates',
      body: { code: 'matrix.template', channel: 'EMAIL', locale: 'vi-VN', purpose: 'OPERATIONAL', content_ast: { body: 'Hello' }, variable_schema: {} },
    }),
  },
  submitTemplateRevision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-templates/${t.notificationTemplateId}/submit`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  decideTemplateRevision: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-templates/${t.notificationTemplateId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: REASON, evidence_ids: [] } }),
  },
  sendTestNotification: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/notification-templates/${t.notificationTemplateId}/test-sends`, body: { test_recipient_ids: [t.recipientMembershipId], sample_variables: {} } }),
  },
  setNotificationTestRecipients: {
    referencesTenantIds: false,
    build: () => ({ method: 'PUT', path: '/notification-test-recipients', body: { membership_ids: [] } }),
  },
  updateMyNotificationPreferences: {
    referencesTenantIds: false,
    build: () => ({
      method: 'PUT',
      path: '/me/notification-preferences',
      ifMatch: '"0"',
      body: { items: [{ event_category: 'report', channel: 'SMS', enabled: false }], quiet_start: '22:00', quiet_end: '06:00' },
    }),
  },
  grantMyConsent: {
    referencesTenantIds: false,
    build: () => ({ method: 'POST', path: '/me/consents', body: { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', consent_text_version: 'matrix-1', capture_method: 'IN_APP' } }),
  },
  withdrawMyConsent: {
    referencesTenantIds: true,
    build: (t) => ({ method: 'POST', path: `/me/consents/${t.consentId}/withdraw`, ifMatch: '"1"', body: { reason: REASON } }),
  },
  // GOV-8: the claim register and the early-warning register of a contract; a caller who is refused changes nothing.
  proposeClaimTerm: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contracts/00000000-0000-4000-8000-0000000000f1/claim-terms', body: { claimant_side: 'CONTRACTOR', notice_days: 28, clause_reference: 'Clause 20.1' } }) },
  decideClaimTerm: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/claim-terms/00000000-0000-4000-8000-0000000000f1/decision', ifMatch: '"1"', body: { decision: 'APPROVE' } }) },
  registerClaim: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contracts/00000000-0000-4000-8000-0000000000f1/claims', body: { claimant_side: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: 'Matrix claim', event_description: REASON, event_on: '2026-01-02', awareness_on: '2026-01-03' } }) },
  recordClaimStep: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/claims/00000000-0000-4000-8000-0000000000f1/steps', ifMatch: '"1"', body: { kind: 'NOTICE', occurred_on: '2026-01-04', note: REASON } }) },
  decideClaimSettlement: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/claims/00000000-0000-4000-8000-0000000000f1/settlement-decision', ifMatch: '"1"', body: { decision: 'APPROVE', note: REASON } }) },
  declareClaimBar: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/claims/00000000-0000-4000-8000-0000000000f1/bar', ifMatch: '"1"', body: { reason: REASON } }) },
  linkClaim: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/claims/00000000-0000-4000-8000-0000000000f1/links', ifMatch: '"1"', body: { change_request_id: '00000000-0000-4000-8000-0000000000f1' } }) },
  raiseContractEarlyWarning: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contracts/00000000-0000-4000-8000-0000000000f1/early-warnings', body: { title: 'Matrix warning', description: REASON, category: 'TIME', raised_by_party: 'CONTRACTOR', raised_on: '2026-01-02' } }) },
  assessContractEarlyWarning: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contract-early-warnings/00000000-0000-4000-8000-0000000000f1/assessment', ifMatch: '"1"', body: { owner_membership_id: '00000000-0000-4000-8000-0000000000f1', likelihood: 'LOW', expected_time_days: 1 } }) },
  addContractEarlyWarningAction: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contract-early-warnings/00000000-0000-4000-8000-0000000000f1/actions', body: { description: REASON, owner_membership_id: '00000000-0000-4000-8000-0000000000f1', due_on: '2030-01-02' } }) },
  completeContractEarlyWarningAction: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contract-early-warning-actions/00000000-0000-4000-8000-0000000000f1/completion', ifMatch: '"1"', body: { outcome: 'DONE', note: REASON } }) },
  closeContractEarlyWarning: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contract-early-warnings/00000000-0000-4000-8000-0000000000f1/closure', ifMatch: '"1"', body: { outcome: 'WITHDRAWN', reason: REASON } }) },
  recordContractEarlyWarningMeeting: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contracts/00000000-0000-4000-8000-0000000000f1/early-warning-meetings', body: { held_on: '2026-01-02', attendees: REASON, reviews: [] } }) },
  issueContractEarlyWarningRegister: { referencesTenantIds: true, build: () => ({ method: 'POST', path: '/contracts/00000000-0000-4000-8000-0000000000f1/early-warning-issues', body: {} }) },
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
