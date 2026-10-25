import { randomUUID } from 'node:crypto';
import {
  DomainError,
  MAX_EXTENSION_DAYS,
  MAX_LIFECYCLE_TEXT,
  assertContractClosure,
  assertContractTransition,
  assertDayBetween,
  assertNotMaker,
  assertNotProposer,
  compareDecimal,
  guaranteeActionOf,
  requiresPerformanceGuarantee,
  requiresPermitGate,
  signingConflict,
  terminationSuggestion,
  unmetClosureGuards,
  versionConflict,
} from '@machvon/kernel';
import type { ClosureFacts, ClosureGuard, ContractStatus, GuaranteeAction, TerminationSuggestion } from '@machvon/kernel';
import { BidConflictStore } from './bid-conflict-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { CtrContractStore, SCOPE_FROM, calendarDate, partiesCheck, textOf } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { decisionDocument } from './ctr-decision-document.ts';
import { CtrGuaranteeStore } from './ctr-guarantee-store.ts';
import type { GuaranteeMove } from './ctr-guarantee-store.ts';
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
const SUSPEND_COMMAND = 'suspendContract';
const RESUME_COMMAND = 'resumeContract';
const TERMINATE_COMMAND = 'terminateContract';
const COMPLETE_COMMAND = 'completeContract';
const CLOSE_COMMAND = 'closeContract';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

export interface ContractSuspendInput {
  reason: string;
  /** Absent when the request names none: refused as 422 `DECISION_DOCUMENT_REQUIRED`. */
  decisionDocumentVersionId?: string | undefined;
  /** `YYYY-MM-DD`. */
  suspendedFrom: string;
}

export interface ContractResumeInput {
  reason: string;
  decisionDocumentVersionId?: string | undefined;
  /** `YYYY-MM-DD`. */
  resumedOn: string;
  /** A request to extend the schedule by this many days; the due date moves only through an approved extension revision. */
  extensionDays?: number | undefined;
}

export interface ContractTerminateInput {
  reason: string;
  decisionDocumentVersionId?: string | undefined;
  /** `YYYY-MM-DD`. */
  terminatedOn: string;
  guaranteeAction: string;
}

export interface ContractSuspendResult extends LifecycleResult {
  suspendedFrom: string;
  decisionDocumentVersionId: string;
}

export interface ContractResumeResult extends LifecycleResult {
  resumedOn: string;
  extensionDays: number | null;
  decisionDocumentVersionId: string;
}

export interface ContractTerminateResult extends LifecycleResult {
  terminatedOn: string;
  guaranteeAction: GuaranteeAction;
  /** The performance guarantees the termination called or released. */
  guarantees: GuaranteeMove[];
  /** The violation suggested for the contractor. */
  violationId: string;
  /** The advance that is still owed: it stays on the contract for the settlement. */
  advanceOutstandingVnd: string;
  decisionDocumentVersionId: string;
}

export interface ContractCompleteInput {
  completionQualityAcceptanceId: string;
  /** `YYYY-MM-DD`. */
  completedOn: string;
}

export interface ContractCompleteResult extends LifecycleResult {
  completedOn: string;
  completionQualityAcceptanceId: string;
  completionRecordNo: string;
}

export interface ContractCloseInput {
  /** The settlement of the project or of the contract that closed. */
  settlementRevisionId: string;
  note?: string | undefined;
}

export interface ContractCloseResult extends LifecycleResult {
  settlementRevisionId: string;
  /** The advance still owed when the contract was closed: nothing, or carried by the exception of the settlement. */
  advanceOutstandingVnd: string;
  settlementExcepted: boolean;
}

/** What stands between a contract that was completed or terminated and its closure, as it stands now (the command judges it again). */
export interface ClosureReadiness {
  /** The settlements that are closed and could serve (of the contract, or of its whole project), the latest first. */
  settlements: Array<{ id: string; scope: string; revision: number; excepted: boolean }>;
  advanceOutstandingVnd: string;
  /** The holds of retention with something still held that nothing carries (the warranty carries what waits for its end while it runs). */
  retention: { holds: number; unresolvedVnd: string };
  /** The guards that are not met now, judged against the latest settlement that could serve. */
  unmet: ClosureGuard[];
}

/** What stands between a contract that is being performed and its completion, as it stands now (the commands judge it again). */
export interface CompletionReadiness {
  /** The completion acceptance minutes of the contract that are approved: the ones the completion can rest on. */
  acceptances: Array<{ id: string; recordNo: string; approvedOn: string }>;
  /** The serious non-conformances of the contract that are not closed. */
  openCriticalNcrIds: string[];
  /** The measurements of the contract that are submitted and not yet decided. */
  pendingMeasurementIds: string[];
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

