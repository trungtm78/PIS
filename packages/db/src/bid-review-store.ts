import { randomUUID } from 'node:crypto';
import { DomainError, MAX_CHECKED_EVIDENCE, assertRunReviewable, compareProposals, findingVersion, reviewDecision, reviewScoreOf, scoreAfterReview, statusForForm, versionConflict } from '@machvon/kernel';
import type { Comparison, ComparisonCriterion, ComparisonRunInput, DecidedFinding, FindingDecisionForm, FindingStatus, ReviewDecision, RunStatus } from '@machvon/kernel';
import { BidAnalysisStore, LATEST_REVIEW } from './bid-analysis-store.ts';
import type { FindingLine, ReviewLine } from './bid-analysis-store.ts';
import { PROHIBITED_RULES, prohibitedRuleOf } from './bid-criteria-rules.ts';
import { SqlParams } from './bid-plan-reads.ts';
import { BidProposalReads } from './bid-proposal-reads.ts';
import type { ProposalViewer } from './bid-proposal-reads.ts';
import { AiDecisionStore } from './llm-emergency-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const NOT_LIVE = `'CANCELLED', 'FAILED', 'REJECTED_BY_POLICY'`;
const APPROVED = 'APPROVED';
/** What an expert decides is, for the record of the decisions about the answers of the AI, a decision (ST-LLM-006). */
const DECISION_ACTION = 'DECISION';
const SUBJECT_MODULE = 'BID';
const SUBJECT_KIND = 'analysis_finding';

/** What the expert sets for the finding: the status they name (with a score when the criterion is scored), or the form of the baseline operation, which approves what stands or sets it aside. */
export type ReviewTarget = { kind: 'STATUS'; status: FindingStatus; score: string | undefined } | { kind: 'FORM'; form: FindingDecisionForm };

export interface ReviewInput {
  findingId: string;
  expectedVersion: number;
  target: ReviewTarget;
  reason: string;
  checkedEvidenceIds: readonly string[];
}

export interface ReviewedFinding {
  review: ReviewLine;
  finding: FindingLine;
  /** The record of the decision of a person about the answer of the AI, written in the same transaction. */
  decisionRecordId: string;
  decision: ReviewDecision;
  runId: string;
  runStatus: Extract<RunStatus, 'AWAITING_REVIEW' | 'COMPLETED'>;
  proposalId: string;
  packageCode: string;
  criteriaVersionId: string;
}

interface FindingRow {
  id: string;
  run_id: string;
  criterion_id: string;
  proposal_id: string;
  criteria_version_id: string;
  ai_request_id: string | null;
  package_code: string;
}

interface Standing {
  status: FindingStatus;
  score: string | null;
  reviewCount: number;
  runStatus: RunStatus;
}

interface CriterionJson {
  code: string;
  name: string;
  kind: string;
  weight: number | null;
  max_score: number | null;
  threshold: number | null;
  mandatory: boolean;
  required_evidence?: string[];
}

interface CriteriaVersionRow {
  id: string;
  package_id: string;
  status: string;
  criteria_json: { criteria?: CriterionJson[] };
}

interface RunSql {
  id: string;
  proposal_id: string;
  status: RunStatus;
  criteria_version_id: string;
}

interface ComparedFindingSql {
  id: string;
  run_id: string;
  criterion_id: string;
  final_status: FindingStatus | null;
  final_score: string | null;
  decision: ReviewDecision | null;
  decided_at: string | null;
}

export interface ComparisonRead {
  package: { id: string; code: string };
  criteriaStatus: string;
  comparison: Comparison;
}

const notFound = (field?: string): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404, field);

/**
 * The review of the findings of an analysis by an expert, and the comparison of proposals that is built from what the experts decided (ST-BID-010, BID 3 F6, BR-BID-03/09/10/11, BID-10/12). A finding is reviewed by a
 * member of the evaluation team who has the full view of its proposal: the decision is a row of its own that points at the finding, written with the record of the decision of a person about an answer of the AI in the same
 * transaction; the finding never changes, and what stands for it is the latest decision. The comparison sets the proposals side by side from those decisions and from nothing the model said.
 */
export class BidReviewStore {
  private readonly proposals = new BidProposalReads();
  private readonly analysis = new BidAnalysisStore();
  private readonly decisions = new AiDecisionStore();

