import { signTenantContext } from '@machvon/kernel';
import type { OpenApiDocument } from '@machvon/contracts';
import { fillPath, operationPath } from '../endpoint-enumerator';
import { randomUUID } from 'node:crypto';
import { CLAIMS_HEADER, TENANT_HEADER } from '../test-auth.guard';
import { AUDIT_EVENT_FIXTURES, CERTIFICATE_FIXTURES, CONSENT_FIXTURES, DELIVERY_ATTEMPT_FIXTURES, DOCUMENT_FIXTURES, GRANT_FIXTURES, LEGAL_HOLD_FIXTURES, MASTER_FIXTURES, MASTER_IMPORT_FIXTURES, CROSSWALK_FIXTURES, SLA_POLICY_FIXTURES, DATASET_FIXTURES, GLOSSARY_FIXTURES, MEMBERSHIP_FIXTURES, NOTIFICATION_FIXTURES, POLICY_FIXTURES, ROLE_FIXTURES, TENANT_IDS, UNIT_FIXTURES } from '../suite';
import { WORK_CALENDAR_FIXTURES } from '../suite';
import { ACCOUNTABILITY_FIXTURES, APPRAISAL_FIXTURES, CONCLUSION_FIXTURES, ENGAGEMENT_FIXTURES, ESCALATION_FIXTURES, COMPLAINT_FIXTURES, HOUSEHOLD_FIXTURES, INVENTORY_FIXTURES, ISSUE_FIXTURES, PAYMENT_COMP_FIXTURES, PLAN_COMP_FIXTURES, PACKAGE_FIXTURES, PARCEL_FIXTURES, PROJECT_FIXTURES, PETITION_FIXTURES, PROPOSAL_FIXTURES, RESULT_FIXTURES, SECTION_FIXTURES } from '../suite';
import { CONTRACTOR_FIXTURES } from '../suite';
import { ACCEPTANCE_FIXTURES, ADVANCE_FIXTURES, BOQ_FIXTURES, CHANGE_FIXTURES, CONTRACT_FIXTURES, GUARANTEE_FIXTURES, CRITERIA_FIXTURES, HANDOVER_FIXTURES, INSPECTION_FIXTURES, MEASUREMENT_FIXTURES, NONCONFORMANCE_FIXTURES, PAYMENT_FIXTURES, PROCUREMENT_PLAN_FIXTURES, WORK_ACCEPTANCE_FIXTURES } from '../suite';
import { TEMPLATE_FIXTURES } from '../suite';
import { QUALITY_FIXTURES } from '../suite';
import { MNE_FIXTURES } from '../suite';
import { PERMIT_FIXTURES, PERMIT_TYPE_FIXTURES } from '../suite';
import { WAIVER_FIXTURES } from '../suite';
import { DOA_FIXTURES } from '../suite';
import { RETENTION_FIXTURES } from '../suite';
import { AVC_POLICY_FIXTURES, EXTENSION_FIXTURES } from '../suite';
import { INTEGRATION_FIXTURES } from '../suite';
import { APPROPRIATION_FIXTURES } from '../suite';
import { CAPITAL_PLAN_FIXTURES } from '../suite';
import { EARLY_WARNING_FIXTURES, EXPLANATION_FIXTURES, TRANSFER_FIXTURES, PERIOD_FIXTURES, PERIOD_SNAPSHOT_FIXTURES, REPORT_EXPORT_FIXTURES, REPORT_FIXTURES, REPORT_IMPORT_FIXTURES } from '../suite';
import { REOPEN_FIXTURES } from '../suite';
import { RECONCILIATION_FIXTURES, SETTLEMENT_FIXTURES, SUBSCRIPTION_FIXTURES, TREASURY_FIXTURES, USAGE_FIXTURES } from '../suite';
import type { ForeignAttempt, IsolationChannel, TenantName } from '../suite';
import { contextOf, seedTenantAuthz, seedTenantUnits } from './database';

export const GET_UNIT_OPERATION = 'get_resources_organization_unit_id';
export const LIST_UNITS_OPERATION = 'get_resources_organization_unit';

/** A request of a TNT-A user against a TNT-B object: the registered foreign-id case of one id-bearing operation. */
export interface ForeignAttemptSpec {
  operation: string;
  method: 'GET' | 'PUT' | 'POST';
  /** The TNT-B object the path names. */
  id: string;
  /** A query string the operation asks for, so the request reaches the handler's own lookup (the reason of a reading). */
  query?: string;
  /** Needs `If-Match` (the command is versioned). */
  versioned?: boolean;
  /** A body that is valid for the operation, so the request reaches the handler's own lookup. */
  body?: unknown;
  /** 403 for a control-plane operation (a tenant-plane token is refused by plane before any lookup); 404 where the route is not registered. */
  expectedStatuses?: readonly number[];
}

const FOREIGN_UNIT = UNIT_FIXTURES['TNT-B'][0]?.id ?? '';
const OWN_UNIT = UNIT_FIXTURES['TNT-A'][0]?.id ?? '';

