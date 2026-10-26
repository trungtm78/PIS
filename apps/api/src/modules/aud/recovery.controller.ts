import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AudRecommendationStore, AudRecoveryStore, TenantDatabase, engagementScope, recommendationScope } from '@machvon/db';
import type { AuditOverview, ExceptionLine, RecoveryLinkLine, RecoverySummary } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Rate, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.listAuditEngagements;
const EXECUTE_PERMISSION = PERMISSIONS.planRemediationAction;
const RECORD_PERMISSION = PERMISSIONS.linkAuditRecovery;
const LINK_TYPE = 'audit_recovery_link';
const RECOMMENDATION_TYPE = 'audit_recommendation';
/** AUD data are CONFIDENTIAL (AUD 2): the trail and the events carry codes, ids, days and amounts, never the words an accountant wrote with a reversal. */
const CLASSIFICATION = 'CONFIDENTIAL';

const rateView = (rate: Rate): Record<string, unknown> => ({ numerator: rate.numerator, denominator: rate.denominator, percent: rate.percent });

/** A line of the ledger as AUD-08 reads it. */
export function linkView(line: RecoveryLinkLine): Record<string, unknown> {
  return {
    id: line.id,
    recommendation_id: line.recommendationId,
    rec_code: line.recCode,
    source_kind: line.sourceKind,
    source_id: line.sourceId,
    amount_vnd: line.amountVnd,
    recorded_on: line.recordedOn,
    evidence_document_id: line.evidenceDocumentId,
    reversal_of_id: line.reversalOfId,
    reversed: line.reversed,
    note: line.note,
    recorded_by: line.recordedBy,
    recorded_at: line.recordedAt,
    cumulative_vnd: line.cumulativeVnd,
    remaining_vnd: line.remainingVnd,
  };
}

const exceptionView = (line: ExceptionLine): Record<string, unknown> => ({
  id: line.id,
  recommendation_id: line.recommendationId,
  rec_code: line.recCode,
  kind: line.kind,
  source_kind: line.sourceKind,
  source_id: line.sourceId,
  amount_vnd: line.amountVnd,
  recorded_on: line.recordedOn,
  status: line.status,
  created_at: line.createdAt,
});

/** The money of an engagement as AUD-08 reads it, the two rates each with their numerator and their denominator (BR-AUD-04). */
export function summaryView(summary: RecoverySummary): Record<string, unknown> {
  return {
    engagement_id: summary.engagementId,
    amount_vnd: summary.amountVnd,
    recovered_vnd: summary.recoveredVnd,
    remaining_vnd: summary.remainingVnd,
    money_rate: rateView(summary.moneyRate),
    count_rate: rateView(summary.countRate),
    recommendations: summary.recommendations.map((line) => ({
      recommendation_id: line.recommendationId,
      rec_code: line.recCode,
      status: line.status,
      amount_vnd: line.amountVnd,
      recovered_vnd: line.recoveredVnd,
      remaining_vnd: line.remainingVnd,
      line_count: line.lineCount,
      version: line.version,
    })),
    exceptions: summary.exceptions.map(exceptionView),
  };
}

/** The figures of AUD-01. */
export function overviewView(overview: AuditOverview): Record<string, unknown> {
  return {
    engagements_ongoing: overview.engagementsOngoing,
    engagements_follow_up: overview.engagementsFollowUp,
    recommendations_open: overview.recommendationsOpen,
    recommendations_overdue: overview.recommendationsOverdue,
    amount_vnd: overview.amountVnd,
    recovered_vnd: overview.recoveredVnd,
    remaining_vnd: overview.remainingVnd,
    money_rate: rateView(overview.moneyRate),
    count_rate: rateView(overview.countRate),
    exceptions_open: overview.exceptionsOpen,
    engagements: overview.engagements.map((engagement) => ({
      id: engagement.id,
      engagement_code: engagement.code,
      title: engagement.title,
      status: engagement.status,
      recommendations_open: engagement.recommendationsOpen,
      recommendations_overdue: engagement.recommendationsOverdue,
      amount_vnd: engagement.amountVnd,
      recovered_vnd: engagement.recoveredVnd,
    })),
  };
}

/**
 * The commands of the ledger of recoveries (ST-AUD-004, AUD 3.4): an accountant links a recovery that PAY does not report, with the document that proves it, and puts right a mistake by a line of
 * the opposite sign. The recommendation is locked first and the table moves what was recovered with the line, so two accountants at once are served one after the other and the second may be
 * refused (409 RECOVERY_EXCEEDS_RECOMMENDATION). A caller finds a recommendation through its engagement or because it was given to them (404 otherwise); one who sees it and may not record is told so
 * (403). A reversal that takes a closed recommendation back to work says so in an event. The trail and the events keep codes, ids, days and amounts.
 */
@Controller()
export class AuditRecoveryController {
  private readonly recommendations = new AudRecommendationStore();
  private readonly recoveries = new AudRecoveryStore();

