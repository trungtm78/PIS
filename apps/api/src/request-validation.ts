import { validateRequestBody } from '@machvon/contracts';
import type { Issue } from '@machvon/contracts';
import { DomainError } from '@machvon/kernel';

/**
 * Operations whose acceptance criteria answer a broken rule of a well typed value as 400 INVALID_REQUEST
 * (ST-ADM-005 AC-4: a custom role of rank 95 is 400; ST-SAS-015 AC-2: a support access request for 600 minutes is 400). Every other operation answers 422 VALIDATION_FAILED.
 */
const RULE_AS_INVALID_REQUEST: ReadonlySet<string> = new Set(['createCustomRole', 'updateCustomRole', 'grantRole', 'revokeRoleGrant', 'requestSupportAccess']);

/**
 * Operations whose acceptance criteria answer a missing field as 422 VALIDATION_FAILED naming it
 * (ST-MDM-007 AC-2: a reset of an integration cursor without a reason; ST-CTR-003 AC-1: a release of a guarantee without its evidence; ST-AST-002 AC-1: a transfer of an asset without the dossier of the commissioning; UAT-AC380: a household without its retention date; UAT-AC381: a data request without its reason).
 * A field of the wrong type stays 400.
 */
const MISSING_AS_VALIDATION_FAILED: ReadonlySet<string> = new Set(['resetIntegrationCursor', 'releaseGuarantee', 'transferAsset', 'registerAffectedHousehold', 'handleHouseholdDataRequest', 'recordInventory', 'confirmInventory', 'draftCompensationPlan', 'addCompensationPlanItems', 'revisePlan', 'postCompensationPlan', 'recordPlanFeedback', 'handlePlanFeedback', 'closePlanPosting', 'approveCompensationPlan', 'scheduleCompensationPayments', 'confirmCompensationPayment', 'depositCompensationPayment', 'fileLandComplaint', 'resolveLandComplaint']);

/**
 * Fields whose absence or empty value has a code of its own in the operation catalogue (422, the field named): a legal
 * confirmation without a reference is CONFIRMATION_REF_REQUIRED and a template revision without a legal basis is
 * LEGAL_BASIS_REQUIRED (ST-DOC-006 AC-1, DOC F12).
 */
const FIELD_PROBLEMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  confirmDocumentTemplateLegalBasis: { legal_confirmation_ref: 'CONFIRMATION_REF_REQUIRED' },
  createDocumentTemplateRevision: { legal_basis: 'LEGAL_BASIS_REQUIRED' },
  createMneFormVersion: { legal_basis: 'LEGAL_BASIS_REQUIRED' },
  createMneObligationRule: { legal_basis: 'LEGAL_BASIS_REQUIRED' },
  // A filing by hand is recorded with the reference of the receipt (ST-MNE-004 AC-1).
  recordMneSubmissionReceipt: { receipt_reference: 'RECEIPT_REQUIRED' },
  // The correction of an issued report is started with its reason (ST-MNE-007 AC-1).
  correctMneReport: { correction_reason: 'CORRECTION_REASON_REQUIRED' },
  publishPermitType: { legal_basis: 'LEGAL_BASIS_REQUIRED' },
  registerAppropriation: { decision_document_id: 'DECISION_REQUIRED' },
  // A plan is published on a decision document (ST-CAP-003 AC-1).
  post_plans_id_publish: { decision_document_id: 'DECISION_REQUIRED' },
  // The suspension, the resumption and the termination of a contract rest on a decision document (ST-CTR-005 AC-1).
  suspendContract: { decision_document_version_id: 'DECISION_DOCUMENT_REQUIRED' },
  resumeContract: { decision_document_version_id: 'DECISION_DOCUMENT_REQUIRED' },
  terminateContract: { decision_document_version_id: 'DECISION_DOCUMENT_REQUIRED' },
  // A contract is completed on the completion acceptance that was approved (ST-CTR-011 AC-1).
  completeContract: { completion_quality_acceptance_id: 'COMPLETION_ACCEPTANCE_REQUIRED' },
  // A reopening without a reason of 20 characters (ST-DIS-002 AC-1).
  requestPeriodReopen: { reason: 'REOPEN_REASON_REQUIRED' },
  // A household is registered on a legal basis for processing the personal data, and the reference to it (ST-LND-002 AC-1, UAT-AC380).
  registerAffectedHousehold: { legal_basis: 'LEGAL_BASIS_REQUIRED', legal_basis_ref: 'LEGAL_BASIS_REQUIRED' },
  // A plan of compensation is approved on the decision document (ST-LND-006 AC-1, UAT-AC377).
  approveCompensationPlan: { decision_document_version_id: 'DECISION_DOCUMENT_REQUIRED' },
};

/**
 * The problem for the issues of a request body, or undefined when there are none. The first class present wins:
 * unknown fields (400 FIELD_NOT_ALLOWED, all of them named), then a field with a code of its own that is missing or
 * breaks its rule (422), then a missing field or a wrong type (400 INVALID_REQUEST), then a broken rule (422
 * VALIDATION_FAILED). The detail names fields, never values.
 */
export function problemOf(issues: readonly Issue[], operationId: string): DomainError | undefined {
  const unknown = issues.filter((issue) => issue.kind === 'unknown_field');
  if (unknown.length > 0) return new DomainError('FIELD_NOT_ALLOWED', 400, unknown.map((issue) => issue.path).join(', '));
  for (const issue of issues) {
    const code = issue.kind === 'type' ? undefined : FIELD_PROBLEMS[operationId]?.[issue.path];
    if (code !== undefined) return new DomainError(code, 422, issue.path);
  }
  const malformed = issues.find((issue) => issue.kind === 'type' || (issue.kind === 'missing' && !MISSING_AS_VALIDATION_FAILED.has(operationId)));
  if (malformed !== undefined) return new DomainError('INVALID_REQUEST', 400, malformed.path);
  const missing = issues.find((issue) => issue.kind === 'missing');
  if (missing !== undefined) return new DomainError('VALIDATION_FAILED', 422, missing.path);
  const broken = issues.find((issue) => issue.kind === 'constraint');
  if (broken === undefined) return undefined;
  return RULE_AS_INVALID_REQUEST.has(operationId)
    ? new DomainError('INVALID_REQUEST', 400, broken.path)
    : new DomainError('VALIDATION_FAILED', 422, broken.path);
}

/**
 * Validates a command body against the request schema of its operation in openapi.json. Operations that are
 * not in the document (test routes) or that declare no JSON body are not checked.
 */
export function assertValidBody(operationId: string | undefined, body: unknown): void {
  if (operationId === undefined) return;
  const issues = validateRequestBody(operationId, body);
  if (issues === undefined) return;
  const problem = problemOf(issues, operationId);
  if (problem !== undefined) throw problem;
}
