import { DomainError } from './errors.ts';

/**
 * The community monitoring file of a project (G4-8, Law 58/2024 articles 78-79, flagged UNVERIFIED until the customer confirms the numbers). One file for a project holds three things: the notice that the investor owes the
 * community (it has a deadline that runs from the day the duty began), the pack of documents that the notice is made of, and the feedback of the community with the answers. Every deadline is a number of days read from the
 * governance rule `COMMUNITY_MONITORING_RULE`, never a constant of the code; every state here is a pure function of dates, so the same file read on the same day always gives the same answer.
 */

export const MONITORING_RULE_TYPE = 'COMMUNITY_MONITORING_RULE';

export interface MonitoringPolicy {
  /** Days from the day the duty began to the day the notice is due (45 in the default, UNVERIFIED). */
  notice_days: number;
  /** Days from the day a feedback was received to the day the answer is due. */
  response_days: number;
  /** A notice or an answer is "due soon" from this many days before its day. */
  reminder_days: number;
}

export const monitoringDefaults = (): MonitoringPolicy => ({ notice_days: 45, response_days: 15, reminder_days: 5 });

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function intIn(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DomainError('VALIDATION_FAILED', 422, path);
  return value;
}

/** The policy a rule row gives; a field that is missing or out of range is refused, so a damaged rule never becomes a deadline of zero days. */
export function monitoringPolicyOf(params: Readonly<Record<string, unknown>>): MonitoringPolicy {
  const policy = { notice_days: intIn(params.notice_days, 1, 365, 'notice_days'), response_days: intIn(params.response_days, 1, 365, 'response_days'), reminder_days: intIn(params.reminder_days, 0, 60, 'reminder_days') };
  if (policy.reminder_days >= policy.notice_days || policy.reminder_days >= policy.response_days) throw new DomainError('VALIDATION_FAILED', 422, 'reminder_days');
  return policy;
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`): positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  if (!isDay(from) || !isDay(to)) throw new DomainError('VALIDATION_FAILED', 422, 'day');
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, days: number): string {
  if (!isDay(day) || !Number.isInteger(days)) throw new DomainError('VALIDATION_FAILED', 422, 'day');
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** What began the duty to notify: the decision to invest, the start of the works, or the day a person of the authority fixed by hand (with a reason on the file). */
export const MONITORING_TRIGGERS = ['INVESTMENT_DECISION', 'WORKS_START', 'MANUAL'] as const;
export type MonitoringTrigger = (typeof MONITORING_TRIGGERS)[number];

export const NOTICE_STATES = ['NOT_STARTED', 'PENDING', 'DUE_SOON', 'OVERDUE', 'SENT_ON_TIME', 'SENT_LATE'] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];

export interface NoticeFacts {
  /** The day the duty began, or null when it has not (the file exists but nothing started it). */
  triggerOn: string | null;
  /** The day the notice was sent, or null. */
  sentOn: string | null;
}

export interface NoticeReading {
  state: NoticeState;
  dueOn: string | null;
  /** Days left (negative: days late); null when there is no deadline or the notice was sent. */
  daysLeft: number | null;
  /** Days between the deadline and the day it was sent (positive: late); null when not sent. */
  daysLate: number | null;
}

/** The deadline of the notice is the day the duty began plus `notice_days`; the notice is on time when it was sent on or before that day. */
export function noticeReading(facts: NoticeFacts, today: string, policy: MonitoringPolicy): NoticeReading {
  if (facts.triggerOn === null) return { state: 'NOT_STARTED', dueOn: null, daysLeft: null, daysLate: null };
  const dueOn = addDays(facts.triggerOn, policy.notice_days);
  if (facts.sentOn !== null) {
    const late = daysBetween(dueOn, facts.sentOn);
    return { state: late > 0 ? 'SENT_LATE' : 'SENT_ON_TIME', dueOn, daysLeft: null, daysLate: late };
  }
  const left = daysBetween(today, dueOn);
  if (left < 0) return { state: 'OVERDUE', dueOn, daysLeft: left, daysLate: null };
  return { state: left <= policy.reminder_days ? 'DUE_SOON' : 'PENDING', dueOn, daysLeft: left, daysLate: null };
}

/** A notice cannot be sent before the duty began, in the future, or twice. */
export function assertNoticeMayBeSent(facts: NoticeFacts, sentOn: string, today: string): void {
  if (!isDay(sentOn)) throw new DomainError('VALIDATION_FAILED', 422, 'sent_on');
  if (facts.triggerOn === null) throw new DomainError('MONITORING_NOTICE_NOT_STARTED', 409);
  if (facts.sentOn !== null) throw new DomainError('MONITORING_NOTICE_ALREADY_SENT', 409);
  if (daysBetween(facts.triggerOn, sentOn) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'sent_on');
  if (daysBetween(sentOn, today) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'sent_on');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The pack of the notice: the documents that make it, each linked by the id of the document of DOC.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const PACK_ITEMS = ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE', 'BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT'] as const;
export type PackItem = (typeof PACK_ITEMS)[number];
/** The items that must be in the pack before the notice may be sent; the other items are added when they exist. */
export const PACK_REQUIRED_FOR_NOTICE: readonly PackItem[] = ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE'];

export interface PackCompleteness {
  present: PackItem[];
  missing: PackItem[];
  requiredMissing: PackItem[];
  complete: boolean;
}

export function packCompleteness(items: readonly string[]): PackCompleteness {
  const set = new Set(items);
  const present = PACK_ITEMS.filter((item) => set.has(item));
  const missing = PACK_ITEMS.filter((item) => !set.has(item));
  const requiredMissing = PACK_REQUIRED_FOR_NOTICE.filter((item) => !set.has(item));
  return { present, missing, requiredMissing, complete: requiredMissing.length === 0 };
}

export function assertPackReadyForNotice(items: readonly string[]): void {
  if (!packCompleteness(items).complete) throw new DomainError('MONITORING_PACK_INCOMPLETE', 422, 'pack');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Feedback of the community and the answer to it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const MONITORING_FEEDBACK_TOPICS = ['QUALITY', 'SCHEDULE', 'COST', 'LAND', 'ENVIRONMENT', 'SAFETY', 'OTHER'] as const;
export type MonitoringFeedbackTopic = (typeof MONITORING_FEEDBACK_TOPICS)[number];
export const MONITORING_FEEDBACK_CHANNELS = ['LETTER', 'MEETING', 'HOTLINE', 'EMAIL', 'PORTAL'] as const;
export type MonitoringFeedbackChannel = (typeof MONITORING_FEEDBACK_CHANNELS)[number];

export const MONITORING_FEEDBACK_STATUSES = ['RECEIVED', 'IN_REVIEW', 'RESPONDED', 'CLOSED', 'OUT_OF_SCOPE'] as const;
export type MonitoringFeedbackStatus = (typeof MONITORING_FEEDBACK_STATUSES)[number];
export type MonitoringFeedbackMove = 'TAKE' | 'RESPOND' | 'CLOSE' | 'REOPEN' | 'DECLINE';

const EDGES: Readonly<Record<MonitoringFeedbackStatus, Readonly<Partial<Record<MonitoringFeedbackMove, MonitoringFeedbackStatus>>>>> = {
  RECEIVED: { TAKE: 'IN_REVIEW', DECLINE: 'OUT_OF_SCOPE', RESPOND: 'RESPONDED' },
  IN_REVIEW: { RESPOND: 'RESPONDED', DECLINE: 'OUT_OF_SCOPE' },
  RESPONDED: { CLOSE: 'CLOSED', REOPEN: 'IN_REVIEW' },
  CLOSED: { REOPEN: 'IN_REVIEW' },
  OUT_OF_SCOPE: { REOPEN: 'IN_REVIEW' },
};

export function nextMonitoringFeedbackStatus(from: MonitoringFeedbackStatus, move: MonitoringFeedbackMove): MonitoringFeedbackStatus {
  const to = EDGES[from][move];
  if (to === undefined) throw new DomainError('MONITORING_FEEDBACK_STATE_INVALID', 409, 'status');
  return to;
}

/** The person who closes a feedback is not the person who answered it (two people look at an answer to the community); a decline and a reopen need a reason. */
export function assertFeedbackMove(input: { move: MonitoringFeedbackMove; actorId: string; responderId: string | null; reason: string | null }): void {
  if (input.move === 'CLOSE' && (input.responderId === null || input.responderId === input.actorId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  if ((input.move === 'DECLINE' || input.move === 'REOPEN') && (input.reason === null || input.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
}

export const RESPONSE_STATES = ['NOT_DUE', 'DUE_SOON', 'OVERDUE', 'ON_TIME', 'LATE'] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

export interface ResponseReading {
  state: ResponseState;
  dueOn: string;
  daysLeft: number | null;
  daysLate: number | null;
}

/** A feedback waits for its answer until `received_on + response_days`; once answered it is on time or late by the day of the answer, whatever happens after. */
export function responseReading(facts: { receivedOn: string; respondedOn: string | null; status: MonitoringFeedbackStatus }, today: string, policy: MonitoringPolicy): ResponseReading {
  const dueOn = addDays(facts.receivedOn, policy.response_days);
  if (facts.respondedOn !== null) {
    const late = daysBetween(dueOn, facts.respondedOn);
    return { state: late > 0 ? 'LATE' : 'ON_TIME', dueOn, daysLeft: null, daysLate: late };
  }
  const left = daysBetween(today, dueOn);
  // A feedback that was declined as out of scope owes no answer in the number of days; it keeps its row for the record.
  if (facts.status === 'OUT_OF_SCOPE') return { state: 'ON_TIME', dueOn, daysLeft: null, daysLate: null };
  if (left < 0) return { state: 'OVERDUE', dueOn, daysLeft: left, daysLate: null };
  return { state: left <= policy.reminder_days ? 'DUE_SOON' : 'NOT_DUE', dueOn, daysLeft: left, daysLate: null };
}

export interface MonitoringSummary {
  feedbackTotal: number;
  open: number;
  overdue: number;
  answeredOnTimePct: number | null;
}

/** The counts of a file: how many feedbacks, how many still wait, how many wait past their day, and the share of the answered ones that were on time (null when none was answered). */
export function summariseFeedback(readings: ReadonlyArray<{ status: MonitoringFeedbackStatus; response: ResponseReading }>): MonitoringSummary {
  let open = 0;
  let overdue = 0;
  let answered = 0;
  let onTime = 0;
  for (const item of readings) {
    if (item.status === 'RECEIVED' || item.status === 'IN_REVIEW') open += 1;
    if (item.response.state === 'OVERDUE') overdue += 1;
    if (item.response.state === 'ON_TIME' && item.status !== 'OUT_OF_SCOPE') {
      answered += 1;
      onTime += 1;
    } else if (item.response.state === 'LATE') answered += 1;
  }
  return { feedbackTotal: readings.length, open, overdue, answeredOnTimePct: answered === 0 ? null : Math.round((onTime * 1000) / answered) / 10 };
}
