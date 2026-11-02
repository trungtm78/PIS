import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { BidAnalysisStore, TenantDatabase } from '@machvon/db';
import type { BidNewEvidence, BidNewFinding, BidRunContext, BidRunLine, ProposalViewer, RecordedOcrPage } from '@machvon/db';
import {
  ANALYSIS_TASK_TYPE,
  DomainError,
  NOOP_METRICS,
  assertInputFits,
  buildAnalysisInput,
  chunkPages,
  classifySources,
  missingEvidenceRatio,
  parseAnswer,
  priceFacts,
  quoteIsPresent,
  quoteSha256,
  runEnd,
  settleFinding,
} from '@machvon/kernel';
import type { CalcFact, Citation, Classification, MetricsSink, ModelFinding, TenantContext } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { FileService } from '../files';
import { LlmGatewayService } from '../llm/gateway.service';
import { AiKnowledgeService } from '../llm/knowledge.service';
import { BID_METRICS } from './tokens';

/** The purpose under which the input of a run is kept in the store of the tenant. */
const INPUT_KIND = 'bid-analysis-input';
const JSON_TYPE = 'application/json';
/** The signal of a finding is the model's own, not yet calibrated against an evaluation (BR-BID-08). */
const CONFIDENCE_TYPE = 'HEURISTIC';
const SUBJECT_MODULE = 'BID';

/** A passage of a proposal that answers a question: where it is and what it says. */
export interface FoundPassage {
  documentVersionId: string;
  pageIndex: number;
  chunkNo: number;
  classification: Classification;
  distance: number;
  text: string;
}

export interface StartedRun {
  run: BidRunLine;
  /** The run already stood for the same input: nothing was asked of a model. */
  reused: boolean;
}

