import { Controller, Get, HttpCode, Inject, Optional, Param, Post, Query } from '@nestjs/common';
import { AlertEscalationStore, AlertGovernancePolicyReader, TenantDatabase } from '@machvon/db';
import type { EscalationRecord } from '@machvon/db';
import { ESCALATION_RULE_TYPE, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ALERT_HEALTH_PERMISSION, invalid, pathId, person, personNames, ruleView, unitScopeOf } from './alert-support';
import { HOME_CLOCK } from './tokens';

export const ESCALATION_RESOURCE = 'alert_escalation';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^[0-9]{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw invalid('limit');
  return parsed;
}

/**
 * The monitor of escalations (roadmap G2-3, NOT-19): the items that were sent up the chain, who received each level, by which kind of level (functional or hierarchical), why and when, and the policy in force; and the acknowledgement of a level by
 * its recipient, which holds the later levels for the time the policy gives. The reader sees the rows whose owner works in a unit they may read under `home.alert.health.read`; the recipient of a row sees it in their own alert centre (the source ESCALATION)
 * whatever the scope. The words of an item are those the owner saw (a snapshot), and no event carries them.
 */
@Controller()
export class AlertEscalationController {
  private readonly escalations = new AlertEscalationStore();
  private readonly policies = new AlertGovernancePolicyReader();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/alert-escalations')
  @OperationId('listAlertEscalations')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') statusQuery?: unknown, @Query('limit') limitQuery?: unknown): Promise<Record<string, unknown>> {
    const status = statusQuery === undefined ? 'open' : statusQuery;
    if (status !== 'open' && status !== 'all') throw invalid('status');
    const limit = limitOf(limitQuery);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.escalations.list(tx, { unitScope: unitScopeOf(access, ALERT_HEALTH_PERMISSION, now), status, limit });
      const names = await personNames(tx, rows.flatMap((row) => [row.recipientId, row.ownerId]));
      return { items: rows.map((row) => view(row, names)), rule: ruleView(await this.policies.info(tx, ESCALATION_RULE_TYPE, vietnamDateOf(now))), as_of: now.toISOString() };
    });
  }

  /** The recipient takes the level up: 404 when the row is not theirs, 409 when it was already acknowledged or closed. */
  @Post('home/alert-escalations/:id/acknowledge')
  @HttpCode(200)
  @OperationId('acknowledgeAlertEscalation')
  @Command({ operation: 'acknowledgeAlertEscalation' })
  async acknowledge(@Scope() scope: CommandScope, @Param('id') idParam: string): Promise<CommandResult> {
    const id = pathId(idParam);
    const now = this.clock();
    const done = await this.escalations.acknowledge(scope.tx, id, scope.tenant.membershipId, now);
    const facts = { source: done.record.source, source_id: done.record.sourceId, level: done.record.level, kind: done.record.kind, severity: done.record.severity };
    await scope.audit({ action: 'home.alert_escalation_acknowledged', resourceType: ESCALATION_RESOURCE, resourceId: id, diff: facts });
    await scope.emit({
      aggregateType: ESCALATION_RESOURCE,
      aggregateId: id,
      aggregateVersion: 2,
      type: 'home.alert_escalation_acknowledged.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), escalation_id: id, ...facts },
      eventKey: `alert_escalation_ack:${id}`,
    });
    return commandResult(scope, 'ACKNOWLEDGED', 2, id);
  }
}

function view(row: EscalationRecord, names: ReadonlyMap<string, string | null>): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    source_id: row.sourceId,
    level: row.level,
    kind: row.kind,
    trigger: row.trigger,
    recipient: person(row.recipientId, names),
    owner: person(row.ownerId, names),
    routed_via: row.routedVia,
    cover_id: row.coverId,
    severity: row.severity,
    from_severity: row.fromSeverity,
    item_title: row.itemTitle,
    item_subtitle: row.itemSubtitle,
    item_due_on: row.itemDueOn,
    target: row.target,
    reached_at: row.reachedAt,
    status: row.status,
    acknowledged_at: row.acknowledgedAt,
    closed_at: row.closedAt,
    close_reason: row.closeReason,
    policy_version: row.policyVersion,
  };
}
