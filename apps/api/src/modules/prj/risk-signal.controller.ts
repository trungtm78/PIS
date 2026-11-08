import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GovernancePolicyPort, RISK_ALERT_RESOURCE, RiskSignalStore, TenantDatabase, projectInScope, projectScope } from '@machvon/db';
import type { RiskAlertView, RiskBoardItem, RiskHistoryRow, RiskSignalLine } from '@machvon/db';
import { DomainError, RISK_SIGNAL_KINDS, RISK_SIGNAL_RULE_CODE, RISK_SIGNAL_RULE_TYPE, asUuid, ruleTypeOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ResolvedGovernanceRule, RiskLevel, RiskSignalKind, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const BOARD_PERMISSION = PERMISSIONS.getRiskSignalBoard;
const PROJECT_PERMISSION = PERMISSIONS.getProjectRiskSignals;
const ALERT_READ_PERMISSION = PERMISSIONS.listProjectRiskAlerts;
const ALERT_ACK_PERMISSION = PERMISSIONS.acknowledgeProjectRiskAlert;

const LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'CRITICAL'];
const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** Where the numbers of the rule come from, in the shape the "i" of a figure shows: the formula, the source, the day, the version that decided and whether it is not verified (the thresholds are the rule's, never the screen's). */
export function ruleInfoView(rule: ResolvedGovernanceRule): Record<string, unknown> {
  return {
    name: rule.type,
    code: rule.code,
    formula: rule.provenance?.formula ?? null,
    source: rule.provenance?.source ?? null,
    as_of: rule.provenance?.asOf ?? null,
    legal_status: rule.provenance?.legalStatus ?? 'UNVERIFIED',
    unverified: rule.unverified,
    version: rule.source === 'DEFAULT' ? 'built-in:1' : String(rule.version),
    owner: ruleTypeOf(rule.type).ownerModule,
    params: rule.params,
  };
}

export function boardItemView(item: RiskBoardItem): Record<string, unknown> {
  return {
    origin: item.origin,
    id: item.id,
    project_id: item.projectId,
    project_code: item.projectCode,
    project_name: item.projectName,
    kind: item.kind,
    title: item.title,
    likelihood: item.likelihood,
    impact: item.impact,
    score: item.score,
    level: item.level,
    previous_score: item.previousScore,
    trend: item.trend,
    scored_on: item.scoredOn,
    evidence: item.evidence,
    owner: item.ownerMembershipId === null ? null : { membership_id: item.ownerMembershipId, display_name: item.ownerName },
    alert_open: item.alertOpen,
    rule_unverified: item.ruleUnverified,
  };
}

const lineView = (line: RiskSignalLine): Record<string, unknown> => ({
  id: line.id,
  signal_kind: line.signalKind,
  status: line.status,
  likelihood: line.likelihood,
  impact: line.impact,
  score: line.score,
  evidence: line.evidence,
  rule_version: line.ruleVersion,
  rule_unverified: line.ruleUnverified,
  first_scored_on: line.firstScoredOn,
  last_scored_on: line.lastScoredOn,
  cleared_on: line.clearedOn,
  version: line.version,
});

const historyView = (row: RiskHistoryRow): Record<string, unknown> => ({
  id: row.id,
  subject_kind: row.subjectKind,
  signal_id: row.signalId,
  risk_id: row.riskId,
  signal_kind: row.signalKind,
  source: row.source,
  scored_on: row.scoredOn,
  likelihood: row.likelihood,
  impact: row.impact,
  score: row.score,
  level: row.level,
  prior_score: row.priorScore,
  status: row.status,
  evidence: row.evidence,
  rule_version: row.ruleVersion,
  scored_at: row.scoredAt,
});

export const riskAlertView = (alert: RiskAlertView): Record<string, unknown> => ({
  id: alert.id,
  project_id: alert.projectId,
  project_code: alert.projectCode,
  alert_type: alert.alertType,
  subject_kind: alert.subjectKind,
  subject_id: alert.subjectId,
  signal_kind: alert.signalKind,
  score: alert.score,
  prior_score: alert.priorScore,
  threshold: alert.threshold,
  rule_version: alert.ruleVersion,
  rule_unverified: alert.ruleUnverified,
  status: alert.status,
  raised_on: alert.raisedOn,
  acknowledged_at: alert.acknowledgedAt,
  acknowledge_note: alert.acknowledgeNote,
  resolved_on: alert.resolvedOn,
  version: alert.version,
});

/** The acknowledgement of a risk alert: a person takes it in with a note, under the version they saw. The scope of the permission decides, the one of `project.read` tells a refusal from a miss. */
@Controller()
export class ProjectRiskAlertController {
  private readonly signals = new RiskSignalStore();

