import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvMaturityStore, MATURITY_ASSESSMENT_RESOURCE, MATURITY_EVIDENCE_RESOURCE, MATURITY_MILESTONE_RESOURCE, MATURITY_RUBRIC_RESOURCE, TenantDatabase } from '@machvon/db';
import type { AssessmentScore, MaturityAssessment, MaturityEvidence, MaturityMilestone, MaturityPerson, MaturityRubric } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { assertTenantAuthority, pageSize, textOf, uuidOf } from './inputs';

const RUBRIC_DRAFTED_EVENT = 'dgv.rubric.drafted.v1';
const RUBRIC_PUBLISHED_EVENT = 'dgv.rubric.published.v1';
const ASSESSMENT_CREATED_EVENT = 'dgv.assessment.created.v1';
const EVIDENCE_RECORDED_EVENT = 'dgv.evidence.recorded.v1';
const EVIDENCE_REVIEWED_EVENT = 'dgv.evidence.reviewed.v1';
const ASSESSMENT_PUBLISHED_EVENT = 'dgv.assessment.published.v1';
const MILESTONE_CREATED_EVENT = 'dgv.milestone.created.v1';
const MAX_REASON = 2000;

/** The auditors read the evidence of every assessment, through a grant on the whole tenant. */
const AUDIT_PERMISSION = 'audit.read';
const mayReadContent = (tenant: TenantContext, access: EffectiveAccess, evidence: MaturityEvidence): boolean =>
  evidence.assessorId === tenant.membershipId || evidence.reviewerId === tenant.membershipId || holdsOnWholeTenant(access, AUDIT_PERMISSION);

