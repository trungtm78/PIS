import { FIGURE_RESOURCE } from '@machvon/db';
import type { AuditEntry, FigureResult, OutboxEventInput } from '@machvon/db';

const CLASSIFICATION = 'CONFIDENTIAL';

/** What a figure command writes beside the state: the command scope gives it, and so does the approval engine when its last step accepts the batch. */
export interface FigureTrailEffects {
  actor: string;
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<unknown>;
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<unknown>;
}

/**
 * The audit row and the event of a figure command: ids, codes, counts and statuses, never an amount and never the name of a person; the reason goes to the audit row only (ADM-11). The command of a person and the final
 * command of the staged approval write the same trail, so a batch accepted by the steps leaves the rows an acceptance by one decision leaves.
 */
export async function writeFigureTrail(effects: FigureTrailEffects, tenantId: string, done: FigureResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
  const facts = { project_id: done.projectId, project_code: done.projectCode, class_code: done.classCode, tier_code: done.tierCode, measure: done.measure, figure_kind: done.kind, period_grain: done.grain, plan_year: done.planYear, figure_count: done.count, conversions: done.conversions };
  await effects.audit({
    action,
    resourceType: FIGURE_RESOURCE,
    resourceId: done.batchId,
    classification: CLASSIFICATION,
    ...(reason === undefined ? {} : { reason }),
    diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
  });
  await effects.emit({
    aggregateType: FIGURE_RESOURCE,
    aggregateId: done.batchId,
    aggregateVersion: done.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: tenantId, batch_id: done.batchId, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: effects.actor, occurred_at: now.toISOString() },
    eventKey: `${FIGURE_RESOURCE}:${done.batchId}:${done.version}:${type}`,
  });
}
