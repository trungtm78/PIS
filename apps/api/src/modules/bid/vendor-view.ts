import type {
  CaseRow,
  PayeeChangeRow,
  KeyStaffRow,
  OwnerRow,
  Policy,
  VendorProfileRow,
  QualificationRow,
  ReputationEventRow,
  SuggestionRow,
  VentureRow,
  AccountRow,
} from '@machvon/db';
import { daysUntil, expiryState, vietnamDateOf } from '@machvon/kernel';
import type { ExpiryWarningPolicy, PayeeVerdict, ProfileCoverage, ProfileField, TaxCodeCheck } from '@machvon/kernel';

/** The names of members by id, as the people directory gives them. */
export type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

/** What the caller may do on a row: the permissions held on the whole tenant and who the caller is. */
export interface Caller {
  membershipId: string;
  holds: (permission: string) => boolean;
}

export const policyDto = <T>(code: string, policy: Policy<T>): Record<string, unknown> => ({
  code,
  version: policy.version,
  unverified: policy.unverified,
  formula: policy.formula,
  source: policy.source,
  as_of: policy.asOf,
  params: policy.value as Record<string, unknown>,
});

export const profileDto = (row: VendorProfileRow): Record<string, unknown> => ({
  contractor_id: row.contractorId,
  tax_identifier: row.taxIdentifier,
  legal_name: row.legalName,
  verification_status: row.verificationStatus,
  legal_rep_name: row.legalRepName,
  legal_rep_position: row.legalRepPosition,
  registered_address: row.registeredAddress,
  phone: row.phone,
  email: row.email,
  business_registration_no: row.businessRegistrationNo,
  ownership_declaration: row.ownershipDeclaration,
  phone_set_at: row.phoneSetAt,
  profile_reviewed_at: row.profileReviewedAt,
  next_review_due: row.nextReviewDue,
  owner_count: row.ownerCount,
  version: row.version,
});

export const taxCheckDto = (check: TaxCodeCheck): Record<string, unknown> => ({ format: check.format, checksum: check.checksum, checksum_legal_status: check.checksumLegalStatus, normalised: check.normalised });

export const coverageDto = (coverage: ProfileCoverage, required: readonly ProfileField[]): Record<string, unknown> => ({ present: coverage.present, missing: coverage.missing, required: [...required], coverage_pct: coverage.coveragePct, complete: coverage.complete });

export const ownerDto = (row: OwnerRow): Record<string, unknown> => ({
  id: row.id,
  owner_kind: row.ownerKind,
  owner_name: row.ownerName,
  share_pct: row.sharePct,
  beneficial_owner: row.beneficialOwner,
  control_basis: row.controlBasis,
  has_identity_key: row.hasIdentityKey,
  source_document_id: row.sourceDocumentId,
  since_on: row.sinceOn,
  ended_on: row.endedOn,
  ended_reason: row.endedReason,
  version: row.version,
});

export const accountDto = (row: AccountRow): Record<string, unknown> => ({
  id: row.id,
  bank_name: row.bankName,
  account_holder: row.accountHolder,
  holder_matches_legal_name: row.holderMatchesLegalName,
  account_no_masked: row.accountNoMasked,
  state: row.state,
  effective_after: row.effectiveAfter,
  valid_now: row.validNow,
  superseded_at: row.supersededAt,
  closed_reason: row.closedReason,
  version: row.version,
});

export const verdictDto = (verdict: PayeeVerdict, policyVersion: string, unverified: boolean): Record<string, unknown> => ({
  allowed: verdict.allowed,
  reason: verdict.reason,
  warnings: verdict.warnings,
  account_id: verdict.accountId,
  valid_from: verdict.validFrom,
  policy_version: policyVersion,
  unverified,
});

export function changeDto(row: PayeeChangeRow, names: Names, caller: Caller): Record<string, unknown> {
  const open = row.status === 'REQUESTED';
  const mine = row.requestedBy === caller.membershipId;
  return {
    id: row.id,
    contractor_id: row.contractorId,
    contractor_name: row.contractorName,
    bank_name: row.bankName,
    account_holder: row.accountHolder,
    holder_matches_legal_name: row.holderMatchesLegalName,
    account_no_masked: row.accountNoMasked,
    reason: row.reason,
    evidence_document_id: row.evidenceDocumentId,
    status: row.status,
    requested_by_name: nameOf(names, row.requestedBy),
    requested_at: row.requestedAt,
    expires_at: row.expiresAt,
    contract_match_by_name: nameOf(names, row.contractMatchBy),
    contract_match_at: row.contractMatchAt,
    contract_match_note: row.contractMatchNote,
    account_match_by_name: nameOf(names, row.accountMatchBy),
    account_match_at: row.accountMatchAt,
    account_match_note: row.accountMatchNote,
    callback_by_name: nameOf(names, row.callbackBy),
    callback_at: row.callbackAt,
    callback_outcome: row.callbackOutcome,
    callback_number_last4: row.callbackNumberLast4,
    callback_note: row.callbackNote,
    closed_at: row.closedAt,
    closed_reason: row.closedReason,
    resulting_account_id: row.resultingAccountId,
    remaining: row.remaining,
    may_approve_contract_match: open && !mine && row.contractMatchBy === null && row.accountMatchBy !== caller.membershipId && caller.holds('vnd.bank.approve'),
    may_approve_account_match: open && !mine && row.accountMatchBy === null && row.contractMatchBy !== caller.membershipId && caller.holds('vnd.bank.approve'),
    may_callback: open && !mine && row.callbackBy === null && caller.holds('vnd.bank.callback'),
    may_cancel: open && mine && caller.holds('vnd.bank.request'),
    may_reject: open && !mine && caller.holds('vnd.bank.approve'),
    version: row.version,
  };
}

