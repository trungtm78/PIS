import { randomUUID } from 'node:crypto';
import { ANALYSIS_TASK_TYPE, DomainError, analysisInputHash, assertCancellable, assertReadOnlyTools, classifySources, documentSetSha256, versionConflict } from '@machvon/kernel';
import type { AnalysisCriterion, Classification, FindingStatus, RunEnd, RunStatus, RunStep } from '@machvon/kernel';
import { BidOcrStore } from './bid-ocr-store.ts';
import { SqlParams } from './bid-plan-reads.ts';
import type { Page } from './bid-plan-reads.ts';
import { BidProposalReads } from './bid-proposal-reads.ts';
import type { ProposalLine, ProposalViewer } from './bid-proposal-reads.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { LlmEvalStore } from './llm-eval-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const NOT_LIVE = `'CANCELLED', 'FAILED', 'REJECTED_BY_POLICY'`;
/** The runs that hold their input: a run that was cancelled, that failed or that was refused leaves the same input free to be asked again. */
const LIVE_RUN = `r.status not in (${NOT_LIVE})`;
const CRITERIA_STATUS_APPROVED = 'APPROVED';

export interface RunLine {
  id: string;
  proposalId: string;
  packageId: string;
  packageCode: string;
  contractorId: string;
  contractorName: string;
  criteriaVersionId: string;
  profileVersionId: string;
  status: RunStatus;
  dataClassification: Classification;
  routeClass: string | null;
  failureCode: string | null;
  failedStep: RunStep | null;
  supersedesRunId: string | null;
  requestedBy: string;
  startedAt: string;
  finishedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  version: number;
  /** The record of the request to the gateway: the policy in force when it was routed and the cost that was settled. */
  policyVersionId: string | null;
  costVnd: string | null;
  findingCount: number;
  missingSourceCount: number;
  reviewedCount: number;
}

export interface EvidenceLine {
  id: string;
  kind: 'DOCUMENT' | 'SCORECARD' | 'DETERMINISTIC_CALC';
  documentVersionId: string | null;
  pageIndex: number | null;
  quoteExcerpt: string | null;
  calcRef: unknown;
  verifiedPresent: boolean;
}

export interface FindingLine {
  id: string;
  runId: string;
  criterionId: string;
  status: FindingStatus;
  finding: string;
  confidenceType: string;
  evidenceCount: number;
  missingSource: boolean;
  finalStatus: FindingStatus | null;
  reviewedAt: string | null;
  createdAt: string;
  evidence: EvidenceLine[];
}

export interface NewEvidence {
  kind: 'DOCUMENT' | 'DETERMINISTIC_CALC';
  documentVersionId?: string;
  pageIndex?: number;
  quoteSha256?: string;
  quoteExcerpt?: string;
  calcRef?: unknown;
  verifiedPresent: boolean;
}

export interface NewFinding {
  criterionCode: string;
  status: FindingStatus;
  text: string;
  missingSource: boolean;
  evidence: NewEvidence[];
}

/** A page the OCR recorded, with where its texts are kept: the analysis reads the corrected text of a page a person corrected. */
export interface RecordedOcrPage {
  documentVersionId: string;
  pageIndex: number;
  status: string;
  textObjectKey: string;
  textSha256: string;
  correctedTextObjectKey: string | null;
  correctedTextSha256: string | null;
  tables: unknown;
}

export interface RunContext {
  proposal: ProposalLine;
  criteriaVersionId: string;
  criteria: AnalysisCriterion[];
  profile: { id: string; promptVersionId: string; maxInputTokens: number | null; taskType: string };
  documents: Array<{ documentVersionId: string; checksum: string }>;
  documentSetSha256: string;
  inputHash: string;
  dataClassification: Classification;
  supersedesRunId: string | null;
  bidPriceVnd: string | null;
}

export type Admission = { kind: 'EXISTING'; run: RunLine } | { kind: 'NEW'; context: RunContext };

export type FoundRun = { kind: 'HIDDEN' } | { kind: 'DECLARATION_REQUIRED' } | { kind: 'SEEN'; run: RunLine };

export interface FindingFilter {
  status?: FindingStatus | undefined;
  missingSource?: boolean | undefined;
}

export interface CancelledRun {
  run: RunLine;
  previousStatus: RunStatus;
}

