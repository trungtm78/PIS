import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisWarningStore, PayAdvanceStore, WARNING_RESOURCE, contractScope, projectScope } from '@machvon/db';
import type { WorkRow } from '@machvon/db';
import { DomainError, evaluateSnooze, reasonOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { recordAdvanceTrail } from '../pay/advance.controller';
import { HOME_CLOCK } from './tokens';
import { WorkActionSupport, invalid } from './work-action-support';
import { holdsGrantOf, workScopes } from './work-scope';

/** What the acknowledgement of a warning says when the person who took it up gave no words. */
const DEFAULT_ACK_REASON = 'Đã nhận xử lý từ trung tâm cảnh báo';

/**
 * The three things a person does about an item of the alert centre: take it up (`claimWork`), give it to someone with a day (`assignWork`), put it off (`snoozeWork`). The item has to be in the work the person may see (404
 * WORK_ITEM_GONE otherwise: it was handled, or it is not theirs). Each decision is a row of `work_action` (append-only), with the audit row and the event in the same transaction, under the Idempotency-Key of the command.
 * Taking up an early warning or an advance that is overdue also acknowledges it in DIS or PAY, by the store of that module, in the same transaction, so that the two never disagree. The module's own commands stay.
 *
 * Putting an item off is governed by the SNOOZE_POLICY rule in force (G2-1): a reason from the list (and words for "other"), at most so many days for the severity of the item, never for an urgent one, never past the day the
 * module says the item is due, and at most two in a row (a claim or a handover starts the count again); the last one allowed tells the next level. Taking an item up that somebody already took up is a re-claim and tells the next level.
 */
@Controller()
export class WorkActionController {
  private readonly support = new WorkActionSupport();
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
    if (body.reason_code !== undefined) throw invalid('reason_code');
    if (body.due_on !== undefined && body.source !== 'ADVANCE') throw invalid('due_on');
    const now = this.clock();
    const row = await this.support.find(scope, access, body, now);
    // Somebody already took it up: this is the item taken up again.
    const reclaim = row.claimedBy !== null;
    const recorded = await this.support.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'CLAIM', actor: scope.tenant.membershipId, reason: body.reason });
    // The module that owns the item hears of it in the same transaction.
    await this.acknowledgeInSource(scope, access, row, body, now);
    if (reclaim) {
      const policies = await this.support.policiesAt(scope, now);
      await this.support.notifyNextLevel(scope, row, { kind: 'RECLAIM_NOTICE', ordinal: 1, seriesKey: `RECLAIM_DONE:${recorded.id}`, policyVersion: policies.versions.clock, actionId: recorded.id }, now);
    }
    return this.support.finish(scope, row, 'CLAIM', recorded.id, now, reclaim ? { reclaim: true, previous_claimed_by: row.claimedBy?.id ?? null } : {});
  }

  @Post('home/work-actions/assign')
  @HttpCode(200)
  @OperationId('assignWork')
  @Command({ operation: 'assignWork' })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkActionTarget']): Promise<CommandResult> {
    if (body.snooze_until !== undefined) throw invalid('snooze_until');
    if (body.reason_code !== undefined) throw invalid('reason_code');
    if (body.assignee_id === undefined) throw invalid('assignee_id');
    const now = this.clock();
    const today = vietnamDateOf(now);
    if (body.due_on !== undefined && body.due_on < today) throw invalid('due_on');
    const row = await this.support.find(scope, access, body, now);
    await this.assertAssignee(scope, access, body.assignee_id, now);
    const recorded = await this.support.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'ASSIGN', actor: scope.tenant.membershipId, assignee: body.assignee_id.toLowerCase(), dueOn: body.due_on, reason: body.reason });
    return this.support.finish(scope, row, 'ASSIGN', recorded.id, now, { assignee_id: body.assignee_id.toLowerCase(), due_on: body.due_on ?? null });
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
    const row = await this.support.find(scope, access, body, now);
    const policies = await this.support.policiesAt(scope, now);
    const state = await this.support.stateOf(scope, row, now);
    const verdict = evaluateSnooze(policies.snooze, {
      severity: row.severity,
      now,
      until,
      reasonCode: body.reason_code,
      note: body.reason,
      dueOn: row.dueOn,
      consecutive: state?.consecutiveSnoozes ?? 0,
    });
    if (!verdict.ok) throw new DomainError(verdict.code, 422, verdict.field);
    const recorded = await this.support.actions.record(scope.tx, {
      source: row.source,
      sourceId: row.id,
      action: 'SNOOZE',
      actor: scope.tenant.membershipId,
      snoozeUntil: until.toISOString(),
      reason: body.reason,
      reasonCode: body.reason_code,
      snoozeOrdinal: verdict.ordinal,
      snoozeFinal: verdict.final,
      policyVersion: policies.versions.snooze,
    });
    // The last snooze that is allowed tells the next level: the item will not wait again.
    if (verdict.final && policies.snooze.final_notifies_next_level) {
      await this.support.notifyNextLevel(scope, row, { kind: 'SNOOZE_FINAL_NOTICE', ordinal: verdict.ordinal, seriesKey: `SNOOZE_FINAL:${recorded.id}`, policyVersion: policies.versions.snooze, actionId: recorded.id }, now);
    }
    return this.support.finish(scope, row, 'SNOOZE', recorded.id, now, {
      snooze_until: until.toISOString(),
      reason_code: body.reason_code,
      reason_length: body.reason === undefined ? 0 : body.reason.trim().length,
      snooze_ordinal: verdict.ordinal,
      snooze_of: policies.snooze.max_consecutive,
      snooze_final: verdict.final,
      policy_version: policies.versions.snooze,
    });
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
}
