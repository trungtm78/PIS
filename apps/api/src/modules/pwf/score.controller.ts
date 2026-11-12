import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfScoreAdjustmentStore, PwfScoreReads, PwfScoreStore, scoreUnitsOf } from '@machvon/db';
import type { StaffScorePeriodResult } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { PWF_RESOURCE_SCORE_ADJUSTMENT, PWF_RESOURCE_SCORE_PERIOD, PWF_RESOURCE_SCORE_RESPONSE, periodDto } from './score-support';
import { ScoreResponseFlow } from './score-response.flow';

const CLASSIFICATION = 'PERSONAL' as const;

/** What a command of the scores leaves: the audit row with the facts of the command (a person's figures are personal data, so the row is classified as such) and the event with ids, codes, days and statuses only. */
async function announce(
  scope: CommandScope,
  entry: { resource: string; id: string; version: number; action: string; type: string | null; fromStatus: string | null; status: string; audit: Record<string, unknown>; event: Record<string, unknown>; reason?: string },
  now: Date,
): Promise<void> {
  await scope.audit({
    action: entry.action,
    resourceType: entry.resource,
    resourceId: entry.id,
    classification: CLASSIFICATION,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    diff: { from_status: entry.fromStatus, to_status: entry.status, ...entry.audit },
  });
  if (entry.type === null) return;
  await scope.emit({
    aggregateType: entry.resource,
    aggregateId: entry.id,
    aggregateVersion: entry.version,
    type: entry.type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, id: entry.id, ...entry.event, status: entry.status, from_status: entry.fromStatus, version: entry.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${entry.resource}:${entry.id}:${entry.version}:${entry.type}`,
  });
}

/**
 * The commands on the scores of staff (PWF-3, docs PWF 7): compute and lock a period, officialize it, ask for and decide an adjustment, answer a score and handle the answer. Each is judged by the permission of its own
 * operation over the units its grants reach, takes the lock of the period, runs idempotently and is audited (ADM-11) with the facts of the command; the events carry ids, codes and days only (BR-PWF-40). Nothing here
 * applies a consequence to a person: a score supports a decision of somebody with authority (BR-PWF-41).
 */
@Controller()
export class StaffScoreController {
  private readonly periods = new PwfScoreStore();
  private readonly adjustments = new PwfScoreAdjustmentStore();
  private readonly reads = new PwfScoreReads();
  private readonly flow: ScoreResponseFlow;

  constructor(@Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry) {
    this.flow = new ScoreResponseFlow(commands);
  }

  private periodDone(scope: CommandScope, result: StaffScorePeriodResult, action: string, type: string, now: Date): Promise<void> {
    return announce(scope, { resource: PWF_RESOURCE_SCORE_PERIOD, id: result.id, version: result.version, action, type, fromStatus: result.fromStatus, status: result.status, audit: { scope_unit_id: result.scopeUnitId, ...result.facts }, event: { scope_unit_id: result.scopeUnitId, ...result.facts } }, now);
  }

  @Post('staff-score-periods')
  @HttpCode(200)
  @OperationId('computeStaffScorePeriod')
  @Command({ operation: 'computeStaffScorePeriod' })
  async compute(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['StaffScorePeriodRequest']): Promise<Schemas['StaffScorePeriodPreview']> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.computeStaffScorePeriod], now);
    const preview = await this.periods.compute(scope.tx, { scopeUnitId: body.scope_unit_id, periodFrom: body.period_from, periodTo: body.period_to, policyCode: body.policy_code, actor: scope.tenant.membershipId, units, now });
    const period = await this.reads.period(scope.tx, { units: '*', subject: '' }, preview.period.id);
    await announce(
      scope,
      {
        resource: PWF_RESOURCE_SCORE_PERIOD,
        id: preview.period.id,
        version: preview.period.version,
        action: 'score.period_computed',
        type: null,
        fromStatus: preview.created ? null : 'DRAFT',
        status: 'DRAFT',
        audit: { scope_unit_id: preview.period.scopeUnitId, period_from: preview.period.periodFrom, period_to: preview.period.periodTo, policy_code: preview.period.policyCode, policy_version: preview.period.policyVersion, preview_hash: preview.previewHash, rated: preview.ratedCount, small_sample: preview.smallSampleCount, not_rated: preview.notRatedCount },
        event: {},
      },
      now,
    );
    return {
      period: periodDto(period, now),
      rated_count: preview.ratedCount,
      small_sample_count: preview.smallSampleCount,
      not_rated_count: preview.notRatedCount,
      signal_count: preview.signalCount,
      excluded_task_count: preview.excludedTaskCount,
      preview_hash: preview.previewHash,
      as_of: now.toISOString(),
    } as unknown as Schemas['StaffScorePeriodPreview'];
  }

  @Post('staff-score-periods/:id/lock')
  @HttpCode(200)
  @OperationId('lockStaffScorePeriod')
  @Command({ operation: 'lockStaffScorePeriod', versioned: true })
  async lock(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.lockStaffScorePeriod], now);
    const result = await this.periods.lock(scope.tx, { periodId: id, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, units, now });
    await this.periodDone(scope, result, 'score.period_locked', 'pwf.score.period.locked.v1', now);
    return commandResult(scope, result.status, result.version, result.id);
  }

  @Post('staff-score-periods/:id/officialize')
  @HttpCode(200)
  @OperationId('officializeStaffScorePeriod')
  @Command({ operation: 'officializeStaffScorePeriod', versioned: true })
  async officialize(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.officializeStaffScorePeriod], now);
    const result = await this.periods.officialize(scope.tx, { periodId: id, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, units, now });
    await this.periodDone(scope, result, 'score.period_officialized', 'pwf.score.period.officialized.v1', now);
    return commandResult(scope, result.status, result.version, result.id);
  }

  @Post('staff-score-lines/:id/adjustments')
  @HttpCode(200)
  @OperationId('requestStaffScoreAdjustment')
  @Command({ operation: 'requestStaffScoreAdjustment' })
  async requestAdjustment(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['StaffScoreAdjustmentRequest']): Promise<CommandResult> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.requestStaffScoreAdjustment], now);
    const result = await this.adjustments.request(scope.tx, { lineId: id, points: body.points, reason: body.reason, evidenceRef: body.evidence_ref, actor: scope.tenant.membershipId, units });
    await announce(scope, { resource: PWF_RESOURCE_SCORE_ADJUSTMENT, id: result.id, version: result.version, action: 'score.adjustment_requested', type: null, fromStatus: null, status: result.status, audit: { line_id: result.lineId, period_id: result.periodId, ...result.facts }, event: {}, reason: body.reason }, now);
    return commandResult(scope, result.status, result.version, result.id);
  }

  @Post('staff-score-adjustments/:id/decide')
  @HttpCode(200)
  @OperationId('decideStaffScoreAdjustment')
  @Command({ operation: 'decideStaffScoreAdjustment', versioned: true })
  async decideAdjustment(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PwfDecisionInput']): Promise<CommandResult> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.decideStaffScoreAdjustment], now);
    const result = await this.adjustments.decide(scope.tx, { adjustmentId: id, expectedVersion: scope.expectedVersion ?? 0, decision: body.decision, note: body.note, actor: scope.tenant.membershipId, units });
    await announce(
      scope,
      {
        resource: PWF_RESOURCE_SCORE_ADJUSTMENT,
        id: result.id,
        version: result.version,
        action: 'score.adjustment_decided',
        type: 'pwf.score.adjustment.decided.v1',
        fromStatus: result.fromStatus,
        status: result.status,
        audit: { line_id: result.lineId, period_id: result.periodId, ...result.facts },
        event: { line_id: result.lineId, period_id: result.periodId, decision: body.decision },
        ...(body.note === undefined ? {} : { reason: body.note }),
      },
      now,
    );
    return commandResult(scope, result.status, result.version, result.id);
  }

  @Post('staff-score-lines/:id/responses')
  @HttpCode(200)
  @OperationId('submitStaffScoreResponse')
  @Command({ operation: 'submitStaffScoreResponse' })
  async submitResponse(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['StaffScoreResponseInput']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.adjustments.submit(scope.tx, { lineId: id, body: body.body, actor: scope.tenant.membershipId, today: vietnamDateOf(now) });
    // The response is kept first; the clock and the workflow of the approvers are the ways it is handled (R43).
    const instanceId = await this.flow.start(scope.tx, effectsOf(scope), result, now);
    await announce(
      scope,
      {
        resource: PWF_RESOURCE_SCORE_RESPONSE,
        id: result.id,
        version: result.version,
        action: 'score.response_submitted',
        type: 'pwf.score.response.submitted.v1',
        fromStatus: null,
        status: result.status,
        audit: { line_id: result.lineId, period_id: result.periodId, instance_id: instanceId ?? null, ...result.facts },
        event: { line_id: result.lineId, period_id: result.periodId, instance_id: instanceId ?? null },
      },
      now,
    );
    return commandResult(scope, result.status, result.version, result.id);
  }

  @Post('staff-score-responses/:id/handle')
  @HttpCode(200)
  @OperationId('handleStaffScoreResponse')
  @Command({ operation: 'handleStaffScoreResponse', versioned: true })
  async handleResponse(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['StaffScoreResponseHandle']): Promise<CommandResult> {
    const now = new Date();
    const units = await scoreUnitsOf(scope.tx, access, [PERMISSIONS.handleStaffScoreResponse], now);
    if (body.outcome === 'ADJUST' && (body.adjustment_points === undefined || body.adjustment_reason === undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'adjustment_points');
    const result = await this.adjustments.handle(scope.tx, {
      responseId: id,
      expectedVersion: scope.expectedVersion ?? 0,
      outcome: body.outcome,
      conclusion: body.conclusion,
      adjustment: body.outcome === 'ADJUST' ? { points: body.adjustment_points as number, reason: body.adjustment_reason as string } : undefined,
      actor: scope.tenant.membershipId,
      units,
    });
    await this.flow.stopClock(scope.tx, result.id, scope.tenant.membershipId);
    await announce(
      scope,
      {
        resource: PWF_RESOURCE_SCORE_RESPONSE,
        id: result.id,
        version: result.version,
        action: 'score.response_handled',
        type: 'pwf.score.response.handled.v1',
        fromStatus: 'OPEN',
        status: result.status,
        audit: { line_id: result.lineId, period_id: result.periodId, ...result.facts },
        event: { line_id: result.lineId, period_id: result.periodId, outcome: body.outcome, adjustment_id: result.adjustmentId },
        reason: body.conclusion,
      },
      now,
    );
    return commandResult(scope, result.status, result.version, result.id);
  }
}
