import { PERMISSIONS } from '@machvon/contracts';
import { projectInScope, projectScope } from '@machvon/db';
import type { PwfCan, TenantTx } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';

export const WORKFLOW_RESOURCE = 'project_workflow';
export const TASK_RESOURCE = 'project_task';
export const PROPOSAL_RESOURCE = 'project_reschedule_proposal';
export const CLASSIFICATION = 'INTERNAL';
export const READ_PERMISSION = PERMISSIONS.getProjectWorkflow;

/** The scopes a command is judged by: the one of its own permission decides, the one of `pwf.read` tells a refusal from a miss. */
export const scopesOf = (access: EffectiveAccess, permission: string, now: Date): { act: ReturnType<typeof projectScope>; read: ReturnType<typeof projectScope> } => ({
  act: projectScope(access, permission, now),
  read: projectScope(access, READ_PERMISSION, now),
});

/** What the caller may do on a project, from the permissions it holds over that project (the buttons of the screens). */
export async function canOf(tx: TenantTx, access: EffectiveAccess, projectId: string, now: Date): Promise<PwfCan> {
  const holds = (permission: string): Promise<boolean> => projectInScope(tx, projectId, projectScope(access, permission, now));
  const [manage, proposeReschedule, work, approve, assign] = await Promise.all([
    holds(PERMISSIONS.startProjectWorkflow),
    holds(PERMISSIONS.proposeProjectReschedule),
    holds(PERMISSIONS.startProjectTask),
    holds(PERMISSIONS.approveProjectTaskCompletion),
    holds(PERMISSIONS.assignProjectTask),
  ]);
  return { manage, proposeReschedule, work, approve, assign };
}

/** The identifier as the lower-case text the database writes; anything else is 422 naming the field. */
export function idOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
}

export function queryText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/** Writes the audit row and the event of one command on the workflow: ids, codes, days and statuses only, never words of people. */
export async function announce(
  scope: CommandScope,
  entry: { resource: string; id: string; version: number; action: string; type: string; facts: Record<string, unknown>; fromStatus: string | null; status: string; reason?: string },
  now: Date,
): Promise<void> {
  await scope.audit({
    action: entry.action,
    resourceType: entry.resource,
    resourceId: entry.id,
    classification: CLASSIFICATION,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    diff: { from_status: entry.fromStatus, to_status: entry.status, ...entry.facts },
  });
  await scope.emit({
    aggregateType: entry.resource,
    aggregateId: entry.id,
    aggregateVersion: entry.version,
    type: entry.type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, id: entry.id, ...entry.facts, status: entry.status, from_status: entry.fromStatus, version: entry.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${entry.resource}:${entry.id}:${entry.version}:${entry.type}`,
  });
}
