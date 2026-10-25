import { createHash, randomUUID } from 'node:crypto';
import {
  ACCEPTANCE_SCOPES,
  DomainError,
  SIGNATURE_METHODS,
  assertAcceptanceTransition,
  assertSignaturesComplete,
  canonicalContent,
  legalEffectOf,
  missingSigners,
  rolesSignableBy,
  scopeAccepts,
  versionConflict,
} from '@machvon/kernel';
import type { AcceptanceScope, AcceptanceStatus, InspectionResult, InspectionType, SignatureMethod, SignerRole } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const UNIQUE_VIOLATION = '23505';
const LIVE_CONSTRAINT = 'quality_acceptance_live_uq';
const NUMBER_CONSTRAINT = 'quality_acceptance_no_uq';
const SIGNATURE_ONCE = 'qms_signature_once_uq';
const SIGNATURE_PERSON = 'qms_signature_person_uq';
const SIGNATURE_OPERATION = 'qms_signature_op_uq';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface CreateInput {
  acceptanceScope: string;
  recordNo: string;
  documentVersionId: string;
}

export interface SignInput {
  signerRole: string;
  signatureMethod: string;
  certSerial?: string | undefined;
  clientOperationId: string;
}

export interface DecisionInput {
  decision: string;
  reason: string;
}

/** What a command did to the minutes: the facts the audit row and the event of the command carry. */
export interface QmsAcceptanceResult {
  id: string;
  recordNo: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  inspectionId: string;
  boqItemId: string | null;
  acceptanceScope: AcceptanceScope;
  fromStatus: AcceptanceStatus | null;
  status: AcceptanceStatus;
  version: number;
  requiredRoles: SignerRole[];
  missingRoles: SignerRole[];
  regimeRuleVersionId: string | null;
  regimeAwaitingConfirmation: boolean;
  signerRole: SignerRole | null;
  signatureMethod: SignatureMethod | null;
  legalEffect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE' | null;
}

export interface SignatureLine {
  role: SignerRole;
  membershipId: string;
  signerName: string;
  method: SignatureMethod;
  legalEffect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE';
  certSerial: string | null;
  signedAt: string;
  /** Whether the signature is over the hash the minutes carry; one that is not is void. */
  valid: boolean;
}

/** The minutes as QMS-05 shows them. */
export interface QmsAcceptanceLine {
  id: string;
  recordNo: string;
  contract: { id: string; code: string; status: string };
  projectId: string;
  inspection: { id: string; inspectionNo: string; inspectionType: InspectionType; title: string; result: InspectionResult | null };
  boqItem: { id: string; businessKey: string; description: string } | null;
  acceptanceScope: AcceptanceScope;
  documentVersionId: string | null;
  status: AcceptanceStatus;
  requiredRoles: SignerRole[];
  signatures: SignatureLine[];
  missingRoles: SignerRole[];
  /** Serious non-conformances of the contract that are still open: approval is refused while there are any. */
  openCriticalNcr: number;
  regime: { versionId: string | null; label: string | null; legalBasis: string | null; awaitingConfirmation: boolean; cxn: string | null };
  decisionNote: string | null;
  approvedAt: string | null;
  approvedBy: { membershipId: string; displayName: string } | null;
  createdBy: { membershipId: string; displayName: string };
  revokeReason: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** The roles the viewer could sign as and has not signed: empty for someone who signed already or who is on the other side. */
  viewerSignableRoles: SignerRole[];
  viewerMembershipId: string;
  version: number;
  reach: ContractPlace;
}

interface LockSql {
  id: string;
  record_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  inspection_id: string;
  boq_item_id: string | null;
  acceptance_scope: AcceptanceScope;
  document_version_id: string;
  status: AcceptanceStatus;
  required_roles: SignerRole[];
  regime_rule_version_id: string | null;
  regime_awaiting_confirmation: boolean;
  content_hash: string;
  created_by: string;
  inspection_result: InspectionResult | null;
  inspection_checklist: Array<{ code: string; outcome?: string; note?: string }>;
  version: string;
}