interface RunSql {
  id: string;
  proposal_id: string;
  package_id: string;
  package_code: string;
  contractor_id: string;
  legal_name: string;
  criteria_version_id: string;
  profile_version_id: string;
  status: RunStatus;
  data_classification: Classification;
  route_class: string | null;
  failure_code: string | null;
  failed_step: RunStep | null;
  supersedes_run_id: string | null;
  requested_by: string;
  started_at: string;
  finished_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  created_at_key: string;
  version: string;
  policy_version_id: string | null;
  cost_vnd: string | null;
  finding_count: number;
  missing_source_count: number;
  reviewed_count: number;
}

interface FindingSql {
  id: string;
  run_id: string;
  criterion_id: string;
  status: FindingStatus;
  finding: string;
  confidence_type: string;
  evidence_count: number;
  missing_source: boolean;
  final_status: FindingStatus | null;
  reviewed_at: string | null;
  created_at: string;
}

interface EvidenceSql {
  id: string;
  finding_id: string;
  evidence_kind: EvidenceLine['kind'];
  document_version_id: string | null;
  page_index: number | null;
  quote_excerpt: string | null;
  calc_ref: unknown;
  verified_present: boolean;
}

const RUN_SELECT = `select r.id, r.proposal_id, r.package_id, k.code as package_code, pr.contractor_id, c.legal_name, r.criteria_version_id, r.profile_version_id, r.status, r.data_classification, r.route_class,
    r.failure_code, r.failed_step, r.supersedes_run_id, r.requested_by, to_char(r.started_at at time zone 'UTC', ${ISO}) as started_at, to_char(r.finished_at at time zone 'UTC', ${ISO}) as finished_at, r.cancel_reason,
    to_char(r.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('r.created_at')} as created_at_key, r.version::text as version, a.policy_version_id, a.cost_vnd::text as cost_vnd,
    (select count(*)::int from machvon.analysis_finding f where f.tenant_id = r.tenant_id and f.run_id = r.id) as finding_count,
    (select count(*)::int from machvon.analysis_finding f where f.tenant_id = r.tenant_id and f.run_id = r.id and f.missing_source) as missing_source_count,
    (select count(*)::int from machvon.analysis_finding f where f.tenant_id = r.tenant_id and f.run_id = r.id and f.final_status is not null) as reviewed_count
  from machvon.analysis_run r
  join machvon.procurement_package k on k.tenant_id = r.tenant_id and k.id = r.package_id
  join machvon.proposal pr on pr.tenant_id = r.tenant_id and pr.id = r.proposal_id
  join machvon.contractor c on c.tenant_id = pr.tenant_id and c.id = pr.contractor_id
  left join machvon.ai_request a on a.tenant_id = r.tenant_id and a.id = r.ai_request_id`;

const FINDING_SELECT = `select f.id, f.run_id, f.criterion_id, f.status, f.finding, f.confidence_type, f.evidence_count, f.missing_source, f.final_status,
    to_char(f.reviewed_at at time zone 'UTC', ${ISO}) as reviewed_at, to_char(f.created_at at time zone 'UTC', ${ISO}) as created_at
  from machvon.analysis_finding f`;

const lineOf = (row: RunSql): RunLine => ({
  id: row.id,
  proposalId: row.proposal_id,
  packageId: row.package_id,
  packageCode: row.package_code,
  contractorId: row.contractor_id,
  contractorName: row.legal_name,
  criteriaVersionId: row.criteria_version_id,
  profileVersionId: row.profile_version_id,
  status: row.status,
  dataClassification: row.data_classification,
  routeClass: row.route_class,
  failureCode: row.failure_code,
  failedStep: row.failed_step,
  supersedesRunId: row.supersedes_run_id,
  requestedBy: row.requested_by,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  cancelReason: row.cancel_reason,
  createdAt: row.created_at,
  version: Number(row.version),
  policyVersionId: row.policy_version_id,
  costVnd: row.cost_vnd,
  findingCount: row.finding_count,
  missingSourceCount: row.missing_source_count,
  reviewedCount: row.reviewed_count,
});

const evidenceOf = (row: EvidenceSql): EvidenceLine => ({
  id: row.id,
  kind: row.evidence_kind,
  documentVersionId: row.document_version_id,
  pageIndex: row.page_index,
  quoteExcerpt: row.quote_excerpt,
  calcRef: row.calc_ref,
  verifiedPresent: row.verified_present,
});

