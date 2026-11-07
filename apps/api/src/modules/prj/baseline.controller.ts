import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BASELINE_RESOURCE, GOVERNANCE_ALERT_RESOURCE, PrjBaselineStore, REAPPRAISAL_RESOURCE, TenantDatabase, projectInScope, projectScope } from '@machvon/db';
import type { BaselineView, GovernanceAlertView } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getProjectBaseline;
const CAPTURE_PERMISSION = PERMISSIONS.captureProjectBaseline;
const DECIDE_PERMISSION = PERMISSIONS.decideReappraisalRequest;
const ALERT_READ_PERMISSION = PERMISSIONS.listGovernanceAlerts;
const ALERT_ACK_PERMISSION = PERMISSIONS.acknowledgeGovernanceAlert;

const deviationView = (deviation: NonNullable<BaselineView['deviation']>): Record<string, unknown> => ({
  cost_vnd: deviation.costVnd,
  cost_pct: deviation.costPct,
  bac_vnd: deviation.bacVnd,
  bac_pct: deviation.bacPct,
  finish_slip_days: deviation.finishSlipDays,
  forecast_finish: deviation.forecastFinish,
  milestones: deviation.milestones.map((milestone) => ({ code: milestone.code, baseline_date: milestone.baselineDate, planned_date: milestone.plannedDate, slip_days: milestone.slipDays, moves: milestone.moves })),
});

export const alertView = (alert: GovernanceAlertView): Record<string, unknown> => ({
  id: alert.id,
  project_id: alert.projectId,
  project_code: alert.projectCode,
  alert_type: alert.alertType,
  audience: alert.audience,
  subject_kind: alert.subjectKind,
  subject_id: alert.subjectId,
  subject_code: alert.subjectCode,
  move_count: alert.moveCount,
  threshold: alert.threshold,
  rule_version: alert.ruleVersion,
  status: alert.status,
  raised_by: alert.raisedBy,
  raised_at: alert.raisedAt,
  acknowledged_by: alert.acknowledgedBy,
  acknowledged_at: alert.acknowledgedAt,
  acknowledge_note: alert.acknowledgeNote,
  version: alert.version,
});

/** The baseline of a project as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. */
export function baselineView(view: BaselineView, actions: Record<string, boolean>): Record<string, unknown> {
  return {
    project_id: view.projectId,
    project_code: view.projectCode,
    project_status: view.projectStatus,
    has_baseline: view.hasBaseline,
    versions: view.versions.map((version) => ({
      id: version.id,
      version: version.version,
      kind: version.kind,
      basis: version.basis,
      total_investment_vnd: version.totalInvestmentVnd,
      bac_vnd: version.bacVnd,
      planned_start: version.plannedStart,
      planned_finish: version.plannedFinish,
      source_revision_id: version.sourceRevisionId,
      taken_by: version.takenBy,
      taken_at: version.takenAt,
      lines: version.lines.map((line) => ({ component_id: line.componentId, code: line.code, name: line.name, bac_vnd: line.bacVnd, planned_start: line.plannedStart, planned_finish: line.plannedFinish })),
    })),
    current: { total_investment_vnd: view.current.totalInvestmentVnd, bac_vnd: view.current.bacVnd, forecast_finish: view.current.forecastFinish },
    deviation: view.deviation === null ? null : deviationView(view.deviation),
    reasons: view.reasons,
    reschedule: {
      count: view.reschedule.count,
      project_moves: view.reschedule.projectMoves,
      per_milestone: view.reschedule.perMilestone.map((entry) => ({ milestone_id: entry.milestoneId, code: entry.code, moves: entry.moves })),
      events: view.reschedule.events.map((event) => ({
        id: event.id,
        source: event.source,
        milestone_id: event.milestoneId,
        milestone_code: event.milestoneCode,
        revision_id: event.revisionId,
        from_date: event.fromDate,
        to_date: event.toDate,
        reason: event.reason,
        recorded_by: event.recordedBy,
        recorded_at: event.recordedAt,
      })),
    },
    alerts: view.alerts.map(alertView),
    reappraisals: view.reappraisals.map((request) => ({
      id: request.id,
      baseline_id: request.baselineId,
      status: request.status,
      reasons: request.reasons,
      cost_pct: request.costPct,
      finish_slip_days: request.finishSlipDays,
      threshold_cost_pct: request.thresholdCostPct,
      threshold_slip_days: request.thresholdSlipDays,
      rule_version: request.ruleVersion,
      triggered_by: request.triggeredBy,
      requested_by: request.requestedBy,
      requested_at: request.requestedAt,
      decided_by: request.decidedBy,
      decided_at: request.decidedAt,
      decision_reason: request.decisionReason,
      version: request.version,
    })),
    policy: { version: view.policy.version, source: view.policy.source, cost_pct: view.policy.costPct, slip_days: view.policy.slipDays, reschedule_alert_count: view.policy.rescheduleAlertCount },
    actions,
    as_of: view.asOf,
  };
}

/**
 * The baseline of a project (governance deepening G1-3, PRJ-26): version 0 is chosen once from the approved work breakdown and the baseline days of the milestones and never changes; the request to appraise again is
 * decided by someone other than the maker of the change; the auditors acknowledge the alerts that reach them. The effects of the rule on the commands that move a date (the count, the alert, the request) are written down
 * by the controllers of those commands (`recordGovernanceEffects`). Every command is audited and idempotent.
 */
@Controller()
export class ProjectBaselineController {
  private readonly baselines = new PrjBaselineStore();

