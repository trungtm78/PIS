import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_WARNING_OPEN_METRIC, DisWarningStore, TenantDatabase, WARNING_RESOURCE, WARNING_RULE_RESOURCE, projectScope } from '@machvon/db';
import type { WarningRow, WarningRuleRow } from '@machvon/db';
import { DomainError, NOOP_METRICS, WARNING_SEVERITIES, WARNING_STATUSES, checkRule, reasonOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, RuleInput, TenantContext, WarningAction } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const HANDLE_PERMISSION = PERMISSIONS.acknowledgeEarlyWarning;
const READ_PERMISSION = PERMISSIONS.listEarlyWarnings;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_CODE = /^[A-Z][A-Z0-9-]{0,29}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function ruleView(rule: WarningRuleRow, preview?: { snapshotId: string | null; wouldOpen: number }): Record<string, unknown> {
  return {
    id: rule.id,
    rule_code: rule.ruleCode,
    name: rule.name,
    metric_code: rule.metricCode,
    comparator: rule.comparator,
    threshold_json: rule.threshold,
    severity: rule.severity,
    scope_kind: rule.scopeKind,
    auto_explanation: rule.autoExplanation,
    legal_basis: rule.legalBasis,
    effective_from: rule.effectiveFrom,
    effective_until: rule.effectiveUntil,
    revision: rule.revision,
    status: rule.status,
    approved_by: rule.approvedBy,
    created_by: rule.createdBy,
    created_at: rule.createdAt,
    version: rule.version,
    ...(preview === undefined ? {} : { preview: { snapshot_id: preview.snapshotId, would_open: preview.wouldOpen } }),
  };
}

export function warningView(warning: WarningRow): Record<string, unknown> {
  return {
    id: warning.id,
    rule_id: warning.ruleId,
    rule_code: warning.ruleCode,
    rule_name: warning.ruleName,
    project: warning.projectId === null ? null : { id: warning.projectId, code: warning.projectCode, name: warning.projectName },
    unit_id: warning.unitId,
    period_id: warning.periodId,
    snapshot_id: warning.snapshotId,
    severity: warning.severity,
    observed: warning.observed,
    dedupe_key: warning.dedupeKey,
    status: warning.status,
    owner_membership_id: warning.ownerMembershipId,
    explanation_request_id: warning.explanationRequestId,
    resolution_reason: warning.resolutionReason,
    acknowledged_by: warning.acknowledgedBy,
    acknowledged_at: warning.acknowledgedAt,
    acknowledgement_note: warning.acknowledgementNote,
    closed_by: warning.closedBy,
    opened_at: warning.openedAt,
    closed_at: warning.closedAt,
    version: warning.version,
  };
}