  /**
   * ACTIVE to SUSPENDED (CTR 3.2). The reason, the decision document and the day the suspension begins are the record of it (the CHECK `contract_status_reason_chk` holds the first two).
   * New quantities and new advances stop while the contract is suspended (`acceptsNewWork`); what the payments may still do is the matrix of PAY (BR-PAY-09), which reads
   * `suspended_from`. The day is not before the contract took effect and not in the future.
   */
  async suspend(tx: TenantTx, id: string, expectedVersion: number, input: ContractSuspendInput, actor: string, scopes: ContractScopes, today: string): Promise<ContractSuspendResult> {
    const reason = textOf(input.reason, 'reason', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(SUSPEND_COMMAND, contract.status);
    const decision = await this.decision(tx, input.decisionDocumentVersionId);
    const suspendedFrom = calendarDate(input.suspendedFrom, 'suspended_from');
    const standing = await this.standing(tx, id);
    assertDayBetween('suspended_from', suspendedFrom, standing.effectiveFrom, today);
    await tx.query(
      `update machvon.contract
          set status = $2, status_reason = $3, status_decision_document_version_id = $4::uuid, suspended_from = $5::date, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, reason, decision.versionId, suspendedFrom, actor],
    );
    await this.record(tx, id, contract.status, to, reason, suspendedFrom, SUSPEND_COMMAND, actor, decision.versionId);
    return { ...this.result(contract, to, reason), suspendedFrom, decisionDocumentVersionId: decision.versionId };
  }

  /**
   * SUSPENDED back to ACTIVE, on a document. The extension of the schedule that may come with it is a request and nothing more: the due date moves only through an approved
   * extension revision of the contract (CTR 3.2), so `extension_days` is kept in the history and the event and `completion_due` is left as it is.
   */
  async resume(tx: TenantTx, id: string, expectedVersion: number, input: ContractResumeInput, actor: string, scopes: ContractScopes, today: string): Promise<ContractResumeResult> {
    const reason = textOf(input.reason, 'reason', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(RESUME_COMMAND, contract.status);
    const decision = await this.decision(tx, input.decisionDocumentVersionId);
    const resumedOn = calendarDate(input.resumedOn, 'resumed_on');
    const extensionDays = input.extensionDays;
    if (extensionDays !== undefined && (!Number.isInteger(extensionDays) || extensionDays < 1 || extensionDays > MAX_EXTENSION_DAYS)) throw invalid('extension_days');
    const standing = await this.standing(tx, id);
    assertDayBetween('resumed_on', resumedOn, standing.suspendedFrom ?? standing.effectiveFrom, today);
    await tx.query(
      `update machvon.contract
          set status = $2, status_reason = null, status_decision_document_version_id = null, suspended_from = null, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, actor],
    );
    const note = extensionDays === undefined ? reason : `${reason} (extension of ${extensionDays} days requested)`;
    await this.record(tx, id, contract.status, to, note, resumedOn, RESUME_COMMAND, actor, decision.versionId);
    return { ...this.result(contract, to, reason), resumedOn, extensionDays: extensionDays ?? null, decisionDocumentVersionId: decision.versionId };
  }

