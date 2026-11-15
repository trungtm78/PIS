import { rescheduleLink, taskLink } from '../../screens/pwf/model';
import { lineLink } from '../../screens/pwf/score/model';
import { toRecordSummary } from './approval-model';
import type { RecordSummary } from './approval-model';

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export type PendingChoice = 'approve' | 'return' | 'reject';

/** The commands of the modules the inbox knows how to send. An item whose command is not one of these is shown and opened on its own screen, never decided blind. */
export const PENDING_OPERATIONS = ['approveProjectTaskCompletion', 'returnProjectTask', 'decideProjectTaskException', 'decideProjectReschedule', 'decideStaffScoreAdjustment'] as const;
export type PendingOperation = (typeof PENDING_OPERATIONS)[number];

export interface PendingAction {
  decision: PendingChoice;
  operationId: PendingOperation;
  reasonRequired: boolean;
  reasonMin: number;
  reasonMax: number;
}

/** A record of a module that waits for the person outside the approval engine (`PendingDecision` of the contract, PWF 20.9). */
export interface PendingDecision {
  id: string;
  kind: string;
  resourceId: string;
  /** The version the command of the decision is sent under (`If-Match`). */
  version: number;
  submittedAt: string;
  initiatorName: string | undefined;
  dueAt: string | null;
  overdue: boolean;
  summary: RecordSummary;
  target: { screen: string; id: string } | undefined;
  actions: PendingAction[];
}

function toAction(raw: unknown): PendingAction | undefined {
  const row = record(raw);
  const decision = row?.decision;
  const operationId = PENDING_OPERATIONS.find((known) => known === row?.operation_id);
  if (row === undefined || operationId === undefined || (decision !== 'approve' && decision !== 'return' && decision !== 'reject')) return undefined;
  return { decision, operationId, reasonRequired: row.reason_required === true, reasonMin: typeof row.reason_min === 'number' ? row.reason_min : 0, reasonMax: typeof row.reason_max === 'number' ? row.reason_max : 500 };
}

export function toPendingDecision(raw: unknown): PendingDecision | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const kind = text(row?.kind);
  const resourceId = text(record(row?.resource)?.id);
  const submittedAt = text(row?.submitted_at);
  const summary = toRecordSummary(row?.summary);
  if (row === undefined || id === undefined || kind === undefined || resourceId === undefined || submittedAt === undefined || summary === undefined || typeof row.version !== 'number') return undefined;
  const target = record(record(row.summary)?.target);
  const screen = text(target?.screen);
  const targetId = text(target?.id);
  return {
    id,
    kind,
    resourceId,
    version: row.version,
    submittedAt,
    initiatorName: text(record(row.initiator)?.name),
    dueAt: text(row.due_at) ?? null,
    overdue: row.overdue === true,
    summary,
    target: screen === undefined || targetId === undefined ? undefined : { screen, id: targetId },
    actions: (Array.isArray(row.actions) ? row.actions : []).flatMap((one) => toAction(one) ?? []),
  };
}

/** The kinds the screen has a name for; any other kind is named by the general word. */
export const PENDING_KIND_KEYS: Readonly<Record<string, string>> = { 'pwf.task.completion': 'completion', 'pwf.task.exception': 'exception', 'pwf.reschedule': 'reschedule', 'pwf.score.adjustment': 'adjustment' };

/** The screen of the module the record is decided on in full (the task, the proposal of a schedule, the line of the score). */
export function pendingLink(item: PendingDecision): string | undefined {
  if (item.target === undefined) return undefined;
  if (item.target.screen === 'PWF-04') return taskLink(item.target.id);
  if (item.target.screen === 'PWF-06') return rescheduleLink(item.target.id, item.resourceId);
  if (item.target.screen === 'PWF-13') return lineLink(item.target.id);
  return undefined;
}

export type PendingCommentProblem = 'required' | 'tooShort' | 'tooLong';

/** The words of a decision as the command keeps them: required for a return, never shorter than the command accepts once given, never longer. */
export function checkPendingComment(action: PendingAction, comment: string): PendingCommentProblem | undefined {
  const trimmed = comment.trim();
  if (trimmed === '') return action.reasonRequired ? 'required' : undefined;
  if (trimmed.length < action.reasonMin) return 'tooShort';
  return trimmed.length > action.reasonMax ? 'tooLong' : undefined;
}

/** The request of the command an action names: its path, its body in the words of that command, and the version. */
export function pendingCommand(item: PendingDecision, action: PendingAction, comment: string): { operationId: PendingOperation; path: Record<string, string>; body: Record<string, string> } {
  const words = comment.trim();
  const note: Record<string, string> = words === '' ? {} : { note: words };
  switch (action.operationId) {
    case 'approveProjectTaskCompletion':
      return { operationId: action.operationId, path: { task_id: item.resourceId }, body: { decision: 'APPROVE', ...note } };
    case 'returnProjectTask':
      return { operationId: action.operationId, path: { task_id: item.resourceId }, body: { reason: words } };
    default:
      return { operationId: action.operationId, path: { id: item.resourceId }, body: { decision: action.decision === 'approve' ? 'APPROVE' : 'REJECT', ...note } };
  }
}