function optionalOf(value: unknown, field: string, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The early-warning rules and the warnings of DIS (ST-DIS-012, DIS 3 F7, DIS-20): a rule is made as a draft and published by someone else (403 SELF_APPROVAL_DENIED), never edited, only versioned; the
 * warnings that the published rules open after each frozen snapshot (the job of `WarningEvaluateConsumer`) are acknowledged or dismissed here, with a reason, by those who handle the projects.
 */
@Controller()
export class EarlyWarningController {
  private readonly store = new DisWarningStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('early-warning-rules')
  @HttpCode(200)
  @OperationId('createEarlyWarningRuleVersion')
  @Command({ operation: 'createEarlyWarningRuleVersion' })
  async createRule(@Scope() scope: CommandScope, @Body() body: Schemas['DisWarningRule']): Promise<CommandResult> {
    const draft = checkRule(body as RuleInput);
    const rule = await this.store.createRuleVersion(scope.tx, draft, scope.tenant.membershipId);
    await scope.audit({
      action: 'dis.warning_rule_created',
      resourceType: WARNING_RULE_RESOURCE,
      resourceId: rule.id,
      diff: { rule_code: rule.ruleCode, revision: rule.revision, metric_code: rule.metricCode, severity: rule.severity, effective_from: rule.effectiveFrom },
    });
    return commandResult(scope, rule.status, rule.version, rule.id);
  }

  @Post('early-warning-rules/:id/publish')
  @HttpCode(200)
  @OperationId('publishEarlyWarningRule')
  @Command({ operation: 'publishEarlyWarningRule', versioned: true })
  async publishRule(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    const done = await this.store.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const { rule } = done;
    await scope.audit({
      action: 'dis.warning_rule_published',
      resourceType: WARNING_RULE_RESOURCE,
      resourceId: id,
      diff: { rule_code: rule.ruleCode, revision: rule.revision, metric_code: rule.metricCode, severity: rule.severity, retired_id: done.retiredId, version: rule.version },
    });
    await scope.emit({
      aggregateType: WARNING_RULE_RESOURCE,
      aggregateId: id,
      aggregateVersion: rule.version,
      type: 'warning.rule_published.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        rule_id: id,
        rule_code: rule.ruleCode,
        revision: rule.revision,
        metric_code: rule.metricCode,
        severity: rule.severity,
        effective_from: rule.effectiveFrom,
        retired_rule_id: done.retiredId,
      },
      eventKey: `${WARNING_RULE_RESOURCE}:${id}:published`,
    });
    return commandResult(scope, rule.status, rule.version, id);
  }

  /** Every revision of every rule, with what each draft would open on the latest frozen close snapshot (the preview of the policy editor). */
  @Get('early-warning-rules')
  @OperationId('listEarlyWarningRules')
  async listRules(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    // What a draft would open is told for the projects the caller may read, not for the tenant.
    const visible = projectScope(access, READ_PERMISSION, now);
    return this.database.withTenant(tenant, async (tx) => {
      const rules = await this.store.listRules(tx);
      const items: Record<string, unknown>[] = [];
      for (const rule of rules) {
        items.push(ruleView(rule, rule.status === 'DRAFT' ? await this.store.preview(tx, rule, now, visible) : undefined));
      }
      return { items, next_cursor: null };
    });
  }

  private async handle(scope: CommandScope, access: EffectiveAccess, id: string, action: WarningAction, body: Schemas['DisWarningAction']): Promise<CommandResult> {
    const now = this.clock();
    const reason = reasonOf(body.reason);
    const owner = optionalUuid(body.owner_membership_id, 'owner_membership_id');
    const done = await this.store.handle(scope.tx, id, action, { expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, reason, ownerMembershipId: owner, scope: projectScope(access, HANDLE_PERMISSION, now) });
    const { warning } = done;
    await scope.audit({
      action: action === 'acknowledge' ? 'dis.warning_acknowledged' : 'dis.warning_dismissed',
      resourceType: WARNING_RESOURCE,
      resourceId: id,
      diff: { rule_code: warning.ruleCode, dedupe_key: warning.dedupeKey, previous_status: done.before, status: warning.status, severity: warning.severity, owner_membership_id: warning.ownerMembershipId, reason_length: reason.length, version: warning.version },
    });
    if (action === 'dismiss') {
      await scope.emit({
        aggregateType: WARNING_RESOURCE,
        aggregateId: id,
        aggregateVersion: warning.version,
        type: 'warning.resolved.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), warning_id: id, rule_code: warning.ruleCode, resolution: 'DISMISSED', project_id: warning.projectId },
        eventKey: `${WARNING_RESOURCE}:${id}:closed`,
      });
    }
    scope.afterCommit(async () => {
      const counts = await this.database.withTenant(scope.tenant, (tx) => this.store.openCounts(tx));
      for (const severity of WARNING_SEVERITIES) this.metrics.gauge(DIS_WARNING_OPEN_METRIC, counts.find((item) => item.severity === severity)?.count ?? 0, { severity });
    });
    return commandResult(scope, warning.status, warning.version, id);
  }

  @Post('early-warnings/:id/acknowledge')
  @HttpCode(200)
  @OperationId('acknowledgeEarlyWarning')
  @Command({ operation: 'acknowledgeEarlyWarning', versioned: true })
  acknowledge(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisWarningAction']): Promise<CommandResult> {
    return this.handle(scope, access, id, 'acknowledge', body);
  }

  @Post('early-warnings/:id/dismiss')
  @HttpCode(200)
  @OperationId('dismissEarlyWarning')
  @Command({ operation: 'dismissEarlyWarning', versioned: true })
  dismiss(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisWarningAction']): Promise<CommandResult> {
    return this.handle(scope, access, id, 'dismiss', body);
  }

  @Get('early-warnings')
  @OperationId('listEarlyWarnings')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('severity') severity?: unknown,
    @Query('rule_code') ruleCode?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    if (ruleCode !== undefined && (typeof ruleCode !== 'string' || !RULE_CODE.test(ruleCode))) throw new DomainError('VALIDATION_FAILED', 422, 'rule_code');
    const filter = {
      status: optionalOf(status, 'status', WARNING_STATUSES),
      severity: optionalOf(severity, 'severity', WARNING_SEVERITIES),
      ruleCode: ruleCode as string | undefined,
      projectId: optionalUuid(projectId, 'project_id'),
      unitId: optionalUuid(unitId, 'unit_id'),
    };
    const scope = projectScope(access, READ_PERMISSION, this.clock());
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, scope, filter, { limit: request.limit + 1, after: request.after === undefined ? undefined : { openedAt: request.after.code, id: request.after.id } }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(warningView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.openedAt, id: last.id }) : null };
  }
}
