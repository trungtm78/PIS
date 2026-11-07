import { ApiError } from '@machvon/api-client';

/** The permission that decides an approval task; the server judges it again, and asks for a fresh second factor for it. */
export const DECIDE_PERMISSION = 'approval.decide';
export const READ_PERMISSION = 'approval_task.read';
/** The most characters of the comment the server keeps (the same limit as the phone). */
export const COMMENT_MAX = 2000;
/** Business types of the period data: the screen offers them as the first filter. */
export const PERIOD_TYPES: readonly string[] = ['report.accept', 'period.reopen'];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** One approval task waiting for the person (`get_resources_approval_task` with `mine=true`), as the manager queue shows it. */
export interface ApprovalTask {
  id: string;
  /** The version the screen saw: the decision is sent under it (`If-Match`), so a task that moved in the meantime is a conflict. */
  version: number;
  businessType: string;
  resourceType: string;
  resourceId: string;
  stepName: string;
  /** Integer VND as a decimal string, or null when the record has no amount. */
  amountVnd: string | null;
  unitId: string | null;
  dueAt: string;
  /** The server's word, not the clock of the phone. */
  overdue: boolean;
  escalated: boolean;
  /** The server says the person may decide this task. */
  canDecide: boolean;
}

export function toApprovalTask(raw: unknown): ApprovalTask | undefined {
  const row = record(raw);
  const instance = record(row?.instance);
  const resource = record(row?.resource);
  const actions = record(row?.actions);
  const id = text(row?.id);
  const dueAt = text(row?.due_at);
  if (row === undefined || row.status !== 'Pending' || id === undefined || dueAt === undefined || typeof row.version !== 'number') return undefined;
  const amount = instance?.amount_vnd;
  return {
    id,
    version: row.version,
    businessType: text(row.business_type) ?? '',
    resourceType: text(resource?.type) ?? '',
    resourceId: text(resource?.id) ?? '',
    stepName: text(row.step_name) ?? text(row.step_id) ?? '',
    amountVnd: typeof amount === 'string' && /^\d+$/.test(amount) ? amount : null,
    unitId: text(instance?.unit_id) ?? null,
    dueAt,
    overdue: row.overdue === true,
    escalated: text(row.escalated_at) !== undefined,
    canDecide: actions?.decide === true,
  };
}

/** The late tasks first, then by deadline, then by id (stable). */
export function byUrgency(tasks: readonly ApprovalTask[]): ApprovalTask[] {
  return [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
}

export interface QueueFilter {
  /** `''` all, `period` the period data types, or one business type code. */
  kind: string;
  onlyOverdue: boolean;
}

export const NO_FILTER: QueueFilter = { kind: '', onlyOverdue: false };
export const PERIOD_FILTER = 'period';

export function applyFilter(tasks: readonly ApprovalTask[], filter: QueueFilter): ApprovalTask[] {
  return tasks.filter((task) => {
    const kindMatches = filter.kind === '' || (filter.kind === PERIOD_FILTER ? PERIOD_TYPES.includes(task.businessType) : task.businessType === filter.kind);
    return kindMatches && (!filter.onlyOverdue || task.overdue);
  });
}

/** What the person decides on a task: approve it, or return it for correction. */
export type Decision = 'approve' | 'return';

export type CommentProblem = 'required' | 'tooLong';

/** A return says why (the comment is required); an approval may carry an opinion. Neither is longer than the server keeps. The server judges the same again. */
export function checkComment(decision: Decision, comment: string): CommentProblem | undefined {
  const trimmed = comment.trim();
  if (decision === 'return' && trimmed === '') return 'required';
  return trimmed.length > COMMENT_MAX ? 'tooLong' : undefined;
}

/** The body of the decision command: the decision and the comment (absent when empty). */
export function decisionBody(decision: Decision, comment: string): { decision: Decision; reason?: string } {
  const trimmed = comment.trim();
  return trimmed === '' ? { decision } : { decision, reason: trimmed };
}

export type Problem =
  | 'selfApproval'
  | 'stepUp'
  | 'notAuthorized'
  | 'alreadyDecided'
  | 'versionConflict'
  | 'notRunning'
  | 'periodLocked'
  | 'licenseExpired'
  | 'denied'
  | 'notFound'
  | 'validation'
  | 'sessionEnded'
  | 'general';

/** What a refusal of the decision means to the person; the codes are the stable ones of the contract. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'MFA_REQUIRED':
      return 'stepUp';
    case 'APPROVER_NOT_AUTHORIZED':
      return 'notAuthorized';
    case 'TASK_ALREADY_DECIDED':
      return 'alreadyDecided';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'WORKFLOW_STATE_INVALID':
      return 'notRunning';
    case 'PERIOD_LOCKED':
      return 'periodLocked';
    case 'LICENSE_EXPIRED':
      return 'licenseExpired';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'SESSION_EXPIRED':
      return 'sessionEnded';
    default:
      return 'general';
  }
}

/** Problems after which the task on the screen is out of date and is read again: the person compares with the new state and decides again. */
export const REFRESH_PROBLEMS: readonly Problem[] = ['versionConflict', 'alreadyDecided', 'notRunning', 'notFound'];

/** A decision can be made on a task the server says the person may decide, in a session that may change things. */
export function mayDecide(task: ApprovalTask, sessionReadOnly: boolean): boolean {
  return task.canDecide && !sessionReadOnly;
}