  @Post('projects/:id/baseline')
  @HttpCode(200)
  @OperationId('captureProjectBaseline')
  @Command({ operation: 'captureProjectBaseline' })
  async capture(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjBaselineCapture']): Promise<CommandResult & Record<string, unknown>> {
    void body;
    const now = new Date();
    const done = await this.baselines.capture(scope.tx, {
      projectId: id.toLowerCase(),
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, CAPTURE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    await scope.audit({
      action: 'project.baseline_captured',
      resourceType: BASELINE_RESOURCE,
      resourceId: done.id,
      classification: done.classification,
      diff: { project_id: done.projectId, code: done.projectCode, version: done.version, total_investment_vnd: done.totalInvestmentVnd, bac_vnd: done.bacVnd, planned_start: done.plannedStart, planned_finish: done.plannedFinish, lines: done.lineCount },
    });
    await scope.emit({
      aggregateType: BASELINE_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'project.baseline_captured.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: done.projectId,
        baseline_id: done.id,
        baseline_version: done.version,
        total_investment_vnd: done.totalInvestmentVnd,
        bac_vnd: done.bacVnd,
        planned_start: done.plannedStart,
        planned_finish: done.plannedFinish,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${BASELINE_RESOURCE}:${done.id}`,
    });
    return { ...commandResult(scope, 'TAKEN', 1, done.id), project_id: done.projectId, baseline_version: done.version, bac_vnd: done.bacVnd, line_count: done.lineCount };
  }

  @Post('project-reappraisals/:id/decision')
  @HttpCode(200)
  @OperationId('decideReappraisalRequest')
  @Command({ operation: 'decideReappraisalRequest', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjReappraisalDecision']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.baselines.decideReappraisal(scope.tx, {
      requestId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      decision: body.decision,
      reason: body.reason,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, DECIDE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await scope.audit({
      action: `project.reappraisal_${done.status === 'STARTED' ? 'started' : 'waived'}`,
      resourceType: REAPPRAISAL_RESOURCE,
      resourceId: done.id,
      classification: done.classification,
      reason: done.decisionReason,
      diff: { project_id: done.projectId, code: done.projectCode, status: done.status, reasons: done.reasons },
    });
    await scope.emit({
      aggregateType: REAPPRAISAL_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'project.reappraisal_decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, request_id: done.id, status: done.status, reasons: done.reasons, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REAPPRAISAL_RESOURCE}:${done.id}:${done.version}`,
    });
    return { ...commandResult(scope, done.status, done.version, done.id), project_id: done.projectId };
  }

  @Post('project-governance-alerts/:id/acknowledgement')
  @HttpCode(200)
  @OperationId('acknowledgeGovernanceAlert')
  @Command({ operation: 'acknowledgeGovernanceAlert', versioned: true })
  async acknowledge(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjGovernanceAlertAck']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.baselines.acknowledgeAlert(scope.tx, {
      alertId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      note: body.note,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, ALERT_ACK_PERMISSION, now), read: projectScope(access, ALERT_READ_PERMISSION, now) },
    });
    await scope.audit({
      action: 'project.governance_alert_acknowledged',
      resourceType: GOVERNANCE_ALERT_RESOURCE,
      resourceId: done.id,
      classification: done.classification,
      reason: body.note,
      diff: { project_id: done.projectId, code: done.projectCode, move_count: done.moveCount },
    });
    await scope.emit({
      aggregateType: GOVERNANCE_ALERT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'project.governance_alert_acknowledged.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, alert_id: done.id, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${GOVERNANCE_ALERT_RESOURCE}:${done.id}:${done.version}`,
    });
    return { ...commandResult(scope, 'ACKNOWLEDGED', done.version, done.id), project_id: done.projectId };
  }
}

/** The reads of PRJ-26 (G1-3): the baseline of a project and the alerts that reach the auditors, each in the scope of its own permission. */
@Controller()
export class ProjectBaselineReadsController {
  private readonly baselines = new PrjBaselineStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/baseline')
  @OperationId('getProjectBaseline')
  async baseline(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = id.toLowerCase();
    return this.database.withTenant(tenant, async (tx) => {
      const view = await this.baselines.view(tx, projectScope(access, READ_PERMISSION, now), projectId, vietnamDateOf(now));
      const reaches = (permission: string): Promise<boolean> => projectInScope(tx, projectId, projectScope(access, permission, now));
      return baselineView(view, {
        capture: !view.hasBaseline && (await reaches(CAPTURE_PERMISSION)),
        decide_reappraisal: view.reappraisals.some((request) => request.status === 'OPEN') && (await reaches(DECIDE_PERMISSION)),
        acknowledge_alert: view.alerts.some((alert) => alert.status === 'OPEN') && (await reaches(ALERT_ACK_PERMISSION)),
      });
    });
  }

  @Get('project-governance-alerts')
  @OperationId('listGovernanceAlerts')
  async alerts(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status: unknown,
    @Query('project_id') projectId: unknown,
    @Query('limit') limit: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    if (status !== undefined && status !== 'OPEN' && status !== 'ACKNOWLEDGED') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const project = projectId === undefined ? undefined : asUuid(projectId);
    if (projectId !== undefined && project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const size = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    const items = await this.database.withTenant(tenant, (tx) => this.baselines.listAlerts(tx, projectScope(access, ALERT_READ_PERMISSION, now), { status, projectId: project }, size));
    return { items: items.map(alertView), as_of: vietnamDateOf(now) };
  }
}
