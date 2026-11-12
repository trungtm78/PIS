import { biDatasetFacts } from '@machvon/kernel';
import type { AccessLogRow, BiReaderEventRow, BiReaderRow, ExportDatasetRow, MachineAccountRow, MachineCredentialRow, ProductChoice, ProjectCodeRow, SourceSystemRow } from '@machvon/db';

/** The name of a person, or null when the person is unknown to the tenant (a deleted membership, a machine). */
export type NameOf = (id: string | null) => string | null;

export const nameLookup = (names: ReadonlyMap<string, string>): NameOf => (id) => (id === null ? null : (names.get(id) ?? null));

export const credentialDto = (row: MachineCredentialRow): Record<string, unknown> => ({
  id: row.id,
  client_id: row.clientId,
  secret_hint: row.secretHint,
  state: row.state,
  created_at: row.createdAt,
  superseded_at: row.supersededAt,
  expires_at: row.expiresAt,
  revoked_at: row.revokedAt,
  last_used_at: row.lastUsedAt,
});

export interface MachineAccountCaller {
  mayUpdate: boolean;
  mayDecide: boolean;
  mayRotate: boolean;
}

export const machineAccountDto = (row: MachineAccountRow, nameOf: NameOf, caller: MachineAccountCaller): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  description: row.description,
  scopes: row.scopes,
  rate_limit_per_minute: row.ratePerMinute,
  expires_on: row.expiresOn,
  status: row.status,
  status_reason: row.statusReason,
  status_changed_at: row.statusChangedAt,
  version: row.version,
  created_at: row.createdAt,
  created_by_name: nameOf(row.createdBy),
  credentials: row.credentials.map(credentialDto),
  actions: { update: caller.mayUpdate && row.status !== 'REVOKED', decide: caller.mayDecide && row.status !== 'REVOKED', rotate: caller.mayRotate && row.status === 'ACTIVE' },
});

export const accessLogDto = (row: AccessLogRow): Record<string, unknown> => ({
  id: row.id,
  account_id: row.accountId,
  account_name: row.accountName,
  credential_id: row.credentialId,
  operation: row.operation,
  scope: row.scope,
  path: row.path,
  query_keys: row.queryKeys,
  outcome: row.outcome,
  status: row.status,
  row_count: row.rowCount,
  correlation_id: row.correlationId,
  occurred_at: row.occurredAt,
});

export const exportDatasetDto = (row: ExportDatasetRow, maySet: boolean): Record<string, unknown> => {
  const facts = biDatasetFacts(row.datasetCode);
  const [primary] = facts.views;
  return {
    dataset_code: row.datasetCode,
    view_name: primary?.view,
    scope: facts.scope,
    grain: primary?.grain,
    columns: [...(primary?.columns ?? [])],
    product_id: row.productId,
    product_code: row.productCode,
    product_title: row.productTitle,
    certification: row.certification,
    certification_expires_on: row.certificationExpiresOn,
    enabled: row.enabled,
    state_reason: row.stateReason,
    state_changed_at: row.stateChangedAt,
    version: row.version,
    gate: { open: row.gate.open, reason: row.gate.open ? null : row.gate.reason },
    can_set: maySet,
  };
};

export const productChoiceDto = (row: ProductChoice): Record<string, unknown> => ({ id: row.id, code: row.code, title: row.title, certification: row.certification, certification_expires_on: row.certificationExpiresOn });

export const biReaderDto = (row: BiReaderRow, caller: { mayManage: boolean }): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  tool: row.tool,
  login_name: row.loginName,
  connection_limit: row.connectionLimit,
  status: row.status,
  status_reason: row.statusReason,
  status_changed_at: row.statusChangedAt,
  password_rotated_at: row.passwordRotatedAt,
  version: row.version,
  created_at: row.createdAt,
  actions: { rotate: caller.mayManage && row.status !== 'RETIRED', decide: caller.mayManage && row.status !== 'RETIRED' },
});

export const biReaderEventDto = (row: BiReaderEventRow, nameOf: NameOf): Record<string, unknown> => ({
  id: row.id,
  action: row.action,
  reason: row.reason,
  actor_name: nameOf(row.actorId),
  reader_version: row.readerVersion,
  occurred_at: row.occurredAt,
});

export const sourceSystemDto = (row: SourceSystemRow, mayManage: boolean): Record<string, unknown> => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  code_pattern: row.codePattern,
  status: row.status,
  retire_reason: row.retireReason,
  retired_at: row.retiredAt,
  active_codes: row.activeCodes,
  proposed_codes: row.proposedCodes,
  version: row.version,
  created_at: row.createdAt,
  can_retire: mayManage && row.status === 'ACTIVE' && row.activeCodes === 0 && row.proposedCodes === 0,
});

export interface ProjectCodeCaller {
  membershipId: string;
  mayDecide: boolean;
  mayRetire: boolean;
}

export const projectCodeDto = (row: ProjectCodeRow, nameOf: NameOf, caller: ProjectCodeCaller): Record<string, unknown> => ({
  id: row.id,
  project_id: row.projectId,
  project_code: row.projectCode,
  project_name: row.projectName,
  source_system: row.sourceSystem,
  external_code: row.externalCode,
  valid_from: row.validFrom,
  valid_until: row.validUntil,
  status: row.status,
  proposed_by_name: nameOf(row.proposedBy),
  proposal_reason: row.proposalReason,
  approved_by_name: nameOf(row.approvedBy),
  approved_at: row.approvedAt,
  decision_reason: row.decisionReason,
  retired_by_name: nameOf(row.retiredBy),
  retired_at: row.retiredAt,
  retire_reason: row.retireReason,
  version: row.version,
  created_at: row.createdAt,
  // The maker never decides; the screen hides what the server would refuse.
  actions: { decide: caller.mayDecide && row.status === 'PROPOSED' && row.proposedBy !== caller.membershipId, retire: caller.mayRetire && row.status === 'ACTIVE' },
});