const personView = (who: MaturityPerson | null): Record<string, unknown> | null => (who === null ? null : { membership_id: who.membershipId, display_name: who.displayName });
/** Weights are kept in hundredths; the contract shows them as the decimal they were written as. */
const weightView = (hundredths: number): string => `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;

export function rubricView(rubric: MaturityRubric): Record<string, unknown> {
  return {
    id: rubric.id,
    rubric_code: rubric.rubricCode,
    revision: rubric.revision,
    framework_refs: rubric.frameworkRefs,
    pillars: rubric.rubric.pillars.map((pillar) => ({
      code: pillar.code,
      name: pillar.name,
      weight: weightView(pillar.weight),
      criteria: pillar.criteria.map((criterion) => ({ code: criterion.code, name: criterion.name, weight: weightView(criterion.weight), levels: criterion.levels, refs: criterion.refs })),
    })),
    min_coverage_pct: rubric.minCoveragePct,
    evidence_ttl_days: rubric.evidenceTtlDays,
    status: rubric.status,
    approved_by: personView(rubric.approvedBy),
    created_by: personView(rubric.createdBy),
    created_at: rubric.createdAt,
    version: rubric.version,
  };
}

export function assessmentView(assessment: MaturityAssessment): Record<string, unknown> {
  return {
    id: assessment.id,
    period_code: assessment.periodCode,
    rubric_version_id: assessment.rubricVersionId,
    rubric_code: assessment.rubricCode,
    rubric_revision: assessment.rubricRevision,
    scope_kind: assessment.scopeKind,
    scope_ref: assessment.scopeRef,
    assessor: personView(assessment.assessor),
    reviewer: personView(assessment.reviewer),
    status: assessment.status,
    coverage_percent: assessment.coveragePercent,
    overall_state: assessment.overallState,
    overall_level: assessment.overallLevel,
    published_by: personView(assessment.publishedBy),
    published_at: assessment.publishedAt,
    created_at: assessment.createdAt,
    version: assessment.version,
  };
}

/**
 * A row of evidence as the contract exposes it. What the evidence says (its references, the reason it does not apply, the note of the review) is for the assessor and the reviewer of the assessment and for the auditors
 * only; to anybody else who may read the rows the criterion, its state and its level are shown, and how many pieces of evidence there are.
 */
export function evidenceView(evidence: MaturityEvidence, content: boolean): Record<string, unknown> {
  return {
    id: evidence.id,
    assessment_id: evidence.assessmentId,
    pillar_code: evidence.pillarCode,
    criterion_code: evidence.criterionCode,
    assessment_state: evidence.state,
    level: evidence.level,
    evidence_refs: content ? evidence.evidenceRefs : [],
    evidence_count: evidence.evidenceCount,
    evidence_redacted: !content,
    review_status: evidence.reviewStatus,
    assessed_by: personView(evidence.assessedBy),
    assessed_on: evidence.assessedOn,
    sample_size: evidence.sampleSize,
    confidence: evidence.confidence,
    reviewer: personView(evidence.reviewer),
    reviewed_at: evidence.reviewedAt,
    review_note: content ? evidence.reviewNote : null,
    evidence_expires_on: evidence.evidenceExpiresOn,
    na_reason: content ? evidence.naReason : null,
    created_at: evidence.createdAt,
    version: evidence.version,
  };
}

export function milestoneView(milestone: MaturityMilestone): Record<string, unknown> {
  return {
    id: milestone.id,
    rubric_version_id: milestone.rubricVersionId,
    rubric_code: milestone.rubricCode,
    pillar_code: milestone.pillarCode,
    target_level: milestone.targetLevel,
    due_on: milestone.dueOn,
    owner: personView(milestone.owner),
    exit_criteria: milestone.exitCriteria,
    evidence_required: milestone.evidenceRequired,
    status: milestone.status,
    achieved_assessment_id: milestone.achievedAssessmentId,
    created_at: milestone.createdAt,
    version: milestone.version,
  };
}

/** The score of BR-DGV-08 with what it stands on: the coverage and the share asked for, the weights, and for each criterion what it counts as and the evidence behind it. A total that is not computed has no level. */
export function scoreView(scored: AssessmentScore): Record<string, unknown> {
  const { score, assessment, rubric } = scored;
  return {
    assessment_id: assessment.id,
    status: assessment.status,
    rubric: { id: rubric.id, rubric_code: rubric.rubricCode, revision: rubric.revision },
    as_of: scored.asOf,
    coverage_percent: score.coveragePercent,
    min_coverage_pct: rubric.minCoveragePct,
    overall_state: score.overallState,
    ...(score.overallLevel === null ? {} : { overall_level: score.overallLevel }),
    assessed_count: score.assessedCount,
    not_assessed_count: score.notAssessedCount,
    not_applicable_count: score.notApplicableCount,
    pillars: score.pillars.map((pillar) => ({
      pillar_code: pillar.code,
      weight: weightView(pillar.weight),
      state: pillar.state,
      level: pillar.level,
      assessed_count: pillar.assessedCount,
      not_assessed_count: pillar.notAssessedCount,
      not_applicable_count: pillar.notApplicableCount,
    })),
    criteria: scored.criteria.map((criterion) => ({
      pillar_code: criterion.pillarCode,
      criterion_code: criterion.criterionCode,
      weight: weightView(criterion.weight),
      state: criterion.state,
      level: criterion.level,
      review_status: criterion.reviewStatus,
      evidence_expires_on: criterion.evidenceExpiresOn,
      evidence_count: criterion.evidenceCount,
      evidence_id: criterion.evidenceId,
    })),
  };
}

/**
 * The maturity of data governance (ST-DGV-008, DGV 3.1 F8, DGV-16, DGV-17, DGV-21, UAT-AC53, UAT-AC492 to UAT-AC494). A rubric of eight pillars is drafted and published by two people; an assessment applies a published
 * version with an assessor and a reviewer who are two people; the assessor records a level for a criterion with evidence that has a last day, the reviewer accepts it, and what is not accepted and in date is
 * NOT_ASSESSED, never a level; somebody other than the assessor publishes the assessment with the score, and the milestones of the roadmap that its pillars reach are achieved. Nothing here belongs to an organisation unit: each command needs its
 * permission on the whole tenant.
 */
@Controller()
export class DgvMaturityCommandsController {
  private readonly maturity = new DgvMaturityStore();

  @Post('dgv/maturity-rubrics')
  @HttpCode(200)
  @OperationId('createMaturityRubricVersion')
  @Command({ operation: 'createMaturityRubricVersion' })
  async createRubric(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvRubricDraft']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.createMaturityRubricVersion);
    const created = await this.maturity.createRubric(
      scope.tx,
      { rubricCode: body.rubric_code, frameworkRefs: body.framework_refs, pillarsJson: body.pillars_json, minCoveragePct: body.min_coverage_pct, evidenceTtlDays: body.evidence_ttl_days },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'dgv.maturity_rubric_drafted',
      resourceType: MATURITY_RUBRIC_RESOURCE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { rubric_code: created.rubricCode, revision: created.revision, min_coverage_pct: created.minCoveragePct, evidence_ttl_days: created.evidenceTtlDays },
    });
    await scope.emit({
      aggregateType: MATURITY_RUBRIC_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: RUBRIC_DRAFTED_EVENT,
      schemaVersion: 1,
      payload: { rubric_id: created.id, rubric_code: created.rubricCode, revision: created.revision },
      eventKey: `${MATURITY_RUBRIC_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('dgv/maturity-rubrics/:id/publish')
  @HttpCode(200)
  @OperationId('publishMaturityRubric')
  @Command({ operation: 'publishMaturityRubric', versioned: true })
  async publishRubric(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.publishMaturityRubric);
    const done = await this.maturity.publishRubric(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'dgv.maturity_rubric_published',
      resourceType: MATURITY_RUBRIC_RESOURCE,
      resourceId: done.rubric.id,
      classification: 'INTERNAL',
      diff: { rubric_code: done.rubric.rubricCode, revision: done.rubric.revision, superseded_id: done.supersededId },
    });
    await scope.emit({
      aggregateType: MATURITY_RUBRIC_RESOURCE,
      aggregateId: done.rubric.id,
      aggregateVersion: done.rubric.version,
      type: RUBRIC_PUBLISHED_EVENT,
      schemaVersion: 1,
      payload: { rubric_id: done.rubric.id, rubric_code: done.rubric.rubricCode, revision: done.rubric.revision, superseded_id: done.supersededId },
      eventKey: `${MATURITY_RUBRIC_RESOURCE}:${done.rubric.id}:${done.rubric.version}`,
    });
    return { ...commandResult(scope, done.rubric.status, done.rubric.version, done.rubric.id) };
  }

  @Post('dgv/maturity-assessments')
  @HttpCode(200)
  @OperationId('createMaturityAssessment')
  @Command({ operation: 'createMaturityAssessment' })
  async createAssessment(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvAssessmentCreate']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.createMaturityAssessment);
    const created = await this.maturity.createAssessment(scope.tx, {
      periodCode: body.period_code,
      rubricVersionId: uuidOf(body.rubric_version_id, 'rubric_version_id'),
      scopeKind: body.scope_kind,
      scopeRef: body.scope_ref,
      assessorId: uuidOf(body.assessor_user_id, 'assessor_user_id'),
      reviewerId: uuidOf(body.reviewer_id, 'reviewer_id'),
    });
    await scope.audit({
      action: 'dgv.maturity_assessment_created',
      resourceType: MATURITY_ASSESSMENT_RESOURCE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: {
        period_code: created.periodCode,
        rubric_version_id: created.rubricVersionId,
        scope_kind: created.scopeKind,
        scope_ref: created.scopeRef,
        assessor_user_id: created.assessor.membershipId,
        reviewer_id: created.reviewer.membershipId,
      },
    });
    await scope.emit({
      aggregateType: MATURITY_ASSESSMENT_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: ASSESSMENT_CREATED_EVENT,
      schemaVersion: 1,
      payload: { assessment_id: created.id, rubric_version_id: created.rubricVersionId, period_code: created.periodCode, scope_kind: created.scopeKind, scope_ref: created.scopeRef },
      eventKey: `${MATURITY_ASSESSMENT_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  /** The assessor records a criterion; `If-Match` is the version of the row of the criterion that they read. */
  @Post('dgv/maturity-assessments/:id/evidence')
  @HttpCode(200)
  @OperationId('recordMaturityEvidence')
  @Command({ operation: 'recordMaturityEvidence', versioned: true })
  async recordEvidence(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DgvEvidenceRecord'],
  ): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.recordMaturityEvidence);
    const recorded = await this.maturity.recordEvidence(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        pillarCode: body.pillar_code,
        criterionCode: body.criterion_code,
        state: body.assessment_state,
        level: body.level,
        evidenceRefs: body.evidence_refs,
        sampleSize: body.sample_size,
        confidence: body.confidence,
        naReason: body.na_reason,
        expiresOn: body.evidence_expires_on,
      },
      scope.tenant.membershipId,
    );
    const { evidence } = recorded;
    await scope.audit({
      action: 'dgv.maturity_evidence_recorded',
      resourceType: MATURITY_EVIDENCE_RESOURCE,
      resourceId: evidence.id,
      classification: 'INTERNAL',
      diff: {
        assessment_id: evidence.assessmentId,
        pillar_code: evidence.pillarCode,
        criterion_code: evidence.criterionCode,
        from: recorded.previous,
        to: evidence.state,
        level: evidence.level,
        evidence_count: evidence.evidenceRefs.length,
        evidence_expires_on: evidence.evidenceExpiresOn,
      },
    });
    await scope.emit({
      aggregateType: MATURITY_EVIDENCE_RESOURCE,
      aggregateId: evidence.id,
      aggregateVersion: evidence.version,
      type: EVIDENCE_RECORDED_EVENT,
      schemaVersion: 1,
      payload: {
        assessment_id: evidence.assessmentId,
        evidence_id: evidence.id,
        pillar_code: evidence.pillarCode,
        criterion_code: evidence.criterionCode,
        assessment_state: evidence.state,
        level: evidence.level,
      },
      eventKey: `${MATURITY_EVIDENCE_RESOURCE}:${evidence.id}:${evidence.version}`,
    });
    return {
      ...commandResult(scope, evidence.state, evidence.version, evidence.id),
      assessment_id: evidence.assessmentId,
      assessment_status: recorded.assessment.status,
      assessment_version: recorded.assessment.version,
    };
  }

  @Post('dgv/maturity-evidence/:id/review')
  @HttpCode(200)
  @OperationId('reviewMaturityEvidence')
  @Command({ operation: 'reviewMaturityEvidence', versioned: true })
  async reviewEvidence(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DgvEvidenceReview'],
  ): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.reviewMaturityEvidence);
    const reviewed = await this.maturity.reviewEvidence(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { decision: body.decision, note: body.note }, scope.tenant.membershipId);
    const { evidence } = reviewed;
    await scope.audit({
      action: 'dgv.maturity_evidence_reviewed',
      resourceType: MATURITY_EVIDENCE_RESOURCE,
      resourceId: evidence.id,
      classification: 'INTERNAL',
      reason: body.note.trim(),
      diff: { assessment_id: evidence.assessmentId, pillar_code: evidence.pillarCode, criterion_code: evidence.criterionCode, decision: body.decision, to: evidence.state },
    });
    await scope.emit({
      aggregateType: MATURITY_EVIDENCE_RESOURCE,
      aggregateId: evidence.id,
      aggregateVersion: evidence.version,
      type: EVIDENCE_REVIEWED_EVENT,
      schemaVersion: 1,
      payload: {
        assessment_id: evidence.assessmentId,
        evidence_id: evidence.id,
        pillar_code: evidence.pillarCode,
        criterion_code: evidence.criterionCode,
        decision: body.decision,
        assessment_state: evidence.state,
      },
      eventKey: `${MATURITY_EVIDENCE_RESOURCE}:${evidence.id}:${evidence.version}`,
    });
    return { ...commandResult(scope, evidence.reviewStatus, evidence.version, evidence.id), assessment_id: evidence.assessmentId };
  }

  /** The baseline decision on an assessment in review: `approve` publishes it with its score, `return` sends it back to the assessor, `reject` closes it. Not the assessor. */
  @Post('maturity-assessments/:id/publish')
  @HttpCode(200)
  @OperationId('post_maturity_assessments_id_publish')
  @Command({ operation: 'post_maturity_assessments_id_publish', versioned: true })
  async decideAssessment(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['Decision'],
  ): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.post_maturity_assessments_id_publish);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '' || reason.length > MAX_REASON || reason.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    if (body.decision !== 'approve' && body.decision !== 'return' && body.decision !== 'reject') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const evidenceIds = body.evidence_ids.map((evidenceId) => uuidOf(evidenceId, 'evidence_ids'));
    const done = await this.maturity.decideAssessment(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    const { assessment } = done;
    await scope.audit({
      action: body.decision === 'approve' ? 'dgv.maturity_assessment_published' : body.decision === 'return' ? 'dgv.maturity_assessment_returned' : 'dgv.maturity_assessment_rejected',
      resourceType: MATURITY_ASSESSMENT_RESOURCE,
      resourceId: assessment.id,
      classification: 'INTERNAL',
      reason,
      diff: {
        period_code: assessment.periodCode,
        from: done.previous,
        to: assessment.status,
        coverage_percent: assessment.coveragePercent,
        overall_state: assessment.overallState,
        overall_level: assessment.overallLevel,
        evidence_ids: evidenceIds,
        achieved_milestone_ids: done.achieved.map((milestone) => milestone.id),
      },
    });
    if (body.decision === 'approve') {
      await scope.emit({
        aggregateType: MATURITY_ASSESSMENT_RESOURCE,
        aggregateId: assessment.id,
        aggregateVersion: assessment.version,
        type: ASSESSMENT_PUBLISHED_EVENT,
        schemaVersion: 1,
        payload: {
          assessment_id: assessment.id,
          rubric_version_id: assessment.rubricVersionId,
          period_code: assessment.periodCode,
          scope_kind: assessment.scopeKind,
          coverage_percent: assessment.coveragePercent,
          overall_state: assessment.overallState,
          overall_level: assessment.overallLevel,
          achieved_milestone_ids: done.achieved.map((milestone) => milestone.id),
        },
        eventKey: `${MATURITY_ASSESSMENT_RESOURCE}:${assessment.id}:${assessment.version}`,
      });
    }
    return {
      ...commandResult(scope, assessment.status, assessment.version, assessment.id),
      coverage_percent: assessment.coveragePercent,
      overall_state: assessment.overallState,
      ...(assessment.overallLevel === null ? {} : { overall_level: assessment.overallLevel }),
      achieved_milestone_ids: done.achieved.map((milestone) => milestone.id),
    };
  }

  @Post('dgv/maturity-milestones')
  @HttpCode(200)
  @OperationId('createMaturityMilestone')
  @Command({ operation: 'createMaturityMilestone' })
  async createMilestone(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvMilestone']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.createMaturityMilestone);
    const created = await this.maturity.createMilestone(
      scope.tx,
      {
        rubricVersionId: uuidOf(body.rubric_version_id, 'rubric_version_id'),
        pillarCode: body.pillar_code,
        targetLevel: body.target_level,
        dueOn: body.due_on,
        ownerId: uuidOf(body.owner_user_id, 'owner_user_id'),
        exitCriteria: body.exit_criteria,
        evidenceRequired: body.evidence_required,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'dgv.maturity_milestone_created',
      resourceType: MATURITY_MILESTONE_RESOURCE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { rubric_version_id: created.rubricVersionId, pillar_code: created.pillarCode, target_level: created.targetLevel, due_on: created.dueOn, owner_user_id: created.owner.membershipId },
    });
    await scope.emit({
      aggregateType: MATURITY_MILESTONE_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: MILESTONE_CREATED_EVENT,
      schemaVersion: 1,
      payload: { milestone_id: created.id, rubric_version_id: created.rubricVersionId, pillar_code: created.pillarCode, target_level: created.targetLevel, due_on: created.dueOn },
      eventKey: `${MATURITY_MILESTONE_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }
}

/** What is read of the maturity: the rubrics, the assessments with their evidence and their score, the roadmap. Each read needs its permission on the whole tenant. */
@Controller()
export class DgvMaturityReadsController {
  private readonly maturity = new DgvMaturityStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('dgv/maturity-rubrics')
  @OperationId('listMaturityRubrics')
  async rubrics(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('rubric_code') rubricCode?: unknown,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertTenantAuthority(access, PERMISSIONS.listMaturityRubrics);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.maturity.listRubrics(tx, { rubricCode: textOf(rubricCode, 'rubric_code'), status: textOf(status, 'status'), cursor: textOf(cursor, 'cursor'), limit: pageSize(limit) }),
    );
    return { items: page.items.map(rubricView), next_cursor: page.next };
  }

  @Get('dgv/maturity-milestones')
  @OperationId('listMaturityMilestones')
  async milestones(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('rubric_version_id') rubricVersionId?: unknown,
    @Query('pillar_code') pillarCode?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertTenantAuthority(access, PERMISSIONS.listMaturityMilestones);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.maturity.listMilestones(tx, {
        status: textOf(status, 'status'),
        rubricVersionId: rubricVersionId === undefined ? undefined : uuidOf(rubricVersionId, 'rubric_version_id'),
        pillarCode: textOf(pillarCode, 'pillar_code'),
        cursor: textOf(cursor, 'cursor'),
        limit: pageSize(limit),
      }),
    );
    return { items: page.items.map(milestoneView), next_cursor: page.next };
  }

  @Get('dgv/maturity-assessments/:id/score')
  @OperationId('getMaturityScore')
  async score(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.getMaturityScore);
    const scored = await this.database.withTenant(tenant, (tx) => this.maturity.score(tx, id.toLowerCase()));
    if (scored === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return scoreView(scored);
  }

  @Get('resources/maturity_assessment')
  @OperationId('get_resources_maturity_assessment')
  async assessments(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('rubric_version_id') rubricVersionId?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertTenantAuthority(access, PERMISSIONS.get_resources_maturity_assessment);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.maturity.listAssessments(tx, {
        status: textOf(status, 'status'),
        rubricVersionId: rubricVersionId === undefined ? undefined : uuidOf(rubricVersionId, 'rubric_version_id'),
        cursor: textOf(cursor, 'cursor'),
        limit: pageSize(limit),
      }),
    );
    return { items: page.items.map(assessmentView), next_cursor: page.next };
  }

  @Get('resources/maturity_assessment/:id')
  @OperationId('get_resources_maturity_assessment_id')
  async assessment(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.get_resources_maturity_assessment_id);
    const found = await this.database.withTenant(tenant, (tx) => this.maturity.findAssessment(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return assessmentView(found);
  }

  @Get('resources/maturity_evidence')
  @OperationId('get_resources_maturity_evidence')
  async evidences(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('assessment_id') assessmentId?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertTenantAuthority(access, PERMISSIONS.get_resources_maturity_evidence);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.maturity.listEvidence(tx, { assessmentId: assessmentId === undefined ? undefined : uuidOf(assessmentId, 'assessment_id'), cursor: textOf(cursor, 'cursor'), limit: pageSize(limit) }),
    );
    return { items: page.items.map((item) => evidenceView(item, mayReadContent(tenant, access, item))), next_cursor: page.next };
  }

  @Get('resources/maturity_evidence/:id')
  @OperationId('get_resources_maturity_evidence_id')
  async evidenceOne(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.get_resources_maturity_evidence_id);
    const found = await this.database.withTenant(tenant, (tx) => this.maturity.findEvidence(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return evidenceView(found, mayReadContent(tenant, access, found));
  }
}
