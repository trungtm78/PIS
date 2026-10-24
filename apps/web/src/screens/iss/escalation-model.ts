import { ESCALATION_LEVELS, toTaskForce } from './issue-model';
import type { EscalationLevel, EscalationStatus, IssueStatus, PersonView, TaskForceView } from './issue-model';
import type { Severity } from './model';
import { SEVERITIES } from './model';

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => text(value) ?? null;
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find((candidate) => candidate === value);

const ISSUE_STATUSES: readonly IssueStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'];
const BOARD_STATUSES: readonly EscalationStatus[] = ['OPEN', 'ACCEPTED', 'RESOLVED', 'CANCELLED'];

/** A line of the board of ISS-10: an escalation with the issue it is about. */
export interface BreachView {
  escalationId: string;
  issueId: string;
  issueCode: string;
  /** Null for a guest contractor. */
  issueTitle: string | null;
  issueStatus: IssueStatus;
  severity: Severity;
  projectCode: string;
  ownerUnitName: string;
  level: EscalationLevel;
  trigger: 'SLA_AUTO' | 'MANUAL';
  targetUnit: { id: string; name: string } | null;
  taskForce: TaskForceView | null;
  /** The moment by which the receiver has to accept. */
  acceptDueAt: string;
  status: EscalationStatus;
  acceptedBy: PersonView | null;
  acceptedAt: string | null;
  overdueSince: string | null;
  overdueDays: number | null;
  /** The signed-in person may accept it now. */
  acceptable: boolean;
}

export function toBreach(raw: unknown): BreachView | undefined {
  const row = asRecord(raw);
  const escalationId = text(row?.escalation_id);
  const issueId = text(row?.issue_id);
  const issueCode = text(row?.issue_code);
  const issueStatus = oneOf(row?.issue_status, ISSUE_STATUSES);
  const severity = oneOf(row?.severity, SEVERITIES);
  const level = oneOf(row?.level, ESCALATION_LEVELS);
  const status = oneOf(row?.status, BOARD_STATUSES);
  const acceptDueAt = text(row?.accept_due_at);
  if (row === undefined || escalationId === undefined || issueId === undefined || issueCode === undefined || issueStatus === undefined || severity === undefined || level === undefined || status === undefined || acceptDueAt === undefined) {
    return undefined;
  }
  const unit = asRecord(row.target_unit);
  const unitId = text(unit?.id);
  const accepted = asRecord(row.accepted_by);
  const acceptedId = text(accepted?.membership_id);
  return {
    escalationId,
    issueId,
    issueCode,
    issueTitle: nullableText(row.issue_title),
    issueStatus,
    severity,
    projectCode: text(row.project_code) ?? '',
    ownerUnitName: text(row.owner_unit_name) ?? '',
    level,
    trigger: row.trigger === 'MANUAL' ? 'MANUAL' : 'SLA_AUTO',
    targetUnit: unitId === undefined ? null : { id: unitId, name: text(unit?.name) ?? '' },
    taskForce: toTaskForce(row.task_force),
    acceptDueAt,
    status,
    acceptedBy: acceptedId === undefined ? null : { id: acceptedId, name: '' },
    acceptedAt: nullableText(row.accepted_at),
    overdueSince: nullableText(row.overdue_since),
    overdueDays: whole(row.overdue_days) ?? null,
    acceptable: row.acceptable === true,
  };
}

export type AcceptState = 'accepted' | 'late' | 'waiting';

/** Where an escalation stands against the time its receiver has to accept it: said in words, never by colour alone. */
export function acceptStateOf(line: Pick<BreachView, 'status' | 'acceptDueAt'>, now: Date): AcceptState {
  if (line.status !== 'OPEN') return 'accepted';
  return Date.parse(line.acceptDueAt) < now.getTime() ? 'late' : 'waiting';
}

export type LevelFilter = '' | `${EscalationLevel}`;

/** The lines of the board at one level, or all of them; the server filters too, this keeps a board already read right when the person narrows it. */
export function filterBreaches(lines: readonly BreachView[], level: LevelFilter): BreachView[] {
  return level === '' ? [...lines] : lines.filter((line) => String(line.level) === level);
}

/** The count of lines by level, for the heading of the filter. */
export function countByLevel(lines: readonly BreachView[]): Record<EscalationLevel, number> {
  const counts: Record<EscalationLevel, number> = { 1: 0, 2: 0, 3: 0 };
  for (const line of lines) counts[line.level] += 1;
  return counts;
}

/** The levels the person may raise an issue to by hand: above the one it has reached, and the task force only when one answers for it. */
export function offeredLevels(reached: number, taskForce: TaskForceView | null): EscalationLevel[] {
  return ESCALATION_LEVELS.filter((level) => level > reached && (level < 3 || taskForce !== null));
}