const findingOf = (row: FindingSql, evidence: EvidenceLine[]): FindingLine => ({
  id: row.id,
  runId: row.run_id,
  criterionId: row.criterion_id,
  status: row.status,
  finding: row.finding,
  confidenceType: row.confidence_type,
  evidenceCount: row.evidence_count,
  missingSource: row.missing_source,
  finalStatus: row.final_status,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
  evidence,
});

const notFound = (field?: string): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404, field);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The AI analysis of a proposal (ST-BID-009, BID 3 F5, BR-BID-05/07, BID-07/08/09). A run is asked of a proposal the caller has the full view of, with the criteria of its package, a published profile and the files of the proposal
 * once no page of them waits for a person; its input is hashed and the same input is the same run; a new input is a new run that supersedes the last and leaves it as it was. The findings of a run and the evidence under them are
 * facts the database keeps from being rewritten. What a caller reads of a run, its findings and their evidence is what belongs to a proposal they have the full view of: for anyone else it does not exist.
 */
export class BidAnalysisStore {
  private readonly proposals = new BidProposalReads();
  private readonly ocr = new BidOcrStore();
  private readonly profiles = new LlmEvalStore();

  /**
   * The context of a run asked for, or the run that already stands for the same input. Refusals in order: the proposal is not one the caller has the full view of (404; 403 CONFLICT_UNDECLARED when they owe the
   * declaration), the criteria (404, 422 when they are of another package, 409 CRITERIA_STATE_INVALID unless approved), the profile (422 PROFILE_NOT_PUBLISHED, 422 TOOL_NOT_READ_ONLY), the pages (409 OCR_NOT_RECORDED, 409 OCR_REVIEW_PENDING).
   * Runs of one proposal are asked one after the other, so that the second of two requests for the same input finds the first.
   */
  async admit(tx: TenantTx, input: { proposalId: string; criteriaVersionId: string; profileVersionId: string }, viewer: ProposalViewer): Promise<Admission> {
    const found = await this.proposals.find(tx, input.proposalId, viewer);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (found.kind !== 'SEEN' || found.line.view !== 'FULL') throw notFound();
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bid_analysis:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [input.proposalId]);

    const criteria = await this.criteriaOf(tx, input.criteriaVersionId, found.line.package.id);
    const profile = await this.profileOf(tx, input.profileVersionId);
    const versionIds = found.files.map((file) => file.documentVersionId);
    const documents = await this.documentsOf(tx, versionIds);
    const setHash = documentSetSha256(documents.map((document) => ({ id: document.documentVersionId, checksum: document.checksum })));
    const inputHash = analysisInputHash({ criteriaVersionId: input.criteriaVersionId, documentSetSha256: setHash, profileVersionId: profile.id, promptVersionId: profile.promptVersionId });

    const existing = await tx.query<{ id: string }>(
      `select r.id from machvon.analysis_run r where r.proposal_id = $1::uuid and r.criteria_version_id = $2::uuid and r.input_hash = $3 and ${LIVE_RUN}`,
      [input.proposalId, input.criteriaVersionId, inputHash],
    );
    if (existing[0] !== undefined) return { kind: 'EXISTING', run: (await this.runById(tx, existing[0].id)) as RunLine };

    // A run is asked on criteria in force; the repeat of a run that stands is answered with it, even when the criteria were superseded since.
    if (criteria.status !== CRITERIA_STATUS_APPROVED) throw new DomainError('CRITERIA_STATE_INVALID', 409, 'status', { extensions: { criteria_status: criteria.status } });

