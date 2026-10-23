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
  /** A clean PDF version of tenant A: the signature verification names it in the path. */
  documentVersionId: string;
  /** An Active signing certificate of tenant A (version 1). */
  certificateId: string;
  /** A security policy draft of tenant A made by someone other than the callers (version 1). */
  policyId: string;
  /** An outgoing document of tenant A in SUBMITTED (version 1) and an open leader signing session of it (version 1). */
  outgoingDocumentId: string;
  signingSessionId: string;
  /** An EFFECTIVE master record of tenant A (version 1), a DRAFT change request of another record and an IN_REVIEW one of a third. */
  masterRecordId: string;
  masterDraftChangeId: string;
  masterReviewChangeId: string;
  /** A document of tenant A, named as the decision that authorises a publication. */
  decisionDocumentId: string;
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