interface PageText {
  documentVersionId: string;
  pageIndex: number;
  text: string;
  tables: unknown;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The pipeline of an analysis run (ST-BID-009, BID 3 F5): it extracts the text of the pages a person made reliable, computes the figures of the price in code, asks the AI gateway for a finding per criterion with the text
 * of the bid wrapped as data, and keeps only what the pages bear out - a citation is kept as verified when its words are on the page it names, and a finding that claims without one is downgraded to NEEDS_REVIEW. The class of the data,
 * the route, the budget and the checks of the answer are the gateway's (`LlmGatewayService`); this adds what is the bid's. The pipeline runs in the transaction of the command, so a run is either whole or not there; a request the
 * gateway refuses is kept as the run it ended.
 */
@Injectable()
export class BidAnalysisService {
  private readonly store = new BidAnalysisStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(LlmGatewayService) private readonly gateway: LlmGatewayService,
    @Inject(FileService) private readonly files: FileService,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(AiKnowledgeService) private readonly knowledge: AiKnowledgeService,
    @Optional() @Inject(BID_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  async start(scope: CommandScope, viewer: ProposalViewer, input: { proposalId: string; criteriaVersionId: string; profileVersionId: string; maxCostVnd: string | undefined }): Promise<StartedRun> {
    const { tx, tenant } = scope;
    const admission = await this.store.admit(tx, input, viewer);
    if (admission.kind === 'EXISTING') return { run: admission.run, reused: true };
    const { context } = admission;

    // EXTRACT: the text of every page, the corrected text where a person corrected it, each checked against the digest recorded with it.
    const versionIds = context.documents.map((document) => document.documentVersionId);
    const pages = await this.readPages(tenant, await this.store.pagesOf(tx, versionIds));
    const facts = priceFacts(pages, context.bidPriceVnd);
    const body = buildAnalysisInput({ criteria: context.criteria, pages, facts });
    assertInputFits(body.length, context.profile.maxInputTokens);
    const bytes = new TextEncoder().encode(body);
    const inputRef = await this.files.storeGenerated(tenant, INPUT_KIND, randomUUID(), bytes, JSON_TYPE);
    scope.afterRollback(async () => {
      await this.files.remove(tenant, inputRef);
    });

    const runId = await this.store.begin(tx, context, tenant.membershipId);
    // MATCH: the gateway classifies, routes, holds the budget and checks the answer; whatever it ends with is the end of the run.
    const outcome = await this.gateway.request(scope, {
      taskType: ANALYSIS_TASK_TYPE,
      subjectModule: SUBJECT_MODULE,
      subjectId: context.proposal.id,
      sourceRefs: versionIds.map((id) => ({ document_version_id: id })),
      inputRef,
      inputSha256: sha256(bytes),
      anonymisationAttestationId: undefined,
      maxCostVnd: input.maxCostVnd,
      profileVersionId: context.profile.id,
      projectId: context.proposal.project.id,
    });
    const request = { aiRequestId: outcome.request.id, routeClass: outcome.request.routeClass, budgetReservationId: outcome.request.budgetReservationId };
    const end = runEnd({ status: outcome.request.status, rejectCode: outcome.request.rejectCode });
    if (end.status !== 'AWAITING_REVIEW') return this.ended(scope, await this.store.finish(tx, runId, end, request), []);

    // VERIFY: every citation is looked for on the page it names, and a finding that claims without one is not taken as supported.
    const parsed = parseAnswer(
      outcome.output ?? '',
      context.criteria.map((criterion) => criterion.code),
    );
    if (!parsed.ok) return this.ended(scope, await this.store.fail(tx, runId, 'OUTPUT_INVALID', 'VERIFY', request), []);
    const findings = parsed.findings.map((finding) => this.settle(finding, context, pages, facts));
    await this.store.saveFindings(tx, runId, findings, CONFIDENCE_TYPE);
    return this.ended(scope, await this.store.finish(tx, runId, end, request), findings);
  }

  /**
   * The passages of the proposals of a package that are nearest to a question (UAT-AC14, BR-BID-03). The candidates are the pages of the files of the proposals the caller has the full view of - declared, released and
   * with no conflict standing - so the access list is applied before any text is embedded or compared, and a proposal the caller is recused from is never in the set. Undefined when the package is not one the caller evaluates.
   */
  async search(tenant: TenantContext, viewer: ProposalViewer, input: { packageId: string; embeddingModelId: string; question: string; limit: number | undefined }): Promise<FoundPassage[] | undefined> {
    const permitted = await this.database.withTenant(tenant, (tx) => this.store.permittedDocumentVersions(tx, input.packageId, viewer));
    if (permitted === undefined) return undefined;
    if (permitted.length === 0) return [];
    const pages = await this.database.withTenant(tenant, async (tx) =>
      this.readPages(
        tenant,
        await this.store.pagesOf(
          tx,
          permitted.map((file) => file.documentVersionId),
        ),
      ),
    );
    const passages = new Map<string, FoundPassage>();
    for (const file of permitted) {
      const texts: string[] = [];
      for (const page of pages.filter((candidate) => candidate.documentVersionId === file.documentVersionId)) texts[page.pageIndex] = page.text;
      for (const chunk of chunkPages(Array.from(texts, (text) => text ?? ''))) {
        passages.set(`${file.documentVersionId}:${chunk.pageIndex}:${chunk.chunkNo}`, { documentVersionId: file.documentVersionId, pageIndex: chunk.pageIndex, chunkNo: chunk.chunkNo, classification: file.classification, distance: 0, text: chunk.text });
      }
    }
    const ranked = await this.knowledge.rank(this.database, tenant, {
      embeddingModelId: input.embeddingModelId,
      classification: classifySources(permitted).classification,
      question: input.question,
      passages: [...passages].map(([ref, passage]) => ({ ref, text: passage.text })),
      limit: input.limit,
    });
    return ranked.map((entry) => ({ ...(passages.get(entry.ref) as FoundPassage), distance: entry.distance }));
  }

  /**
   * The texts of the pages in the store, in the order the pages were recorded; a text that is not there or does not match its digest is not read as the page. The tables are the engine's reading: a page a person
   * corrected has none, because the structured amounts were not corrected with the text and a figure computed from them would be certified against a page that says otherwise.
   */
  private async readPages(tenant: TenantContext, recorded: readonly RecordedOcrPage[]): Promise<PageText[]> {
    const pages: PageText[] = [];
    for (const page of recorded) {
      const corrected = page.status === 'CORRECTED' && page.correctedTextObjectKey !== null && page.correctedTextSha256 !== null;
      const key = corrected ? (page.correctedTextObjectKey as string) : page.textObjectKey;
      const expected = corrected ? (page.correctedTextSha256 as string) : page.textSha256;
      pages.push({ documentVersionId: page.documentVersionId, pageIndex: page.pageIndex, text: await this.textOf(tenant, key, expected), tables: corrected ? [] : page.tables });
    }
    return pages;
  }

  private async textOf(tenant: TenantContext, key: string, expectedSha256: string): Promise<string> {
    let stored: Awaited<ReturnType<FileService['readStored']>>;
    try {
      stored = await this.files.readStored(tenant, key);
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) throw new DomainError('OCR_NOT_RECORDED', 409, 'page_text');
      throw error;
    }
    if (sha256(stored.bytes) !== expectedSha256) throw new DomainError('OCR_NOT_RECORDED', 409, 'page_text');
    return new TextDecoder().decode(stored.bytes);
  }