interface LineSql {
  id: string;
  record_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  inspection_id: string;
  inspection_no: string;
  inspection_type: InspectionType;
  inspection_title: string;
  inspection_result: InspectionResult | null;
  boq_item_id: string | null;
  business_key: string | null;
  boq_description: string | null;
  acceptance_scope: AcceptanceScope;
  document_version_id: string | null;
  status: AcceptanceStatus;
  required_roles: SignerRole[];
  content_hash: string;
  open_critical_ncr: string;
  regime_rule_version_id: string | null;
  regime_label: string | null;
  regime_legal_basis: string | null;
  regime_awaiting_confirmation: boolean;
  regime_cxn: string | null;
  decision_note: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approver_name: string | null;
  created_by: string;
  creator_name: string | null;
  revoke_reason: string | null;
  revoked_at: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface SignatureSql {
  subject_id: string;
  signer_role: SignerRole;
  membership_id: string;
  signer_name_snapshot: string;
  method: SignatureMethod;
  legal_effect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE';
  cert_serial: string | null;
  signed_content_hash: string;
  signed_at: string;
}

const OPEN_CRITICAL = "n.blocks_acceptance and n.status <> 'CLOSED'";

const SELECT = `select q.id, q.record_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, q.inspection_id, i.inspection_no, i.inspection_type, i.title as inspection_title,
       i.result as inspection_result, i.boq_item_id, b.business_key, b.description as boq_description, q.acceptance_scope, q.document_version_id, q.status, q.required_roles, q.content_hash,
       (select count(*)::text from machvon.quality_nonconformance n where n.tenant_id = q.tenant_id and n.contract_id = q.contract_id and ${OPEN_CRITICAL}) as open_critical_ncr,
       q.regime_rule_version_id, rv.label as regime_label, rv.legal_basis as regime_legal_basis, q.regime_awaiting_confirmation, q.regime_cxn, q.decision_note,
       ${TIMESTAMP('q.approved_at')} as approved_at, q.approved_by, au.display_name as approver_name, q.created_by, cu.display_name as creator_name, q.revoke_reason, ${TIMESTAMP('q.revoked_at')} as revoked_at,
       ${TIMESTAMP('q.created_at')} as created_at, q.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.quality_acceptance q on q.tenant_id = c.tenant_id and q.contract_id = c.id
  join machvon.inspection i on i.tenant_id = q.tenant_id and i.id = q.inspection_id
  left join machvon.boq_item b on b.tenant_id = i.tenant_id and b.id = i.boq_item_id
  left join machvon.master_record_version rv on rv.id = q.regime_rule_version_id
  left join machvon.tenant_user_directory au on au.tenant_id = q.tenant_id and au.membership_id = q.approved_by
  left join machvon.tenant_user_directory cu on cu.tenant_id = q.tenant_id and cu.membership_id = q.created_by`;

/**
 * The quality acceptance minutes of an inspection (ST-QMS-005, QMS 3.2): drafted from an inspection that passed, signed by each role the regime of the day required over one hash of what
 * the minutes say, approved by someone other than whoever drafted them once every role has signed and no serious non-conformance of the contract is open, and revoked while no approved
 * acceptance of work holds them. What the minutes say never changes after they are drafted; a signature is kept as it is.
 */
export class QmsAcceptanceStore {
  private readonly contracts: CtrContractStore;

  constructor(contracts: CtrContractStore = new CtrContractStore()) {
    this.contracts = contracts;
  }

