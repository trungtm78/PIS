import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, BidAnalysisStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BidEvidenceLine, BidFindingLine, BidRunLine, ProposalViewer } from '@machvon/db';
import { DomainError, FINDING_STATUSES, RUN_STATUSES, asUuid, cancelReasonOf, runTimeline } from '@machvon/kernel';
import type { EffectiveAccess, RunStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { BidAnalysisService } from './analysis.service';
import { within } from './ocr.controller';

const EVALUATE_PERMISSION = PERMISSIONS.listAnalysisFindings;
const RUN_TYPE = 'analysis_run';
const MAX_COST = /^(0|[1-9][0-9]{0,17})$/;

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** A member of the evaluation team over the project who also holds the permission of the operation over it: the full view of a proposal is judged on top of that, for each read. */
function viewerOf(tenant: TenantContext, access: EffectiveAccess, permission: string, now: Date): ProposalViewer {
  return { membershipId: tenant.membershipId, evaluate: within(projectScope(access, EVALUATE_PERMISSION, now), projectScope(access, permission, now)), receive: () => ({ sql: 'false', params: [] }), now };
}

/** A run as a screen reads it: what it was asked and how it stands, never the hash of its input or the request it made at the gateway. */
export function runDto(run: BidRunLine): Record<string, unknown> {
  return {
    id: run.id,
    proposal_id: run.proposalId,
    package: { id: run.packageId, code: run.packageCode },
    contractor: { id: run.contractorId, legal_name: run.contractorName },
    criteria_version_id: run.criteriaVersionId,
    profile_version_id: run.profileVersionId,
    status: run.status,
    data_classification: run.dataClassification,
    route_class: run.routeClass,
    policy_version_id: run.policyVersionId,
    failure_code: run.failureCode,
    failed_step: run.failedStep,
    timeline: runTimeline(run.status, run.failedStep),
    supersedes_run_id: run.supersedesRunId,
    requested_by: run.requestedBy,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    cancel_reason: run.cancelReason,
    cost_vnd: run.costVnd,
    finding_count: run.findingCount,
    missing_source_count: run.missingSourceCount,
    reviewed_count: run.reviewedCount,
    created_at: run.createdAt,
    version: run.version,
  };
}

export function evidenceDto(evidence: BidEvidenceLine): Record<string, unknown> {
  return {
    id: evidence.id,
    kind: evidence.kind,
    document_version_id: evidence.documentVersionId,
    page_index: evidence.pageIndex,
    quote_excerpt: evidence.quoteExcerpt,
    calc_ref: evidence.calcRef,
    verified_present: evidence.verifiedPresent,
  };
}

/** A finding with the evidence under it: the AI proposal, never a decision (BR-BID-09). */
export function findingDto(finding: BidFindingLine): Record<string, unknown> {
  return {
    id: finding.id,
    run_id: finding.runId,
    criterion_id: finding.criterionId,
    status: finding.status,
    finding: finding.finding,
    confidence_type: finding.confidenceType,
    evidence_count: finding.evidenceCount,
    missing_source: finding.missingSource,
    final_status: finding.finalStatus,
    reviewed_at: finding.reviewedAt,
    created_at: finding.createdAt,
    evidence: finding.evidence.map(evidenceDto),
  };
}

/** The scaffold read of a finding: how it stands, without what it says or what it rests on. */
function findingSummaryDto(finding: BidFindingLine, proposalId: string | undefined): Record<string, unknown> {
  return {
    id: finding.id,
    run_id: finding.runId,
    proposal_id: proposalId ?? null,
    criterion_id: finding.criterionId,
    status: finding.status,
    confidence_type: finding.confidenceType,
    evidence_count: finding.evidenceCount,
    missing_source: finding.missingSource,
    final_status: finding.finalStatus,
    reviewed_at: finding.reviewedAt,
    created_at: finding.createdAt,
  };
}

function optional<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

/**
 * The AI analysis of a proposal (ST-BID-009, BID 3 F5, BR-BID-05/07, BID-07/08/09). A member of the evaluation team asks for a run of a proposal they have the full view of; the run reads the pages once no page waits for a
 * person, is classified and routed by the AI gateway (confidential bids go only to domestic or self-hosted models), and keeps the findings whose citations are on their pages. The same input is the same run; a new input is a new
 * run that supersedes the last, which is never rewritten. What the run, its findings and their evidence say is read only by whoever has the full view of the proposal: for anyone else it does not exist (404).
 */
@Controller()
export class AnalysisController {
  private readonly store = new BidAnalysisStore();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(BidAnalysisService) private readonly analysis: BidAnalysisService,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Post('analysis-runs')
  @HttpCode(200)
  @OperationId('post_analysis_runs')
  @Command({ operation: 'post_analysis_runs' })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AnalysisRequest']): Promise<CommandResult & { reused: boolean; failure_code: string | null }> {
    const now = new Date();
    const maxCost = body.max_cost_vnd;
    if (maxCost !== undefined && !MAX_COST.test(maxCost)) throw new DomainError('VALIDATION_FAILED', 422, 'max_cost_vnd');
    const { run, reused } = await this.analysis.start(scope, viewerOf(scope.tenant, access, PERMISSIONS.post_analysis_runs, now), {
      proposalId: idOf(body.proposal_id, 'proposal_id'),
      criteriaVersionId: idOf(body.criteria_version_id, 'criteria_version_id'),
      profileVersionId: idOf(body.profile_version_id, 'profile_version_id'),
      maxCostVnd: maxCost,
    });
    // The audit row and the event say what was asked and how it ended; they carry none of the text of the bid or of the findings.
    const facts = {
      proposal_id: run.proposalId,
      package_code: run.packageCode,
      contractor_id: run.contractorId,
      criteria_version_id: run.criteriaVersionId,
      profile_version_id: run.profileVersionId,
      data_classification: run.dataClassification,
      route_class: run.routeClass,
      status: run.status,
      failure_code: run.failureCode,
      supersedes_run_id: run.supersedesRunId,
      finding_count: run.findingCount,
      missing_source_count: run.missingSourceCount,
      cost_vnd: run.costVnd,
    };
    await scope.audit({ action: reused ? 'bid.analysis_repeated' : 'bid.analysis_requested', resourceType: RUN_TYPE, resourceId: run.id, diff: facts, classification: 'CONFIDENTIAL' });
    if (!reused) {
      await scope.emit({
        aggregateType: RUN_TYPE,
        aggregateId: run.id,
        aggregateVersion: run.version,
        type: 'bid.analysis.finished.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, run_id: run.id, ...facts, package_id: run.packageId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${RUN_TYPE}:${run.id}:${run.version}`,
      });
    }
    return { ...commandResult(scope, run.status, run.version, run.id), reused, failure_code: run.failureCode };
  }

  @Post('analysis-runs/:id/cancel')
  @HttpCode(200)
  @OperationId('post_analysis_runs_id_cancel')
  @Command({ operation: 'post_analysis_runs_id_cancel', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AnalysisCancel']): Promise<CommandResult> {
    const now = new Date();
    const reason = cancelReasonOf(body.reason);
    const { run, previousStatus } = await this.store.cancel(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, reason, viewerOf(scope.tenant, access, PERMISSIONS.post_analysis_runs_id_cancel, now));
    // What the run had cost stays settled at the gateway: the cancellation frees the input, it does not take back what was spent.
    await scope.audit({
      action: 'bid.analysis_cancelled',
      resourceType: RUN_TYPE,
      resourceId: run.id,
      reason,
      diff: { proposal_id: run.proposalId, package_code: run.packageCode, from_status: previousStatus, to_status: run.status, cost_vnd: run.costVnd, finding_count: run.findingCount },
      classification: 'CONFIDENTIAL',
    });
    await scope.emit({
      aggregateType: RUN_TYPE,
      aggregateId: run.id,
      aggregateVersion: run.version,
      type: 'bid.analysis.cancelled.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, run_id: run.id, proposal_id: run.proposalId, package_id: run.packageId, from_status: previousStatus, cost_vnd: run.costVnd, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RUN_TYPE}:${run.id}:${run.version}`,
    });
    return commandResult(scope, run.status, run.version, run.id);
  }

  @Get('analysis-runs/:id/findings')
  @OperationId('listAnalysisFindings')
  async findings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
    @Query('missing_source') missingSource?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter = { status: optional(status, FINDING_STATUSES, 'status'), missingSource: flag(missingSource, 'missing_source') };
    const now = new Date();
    const viewer = viewerOf(tenant, access, EVALUATE_PERMISSION, now);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const seen = await this.store.findRun(tx, id.toLowerCase(), viewer);
      if (seen.kind !== 'SEEN') return seen;
      const listed = await this.store.listFindings(tx, seen.run.id, filter, request);
      // Opening the evidence of a run of a sealed proposal is recorded: who, which run, how many findings.
      await this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'bid.findings_opened',
        resourceType: RUN_TYPE,
        resourceId: seen.run.id,
        diff: { proposal_id: seen.run.proposalId, package_code: seen.run.packageCode, contractor_id: seen.run.contractorId, finding_count: listed.findings.length },
        classification: 'CONFIDENTIAL',
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
      return { kind: 'SEEN' as const, run: seen.run, listed };
    });
    if (found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    return {
      run: runDto(found.run),
      items: found.listed.findings.map(findingDto),
      next_cursor: found.listed.more && found.listed.last !== undefined ? encodeCursor(found.listed.last) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('resources/analysis_run')
  @OperationId('get_resources_analysis_run')
  async runs(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('proposal_id') proposalId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter = { proposalId: proposalId === undefined ? undefined : idOf(proposalId, 'proposal_id'), status: optional<RunStatus>(status, RUN_STATUSES, 'status') };
    const now = new Date();
    const listed = await this.database.withTenant(tenant, (tx) => this.store.listRuns(tx, viewerOf(tenant, access, PERMISSIONS.get_resources_analysis_run, now), filter, request));
    return { items: listed.runs.map(runDto), next_cursor: listed.more && listed.last !== undefined ? encodeCursor(listed.last) : null, as_of: now.toISOString() };
  }

  @Get('resources/analysis_run/:id')
  @OperationId('get_resources_analysis_run_id')
  async run(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.store.findRun(tx, id.toLowerCase(), viewerOf(tenant, access, PERMISSIONS.get_resources_analysis_run_id, new Date())));
    if (found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    return runDto(found.run);
  }

  @Get('resources/analysis_finding')
  @OperationId('get_resources_analysis_finding')
  async findingList(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('run_id') runId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const filter = { runId: runId === undefined ? undefined : idOf(runId, 'run_id') };
    const listed = await this.database.withTenant(tenant, (tx) => this.store.listFindingSummaries(tx, viewerOf(tenant, access, PERMISSIONS.get_resources_analysis_finding, now), filter, request));
    return {
      items: listed.findings.map((finding) => findingSummaryDto(finding, finding.proposalId)),
      next_cursor: listed.more && listed.last !== undefined ? encodeCursor(listed.last) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('resources/analysis_finding/:id')
  @OperationId('get_resources_analysis_finding_id')
  async finding(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.store.findFinding(tx, id.toLowerCase(), viewerOf(tenant, access, PERMISSIONS.get_resources_analysis_finding_id, new Date())));
    if (found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    return findingSummaryDto(found.finding, undefined);
  }

  /**
   * The passages of the proposals of a package that answer a question (UAT-AC14). The files the question may be answered from are those of the proposals the caller has the full view of - a proposal of a contractor
   * they are recused from adds none - and that is decided before any text is embedded; the passages come back in order of nearness.
   */
  @Get('procurement-packages/:id/proposal-passages')
  @OperationId('searchProposalPassages')
  async passages(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('embedding_model_id') embeddingModelId?: unknown,
    @Query('question') question?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    const model = idOf(embeddingModelId, 'embedding_model_id');
    if (typeof question !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'question');
    const found = await this.analysis.search(tenant, viewerOf(tenant, access, EVALUATE_PERMISSION, new Date()), {
      packageId: id.toLowerCase(),
      embeddingModelId: model,
      question,
      limit: limit === undefined ? undefined : Number(limit),
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      items: found.map((passage) => ({
        document_version_id: passage.documentVersionId,
        page_index: passage.pageIndex,
        chunk_no: passage.chunkNo,
        classification: passage.classification,
        distance: passage.distance,
        text: passage.text,
      })),
      as_of: new Date().toISOString(),
    };
  }
}
