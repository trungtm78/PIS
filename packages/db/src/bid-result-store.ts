import { randomUUID } from 'node:crypto';
import {
  DomainError,
  MAX_RESULT_COMMENT,
  PACKAGE_STATUS_AFTER_RESULT,
  RESULT_DECISIONS,
  RESULT_OUTCOMES,
  assertFourEyes,
  assertPriceWithinBudget,
  assertResultShape,
  versionConflict,
  vietnamDateOf,
  isInForce,
} from '@machvon/kernel';
import type { ResultDecision, ResultOutcome, ResultStatus } from '@machvon/kernel';
import { assertDecisionDocument } from './bid-decision-document.ts';
import { BidContractorStore } from './bid-contractor-store.ts';
import { PACKAGE_STATUS_OPEN_FOR_BIDS } from './bid-proposal-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const PRICE = /^[0-9]{1,24}$/;
const UNIQUE_VIOLATION = '23505';
const OPEN_CONSTRAINT = 'procurement_result_one_open_uq';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (status: string, reason?: string): DomainError =>
  new DomainError('RESULT_STATE_INVALID', 409, 'status', { extensions: { result_status: status, ...(reason === undefined ? {} : { reason }) } });

export interface NewResultInput {
  packageId: string;
  outcome: string;
  winnerContractorId?: string | undefined;
  awardPriceVnd?: string | undefined;
  /** The evaluation the result rests on. Until the structured report exists (ST-BID-012) it is the evaluation minutes issued through DOC. */
  evaluationReportId: string;
}

/** What a submission left, as the audit row, the event and the answer are written from. */
export interface SubmittedResult {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  outcome: ResultOutcome;
  winnerContractorId: string | null;
  awardPriceVnd: string | null;
  budgetVnd: string;
  evaluationMinutesDocumentId: string;
  status: 'SUBMITTED';
  version: number;
}

export interface ResultDecisionInput {
  decision: string;
  decisionDocumentId?: string | undefined;
  comment?: string | undefined;
}

/** The facts the delegation limit of the matrix is judged on: where the project lies and what the award is worth (the price of the package for an outcome with no award). */
export interface ResultFacts {
  resultId: string;
  packageId: string;
  projectId: string;
  ownerUnit: { id: string; path: string };
  amountVnd: string;
}

export interface ResultHooks {
  /** Refuses with 403 `SCOPE_DENIED` when the caller is not within the delegation limit for the result; a tenant with no rule for results does not limit it. */
  authorise(facts: ResultFacts): Promise<void>;
}

/** What a decision left, as the audit row, the event and the answer are written from. */
export interface DecidedResult {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  outcome: ResultOutcome;
  winnerContractorId: string | null;
  awardPriceVnd: string | null;
  decision: ResultDecision;
  status: Extract<ResultStatus, 'APPROVED' | 'REJECTED'>;
  decisionDocumentId: string | null;
  comment: string | null;
  evaluationMinutesDocumentId: string | null;
  packageStatus: string;
  version: number;
}

/** One result as BID-18 shows it. */
export interface ResultLine {
  id: string;
  package: { id: string; code: string; budgetVnd: string };
  outcome: ResultOutcome;
  winner: { id: string; legalName: string } | null;
  awardPriceVnd: string | null;
  evaluationMinutes: { documentId: string; title: string } | null;
  decisionDocumentId: string | null;
  status: ResultStatus;
  submittedBy: { membershipId: string; displayName: string } | null;
  submittedAt: string | null;
  decidedBy: { membershipId: string; displayName: string } | null;
  decidedAt: string | null;
  comment: string | null;
  version: number;
}

interface LockSql {
  id: string;
  package_id: string;
  package_code: string;
  package_status: string;
  budget_vnd: string;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  outcome: ResultOutcome;
  status: ResultStatus;
  winner_contractor_id: string | null;
  award_price_vnd: string | null;
  evaluation_minutes_document_id: string | null;
  submitted_by: string | null;
  version: string;
}

