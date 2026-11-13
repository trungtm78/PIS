import { randomUUID } from 'node:crypto';
import { HomeWorkReminderStore, HomeWorkStore, WORKER_MEMBERSHIP_ID, enqueueOutbox, loadAccessIn, reminderSeriesKey } from '@machvon/db';
import type { TenantDatabase, TenantTx, WorkRow } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { REMINDER_EVENT, WORK_RESOURCE_TYPE } from './work-action-support';
import { pwfTaskReminderPass } from './work-reminder-pwf';
import { canReadScope, workScopes } from './work-scope';

export const WORK_REMINDER_METRIC = 'home_work_reminder_total';
export const WORK_RECLAIM_NOTICE_METRIC = 'home_work_reclaim_notice_total';
/** The most reminders one person gets in one pass: a person with a very long list is reminded of the first of it, and the rest follow on the next passes. */
export const MAX_REMINDERS_PER_MEMBER = 500;
const MEMBER_SAVEPOINT = 'home_work_reminder_member';
const MEMBER_LIMIT = 5000;

export interface WorkReminderDeps {
  metrics?: MetricsSink;
}

export interface WorkReminderResult {
  members: number;
  items: number;
  reminders: number;
  reclaimNotices: number;
  /** The reminders of the points of the deadline rule of the tasks of a workflow, and their own days (PWF-2): they are made by the points, not by the cadence. */
  pointReminders: number;
  /** The pass over the points could not be made; the reminders of the cadence were made and the next pass tries the points again. */
  pointsFailed: boolean;
  /** The people whose list could not be read this pass: they are named by the count, and the next pass tries again. */
  failed: number;
}

/**
 * The job `work-reminder` (G2-4, every 15 minutes) for the tenant of the transaction: for each person who may read the alert centre it reads their list as they see it (the mode `rows`, so the clocks and the cadence of the policy are
 * applied), and for each open item whose reminder is due by the cadence of its severity (in working hours, from its start, its claim, the end of a snooze or a pause, or the last reminder) it records the reminder in
 * `work_reminder` and writes the event `home.work_reminder.v1` in the same transaction. An item that somebody took up and then went silent (the no-progress threshold of the clock policy) is noticed once to the next level
 * (`home.work_reclaim_notice.v1`). A snoozed item, a paused one and one that ran out of reminders is not reminded, and a year without a published calendar invents no reminder. Every reminder is a row with a series key, so the pass run
 * twice, or by two processes, records each once. Who the next level is, and how the reminder reaches a person, belongs to delivery (G2-5, G2-6): the event names the item, the person and the kind, never the words of anyone.
 */
export async function runWorkReminders(database: TenantDatabase, tenant: TenantContext, now: Date, deps: WorkReminderDeps = {}): Promise<WorkReminderResult> {
  return database.withTenant(tenant, (tx) => workReminderPass(tx, tenant, now, deps));
}

