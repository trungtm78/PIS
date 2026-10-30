import {
  DomainError,
  assertEvaluable,
  assertNotTheAuthor,
  assertViolable,
  needsDecisionDocument,
  overallScoreOf,
  ratingOf,
  versionConflict,
} from '@machvon/kernel';
import type { ConfirmationInput, EvaluationInput, EvaluationKind, PenaltyKind, Rating, Scores, Severity, ViolationInput, ViolationKind, ViolationSource } from '@machvon/kernel';
import { decisionDocument } from './ctr-decision-document.ts';
import { CtrContractStore, SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const EVALUATE_PERMISSION = 'contractor.performance.evaluate';
export const APPROVE_PERMISSION = 'contractor.performance.approve';
export const READ_PERMISSION = 'contractor.performance.read';
export const RECORD_PERMISSION = 'contractor.violation.record';
export const CONFIRM_PERMISSION = 'contractor.violation.confirm';

const LIST_MAX = 500;

type EvaluationStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'SUPERSEDED';
type ViolationStatus = 'RECORDED' | 'CONFIRMED' | 'APPEALED' | 'REVOKED';

/** What a command of the scorecard did, for the answer, the trail and the event: ids, the contract and the figures; never the words of the people. */
export interface EvaluationResult {
  id: string;
  version: number;
  status: EvaluationStatus;
  contractId: string;
  contractCode: string;
  projectId: string;
  contractorId: string;
  kind: EvaluationKind;
  periodLabel: string;
  revision: number;
  overallScore: string;
  rating: Rating;
  supersededId: string | null;
}

export interface ViolationResult {
  id: string;
  version: number;
  status: ViolationStatus;
  contractId: string;
  contractCode: string;
  projectId: string;
  contractorId: string;
  kind: ViolationKind;
  severity: Severity;
  sourceModule: ViolationSource;
  penaltyKind: PenaltyKind;
  penaltyAmountVnd: string;
  decisionDocumentVersionId: string | null;
}

export interface EvaluationLine {
  id: string;
  contractId: string;
  contractCode: string;
  kind: EvaluationKind;
  periodLabel: string;
  revision: number;
  scores: Scores;
  overallScore: string;
  rating: Rating;
  status: EvaluationStatus;
  evaluatedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesId: string | null;
  remarks: string | null;
  approvalNote: string | null;
  createdAt: string;
  version: number;
  place: ContractPlace;
}

export interface ViolationLine {
  id: string;
  contractId: string;
  contractCode: string;
  kind: ViolationKind;
  severity: Severity;
  occurredOn: string;
  description: string;
  evidenceDocumentVersionId: string | null;
  penaltyKind: PenaltyKind;
  penaltyAmountVnd: string;
  decisionDocumentVersionId: string | null;
  sourceModule: ViolationSource;
  sourceRefId: string | null;
  status: ViolationStatus;
  recordedBy: string;
  confirmedAt: string | null;
  createdAt: string;
  version: number;
  place: ContractPlace;
}

export interface ScorecardRange {
  from: string | undefined;
  to: string | undefined;
}

/** A contract of the contractor that the caller reads: what the screen offers to evaluate or to record a violation on. */
export interface ScorecardContract {
  id: string;
  code: string;
  status: string;
  place: ContractPlace;
}

export interface Scorecard {
  contractor: { id: string; legalName: string };
  contracts: ScorecardContract[];
  evaluations: EvaluationLine[];
  violations: ViolationLine[];
  summary: { approvedCount: number; averageOverallScore: string | null; confirmedViolations: Record<Severity, number>; evaluationCount: number; violationCount: number };
}

interface PlaceSql {
  contract_id: string;
  contract_code: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface EvaluationSql extends PlaceSql {
  id: string;
  evaluation_kind: EvaluationKind;
  period_label: string;
  revision: number;
  score_quality: number;
  score_schedule: number;
  score_safety_env: number;
  score_cooperation: number;
  score_financial: number;
  overall_score: string;
  rating: Rating;
  status: EvaluationStatus;
  evaluated_by: string;
  approved_by: string | null;
  approved_at: string | null;
  supersedes_id: string | null;
  remarks: string | null;
  approval_note: string | null;
  created_at: string;
  version: string;
}

interface ViolationSql extends PlaceSql {
  id: string;
  violation_kind: ViolationKind;
  severity: Severity;
  occurred_on: string;
  description: string;
  evidence_document_version_id: string | null;
  penalty_kind: PenaltyKind;
  penalty_amount_vnd: string;
  decision_document_version_id: string | null;
  source_module: ViolationSource;
  source_ref_id: string | null;
  status: ViolationStatus;
  created_by: string;
  confirmed_at: string | null;
  created_at: string;
  version: string;
}

const placeOf = (row: PlaceSql): ContractPlace => ({
  contractId: row.contract_id,
  projectId: row.project_id,
  ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
  investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
});

const PLACE_COLUMNS = `c.id as contract_id, c.code as contract_code, c.project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path`;

const EVALUATION_COLUMNS = `e.id, e.evaluation_kind, e.period_label, e.revision, e.score_quality, e.score_schedule, e.score_safety_env, e.score_cooperation, e.score_financial, e.overall_score::text as overall_score,
  e.rating, e.status, e.evaluated_by, e.approved_by, ${TIMESTAMP('e.approved_at')} as approved_at, e.supersedes_id, e.remarks, e.approval_note, ${TIMESTAMP('e.created_at')} as created_at, e.version::text as version`;

const VIOLATION_COLUMNS = `v.id, v.violation_kind, v.severity, v.occurred_on::text as occurred_on, v.description, v.evidence_document_version_id, v.penalty_kind, v.penalty_amount_vnd::text as penalty_amount_vnd,
  v.decision_document_version_id, v.source_module, v.source_ref_id, v.status, v.created_by, ${TIMESTAMP('v.confirmed_at')} as confirmed_at, ${TIMESTAMP('v.created_at')} as created_at, v.version::text as version`;

const DAY_VN = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date`;

const scoresOf = (row: EvaluationSql): Scores => ({ quality: row.score_quality, schedule: row.score_schedule, safetyEnv: row.score_safety_env, cooperation: row.score_cooperation, financial: row.score_financial });

/**
 * The scorecard of a contractor and the log of its violations (ST-CTR-014, CTR 3.6, BR-CTR-11). An evaluation is made on a contract the caller holds `contractor.performance.evaluate` over, with five scores that the rule `CTR.SCORECARD` weights into
 * an overall score and a rating; it is approved by another person (403 `SELF_APPROVAL_DENIED`), and approving a new one for a period that was approved before supersedes the old one. A violation is recorded on a contract that has
 * started and confirmed by another person; a sanction is confirmed only with a document of decision (422 `DECISION_DOCUMENT_REQUIRED`). Every command locks the contract first, as every command that moves what a contract holds does.
 */
export class CtrScorecardStore {
  private readonly contracts: CtrContractStore;

  constructor(contracts: CtrContractStore = new CtrContractStore()) {
    this.contracts = contracts;
  }

  private async contractHeader(tx: TenantTx, contractId: string): Promise<{ code: string; projectId: string; status: string; contractorId: string }> {
    const [row] = await tx.query<{ code: string; project_id: string; status: string; contractor_id: string }>('select code, project_id, status, contractor_id from machvon.contract where id = $1::uuid', [contractId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { code: row.code, projectId: row.project_id, status: row.status, contractorId: row.contractor_id };
  }

  /** Makes an evaluation of a contract, waiting for approval. One that waits already for the same kind and period is 409 `EVALUATION_DUPLICATE`; one that was approved is replaced by a new revision when this one is approved. */
  async evaluate(tx: TenantTx, contractId: string, input: EvaluationInput, actor: string, scopes: ContractScopes): Promise<EvaluationResult> {
    const locked = await this.contracts.lock(tx, contractId, scopes);
    assertEvaluable(input.kind, locked.status);
    const header = await this.contractHeader(tx, contractId);
    const [latest] = await tx.query<{ id: string; status: EvaluationStatus; revision: number }>(
      'select id, status, revision from machvon.contractor_performance where contract_id = $1::uuid and evaluation_kind = $2 and period_label = $3 order by revision desc limit 1 for update',
      [contractId, input.kind, input.periodLabel],
    );
    if (latest !== undefined && latest.status !== 'APPROVED') throw new DomainError('EVALUATION_DUPLICATE', 409, 'period_label');
    const overall = overallScoreOf(input.scores);
    const rating = ratingOf(input.scores);
    const revision = latest === undefined ? 1 : latest.revision + 1;
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.contractor_performance
         (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, remarks, status, evaluated_by, supersedes_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13, 'SUBMITTED', $14::uuid, $15::uuid, $14::uuid, $14::uuid)
       returning id`,
      [
        contractId,
        locked.contractorId,
        input.kind,
        input.periodLabel,
        revision,
        input.scores.quality,
        input.scores.schedule,
        input.scores.safetyEnv,
        input.scores.cooperation,
        input.scores.financial,
        overall,
        rating,
        input.remarks ?? null,
        actor,
        latest?.id ?? null,
      ],
    );
    return {
      id: (made as { id: string }).id,
      version: 1,
      status: 'SUBMITTED',
      contractId,
      contractCode: header.code,
      projectId: header.projectId,
      contractorId: locked.contractorId,
      kind: input.kind,
      periodLabel: input.periodLabel,
      revision,
      overallScore: overall,
      rating,
      supersededId: null,
    };
  }

  /** Approves an evaluation at the version read, by someone other than the one who made it; the one it replaces is superseded in the same step. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, note: string | undefined, actor: string, scopes: ContractScopes): Promise<EvaluationResult> {
    const [owner] = await tx.query<{ contract_id: string }>('select contract_id from machvon.contractor_performance where id = $1::uuid', [id]);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, owner.contract_id, scopes);
    const [row] = await tx.query<{ status: EvaluationStatus; version: string; evaluated_by: string; supersedes_id: string | null; contractor_id: string; evaluation_kind: EvaluationKind; period_label: string; revision: number; overall_score: string; rating: Rating }>(
      'select status, version::text as version, evaluated_by, supersedes_id, contractor_id, evaluation_kind, period_label, revision, overall_score::text as overall_score, rating from machvon.contractor_performance where id = $1::uuid for update',
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'SUBMITTED') throw new DomainError('EVALUATION_STATE_INVALID', 409, 'id');
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    assertNotTheAuthor(actor, row.evaluated_by);
    // The approval that stood for this period gives way first, so that one evaluation is approved for a period at a time.
    if (row.supersedes_id !== null) {
      await tx.query("update machvon.contractor_performance set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'APPROVED'", [row.supersedes_id, actor]);
    }
    await tx.query(
      "update machvon.contractor_performance set status = 'APPROVED', approved_by = $2::uuid, approved_at = now(), approval_note = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid",
      [id, actor, note ?? null],
    );
    const header = await this.contractHeader(tx, owner.contract_id);
    return {
      id,
      version: Number(row.version) + 1,
      status: 'APPROVED',
      contractId: owner.contract_id,
      contractCode: header.code,
      projectId: header.projectId,
      contractorId: row.contractor_id,
      kind: row.evaluation_kind,
      periodLabel: row.period_label,
      revision: row.revision,
      overallScore: row.overall_score,
      rating: row.rating,
      supersededId: row.supersedes_id,
    };
  }

  private async assertEvidence(tx: TenantTx, versionId: string): Promise<void> {
    const [row] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [versionId]);
    if (row === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_document_version_id');
    if (row.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'evidence_document_version_id');
  }

  /** Records a violation of the contractor on a contract that has started, waiting for confirmation. The evidence, if given, is a clean file of the tenant. */
  async record(tx: TenantTx, contractId: string, input: ViolationInput, actor: string, scopes: ContractScopes): Promise<ViolationResult> {
    const locked = await this.contracts.lock(tx, contractId, scopes);
    assertViolable(locked.status);
    if (input.evidenceDocumentVersionId !== undefined) await this.assertEvidence(tx, input.evidenceDocumentVersionId);
    const header = await this.contractHeader(tx, contractId);
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.contractor_violation
         (tenant_id, id, contract_id, contractor_id, violation_kind, severity, occurred_on, description, evidence_document_version_id, source_module, source_ref_id, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::date, $6, $7::uuid, $8, $9::uuid, 'RECORDED', $10::uuid, $10::uuid)
       returning id`,
      [contractId, locked.contractorId, input.kind, input.severity, input.occurredOn, input.description, input.evidenceDocumentVersionId ?? null, input.sourceModule, input.sourceRefId ?? null, actor],
    );
    return {
      id: (made as { id: string }).id,
      version: 1,
      status: 'RECORDED',
      contractId,
      contractCode: header.code,
      projectId: header.projectId,
      contractorId: locked.contractorId,
      kind: input.kind,
      severity: input.severity,
      sourceModule: input.sourceModule,
      penaltyKind: 'NONE',
      penaltyAmountVnd: '0',
      decisionDocumentVersionId: null,
    };
  }

  /**
   * Confirms a recorded violation with its sanction, at the version read, by someone other than the one who recorded it. A sanction needs the document that decides it (a version of a clean file of the tenant, given now or already on the
   * violation, as a termination leaves it): without one it is 422 `DECISION_DOCUMENT_REQUIRED` and the violation stays recorded.
   */
  async confirm(tx: TenantTx, id: string, expectedVersion: number, input: ConfirmationInput, actor: string, scopes: ContractScopes): Promise<ViolationResult> {
    const [owner] = await tx.query<{ contract_id: string }>('select contract_id from machvon.contractor_violation where id = $1::uuid', [id]);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, owner.contract_id, scopes);
    const [row] = await tx.query<{
      status: ViolationStatus;
      version: string;
      created_by: string;
      contractor_id: string;
      violation_kind: ViolationKind;
      severity: Severity;
      source_module: ViolationSource;
      decision_document_version_id: string | null;
    }>(
      'select status, version::text as version, created_by, contractor_id, violation_kind, severity, source_module, decision_document_version_id from machvon.contractor_violation where id = $1::uuid for update',
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'RECORDED') throw new DomainError('VIOLATION_STATE_INVALID', 409, 'id');
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    assertNotTheAuthor(actor, row.created_by);
    const documentId = input.decisionDocumentVersionId ?? row.decision_document_version_id ?? undefined;
    const document = needsDecisionDocument(input.penaltyKind) || documentId !== undefined ? await decisionDocument(tx, documentId, 'decision_document_version_id') : undefined;
    await tx.query(
      `update machvon.contractor_violation
          set status = 'CONFIRMED', penalty_kind = $2, penalty_amount_vnd = $3::numeric, decision_document_version_id = $4::uuid, confirmed_by = $5::uuid, confirmed_at = now(),
              updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, input.penaltyKind, input.penaltyAmountVnd, document?.versionId ?? null, actor],
    );
    const header = await this.contractHeader(tx, owner.contract_id);
    return {
      id,
      version: Number(row.version) + 1,
      status: 'CONFIRMED',
      contractId: owner.contract_id,
      contractCode: header.code,
      projectId: header.projectId,
      contractorId: row.contractor_id,
      kind: row.violation_kind,
      severity: row.severity,
      sourceModule: row.source_module,
      penaltyKind: input.penaltyKind,
      penaltyAmountVnd: input.penaltyAmountVnd,
      decisionDocumentVersionId: document?.versionId ?? null,
    };
  }

  /** The contractors that hold a contract the caller reads, by name: the choice that CTR-23 offers to one who has no contractor in hand. */
  async contractorsInScope(tx: TenantTx, scope: ScopeBuilder): Promise<Array<{ id: string; legalName: string; contractCount: number }>> {
    const predicate = scope(1);
    const rows = await tx.query<{ id: string; legal_name: string; contract_count: string }>(
      `select k.id, k.legal_name, count(*)::text as contract_count
         from ${SCOPE_FROM} join machvon.contractor k on k.tenant_id = c.tenant_id and k.id = c.contractor_id
        where ${predicate.sql} group by k.id, k.legal_name order by k.legal_name, k.id limit ${LIST_MAX}`,
      predicate.params,
    );
    return rows.map((row) => ({ id: row.id, legalName: row.legal_name, contractCount: Number(row.contract_count) }));
  }

  /**
   * The scorecard of a contractor over the contracts the caller reads, and the log of its violations: every evaluation made in the range (the day it was made) and every violation that happened in it. The summary counts what is approved
   * and confirmed: the average of the overall scores of the approved evaluations that stand (not the superseded ones), and the confirmed violations by severity. A contractor with no contract in the scope of the caller is 404.
   */
  async scorecard(tx: TenantTx, contractorId: string, range: ScorecardRange, scope: ScopeBuilder): Promise<Scorecard> {
    const predicate = scope(4);
    const params = [contractorId, range.from ?? null, range.to ?? null, ...predicate.params];
    const evaluations = await tx.query<EvaluationSql>(
      `select ${PLACE_COLUMNS}, ${EVALUATION_COLUMNS}
         from machvon.contractor_performance e join ${SCOPE_FROM} on c.tenant_id = e.tenant_id and c.id = e.contract_id
        where e.contractor_id = $1::uuid and ($2::date is null or ${DAY_VN('e.created_at')} >= $2::date) and ($3::date is null or ${DAY_VN('e.created_at')} <= $3::date) and ${predicate.sql}
        order by e.created_at desc, e.id limit ${LIST_MAX}`,
      params,
    );
    const violations = await tx.query<ViolationSql>(
      `select ${PLACE_COLUMNS}, ${VIOLATION_COLUMNS}
         from machvon.contractor_violation v join ${SCOPE_FROM} on c.tenant_id = v.tenant_id and c.id = v.contract_id
        where v.contractor_id = $1::uuid and ($2::date is null or v.occurred_on >= $2::date) and ($3::date is null or v.occurred_on <= $3::date) and ${predicate.sql}
        order by v.occurred_on desc, v.created_at desc, v.id limit ${LIST_MAX}`,
      params,
    );
    // The totals are counted over everything the caller reads in the range, not over the rows that are shown: a contractor with more records than the list holds still has the right figures.
    const [evaluationTotals] = await tx.query<{ total: string; approved: string; average: string | null }>(
      `select count(*)::text as total, (count(*) filter (where e.status = 'APPROVED'))::text as approved, round(avg(e.overall_score) filter (where e.status = 'APPROVED'), 2)::text as average
         from machvon.contractor_performance e join ${SCOPE_FROM} on c.tenant_id = e.tenant_id and c.id = e.contract_id
        where e.contractor_id = $1::uuid and ($2::date is null or ${DAY_VN('e.created_at')} >= $2::date) and ($3::date is null or ${DAY_VN('e.created_at')} <= $3::date) and ${predicate.sql}`,
      params,
    );
    const [violationTotals] = await tx.query<{ total: string; minor: string; major: string; critical: string }>(
      `select count(*)::text as total, (count(*) filter (where v.status = 'CONFIRMED' and v.severity = 'MINOR'))::text as minor, (count(*) filter (where v.status = 'CONFIRMED' and v.severity = 'MAJOR'))::text as major,
              (count(*) filter (where v.status = 'CONFIRMED' and v.severity = 'CRITICAL'))::text as critical
         from machvon.contractor_violation v join ${SCOPE_FROM} on c.tenant_id = v.tenant_id and c.id = v.contract_id
        where v.contractor_id = $1::uuid and ($2::date is null or v.occurred_on >= $2::date) and ($3::date is null or v.occurred_on <= $3::date) and ${predicate.sql}`,
      params,
    );
    const own = scope(2);
    const contracts = await tx.query<PlaceSql & { contract_status: string }>(
      `select ${PLACE_COLUMNS}, c.status as contract_status from ${SCOPE_FROM} where c.contractor_id = $1::uuid and ${own.sql} order by c.code, c.id limit ${LIST_MAX}`,
      [contractorId, ...own.params],
    );
    // A contractor is there for the caller only through a contract they read: one with none in the scope is not there (404), and its name is not told.
    const [contractor] = contracts.length === 0 ? [] : await tx.query<{ id: string; legal_name: string }>('select id, legal_name from machvon.contractor where id = $1::uuid', [contractorId]);
    if (contractor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lines = evaluations.map(
      (row): EvaluationLine => ({
        id: row.id,
        contractId: row.contract_id,
        contractCode: row.contract_code,
        kind: row.evaluation_kind,
        periodLabel: row.period_label,
        revision: row.revision,
        scores: scoresOf(row),
        overallScore: row.overall_score,
        rating: row.rating,
        status: row.status,
        evaluatedBy: row.evaluated_by,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
        supersedesId: row.supersedes_id,
        remarks: row.remarks,
        approvalNote: row.approval_note,
        createdAt: row.created_at,
        version: Number(row.version),
        place: placeOf(row),
      }),
    );
    const log = violations.map(
      (row): ViolationLine => ({
        id: row.id,
        contractId: row.contract_id,
        contractCode: row.contract_code,
        kind: row.violation_kind,
        severity: row.severity,
        occurredOn: row.occurred_on,
        description: row.description,
        evidenceDocumentVersionId: row.evidence_document_version_id,
        penaltyKind: row.penalty_kind,
        penaltyAmountVnd: row.penalty_amount_vnd,
        decisionDocumentVersionId: row.decision_document_version_id,
        sourceModule: row.source_module,
        sourceRefId: row.source_ref_id,
        status: row.status,
        recordedBy: row.created_by,
        confirmedAt: row.confirmed_at,
        createdAt: row.created_at,
        version: Number(row.version),
        place: placeOf(row),
      }),
    );
    return {
      contractor: { id: contractor.id, legalName: contractor.legal_name },
      contracts: contracts.map((row) => ({ id: row.contract_id, code: row.contract_code, status: row.contract_status, place: placeOf(row) })),
      evaluations: lines,
      violations: log,
      summary: {
        approvedCount: Number(evaluationTotals?.approved ?? 0),
        averageOverallScore: evaluationTotals?.average ?? null,
        confirmedViolations: { MINOR: Number(violationTotals?.minor ?? 0), MAJOR: Number(violationTotals?.major ?? 0), CRITICAL: Number(violationTotals?.critical ?? 0) },
        evaluationCount: Number(evaluationTotals?.total ?? 0),
        violationCount: Number(violationTotals?.total ?? 0),
      },
    };
  }
}
