import { randomUUID } from 'node:crypto';
import {
  DomainError,
  MAX_LIFECYCLE_TEXT,
  assertContractTransition,
  assertNotMaker,
  compareDecimal,
  requiresPerformanceGuarantee,
  requiresPermitGate,
  signingConflict,
  versionConflict,
} from '@machvon/kernel';
import type { ContractStatus } from '@machvon/kernel';
import { BidConflictStore } from './bid-conflict-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { CtrContractStore, SCOPE_FROM, calendarDate, partiesCheck, textOf } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { CtrGuaranteeStore } from './ctr-guarantee-store.ts';
import { PmtGateStore } from './pmt-gate-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** The gate of the permits that a contract of works waits for before it begins (BR-CTR-14). */
export const ACTIVATION_GATE = 'CONTRACT_ACTIVATION';
/** The stage of a project in which its contracts are activated. */
export const ACTIVATION_PROJECT_STATUS = 'IMPLEMENTATION';

const SUBMIT_COMMAND = 'submitContractForReview';
const RETURN_COMMAND = 'returnContractDraft';
const SIGN_COMMAND = 'recordContractSigning';
const ACTIVATE_COMMAND = 'activateContract';
const DEFAULT_SUBMIT_REASON = 'Sent to review';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** What every command of the life of a contract answers: the contract before and after, for the audit row, the event and the answer. */
export interface LifecycleResult {
  id: string;
  code: string;
  projectId: string;
  packageId: string;
  contractorId: string;
  fromStatus: ContractStatus;
  status: ContractStatus;
  version: number;
  reason: string;
}

/** Where a contract lies and what it is worth: the facts a delegation limit and a commitment of capital are judged on. */
export interface ContractFacts {
  id: string;
  code: string;
  projectId: string;
  packageId: string;
  contractorId: string;
  ownerUnit: { id: string; path: string };
  contractValueVnd: string;
  advanceCategory: string;
}

export interface SignInput {
  /** `YYYY-MM-DD`. */
  signedOn: string;
  signedDocumentVersionId: string;
  conflictDecisionRef?: string | undefined;
}

export interface ActivateInput {
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  reason: string;
  evidenceIds: readonly string[];
}

export interface SignResult extends LifecycleResult {
  signedOn: string;
  signedDocumentVersionId: string;
  conflictDecisionRef: string | null;
}

export interface ActivateResult extends LifecycleResult {
  effectiveFrom: string;
  revisionId: string;
  committedVnd: string;
  allocationLineId: string;
  evidenceIds: string[];
  /** What the commitment of capital answered (the entry of the ledger, or the fact that it was posted already). */
  commitment: CommitmentOutcome;
}

/** What the commitment of capital reports back: enough to write the event of the commitment, nothing of the ledger itself. */
export interface CommitmentOutcome {
  entryId: string;
  replayed: boolean;
  warningAcknowledged: boolean;
}

/**
 * The two collaborators of the module that are not tables of CTR: the delegation limit of the matrix of ADM (which needs the grants of the caller) and the commitment of capital of CAP
 * (which writes its own audit row and event in the transaction of the command). The store calls them at the point of the sequence where they belong.
 */
export interface LifecycleHooks {
  /** Refuses with 403 `SCOPE_DENIED` (or 422 `DOA_RULE_NOT_FOUND`) when the caller is not within the delegation limit for the contract. */
  authorise(facts: ContractFacts): Promise<void>;
  /** Commits the value of the contract against the line of capital; any refusal becomes 422 `FUND_COMMIT_FAILED`. */
  commit(facts: ContractFacts & { allocationLineId: string }): Promise<CommitmentOutcome>;
}

/** What stands between a contract and its activation, as the workspace of the contract shows it before anyone tries (the activation judges the same things again, under the lock). */
export interface ActivationReadiness {
  boq: { totalVnd: string; balanced: boolean };
  guarantee: { required: boolean; held: boolean };
  permitGate: { required: boolean; status: 'NOT_REQUIRED' | 'PASSED' | 'PASSED_WITH_WAIVER' | 'BLOCKED'; blocking: string[] };
  capital: { allocationLineId: string | null };
  project: { status: string; inImplementation: boolean };
}