export async function workReminderPass(tx: TenantTx, tenant: TenantContext, now: Date, deps: WorkReminderDeps = {}): Promise<WorkReminderResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const work = new HomeWorkStore();
  const reminders = new HomeWorkReminderStore();
  const today = vietnamDateOf(now);
  const result: WorkReminderResult = { members: 0, items: 0, reminders: 0, reclaimNotices: 0, pointReminders: 0, pointsFailed: false, failed: 0 };
  const members = await tx.query<{ id: string }>(
    `select m.id from machvon.membership m where m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz) order by m.id limit ${MEMBER_LIMIT}`,
    [now.toISOString()],
  );
  for (const member of members) {
    const access = await loadAccessIn(tx, member.id);
    // Who may not read the alert centre has no list to be reminded of.
    if (!access.membershipActive || !canReadScope(access, now)) continue;
    result.members += 1;
    // One person's list that cannot be read is rolled back to here and counted; the others are still reminded.
    await tx.query(`savepoint ${MEMBER_SAVEPOINT}`);
    try {
      const collected = await work.collect(tx, { membershipId: member.id, now, today, view: 'mine', mode: 'rows', ...workScopes(access, now) });
      let sent = 0;
      for (const row of collected.rows) {
        result.items += 1;
        if (row.lifecycle === 'RESOLVED' || row.reminders === null) continue;
        const policyVersion = collected.policies?.versions.reminder ?? 'builtin';
        // The tasks of a workflow are reminded at the points of their rule (below), not by the cadence of the severity: the two would remind the same person twice about the same day.
        if (row.reminders.due && row.kind !== 'PWF_TASK_DUE_SOON' && row.kind !== 'PWF_TASK_OVERDUE' && sent < MAX_REMINDERS_PER_MEMBER) {
          const ordinal = row.reminders.sent + 1;
          const recorded = await reminders.record(tx, {
            source: row.source,
            sourceId: row.id,
            kind: 'REMINDER',
            audience: 'OWNER',
            recipient: member.id,
            severity: row.severity,
            ordinal,
            seriesKey: reminderSeriesKey(row.source, row.id, member.id, ordinal),
            dueAt: row.reminders.nextAt === null ? now : new Date(row.reminders.nextAt),
            cadenceWorkingHours: row.reminders.cadenceWorkingHours,
            policyVersion,
          });
          if (recorded.created) {
            sent += 1;
            result.reminders += 1;
            await announce(tx, tenant, row, { id: recorded.id, kind: 'REMINDER', ordinal, recipient: member.id }, now);
            metrics.increment(WORK_REMINDER_METRIC);
          }
        }
        // Taken up and then silent: the next level hears of it once for each claim.
        if (row.clocks?.needsReclaim != null && row.lastClaimAt !== null) {
          const recorded = await reminders.record(tx, {
            source: row.source,
            sourceId: row.id,
            kind: 'RECLAIM_NOTICE',
            audience: 'NEXT_LEVEL',
            recipient: row.claimedBy?.id ?? member.id,
            severity: row.severity,
            ordinal: 1,
            seriesKey: `RECLAIM:${row.source}:${row.id}:${row.lastClaimAt}`.slice(0, 200),
            dueAt: new Date(row.clocks.needsReclaim.since),
            cadenceWorkingHours: null,
            policyVersion: collected.policies?.versions.clock ?? 'builtin',
          });
          if (recorded.created) {
            result.reclaimNotices += 1;
            await announce(tx, tenant, row, { id: recorded.id, kind: 'RECLAIM_NOTICE', ordinal: 1, recipient: row.claimedBy?.id ?? member.id }, now);
            metrics.increment(WORK_RECLAIM_NOTICE_METRIC);
          }
        }
      }
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
    } catch {
      await tx.query(`rollback to savepoint ${MEMBER_SAVEPOINT}`);
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
      result.failed += 1;
    }
  }
  const points = await pwfTaskReminderPass(tx, tenant, now, metrics);
  result.pointReminders = points.reminders;
  result.pointsFailed = points.failed;
  return result;
}

/** The event that carries a reminder or a notice, in the transaction that recorded it. */
async function announce(tx: TenantTx, tenant: TenantContext, row: WorkRow, reminder: { id: string; kind: 'REMINDER' | 'RECLAIM_NOTICE'; ordinal: number; recipient: string }, now: Date): Promise<void> {
  const correlationId = randomUUID();
  await enqueueOutbox(tx, {
    aggregateType: WORK_RESOURCE_TYPE,
    aggregateId: reminder.id,
    aggregateVersion: 1,
    type: REMINDER_EVENT[reminder.kind],
    schemaVersion: 1,
    payload: {
      tenant_id: tenant.tenantId,
      actor_id: WORKER_MEMBERSHIP_ID,
      occurred_at: now.toISOString(),
      reminder_id: reminder.id,
      kind: reminder.kind,
      audience: reminder.kind === 'REMINDER' ? 'OWNER' : 'NEXT_LEVEL',
      source: row.source,
      source_id: row.id,
      severity: row.severity,
      ordinal: reminder.ordinal,
      recipient_membership_id: reminder.recipient,
      due_on: row.dueOn,
    },
    eventKey: `work_reminder:${reminder.id}`,
    correlationId,
  });
}