  /**
   * Records the decision of an expert. Refusals in order: the finding is not one of a proposal the caller has the full view of (404; 403 CONFLICT_UNDECLARED when they owe the declaration), the run does not wait for the
   * experts (422 RUN_NOT_COMPLETED), the version they saw is not the current one (409 VERSION_CONFLICT), the score or the citations (422). Experts decide one after the other for a proposal, so that the version they name is
   * the one that stands, and the run is COMPLETED the moment its last finding has a decision.
   */
  async review(tx: TenantTx, input: ReviewInput, viewer: ProposalViewer, actor: string): Promise<ReviewedFinding> {
    const row = await this.findingRow(tx, input.findingId);
    if (row === undefined) throw notFound();
    const found = await this.proposals.find(tx, row.proposal_id, viewer);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (found.kind !== 'SEEN' || found.line.view !== 'FULL') throw notFound();
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bid_analysis:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [row.proposal_id]);

    const standing = await this.standing(tx, row.id);
    assertRunReviewable(standing.runStatus);
    const version = findingVersion(standing.reviewCount);
    if (version !== input.expectedVersion) throw versionConflict(version);
    const toStatus = input.target.kind === 'FORM' ? statusForForm(input.target.form, standing.status) : input.target.status;
    const criterion = (await this.criteriaVersion(tx, row.criteria_version_id)).criteria_json.criteria?.find((candidate) => candidate.code === row.criterion_id);
    const given = input.target.kind === 'STATUS' ? reviewScoreOf(input.target.score, { maxScore: criterion?.max_score ?? null }) : null;
    const checked = await this.checkedEvidence(tx, row.id, input.checkedEvidenceIds);
    const decision = reviewDecision({ fromStatus: standing.status, toStatus, scoreBefore: standing.score, scoreAfter: given });