  /**
   * Refusals in order: the shape (422 `VALIDATION_FAILED`), the inspection (404 outside the scope, 403 where it may be read and not changed), the contract being performed (409
   * `CONTRACT_STATE_INVALID`), an inspection that passed (422 `INSPECTION_NOT_PASSED`), a scope that the kind of inspection covers (422), a serious non-conformance still open (422
   * `OPEN_CRITICAL_NCR`), the paper (422), and one live set of minutes for the inspection and a number once for the contract (409 `QUALITY_ACCEPTANCE_STATE_INVALID`).
   */
  async create(tx: TenantTx, inspectionId: string, input: CreateInput, actor: string, scopes: ContractScopes): Promise<QmsAcceptanceResult> {
    const scope = ACCEPTANCE_SCOPES.find((candidate) => candidate === input.acceptanceScope);
    if (scope === undefined) throw invalid('acceptance_scope');
    const recordNo = textOf(input.recordNo, 'record_no');
    const documentId = idOf(input.documentVersionId, 'document_version_id');
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.inspection where id = $1::uuid', [idOf(inspectionId, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<{
      id: string;
      inspection_no: string;
      inspection_type: InspectionType;
      status: string;
      result: InspectionResult | null;
      boq_item_id: string | null;
      checklist: Array<{ code: string; outcome?: string; note?: string }>;
      required_roles: SignerRole[];
      regime_rule_version_id: string | null;
      regime_awaiting_confirmation: boolean;
      regime_cxn: string | null;
      contract_code: string;
    }>(
      `select i.id, i.inspection_no, i.inspection_type, i.status, i.result, i.boq_item_id, i.checklist, i.required_roles, i.regime_rule_version_id, i.regime_awaiting_confirmation, i.regime_cxn, c.code as contract_code
         from machvon.inspection i join machvon.contract c on c.tenant_id = i.tenant_id and c.id = i.contract_id
        where i.id = $1::uuid for share of i`,
      [inspectionId.toLowerCase()],
    );
    const inspection = rows[0];
    if (inspection === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if (inspection.status !== 'RESULT_RECORDED' || (inspection.result !== 'PASS' && inspection.result !== 'CONDITIONAL')) {
      throw new DomainError('INSPECTION_NOT_PASSED', 422, 'inspection_id', { extensions: { inspection_status: inspection.status, inspection_result: inspection.result } });
    }
    if (!scopeAccepts(scope, inspection.inspection_type)) throw invalid('acceptance_scope');
    await this.assertNoCriticalNcr(tx, peek[0].contract_id);
    if ((await tx.query("select 1 from machvon.document_version where id = $1::uuid and scan_status = 'CLEAN'", [documentId])).length === 0) throw invalid('document_version_id');

    const id = randomUUID();
    const hash = hashOf(
      canonicalContent({
        acceptanceId: id,
        contractId: peek[0].contract_id,
        inspectionId: inspection.id,
        recordNo,
        acceptanceScope: scope,
        documentVersionId: documentId,
        requiredRoles: inspection.required_roles,
        inspectionResult: inspection.result,
        checklist: inspection.checklist,
      }),
    );
    try {
      await tx.query(
        `insert into machvon.quality_acceptance
           (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, regime_rule_version_id, regime_awaiting_confirmation, regime_cxn,
            content_hash, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, 'DRAFT', $8::jsonb, $9::uuid, $10, $11, $12, $13::uuid, $13::uuid, 1)`,
        [id, contract.projectId, peek[0].contract_id, inspection.id, recordNo, scope, documentId, JSON.stringify(inspection.required_roles), inspection.regime_rule_version_id, inspection.regime_awaiting_confirmation, inspection.regime_cxn, hash, actor],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === LIVE_CONSTRAINT) throw new DomainError('QUALITY_ACCEPTANCE_STATE_INVALID', 409, 'inspection_id', { extensions: { reason: 'ALREADY_DRAFTED' } });
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === NUMBER_CONSTRAINT) throw new DomainError('QUALITY_ACCEPTANCE_STATE_INVALID', 409, 'record_no', { extensions: { reason: 'RECORD_NO_USED' } });
      throw error;
    }
    return {
      id,
      recordNo,
      contractId: peek[0].contract_id,
      contractCode: inspection.contract_code,
      projectId: contract.projectId,
      inspectionId: inspection.id,
      boqItemId: inspection.boq_item_id,
      acceptanceScope: scope,
      fromStatus: null,
      status: 'DRAFT',
      version: 1,
      requiredRoles: inspection.required_roles,
      missingRoles: [...inspection.required_roles],
      regimeRuleVersionId: inspection.regime_rule_version_id,
      regimeAwaitingConfirmation: inspection.regime_awaiting_confirmation,
      signerRole: null,
      signatureMethod: null,
      legalEffect: null,
    };
  }