  @Post('project-risk-alerts/:id/acknowledgement')
  @HttpCode(200)
  @OperationId('acknowledgeProjectRiskAlert')
  @Command({ operation: 'acknowledgeProjectRiskAlert', versioned: true })
  async acknowledge(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRiskAlertAck']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.signals.acknowledge(scope.tx, {
      alertId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      note: body.note,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, ALERT_ACK_PERMISSION, now), read: projectScope(access, PROJECT_PERMISSION, now) },
    });
    await scope.audit({
      action: 'project.risk_alert_acknowledged',
      resourceType: RISK_ALERT_RESOURCE,
      resourceId: done.id,
      classification: done.classification as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL',
      reason: body.note,
      diff: { project_id: done.projectId, code: done.projectCode, alert_type: done.alertType, score: done.score, threshold: done.threshold },
    });
    await scope.emit({
      aggregateType: RISK_ALERT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'project.risk_alert_acknowledged.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, alert_id: done.id, alert_type: done.alertType, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RISK_ALERT_RESOURCE}:${done.id}:${done.version}`,
    });
    return { ...commandResult(scope, 'ACKNOWLEDGED', done.version, done.id), project_id: done.projectId };
  }
}

/** The reads of PRJ-28 (MR.02): the board of the risks of the projects in the scope of the caller, the lines and the history of one project, and the alerts. */
@Controller()
export class ProjectRiskSignalReadsController {
  private readonly signals = new RiskSignalStore();
  private readonly policies = new GovernancePolicyPort();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('risk-signals/board')
  @OperationId('getRiskSignalBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('kind') kind?: unknown, @Query('level') level?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    if (kind !== undefined && (typeof kind !== 'string' || !([...RISK_SIGNAL_KINDS, 'REGISTER'] as string[]).includes(kind))) throw invalid('kind');
    if (level !== undefined && (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level))) throw invalid('level');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const board = await this.signals.board(tx, projectScope(access, BOARD_PERMISSION, now), {
        kind: kind as RiskSignalKind | 'REGISTER' | undefined,
        level: level as RiskLevel | undefined,
        limit: request.limit + 1,
        after: request.after,
      });
      const shown = board.items.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const rule = await this.policies.require(tx, RISK_SIGNAL_RULE_TYPE, RISK_SIGNAL_RULE_CODE, vietnamDateOf(now));
      return {
        items: shown.map(boardItemView),
        next_cursor: board.items.length > request.limit && last !== undefined ? encodeCursor({ code: last.rankKey, id: last.id }) : null,
        counts: { total: board.counts.total, critical: board.counts.critical, medium: board.counts.medium, low: board.counts.low, open_alerts: board.counts.openAlerts },
        policy: ruleInfoView(rule),
        as_of: vietnamDateOf(now),
      };
    });
  }

  @Get('projects/:id/risk-signals')
  @OperationId('getProjectRiskSignals')
  async project(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = asUuid(id);
    if (projectId === undefined) throw invalid('id');
    return this.database.withTenant(tenant, async (tx) => {
      const view = await this.signals.projectView(tx, projectScope(access, PROJECT_PERMISSION, now), projectId);
      const rule = await this.policies.require(tx, RISK_SIGNAL_RULE_TYPE, RISK_SIGNAL_RULE_CODE, vietnamDateOf(now));
      const acknowledge = view.alerts.some((alert) => alert.status === 'OPEN') && (await projectInScope(tx, projectId, projectScope(access, ALERT_ACK_PERMISSION, now)));
      return {
        project: { id: view.project.id, code: view.project.code, name: view.project.name, status: view.project.status },
        lines: view.lines.map(lineView),
        history: view.history.map(historyView),
        alerts: view.alerts.map(riskAlertView),
        policy: ruleInfoView(rule),
        can: { acknowledge_alert: acknowledge },
        as_of: vietnamDateOf(now),
      };
    });
  }

  @Get('project-risk-alerts')
  @OperationId('listProjectRiskAlerts')
  async alerts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('project_id') projectId?: unknown, @Query('limit') limit?: unknown): Promise<Record<string, unknown>> {
    if (status !== undefined && (typeof status !== 'string' || !(ALERT_STATUSES as readonly string[]).includes(status))) throw invalid('status');
    const project = projectId === undefined ? undefined : asUuid(projectId);
    if (projectId !== undefined && project === undefined) throw invalid('project_id');
    const size = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) throw invalid('limit');
    const now = new Date();
    const items = await this.database.withTenant(tenant, (tx) => this.signals.listAlerts(tx, projectScope(access, ALERT_READ_PERMISSION, now), { status: status as (typeof ALERT_STATUSES)[number] | undefined, projectId: project }, size));
    return { items: items.map(riskAlertView), as_of: vietnamDateOf(now) };
  }
}