interface LockedRow extends ContractFacts {
  version: number;
  status: ContractStatus;
  isJointVenture: boolean;
  estimateCeilingVnd: string | null;
  createdBy: string | null;
  submittedBy: string | null;
  signedOn: string | null;
  projectStatus: string;
  allocationLineId: string | null;
}

interface LockSql {
  code: string;
  advance_category: string;
  created_by: string | null;
  submitted_by: string | null;
  signed_on: string | null;
  project_status: string;
  owner_unit_id: string;
  owner_unit_path: string;
  allocation_line_id: string | null;
}

/**
 * The review, the signing and the activation of a contract (ST-CTR-004, CTR 3.1 steps 3 to 5, BR-CTR-13 to BR-CTR-15). Every command takes the row of the contract first, inside the
 * scope of its own permission, answers a stale version with 409, and then judges in this order: the conflict of interest of the caller, the state, the maker against the checker,
 * the delegation limit, and what the command itself needs. The history of the status gets one row for each move, written with it; a refusal leaves nothing behind.
 */
export class CtrContractLifecycleStore {
  private readonly contracts: CtrContractStore;
  private readonly source: CtrContractSource;
  private readonly conflicts: BidConflictStore;
  private readonly guarantees: CtrGuaranteeStore;
  private readonly gates: PmtGateStore;

  constructor(options: { source?: CtrContractSource; gates?: PmtGateStore; conflicts?: BidConflictStore } = {}) {
    this.source = options.source ?? new CtrContractSource();
    this.contracts = new CtrContractStore(this.source);
    this.conflicts = options.conflicts ?? new BidConflictStore();
    this.guarantees = new CtrGuaranteeStore(this.source);
    this.gates = options.gates ?? new PmtGateStore();
  }

  /** DRAFT to IN_REVIEW: the terms are complete and the caller is free of any conflict with the contractor. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, note: string | undefined, actor: string, scopes: ContractScopes, today: string): Promise<LifecycleResult> {
    const reason = note === undefined ? DEFAULT_SUBMIT_REASON : textOf(note, 'note', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(SUBMIT_COMMAND, contract.status);
    if (contract.estimateCeilingVnd !== null && compareDecimal(contract.contractValueVnd, contract.estimateCeilingVnd) > 0) {
      throw new DomainError('CONTRACT_VALUE_EXCEEDS_CEILING', 422, 'contract_value_vnd', { extensions: { estimate_ceiling_vnd: contract.estimateCeilingVnd } });
    }
    if (!(await this.source.hasApprovedCapitalPlan(tx, contract.projectId))) throw new DomainError('CAPITAL_PLAN_NOT_APPROVED', 422, 'project_id');
    await this.contracts.assertContractorMayContract(tx, contract.contractorId, today);
    await this.assertBoqBalanced(tx, contract);
    if (contract.isJointVenture) {
      const check = partiesCheck(await this.contracts.partiesOf(tx, id), contract.contractValueVnd);
      if (!check.sharesComplete || !check.workMatchesValue) {
        throw new DomainError('JV_SHARE_NOT_100', 422, 'parties', { extensions: { share_total: check.shareTotal, work_value_total_vnd: check.workValueTotal } });
      }
    }
    await tx.query(
      `update machvon.contract set status = $2, submitted_by = $3::uuid, submitted_at = now(), status_reason = null, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, to, actor],
    );
    await this.record(tx, id, contract.status, to, reason, today, SUBMIT_COMMAND, actor);
    return this.result(contract, to, reason);
  }

  /** IN_REVIEW back to DRAFT, with the reason, by someone other than the people whose work is in review. */
  async returnToDraft(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, today: string): Promise<LifecycleResult> {
    const words = textOf(reason, 'reason', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    const to = assertContractTransition(RETURN_COMMAND, contract.status);
    assertNotMaker(actor, contract);
    await tx.query(
      `update machvon.contract set status = $2, submitted_by = null, submitted_at = null, status_reason = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, to, actor, words],
    );
    await this.record(tx, id, contract.status, to, words, today, RETURN_COMMAND, actor);
    return this.result(contract, to, words);
  }

  /**
   * IN_REVIEW to SIGNED (BR-CTR-13, BR-CTR-15). A signer who is in conflict with the contractor is blocked whatever is on the record; when the one who sent the contract to review
   * is in conflict, someone free of it may sign only with the decision that dealt with it. The signed document must be a clean file of the tenant that is not a sealed bid.
   */
  async sign(tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, today: string, hooks: Pick<LifecycleHooks, 'authorise'>): Promise<SignResult> {
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    const decisionRef = input.conflictDecisionRef === undefined ? undefined : textOf(input.conflictDecisionRef, 'conflict_decision_ref', MAX_LIFECYCLE_TEXT);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(SIGN_COMMAND, contract.status);
    assertNotMaker(actor, contract);
    await hooks.authorise(contract);
    const signedOn = calendarDate(input.signedOn, 'signed_on');
    if (signedOn > today) throw invalid('signed_on');
    const documentVersionId = input.signedDocumentVersionId.toLowerCase();
    await this.assertCleanDocument(tx, documentVersionId);
    if (contract.submittedBy !== null) {
      const reviewer = await this.conflicts.blockingDeclaration(tx, contract.submittedBy, contract.contractorId, contract.packageId);
      const verdict = signingConflict({ signerInConflict: false, reviewerInConflict: reviewer !== undefined, decisionRef });
      if (verdict === 'BLOCKED') throw this.blocked(reviewer?.id, contract, 'REVIEWER');
    }
    await tx.query(
      `update machvon.contract
          set status = $2, signed_on = $3::date, signed_by = $4::uuid, signed_document_version_id = $5::uuid, conflict_decision_ref = $6, status_reason = null,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, signedOn, actor, documentVersionId, decisionRef ?? null],
    );
    const reason = decisionRef === undefined ? `Signed on ${signedOn}` : `Signed on ${signedOn} under decision ${decisionRef}`;
    await this.record(tx, id, contract.status, to, reason, today, SIGN_COMMAND, actor, documentVersionId);
    return { ...this.result(contract, to, reason), signedOn, signedDocumentVersionId: documentVersionId, conflictDecisionRef: decisionRef ?? null };
  }

