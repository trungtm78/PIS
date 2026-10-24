import { EXTENSION_PATH, ISSUE_CLOSE_PERMISSION, ISSUE_ESCALATE_PERMISSION, ISSUE_EXTEND_PERMISSION, ISSUE_REOPEN_PERMISSION, ISSUE_WORK_PERMISSION, VERIFICATION_PATH, hasPermission } from './issue-model';
import type { IssueEventView, IssueView } from './issue-model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** The contract allows 20 documents in one request for verification; the screen says so before the server does. */
export const MAX_EVIDENCE = 20;
/** Vietnam time, the zone in which the business reads a deadline (UTC+7, no daylight saving). */
const BUSINESS_OFFSET = '+07:00';
const LOCAL_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The address of a screen of the closure, for the issue. */
export const verificationLink = (issueId: string): string => `${VERIFICATION_PATH}?id=${issueId}`;
export const extensionLink = (issueId: string): string => `${EXTENSION_PATH}?id=${issueId}`;

export interface ClosureRights {
  work: boolean;
  close: boolean;
  reopen: boolean;
  extend: boolean;
  escalate: boolean;
}

export function closureRightsOf(permissions: readonly string[] | undefined, live: boolean): ClosureRights {
  return {
    work: hasPermission(permissions, ISSUE_WORK_PERMISSION) && live,
    close: hasPermission(permissions, ISSUE_CLOSE_PERMISSION) && live,
    reopen: hasPermission(permissions, ISSUE_REOPEN_PERMISSION) && live,
    extend: hasPermission(permissions, ISSUE_EXTEND_PERMISSION) && live,
    escalate: hasPermission(permissions, ISSUE_ESCALATE_PERMISSION) && live,
  };
}

export interface ClosureActions {
  /** The handler declares the work done. */
  request: boolean;
  /** A person other than the handler confirms the result and closes the issue. */
  close: boolean;
  /** The closed issue is opened again (the server judges the window). */
  reopen: boolean;
  /** The deadline is extended by a person other than the handler. */
  extend: boolean;
  /** The issue is raised to a unit or to the task force by hand (an assigned or working issue: the machine has no other edge to ESCALATED). */
  escalate: boolean;
}

/**
 * What the signed-in person may do about the end of an issue in its state, the server deciding again. The person who handles the issue is offered
 * to ask for the verification and never to close or extend it: the independence is shown, not hidden (BR-ISS-05).
 */
export function closureActionsOf(issue: Pick<IssueView, 'status' | 'assignee'>, rights: ClosureRights, membershipId: string | undefined): ClosureActions {
  const handler = membershipId !== undefined && issue.assignee?.id === membershipId;
  return {
    request: rights.work && issue.status === 'IN_PROGRESS' && handler,
    close: rights.close && issue.status === 'PENDING_VERIFICATION' && !handler,
    reopen: rights.reopen && issue.status === 'CLOSED',
    extend: rights.extend && issue.status !== 'CLOSED' && issue.status !== 'PENDING_VERIFICATION' && !handler,
    escalate: rights.escalate && (issue.status === 'ASSIGNED' || issue.status === 'IN_PROGRESS'),
  };
}

/** The latest request for verification of the timeline: what the handler said and the documents they named. */
export function lastVerificationRequest(events: readonly IssueEventView[]): IssueEventView | undefined {
  return [...events].reverse().find((event) => event.kind === 'VERIFICATION_REQUESTED');
}

export type EvidenceProblem = 'invalid' | 'tooMany' | 'required';

export interface ParsedEvidence {
  ids: string[];
  problem: EvidenceProblem | undefined;
}

/** The documents typed one per line (the contract has no upload of a document for an issue yet): each a document version id, once. */
export function parseEvidence(input: string, required: boolean): ParsedEvidence {
  const ids = input
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (ids.some((value) => !UUID.test(value))) return { ids: [], problem: 'invalid' };
  const unique = [...new Set(ids.map((value) => value.toLowerCase()))];
  if (unique.length > MAX_EVIDENCE) return { ids: unique, problem: 'tooMany' };
  if (required && unique.length === 0) return { ids: unique, problem: 'required' };
  return { ids: unique, problem: undefined };
}

/** A moment typed in a `datetime-local` field, read as Vietnam time; undefined when it is not a moment. */
export function businessMomentToIso(value: string): string | undefined {
  if (!LOCAL_MOMENT.test(value)) return undefined;
  const date = new Date(`${value}:00${BUSINESS_OFFSET}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export type ExtensionProblem = 'required' | 'notLater' | 'inThePast' | 'invalid';

/** The new deadline must be a moment that is later than the deadline it replaces and still ahead; the server judges the longest extension on the calendar. */
export function extensionProblem(value: string, dueAt: string, now: Date): ExtensionProblem | undefined {
  if (value === '') return 'required';
  const iso = businessMomentToIso(value);
  if (iso === undefined) return 'invalid';
  const moment = Date.parse(iso);
  if (moment <= Date.parse(dueAt)) return 'notLater';
  if (moment <= now.getTime()) return 'inThePast';
  return undefined;
}

/** The last instant at which a closed issue can still be reopened, by the window the server told; null when the issue is not closed. */
export function reopenDeadline(issue: Pick<IssueView, 'closedAt' | 'reopenWindowDays'>): string | null {
  return issue.closedAt === null ? null : new Date(Date.parse(issue.closedAt) + issue.reopenWindowDays * DAY_MS).toISOString();
}