    const recordId = await this.recordDecision(tx, row, decision, input.reason, actor);
    const reviewId = randomUUID();
    // The moment is taken here, after the lock of the proposal, so that the order of the decisions is the order they were made in.
    await tx.query(
      `insert into machvon.analysis_finding_review (tenant_id, id, finding_id, reviewer_user_id, from_status, to_status, score_before, score_after, reason, decision, ai_decision_record_id, checked_evidence_ids, decided_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8, $9, $10::uuid, $11::jsonb, clock_timestamp())`,
      [reviewId, row.id, actor, standing.status, toStatus, standing.score, scoreAfterReview(standing.score, given), input.reason, decision, recordId, JSON.stringify(checked)],
    );
    const runStatus = await this.completeRun(tx, row.run_id);
    const reviews = (await this.analysis.reviewsOf(tx, [row.id])).get(row.id) as ReviewLine[];
    const seen = await this.analysis.findFinding(tx, row.id, viewer);
    if (seen.kind !== 'SEEN') throw notFound();
    return {
      review: reviews.find((candidate) => candidate.id === reviewId) as ReviewLine,
      finding: { ...seen.finding, reviews },
      decisionRecordId: recordId,
      decision,
      runId: row.run_id,
      runStatus,
      proposalId: row.proposal_id,
      packageCode: row.package_code,
      criteriaVersionId: row.criteria_version_id,
    };
  }

  private async findingRow(tx: TenantTx, id: string): Promise<FindingRow | undefined> {
    const rows = await tx.query<FindingRow>(
      `select f.id, f.run_id, f.criterion_id, r.proposal_id, r.criteria_version_id, r.ai_request_id, k.code as package_code
         from machvon.analysis_finding f
         join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id
         join machvon.procurement_package k on k.tenant_id = r.tenant_id and k.id = r.package_id
        where f.id = $1::uuid`,
      [id],
    );
    return rows[0];
  }

  /** What stands for the finding, read after the lock: the status and the score of the latest decision or what the model said, the number of decisions, and the state of the run. */
  private async standing(tx: TenantTx, findingId: string): Promise<Standing> {
    const rows = await tx.query<{ status: FindingStatus; score: string | null; review_count: number; run_status: RunStatus }>(
      `select coalesce(lr.to_status, f.status) as status, lr.score_after::text as score, r.status as run_status,
              (select count(*)::int from machvon.analysis_finding_review rv where rv.tenant_id = f.tenant_id and rv.finding_id = f.id) as review_count
         from machvon.analysis_finding f ${LATEST_REVIEW} join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id where f.id = $1::uuid`,
      [findingId],
    );
    const row = rows[0] as { status: FindingStatus; score: string | null; review_count: number; run_status: RunStatus };
    return { status: row.status, score: row.score, reviewCount: row.review_count, runStatus: row.run_status };
  }

  private async criteriaVersion(tx: TenantTx, id: string): Promise<CriteriaVersionRow> {
    const rows = await tx.query<CriteriaVersionRow>('select id, package_id, status, criteria_json from machvon.criteria_version where id = $1::uuid', [id]);
    if (rows[0] === undefined) throw notFound('criteria_version_id');
    return rows[0];
  }

  /** The citations the expert says they checked are citations of this finding, each named once (422 otherwise). */
  private async checkedEvidence(tx: TenantTx, findingId: string, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (unique.length > MAX_CHECKED_EVIDENCE) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    if (unique.length === 0) return [];
    const rows = await tx.query<{ id: string }>('select id from machvon.analysis_evidence where finding_id = $1::uuid and id = any($2::uuid[])', [findingId, unique]);
    if (rows.length !== unique.length) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    return unique;
  }

  /** The decision of a person about the answer of the AI that the run was made of, in the transaction of the review (ST-LLM-006, BR-BID-09). */
  private async recordDecision(tx: TenantTx, row: FindingRow, decision: ReviewDecision, reason: string, actor: string): Promise<string> {
    const request = await tx.query<{ output_sha256: string | null }>('select output_sha256 from machvon.ai_request where id = $1::uuid', [row.ai_request_id]);
    const record = await this.decisions.record(tx, {
      aiRequestId: row.ai_request_id as string,
      subjectModule: SUBJECT_MODULE,
      subjectKind: SUBJECT_KIND,
      subjectId: row.id,
      aiOutputSha256: request[0]?.output_sha256 ?? '',
      actionKind: DECISION_ACTION,
      decision,
      rationale: reason,
      actor,
    });
    return record.id;
  }

  /** The run is done with the experts the moment every finding of it has a decision. */
  private async completeRun(tx: TenantTx, runId: string): Promise<'AWAITING_REVIEW' | 'COMPLETED'> {
    const open = await tx.query(
      'select 1 from machvon.analysis_finding f where f.run_id = $1::uuid and not exists (select 1 from machvon.analysis_finding_review rv where rv.tenant_id = f.tenant_id and rv.finding_id = f.id) limit 1',
      [runId],
    );
    if (open.length > 0) return 'AWAITING_REVIEW';
    await tx.query("update machvon.analysis_run set status = 'COMPLETED', version = version + 1 where id = $1::uuid and status = 'AWAITING_REVIEW'", [runId]);
    return 'COMPLETED';
  }

  // ---- the comparison ---------------------------------------------------------------------------------------------------------------------

  /**
   * The proposals of a package side by side on one version of the criteria (BID-10). Only proposals the caller has the full view of are in it; the declaration is owed (403 CONFLICT_UNDECLARED) when any stands
   * waiting for it. `undefined` when the package is not of a project the caller evaluates. The version is the one asked for (404 when there is none, 422 when it is of another package) or the one in force.
   */
  async compare(tx: TenantTx, packageId: string, requestedVersionId: string | undefined, viewer: ProposalViewer): Promise<ComparisonRead | undefined> {
    const params = new SqlParams();
    const evaluate = params.scope(viewer.evaluate);
    const reach = await tx.query<{ id: string; code: string }>(
      `select k.id, k.code from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = ${params.add(packageId)}::uuid and ${evaluate}`,
      params.values,
    );
    const target = reach[0];
    if (target === undefined) return undefined;
    const lines = await this.proposals.ofPackage(tx, viewer, packageId);
    if (lines.some((line) => line.view === 'DECLARATION_REQUIRED')) throw new DomainError('CONFLICT_UNDECLARED', 403);
    const version = await this.versionToCompare(tx, packageId, requestedVersionId);

    const full = lines.filter((line) => line.view === 'FULL');
    const runs = await this.standingRuns(tx, full.map((line) => line.id));
    const findings = await this.decidedFindings(tx, [...runs.values()].map((run) => run.id));
    const inputs = full.map((line): ComparisonRunInput => {
      const run = runs.get(line.id);
      return {
        proposalId: line.id,
        contractor: { id: line.contractor.id, name: line.contractor.legalName },
        run: run === undefined ? null : { id: run.id, status: run.status, criteriaVersionId: run.criteria_version_id },
        findings: (findings.get(run?.id ?? '') ?? []).map((finding) => ({ findingId: finding.id, criterionCode: finding.criterion_id, decided: decidedOf(finding) })),
      };
    });
    const comparison = compareProposals({ criteriaVersionId: version.id, criteria: criteriaOf(version), runs: inputs, excludedAttributes: PROHIBITED_RULES.map((rule) => rule.code) });
    return { package: { id: target.id, code: target.code }, criteriaStatus: version.status, comparison };
  }

  private async versionToCompare(tx: TenantTx, packageId: string, requested: string | undefined): Promise<CriteriaVersionRow> {
    if (requested !== undefined) {
      const version = await this.criteriaVersion(tx, requested);
      if (version.package_id !== packageId) throw new DomainError('VALIDATION_FAILED', 422, 'criteria_version_id');
      return version;
    }
    const inForce = await tx.query<CriteriaVersionRow>(
      'select id, package_id, status, criteria_json from machvon.criteria_version where package_id = $1::uuid and status = $2 order by revision desc limit 1',
      [packageId, APPROVED],
    );
    if (inForce[0] === undefined) throw notFound('criteria_version_id');
    return inForce[0];
  }

  /** The analysis that stands for each proposal: its latest run that was not cancelled, refused or failed. */
  private async standingRuns(tx: TenantTx, proposalIds: readonly string[]): Promise<Map<string, RunSql>> {
    if (proposalIds.length === 0) return new Map();
    const rows = await tx.query<RunSql>(
      `select distinct on (r.proposal_id) r.id, r.proposal_id, r.status, r.criteria_version_id from machvon.analysis_run r
        where r.proposal_id = any($1::uuid[]) and r.status not in (${NOT_LIVE}) order by r.proposal_id, r.created_at desc, r.id desc`,
      [[...proposalIds]],
    );
    return new Map(rows.map((row) => [row.proposal_id, row] as const));
  }

  /** The findings of the runs with the latest decision of a person about each; what the model said is not read. */
  private async decidedFindings(tx: TenantTx, runIds: readonly string[]): Promise<Map<string, ComparedFindingSql[]>> {
    const byRun = new Map<string, ComparedFindingSql[]>();
    if (runIds.length === 0) return byRun;
    const rows = await tx.query<ComparedFindingSql>(
      `select f.id, f.run_id, f.criterion_id, lr.to_status as final_status, lr.score_after::text as final_score, lr.decision, to_char(lr.decided_at at time zone 'UTC', ${ISO}) as decided_at
         from machvon.analysis_finding f ${LATEST_REVIEW} where f.run_id = any($1::uuid[]) order by f.criterion_id, f.id`,
      [[...runIds]],
    );
    for (const row of rows) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row]);
    return byRun;
  }
}

function decidedOf(finding: ComparedFindingSql): DecidedFinding | null {
  if (finding.final_status === null || finding.decision === null || finding.decided_at === null) return null;
  return { findingId: finding.id, status: finding.final_status, score: finding.final_score, decision: finding.decision, decidedAt: finding.decided_at };
}

/** The criteria of a version as the comparison reads them, each marked with the rule of the criteria nobody may ask for that its text falls under, if any. */
function criteriaOf(version: CriteriaVersionRow): ComparisonCriterion[] {
  return (version.criteria_json.criteria ?? []).map((criterion) => ({
    code: criterion.code,
    name: criterion.name,
    kind: criterion.kind,
    weight: criterion.weight,
    maxScore: criterion.max_score,
    threshold: criterion.threshold,
    mandatory: criterion.mandatory,
    prohibitedRule: [criterion.name, ...(criterion.required_evidence ?? [])].map(prohibitedRuleOf).find((rule) => rule !== undefined)?.code ?? null,
  }));
}
