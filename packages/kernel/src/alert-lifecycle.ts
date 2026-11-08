import { DomainError } from './errors.ts';

/**
 * The life of an alert after it is shown (GOV-10, roadmap G2-8 and G2-9), as pure rules: when the system may close an alert because the condition of its source cleared (and when it must not), when it is opened again, and
 * what a person may say about an alert that they think is wrong and how the owner of its type answers. The database side reads and writes; the decisions are here, so that they can be tested without it.
 */

export type ObservedState = 'OPEN' | 'RESOLVED_BY_SYSTEM';

export interface ObservedItem {
  source: string;
  sourceId: string;
  state: ObservedState;
}

export const itemKey = (source: string, sourceId: string): string => `${source}\u0000${sourceId}`;

export interface ObservationPass {
  /** What the pass produced: every item of every person's list, snoozed or paused items included (hiding is not clearing). */
  produced: ReadonlyArray<{ source: string; sourceId: string }>;
  /** What the store already knows. */
  known: readonly ObservedItem[];
  /** The sources that answered in the pass, and the ones that could not be read in at least one list. A source that did not answer closes nothing. */
  answeredSources: ReadonlySet<string>;
  failedSources: ReadonlySet<string>;
}

export interface ObservationDecision {
  /** Seen for the first time. */
  open: Array<{ source: string; sourceId: string }>;
  /** Seen again and still open: only the last-seen time moves. */
  touch: Array<{ source: string; sourceId: string }>;
  /** Closed before and produced again: the condition returned. */
  reopen: Array<{ source: string; sourceId: string }>;
  /** Open before, not produced now, and its source answered: the condition cleared. */
  close: Array<{ source: string; sourceId: string }>;
  /** Open before, not produced now, and its source did not answer: nothing is said about it. */
  unknown: Array<{ source: string; sourceId: string }>;
}

/**
 * The decision of one pass. The one rule that matters: an item is closed only when its source answered in EVERY list that was read (a source that failed for even one person may be hiding the item from the person it
 * belongs to), so a failing source never closes anything and is never read as "the condition cleared".
 */
export function observationDecision(pass: ObservationPass): ObservationDecision {
  const produced = new Map(pass.produced.map((item) => [itemKey(item.source, item.sourceId), item]));
  const known = new Map(pass.known.map((item) => [itemKey(item.source, item.sourceId), item]));
  const decision: ObservationDecision = { open: [], touch: [], reopen: [], close: [], unknown: [] };
  for (const [key, item] of produced) {
    const before = known.get(key);
    const ref = { source: item.source, sourceId: item.sourceId };
    if (before === undefined) decision.open.push(ref);
    else if (before.state === 'RESOLVED_BY_SYSTEM') decision.reopen.push(ref);
    else decision.touch.push(ref);
  }
  for (const [key, item] of known) {
    if (item.state !== 'OPEN' || produced.has(key)) continue;
    const ref = { source: item.source, sourceId: item.sourceId };
    if (pass.answeredSources.has(item.source) && !pass.failedSources.has(item.source)) decision.close.push(ref);
    else decision.unknown.push(ref);
  }
  return decision;
}

/**
 * The sources that answered in a pass over the lists of the people: all of them, unless nobody was read, a list could not be read, a source failed, or a source reached its cap of rows in some list (the rows past the cap
 * are not in the answer, so their absence says nothing). A source that is not in the answer closes nothing.
 */
export function answeredSources(all: readonly string[], input: { members: number; incomplete: boolean; failed: ReadonlySet<string>; truncated: boolean }): Set<string> {
  if (input.members === 0 || input.incomplete || input.truncated) return new Set();
  return new Set(all.filter((source) => !input.failed.has(source)));
}

/** An item that the system closed with no decision of any person on it: nobody claimed, assigned, snoozed or paused it. The report of "closed with no record" lists these. */
export const closedWithoutRecord = (decisionsBeforeClose: number | null): boolean => decisionsBeforeClose === 0;

// -- the "this alert is wrong" report ---------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEEDBACK_REASONS = ['NOT_APPLICABLE', 'WRONG_DATA', 'DUPLICATE', 'ALREADY_HANDLED', 'NOT_MY_ROLE', 'TOO_EARLY', 'OTHER'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export const isFeedbackReason = (value: unknown): value is FeedbackReason => typeof value === 'string' && (FEEDBACK_REASONS as readonly string[]).includes(value);

export const ALERT_FEEDBACK_STATUSES = ['PENDING', 'ACCEPTED_FOR_TUNING', 'REJECTED', 'DUPLICATE_OF', 'WITHDRAWN'] as const;
export type AlertFeedbackStatus = (typeof ALERT_FEEDBACK_STATUSES)[number];

export const FEEDBACK_NOTE_MAX = 500;
const NOTE_MIN_FOR_OTHER = 5;

/** The report as a person makes it: a reason from the catalogue, and a note that the reason OTHER cannot do without. A reason that is not in the catalogue is refused. */
export function assertFeedbackInput(input: { reason: unknown; note: unknown }): { reason: FeedbackReason; note: string | null } {
  if (!isFeedbackReason(input.reason)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const trimmed = input.note.trim();
    if (trimmed.length > FEEDBACK_NOTE_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    note = trimmed === '' ? null : trimmed;
  }
  if (input.reason === 'OTHER' && (note === null || note.length < NOTE_MIN_FOR_OTHER)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
  return { reason: input.reason, note };
}

export type FeedbackMove = 'WITHDRAW' | 'ACCEPT_FOR_TUNING' | 'REJECT' | 'MARK_DUPLICATE';

const FEEDBACK_MOVES: Readonly<Record<FeedbackMove, AlertFeedbackStatus>> = {
  WITHDRAW: 'WITHDRAWN',
  ACCEPT_FOR_TUNING: 'ACCEPTED_FOR_TUNING',
  REJECT: 'REJECTED',
  MARK_DUPLICATE: 'DUPLICATE_OF',
};

/**
 * The status after a move of a report. Only a pending report moves (409 ALERT_FEEDBACK_STATE_INVALID); only the reporter withdraws; the owner of the type decides, and never on their own report (403 SELF_APPROVAL_DENIED);
 * a rejection needs its reason in the review note (422). A decision is never "suppress": there is no move here that hides an alert.
 */
export function nextAlertFeedbackStatus(current: AlertFeedbackStatus, move: FeedbackMove, input: { actor: string; reporter: string; reviewNote?: string | null }): AlertFeedbackStatus {
  if (current !== 'PENDING') throw new DomainError('ALERT_FEEDBACK_STATE_INVALID', 409, 'status');
  if (move === 'WITHDRAW') {
    if (input.actor !== input.reporter) throw new DomainError('SCOPE_DENIED', 403);
    return FEEDBACK_MOVES[move];
  }
  if (input.actor === input.reporter) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  if (move === 'REJECT' && (input.reviewNote === undefined || input.reviewNote === null || input.reviewNote.trim() === '')) throw new DomainError('VALIDATION_FAILED', 422, 'review_note');
  return FEEDBACK_MOVES[move];
}

/** The "unhelpful" share of a type: the reports about it, over the alerts of that type that were shown in the period (a type with nothing shown has no share, never zero). */
export function unhelpfulShare(reports: number, shown: number): number | null {
  if (shown <= 0) return null;
  return Math.round((reports / shown) * 1000) / 10;
}

/** Whether a type goes into review: its unhelpful share reaches the line of the rule (default 30%, research A10, not confirmed). */
export const needsRationalisation = (share: number | null, reviewLinePct: number): boolean => share !== null && share >= reviewLinePct;
