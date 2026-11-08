import { AlertCoverStore, HomeWorkActionStore, HomeWorkReminderStore, HomeWorkStore, WorkPolicyReader, actionKey, policyVersionOf } from '@machvon/db';
import type { ReminderRecord, WorkActionKind, WorkActionState, WorkPolicies, WorkRow, WorkSource } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ReminderKind } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { coveredWork } from './alert-cover-view';
import { canReadScope, workScopes } from './work-scope';

export const WORK_RESOURCE_TYPE = 'work_item';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What each decision answers, the audit action and the event it writes. */
export const WORK_OUTCOME: Readonly<Record<WorkActionKind, { status: string; audit: string; event: string }>> = {
  CLAIM: { status: 'CLAIMED', audit: 'home.work_claimed', event: 'home.work_claimed.v1' },
  ASSIGN: { status: 'ASSIGNED', audit: 'home.work_assigned', event: 'home.work_assigned.v1' },
  SNOOZE: { status: 'SNOOZED', audit: 'home.work_snoozed', event: 'home.work_snoozed.v1' },
  PAUSE_CLOCK: { status: 'PAUSED', audit: 'home.work_clock_paused', event: 'home.work_clock_paused.v1' },
  RESUME_CLOCK: { status: 'RESUMED', audit: 'home.work_clock_resumed', event: 'home.work_clock_resumed.v1' },
};

/** The event a notice or a reminder is carried by. */
export const REMINDER_EVENT: Readonly<Record<ReminderKind, string>> = {
  REMINDER: 'home.work_reminder.v1',
  RECLAIM_NOTICE: 'home.work_reclaim_notice.v1',
  SNOOZE_FINAL_NOTICE: 'home.work_snooze_final.v1',
};

/**
 * What the commands of the alert centre share: finding the item as the person sees it, the policies in force, the state people left on the item, the audit row and the event of a decision, and the notice to the next level.
 * The words of a person (a note, a reason) are never in an audit row or an event: they are in `work_action`, where the scope of the reader decides who sees them.
 */
export class WorkActionSupport {
  readonly work = new HomeWorkStore();
  readonly actions = new HomeWorkActionStore();
  readonly reminders = new HomeWorkReminderStore();
  readonly policies = new WorkPolicyReader();

  /** The item, as the person sees it now: in the work given to them, or in the scope they may read (404 WORK_ITEM_GONE when it is in neither). */
  async find(scope: CommandScope, access: EffectiveAccess, target: { source: string; source_id: string }, now: Date): Promise<WorkRow> {
    const today = vietnamDateOf(now);
    const source = target.source as WorkSource;
    const unavailable = new Set<string>();
    for (const view of canReadScope(access, now) ? (['mine', 'scope'] as const) : (['mine'] as const)) {
      const collected = await this.work.collect(scope.tx, { membershipId: scope.tenant.membershipId, now, today, view, mode: 'count', includeHidden: true, ...workScopes(access, now) });
      const row = collected.rows.find((candidate) => candidate.source === source && candidate.id === target.source_id);
      if (row !== undefined) return row;
      for (const name of collected.unavailableSources) unavailable.add(name);
    }
    // G2-7: an item of a person the reader stands in for is theirs to take up, put off or hand over while the cover is in force.
    const scopes = workScopes(access, now);
    const covers = new AlertCoverStore();
    const covered = await coveredWork(scope.tx, this.work, { deputyId: scope.tenant.membershipId, now, today, edges: await covers.liveEdges(scope.tx, now), spans: await covers.absenceSpans(scope.tx, now), unitScope: scopes.unitScope, projectScope: scopes.projectScope, holds: scopes.holds, mode: 'count' });
    const standing = covered.rows.find((candidate) => candidate.source === source && candidate.id === target.source_id);
    if (standing !== undefined) return standing;
    // A source that could not be read does not say the item is gone.
    if (unavailable.has(source)) throw new DomainError('PROVIDER_UNAVAILABLE', 503, source);
    throw new DomainError('WORK_ITEM_GONE', 404, 'source_id');
  }

  /** The policies in force on the day of `now` (G0-1): the approved rule or the default of the platform, with the version that decided. */
  policiesAt(scope: CommandScope, now: Date): Promise<WorkPolicies> {
    return this.policies.read(scope.tx, vietnamDateOf(now));
  }

  /** What people decided about the item so far, as the reader sees it. */
  async stateOf(scope: CommandScope, row: WorkRow, now: Date): Promise<WorkActionState | undefined> {
    const states = await this.actions.stateOf(scope.tx, [{ source: row.source, sourceId: row.id }], scope.tenant.membershipId, now);
    return states.get(actionKey(row.source, row.id));
  }

  /** The audit row and the event of a decision, in the transaction of the command; they name the item and the decision, never the words of the person. */
  async finish(scope: CommandScope, row: WorkRow, action: WorkActionKind, actionId: string, now: Date, operands: Record<string, unknown>): Promise<CommandResult> {
    const outcome = WORK_OUTCOME[action];
    const resourceId = UUID.test(row.id) ? row.id : actionId;
    const facts = { source: row.source, source_id: row.id, severity: row.severity, action_id: actionId, ...operands };
    await scope.audit({ action: outcome.audit, resourceType: WORK_RESOURCE_TYPE, resourceId, diff: facts });
    await scope.emit({
      aggregateType: WORK_RESOURCE_TYPE,
      aggregateId: resourceId,
      aggregateVersion: 1,
      type: outcome.event,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts },
      eventKey: `work_action:${actionId}`,
    });
    return commandResult(scope, outcome.status, 1, actionId);
  }

  /**
   * A notice to the next level (the last snooze that is allowed, an item taken up again): one row of `work_reminder` and the event that carries it, written in the transaction of the command. The series key makes a replay write it
   * once. Who the next level is belongs to delivery (lane G2-5/G2-6): the event names the item, the person and the kind.
   */
  async notifyNextLevel(scope: CommandScope, row: WorkRow, input: Pick<ReminderRecord, 'kind' | 'ordinal' | 'seriesKey' | 'policyVersion' | 'actionId'>, now: Date): Promise<void> {
    const recorded = await this.reminders.record(scope.tx, {
      source: row.source,
      sourceId: row.id,
      kind: input.kind,
      audience: 'NEXT_LEVEL',
      recipient: scope.tenant.membershipId,
      severity: row.severity,
      ordinal: input.ordinal,
      seriesKey: input.seriesKey,
      dueAt: now,
      cadenceWorkingHours: null,
      policyVersion: input.policyVersion,
      actionId: input.actionId,
    });
    if (!recorded.created) return;
    await scope.emit({
      aggregateType: WORK_RESOURCE_TYPE,
      aggregateId: UUID.test(row.id) ? row.id : recorded.id,
      aggregateVersion: 1,
      type: REMINDER_EVENT[input.kind],
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        reminder_id: recorded.id,
        kind: input.kind,
        audience: 'NEXT_LEVEL',
        source: row.source,
        source_id: row.id,
        severity: row.severity,
        about_membership_id: scope.tenant.membershipId,
        action_id: input.actionId ?? null,
      },
      eventKey: `work_reminder:${recorded.id}`,
    });
  }
}

export const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The body of a command that names an item and nothing about the clocks. */
export type WorkTarget = Pick<Schemas['WorkActionTarget'], 'source' | 'source_id'>;
export { policyVersionOf };