  /** What the pages bear out of a finding of the model: each citation checked, the evidence kept, the status settled. */
  private settle(finding: ModelFinding, context: BidRunContext, pages: readonly PageText[], facts: readonly CalcFact[]): BidNewFinding {
    const evidence = new Map<string, BidNewEvidence>();
    for (const citation of finding.citations) {
      const checked = this.check(citation, context, pages, facts);
      if (checked !== undefined) evidence.set(JSON.stringify(checked), checked);
    }
    const kept = [...evidence.values()];
    const settled = settleFinding(
      finding.status,
      kept.filter((entry) => entry.verifiedPresent).length,
    );
    return { criterionCode: finding.criterionCode, status: settled.status, text: finding.text, missingSource: settled.missingSource, evidence: kept };
  }

  /** A citation of a page is verified when the words are on that page of a file of the run; one that names a file the run did not read is not kept at all. A figure is verified when the pipeline computed it. */
  private check(citation: Citation, context: BidRunContext, pages: readonly PageText[], facts: readonly CalcFact[]): BidNewEvidence | undefined {
    if (citation.kind === 'CALC') {
      const fact = facts.find((candidate) => candidate.id === citation.calcRef);
      return fact === undefined ? undefined : { kind: 'DETERMINISTIC_CALC', calcRef: fact, verifiedPresent: true };
    }
    if (!context.documents.some((document) => document.documentVersionId === citation.documentVersionId)) return undefined;
    const page = pages.find((candidate) => candidate.documentVersionId === citation.documentVersionId && candidate.pageIndex === citation.pageIndex);
    return {
      kind: 'DOCUMENT',
      documentVersionId: citation.documentVersionId,
      pageIndex: citation.pageIndex,
      quoteSha256: quoteSha256(citation.quote),
      quoteExcerpt: citation.quote,
      verifiedPresent: page !== undefined && quoteIsPresent(page.text, citation.quote),
    };
  }

  /** A run that ended; its metrics are told once it is committed (TK-BID-009-6): what it cost, and the share of its findings that lack a source when it made any. */
  private ended(scope: CommandScope, run: BidRunLine, findings: ReadonlyArray<BidNewFinding>): StartedRun {
    const labels = { tenant_id: scope.tenant.tenantId, route: run.routeClass ?? 'NONE' };
    scope.afterCommit(() => {
      this.metrics.gauge('bid_run_cost_vnd', Number(run.costVnd ?? '0'), labels);
      if (findings.length > 0) this.metrics.gauge('bid_finding_missing_evidence_ratio', missingEvidenceRatio(findings), labels);
    });
    return { run, reused: false };
  }
}
