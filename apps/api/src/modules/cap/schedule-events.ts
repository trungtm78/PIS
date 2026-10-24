import type { OutboxEventInput, ScheduleRegistered } from '@machvon/db';

export const SCHEDULE_REGISTERED_EVENT = 'capital.schedule_registered.v1';

/**
 * The event `capital.schedule_registered.v1` (CAP 3.1 section 9): a project registered, forecast or committed an amount for a month or a week.
 * The disbursement reports compare it with the Treasury's payments; it is a promise, and nothing reads it as money paid.
 */
export function scheduleRegisteredEvent(tenantId: string, actorId: string, created: ScheduleRegistered, occurredAt: Date): Omit<OutboxEventInput, 'correlationId'> {
  return {
    aggregateType: 'disbursement_schedule_line',
    aggregateId: created.id,
    aggregateVersion: created.version,
    type: SCHEDULE_REGISTERED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      schedule_line_id: created.id,
      version: created.version,
      actor_id: actorId,
      occurred_at: occurredAt.toISOString(),
      project_id: created.projectId,
      plan_year: created.planYear,
      granularity: created.granularity,
      month: created.month,
      period_id: created.periodId,
      kind: created.kind,
      bucket: created.bucket,
      budget_level: created.budgetLevel,
      amount_vnd: created.amountVnd,
      ctmtqg_subset_vnd: created.ctmtqgSubsetVnd,
      revision: created.revision,
      supersedes_id: created.supersedesId,
    },
    eventKey: `disbursement_schedule_line:${created.id}:registered:${created.version}`,
  };
}
