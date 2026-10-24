import type { RaisedEscalation } from './iss-escalation-store.ts';

/** The event that tells the receiving unit or task force, and HOME and BI, that an issue was escalated (ISS 9). */
export const ISSUE_ESCALATED_EVENT = 'iss.issue.escalated.v1';

/**
 * The payload of `iss.issue.escalated.v1` for the escalation that a command or the job raised: ids, the state, the level and the dates, never the title or the
 * description of the issue. The `notification` member says what the notification is about and names the receiving people (docs/notification-event-types.md); the
 * tenant workflow decides who is told and how.
 */
export function escalatedPayload(tenantId: string, raised: RaisedEscalation, actor: string, now: Date): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    issue_id: raised.id,
    code: raised.code,
    project_id: raised.projectId,
    owner_unit_id: raised.ownerUnitId,
    severity: raised.severity,
    status: raised.status,
    assignee_id: raised.assigneeId,
    escalation_level: raised.escalationLevel,
    due_at: raised.dueAt,
    version: raised.version,
    actor_id: actor,
    occurred_at: now.toISOString(),
    escalation_id: raised.escalationId,
    level: raised.level,
    trigger: raised.trigger,
    target_unit_id: raised.targetUnitId,
    task_force_id: raised.taskForceId,
    accept_due_at: raised.acceptDueAt,
    notification: {
      resource: { type: 'issue', id: raised.id, ownerUnitId: raised.ownerUnitId, ownerUnitPath: raised.ownerUnitPath, projectId: raised.projectId },
      deepLink: `/iss/iss-03?id=${raised.id}`,
      recipients: raised.recipients,
    },
  };
}

/** The key of the event of one escalation: an escalation is announced once, whoever raised it. */
export const escalatedEventKey = (raised: Pick<RaisedEscalation, 'id' | 'escalationId'>): string => `issue:${raised.id}:escalation:${raised.escalationId}`;