export function qualificationDto(row: QualificationRow, names: Names, today: string, policy: ExpiryWarningPolicy, caller: Caller): Record<string, unknown> {
  const state = expiryState({ issuedOn: row.issuedOn, expiresOn: row.expiresOn, revoked: row.revokedAt !== null }, today, policy);
  return {
    id: row.id,
    kind: row.kind,
    certificate_no: row.certificateNo,
    grade: row.grade,
    scope: row.scope,
    issuer: row.issuer,
    issued_on: row.issuedOn,
    expires_on: row.expiresOn,
    document_id: row.documentId,
    verified_by_name: nameOf(names, row.verifiedBy),
    verified_at: row.verifiedAt,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    state,
    days_left: row.expiresOn === null ? null : daysUntil(today, row.expiresOn),
    may_verify: row.verifiedBy === null && row.revokedAt === null && row.createdBy !== caller.membershipId && caller.holds('vnd.qualification.verify'),
    version: row.version,
  };
}

export function keyStaffDto(row: KeyStaffRow, names: Names, today: string, policy: ExpiryWarningPolicy, caller: Caller): Record<string, unknown> {
  const state = expiryState({ issuedOn: row.issuedOn, expiresOn: row.expiresOn, revoked: row.revokedAt !== null }, today, policy);
  return {
    id: row.id,
    staff_role: row.staffRole,
    person_name: row.personName,
    qualification_title: row.qualificationTitle,
    certificate_no: row.certificateNo,
    issued_on: row.issuedOn,
    expires_on: row.expiresOn,
    document_id: row.documentId,
    verified_by_name: nameOf(names, row.verifiedBy),
    verified_at: row.verifiedAt,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    state,
    days_left: row.expiresOn === null ? null : daysUntil(today, row.expiresOn),
    may_verify: row.verifiedBy === null && row.revokedAt === null && row.createdBy !== caller.membershipId && caller.holds('vnd.qualification.verify'),
    version: row.version,
  };
}

export const duplicateDto = (row: SuggestionRow): Record<string, unknown> => ({
  id: row.id,
  contractor_a_id: row.contractorAId,
  contractor_b_id: row.contractorBId,
  contractor_a_name: row.contractorAName,
  contractor_b_name: row.contractorBName,
  contractor_a_tax: row.contractorATax,
  contractor_b_tax: row.contractorBTax,
  score: row.score,
  signals: row.signals,
  status: row.status,
  decision_reason: row.decisionReason,
  version: row.version,
});

export function caseDto(row: CaseRow, names: Names): Record<string, unknown> {
  return {
    id: row.id,
    case_no: row.caseNo,
    subject_kind: row.subjectKind,
    contractor_id: row.contractorId,
    joint_venture_id: row.jointVentureId,
    subject_name: row.subjectName,
    trigger_kind: row.triggerKind,
    trigger_ref: row.triggerRef,
    egp_record_id: row.egpRecordId,
    violation_groups: row.violationGroups,
    violation_summary: row.violationSummary,
    violation_on: row.violationOn,
    proposed_by_name: nameOf(names, row.proposedBy),
    received_at: row.receivedAt,
    decide_by: row.decideBy,
    clock: row.clock,
    policy_version: row.policyVersion,
    status: row.status,
    response_due_at: row.responseDueAt,
    response_outcome: row.responseOutcome,
    decision: row.decision,
    decided_by_name: nameOf(names, row.decidedBy),
    decided_at: row.decidedAt,
    decision_scope: row.decisionScope,
    ban_months: row.banMonths,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    decided_late: row.decidedLate,
    version: row.version,
  };
}

export function reputationDto(row: ReputationEventRow, names: Names, caller: Caller): Record<string, unknown> {
  const open = row.status === 'RECORDED';
  const other = row.recordedBy !== caller.membershipId;
  return {
    id: row.id,
    contractor_id: row.contractorId,
    contractor_name: row.contractorName,
    package_id: row.packageId,
    contract_id: row.contractId,
    behaviour_code: row.behaviourCode,
    event_on: row.eventOn,
    description: row.description,
    evidence_document_id: row.evidenceDocumentId,
    status: row.status,
    recorded_by_name: nameOf(names, row.recordedBy),
    recorded_at: row.recordedAt,
    post_due_at: row.postDueAt,
    clock: row.clock,
    deadline_policy_version: row.deadlinePolicyVersion,
    posted_by_name: nameOf(names, row.postedBy),
    posted_at: row.postedAt,
    posting_ref: row.postingRef,
    retracted_at: row.retractedAt,
    retract_reason: row.retractReason,
    may_post: open && other && caller.holds('vnd.reputation.post'),
    may_retract: open && other && caller.holds('vnd.reputation.post'),
    version: row.version,
  };
}

export const ventureDto = (row: VentureRow): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  lead_contractor_id: row.leadContractorId,
  agreement_document_id: row.agreementDocumentId,
  package_id: row.packageId,
  starts_on: row.startsOn,
  ends_on: row.endsOn,
  ended_reason: row.endedReason,
  status: row.status,
  members: row.members.map((member) => ({ contractor_id: member.contractorId, contractor_name: member.contractorName, tax_identifier: member.taxIdentifier, share_pct: member.sharePct, lead: member.lead })),
  version: row.version,
});

export const todayOf = (now: Date): string => vietnamDateOf(now);
