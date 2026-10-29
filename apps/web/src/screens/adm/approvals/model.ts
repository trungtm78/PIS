import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'approval_task.read';
export const OPERATE_PERMISSION = 'adm.workflow.operate';
/** The least a reason has to say, as the contract asks. */
export const REASON_MIN = 10;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** One open approval task as the monitor shows it, with the instance it belongs to (ADM-18). */
export interface MonitorTask {
  id: string;
  version: number;
  instanceId: string;
  instanceVersion: number;
  resourceType: string;
  resourceId: string;
  businessType: string;
  stepName: string;
  amountVnd: string | null;
  assigneeId: string;
  assigneeName: string;
  dueAt: string;
  overdue: boolean;
  escalated: boolean;
  reminders: number;
  workflowRevision: number;
  mayReassign: boolean;
  mayCancel: boolean;
}

export function toTask(raw: unknown, now: number): MonitorTask | undefined {
  const row = record(raw);
  const instance = record(row?.instance);
  const assignee = record(row?.assignee);
  const resource = record(row?.resource);
  const actions = record(row?.actions);
  const id = text(row?.id);
  const dueAt = text(row?.due_at);
  const instanceId = text(instance?.id);
  const assigneeId = text(assignee?.id);
  if (row === undefined || row.status !== 'Pending' || id === undefined || dueAt === undefined || instanceId === undefined || assigneeId === undefined || typeof row.version !== 'number' || typeof instance?.version !== 'number') return undefined;
  return {
    id,
    version: row.version,
    instanceId,
    instanceVersion: instance.version,
    resourceType: text(resource?.type) ?? '',
    resourceId: text(resource?.id) ?? '',
    businessType: text(row.business_type) ?? '',
    stepName: text(row.step_name) ?? text(row.step_id) ?? '',
    amountVnd: text(instance.amount_vnd) ?? null,
    assigneeId,
    assigneeName: text(assignee?.name) ?? '',
    dueAt,
    // The server says it; a payload that does not is judged by the clock.
    overdue: typeof row.overdue === 'boolean' ? row.overdue : Date.parse(dueAt) < now,
    escalated: text(row.escalated_at) !== undefined,
    reminders: typeof row.overdue_reminders === 'number' ? row.overdue_reminders : 0,
    workflowRevision: typeof instance.workflow_revision === 'number' ? instance.workflow_revision : 0,
    mayReassign: actions?.reassign === true,
    mayCancel: actions?.cancel === true,
  };
}

/** The late tasks first, the one that has waited longest at the top; then by deadline. */
export function byUrgency(tasks: readonly MonitorTask[]): MonitorTask[] {
  return [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
}

export interface Filters {
  businessType: string;
  onlyOverdue: boolean;
}

export const NO_FILTER: Filters = { businessType: '', onlyOverdue: false };

export function applyFilters(tasks: readonly MonitorTask[], filters: Filters): MonitorTask[] {
  return tasks.filter((task) => (filters.businessType === '' || task.businessType === filters.businessType) && (!filters.onlyOverdue || task.overdue));
}

export type Problem = 'versionConflict' | 'notAuthorized' | 'selfApproval' | 'alreadyDecided' | 'notRunning' | 'denied' | 'notFound' | 'validation' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'APPROVER_NOT_AUTHORIZED':
      return 'notAuthorized';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'TASK_ALREADY_DECIDED':
      return 'alreadyDecided';
    case 'WORKFLOW_STATE_INVALID':
      return 'notRunning';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    default:
      return 'general';
  }
}