  private seen(access: EffectiveAccess, now: Date) {
    return recommendationScope(access, READ_PERMISSION, EXECUTE_PERMISSION, now);
  }

  @Post('audit-recommendations/:id/recoveries')
  @HttpCode(200)
  @OperationId('linkAuditRecovery')
  @Command({ operation: 'linkAuditRecovery', versioned: true })
  async link(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudRecoveryLink'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now), { acts: engagementScope(access, RECORD_PERMISSION, now) });
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recoveries.link(
      scope.tx,
      row,
      { sourceKind: body.source_kind, sourceId: body.source_id, amountVnd: body.amount_vnd, recordedOn: body.recorded_on, evidenceDocumentId: body.evidence_document_id, today: vietnamDateOf(now) },
      scope.tenant.membershipId,
    );
    const facts = {
      recommendation_id: id,
      rec_code: row.recCode,
      engagement_id: row.engagementId,
      source_kind: body.source_kind,
      source_id: body.source_id ?? null,
      amount_vnd: body.amount_vnd.replace(/^0+(?=\d)/, ''),
      recorded_on: body.recorded_on,
      evidence_document_id: body.evidence_document_id ?? null,
      recovered_vnd: done.recoveredVnd,
      remaining_vnd: done.remainingVnd,
    };
    await scope.audit({ action: 'aud.recovery_linked', resourceType: LINK_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: LINK_TYPE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'aud.recovery.linked.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, link_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${LINK_TYPE}:${done.id}:linked`,
    });
    return commandResult(scope, 'LINKED', done.version, done.id);
  }

  @Post('audit-recovery-links/:id/reversal')
  @HttpCode(200)
  @OperationId('reverseAuditRecovery')
  @Command({ operation: 'reverseAuditRecovery' })
  async reverse(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudRecoveryReversal'],
  ): Promise<CommandResult> {
    const now = new Date();
    const target = await this.recoveries.lockLink(scope.tx, id, this.seen(access, now), engagementScope(access, RECORD_PERMISSION, now));
    this.recommendations.assertFollowedUp(target.recommendation);
    const done = await this.recoveries.reverse(scope.tx, target, { reason: body.reason, today: vietnamDateOf(now) }, scope.tenant.membershipId);
    const facts = {
      recommendation_id: target.recommendation.id,
      rec_code: target.recommendation.recCode,
      engagement_id: target.recommendation.engagementId,
      reversed_link_id: id,
      source_kind: target.link.sourceKind,
      amount_vnd: target.link.amountVnd,
      recovered_vnd: done.recoveredVnd,
      reopened: done.reopened,
    };
    await scope.audit({ action: 'aud.recovery_reversed', resourceType: LINK_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: LINK_TYPE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'aud.recovery.reversed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, link_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${LINK_TYPE}:${done.id}:reversed`,
    });
    if (done.reopened) {
      await scope.audit({
        action: 'aud.recommendation_reopened',
        resourceType: RECOMMENDATION_TYPE,
        resourceId: target.recommendation.id,
        classification: CLASSIFICATION,
        diff: { reversed_link_id: id, recovered_vnd: done.recoveredVnd, from_status: 'CLOSED', to_status: 'IN_PROGRESS' },
      });
      await scope.emit({
        aggregateType: RECOMMENDATION_TYPE,
        aggregateId: target.recommendation.id,
        aggregateVersion: 1,
        type: 'aud.recommendation.reopened.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, recommendation_id: target.recommendation.id, reversed_link_id: id, recovered_vnd: done.recoveredVnd, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${RECOMMENDATION_TYPE}:${target.recommendation.id}:reopened:${done.id}`,
      });
    }
    return commandResult(scope, 'REVERSED', 1, done.id);
  }
}

/** The ledger, the money and the overview the caller may see (AUD-08, AUD-01): all of them through the scope of the engagement, so what is outside it is not found (404, or no figure). */
@Controller()
export class AuditRecoveryReadsController {
  private readonly recoveries = new AudRecoveryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-engagements/:id/recovery-summary')
  @OperationId('getAuditRecoverySummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.recoveries.summary(tx, id, engagementScope(access, READ_PERMISSION, new Date())));
    // An engagement of another tenant, or outside the scope of the caller, is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return summaryView(found);
  }

  @Get('audit-engagements/:id/recovery-links')
  @OperationId('listAuditRecoveryLinks')
  async links(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<{ items: Array<Record<string, unknown>> }> {
    const scope = engagementScope(access, READ_PERMISSION, new Date());
    const items = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.recoveries.summary(tx, id, scope)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.recoveries.listLinks(tx, id, scope);
    });
    return { items: items.map(linkView) };
  }

  @Get('audit-overview')
  @OperationId('getAuditOverview')
  async overview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    return overviewView(await this.database.withTenant(tenant, (tx) => this.recoveries.overview(tx, engagementScope(access, READ_PERMISSION, now), vietnamDateOf(now))));
  }
}
