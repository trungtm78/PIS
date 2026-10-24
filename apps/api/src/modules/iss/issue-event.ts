import type { IssueHeader } from '@machvon/db';
import type { CommandScope } from '../../command-scope';

/** What every event of an issue carries to NOT, HOME and BI: ids, the state and the dates, never the text or the position (ISS 9). */
export function issueEventPayload(scope: Pick<CommandScope, 'tenant'>, issue: IssueHeader, now: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: scope.tenant.tenantId,
    issue_id: issue.id,
    code: issue.code,
    project_id: issue.projectId,
    owner_unit_id: issue.ownerUnitId,
    severity: issue.severity,
    status: issue.status,
    assignee_id: issue.assigneeId,
    escalation_level: issue.escalationLevel,
    due_at: issue.dueAt,
    version: issue.version,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
    ...extra,
  };
}
