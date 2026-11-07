import { DomainError } from './errors.ts';
import { DEMO_MARK, assertLayoutIssuable } from './report-layout.ts';
import type { IssuableOptions, LayoutStatus, ReportLayout } from './report-layout.ts';

/**
 * The issued copy of a report (RPT-1, eng-review R17): the file that went out for a period, which nobody can change afterwards. An issued copy carries the sha256 of its bytes, the people who prepared, checked and
 * approved it (three different people), the period, and its place in a lineage: a correction is a NEW copy with the next revision that names the one it replaces, and a delivery of a copy that a later one replaced, or that
 * is older than what the receiver already accepted, is refused. This module is the pure rules; the store, the triggers that make the rows immutable and the push to a receiver come with the database part.
 */

export const ISSUE_ROLES = ['PREPARER', 'CHECKER', 'APPROVER'] as const;
export type IssueRole = (typeof ISSUE_ROLES)[number];

export interface IssueSignatories {
  preparer: string;
  checker: string;
  approver: string;
}

/** The three must be named and must be three different people: nobody checks or approves what they prepared, and nobody approves what they checked. */
export function assertDistinctSignatories(signatories: IssueSignatories): void {
  const ids = [signatories.preparer, signatories.checker, signatories.approver];
  if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) throw new DomainError('VALIDATION_FAILED', 422, 'signatories');
  if (new Set(ids).size !== ids.length) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'signatories');
}

// ---- the life of a copy before it is issued -----------------------------------------------------------------------------------------------------

export const ISSUE_STATES = ['DRAFT', 'CHECKED', 'APPROVED', 'ISSUED'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];
export const ISSUE_ACTIONS = ['CHECK', 'APPROVE', 'ISSUE'] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];

const NEXT: Record<IssueState, { action: IssueAction; to: IssueState } | null> = {
  DRAFT: { action: 'CHECK', to: 'CHECKED' },
  CHECKED: { action: 'APPROVE', to: 'APPROVED' },
  APPROVED: { action: 'ISSUE', to: 'ISSUED' },
  ISSUED: null,
};

/** Who did what so far on one copy: the preparer made it, the checker and the approver signed it. */
export interface IssueActors {
  preparer: string;
  checker: string | null;
  approver: string | null;
}

export interface IssueStep {
  state: IssueState;
  actors: IssueActors;
}

/**
 * One step: DRAFT is checked, CHECKED is approved, APPROVED is issued; any other order, or a step out of an ISSUED copy, is REPORT_STATE_INVALID (409). The checker and the approver must not be anyone who already
 * acted on the copy (SELF_APPROVAL_DENIED, 403). Issuing records no new person: it is the act of the approver, who must be the one who approved.
 */
export function advanceIssue(step: IssueStep, action: IssueAction, actor: string): IssueStep {
  if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError('VALIDATION_FAILED', 422, 'actor');
  const next = NEXT[step.state];
  if (next === null || next.action !== action) throw new DomainError('REPORT_STATE_INVALID', 409, 'issue_state');
  if (action === 'CHECK') {
    if (actor === step.actors.preparer) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'checker');
    return { state: next.to, actors: { ...step.actors, checker: actor } };
  }
  if (action === 'APPROVE') {
    if (actor === step.actors.preparer || actor === step.actors.checker) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approver');
    return { state: next.to, actors: { ...step.actors, approver: actor } };
  }
  if (actor !== step.actors.approver) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'issuer');
  return { state: next.to, actors: step.actors };
}

// ---- the lineage ---------------------------------------------------------------------------------------------------------------------------------

/** The DIS snapshot a copy is made from, with the revision of that snapshot and the cut-off day it is common to (R17). A report built from a snapshot that was later corrected is a stale report. */
export interface SnapshotRevisionRef {
  snapshotId: string;
  revision: number;
  cutoff: string;
}

/**
 * What an issued copy says about the form it was made on (R18): the status of the layout at the day of issue and, for a DEMO form, the demo mark. A copy made on a DEMO form carries the mark in its metadata as in its
 * file, is never counted as accepted by a receiver, and can never stand in for the official copy of the series.
 */
export interface IssuedCopyMarks {
  formStatus: LayoutStatus;
  demoMark: string | null;
}

/** The marks of a copy about to be issued on `layout`: refused when the layout may not be issued (a DEMO layout needs demo mode on), else its status and its mark. */
export function issueMarksOf(layout: ReportLayout, options: IssuableOptions = {}): IssuedCopyMarks {
  assertLayoutIssuable(layout, options);
  return { formStatus: layout.status, demoMark: layout.status === 'DEMO' ? DEMO_MARK : null };
}

/** Whether a copy was made on a DEMO form. */
export const isDemoCopy = (copy: { marks?: IssuedCopyMarks | undefined }): boolean => copy.marks?.formStatus === 'DEMO' || (copy.marks?.demoMark ?? null) !== null;

/** Whether a copy counts as accepted when a receiver says it holds it: a copy made on a DEMO form never does. */
export const countsAsAcceptedCopy = (copy: { marks?: IssuedCopyMarks | undefined }): boolean => !isDemoCopy(copy);

/** Refuses to record a receiver's acceptance of a copy made on a DEMO form (TEMPLATE_UNCONFIRMED, `demo_not_acceptable`): a demo copy is shown, never accepted (R18). */
export function assertAcceptable(copy: { marks?: IssuedCopyMarks | undefined }): void {
  if (!countsAsAcceptedCopy(copy)) throw new DomainError('TEMPLATE_UNCONFIRMED', 409, 'demo_not_acceptable');
}