    await this.assertPagesReady(tx, documents);
    const supersedes = await tx.query<{ id: string }>(
      `select r.id from machvon.analysis_run r where r.proposal_id = $1::uuid and ${LIVE_RUN} order by r.created_at desc, r.id desc limit 1`,
      [input.proposalId],
    );
    return {
      kind: 'NEW',
      context: {
        proposal: found.line,
        criteriaVersionId: input.criteriaVersionId,
        criteria: criteria.criteria,
        profile,
        documents: documents.map((document) => ({ documentVersionId: document.documentVersionId, checksum: document.checksum })),
        documentSetSha256: setHash,
        inputHash,
        dataClassification: classifySources(documents.map((document) => ({ documentVersionId: document.documentVersionId, classification: document.classification }))).classification,
        supersedesRunId: supersedes[0]?.id ?? null,
        bidPriceVnd: await this.bidPriceOf(tx, input.proposalId),
      },
    };
  }

  private async criteriaOf(tx: TenantTx, id: string, packageId: string): Promise<{ status: string; criteria: AnalysisCriterion[] }> {
    const rows = await tx.query<{ package_id: string; status: string; criteria_json: { criteria?: Array<{ code: string; name: string; kind: string; weight: number | null; max_score: number | null; threshold: number | null; mandatory: boolean; required_evidence?: string[] }> } }>(
      'select package_id, status, criteria_json from machvon.criteria_version where id = $1::uuid',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw notFound('criteria_version_id');
    if (row.package_id !== packageId) throw invalid('criteria_version_id');
    return {
      status: row.status,
      criteria: (row.criteria_json.criteria ?? []).map((criterion) => ({
        code: criterion.code,
        name: criterion.name,
        kind: criterion.kind,
        weight: criterion.weight,
        maxScore: criterion.max_score,
        threshold: criterion.threshold,
        mandatory: criterion.mandatory,
        requiredEvidence: criterion.required_evidence ?? [],
      })),
    };
  }

  private async profileOf(tx: TenantTx, id: string): Promise<RunContext['profile']> {
    const profile = await this.profiles.findProfile(tx, id);
    if (profile === undefined || profile.status !== 'PUBLISHED' || profile.taskType !== ANALYSIS_TASK_TYPE || profile.promptVersionId === null) throw new DomainError('PROFILE_NOT_PUBLISHED', 422, 'profile_version_id');
    assertReadOnlyTools(profile.toolAllowlist);
    return { id: profile.id, promptVersionId: profile.promptVersionId, maxInputTokens: profile.maxInputTokens, taskType: profile.taskType };
  }

  private async documentsOf(tx: TenantTx, versionIds: readonly string[]): Promise<Array<{ documentVersionId: string; checksum: string; classification: Classification; pageCount: number | null }>> {
    const rows = await tx.query<{ id: string; checksum: string; classification: Classification; page_count: number | null }>(
      'select id, checksum, classification, page_count from machvon.document_version where id = any($1::uuid[]) order by id',
      [[...versionIds]],
    );
    return rows.map((row) => ({ documentVersionId: row.id, checksum: row.checksum, classification: row.classification, pageCount: row.page_count }));
  }

  private async bidPriceOf(tx: TenantTx, proposalId: string): Promise<string | null> {
    const rows = await tx.query<{ bid_price_vnd: string | null }>('select bid_price_vnd::text as bid_price_vnd from machvon.proposal where id = $1::uuid', [proposalId]);
    return rows[0]?.bid_price_vnd ?? null;
  }

  /** Every file has its pages recorded, and none of the pages waits for a person (BR-BID-06). */
  private async assertPagesReady(tx: TenantTx, documents: ReadonlyArray<{ documentVersionId: string; pageCount: number | null }>): Promise<void> {
    const counts = await tx.query<{ document_version_id: string; pages: number }>(
      'select document_version_id, count(*)::int as pages from machvon.document_page_ocr where document_version_id = any($1::uuid[]) group by document_version_id',
      [documents.map((document) => document.documentVersionId)],
    );
    const recorded = new Map(counts.map((row) => [row.document_version_id, row.pages] as const));
    const missing = documents.filter((document) => (recorded.get(document.documentVersionId) ?? 0) < (document.pageCount ?? 1));
    if (missing.length > 0) throw new DomainError('OCR_NOT_RECORDED', 409, 'document_version_id', { extensions: { document_version_ids: missing.map((document) => document.documentVersionId) } });
    const gate = await this.ocr.gate(
      tx,
      documents.map((document) => document.documentVersionId),
    );
    if (!gate.ready) throw new DomainError('OCR_REVIEW_PENDING', 409, 'pages', { extensions: { blocked_pages: gate.blocked.length } });
  }

  /** The pages the OCR recorded for the files of a run, in the order of the files and of the pages. */
  async pagesOf(tx: TenantTx, documentVersionIds: readonly string[]): Promise<RecordedOcrPage[]> {
    const rows = await tx.query<{
      document_version_id: string;
      page_index: number;
      review_status: string;
      text_object_key: string;
      text_sha256: string;
      corrected_text_object_key: string | null;
      corrected_text_sha256: string | null;
      tables_json: unknown;
    }>(
      `select document_version_id, page_index, review_status, text_object_key, text_sha256, corrected_text_object_key, corrected_text_sha256, tables_json
         from machvon.document_page_ocr where document_version_id = any($1::uuid[]) order by document_version_id, page_index`,
      [[...documentVersionIds]],
    );
    return rows.map((row) => ({
      documentVersionId: row.document_version_id,
      pageIndex: row.page_index,
      status: row.review_status,
      textObjectKey: row.text_object_key,
      textSha256: row.text_sha256,
      correctedTextObjectKey: row.corrected_text_object_key,
      correctedTextSha256: row.corrected_text_sha256,
      tables: row.tables_json,
    }));
  }

  /** Begins a run: it is RUNNING, with the input it will keep for good. */
  async begin(tx: TenantTx, context: RunContext, actor: string): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.analysis_run (tenant_id, id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, package_id, data_classification, prompt_version_id, document_version_set_sha256, supersedes_run_id, requested_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'RUNNING', $6::uuid, $7, $8::uuid, $9, $10::uuid, $11::uuid)`,
      [id, context.proposal.id, context.criteriaVersionId, context.profile.id, context.inputHash, context.proposal.package.id, context.dataClassification, context.profile.promptVersionId, context.documentSetSha256, context.supersedesRunId, actor],
    );
    return id;
  }

  /** Writes the findings of a run with the evidence under each, while the run runs. The number of citations a finding stands on is the number of its evidence that was found on its page. */
  async saveFindings(tx: TenantTx, runId: string, findings: readonly NewFinding[], confidenceType: string): Promise<void> {
    for (const finding of findings) {
      const id = randomUUID();
      const verified = finding.evidence.filter((evidence) => evidence.verifiedPresent);
      const refs = verified.map((evidence) => (evidence.kind === 'DOCUMENT' ? { document_version_id: evidence.documentVersionId, page_index: evidence.pageIndex } : { calc_ref: (evidence.calcRef as { id: string }).id }));
      await tx.query(
        `insert into machvon.analysis_finding (tenant_id, id, run_id, criterion_id, status, finding, evidence_refs, confidence_type, evidence_count, missing_source)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::int, $9)`,
        [id, runId, finding.criterionCode, finding.status, finding.text, JSON.stringify(refs), confidenceType, verified.length, finding.missingSource],
      );
      for (const evidence of finding.evidence) {
        await tx.query(
          `insert into machvon.analysis_evidence (tenant_id, id, finding_id, evidence_kind, document_version_id, page_index, quote_sha256, quote_excerpt, calc_ref, verified_present)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::int, $5, $6, $7::jsonb, $8)`,
          [
            id,
            evidence.kind,
            evidence.documentVersionId ?? null,
            evidence.pageIndex ?? null,
            evidence.quoteSha256 ?? null,
            evidence.quoteExcerpt ?? null,
            evidence.calcRef === undefined ? null : JSON.stringify(evidence.calcRef),
            evidence.verifiedPresent,
          ],
        );
      }
    }
  }

  /** Ends the run the pipeline began: once, to the end it reached, with the request it made and the hold of its budget. */
  async finish(tx: TenantTx, id: string, end: RunEnd, request: { aiRequestId: string; routeClass: string | null; budgetReservationId: string | null }): Promise<RunLine> {
    await tx.query(
      `update machvon.analysis_run set status = $2, failure_code = $3, failed_step = $4, ai_request_id = $5::uuid, route_class = $6, budget_reservation_id = $7::uuid, finished_at = now(), version = version + 1
        where id = $1::uuid`,
      [id, end.status, end.failureCode, end.failedStep, request.aiRequestId, request.routeClass, request.budgetReservationId],
    );
    return (await this.runById(tx, id)) as RunLine;
  }

  /** Ends the run on the step that came after the model answered: the answer was used and was not a set of findings. */
  async fail(tx: TenantTx, id: string, failureCode: string, failedStep: RunStep, request: { aiRequestId: string; routeClass: string | null; budgetReservationId: string | null }): Promise<RunLine> {
    return this.finish(tx, id, { status: 'FAILED', failureCode, failedStep }, request);
  }

  private async runById(tx: TenantTx, id: string): Promise<RunLine | undefined> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------------------

  /** One run as the caller may see it: it exists only for whoever has the full view of its proposal (403 when they owe the declaration). */
  async findRun(tx: TenantTx, id: string, viewer: ProposalViewer): Promise<FoundRun> {
    const run = await this.runById(tx, id);
    if (run === undefined) return { kind: 'HIDDEN' };
    const found = await this.proposals.find(tx, run.proposalId, viewer);
    if (found.kind === 'DECLARATION_REQUIRED') return { kind: 'DECLARATION_REQUIRED' };
    if (found.kind !== 'SEEN' || found.line.view !== 'FULL') return { kind: 'HIDDEN' };
    return { kind: 'SEEN', run };
  }

  /** A page of the runs the caller may see, newest first. The page can hold fewer runs than its size when the next ones belong to proposals hidden from the caller. */
  async listRuns(tx: TenantTx, viewer: ProposalViewer, filter: { proposalId?: string | undefined; status?: RunStatus | undefined }, page: Page): Promise<{ runs: RunLine[]; more: boolean; last: { code: string; id: string } | undefined }> {
    assertTimestampCursor(page.after?.code);
    const params = new SqlParams();
    const where: string[] = [];
    if (filter.proposalId !== undefined) where.push(`r.proposal_id = ${params.add(filter.proposalId)}::uuid`);
    if (filter.status !== undefined) where.push(`r.status = ${params.add(filter.status)}`);
    if (page.after !== undefined) where.push(`(${timestampKey('r.created_at')}, r.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<RunSql>(
      `${RUN_SELECT} ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by r.created_at desc, r.id desc limit ${params.add(page.limit + 1)}`,
      params.values,
    );
    const shown = rows.slice(0, page.limit);
    const visible = await this.proposals.fullView(tx, viewer, [...new Set(shown.map((row) => row.proposal_id))]);
    const tail = shown[shown.length - 1];
    return { runs: shown.filter((row) => visible.has(row.proposal_id)).map(lineOf), more: rows.length > page.limit, last: tail === undefined ? undefined : { code: tail.created_at_key, id: tail.id } };
  }

  /** The findings of a run with the evidence under each, in the order of the criteria. */
  async listFindings(tx: TenantTx, runId: string, filter: FindingFilter, page: Page): Promise<{ findings: FindingLine[]; more: boolean; last: { code: string; id: string } | undefined }> {
    const params = new SqlParams();
    const where = [`f.run_id = ${params.add(runId)}::uuid`];
    if (filter.status !== undefined) where.push(`f.status = ${params.add(filter.status)}`);
    if (filter.missingSource !== undefined) where.push(`f.missing_source = ${params.add(filter.missingSource)}`);
    if (page.after !== undefined) where.push(`(f.criterion_id, f.id) > (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<FindingSql>(`${FINDING_SELECT} where ${where.join(' and ')} order by f.criterion_id, f.id limit ${params.add(page.limit + 1)}`, params.values);
    const shown = rows.slice(0, page.limit);
    const evidence = await this.evidenceOf(tx, shown.map((row) => row.id));
    const tail = shown[shown.length - 1];
    return { findings: shown.map((row) => findingOf(row, evidence.get(row.id) ?? [])), more: rows.length > page.limit, last: tail === undefined ? undefined : { code: tail.criterion_id, id: tail.id } };
  }

  private async evidenceOf(tx: TenantTx, findingIds: readonly string[]): Promise<Map<string, EvidenceLine[]>> {
    const byFinding = new Map<string, EvidenceLine[]>();
    if (findingIds.length === 0) return byFinding;
    const rows = await tx.query<EvidenceSql>(
      `select e.id, e.finding_id, e.evidence_kind, e.document_version_id, e.page_index, e.quote_excerpt, e.calc_ref, e.verified_present
         from machvon.analysis_evidence e where e.finding_id = any($1::uuid[]) order by e.verified_present desc, e.evidence_kind, e.document_version_id, e.page_index, e.id`,
      [[...findingIds]],
    );
    for (const row of rows) byFinding.set(row.finding_id, [...(byFinding.get(row.finding_id) ?? []), evidenceOf(row)]);
    return byFinding;
  }

  /** A page of the findings (without the evidence) of the runs of proposals the caller has the full view of, newest first. */
  async listFindingSummaries(tx: TenantTx, viewer: ProposalViewer, filter: { runId?: string | undefined }, page: Page): Promise<{ findings: Array<FindingLine & { proposalId: string }>; more: boolean; last: { code: string; id: string } | undefined }> {
    assertTimestampCursor(page.after?.code);
    const params = new SqlParams();
    const where: string[] = [];
    if (filter.runId !== undefined) where.push(`f.run_id = ${params.add(filter.runId)}::uuid`);
    if (page.after !== undefined) where.push(`(${timestampKey('f.created_at')}, f.id) < (${params.add(page.after.code)}::text, ${params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<FindingSql & { proposal_id: string; created_at_key: string }>(
      `select f.id, f.run_id, f.criterion_id, f.status, f.finding, f.confidence_type, f.evidence_count, f.missing_source, f.final_status, to_char(f.reviewed_at at time zone 'UTC', ${ISO}) as reviewed_at,
              to_char(f.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('f.created_at')} as created_at_key, r.proposal_id
         from machvon.analysis_finding f join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id
         ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by f.created_at desc, f.id desc limit ${params.add(page.limit + 1)}`,
      params.values,
    );
    const shown = rows.slice(0, page.limit);
    const visible = await this.proposals.fullView(tx, viewer, [...new Set(shown.map((row) => row.proposal_id))]);
    const tail = shown[shown.length - 1];
    return {
      findings: shown.filter((row) => visible.has(row.proposal_id)).map((row) => ({ ...findingOf(row, []), proposalId: row.proposal_id })),
      more: rows.length > page.limit,
      last: tail === undefined ? undefined : { code: tail.created_at_key, id: tail.id },
    };
  }

  /** One finding (without its evidence) of a run the caller may see. */
  async findFinding(tx: TenantTx, id: string, viewer: ProposalViewer): Promise<{ kind: 'HIDDEN' } | { kind: 'DECLARATION_REQUIRED' } | { kind: 'SEEN'; finding: FindingLine }> {
    const rows = await tx.query<FindingSql>(`${FINDING_SELECT} where f.id = $1::uuid`, [id]);
    const row = rows[0];
    if (row === undefined) return { kind: 'HIDDEN' };
    const found = await this.findRun(tx, row.run_id, viewer);
    return found.kind === 'SEEN' ? { kind: 'SEEN', finding: findingOf(row, []) } : found;
  }

  /**
   * Cancels a run that is not over, or that waits for the experts with none of its findings reviewed (BID F5). The caller names the version they saw (409 VERSION_CONFLICT otherwise); a run that is over, or one an
   * expert already reviewed a finding of, is not cancelled (409 ANALYSIS_STATE_INVALID). The run and its findings stay as they are: the cancelled run only frees its input to be asked again.
   */
  async cancel(tx: TenantTx, id: string, expectedVersion: number, reason: string, viewer: ProposalViewer): Promise<CancelledRun> {
    const found = await this.findRun(tx, id, viewer);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (found.kind === 'HIDDEN') throw notFound();
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bid_analysis:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [found.run.proposalId]);
    const current = (await this.runById(tx, id)) as RunLine;
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    assertCancellable(current.status, current.reviewedCount);
    await tx.query("update machvon.analysis_run set status = 'CANCELLED', cancel_reason = $2, finished_at = coalesce(finished_at, now()), version = version + 1 where id = $1::uuid", [id, reason]);
    return { run: (await this.runById(tx, id)) as RunLine, previousStatus: current.status };
  }

  /**
   * The files of the proposals of a package that the caller has the full view of: what a question over the proposals may be answered from. A proposal of a contractor the caller is recused from, one that is
   * sealed, replaced or not yet released adds none. A package of a project the caller does not evaluate does not exist for them (undefined).
   */
  async permittedDocumentVersions(tx: TenantTx, packageId: string, viewer: ProposalViewer): Promise<Array<{ documentVersionId: string; classification: Classification }> | undefined> {
    const params = new SqlParams();
    const evaluate = params.scope(viewer.evaluate);
    const reach = await tx.query(
      `select 1 from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = ${params.add(packageId)}::uuid and ${evaluate}`,
      params.values,
    );
    if (reach.length === 0) return undefined;
    const candidates = await tx.query<{ id: string }>('select id from machvon.proposal where package_id = $1::uuid', [packageId]);
    const visible = await this.proposals.fullView(
      tx,
      viewer,
      candidates.map((row) => row.id),
    );
    if (visible.size === 0) return [];
    const rows = await tx.query<{ id: string; classification: Classification }>(
      `select distinct v.id, v.classification from machvon.proposal_document pd join machvon.document_version v on v.tenant_id = pd.tenant_id and v.id = pd.document_version_id
        where pd.proposal_id = any($1::uuid[]) order by v.id`,
      [[...visible]],
    );
    return rows.map((row) => ({ documentVersionId: row.id, classification: row.classification }));
  }
}