  /**
   * SIGNED to ACTIVE. The conditions are judged in the order the acceptance case names them: the performance guarantee, the gate of the permits, then the commitment of capital,
   * so each refusal leaves the contract SIGNED and the next condition unasked. The first revision becomes the effective one from the date of effect, the value of the contract is
   * committed against its line of capital, and the whole is one transaction.
   */
  async activate(tx: TenantTx, id: string, expectedVersion: number, input: ActivateInput, actor: string, scopes: ContractScopes, today: string, hooks: LifecycleHooks): Promise<ActivateResult> {
    const reason = textOf(input.reason, 'reason', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(ACTIVATE_COMMAND, contract.status);
    assertNotMaker(actor, contract);
    await hooks.authorise(contract);
    const effectiveFrom = calendarDate(input.effectiveFrom, 'effective_from');
    if (contract.signedOn !== null && effectiveFrom < contract.signedOn) throw invalid('effective_from');
    const evidenceIds = [...new Set(input.evidenceIds.map((evidence) => evidence.toLowerCase()))].sort();
    await this.assertDocuments(tx, evidenceIds);
    if (contract.projectStatus !== ACTIVATION_PROJECT_STATUS) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { project_status: contract.projectStatus } });

    if (requiresPerformanceGuarantee(contract.advanceCategory) && !(await this.guarantees.holdsActive(tx, id, 'PERFORMANCE', new Date(`${effectiveFrom}T00:00:00+07:00`)))) {
      throw new DomainError('PERFORMANCE_GUARANTEE_MISSING', 422, 'guarantee');
    }
    if (requiresPermitGate(contract.advanceCategory)) await this.gates.assertPasses(tx, contract.projectId, ACTIVATION_GATE, effectiveFrom);
    if (contract.allocationLineId === null) throw new DomainError('FUND_COMMIT_FAILED', 422, 'allocation_line_id', { extensions: { cause: 'NO_ALLOCATION_LINE' } });
    let commitment: CommitmentOutcome;
    try {
      commitment = await hooks.commit({ ...contract, allocationLineId: contract.allocationLineId });
    } catch (error) {
      if (error instanceof DomainError) throw new DomainError('FUND_COMMIT_FAILED', 422, 'allocation_line_id', { extensions: { cause: error.code, ...error.extensions } });
      throw error;
    }