interface LineSql {
  id: string;
  package_id: string;
  package_code: string;
  budget_vnd: string;
  outcome: ResultOutcome;
  winner_contractor_id: string | null;
  winner_name: string | null;
  award_price_vnd: string | null;
  minutes_id: string | null;
  minutes_title: string | null;
  decision_document_id: string | null;
  status: ResultStatus;
  submitted_by: string | null;
  submitter_name: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  version: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The result of the selection of a contractor (ST-BID-006, BID 3 F7). A proposer submits it for a package whose plan is in force: an award names a winner that no restriction
 * stops, at a price that does not pass the price of the package, and rests on an evaluation that was issued; one result is open for a package at a time. Someone else, with
 * the authority, approves it on a decision document or turns it down with the reason, and an approval gives the package the status of the outcome. Nothing a machine produced
 * enters the decision: the approval is a person's, on a document of the authority.
 */
export class BidResultStore {
  private readonly contractors = new BidContractorStore();

  /**
   * Refusals in order: the shape (422 `VALIDATION_FAILED`), the package (404 outside the scope, 409 `PLAN_NOT_APPROVED` unless its plan is in force), a result that is still
   * open (409 `RESULT_STATE_INVALID`), the price (422 `PRICE_EXCEEDS_PACKAGE_BUDGET`), the winner (422 `CONTRACTOR_RESTRICTED`, `CONTRACTOR_NOT_VERIFIED`) and the evaluation
   * (409 `REPORT_NOT_ISSUED` unless the document is in force).
   */
  async submit(tx: TenantTx, input: NewResultInput, actor: string, scope: ScopeBuilder, now: Date): Promise<SubmittedResult> {
    const outcome = RESULT_OUTCOMES.find((candidate) => candidate === input.outcome);
    if (outcome === undefined) throw invalid('outcome');
    const winner = input.winnerContractorId?.toLowerCase();
    const price = input.awardPriceVnd;
    if (price !== undefined && !PRICE.test(price)) throw invalid('award_price_vnd');
    assertResultShape(outcome, winner, price);
    const minutes = input.evaluationReportId.toLowerCase();

    const pack = await this.lockPackage(tx, input.packageId, scope);
    if (pack.status !== PACKAGE_STATUS_OPEN_FOR_BIDS) throw new DomainError('PLAN_NOT_APPROVED', 409, 'package_id', { extensions: { package_status: pack.status } });
    const open = await tx.query<{ id: string; status: string }>("select id, status from machvon.procurement_result where package_id = $1::uuid and status in ('DRAFT', 'SUBMITTED')", [pack.id]);
    if (open[0] !== undefined) throw stateInvalid(open[0].status, 'OPEN_RESULT');
    if (price !== undefined) assertPriceWithinBudget(price, pack.budget_vnd);
    if (winner !== undefined) await this.assertWinner(tx, winner, now);
    await this.assertEvaluationIssued(tx, minutes);

    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.procurement_result
           (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, evaluation_minutes_document_id, outcome, status, submitted_by, submitted_at, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::uuid, $6, 'SUBMITTED', $7::uuid, $8::timestamptz, $7::uuid, $7::uuid, 1)`,
        [id, pack.id, winner ?? null, price ?? null, minutes, outcome, actor, now.toISOString()],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === OPEN_CONSTRAINT) throw stateInvalid('SUBMITTED', 'OPEN_RESULT');
      throw error;
    }
    return {
      id,
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      outcome,
      winnerContractorId: winner ?? null,
      awardPriceVnd: price ?? null,
      budgetVnd: pack.budget_vnd,
      evaluationMinutesDocumentId: minutes,
      status: 'SUBMITTED',
      version: 1,
    };
  }

  /**
   * Refusals in order: the result (404 outside the scope), the version (409), its state (409 `RESULT_STATE_INVALID` unless it is SUBMITTED), the maker (403
   * `SELF_APPROVAL_DENIED`), the delegation limit, and what the decision needs: an approval needs a decision document in force (422 `DECISION_DOCUMENT_NOT_EFFECTIVE`) and, for an
   * award, the plan still in force, the price still within the package and the winner still free of restriction; a rejection needs the reason in words and no document.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: ResultDecisionInput, decider: string, scope: ScopeBuilder, now: Date, hooks: ResultHooks): Promise<DecidedResult> {
    const decision = RESULT_DECISIONS.find((candidate) => candidate === input.decision);
    if (decision === undefined) throw invalid('decision');
    const comment = input.comment === undefined ? undefined : input.comment.trim();
    if (comment !== undefined && comment.length > MAX_RESULT_COMMENT) throw invalid('comment');
    const held = await this.lockResult(tx, id, scope);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'SUBMITTED') throw stateInvalid(held.status);
    if (held.submitted_by !== null) assertFourEyes(held.submitted_by, decider);
    await hooks.authorise({ resultId: held.id, packageId: held.package_id, projectId: held.project_id, ownerUnit: { id: held.owner_unit_id, path: held.owner_unit_path }, amountVnd: held.award_price_vnd ?? held.budget_vnd });

    const base = {
      id: held.id,
      packageId: held.package_id,
      packageCode: held.package_code,
      projectId: held.project_id,
      outcome: held.outcome,
      winnerContractorId: held.winner_contractor_id,
      awardPriceVnd: held.award_price_vnd,
      decision,
      evaluationMinutesDocumentId: held.evaluation_minutes_document_id,
      version: Number(held.version) + 1,
    };
    if (decision === 'REJECT') {
      if (comment === undefined || comment === '') throw invalid('comment');
      if (input.decisionDocumentId !== undefined) throw invalid('decision_document_id');
      await tx.query(
        `update machvon.procurement_result set status = 'REJECTED', rejected_by = $2::uuid, rejected_at = $3::timestamptz, decision_comment = $4, updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, decider, now.toISOString(), comment],
      );
      return { ...base, status: 'REJECTED', decisionDocumentId: null, comment, packageStatus: held.package_status };
    }

    const documentId = await assertDecisionDocument(tx, input.decisionDocumentId?.toLowerCase());
    if (held.outcome === 'AWARDED') await this.assertAwardStillStands(tx, held, now);
    await tx.query(
      `update machvon.procurement_result
          set status = 'APPROVED', decision_document_id = $2::uuid, approved_by = $3::uuid, approved_at = $4::timestamptz, decision_comment = $5, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, documentId, decider, now.toISOString(), comment === undefined || comment === '' ? null : comment],
    );
    const packageStatus = PACKAGE_STATUS_AFTER_RESULT[held.outcome];
    await tx.query('update machvon.procurement_package set status = $2 where id = $1::uuid', [held.package_id, packageStatus]);
    return { ...base, status: 'APPROVED', decisionDocumentId: documentId, comment: comment === undefined || comment === '' ? null : comment, packageStatus };
  }

  /** The results of the packages in the scope of the caller, the newest first, optionally those of one package. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { packageId?: string | undefined }): Promise<ResultLine[]> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(
      `select r.id, r.package_id, k.code as package_code, k.budget_vnd::text as budget_vnd, r.outcome, r.winner_contractor_id, c.legal_name as winner_name, r.award_price_vnd::text as award_price_vnd,
              r.evaluation_minutes_document_id as minutes_id, md.title as minutes_title, r.decision_document_id, r.status, r.submitted_by, su.display_name as submitter_name,
              to_char(r.submitted_at at time zone 'UTC', ${ISO}) as submitted_at, coalesce(r.approved_by, r.rejected_by) as decided_by, du.display_name as decider_name,
              to_char(coalesce(r.approved_at, r.rejected_at) at time zone 'UTC', ${ISO}) as decided_at, r.decision_comment, r.version::text as version
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_result r on r.tenant_id = k.tenant_id and r.package_id = k.id
         left join machvon.contractor c on c.tenant_id = r.tenant_id and c.id = r.winner_contractor_id
         left join machvon.document md on md.tenant_id = r.tenant_id and md.id = r.evaluation_minutes_document_id
         left join machvon.tenant_user_directory su on su.tenant_id = r.tenant_id and su.membership_id = r.submitted_by
         left join machvon.tenant_user_directory du on du.tenant_id = r.tenant_id and du.membership_id = coalesce(r.approved_by, r.rejected_by)
        where ${predicate.sql} and ($1::uuid is null or r.package_id = $1::uuid)
        order by r.created_at desc, r.id desc`,
      [filter.packageId ?? null, ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      package: { id: row.package_id, code: row.package_code, budgetVnd: row.budget_vnd },
      outcome: row.outcome,
      winner: row.winner_contractor_id === null ? null : { id: row.winner_contractor_id, legalName: row.winner_name ?? '' },
      awardPriceVnd: row.award_price_vnd,
      evaluationMinutes: row.minutes_id === null ? null : { documentId: row.minutes_id, title: row.minutes_title ?? '' },
      decisionDocumentId: row.decision_document_id,
      status: row.status,
      submittedBy: row.submitted_by === null ? null : { membershipId: row.submitted_by, displayName: row.submitter_name ?? '' },
      submittedAt: row.submitted_at,
      decidedBy: row.decided_by === null ? null : { membershipId: row.decided_by, displayName: row.decider_name ?? '' },
      decidedAt: row.decided_at,
      comment: row.decision_comment,
      version: Number(row.version),
    }));
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  /** The winner is a contractor of the tenant that no restriction in force stops and that nobody left unverified. */
  private async assertWinner(tx: TenantTx, contractorId: string, now: Date): Promise<void> {
    const contractor = await this.contractors.find(tx, contractorId);
    if (contractor === undefined) throw invalid('winner_contractor_id');
    await this.contractors.assertMayTakePart(tx, contractorId, vietnamDateOf(now));
  }

  /** The evaluation minutes are a document of the tenant that is in force, issued through DOC; one that is still being drafted or was recalled is 409 `REPORT_NOT_ISSUED`. */
  private async assertEvaluationIssued(tx: TenantTx, documentId: string): Promise<void> {
    const rows = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [documentId]);
    if (rows[0] === undefined) throw invalid('evaluation_report_id');
    if (!isInForce(rows[0].effect_status)) throw new DomainError('REPORT_NOT_ISSUED', 409, 'evaluation_report_id', { extensions: { effect_status: rows[0].effect_status } });
  }

  /** What was true when the award was submitted is judged again when it is approved: the plan, the price and the winner may have moved since. */
  private async assertAwardStillStands(tx: TenantTx, held: LockSql, now: Date): Promise<void> {
    if (held.package_status !== PACKAGE_STATUS_OPEN_FOR_BIDS) throw new DomainError('PLAN_NOT_APPROVED', 409, 'package_id', { extensions: { package_status: held.package_status } });
    if (held.award_price_vnd !== null) assertPriceWithinBudget(held.award_price_vnd, held.budget_vnd);
    if (held.winner_contractor_id !== null) await this.assertWinner(tx, held.winner_contractor_id, now);
  }

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<{ id: string; code: string; status: string; project_id: string; budget_vnd: string }> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string; code: string; status: string; project_id: string; budget_vnd: string }>(
      `select k.id, k.code, k.status, k.project_id, k.budget_vnd::text as budget_vnd from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  private async lockResult(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<LockSql> {
    const predicate = scope(2);
    const rows = await tx.query<LockSql>(
      `select r.id, r.package_id, k.code as package_code, k.status as package_status, k.budget_vnd::text as budget_vnd, p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path,
              r.outcome, r.status, r.winner_contractor_id, r.award_price_vnd::text as award_price_vnd, r.evaluation_minutes_document_id, r.submitted_by, r.version::text as version
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_result r on r.tenant_id = k.tenant_id and r.package_id = k.id
        where r.id = $1::uuid and ${predicate.sql} for update of p, k, r`,
      [id, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }
}