  /**
   * One role signs the minutes over the hash they carry. Refusals in order: the state (409 `QUALITY_ACCEPTANCE_STATE_INVALID`), a role the minutes do not require (422 `ROLE_NOT_REQUIRED`), a
   * method that is not accepted (422 `SIGNATURE_METHOD_NOT_ACCEPTED`: a certificate needs its serial, and only a certificate carries one), a role that is not the signer's to sign (403
   * `SCOPE_DENIED`), a role that has signed or a person who has (409 `ALREADY_SIGNED`).
   */
  async sign(tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsAcceptanceResult> {
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const method = SIGNATURE_METHODS.find((candidate) => candidate === input.signatureMethod);
    if (method === undefined) throw invalid('signature_method');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertAcceptanceTransition('sign', held.status);
    const role = held.required_roles.find((candidate) => candidate === input.signerRole);
    if (role === undefined) throw new DomainError('ROLE_NOT_REQUIRED', 422, 'signer_role', { extensions: { required_roles: held.required_roles } });
    const serial = input.certSerial === undefined ? null : textOf(input.certSerial, 'cert_serial');
    if ((method === 'DIGITAL_CERT') !== (serial !== null)) throw new DomainError('SIGNATURE_METHOD_NOT_ACCEPTED', 422, 'signature_method', { extensions: { signature_method: method } });
    this.assertIntact(held);
    const standing = await this.standingOf(tx, actor, held.contract_id);
    if (!standing.roles.includes(role)) throw new DomainError('SCOPE_DENIED', 403, 'signer_role');
    const signatures = await this.signaturesOf(tx, [id]);
    if (signatures.some((signature) => signature.signer_role === role && signature.signed_content_hash === held.content_hash)) throw new DomainError('ALREADY_SIGNED', 409, 'signer_role', { extensions: { signer_role: role } });
    if (signatures.some((signature) => signature.membership_id === actor)) throw new DomainError('ALREADY_SIGNED', 409, 'membership_id', { extensions: { signer_role: role } });
    const effect = legalEffectOf(method);
    try {
      await tx.query(
        `insert into machvon.qms_signature
           (tenant_id, id, subject_kind, subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, cert_serial, signed_content_hash, signed_at, client_operation_id, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'QUALITY_ACCEPTANCE', $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::uuid, $3::uuid)`,
        [id, role, actor, standing.displayName, method, effect, serial, held.content_hash, now.toISOString(), operationId],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && (failure.constraint === SIGNATURE_ONCE || failure.constraint === SIGNATURE_PERSON)) throw new DomainError('ALREADY_SIGNED', 409, 'signer_role', { extensions: { signer_role: role } });
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === SIGNATURE_OPERATION) throw invalid('client_operation_id');
      throw error;
    }
    await tx.query('update machvon.quality_acceptance set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [id, target, actor]);
    const after = [...signatures.map((signature) => ({ role: signature.signer_role, contentHash: signature.signed_content_hash })), { role, contentHash: held.content_hash }];
    return this.viewOf(held, held.status, target, { missing: missingSigners(held.required_roles, after, held.content_hash), signer: { role, method, effect } });
  }

  /**
   * The decision on minutes that are being signed. Approving is refused while a serious non-conformance of the contract is open (422 `OPEN_CRITICAL_NCR`; this is judged before the state, so
   * minutes that are only drafted are refused for it too), by whoever drafted the minutes (403 `SELF_APPROVAL_DENIED`), and until every required role has signed over the hash of the minutes
   * (422 `SIGNATURES_INCOMPLETE`, naming the roles that have not); the contract must still be performed (409 `CONTRACT_STATE_INVALID`). Rejecting needs the reason and nothing else.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecisionInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsAcceptanceResult> {
    if (input.decision !== 'approve' && input.decision !== 'reject') throw invalid('decision');
    const reason = textOf(input.reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (input.decision === 'reject') {
      const target = assertAcceptanceTransition('reject', held.status);
      await tx.query(
        `update machvon.quality_acceptance
            set status = $2, decision_note = $3, rejected_at = $4::timestamptz, rejected_by = $5::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1
          where id = $1::uuid`,
        [id, target, reason, now.toISOString(), actor],
      );
      return this.viewOf(held, held.status, target, { missing: [] });
    }
    if (held.status === 'DRAFT' || held.status === 'SIGNING') await this.assertNoCriticalNcr(tx, held.contract_id);
    const target = assertAcceptanceTransition('approve', held.status);
    if (held.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approved_by');
    this.assertIntact(held);
    const signatures = (await this.signaturesOf(tx, [id])).map((signature) => ({ role: signature.signer_role, contentHash: signature.signed_content_hash }));
    assertSignaturesComplete(held.required_roles, signatures, held.content_hash);
    if (held.contract_status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract_status } });
    await tx.query(
      `update machvon.quality_acceptance
          set status = $2, decision_note = $3, approved_at = $4::timestamptz, approved_by = $5::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, target, reason, now.toISOString(), actor],
    );
    return this.viewOf(held, held.status, target, { missing: [] });
  }

  /** Withdraws approved minutes with the reason, unless an approved acceptance of work holds them (409 `ACCEPTANCE_ALREADY_USED`). */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, now: Date): Promise<QmsAcceptanceResult> {
    const why = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertAcceptanceTransition('revoke', held.status);
    const used = await tx.query<{ id: string }>("select id from machvon.acceptance where quality_acceptance_id = $1::uuid and status = 'APPROVED' limit 1", [id]);
    if (used[0] !== undefined) throw new DomainError('ACCEPTANCE_ALREADY_USED', 409, 'id', { extensions: { acceptance_id: used[0].id } });
    await tx.query(
      `update machvon.quality_acceptance
          set status = $2, revoke_reason = $3, revoked_at = $4::timestamptz, revoked_by = $5::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, target, why, now.toISOString(), actor],
    );
    return this.viewOf(held, held.status, target, { missing: [] });
  }

  /** The minutes of the contracts in the scope of the caller, newest first; those of one contract or one inspection when named. */
  async list(tx: TenantTx, scope: ScopeBuilder, viewer: string, filter: { contractId?: string | undefined; inspectionId?: string | undefined; limit?: number | undefined }): Promise<QmsAcceptanceLine[]> {
    const predicate = scope(3);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or q.contract_id = $1::uuid) and ($2::uuid is null or q.inspection_id = $2::uuid)
        order by q.created_at desc, q.id limit ${Math.min(Math.max(filter.limit ?? 200, 1), 1000)}`,
      [filter.contractId ?? null, filter.inspectionId ?? null, ...predicate.params],
    );
    return this.lines(tx, rows, viewer);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder, viewer: string): Promise<QmsAcceptanceLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where q.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return (await this.lines(tx, rows, viewer))[0];
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  private async lines(tx: TenantTx, rows: LineSql[], viewer: string): Promise<QmsAcceptanceLine[]> {
    if (rows.length === 0) return [];
    const signatures = await this.signaturesOf(
      tx,
      rows.map((row) => row.id),
    );
    const standings = new Map<string, { roles: SignerRole[]; displayName: string }>();
    const lines: QmsAcceptanceLine[] = [];
    for (const row of rows) {
      if (!standings.has(row.contract_id)) standings.set(row.contract_id, await this.standingOf(tx, viewer, row.contract_id));
      const own = signatures.filter((signature) => signature.subject_id === row.id);
      const standing = standings.get(row.contract_id);
      const missing = missingSigners(row.required_roles, own.map((signature) => ({ role: signature.signer_role, contentHash: signature.signed_content_hash })), row.content_hash);
      const signed = own.some((signature) => signature.membership_id === viewer);
      lines.push({
        id: row.id,
        recordNo: row.record_no,
        contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
        projectId: row.project_id,
        inspection: { id: row.inspection_id, inspectionNo: row.inspection_no, inspectionType: row.inspection_type, title: row.inspection_title, result: row.inspection_result },
        boqItem: row.boq_item_id === null ? null : { id: row.boq_item_id, businessKey: row.business_key ?? '', description: row.boq_description ?? '' },
        acceptanceScope: row.acceptance_scope,
        documentVersionId: row.document_version_id,
        status: row.status,
        requiredRoles: row.required_roles,
        signatures: own.map((signature) => ({
          role: signature.signer_role,
          membershipId: signature.membership_id,
          signerName: signature.signer_name_snapshot,
          method: signature.method,
          legalEffect: signature.legal_effect,
          certSerial: signature.cert_serial,
          signedAt: signature.signed_at,
          valid: signature.signed_content_hash === row.content_hash,
        })),
        missingRoles: missing,
        openCriticalNcr: Number(row.open_critical_ncr),
        regime: { versionId: row.regime_rule_version_id, label: row.regime_label, legalBasis: row.regime_legal_basis, awaitingConfirmation: row.regime_awaiting_confirmation, cxn: row.regime_cxn },
        decisionNote: row.decision_note,
        approvedAt: row.approved_at,
        approvedBy: row.approved_by === null ? null : { membershipId: row.approved_by, displayName: row.approver_name ?? '' },
        createdBy: { membershipId: row.created_by, displayName: row.creator_name ?? '' },
        revokeReason: row.revoke_reason,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
        viewerSignableRoles: signed || (row.status !== 'DRAFT' && row.status !== 'SIGNING') ? [] : (standing?.roles ?? []).filter((role) => missing.includes(role)),
        viewerMembershipId: viewer,
        version: Number(row.version),
        reach: {
          contractId: row.contract_id,
          projectId: row.project_id,
          ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
          investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
        },
      });
    }
    return lines;
  }