export interface IssuedCopyRef {
  id: string;
  orgId: string;
  layoutCode: string;
  layoutVersion: string;
  /** The code of the period, as `periodCode` writes it. */
  period: string;
  /** 1 for the first copy of the series, then one more for each correction. */
  revision: number;
  /** The id of the copy this one replaces; null for revision 1. */
  supersedes: string | null;
  sha256: string;
  snapshot: SnapshotRevisionRef | null;
  /** The marks of the form the copy was made on; absent on a copy that predates them (an official one). */
  marks?: IssuedCopyMarks | undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A series is one organisation, one layout and one period: the copies of it form one chain. */
export const seriesKeyOf = (copy: Pick<IssuedCopyRef, 'orgId' | 'layoutCode' | 'period'>): string => `${copy.orgId}|${copy.layoutCode}|${copy.period}`;

/** The key that makes one issue happen once, however many times the request is repeated (HPM push key: organisation, period, revision of the report). */
export const issueKeyOf = (copy: Pick<IssuedCopyRef, 'orgId' | 'layoutCode' | 'period' | 'revision'>): string => `${seriesKeyOf(copy)}|r${copy.revision}`;

/** The chain of one series must be unbroken: revisions 1 to n in order, each naming the one before, all of one series, every hash well formed. Returns the head (the newest copy), or null for an empty series. */
export function assertLineage(copies: readonly IssuedCopyRef[]): IssuedCopyRef | null {
  const sorted = [...copies].sort((a, b) => a.revision - b.revision);
  let previous: IssuedCopyRef | null = null;
  for (const copy of sorted) {
    if (!SHA256.test(copy.sha256)) throw new DomainError('VALIDATION_FAILED', 422, 'sha256');
    if (previous === null) {
      if (copy.revision !== 1 || copy.supersedes !== null) throw new DomainError('VALIDATION_FAILED', 422, 'lineage');
    } else if (copy.revision !== previous.revision + 1 || copy.supersedes !== previous.id || seriesKeyOf(copy) !== seriesKeyOf(previous)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'lineage');
    }
    previous = copy;
  }
  return previous;
}

export interface NextIssue {
  /** DUPLICATE: the same bytes were already issued as the head (an idempotent repeat), nothing new is made. */
  outcome: 'NEW' | 'DUPLICATE';
  revision: number;
  supersedes: string | null;
}

/**
 * What issuing `sha256` next means for a series: the first copy is revision 1; a copy with other bytes is the next revision and replaces the head; the same bytes as the head is a repeat (DUPLICATE). A correction
 * must carry a reason (`reason`), since an issued copy is only ever replaced, never edited.
 */
export function nextIssueOf(series: readonly IssuedCopyRef[], sha256: string, reason: string | null): NextIssue {
  if (!SHA256.test(sha256)) throw new DomainError('VALIDATION_FAILED', 422, 'sha256');
  const head = assertLineage(series);
  if (head === null) return { outcome: 'NEW', revision: 1, supersedes: null };
  if (head.sha256 === sha256) return { outcome: 'DUPLICATE', revision: head.revision, supersedes: head.supersedes };
  if (reason === null || reason.trim() === '') throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return { outcome: 'NEW', revision: head.revision + 1, supersedes: head.id };
}

/** Whether the bytes in the store are the bytes that were issued. */
export function assertIntegrity(copy: Pick<IssuedCopyRef, 'sha256'>, actualSha256: string): void {
  if (copy.sha256 !== actualSha256) throw new DomainError('HASH_MISMATCH', 422, 'sha256');
}

/**
 * Whether a copy may be delivered to a receiver (R17). The receiver's last accepted copy of the series, if any, is `accepted`; `head` is the newest copy issued. Refused (REPORT_OUT_OF_DATE, 409, with the current
 * revision) when the copy was replaced by a later one, when it is older than the one the receiver accepted, or when it was made from an older revision of the snapshot than the one the receiver accepted. A copy the receiver
 * already holds is ALREADY_DELIVERED: the push is repeated without effect.
 */
export function assertDeliverable(copy: IssuedCopyRef, head: IssuedCopyRef, acceptedRef: IssuedCopyRef | null): 'DELIVER' | 'ALREADY_DELIVERED' {
  // A copy made on a DEMO form is never an acceptance (R18): it does not hold back a later delivery.
  const accepted = acceptedRef !== null && countsAsAcceptedCopy(acceptedRef) ? acceptedRef : null;
  if (seriesKeyOf(copy) !== seriesKeyOf(head) || (accepted !== null && seriesKeyOf(accepted) !== seriesKeyOf(copy))) throw new DomainError('VALIDATION_FAILED', 422, 'series');
  const stale = (): never => {
    throw new DomainError('REPORT_OUT_OF_DATE', 409, 'revision', { extensions: { current_revision: head.revision } });
  };
  if (copy.revision < head.revision) stale();
  if (copy.revision > head.revision) throw new DomainError('VALIDATION_FAILED', 422, 'revision');
  if (accepted !== null) {
    if (copy.revision < accepted.revision) stale();
    if (copy.revision === accepted.revision) return copy.sha256 === accepted.sha256 ? 'ALREADY_DELIVERED' : stale();
    if (copy.snapshot !== null && accepted.snapshot !== null && copy.snapshot.snapshotId === accepted.snapshot.snapshotId && copy.snapshot.revision < accepted.snapshot.revision) stale();
  }
  return 'DELIVER';
}
