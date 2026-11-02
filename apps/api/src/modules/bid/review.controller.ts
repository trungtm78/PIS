import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AiDecisionStore, AuditWriter, BidReviewStore, TenantDatabase } from '@machvon/db';
import type { BidComparisonRead, BidReviewTarget } from '@machvon/db';
import { DomainError, asUuid, decisionFormOf, reviewReasonOf, reviewStatusOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { viewerOf } from './analysis.controller';

const FINDING_TYPE = 'analysis_finding';
const PACKAGE_TYPE = 'procurement_package';

type Reviewed = CommandResult & {
  review_id: string;
  decision: string;
  final_status: string;
  final_score: string | null;
  ai_decision_record_id: string;
  run_status: string;
};

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The comparison as BID-10 reads it: what a person decided, cell by cell, and what was left out and why. Nothing here ranks the proposals or names one. */
export function comparisonDto(read: BidComparisonRead, asOf: string): Record<string, unknown> {
  const { comparison } = read;
  return {
    package: read.package,
    criteria_version_id: comparison.criteriaVersionId,
    criteria_status: read.criteriaStatus,
    proposals: comparison.proposals.map((proposal) => ({
      proposal_id: proposal.proposalId,
      contractor: { id: proposal.contractor.id, legal_name: proposal.contractor.name },
      run_id: proposal.runId,
      run_status: proposal.runStatus,
      criteria_count: proposal.criteriaCount,
      decided_count: proposal.decidedCount,
      mandatory_not_met: proposal.mandatoryNotMet,
      weighted_score: proposal.weightedScore,
    })),
    rows: comparison.rows.map((row) => ({
      criterion: {
        code: row.criterion.code,
        name: row.criterion.name,
        kind: row.criterion.kind,
        weight: row.criterion.weight,
        max_score: row.criterion.maxScore,
        threshold: row.criterion.threshold,
        mandatory: row.criterion.mandatory,
      },
      cells: row.cells.map((cell) => ({
        proposal_id: cell.proposalId,
        finding_id: cell.findingId,
        decided: cell.decided === null ? null : { status: cell.decided.status, score: cell.decided.score, decision: cell.decided.decision, decided_at: cell.decided.decidedAt },
        risk: cell.risk,
      })),
    })),
    excluded: comparison.excluded.map((entry) => ({
      proposal_id: entry.proposalId,
      contractor: { id: entry.contractor.id, legal_name: entry.contractor.name },
      run_id: entry.runId,
      criteria_version_id: entry.criteriaVersionId,
      reason: entry.reason,
    })),
    excluded_criteria: comparison.excludedCriteria,
    excluded_attributes: comparison.excludedAttributes,
    as_of: asOf,
  };
}

/**
 * The review of the findings of an analysis by an expert and the comparison of proposals (ST-BID-010, BID 3 F6, BR-BID-03/09/10/11, BID-10/12). A member of the evaluation team with the full view of a proposal decides what
 * stands for a finding of the analysis: the status, and the score, with a reason of at least 20 characters. The decision is a row of its own and the record of the decision of a person about an answer of the AI, in one
 * transaction; the finding is never changed and nothing accepts all the findings at once. The comparison is built from what the experts decided on one version of the criteria, never from what the model said.
 */
@Controller()
export class ReviewController {
  private readonly store = new BidReviewStore();
  private readonly decisions = new AiDecisionStore();
  private readonly audit: AuditWriter;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {
    this.audit = new AuditWriter(database);
  }

  @Post('analysis-findings/:id/review')
  @HttpCode(200)
  @OperationId('reviewAnalysisFinding')
  @Command({ operation: 'reviewAnalysisFinding', versioned: true })
  async review(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidFindingReview']): Promise<Reviewed> {
    const reason = reviewReasonOf(body.reason);
    const target: BidReviewTarget = { kind: 'STATUS', status: reviewStatusOf(body.to_status), score: body.score_after };
    return this.record(scope, access, PERMISSIONS.reviewAnalysisFinding, { findingId: id.toLowerCase(), target, reason, checkedEvidenceIds: [] });
  }

  /** The baseline form of the same command: the expert approves what stands for the finding or sets it aside, and names the citations they checked. */
  @Post('findings/:id/review')
  @HttpCode(200)
  @OperationId('post_findings_id_review')
  @Command({ operation: 'post_findings_id_review', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidFindingDecision']): Promise<Reviewed> {
    const reason = reviewReasonOf(body.reason);
    const target: BidReviewTarget = { kind: 'FORM', form: decisionFormOf(body.decision) };
    return this.record(scope, access, PERMISSIONS.post_findings_id_review, { findingId: id.toLowerCase(), target, reason, checkedEvidenceIds: body.evidence_ids });
  }

  private async record(
    scope: CommandScope,
    access: EffectiveAccess,
    permission: string,
    input: { findingId: string; target: BidReviewTarget; reason: string; checkedEvidenceIds: readonly string[] },
  ): Promise<Reviewed> {
    const now = new Date();
    const reviewed = await this.store.review(
      scope.tx,
      { ...input, expectedVersion: scope.expectedVersion ?? 0 },
      viewerOf(scope.tenant, access, permission, now),
      scope.tenant.membershipId,
    );
    const { finding, review } = reviewed;
    await this.decisions.markApplied(scope.tx, reviewed.decisionRecordId, scope.requestId, finding.version);
    // The audit row and the event say who decided what about which finding and why; the text of the finding and the pages it rests on stay in the analysis.
    const facts = {
      finding_id: finding.id,
      run_id: reviewed.runId,
      proposal_id: reviewed.proposalId,
      package_code: reviewed.packageCode,
      criterion_id: finding.criterionId,
      from_status: review.fromStatus,
      to_status: review.toStatus,
      score_before: review.scoreBefore,
      score_after: review.scoreAfter,
      decision: review.decision,
      ai_decision_record_id: reviewed.decisionRecordId,
      run_status: reviewed.runStatus,
    };
    await scope.audit({ action: 'bid.finding_reviewed', resourceType: FINDING_TYPE, resourceId: finding.id, reason: review.reason, diff: facts, classification: 'CONFIDENTIAL' });
    await scope.emit({
      aggregateType: FINDING_TYPE,
      aggregateId: finding.id,
      aggregateVersion: finding.version,
      type: 'bid.finding.reviewed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, review_id: review.id, ...facts, criteria_version_id: reviewed.criteriaVersionId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${FINDING_TYPE}:${finding.id}:${finding.version}`,
    });
    return {
      ...commandResult(scope, review.toStatus, finding.version, finding.id),
      review_id: review.id,
      decision: review.decision,
      final_status: review.toStatus,
      final_score: review.scoreAfter,
      ai_decision_record_id: reviewed.decisionRecordId,
      run_status: reviewed.runStatus,
    };
  }

  /**
   * The proposals of a package side by side on one version of the criteria (UAT-AC17): the analyses that ran on other criteria are left out and named, the personal attributes and the region the comparison never looks
   * at are listed, and a cell holds only what an expert decided. Opening it is recorded.
   */
  @Get('procurement-packages/:id/proposal-comparison')
  @OperationId('compareProposals')
  async compare(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('criteria_version_id') criteriaVersionId?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const version = criteriaVersionId === undefined ? undefined : idOf(criteriaVersionId, 'criteria_version_id');
    const viewer = viewerOf(tenant, access, PERMISSIONS.compareProposals, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.compare(tx, id.toLowerCase(), version, viewer);
      if (found === undefined) return undefined;
      await this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'bid.comparison_opened',
        resourceType: PACKAGE_TYPE,
        resourceId: found.package.id,
        diff: {
          package_code: found.package.code,
          criteria_version_id: found.comparison.criteriaVersionId,
          compared: found.comparison.proposals.length,
          excluded: found.comparison.excluded.length,
        },
        classification: 'CONFIDENTIAL',
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
      return found;
    });
    if (read === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return comparisonDto(read, now.toISOString());
  }
}