/** Every id-bearing operation beyond the unit read: reads of role grants and all commands that name an object in the path. */
export const FOREIGN_ATTEMPT_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'get_resources_membership_id', method: 'GET', id: MEMBERSHIP_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_role_grant_id', method: 'GET', id: GRANT_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_role_definition_id', method: 'GET', id: ROLE_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_notification_instance_id', method: 'GET', id: NOTIFICATION_FIXTURES['TNT-B'].id },
  { operation: 'markNotificationRead', method: 'POST', id: NOTIFICATION_FIXTURES['TNT-B'].id, body: { opened_via: 'IN_APP' } },
  { operation: 'acknowledgeNotification', method: 'POST', id: NOTIFICATION_FIXTURES['TNT-B'].id, body: {} },
  { operation: 'get_resources_delivery_attempt_id', method: 'GET', id: DELIVERY_ATTEMPT_FIXTURES['TNT-B'].id },
  { operation: 'post_notifications_id_replay', method: 'POST', id: NOTIFICATION_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign replay attempt', evidence_ids: [] } },
  { operation: 'cancelNotification', method: 'POST', id: NOTIFICATION_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancel attempt' } },
  { operation: 'withdrawMyConsent', method: 'POST', id: CONSENT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign withdrawal attempt' } },
  { operation: 'get_resources_contact_consent_id', method: 'GET', id: CONSENT_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_audit_event_id', method: 'GET', id: AUDIT_EVENT_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_legal_hold_id', method: 'GET', id: LEGAL_HOLD_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_signing_certificate_id', method: 'GET', id: CERTIFICATE_FIXTURES['TNT-B'].id },
  { operation: 'revokeSigningCertificate', method: 'POST', id: CERTIFICATE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign revoke attempt' } },
  { operation: 'get_resources_security_policy_version_id', method: 'GET', id: POLICY_FIXTURES['TNT-B'].id },
  { operation: 'publishSecurityPolicy', method: 'POST', id: POLICY_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign publish attempt' } },
  {
    operation: 'updateDoaMatrixDraft',
    method: 'PUT',
    id: DOA_FIXTURES['TNT-B'].id,
    versioned: true,
    body: {
      effective_from: '2026-01-01',
      legal_basis_ref: 'Isolation foreign update attempt',
      rules: [{ document_type: 'ISOLATION', unit_id: FOREIGN_UNIT, amount_min_vnd: '0', approver_role_id: ROLE_FIXTURES['TNT-B'].id }],
    },
  },
  { operation: 'submitDoaMatrix', method: 'POST', id: DOA_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign submit attempt' } },
  { operation: 'decideDoaMatrix', method: 'POST', id: DOA_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision', evidence_ids: [] } },
  { operation: 'get_resources_work_calendar_version_id', method: 'GET', id: WORK_CALENDAR_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_doa_matrix_version_id', method: 'GET', id: DOA_FIXTURES['TNT-B'].id },
  { operation: 'publishWorkCalendar', method: 'POST', id: WORK_CALENDAR_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign publish attempt' } },
  { operation: 'get_resources_data_retention_policy_id', method: 'GET', id: RETENTION_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_retention_review_item_id', method: 'GET', id: RETENTION_FIXTURES['TNT-B'].reviewId },
  { operation: 'get_resources_integration_connector_id', method: 'GET', id: INTEGRATION_FIXTURES['TNT-B'].connectorId },
  { operation: 'get_resources_integration_event_inbox_id', method: 'GET', id: INTEGRATION_FIXTURES['TNT-B'].eventId },
  { operation: 'releaseLegalHold', method: 'POST', id: LEGAL_HOLD_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign release attempt' } },
  { operation: 'publishRetentionPolicy', method: 'POST', id: RETENTION_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign publish attempt' } },
  { operation: 'updateIntegrationConnector', method: 'PUT', id: INTEGRATION_FIXTURES['TNT-B'].connectorId, versioned: true, body: { reason: 'Isolation foreign update attempt', status: 'Disabled' } },
  { operation: 'replayInboxEvent', method: 'POST', id: INTEGRATION_FIXTURES['TNT-B'].eventId, versioned: true, body: { reason: 'Isolation foreign replay attempt' } },
  { operation: 'get_resources_document_version_id', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  { operation: 'getDocumentVersionDownload', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  { operation: 'getDocumentSignatureReport', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  { operation: 'verifyDocumentSignatures', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].versionId, body: {} },
  { operation: 'listDocumentRegisterEntries', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].registerId },
  {
    operation: 'closeDocumentNumberRegister',
    method: 'POST',
    id: DOCUMENT_FIXTURES['TNT-B'].registerId,
    versioned: true,
    body: { reason: 'Isolation foreign close attempt' },
  },
  { operation: 'getOutgoingDocument', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId },
  { operation: 'startLeaderSigning', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: {} },
  { operation: 'completeSigningSession', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].sessionId, versioned: true, body: {} },
  {
    operation: 'assignOutgoingDocumentNumber',
    method: 'POST',
    id: DOCUMENT_FIXTURES['TNT-B'].outgoingId,
    versioned: true,
    body: { register_id: DOCUMENT_FIXTURES['TNT-B'].registerId },
  },
  { operation: 'startOrganizationSeal', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: {} },
  { operation: 'updateOutgoingDocumentDraft', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: { title: 'Isolation foreign edit attempt' } },
  { operation: 'submitOutgoingDocumentForReview', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: {} },
  { operation: 'decideOutgoingDocumentReview', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: { decision: 'RETURN', comment: 'Isolation foreign decision attempt' } },
  { operation: 'returnOutgoingDocument', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: { reason: 'Isolation foreign return attempt' } },
  {
    operation: 'cancelOutgoingDocument',
    method: 'POST',
    id: DOCUMENT_FIXTURES['TNT-B'].outgoingId,
    versioned: true,
    body: { reason: 'Isolation foreign cancel attempt', reject_code: 'CANCELLED_BY_DRAFTER' },
  },
  { operation: 'getDocumentTimeline', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  { operation: 'resolveDocumentReference', method: 'GET', id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  {
    operation: 'uploadLeaderSignedDocument',
    method: 'POST',
    id: DOCUMENT_FIXTURES['TNT-B'].outgoingId,
    versioned: true,
    body: { file_object_key: DOCUMENT_FIXTURES['TNT-B'].objectKey, file_sha256: 'a'.repeat(64) },
  },
  { operation: 'issueOutgoingDocument', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: {} },
  { operation: 'dispatchOutgoingDocument', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: { recipients: [{ name: 'Isolation foreign recipient', channel: 'PAPER_HANDOVER' }] } },
  { operation: 'recordDistributionAcknowledgement', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].distributionId, versioned: true, body: { acknowledged_at: '2026-01-02T00:00:00Z' } },
  { operation: 'retryDocumentDistribution', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].distributionId, versioned: true, body: {} },
  { operation: 'publishAvcPolicy', method: 'POST', id: AVC_POLICY_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'previewAvcPolicy', method: 'GET', id: AVC_POLICY_FIXTURES['TNT-B'].id },
  { operation: 'requestAllocationExtension', method: 'POST', id: CAPITAL_PLAN_FIXTURES['TNT-B'].lineId, body: { amount_vnd: '100', extended_to: '2027-03-31', reason_code: 'GPMB_CHAM' } },
  { operation: 'decideAllocationExtension', method: 'POST', id: EXTENSION_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'reject', reason: 'Isolation foreign decision' } },
  { operation: 'recallOutgoingDocument', method: 'POST', id: DOCUMENT_FIXTURES['TNT-B'].outgoingId, versioned: true, body: { reason: 'Isolation foreign recall attempt' } },
  {
    operation: 'voidOutgoingDocumentNumber',
    method: 'POST',
    id: DOCUMENT_FIXTURES['TNT-B'].outgoingId,
    versioned: true,
    body: { reason: 'Isolation foreign void attempt', approver_user_id: '00000000-0000-4000-8000-000000000002' },
  },
  { operation: 'getMasterChangeRequest', method: 'GET', id: MASTER_FIXTURES['TNT-B'].changeId },
  { operation: 'getMasterRecordUsages', method: 'GET', id: MASTER_FIXTURES['TNT-B'].recordId },
  { operation: 'getMasterRecordAsOf', method: 'GET', id: MASTER_FIXTURES['TNT-B'].recordId },
  { operation: 'getMasterRecordSuccessors', method: 'GET', id: MASTER_FIXTURES['TNT-B'].recordId },
  { operation: 'get_resources_master_record_version_id', method: 'GET', id: MASTER_FIXTURES['TNT-B'].versionId },
  { operation: 'submitMasterChangeRequest', method: 'POST', id: MASTER_FIXTURES['TNT-B'].changeId, versioned: true, body: {} },
  { operation: 'decideMasterChangeRequest', method: 'POST', id: MASTER_FIXTURES['TNT-B'].changeId, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  { operation: 'post_master_records_id_publish', method: 'POST', id: MASTER_FIXTURES['TNT-B'].recordId, versioned: true, body: { decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'getMasterImport', method: 'GET', id: MASTER_IMPORT_FIXTURES['TNT-B'].id },
  { operation: 'applyMasterImport', method: 'POST', id: MASTER_IMPORT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'decideMasterImport', method: 'POST', id: MASTER_IMPORT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  { operation: 'publishMasterImport', method: 'POST', id: MASTER_IMPORT_FIXTURES['TNT-B'].id, versioned: true, body: { decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'retireMasterCrosswalk', method: 'POST', id: CROSSWALK_FIXTURES['TNT-B'].crosswalkId, versioned: true, body: { reason: 'Isolation foreign retire' } },
  { operation: 'resetIntegrationCursor', method: 'POST', id: CROSSWALK_FIXTURES['TNT-B'].cursorId, versioned: true, body: { reason: 'Isolation foreign reset', cursor_json: {} } },
  { operation: 'get_resources_integration_cursor_id', method: 'GET', id: CROSSWALK_FIXTURES['TNT-B'].cursorId },
  { operation: 'getTreasuryImport', method: 'GET', id: TREASURY_FIXTURES['TNT-B'].importId },
  { operation: 'get_resources_treasury_transaction_id', method: 'GET', id: TREASURY_FIXTURES['TNT-B'].transactionId },
  { operation: 'get_resources_usage_meter_event_id', method: 'GET', id: USAGE_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_subscription_id', method: 'GET', id: SUBSCRIPTION_FIXTURES['TNT-B'].id },
  { operation: 'getDocumentTemplate', method: 'GET', id: TEMPLATE_FIXTURES['TNT-B'].id },
  { operation: 'publishDocumentTemplate', method: 'POST', id: TEMPLATE_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  {
    operation: 'confirmDocumentTemplateLegalBasis',
    method: 'POST',
    id: TEMPLATE_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { legal_confirmation_ref: 'CXN-ISOLATION', evidence_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  },
  { operation: 'retireDocumentTemplate', method: 'POST', id: TEMPLATE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign retire attempt' } },
  { operation: 'softCloseReportingPeriod', method: 'POST', id: PERIOD_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign soft close' } },
  { operation: 'lockReportingPeriod', method: 'POST', id: PERIOD_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign lock' } },
  { operation: 'get_resources_reporting_period_id', method: 'GET', id: PERIOD_FIXTURES['TNT-B'].id },
  { operation: 'post_reports_id_submit', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'post_reports_id_decision', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision', evidence_ids: [] } },
  { operation: 'post_reports_id_corrections', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: { amendment_reason: 'Isolation foreign correction' } },
  { operation: 'withdrawReport', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign withdrawal attempt.' } },
  { operation: 'deleteDraftReport', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign deletion' } },
  { operation: 'restoreDraftReport', method: 'POST', id: REPORT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  {
    operation: 'post_reports_id_revisions',
    method: 'POST',
    id: REPORT_FIXTURES['TNT-B'].id,
    versioned: true,
    body: {
      project_id: PROJECT_FIXTURES['TNT-B'].id,
      period_id: PERIOD_FIXTURES['TNT-B'].id,
      plan_version_id: '00000000-0000-4000-b0bb-0000000000fa',
      measurement_basis: 'YTD',
      funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1000' }],
    },
  },
  { operation: 'getReportRevision', method: 'GET', id: REPORT_FIXTURES['TNT-B'].id },
  { operation: 'getReportImport', method: 'GET', id: REPORT_IMPORT_FIXTURES['TNT-B'].id },
  { operation: 'applyReportImport', method: 'POST', id: REPORT_IMPORT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'getReportExportDownload', method: 'GET', id: REPORT_EXPORT_FIXTURES['TNT-B'].id },
  { operation: 'getSubmissionProgress', method: 'GET', id: PERIOD_FIXTURES['TNT-B'].id },
  { operation: 'listPeriodSnapshotLines', method: 'GET', id: PERIOD_SNAPSHOT_FIXTURES['TNT-B'].id },
  { operation: 'freezePeriodSnapshot', method: 'POST', id: PERIOD_SNAPSHOT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'publishEarlyWarningRule', method: 'POST', id: EARLY_WARNING_FIXTURES['TNT-B'].ruleId, versioned: true, body: {} },
  { operation: 'acknowledgeEarlyWarning', method: 'POST', id: EARLY_WARNING_FIXTURES['TNT-B'].warningId, versioned: true, body: { reason: 'Isolation foreign acknowledgement' } },
  { operation: 'dismissEarlyWarning', method: 'POST', id: EARLY_WARNING_FIXTURES['TNT-B'].warningId, versioned: true, body: { reason: 'Isolation foreign dismissal' } },
  { operation: 'submitExplanation', method: 'POST', id: EXPLANATION_FIXTURES['TNT-B'].id, versioned: true, body: { response_text: 'Isolation foreign answer to a request of another tenant' } },
  { operation: 'requestProjectTransfer', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { to_unit_id: (UNIT_FIXTURES['TNT-B'][1]?.id ?? ''), transfer_scope: 'OWNER_UNIT', effective_date: '2099-01-01', reason: 'Isolation foreign transfer attempt' } },
  { operation: 'getProjectTransferImpact', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id, query: `to_unit_id=${UNIT_FIXTURES['TNT-B'][1]?.id ?? ''}&transfer_scope=OWNER_UNIT` },
  { operation: 'decideProjectTransfer', method: 'POST', id: TRANSFER_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  { operation: 'reviewExplanation', method: 'POST', id: EXPLANATION_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'ACCEPTED', review_note: 'Isolation foreign conclusion' } },
  { operation: 'get_resources_report_revision_id', method: 'GET', id: REPORT_FIXTURES['TNT-B'].id },
  { operation: 'requestPeriodReopen', method: 'POST', id: REOPEN_FIXTURES['TNT-B'].periodId, body: { scope_kind: 'PERIOD', reason: 'Isolation foreign reopen request attempt', window_hours: 24 } },
  { operation: 'decidePeriodReopen', method: 'POST', id: REOPEN_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision', window_hours: 24 } },
  { operation: 'retireIssueSlaPolicy', method: 'POST', id: SLA_POLICY_FIXTURES['TNT-B'].id, body: { valid_until: '2999-12-31' } },
  { operation: 'get_resources_issue_id', method: 'GET', id: ISSUE_FIXTURES['TNT-B'].id },
  { operation: 'listIssueAssignees', method: 'GET', id: ISSUE_FIXTURES['TNT-B'].id },
  { operation: 'assignIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { assignee_id: '00000000-0000-4000-8000-0000000000f1' } },
  { operation: 'startIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'commentIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, body: { note: 'Isolation foreign comment attempt' } },
  { operation: 'transferIssueUnit', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { target_unit_id: OWN_UNIT, reason: 'Isolation foreign transfer attempt' } },
  { operation: 'requestIssueVerification', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { result_note: 'Isolation foreign verification attempt', evidence_document_version_ids: [] } },
  { operation: 'closeIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { verification_note: 'Isolation foreign close attempt' } },
  { operation: 'reopenIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign reopen attempt' } },
  { operation: 'escalateIssue', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { level: 1, reason: 'Isolation foreign escalation attempt' } },
  { operation: 'acceptIssueEscalation', method: 'POST', id: ESCALATION_FIXTURES['TNT-B'].id, body: { note: 'Isolation foreign acceptance attempt' } },
  { operation: 'extendIssueDeadline', method: 'POST', id: ISSUE_FIXTURES['TNT-B'].id, versioned: true, body: { new_due_at: '2999-01-01T00:00:00.000Z', reason: 'Isolation foreign extension attempt' } },
  { operation: 'get_resources_permit_type_id', method: 'GET', id: PERMIT_TYPE_FIXTURES['TNT-B'].id },
  { operation: 'retirePermitType', method: 'POST', id: PERMIT_TYPE_FIXTURES['TNT-B'].id, body: { effective_until: '2999-12-31' } },
  { operation: 'retirePermitGateRule', method: 'POST', id: PERMIT_TYPE_FIXTURES['TNT-B'].gateRuleId, body: { effective_until: '2999-12-31' } },
  { operation: 'revokePermitGateWaiver', method: 'POST', id: WAIVER_FIXTURES['TNT-B'].id, body: { reason: 'Isolation foreign revocation attempt' } },
  { operation: 'evaluatePermitGates', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id },
  { operation: 'createPermitDossier', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, body: { owner_unit_id: OWN_UNIT } },
  { operation: 'addPermit', method: 'POST', id: PERMIT_FIXTURES['TNT-B'].dossierId, body: { permit_type_id: PERMIT_TYPE_FIXTURES['TNT-B'].id } },
  { operation: 'recordPermitMilestone', method: 'POST', id: PERMIT_FIXTURES['TNT-B'].permitId, versioned: true, body: { step_code: 'APPRAISAL_MEETING', planned_on: '2999-01-01' } },
  { operation: 'recordPermitDecision', method: 'POST', id: PERMIT_FIXTURES['TNT-B'].permitId, versioned: true, body: { outcome: 'REJECTED', reason: 'Isolation foreign decision' } },
  {
    operation: 'renewPermit',
    method: 'POST',
    id: PERMIT_FIXTURES['TNT-B'].permitId,
    versioned: true,
    body: { new_permit_no: 'ISOLATION-FOREIGN', new_valid_until: '2999-12-31', document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  {
    operation: 'revokePermit',
    method: 'POST',
    id: PERMIT_FIXTURES['TNT-B'].permitId,
    versioned: true,
    body: { reason: 'Isolation foreign revoke', decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  {
    operation: 'declarePermitExemption',
    method: 'POST',
    id: PERMIT_FIXTURES['TNT-B'].permitId,
    versioned: true,
    body: { exemption_basis: 'Isolation foreign exemption', exemption_decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  { operation: 'get_resources_permit_dossier_id', method: 'GET', id: PERMIT_FIXTURES['TNT-B'].dossierId },
  { operation: 'get_resources_permit_id', method: 'GET', id: PERMIT_FIXTURES['TNT-B'].permitId },
  { operation: 'approveQualityRuleVersion', method: 'POST', id: QUALITY_FIXTURES['TNT-B'].ruleId, versioned: true, body: {} },
  { operation: 'getQualityScorecard', method: 'GET', id: DATASET_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_quality_rule_version_id', method: 'GET', id: QUALITY_FIXTURES['TNT-B'].ruleId },
  { operation: 'get_resources_quality_run_id', method: 'GET', id: QUALITY_FIXTURES['TNT-B'].runId },
  {
    operation: 'assignDatasetOwnership',
    method: 'POST',
    id: DATASET_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { owner_user_id: '00000000-0000-4000-8000-0000000000f1', steward_user_id: '00000000-0000-4000-8000-0000000000f1', reason: 'Isolation foreign ownership change' },
  },
  { operation: 'submitGlossaryTerm', method: 'POST', id: GLOSSARY_FIXTURES['TNT-B'].termId, versioned: true, body: {} },
  { operation: 'decideGlossaryTerm', method: 'POST', id: GLOSSARY_FIXTURES['TNT-B'].termId, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  { operation: 'publishGlossaryTerm', method: 'POST', id: GLOSSARY_FIXTURES['TNT-B'].termId, versioned: true, body: {} },
  { operation: 'get_resources_project_id', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id },
  { operation: 'decideAppropriation', method: 'POST', id: APPROPRIATION_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  {
    operation: 'draftCapitalAllocation',
    method: 'POST',
    id: CAPITAL_PLAN_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { lines: [{ project_id: PROJECT_FIXTURES['TNT-B'].id, appropriation_id: APPROPRIATION_FIXTURES['TNT-B'].id, bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: '100' }] },
  },
  { operation: 'submitCapitalPlan', method: 'POST', id: CAPITAL_PLAN_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'createCapitalPlanRevision', method: 'POST', id: CAPITAL_PLAN_FIXTURES['TNT-B'].publishedId, versioned: true, body: { reason: 'Isolation foreign revision' } },
  { operation: 'getCapitalPlanAsOf', method: 'GET', id: CAPITAL_PLAN_FIXTURES['TNT-B'].publishedId },
  { operation: 'decideCapitalPlan', method: 'POST', id: CAPITAL_PLAN_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision' } },
  { operation: 'post_plans_id_publish', method: 'POST', id: CAPITAL_PLAN_FIXTURES['TNT-B'].id, versioned: true, body: { decision_document_id: '00000000-0000-4000-b0f2-0000000000ff' } },
  { operation: 'listCapitalPlanLines', method: 'GET', id: CAPITAL_PLAN_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_plan_version_id', method: 'GET', id: CAPITAL_PLAN_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_allocation_line_id', method: 'GET', id: CAPITAL_PLAN_FIXTURES['TNT-B'].lineId },
  { operation: 'publishMneForm', method: 'POST', id: MNE_FIXTURES['TNT-B'].formId, versioned: true, body: {} },
  { operation: 'publishMneObligationRule', method: 'POST', id: MNE_FIXTURES['TNT-B'].ruleId, versioned: true, body: {} },
  { operation: 'get_resources_contractor_id', method: 'GET', id: CONTRACTOR_FIXTURES['TNT-B'].id },
  { operation: 'submitProcurementPlan', method: 'POST', id: PROCUREMENT_PLAN_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'decideProcurementPlan', method: 'POST', id: PROCUREMENT_PLAN_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'RETURN', comment: 'Isolation foreign decision attempt' } },
  { operation: 'get_resources_procurement_package_id', method: 'GET', id: PROCUREMENT_PLAN_FIXTURES['TNT-B'].packageId },
  { operation: 'approveCriteriaVersion', method: 'POST', id: CRITERIA_FIXTURES['TNT-B'].draftId, versioned: true, body: {} },
  { operation: 'get_resources_criteria_version_id', method: 'GET', id: CRITERIA_FIXTURES['TNT-B'].approvedId },
  { operation: 'get_resources_contract_id', method: 'GET', id: CONTRACT_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_contract_revision_id', method: 'GET', id: CONTRACT_FIXTURES['TNT-B'].revisionId },
  { operation: 'reviseContractDraft', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { title: 'Isolation foreign rename attempt' } },
  {
    operation: 'replaceContractParties',
    method: 'POST',
    id: CONTRACT_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { parties: [{ contractor_id: CONTRACTOR_FIXTURES['TNT-B'].id, role: 'LEAD', share_pct: '60', work_value_vnd: '600' }, { contractor_id: CONTRACTOR_FIXTURES['TNT-A'].id, role: 'MEMBER', share_pct: '40', work_value_vnd: '400' }] },
  },
  { operation: 'cancelContractDraft', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancel attempt' } },
  { operation: 'submitContractForReview', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { note: 'Isolation foreign review attempt' } },
  { operation: 'returnContractDraft', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign return attempt' } },
  { operation: 'recordContractSigning', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { signed_on: '2026-10-25', signed_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId } },
  { operation: 'post_contracts_id_activate', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign activation attempt', evidence_ids: [], effective_from: '2026-10-25' } },
  { operation: 'getContractSummary', method: 'GET', id: CONTRACT_FIXTURES['TNT-B'].id },
  { operation: 'getCumulativeLedger', method: 'GET', id: CONTRACT_FIXTURES['TNT-B'].id },
  { operation: 'releaseRetention', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].holdId, versioned: true, body: { amount_vnd: '1', reason: 'Isolation foreign release attempt' } },
  { operation: 'listRetentionHolds', method: 'GET', id: CONTRACT_FIXTURES['TNT-B'].id },
  { operation: 'revisePaymentDraft', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { request_no: 'Isolation foreign revision attempt' } },
  { operation: 'attachPaymentDocument', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, body: { document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId, doc_kind: 'OTHER' } },
  { operation: 'cancelPaymentRequest', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancellation attempt' } },
  { operation: 'post_payment_requests_id_submit', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { expected_gross_vnd: '1', expected_net_vnd: '1' } },
  { operation: 'verifyPaymentRequest', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { note: 'Isolation foreign check attempt' } },
  { operation: 'returnPaymentRequest', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign return attempt' } },
  { operation: 'generatePaymentForms', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, body: { form_codes: ['03.a/TT'], place: 'Isolation foreign forms attempt' } },
  { operation: 'markPaymentSentToTreasury', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { treasury_submitted_on: '2026-10-25', form_instance_ids: [PAYMENT_FIXTURES['TNT-B'].id] } },
  { operation: 'listPaymentForms', method: 'GET', id: PAYMENT_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_payment_request_id', method: 'GET', id: PAYMENT_FIXTURES['TNT-B'].id },
  { operation: 'cancelAdvance', method: 'POST', id: ADVANCE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancellation attempt' } },
  { operation: 'recordAdvanceRecovery', method: 'POST', id: ADVANCE_FIXTURES['TNT-B'].id, versioned: true, body: { amount_vnd: '1', basis: 'REFUND', evidence_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'getAdvanceRecoveryPlan', method: 'GET', id: ADVANCE_FIXTURES['TNT-B'].id },
  { operation: 'matchTreasuryTransaction', method: 'POST', id: TREASURY_FIXTURES['TNT-B'].transactionId, body: { payment_request_id: PAYMENT_FIXTURES['TNT-B'].id } },
  { operation: 'assignReconciliationItem', method: 'POST', id: RECONCILIATION_FIXTURES['TNT-B'].id, versioned: true, body: { owner_membership_id: PAYMENT_FIXTURES['TNT-B'].id, due_at: '2030-01-01T00:00:00Z' } },
  { operation: 'resolveReconciliationItem', method: 'POST', id: RECONCILIATION_FIXTURES['TNT-B'].id, versioned: true, body: { resolution: 'EXPLAINED', note: 'Isolation foreign resolution attempt' } },
  { operation: 'getReconciliationItem', method: 'GET', id: RECONCILIATION_FIXTURES['TNT-B'].id },
  { operation: 'reversePayment', method: 'POST', id: PAYMENT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign reversal attempt', approval_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId, refund_treasury_transaction_id: TREASURY_FIXTURES['TNT-B'].transactionId } },
  { operation: 'refreshSettlementFigures', method: 'POST', id: SETTLEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { note: 'Isolation foreign refresh attempt' } },
  { operation: 'submitSettlement', method: 'POST', id: SETTLEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { submitted_on: '2026-10-25' } },
  { operation: 'recordSettlementVerification', method: 'POST', id: SETTLEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { outcome: 'VERIFYING', findings: 'Isolation foreign verification attempt' } },
  { operation: 'approveSettlementException', method: 'POST', id: SETTLEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign exception attempt', approval_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'post_settlements_id_close', method: 'POST', id: SETTLEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign close attempt', evidence_ids: [], decision_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'get_resources_settlement_revision_id', method: 'GET', id: SETTLEMENT_FIXTURES['TNT-B'].id },
  { operation: 'requestAdvance', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, body: { party_id: ADVANCE_FIXTURES['TNT-B'].partyId, kind: 'GPMB', amount_vnd: '1', allocation_line_id: CONTRACT_FIXTURES['TNT-B'].id } },
  { operation: 'setChangeChainTiers', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, body: { tier_count: 2 } },
  { operation: 'getChangeChain', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id },
  { operation: 'createChangeRequest', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, body: { stage: 'EVENT', baseline_revision_id: CONTRACT_FIXTURES['TNT-B'].revisionId, reason: 'Isolation foreign change attempt' } },
  { operation: 'promoteChangeRequest', method: 'POST', id: CHANGE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign promotion attempt' } },
  { operation: 'evaluateChangeRequest', method: 'POST', id: CHANGE_FIXTURES['TNT-B'].id, versioned: true, body: { evaluated_delta_vnd: '0', schedule_impact_days: 0, funding_impact_note: 'Isolation foreign evaluation attempt' } },
  { operation: 'post_contract_changes_id_decision', method: 'POST', id: CHANGE_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'reject', reason: 'Isolation foreign decision attempt', evidence_ids: [] } },
  { operation: 'withdrawChangeRequest', method: 'POST', id: CHANGE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign withdrawal attempt' } },
  { operation: 'get_resources_change_request_id', method: 'GET', id: CHANGE_FIXTURES['TNT-B'].id },
  {
    operation: 'recordMeasurement',
    method: 'POST',
    id: CONTRACT_FIXTURES['TNT-B'].id,
    body: { contract_revision_id: CONTRACT_FIXTURES['TNT-B'].revisionId, boq_item_id: BOQ_FIXTURES['TNT-B'].itemId, period_id: PERIOD_FIXTURES['TNT-B'].id, quantity_period: '1', reference_no: 'Isolation foreign measurement attempt', evidence_refs: [] },
  },
  { operation: 'submitMeasurement', method: 'POST', id: MEASUREMENT_FIXTURES['TNT-B'].id, versioned: true, body: {} },
  { operation: 'post_measurements_id_decision', method: 'POST', id: MEASUREMENT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'reject', reason: 'Isolation foreign measurement decision attempt', evidence_ids: [] } },
  { operation: 'correctMeasurement', method: 'POST', id: MEASUREMENT_FIXTURES['TNT-B'].id, versioned: true, body: { quantity_period: '1', correction_reason: 'Isolation foreign correction attempt', evidence_refs: [] } },
  { operation: 'get_resources_measurement_id', method: 'GET', id: MEASUREMENT_FIXTURES['TNT-B'].id },
  { operation: 'createAcceptance', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, body: { measurement_ids: [MEASUREMENT_FIXTURES['TNT-B'].id], period_id: PERIOD_FIXTURES['TNT-B'].id, document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'submitAcceptance', method: 'POST', id: WORK_ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { signer_refs: [{ name: 'Isolation foreign signer' }] } },
  { operation: 'post_acceptances_id_decision', method: 'POST', id: WORK_ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'reject', reason: 'Isolation foreign acceptance decision attempt', evidence_ids: [] } },
  { operation: 'revokeAcceptance', method: 'POST', id: WORK_ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign revocation attempt', approval_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'get_resources_acceptance_id', method: 'GET', id: WORK_ACCEPTANCE_FIXTURES['TNT-B'].id },
  { operation: 'scheduleInspection', method: 'POST', id: INSPECTION_FIXTURES['TNT-B'].id, versioned: true, body: { scheduled_at: '2999-01-01T00:00:00Z', participant_membership_ids: [MEMBERSHIP_FIXTURES['TNT-B'].id] } },
  { operation: 'recordInspectionResult', method: 'POST', id: INSPECTION_FIXTURES['TNT-B'].id, versioned: true, body: { result: 'PASS', result_note: 'Isolation foreign inspection result', checklist: [] } },
  { operation: 'cancelInspection', method: 'POST', id: INSPECTION_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancellation attempt' } },
  { operation: 'getInspection', method: 'GET', id: INSPECTION_FIXTURES['TNT-B'].id },
  { operation: 'transferAsset', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].assetId, versioned: true, body: { transferred_on: '2026-10-25', commissioning_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId } },
  { operation: 'get_resources_asset_record_id', method: 'GET', id: HANDOVER_FIXTURES['TNT-B'].assetId },
  { operation: 'closeWarrantyObligation', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].warrantyId, body: { note: 'Isolation foreign close attempt' } },
  { operation: 'addPunchItem', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].id, versioned: true, body: { description: 'Isolation foreign punch item attempt', severity: 'MINOR', due_on: '2999-01-01' } },
  { operation: 'markPunchItemFixed', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].itemId, body: { evidence_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId, note: 'Isolation foreign fix attempt' } },
  { operation: 'verifyPunchItem', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].itemId, body: { outcome: 'VERIFIED', note: 'Isolation foreign verification attempt' } },
  { operation: 'waivePunchItem', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].itemId, body: { waiver_reason: 'Isolation foreign waiver attempt' } },
  { operation: 'post_handovers_id_decision', method: 'POST', id: HANDOVER_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision attempt', evidence_ids: [], as_built_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId } },
  { operation: 'getHandoverTrace', method: 'GET', id: HANDOVER_FIXTURES['TNT-B'].id },
  { operation: 'get_resources_handover_id', method: 'GET', id: HANDOVER_FIXTURES['TNT-B'].id },
  { operation: 'assignCorrectiveAction', method: 'POST', id: NONCONFORMANCE_FIXTURES['TNT-B'].id, versioned: true, body: { description: 'Isolation foreign action attempt', owner_membership_id: MEMBERSHIP_FIXTURES['TNT-B'].id, due_at: '2999-01-01T00:00:00Z' } },
  { operation: 'submitCorrectiveEvidence', method: 'POST', id: NONCONFORMANCE_FIXTURES['TNT-B'].actionId, body: { evidence_document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId, note: 'Isolation foreign evidence attempt' } },
  { operation: 'verifyCorrectiveAction', method: 'POST', id: NONCONFORMANCE_FIXTURES['TNT-B'].actionId, body: { outcome: 'VERIFIED', verification_note: 'Isolation foreign verification attempt' } },
  { operation: 'closeNonconformance', method: 'POST', id: NONCONFORMANCE_FIXTURES['TNT-B'].id, versioned: true, body: { closure_note: 'Isolation foreign close attempt' } },
  { operation: 'reopenNonconformance', method: 'POST', id: NONCONFORMANCE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign reopen attempt' } },
  { operation: 'get_resources_quality_nonconformance_id', method: 'GET', id: NONCONFORMANCE_FIXTURES['TNT-B'].id },
  { operation: 'createQualityAcceptance', method: 'POST', id: INSPECTION_FIXTURES['TNT-B'].id, body: { acceptance_scope: 'WORK_ITEM', record_no: 'Isolation foreign draft', document_version_id: CONTRACT_FIXTURES['TNT-B'].revisionId } },
  { operation: 'signQualityAcceptance', method: 'POST', id: ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { signer_role: 'OWNER', signature_method: 'IN_APP_OTP', client_operation_id: '00000000-0000-4000-8000-0000000000e6' } },
  { operation: 'decideQualityAcceptance', method: 'POST', id: ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision attempt' } },
  { operation: 'revokeQualityAcceptance', method: 'POST', id: ACCEPTANCE_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign revocation attempt' } },
  { operation: 'getQualityAcceptance', method: 'GET', id: ACCEPTANCE_FIXTURES['TNT-B'].id },
  { operation: 'suspendContract', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign suspension attempt', decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId, suspended_from: '2026-10-25' } },
  { operation: 'resumeContract', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign resumption attempt', decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId, resumed_on: '2026-10-25' } },
  { operation: 'closeContract', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { settlement_revision_id: CONTRACT_FIXTURES['TNT-B'].revisionId, note: 'Isolation foreign closure attempt' } },
  { operation: 'completeContract', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { completion_quality_acceptance_id: DOCUMENT_FIXTURES['TNT-B'].versionId, completed_on: '2026-10-25' } },
  { operation: 'terminateContract', method: 'POST', id: CONTRACT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign termination attempt', decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId, terminated_on: '2026-10-25', guarantee_action: 'HOLD' } },
  {
    operation: 'importBoqLines',
    method: 'POST',
    id: CONTRACT_FIXTURES['TNT-B'].revisionId,
    versioned: true,
    body: { mode: 'REPLACE', lines: [{ business_key: 'ISOLATION-ATTEMPT', description: 'Isolation foreign import attempt', unit_code: 'M3', quantity: '1', unit_price: '1000' }] },
  },
  { operation: 'get_resources_boq_line_id', method: 'GET', id: BOQ_FIXTURES['TNT-B'].lineId },
  {
    operation: 'registerGuarantee',
    method: 'POST',
    id: CONTRACT_FIXTURES['TNT-B'].id,
    body: {
      kind: 'PERFORMANCE',
      issuer: 'Isolation foreign issuer',
      guarantee_no: 'ISOLATION-ATTEMPT',
      amount_vnd: '1000',
      valid_from: '2026-01-01',
      expires_at: '2099-01-01T00:00:00Z',
      document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId,
    },
  },
  {
    operation: 'verifyGuarantee',
    method: 'POST',
    id: GUARANTEE_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { outcome: 'VERIFIED', method: 'Isolation foreign verification attempt', evidence_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  {
    operation: 'extendGuarantee',
    method: 'POST',
    id: GUARANTEE_FIXTURES['TNT-B'].activeId,
    versioned: true,
    body: { new_expires_at: '2100-01-01T00:00:00Z', new_guarantee_no: 'ISOLATION-EXTENDED', document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  {
    operation: 'releaseGuarantee',
    method: 'POST',
    id: GUARANTEE_FIXTURES['TNT-B'].activeId,
    versioned: true,
    body: { release_evidence_id: DOCUMENT_FIXTURES['TNT-B'].versionId, reason: 'Isolation foreign release attempt' },
  },
  { operation: 'get_resources_guarantee_id', method: 'GET', id: GUARANTEE_FIXTURES['TNT-B'].id },
  {
    operation: 'verifyContractor',
    method: 'POST',
    id: CONTRACTOR_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { decision: 'VERIFIED', verification_evidence_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  },
  {
    operation: 'recordContractorRestriction',
    method: 'POST',
    id: CONTRACTOR_FIXTURES['TNT-B'].id,
    body: { kind: 'WARNING', effective_from: '2026-01-01', decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  },
  { operation: 'updateProjectProfile', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { name: 'Isolation foreign rename attempt' } },
  { operation: 'startProjectImplementation', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign start attempt', investment_decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'suspendProject', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign suspend attempt', decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'resumeProject', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign resume attempt' } },
  { operation: 'completeProject', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign completion attempt', decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'closeProject', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign closure attempt' } },
  { operation: 'cancelProject', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign cancellation attempt', decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'submitProjectForAppraisal', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign appraisal submission', policy_proposal_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  {
    operation: 'recordProjectAppraisal',
    method: 'POST',
    id: PROJECT_FIXTURES['TNT-B'].id,
    body: { criteria_set_version_id: '00000000-0000-4000-b0c4-0000000000ff', scores: [{ criterion_code: 'A', score: 3 }], recommendation: 'ADMIT' },
  },
  {
    operation: 'decideProjectAppraisal',
    method: 'POST',
    id: APPRAISAL_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { decision: 'ADMIT', reason: 'Isolation foreign appraisal decision', decision_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId, project_group: 'B' },
  },
  { operation: 'assignNationalProjectCode', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, versioned: true, body: { national_project_code: '9900002', evidence_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  {
    operation: 'recordRecoveryNotice',
    method: 'POST',
    id: PARCEL_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { notice_on: '2026-07-01', notice_document_version_id: DOCUMENT_FIXTURES['TNT-B'].documentId },
  },
  {
    operation: 'recordSectionHandover',
    method: 'POST',
    id: SECTION_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { handed_area_m2: '10', handed_over_on: '2026-10-20', handover_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId },
  },
  { operation: 'linkHouseholdParcel', method: 'POST', id: HOUSEHOLD_FIXTURES['TNT-B'].id, body: { parcel_id: PARCEL_FIXTURES['TNT-B'].id, right_kind: 'OWNER', share_pct: '10' } },
  { operation: 'handleHouseholdDataRequest', method: 'POST', id: HOUSEHOLD_FIXTURES['TNT-B'].id, body: { request_kind: 'ACCESS', requester_verified: true, outcome: 'FULFILLED', reason: 'Isolation foreign data request attempt' } },
  { operation: 'confirmInventory', method: 'POST', id: INVENTORY_FIXTURES['TNT-B'].id, versioned: true, body: { outcome: 'CONFIRMED', household_confirmed_on: '2026-10-20' } },
  { operation: 'addCompensationPlanItems', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { items: [{ household_id: HOUSEHOLD_FIXTURES['TNT-B'].id, item_kind: 'SUPPORT_TRAINING', amount_vnd: '1', legal_basis: 'Isolation foreign item attempt' }] } },
  { operation: 'revisePlan', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign revision attempt' } },
  { operation: 'listCompensationPlanItems', method: 'GET', id: PLAN_COMP_FIXTURES['TNT-B'].id },
  { operation: 'postCompensationPlan', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { posting_started_on: '2026-10-20', posting_place_text: 'Isolation foreign posting attempt' } },
  { operation: 'recordPlanFeedback', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, body: { summary: 'Isolation foreign opinion attempt', channel: 'LETTER' } },
  { operation: 'handlePlanFeedback', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, body: { handling_note: 'Isolation foreign handling attempt' } },
  { operation: 'closePlanPosting', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { feedback_summary: 'Isolation foreign closing attempt' } },
  { operation: 'approveCompensationPlan', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { approved_on: '2026-10-20', decision_document_version_id: DOCUMENT_FIXTURES['TNT-B'].versionId } },
  { operation: 'listPlanFeedback', method: 'GET', id: PLAN_COMP_FIXTURES['TNT-B'].id },
  { operation: 'getCompensationPlanTimers', method: 'GET', id: PLAN_COMP_FIXTURES['TNT-B'].id },
  { operation: 'scheduleCompensationPayments', method: 'POST', id: PLAN_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { payments: [{ household_id: HOUSEHOLD_FIXTURES['TNT-B'].id, amount_vnd: '999999999' }] } },
  { operation: 'confirmCompensationPayment', method: 'POST', id: PAYMENT_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { paid_on: '2026-11-01', method: 'BANK_TRANSFER', voucher_document_version_id: '00000000-0000-4000-b0bb-0000000000ff' } },
  { operation: 'depositCompensationPayment', method: 'POST', id: PAYMENT_COMP_FIXTURES['TNT-B'].id, versioned: true, body: { deposit_reason: 'Isolation foreign deposit attempt', voucher_document_version_id: '00000000-0000-4000-b0bb-0000000000ff', paid_on: '2026-11-01' } },
  { operation: 'listCompensationPayments', method: 'GET', id: PLAN_COMP_FIXTURES['TNT-B'].id },
  { operation: 'getAuditEngagement', method: 'GET', id: ENGAGEMENT_FIXTURES['TNT-B'].id },
  { operation: 'listAuditConclusions', method: 'GET', id: ENGAGEMENT_FIXTURES['TNT-B'].id },
  {
    operation: 'recordAuditConclusion',
    method: 'POST',
    id: ENGAGEMENT_FIXTURES['TNT-B'].id,
    versioned: true,
    body: {
      conclusion_kind: 'AUDIT_REPORT',
      conclusion_document_id: '00000000-0000-4000-b0bb-0000000000ff',
      issued_on: '2026-10-10',
      received_on: '2026-10-15',
      summary: 'Isolation foreign conclusion attempt',
      total_financial_vnd: '1000',
    },
  },
  { operation: 'listAuditFindings', method: 'GET', id: CONCLUSION_FIXTURES['TNT-B'].id },
  { operation: 'getAuditRecoverySummary', method: 'GET', id: ENGAGEMENT_FIXTURES['TNT-B'].id },
  { operation: 'listAuditRecoveryLinks', method: 'GET', id: ENGAGEMENT_FIXTURES['TNT-B'].id },
  {
    operation: 'linkAuditRecovery',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].recommendationId,
    versioned: true,
    body: { source_kind: 'MANUAL_EVIDENCE', amount_vnd: '1000', recorded_on: '2026-10-20', evidence_document_id: '00000000-0000-4000-b0bb-0000000000ff' },
  },
  { operation: 'reverseAuditRecovery', method: 'POST', id: CONCLUSION_FIXTURES['TNT-B'].linkId, body: { reason: 'Isolation foreign reversal attempt' } },
  { operation: 'assignAuditRecommendation', method: 'POST', id: CONCLUSION_FIXTURES['TNT-B'].recommendationId, versioned: true, body: { owner_unit_id: '00000000-0000-4000-b0bb-0000000000fe', due_on: '2026-12-01' } },
  {
    operation: 'planRemediationAction',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].recommendationId,
    versioned: true,
    body: { action_code: 'A-ISO-1', description: 'Isolation foreign action attempt', planned_on: '2026-12-01' },
  },
  {
    operation: 'completeRemediationAction',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].actionId,
    versioned: true,
    body: { completed_on: '2026-10-20', evidence_document_id: '00000000-0000-4000-b0bb-0000000000ff' },
  },
  { operation: 'submitRecommendationForVerification', method: 'POST', id: CONCLUSION_FIXTURES['TNT-B'].recommendationId, versioned: true, body: {} },
  { operation: 'verifyAuditRecommendation', method: 'POST', id: CONCLUSION_FIXTURES['TNT-B'].recommendationId, versioned: true, body: { decision: 'CLOSE' } },
  {
    operation: 'disputeAuditRecommendation',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].recommendationId,
    versioned: true,
    body: { dispute_reason: 'Isolation foreign dispute attempt by an owner', dispute_document_id: '00000000-0000-4000-b0bb-0000000000ff' },
  },
  {
    operation: 'recordAuditDisputeDecision',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].recommendationId,
    versioned: true,
    body: { outcome: 'REJECTED_BY_AUTHORITY', authority_document_id: '00000000-0000-4000-b0bb-0000000000ff' },
  },
  {
    operation: 'recordAuditFinding',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].id,
    body: { finding_code: 'F-ISO-1', category: 'FINANCIAL', description: 'Isolation foreign finding attempt', severity: 'HIGH' },
  },
  {
    operation: 'createAuditRecommendation',
    method: 'POST',
    id: CONCLUSION_FIXTURES['TNT-B'].id,
    body: { rec_code: 'R-ISO-1', rec_type: 'FINANCIAL_RECOVERY', description: 'Isolation foreign recommendation attempt', amount_vnd: '1000' },
  },
  { operation: 'startAuditEngagement', method: 'POST', id: ENGAGEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { started_on: '2026-10-20', place_legal_hold: false } },
  { operation: 'endAuditFieldwork', method: 'POST', id: ENGAGEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { on_date: '2026-10-20' } },
  { operation: 'cancelAuditEngagement', method: 'POST', id: ENGAGEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { on_date: '2026-10-20', reason: 'Isolation foreign cancellation attempt' } },
  { operation: 'closeAuditEngagement', method: 'POST', id: ENGAGEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { on_date: '2026-10-20' } },
  { operation: 'listAuditFollowUpReports', method: 'GET', id: ENGAGEMENT_FIXTURES['TNT-B'].id },
  { operation: 'requestAuditFollowUpReport', method: 'POST', id: ENGAGEMENT_FIXTURES['TNT-B'].id, versioned: true, body: { conclusion_id: CONCLUSION_FIXTURES['TNT-B'].id, as_of_date: '2026-10-20' } },
  { operation: 'resolveLandComplaint', method: 'POST', id: COMPLAINT_FIXTURES['TNT-B'].id, versioned: true, body: { outcome: 'ESCALATED', resolved_on: '2026-10-20', note: 'Isolation foreign answer attempt' } },
  { operation: 'revealHouseholdIdentity', method: 'GET', id: HOUSEHOLD_FIXTURES['TNT-B'].id, query: 'reason=Isolation%20foreign%20reading%20attempt' },
  { operation: 'getProjectLifecycle', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id },
  { operation: 'getLandProgress', method: 'GET', id: PROJECT_FIXTURES['TNT-B'].id },
  { operation: 'recordProcurementMilestone', method: 'POST', id: PACKAGE_FIXTURES['TNT-B'].id, versioned: true, body: { milestone_kind: 'BID_OPENING', actual_at: '2026-09-01T03:00:00Z' } },
  { operation: 'declareConflictOfInterest', method: 'POST', id: PACKAGE_FIXTURES['TNT-B'].id, body: { has_conflict: false } },
  { operation: 'decideConflictOfInterest', method: 'POST', id: PROPOSAL_FIXTURES['TNT-B'].declarationId, versioned: true, body: { decision: 'ALLOWED', decision_reason: 'Isolation foreign decision attempt' } },
  { operation: 'listConflictDeclarations', method: 'GET', id: PACKAGE_FIXTURES['TNT-B'].id },
  { operation: 'resolveProcurementPetition', method: 'POST', id: PETITION_FIXTURES['TNT-B'].id, versioned: true, body: { outcome: 'RESOLVED', resolution_document_id: DOCUMENT_FIXTURES['TNT-B'].documentId } },
  { operation: 'decideProcurementResult', method: 'POST', id: RESULT_FIXTURES['TNT-B'].id, versioned: true, body: { decision: 'REJECT', comment: 'Isolation foreign decision attempt' } },
  { operation: 'get_resources_proposal_id', method: 'GET', id: PROPOSAL_FIXTURES['TNT-B'].id },
  { operation: 'assignProjectLeader', method: 'POST', id: PROJECT_FIXTURES['TNT-B'].id, body: { leader_membership_id: MEMBERSHIP_FIXTURES['TNT-B'].id, accountability_role: 'LEADER_IN_CHARGE', valid_from: '2026-01-05' } },
  { operation: 'endProjectLeaderAssignment', method: 'POST', id: ACCOUNTABILITY_FIXTURES['TNT-B'].assignmentId, versioned: true, body: { valid_until: '2026-01-06', end_reason: 'Isolation foreign end attempt' } },
  { operation: 'addTaskForceMember', method: 'POST', id: ACCOUNTABILITY_FIXTURES['TNT-B'].taskForceId, body: { membership_id: MEMBERSHIP_FIXTURES['TNT-B'].id, member_role: 'SECRETARY', valid_from: '2026-01-05' } },
  { operation: 'dissolveTaskForce', method: 'POST', id: ACCOUNTABILITY_FIXTURES['TNT-B'].taskForceId, versioned: true, body: { reason: 'Isolation foreign dissolution attempt' } },
  { operation: 'getTenantEntitlements', method: 'GET', id: TENANT_IDS['TNT-B'], expectedStatuses: [403, 404] },
  { operation: 'updateOrganizationUnit', method: 'PUT', id: FOREIGN_UNIT, versioned: true, body: { name: 'Tên đơn vị mới' } },
  {
    operation: 'moveOrganizationUnit',
    method: 'POST',
    id: FOREIGN_UNIT,
    versioned: true,
    body: { new_parent_id: OWN_UNIT, effective_from: '2026-01-01', reason: 'Isolation foreign move attempt' },
  },
  {
    operation: 'updateCustomRole',
    method: 'PUT',
    id: ROLE_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { permissions: ['iam.unit.manage'], reason: 'Isolation foreign update attempt' },
  },
  {
    operation: 'revokeRoleGrant',
    method: 'POST',
    id: GRANT_FIXTURES['TNT-B'].id,
    versioned: true,
    body: { reason: 'Isolation foreign revoke attempt' },
  },
  { operation: 'suspendMembership', method: 'POST', id: MEMBERSHIP_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign suspend attempt' } },
  { operation: 'reactivateMembership', method: 'POST', id: MEMBERSHIP_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign reactivate attempt' } },
  { operation: 'endMembership', method: 'POST', id: MEMBERSHIP_FIXTURES['TNT-B'].id, versioned: true, body: { reason: 'Isolation foreign end attempt' } },
];

/** Operations that this channel exercises with a foreign id (the registered foreign-id cases). */
export const API_FOREIGN_ID_CASES: ReadonlySet<string> = new Set([GET_UNIT_OPERATION, ...FOREIGN_ATTEMPT_SPECS.map((spec) => spec.operation)]);

export function tokenFor(tenant: TenantName, signingKey: Buffer): string {
  return signTenantContext(contextOf(tenant), signingKey);
}

export interface ApiChannelOptions {
  baseUrl: string;
  signingKey: Buffer;
  ownerUrl: string;
  doc: OpenApiDocument;
  /** Also aim the commands and further reads of FOREIGN_ATTEMPT_SPECS at TNT-B; needs the policy guard and the command pipeline. */
  attempts?: boolean;
}

async function get(baseUrl: string, path: string, token: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { [TENANT_HEADER]: token } });
  return { status: response.status, body: await response.text() };
}

/** The attempts go to the application a batch at a time: a hundred and more connections at once are refused by the listener of a loaded machine, which is not what the suite is about. */
const ATTEMPTS_AT_ONCE = 32;

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let from = 0; from < items.length; from += size) done.push(...(await Promise.all(items.slice(from, from + size).map(work))));
  return done;
}

export async function attempt(options: ApiChannelOptions, spec: ForeignAttemptSpec, user: TenantName): Promise<ForeignAttempt> {
  const headers: Record<string, string> = {
    [TENANT_HEADER]: tokenFor(user, options.signingKey),
    // Step-up commands (revokeRoleGrant) need a fresh aal2.
    [CLAIMS_HEADER]: JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() }),
  };
  if (spec.method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = `isolation-${randomUUID()}`;
  }
  if (spec.versioned === true) headers['if-match'] = '"1"';
  const path = `${fillPath(operationPath(options.doc, spec.operation), spec.id)}${spec.query === undefined ? '' : `?${spec.query}`}`;
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: spec.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  });
  return { operation: spec.operation, status: response.status, body: await response.text(), expectedStatuses: spec.expectedStatuses };
}

/** Reads through the HTTP API using the real paths of the OpenAPI document and a signed test tenant context. */
export function createApiChannel(options: ApiChannelOptions): IsolationChannel {
  const detailPath = operationPath(options.doc, GET_UNIT_OPERATION);
  const listPath = operationPath(options.doc, LIST_UNITS_OPERATION);
  return {
    name: 'api',
    seed: async (tenant) => {
      await seedTenantUnits(options.ownerUrl, tenant);
      await seedTenantAuthz(options.ownerUrl, tenant);
    },
    foreignAttempts:
      options.attempts === true ? async (user) => inBatches(FOREIGN_ATTEMPT_SPECS, ATTEMPTS_AT_ONCE, (spec) => attempt(options, spec, user)) : undefined,
    readAs(user, target) {
      const targetId = UNIT_FIXTURES[target][0]?.id ?? '';
      return get(options.baseUrl, fillPath(detailPath, targetId), tokenFor(user, options.signingKey));
    },
    listAs(user) {
      return get(options.baseUrl, listPath, tokenFor(user, options.signingKey));
    },
  };
}

