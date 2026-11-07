import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisWarningStore, HomeWorkActionStore, HomeWorkStore, PayAdvanceStore, WARNING_RESOURCE, contractScope, projectScope } from '@machvon/db';
import type { WorkActionKind, WorkRow, WorkSource } from '@machvon/db';
import { DomainError, reasonOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { recordAdvanceTrail } from '../pay/advance.controller';
import { HOME_CLOCK } from './tokens';
import { canReadScope, holdsGrantOf, workScopes } from './work-scope';

const RESOURCE_TYPE = 'work_item';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** How far ahead an item that has no day of its own may be put off. */
export const SNOOZE_MAX_DAYS = 30;
/** What the acknowledgement of a warning says when the person who took it up gave no words. */
const DEFAULT_ACK_REASON = 'Đã nhận xử lý từ trung tâm cảnh báo';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const OUTCOME: Readonly<Record<WorkActionKind, { status: string; audit: string; event: string }>> = {
  CLAIM: { status: 'CLAIMED', audit: 'home.work_claimed', event: 'home.work_claimed.v1' },
  ASSIGN: { status: 'ASSIGNED', audit: 'home.work_assigned', event: 'home.work_assigned.v1' },
  SNOOZE: { status: 'SNOOZED', audit: 'home.work_snoozed', event: 'home.work_snoozed.v1' },
};

/**
 * The three things a person does about an item of the alert centre: take it up (`claimWork`), give it to someone with a day (`assignWork`), put it off (`snoozeWork`). The item has to be in the work the person may see (404
 * WORK_ITEM_GONE otherwise: it was handled, or it is not theirs). Each decision is a row of `work_action` (append-only), with the audit row and the event in the same transaction, under the Idempotency-Key of the command.
 * Taking up an early warning or an advance that is overdue also acknowledges it in DIS or PAY, by the store of that module, in the same transaction, so that the two never disagree. The module's own commands stay.
 */
@Controller()
export class WorkActionController {
  private readonly work = new HomeWorkStore();
  private readonly actions = new HomeWorkActionStore();
  private readonly warnings = new DisWarningStore();
  private readonly advances = new PayAdvanceStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(HOME_CLOCK) clock?: () => Date) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('home/work-actions/claim')
  @HttpCode(200)
  @OperationId('claimWork')
  @Command({ operation: 'claimWork' })
  async claim(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkActionTarget']): Promise<CommandResult> {
    if (body.assignee_id !== undefined) throw invalid('assignee_id');
    if (body.snooze_until !== undefined) throw invalid('snooze_until');
    if (body.due_on !== undefined && body.source !== 'ADVANCE') throw invalid('due_on');
    const now = this.clock();
    const row = await this.find(scope, access, body, now);
    const recorded = await this.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'CLAIM', actor: scope.tenant.membershipId, reason: body.reason });
    // The module that owns the item hears of it in the same transaction.
    await this.acknowledgeInSource(scope, access, row, body, now);
    return this.finish(scope, row, 'CLAIM', recorded.id, now, {});
  }

  @Post('home/work-actions/assign')
  @HttpCode(200)
  @OperationId('assignWork')
  @Command({ operation: 'assignWork' })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkActionTarget']): Promise<CommandResult> {
    if (body.snooze_until !== undefined) throw invalid('snooze_until');
    if (body.assignee_id === undefined) throw invalid('assignee_id');
    const now = this.clock();
    const today = vietnamDateOf(now);
    if (body.due_on !== undefined && body.due_on < today) throw invalid('due_on');
    const row = await this.find(scope, access, body, now);
    await this.assertAssignee(scope, access, body.assignee_id, now);
    const recorded = await this.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'ASSIGN', actor: scope.tenant.membershipId, assignee: body.assignee_id.toLowerCase(), dueOn: body.due_on, reason: body.reason });
    return this.finish(scope, row, 'ASSIGN', recorded.id, now, { assignee_id: body.assignee_id.toLowerCase(), due_on: body.due_on ?? null });
  }

  @Post('home/work-actions/snooze')
  @HttpCode(200)
  @OperationId('snoozeWork')
  @Command({ operation: 'snoozeWork' })
  async snooze(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkActionTarget']): Promise<CommandResult> {
    if (body.assignee_id !== undefined) throw invalid('assignee_id');
    if (body.due_on !== undefined) throw invalid('due_on');
    if (body.snooze_until === undefined) throw invalid('snooze_until');
    const now = this.clock();
    const until = new Date(body.snooze_until);
    if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) throw invalid('snooze_until');
    const row = await this.find(scope, access, body, now);
    this.assertSnoozable(row, until, now);
    const recorded = await this.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'SNOOZE', actor: scope.tenant.membershipId, snoozeUntil: until.toISOString(), reason: body.reason });
    return this.finish(scope, row, 'SNOOZE', recorded.id, now, { snooze_until: until.toISOString() });
  }

  /** An urgent item is not put off, and nothing is put off past its day (an item that has no day is put off for at most a month). */
  private assertSnoozable(row: WorkRow, until: Date, now: Date): void {
    if (row.severity === 'URGENT') throw new DomainError('WORK_SNOOZE_NOT_ALLOWED', 422, 'severity');
    if (row.dueOn !== null) {
      if (vietnamDateOf(until) > row.dueOn) throw new DomainError('WORK_SNOOZE_NOT_ALLOWED', 422, 'snooze_until');
    } else if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * DAY_MS) throw new DomainError('WORK_SNOOZE_NOT_ALLOWED', 422, 'snooze_until');
  }

  /** The item, as the person sees it now: in the work given to them, or in the scope they may read (404 WORK_ITEM_GONE when it is in neither). */
  private async find(scope: CommandScope, access: EffectiveAccess, target: Schemas['WorkActionTarget'], now: Date): Promise<WorkRow> {
    const today = vietnamDateOf(now);
    const source = target.source as WorkSource;
    const unavailable = new Set<string>();
    for (const view of canReadScope(access, now) ? (['mine', 'scope'] as const) : (['mine'] as const)) {
      const collected = await this.work.collect(scope.tx, { membershipId: scope.tenant.membershipId, now, today, view, mode: 'count', includeHidden: true, ...workScopes(access, now) });
      const row = collected.rows.find((candidate) => candidate.source === source && candidate.id === target.source_id);
      if (row !== undefined) return row;
      for (const name of collected.unavailableSources) unavailable.add(name);
    }
    // A source that could not be read does not say the item is gone.
    if (unavailable.has(source)) throw new DomainError('PROVIDER_UNAVAILABLE', 503, source);
    throw new DomainError('WORK_ITEM_GONE', 404, 'source_id');
  }

  /** The assignee is an active member of a unit the person may read (404 RESOURCE_NOT_FOUND names nothing of a member outside it). */
  private async assertAssignee(scope: CommandScope, access: EffectiveAccess, assignee: string, now: Date): Promise<void> {
    const units = workScopes(access, now).unitScope(2);
    const found = await scope.tx.query<{ id: string }>(
      `select m.id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
        where m.id = $1::uuid and m.status = 'Active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now()) and ${units.sql}`,
      [assignee.toLowerCase(), ...units.params],
    );
    if (found.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'assignee_id');
  }

  /**
   * Taking up an early warning that is open acknowledges it in DIS, and taking up an advance that is overdue acknowledges its alert in PAY (the plan to recover it is the words and the day the person gave; without them PAY's own
   * command stays what records the plan), each by the store of its module and under the right of that module: a person who may take the item up but not acknowledge it in its module only takes it up.
   */
  private async acknowledgeInSource(scope: CommandScope, access: EffectiveAccess, row: WorkRow, body: Schemas['WorkActionTarget'], now: Date): Promise<void> {
    const actor = scope.tenant.membershipId;
    if (row.source === 'EARLY_WARNING' && holdsGrantOf(access, now, PERMISSIONS.acknowledgeEarlyWarning)) {
      const reach = projectScope(access, PERMISSIONS.acknowledgeEarlyWarning, now);
      const current = await this.warnings.find(scope.tx, row.id, reach, true);
      if (current === undefined || current.status !== 'OPEN') return;
      const reason = body.reason !== undefined && body.reason.trim().length >= 5 ? reasonOf(body.reason) : DEFAULT_ACK_REASON;
      const done = await this.warnings.handle(scope.tx, row.id, 'acknowledge', { expectedVersion: current.version, actor, reason, scope: reach });
      const { warning } = done;
      await scope.audit({
        action: 'dis.warning_acknowledged',
        resourceType: WARNING_RESOURCE,
        resourceId: row.id,
        diff: { rule_code: warning.ruleCode, dedupe_key: warning.dedupeKey, previous_status: done.before, status: warning.status, severity: warning.severity, owner_membership_id: warning.ownerMembershipId, reason_length: reason.length, version: warning.version, via: 'home.work_claimed' },
      });
      return;
    }
    if (row.source === 'ADVANCE' && holdsGrantOf(access, now, PERMISSIONS.acknowledgeAdvanceAlert) && body.reason !== undefined && body.due_on !== undefined) {
      const scopes = { update: contractScope(access, PERMISSIONS.acknowledgeAdvanceAlert, now), read: contractScope(access, PERMISSIONS.listAdvances, now) };
      const view = await this.advances.find(scope.tx, row.id, scopes.read);
      if (view === undefined || view.acknowledgement !== null) return;
      const done = await this.advances.acknowledge(scope.tx, row.id, view.version, { note: body.reason, planDueOn: body.due_on }, actor, scopes, vietnamDateOf(now));
      await recordAdvanceTrail(scope, done, 'advance.alert_acknowledged', 'pay.advance.alert_acknowledged.v1', now, {
        reason: body.reason.trim(),
        recovery: { action_plan_due_on: body.due_on, last_alert_level: done.view.lastAlertLevel, overdue_since: done.view.overdueSince, via: 'home.work_claimed' },
      });
    }
  }

  /** The audit row and the event of a decision, in the transaction of the command; they name the item and the decision, never the words of the person. */
  private async finish(scope: CommandScope, row: WorkRow, action: WorkActionKind, actionId: string, now: Date, operands: Record<string, unknown>): Promise<CommandResult> {
    const outcome = OUTCOME[action];
    const resourceId = UUID.test(row.id) ? row.id : actionId;
    const facts = { source: row.source, source_id: row.id, severity: row.severity, action_id: actionId, ...operands };
    await scope.audit({ action: outcome.audit, resourceType: RESOURCE_TYPE, resourceId, diff: facts });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: resourceId,
      aggregateVersion: 1,
      type: outcome.event,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts },
      eventKey: `work_action:${actionId}`,
    });
    return commandResult(scope, outcome.status, 1, actionId);
  }
}