  private async signaturesOf(tx: TenantTx, ids: readonly string[]): Promise<SignatureSql[]> {
    return tx.query<SignatureSql>(
      `select subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, cert_serial, signed_content_hash, ${TIMESTAMP('signed_at')} as signed_at
         from machvon.qms_signature where subject_kind = 'QUALITY_ACCEPTANCE' and subject_id = any($1::uuid[]) order by signed_at, id`,
      [ids],
    );
  }

  /** Who the person is to the contract and the roles they may sign as (BR-QMS-05): a guest of the contractor signs for the contractor, the staff for the other side. */
  private async standingOf(tx: TenantTx, membershipId: string, contractId: string): Promise<{ roles: SignerRole[]; displayName: string }> {
    const people = await tx.query<{ membership_type: string; contractor_id: string | null; display_name: string | null }>(
      `select m.membership_type, m.contractor_id, d.display_name
         from machvon.membership m left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.id
        where m.id = $1::uuid`,
      [membershipId],
    );
    const person = people[0];
    if (person === undefined) return { roles: [], displayName: '' };
    const parties = await tx.query<{ contractor_id: string }>(
      `select contractor_id from machvon.contract where id = $1::uuid
        union select contractor_id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'`,
      [contractId],
    );
    const standing = person.membership_type === 'GUEST_CONTRACTOR' && person.contractor_id !== null ? ({ kind: 'GUEST_CONTRACTOR', contractorId: person.contractor_id } as const) : person.membership_type === 'STAFF' ? ({ kind: 'STAFF' } as const) : undefined;
    return { roles: standing === undefined ? [] : rolesSignableBy(standing, parties.map((party) => party.contractor_id)), displayName: person.display_name ?? '' };
  }

