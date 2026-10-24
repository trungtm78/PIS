import { Body, Controller, Headers, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PRJ_STAGE_TRANSITION_METRIC, PrjAppraisalStore, projectScope, stageChangeRecord } from '@machvon/db';
import type { StageChange } from '@machvon/db';
import { NOOP_METRICS, parseIfMatch, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { reaches } from './reach';
import { stageInputOf } from './stage-view';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const APPRAISAL_RESOURCE = 'project_appraisal';

/**
 * The appraisal of a project (ST-PRJ-003, PRJ 3.1 F2): the proposal that sends a project to appraisal, the sheets of the appraisers and the
 * decision that admits the project to the project bank, rejects it or returns it. The two moves of the project are guarded commands of the
 * transition table; a sheet is scored by the server, in the scope of `project.appraise`, by someone who did not propose the project.
 */
@Controller()
export class ProjectAppraisalController {
  private readonly appraisals = new PrjAppraisalStore();
  private readonly metrics: MetricsSink;
  private readonly cache: PipelineCache;

  constructor(@Optional() @Inject(PRJ_METRICS) metrics?: MetricsSink, @Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Post('projects/:id/appraisal-submissions')
  @HttpCode(200)
  @OperationId('submitProjectForAppraisal')
  @Command({ operation: 'submitProjectForAppraisal', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.appraisals.submit(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PERMISSIONS.submitProjectForAppraisal, now), read: projectScope(access, READ_PERMISSION, now) },
      input: stageInputOf(body),
    });
    await this.recordMove(scope, change, now);
    return commandResult(scope, change.to, change.version, change.projectId);
  }

  @Post('projects/:id/appraisals')
  @HttpCode(200)
  @OperationId('recordProjectAppraisal')
  @Command({ operation: 'recordProjectAppraisal' })
  async record(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PrjAppraisalScore'],
    // The sheet an appraiser scores again is under the version they saw; the first sheet has none, so the header is optional (the contract says so).
    @Headers('if-match') ifMatch?: string,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const sheet = await this.appraisals.record(scope.tx, {
      projectId: id.toLowerCase(),
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PERMISSIONS.recordProjectAppraisal, now), read: projectScope(access, READ_PERMISSION, now) },
      criteriaSetVersionId: body.criteria_set_version_id,
      scores: body.scores.map((entry) => ({ criterionCode: entry.criterion_code, score: entry.score, evidenceIds: entry.evidence_ids })),
      recommendation: body.recommendation,
      note: body.note,
      expectedSheetVersion: ifMatch === undefined ? undefined : parseIfMatch(ifMatch),
      today: vietnamDateOf(now),
    });
    await scope.audit({
      action: 'project.appraisal_recorded',
      resourceType: APPRAISAL_RESOURCE,
      resourceId: sheet.id,
      classification: sheet.classification,
      diff: {
        project_id: sheet.projectId,
        round: sheet.round,
        criteria_set_version_id: sheet.criteriaSetVersionId,
        total_score: sheet.totalScore,
        previous_total_score: sheet.previousTotalScore,
        recommendation: sheet.recommendation,
        replaced: sheet.replaced,
        score_count: sheet.scoreCount,
        evidence_count: sheet.evidenceCount,
        has_note: sheet.hasNote,
        mean_score: sheet.meanScore,
        sheet_count: sheet.sheetCount,
      },
    });
    await scope.emit({
      aggregateType: APPRAISAL_RESOURCE,
      aggregateId: sheet.id,
      aggregateVersion: sheet.version,
      type: 'project.appraisal_recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: sheet.projectId,
        version: sheet.projectVersion,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        appraisal_id: sheet.id,
        appraisal_version: sheet.version,
        round: sheet.round,
        total_score: sheet.totalScore,
        recommendation: sheet.recommendation,
        mean_score: sheet.meanScore,
        sheet_count: sheet.sheetCount,
      },
      eventKey: `${APPRAISAL_RESOURCE}:${sheet.id}:${sheet.version}`,
    });
    return {
      ...commandResult(scope, 'SUBMITTED', sheet.version, sheet.id),
      project_id: sheet.projectId,
      round: sheet.round,
      // Blind scoring: nothing computed over the other sheets (the mean, their count, what the threshold says of it) goes back to an appraiser, or the
      // second of two would read the first one's total off it. The decision maker reads those figures from the lifecycle read.
      total_score: sheet.totalScore,
    };
  }

  @Post('project-appraisals/:id/decision')
  @HttpCode(200)
  @OperationId('decideProjectAppraisal')
  @Command({ operation: 'decideProjectAppraisal', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PrjAppraisalDecision'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const decided = await this.appraisals.decide(scope.tx, {
      appraisalId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PERMISSIONS.decideProjectAppraisal, now), read: projectScope(access, READ_PERMISSION, now) },
      decision: body.decision,
      reason: body.reason,
      decisionDocumentId: body.decision_document_id,
      projectGroup: body.project_group,
      overrideReason: body.override_reason,
      authorizes: (unit) => reaches(access, PERMISSIONS.decideProjectAppraisal, unit, now),
      today: vietnamDateOf(now),
    });
    await this.recordMove(scope, decided.change, now);
    await scope.audit({
      action: 'project.appraisal_decided',
      resourceType: APPRAISAL_RESOURCE,
      resourceId: decided.appraisalId,
      classification: decided.change.classification,
      reason: decided.change.reason ?? undefined,
      diff: {
        project_id: decided.change.projectId,
        round: decided.round,
        decision: decided.decision,
        mean_score: decided.meanScore,
        sheet_count: decided.sheetCount,
        pass_threshold: decided.passThreshold,
        against_recommendation: decided.againstRecommendation,
        override_reason: decided.overrideReason,
        project_group: decided.projectGroup,
        decision_document_id: decided.decisionDocumentId,
      },
    });
    return {
      ...commandResult(scope, 'DECIDED', decided.appraisalVersion, decided.appraisalId),
      project_id: decided.change.projectId,
      project_status: decided.change.to,
      project_version: decided.change.version,
      mean_score: decided.meanScore,
    };
  }

  /** The audit row and the event of a move of the project (the same as for every other stage command), the metric and the cache once it is committed. */
  private async recordMove(scope: CommandScope, change: StageChange, now: Date): Promise<void> {
    const record = stageChangeRecord(change, scope.tenant.tenantId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    scope.afterCommit(async () => {
      this.metrics.increment(PRJ_STAGE_TRANSITION_METRIC, { to: change.to });
      await this.cache.invalidate(scope.tenant.tenantId);
    });
  }
}
