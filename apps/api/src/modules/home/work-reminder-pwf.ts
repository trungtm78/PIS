import { randomUUID } from 'node:crypto';
import { HomeWorkReminderStore, PwfTaskReminders, WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { PwfReminderNotice, TenantTx } from '@machvon/db';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { REMINDER_EVENT, WORK_RESOURCE_TYPE } from './work-action-support';

export const PWF_REMINDER_METRIC = 'pwf_task_reminder_total';
export const PROJECT_TASK_SOURCE = 'PROJECT_TASK';
const SAVEPOINT = 'pwf_task_reminders';

export interface PwfReminderResult {
  /** The reminders made for the points of the rule and of people's own days. */
  reminders: number;
  /** The pass could not be made (the others of the job went on); the next pass tries again. */
  failed: boolean;
}

/** The series of one reminder point of one task, version of the schedule and person: a point is reminded once. */
export const pointSeriesKey = (sourceId: string, recipient: string, point: number): string => `REMINDER:${PROJECT_TASK_SOURCE}:${sourceId}:${recipient.toLowerCase()}:D${point}`.slice(0, 200);

/**
 * The multi-point reminders of the tasks of a workflow (BR-PWF-24): the points of the rule `DEADLINE_BAND_POLICY` of the source `PROJECT_TASK` (5, 2, 0 and the day after by default) and the extra days a person asked for. Each point that was crossed
 * is recorded once in `project_task_reminder` and becomes a reminder of the alert centre (`work_reminder`, with the event `home.work_reminder.v1`) in the SAME transaction, so a pass that runs twice, or two that run at once, remind once and a point is never
 * recorded without its reminder. The reminder is delivered by the engine that already holds the profile of the person (channels, quiet hours, the cap of the day); the escalation of a task that stays overdue is the one of the alert centre.
 */
export async function pwfTaskReminderPass(tx: TenantTx, tenant: TenantContext, now: Date, metrics: MetricsSink): Promise<PwfReminderResult> {
  await tx.query(`savepoint ${SAVEPOINT}`);
  try {
    const notices = await new PwfTaskReminders().fire(tx, now);
    const reminders = new HomeWorkReminderStore();
    let made = 0;
    for (const notice of notices) {
      const recorded = await reminders.record(tx, {
        source: PROJECT_TASK_SOURCE,
        sourceId: notice.sourceId,
        kind: 'REMINDER',
        audience: 'OWNER',
        recipient: notice.recipient,
        severity: notice.severity,
        ordinal: notice.ordinal,
        seriesKey: pointSeriesKey(notice.sourceId, notice.recipient, notice.point),
        dueAt: now,
        cadenceWorkingHours: null,
        policyVersion: notice.policyVersion,
      });
      if (!recorded.created) continue;
      made += 1;
      await announce(tx, tenant, notice, recorded.id, now);
      metrics.increment(PWF_REMINDER_METRIC);
    }
    await tx.query(`release savepoint ${SAVEPOINT}`);
    return { reminders: made, failed: false };
  } catch {
    await tx.query(`rollback to savepoint ${SAVEPOINT}`);
    await tx.query(`release savepoint ${SAVEPOINT}`);
    return { reminders: 0, failed: true };
  }
}

/** The event that carries a reminder, in the transaction that recorded it: the item, the person, the point; never the words of anyone. */
async function announce(tx: TenantTx, tenant: TenantContext, notice: PwfReminderNotice, reminderId: string, now: Date): Promise<void> {
  await enqueueOutbox(tx, {
    aggregateType: WORK_RESOURCE_TYPE,
    aggregateId: reminderId,
    aggregateVersion: 1,
    type: REMINDER_EVENT.REMINDER,
    schemaVersion: 1,
    payload: {
      tenant_id: tenant.tenantId,
      actor_id: WORKER_MEMBERSHIP_ID,
      occurred_at: now.toISOString(),
      reminder_id: reminderId,
      kind: 'REMINDER',
      audience: 'OWNER',
      source: PROJECT_TASK_SOURCE,
      source_id: notice.sourceId,
      severity: notice.severity,
      ordinal: notice.ordinal,
      recipient_membership_id: notice.recipient,
      due_on: notice.dueOn,
      point: notice.point,
      remaining_days: notice.remaining,
      reminder_audience: notice.audience,
    },
    eventKey: `work_reminder:${reminderId}`,
    correlationId: randomUUID(),
  });
}