  /** 422 `OPEN_CRITICAL_NCR` while a serious non-conformance of the contract is still open (the non-conformances themselves are ST-QMS-006's). */
  private async assertNoCriticalNcr(tx: TenantTx, contractId: string): Promise<void> {
    const open = await tx.query<{ id: string }>(`select n.id from machvon.quality_nonconformance n where n.contract_id = $1::uuid and ${OPEN_CRITICAL} order by n.id limit 20`, [contractId]);
    if (open.length > 0) throw new DomainError('OPEN_CRITICAL_NCR', 422, 'contract_id', { extensions: { nonconformance_ids: open.map((row) => row.id) } });
  }

  /** The hash the minutes carry is the hash of what they say now (BR-QMS-02); otherwise nothing is signed or approved on them. */
  private assertIntact(held: LockSql): void {
    const hash = hashOf(
      canonicalContent({
        acceptanceId: held.id,
        contractId: held.contract_id,
        inspectionId: held.inspection_id,
        recordNo: held.record_no,
        acceptanceScope: held.acceptance_scope,
        documentVersionId: held.document_version_id,
        requiredRoles: held.required_roles,
        inspectionResult: held.inspection_result ?? '',
        checklist: held.inspection_checklist,
      }),
    );
    if (hash !== held.content_hash) throw new DomainError('QUALITY_ACCEPTANCE_STATE_INVALID', 409, 'content_hash', { extensions: { reason: 'CONTENT_CHANGED' } });
  }

  /** The minutes locked for update inside the scope of the command, their contract locked first and judged by the scope; minutes the caller cannot see do not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.quality_acceptance where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<LockSql>(
      `select q.id, q.record_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, q.inspection_id, i.boq_item_id, q.acceptance_scope, q.document_version_id, q.status, q.required_roles,
              q.regime_rule_version_id, q.regime_awaiting_confirmation, q.content_hash, q.created_by, i.result as inspection_result, i.checklist as inspection_checklist, q.version::text as version
         from machvon.quality_acceptance q
         join machvon.contract c on c.tenant_id = q.tenant_id and c.id = q.contract_id
         join machvon.inspection i on i.tenant_id = q.tenant_id and i.id = q.inspection_id
        where q.id = $1::uuid for update of q`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private viewOf(
    held: LockSql,
    from: AcceptanceStatus,
    status: AcceptanceStatus,
    after: { missing: SignerRole[]; signer?: { role: SignerRole; method: SignatureMethod; effect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE' } },
  ): QmsAcceptanceResult {
    return {
      id: held.id,
      recordNo: held.record_no,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      inspectionId: held.inspection_id,
      boqItemId: held.boq_item_id,
      acceptanceScope: held.acceptance_scope,
      fromStatus: from,
      status,
      version: Number(held.version) + 1,
      requiredRoles: held.required_roles,
      missingRoles: after.missing,
      regimeRuleVersionId: held.regime_rule_version_id,
      regimeAwaitingConfirmation: held.regime_awaiting_confirmation,
      signerRole: after.signer?.role ?? null,
      signatureMethod: after.signer?.method ?? null,
      legalEffect: after.signer?.effect ?? null,
    };
  }
}