    const revision = await this.firstRevision(tx, id);
    await tx.query(
      `update machvon.contract_revision
          set status = 'EFFECTIVE', valid_from = $2::date, decided_by = $3::uuid, decided_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [revision, effectiveFrom, actor],
    );
    await tx.query(
      `update machvon.contract
          set status = $2, effective_from = $3::date, activated_by = $4::uuid, current_revision_id = $5::uuid, status_reason = null, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, effectiveFrom, actor, revision],
    );
    await this.record(tx, id, contract.status, to, reason, effectiveFrom, ACTIVATE_COMMAND, actor);
    return {
      ...this.result(contract, to, reason),
      effectiveFrom,
      revisionId: revision,
      committedVnd: contract.contractValueVnd,
      allocationLineId: contract.allocationLineId,
      evidenceIds,
      commitment,
    };
  }

  /** The version of a contract inside a scope, without taking the row: what a cached summary is keyed by. Undefined outside the scope. */
  async versionIn(tx: TenantTx, id: string, scope: ContractScopes['read']): Promise<number | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<{ version: string }>(`select c.version::text as version from ${SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : Number(rows[0].version);
  }

  /** The conditions of the activation as they stand now, read without a lock. */
  async readiness(tx: TenantTx, id: string, on: string): Promise<ActivationReadiness | undefined> {
    const rows = await tx.query<{ project_id: string; advance_category: string; contract_value_vnd: string; project_status: string; allocation_line_id: string | null }>(
      `select c.project_id, c.advance_category, c.contract_value_vnd::text as contract_value_vnd, p.status as project_status, k.allocation_line_id
         from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         left join machvon.procurement_package k on k.tenant_id = c.tenant_id and k.id = c.package_id
        where c.id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const boq = await tx.query<{ boq_total: string }>(
      `select coalesce(sum(l.amount_vnd), 0)::text as boq_total from machvon.contract_revision r left join machvon.boq_line l on l.tenant_id = r.tenant_id and l.contract_revision_id = r.id
        where r.contract_id = $1::uuid and r.status in ('DRAFT', 'EFFECTIVE') group by r.id, r.revision order by r.revision limit 1`,
      [id],
    );
    const boqTotal = boq[0]?.boq_total ?? '0';
    const guaranteeRequired = requiresPerformanceGuarantee(row.advance_category);
    const gateRequired = requiresPermitGate(row.advance_category);
    const evaluation = gateRequired ? await this.gates.evaluate(tx, row.project_id, ACTIVATION_GATE, on) : undefined;
    return {
      boq: { totalVnd: boqTotal, balanced: compareDecimal(boqTotal, row.contract_value_vnd) === 0 },
      guarantee: { required: guaranteeRequired, held: guaranteeRequired ? await this.guarantees.holdsActive(tx, id, 'PERFORMANCE', new Date(`${on}T00:00:00+07:00`)) : false },
      permitGate: {
        required: gateRequired,
        status: evaluation === undefined ? 'NOT_REQUIRED' : evaluation.status,
        blocking: evaluation === undefined ? [] : evaluation.verdicts.filter((verdict) => verdict.outcome === 'BLOCKING').map((verdict) => verdict.permitTypeCode),
      },
      capital: { allocationLineId: row.allocation_line_id },
      project: { status: row.project_status, inImplementation: row.project_status === ACTIVATION_PROJECT_STATUS },
    };
  }

  // ---- the steps every command shares -----------------------------------------------------------------------------

  /** The contract held for update inside the scope of the command, at the version the caller saw, with what the commands judge on. */
  private async hold(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockedRow> {
    const locked = await this.contracts.lock(tx, id, scopes);
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    const rows = await tx.query<LockSql>(
      `select c.code, c.advance_category, c.created_by, c.submitted_by, c.signed_on::text as signed_on, p.status as project_status, p.owner_unit_id, ou.path as owner_unit_path,
              k.allocation_line_id
         from machvon.contract c
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.procurement_package k on k.tenant_id = c.tenant_id and k.id = c.package_id
        where c.id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      id,
      code: row.code,
      projectId: locked.projectId,
      packageId: locked.packageId,
      contractorId: locked.contractorId,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      contractValueVnd: locked.contractValueVnd,
      advanceCategory: row.advance_category,
      version: locked.version,
      status: locked.status,
      isJointVenture: locked.isJointVenture,
      estimateCeilingVnd: locked.estimateCeilingVnd,
      createdBy: row.created_by,
      submittedBy: row.submitted_by,
      signedOn: row.signed_on,
      projectStatus: row.project_status,
      allocationLineId: row.allocation_line_id,
    };
  }

  /** 409 `CONFLICT_OF_INTEREST_BLOCKED` when the caller declared a relation with the contractor (of the package, or of the contractor wherever it was declared) that was not allowed. */
  private async assertFree(tx: TenantTx, member: string, contract: LockedRow, role: 'ACTOR' | 'REVIEWER'): Promise<void> {
    const declaration = await this.conflicts.blockingDeclaration(tx, member, contract.contractorId, contract.packageId);
    if (declaration !== undefined) throw this.blocked(declaration.id, contract, role);
  }

  private blocked(declarationId: string | undefined, contract: LockedRow, role: 'ACTOR' | 'REVIEWER'): DomainError {
    return new DomainError('CONFLICT_OF_INTEREST_BLOCKED', 409, role === 'ACTOR' ? 'actor' : 'conflict_decision_ref', {
      extensions: { contractor_id: contract.contractorId, declaration_id: declarationId ?? null, conflict_of: role },
    });
  }

  /** The bill of quantities of the draft revision adds up to the value of the contract (BR-CTR-02). */
  private async assertBoqBalanced(tx: TenantTx, contract: LockedRow): Promise<void> {
    const rows = await tx.query<{ boq_total: string; amount: string }>(
      `select coalesce(sum(l.amount_vnd), 0)::text as boq_total, r.amount_vnd::text as amount
         from machvon.contract_revision r
         left join machvon.boq_line l on l.tenant_id = r.tenant_id and l.contract_revision_id = r.id
        where r.contract_id = $1::uuid and r.status = 'DRAFT'
        group by r.id, r.amount_vnd`,
      [contract.id],
    );
    const row = rows[0];
    if (row === undefined || compareDecimal(row.boq_total, contract.contractValueVnd) !== 0 || compareDecimal(row.amount, contract.contractValueVnd) !== 0) {
      throw new DomainError('BOQ_TOTAL_MISMATCH', 422, 'boq', { extensions: { boq_total_vnd: row?.boq_total ?? '0', contract_value_vnd: contract.contractValueVnd } });
    }
  }

  private async assertCleanDocument(tx: TenantTx, versionId: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string; sealed: boolean }>(
      `select v.scan_status, (d.subject_module = 'BID_PROPOSAL') as sealed
         from machvon.document_version v join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id where v.id = $1::uuid`,
      [versionId],
    );
    const row = rows[0];
    // A sealed bid is not a signed contract, and what is not a file of the tenant is not a file at all.
    if (row === undefined || row.sealed) throw invalid('signed_document_version_id');
    if (row.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'signed_document_version_id', { extensions: { scan_status: row.scan_status } });
  }

  private async assertDocuments(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.query<{ id: string }>('select id from machvon.document where id = any($1::uuid[])', [ids]);
    if (rows.length !== ids.length) throw invalid('evidence_ids');
  }

  private async firstRevision(tx: TenantTx, contractId: string): Promise<string> {
    const rows = await tx.query<{ id: string }>(`select id from machvon.contract_revision where contract_id = $1::uuid and status = 'DRAFT' order by revision limit 1 for update`, [contractId]);
    if (rows[0] === undefined) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'revision');
    return rows[0].id;
  }

  private async record(tx: TenantTx, id: string, from: ContractStatus, to: ContractStatus, reason: string, effectiveOn: string, command: string, actor: string, documentVersionId?: string): Promise<void> {
    await tx.query(
      `insert into machvon.contract_status_change (tenant_id, id, contract_id, from_status, to_status, reason, decision_document_version_id, effective_on, command, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::date, $8, $9::uuid)`,
      [randomUUID(), id, from, to, reason, documentVersionId ?? null, effectiveOn, command, actor],
    );
  }

  private result(contract: LockedRow, to: ContractStatus, reason: string): LifecycleResult {
    return {
      id: contract.id,
      code: contract.code,
      projectId: contract.projectId,
      packageId: contract.packageId,
      contractorId: contract.contractorId,
      fromStatus: contract.status,
      status: to,
      version: contract.version + 1,
      reason,
    };
  }
}