  /**
   * SIGNED, ACTIVE or SUSPENDED to TERMINATED, for good (CTR 3.2). The end is proposed by one person and decided by another: whoever made the decision document, drafted the contract or
   * sent it to review is refused (403 `SELF_APPROVAL_DENIED`), and the approver is within the delegation limit of the matrix like the signer. The performance guarantee is called,
   * released or held as the decision says; the advance that is still owed stays on the contract for the settlement; and one violation is suggested for the contractor (RECORDED, for a
   * person to confirm with a decision), once for the contract.
   */
  async terminate(tx: TenantTx, id: string, expectedVersion: number, input: ContractTerminateInput, actor: string, scopes: ContractScopes, today: string, hooks: Pick<LifecycleHooks, 'authorise'>): Promise<ContractTerminateResult> {
    const reason = textOf(input.reason, 'reason', MAX_LIFECYCLE_TEXT);
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(TERMINATE_COMMAND, contract.status);
    const decision = await this.decision(tx, input.decisionDocumentVersionId);
    assertNotProposer(actor, [decision.maker, contract.createdBy, contract.submittedBy]);
    await hooks.authorise(contract);
    const terminatedOn = calendarDate(input.terminatedOn, 'terminated_on');
    const action = guaranteeActionOf(input.guaranteeAction);
    if (action === undefined) throw invalid('guarantee_action');
    const standing = await this.standing(tx, id);
    const earliest = [contract.signedOn, standing.suspendedFrom].filter((day): day is string => day !== null).sort().at(-1) ?? null;
    assertDayBetween('terminated_on', terminatedOn, earliest, today);
    const guarantees = await this.guarantees.settle(tx, id, action, { documentVersionId: decision.versionId, reason }, actor, new Date(`${today}T00:00:00+07:00`));
    await tx.query(
      `update machvon.contract
          set status = $2, status_reason = $3, status_decision_document_version_id = $4::uuid, terminated_on = $5::date, terminated_by = $6::uuid,
              updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, reason, decision.versionId, terminatedOn, actor],
    );
    await this.record(tx, id, contract.status, to, reason, terminatedOn, TERMINATE_COMMAND, actor, decision.versionId);
    const violationId = await this.suggestViolation(tx, contract, terminationSuggestion({ contractId: id, terminatedOn, reason, decisionDocumentVersionId: decision.versionId }), actor);
    return { ...this.result(contract, to, reason), terminatedOn, guaranteeAction: action, guarantees, violationId, advanceOutstandingVnd: standing.advanceOutstandingVnd, decisionDocumentVersionId: decision.versionId };
  }

  /**
   * ACTIVE to COMPLETED (CTR 3.2, BR-CTR-09): a contract is completed on the completion acceptance minutes that were approved, and not while a serious non-conformance of the contract is open or a
   * measurement of it waits to be decided. The guards are judged in that order, so the person is told the first thing that stands in the way (422 `COMPLETION_ACCEPTANCE_REQUIRED`, 422
   * `OPEN_CRITICAL_NCR` with the identifiers, 422 `MEASUREMENT_PENDING` with the identifiers). The day is not before the contract took effect nor before the minutes were approved, and not in the future.
   */
  async complete(tx: TenantTx, id: string, expectedVersion: number, input: ContractCompleteInput, actor: string, scopes: ContractScopes, today: string): Promise<ContractCompleteResult> {
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(COMPLETE_COMMAND, contract.status);
    const acceptanceId = input.completionQualityAcceptanceId.trim().toLowerCase();
    if (!UUID.test(acceptanceId)) throw invalid('completion_quality_acceptance_id');
    const completedOn = calendarDate(input.completedOn, 'completed_on');
    const minutes = await this.completionMinutes(tx, id, acceptanceId);
    const readiness = await this.completionReadiness(tx, id);
    if (readiness.openCriticalNcrIds.length > 0) throw new DomainError('OPEN_CRITICAL_NCR', 422, 'id', { extensions: { nonconformance_ids: readiness.openCriticalNcrIds } });
    if (readiness.pendingMeasurementIds.length > 0) throw new DomainError('MEASUREMENT_PENDING', 422, 'id', { extensions: { measurement_ids: readiness.pendingMeasurementIds } });
    const standing = await this.standing(tx, id);
    const earliest =
      [standing.effectiveFrom, minutes.approvedOn]
        .filter((day): day is string => day !== null)
        .sort()
        .at(-1) ?? null;
    assertDayBetween('completed_on', completedOn, earliest, today);
    const reason = `Completed on the acceptance ${minutes.recordNo}`;
    await tx.query(
      `update machvon.contract
          set status = $2, completed_on = $3::date, completion_quality_acceptance_id = $4::uuid, completed_by = $5::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, to, completedOn, acceptanceId, actor],
    );
    await this.record(tx, id, contract.status, to, reason, completedOn, COMPLETE_COMMAND, actor, minutes.documentVersionId);
    return { ...this.result(contract, to, reason), completedOn, completionQualityAcceptanceId: acceptanceId, completionRecordNo: minutes.recordNo };
  }

  /** The completion minutes the command names: of this contract, for the completion of the work, approved. */
  private async completionMinutes(tx: TenantTx, contractId: string, acceptanceId: string): Promise<{ recordNo: string; documentVersionId: string; approvedOn: string }> {
    const rows = await tx.query<{ record_no: string; document_version_id: string; acceptance_scope: string; status: string; approved_on: string | null }>(
      `select record_no, document_version_id, acceptance_scope, status, (approved_at at time zone 'Asia/Ho_Chi_Minh')::date::text as approved_on
         from machvon.quality_acceptance where id = $1::uuid and contract_id = $2::uuid`,
      [acceptanceId, contractId],
    );
    const row = rows[0];
    const refuse = (reason: string): DomainError => new DomainError('COMPLETION_ACCEPTANCE_REQUIRED', 422, 'completion_quality_acceptance_id', { extensions: { reason } });
    if (row === undefined) throw refuse('MISSING');
    if (row.acceptance_scope !== 'COMPLETION') throw refuse('NOT_COMPLETION');
    if (row.status !== 'APPROVED' || row.approved_on === null) throw refuse('NOT_APPROVED');
    return { recordNo: row.record_no, documentVersionId: row.document_version_id, approvedOn: row.approved_on };
  }

  /**
   * Closes a contract that was completed or terminated (CTR section 4, UAT-AC300): its settlement is closed, no advance is left unrecovered unless that settlement carries the exception approved for it,
   * and the retention is resolved. The first guard that is not met is the answer (422), with the list of all of them, and the contract keeps its status.
   */
  async close(tx: TenantTx, id: string, expectedVersion: number, input: ContractCloseInput, actor: string, scopes: ContractScopes, today: string): Promise<ContractCloseResult> {
    const contract = await this.hold(tx, id, expectedVersion, scopes);
    await this.assertFree(tx, actor, contract, 'ACTOR');
    const to = assertContractTransition(CLOSE_COMMAND, contract.status);
    const settlementId = input.settlementRevisionId.trim().toLowerCase();
    if (!UUID.test(settlementId)) throw invalid('settlement_revision_id');
    const note = input.note === undefined ? null : textOf(input.note, 'note', MAX_LIFECYCLE_TEXT);
    const settlement = await this.settlementOf(tx, contract, settlementId);
    const facts = await this.closureFacts(tx, contract, settlement);
    assertContractClosure(facts);
    const reason = note ?? 'Closed after the settlement';
    await tx.query('update machvon.contract set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [id, to, actor]);
    await this.record(tx, id, contract.status, to, reason, today, CLOSE_COMMAND, actor);
    return { ...this.result(contract, to, reason), settlementRevisionId: settlementId, advanceOutstandingVnd: facts.advanceOutstandingVnd, settlementExcepted: settlement?.excepted === true };
  }

  /** The settlement the command names, which has to be one that covers the contract: its own, or the one of its whole project. */
  private async settlementOf(tx: TenantTx, contract: LockedRow, settlementId: string): Promise<{ status: string; excepted: boolean } | undefined> {
    const rows = await tx.query<{ status: string; settlement_scope: string; contract_id: string | null; project_id: string; excepted: boolean }>(
      'select status, settlement_scope, contract_id, project_id, (exception_approved_by is not null) as excepted from machvon.settlement_revision where id = $1::uuid',
      [settlementId],
    );
    const row = rows[0];
    const refuse = (reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, 'settlement_revision_id', { extensions: { reason } });
    if (row === undefined) throw refuse('NOT_FOUND');
    const covers = (row.settlement_scope === 'CONTRACT' && row.contract_id === contract.id) || (row.settlement_scope === 'PROJECT' && row.project_id === contract.projectId);
    if (!covers) throw refuse('NOT_A_SETTLEMENT_OF_THE_CONTRACT');
    return { status: row.status, excepted: row.excepted };
  }

  /** The facts a closure is judged on: the settlement, the advance still owed and the retention that nothing carries (a hold that waits for the end of the warranty is carried while a warranty obligation of the contract runs). */
  private async closureFacts(tx: TenantTx, contract: Pick<LockedRow, 'id'>, settlement: ClosureFacts['settlement']): Promise<ClosureFacts> {
    const standing = await this.standing(tx, contract.id);
    const retention = (
      await tx.query<{ holds: string; unresolved: string }>(
        `select count(*)::text as holds, coalesce(sum(h.held_vnd - h.released_vnd), 0)::text as unresolved
           from machvon.retention_hold h
          where h.contract_id = $1::uuid and h.status in ('HELD', 'PARTIALLY_RELEASED') and h.held_vnd > h.released_vnd
            and not (h.release_condition = 'WARRANTY_END'
                     and exists (select 1 from machvon.warranty_obligation w where w.tenant_id = h.tenant_id and w.contract_id = h.contract_id and w.status <> 'CLOSED'))`,
        [contract.id],
      )
    )[0];
    return { settlement, advanceOutstandingVnd: standing.advanceOutstandingVnd, retention: { holds: Number(retention?.holds ?? 0), unresolvedVnd: retention?.unresolved ?? '0' } };
  }

  /** What stands between the contract and its closure, read without a lock. */
  async closureReadiness(tx: TenantTx, id: string): Promise<ClosureReadiness> {
    const settlements = await tx.query<{ id: string; settlement_scope: string; revision: number; excepted: boolean }>(
      `select s.id, s.settlement_scope, s.revision, (s.exception_approved_by is not null) as excepted
         from machvon.settlement_revision s join machvon.contract c on c.tenant_id = s.tenant_id and c.id = $1::uuid
        where s.status = 'CLOSED' and ((s.settlement_scope = 'CONTRACT' and s.contract_id = c.id) or (s.settlement_scope = 'PROJECT' and s.project_id = c.project_id))
        order by s.closed_at desc nulls last, s.id limit 20`,
      [id],
    );
    const latest = settlements[0];
    const facts = await this.closureFacts(tx, { id }, latest === undefined ? undefined : { status: 'CLOSED', excepted: latest.excepted });
    return {
      settlements: settlements.map((row) => ({ id: row.id, scope: row.settlement_scope, revision: row.revision, excepted: row.excepted })),
      advanceOutstandingVnd: facts.advanceOutstandingVnd,
      retention: facts.retention,
      unmet: unmetClosureGuards(facts),
    };
  }

  /** The conditions of the completion as they stand now, read without a lock; the identifiers are the first twenty of each kind. */
  async completionReadiness(tx: TenantTx, id: string): Promise<CompletionReadiness> {
    const acceptances = await tx.query<{ id: string; record_no: string; approved_on: string }>(
      `select id, record_no, (approved_at at time zone 'Asia/Ho_Chi_Minh')::date::text as approved_on from machvon.quality_acceptance
        where contract_id = $1::uuid and acceptance_scope = 'COMPLETION' and status = 'APPROVED' order by approved_at desc, id limit 20`,
      [id],
    );
    const ncrs = await tx.query<{ id: string }>("select id from machvon.quality_nonconformance where contract_id = $1::uuid and blocks_acceptance and status <> 'CLOSED' order by id limit 20", [id]);
    const measurements = await tx.query<{ id: string }>("select id from machvon.measurement where contract_id = $1::uuid and status = 'SUBMITTED' order by id limit 20", [id]);
    return {
      acceptances: acceptances.map((row) => ({ id: row.id, recordNo: row.record_no, approvedOn: row.approved_on })),
      openCriticalNcrIds: ncrs.map((row) => row.id),
      pendingMeasurementIds: measurements.map((row) => row.id),
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

  /**
   * The decision document a suspension, a resumption or a termination rests on: a version of a file of the tenant that is not infected and not a sealed bid. Without one, or with one that
   * is none of these, the command is refused with 422 `DECISION_DOCUMENT_REQUIRED`. `maker` is whoever made the document: one of the people who proposed what it decides.
   */
  private decision(tx: TenantTx, versionId: string | undefined): Promise<{ versionId: string; maker: string }> {
    return decisionDocument(tx, versionId, 'decision_document_version_id');
  }

  /** The days and the figures of a contract that the suspension, the resumption and the termination are judged on, read under the lock the command holds. */
  private async standing(tx: TenantTx, id: string): Promise<{ effectiveFrom: string | null; suspendedFrom: string | null; advanceOutstandingVnd: string }> {
    const rows = await tx.query<{ effective_from: string | null; suspended_from: string | null; advance_outstanding_vnd: string }>(
      'select effective_from::text as effective_from, suspended_from::text as suspended_from, advance_outstanding_vnd::text as advance_outstanding_vnd from machvon.contract where id = $1::uuid',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { effectiveFrom: row.effective_from, suspendedFrom: row.suspended_from, advanceOutstandingVnd: row.advance_outstanding_vnd };
  }

  /** Writes the violation a termination suggests: RECORDED, resting on the decision document, with no penalty amount; a person confirms it with a decision of their own. */
  private async suggestViolation(tx: TenantTx, contract: LockedRow, suggestion: TerminationSuggestion, actor: string): Promise<string> {
    const violationId = randomUUID();
    await tx.query(
      `insert into machvon.contractor_violation
         (tenant_id, id, contract_id, contractor_id, violation_kind, severity, occurred_on, description, penalty_kind, penalty_amount_vnd, decision_document_version_id, source_module, source_ref_id, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8, $9::numeric, $10::uuid, $11, $12::uuid, 'RECORDED', $13::uuid, $13::uuid)`,
      [
        violationId,
        contract.id,
        contract.contractorId,
        suggestion.violationKind,
        suggestion.severity,
        suggestion.occurredOn,
        suggestion.description,
        suggestion.penaltyKind,
        suggestion.penaltyAmountVnd,
        suggestion.decisionDocumentVersionId,
        suggestion.sourceModule,
        suggestion.sourceRefId,
        actor,
      ],
    );
    return violationId;
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
