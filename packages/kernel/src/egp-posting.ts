import { sha256Hex } from './canonical-json.ts';
import { registerEvidenceKind } from './bid-workflow.ts';
import { DomainError } from './errors.ts';
import { egpDayOf } from './egp.ts';
import type { EgpClock, EgpFieldDifference, EgpNoticeRecord, EgpObligation, EgpPostingKind, EgpResultRecord, EgpSubjectType } from './egp.ts';
import { message } from './messages.ts';
import { momentOf } from './procurement-file.ts';
import type { MilestoneKind } from './procurement-file.ts';

/**
 * The outbound side of the connector to the national procurement network (EGP-2, docs/egp-connector.md sections 7 and 12): how urgent an open posting is by the time that is left, what the dates of an imported
 * notice and result say about the milestones of a package, which facts of the register open an obligation, the figure "posted on time", and the fingerprint that makes the reconciliation of a field idempotent.
 * Pure, like `egp.ts`: it opens no connection, reads no file and writes nothing.
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Severity by the time that is left (rule EGP_POSTING_SEVERITY, defaults UNVERIFIED).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The rule type that says how close to the deadline a posting turns from "to be acted on" into "urgent" (registered in `governance-rules.ts`, code `DEFAULT`). */
export const EGP_SEVERITY_RULE_TYPE = 'EGP_POSTING_SEVERITY';
export const EGP_SEVERITY_RULE_CODE = 'DEFAULT';

export interface EgpSeverityParams {
  /** Hours before the deadline from which a posting that is due soon is urgent (an overdue posting is always urgent). */
  urgent_within_hours: number;
}

/** Narrows the params of the rule to the shape this module uses: 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field (the registry has checked them already; this is the type, and a defence against a stale row). */
export function egpSeverityParamsOf(params: Readonly<Record<string, unknown>>): EgpSeverityParams {
  const value = params.urgent_within_hours;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 720) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'urgent_within_hours');
  return { urgent_within_hours: value };
}

/** The finding of an open posting that the alert centre turns into a severity (`EGP_POSTING` in `DEFAULT_SEVERITY_RULES`). */
export type EgpPostingFacet = 'DUE_SOON' | 'DUE_SOON_URGENT' | 'OVERDUE';

/**
 * The facet of a clock: OVERDUE past the deadline; DUE_SOON_URGENT when the time left is at most `urgent_within_hours`; DUE_SOON while it is within the reminder window but longer. Anything else raises no alert (undefined),
 * and so does a posting that was submitted: the lateness is a figure, not an alert.
 */
export function egpPostingFacet(clock: EgpClock, params: EgpSeverityParams): EgpPostingFacet | undefined {
  if (clock.status === 'OVERDUE') return 'OVERDUE';
  if (clock.status !== 'DUE_SOON') return undefined;
  const left = clock.msToDue ?? Number.POSITIVE_INFINITY;
  return left <= params.urgent_within_hours * 3_600_000 ? 'DUE_SOON_URGENT' : 'DUE_SOON';
}

/** The rule type that says how many working days the owner of a difference has to settle it (registered in `governance-rules.ts`, code `DEFAULT`; the number is ours and unverified). */
export const EGP_RECONCILE_RULE_TYPE = 'EGP_RECONCILIATION_POLICY';
export const EGP_RECONCILE_RULE_CODE = 'DEFAULT';

export function egpReconcileParamsOf(params: Readonly<Record<string, unknown>>): { due_in_working_days: number } {
  const value = params.due_in_working_days;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'due_in_working_days');
  return { due_in_working_days: value };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// "Posted on time".
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpOnTime {
  met: number;
  metLate: number;
  overdue: number;
  /** MET / (MET + MET_LATE + OVERDUE) in ten-thousandths (basis points, rounded down), null when nothing has been judged yet: no row is "100%" by default. */
  rateBp: number | null;
}

/** The figure "% posted on time": a posting that was submitted at or before its deadline over every posting that is judged (submitted, or still open and past its deadline). Open ones within their time and cancelled ones are not judged. */
export function egpOnTime(clocks: ReadonlyArray<Pick<EgpClock, 'status'>>): EgpOnTime {
  let met = 0;
  let metLate = 0;
  let overdue = 0;
  for (const clock of clocks) {
    if (clock.status === 'MET') met += 1;
    else if (clock.status === 'MET_LATE') metLate += 1;
    else if (clock.status === 'OVERDUE') overdue += 1;
  }
  return egpOnTimeOf({ met, metLate, overdue });
}

/** The same figure from counts (a database that counted the rows by clock). */
export function egpOnTimeOf(counts: { met: number; metLate: number; overdue: number }): EgpOnTime {
  const judged = counts.met + counts.metLate + counts.overdue;
  return { ...counts, rateBp: judged === 0 ? null : Math.floor((counts.met * 10_000) / judged) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The facts of the register that open an obligation.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What each fact the register can state opens: the kind of the posting, and what the day of the fact means. A notice, a reputation event and a contractor response have no fact in the register yet: a person opens them (and any other kind may be opened by hand too). */
export const EGP_OBLIGATION_FACTS: ReadonlyArray<{ fact: string; kind: EgpPostingKind; day: string }> = [
  { fact: 'PLAN_APPROVED', kind: 'PLAN', day: 'the moment the plan of the project was approved' },
  { fact: 'RESULT_APPROVED', kind: 'RESULT', day: 'the moment the result of the choice of contractor was approved' },
  { fact: 'CONTRACT_SIGNED', kind: 'CONTRACT_INFO', day: 'the first instant (Vietnam) of the day the contract was signed' },
  { fact: 'EVALUATION_APPROVED', kind: 'CONTRACTOR_PERFORMANCE', day: 'the moment the completion evaluation of the contractor was approved' },
  { fact: 'VIOLATION_CONFIRMED', kind: 'VIOLATION', day: 'the first instant (Vietnam) of the day the violation occurred' },
  { fact: 'CONTRACTOR_NOTIFIED', kind: 'CONTRACTOR_RESPONSE', day: 'the moment the contractor was told of the proposed rating of its performance (CA-3)' },
];

/** The kinds whose posting is the file of the contractor export (CTR-24): its batch is the packet and its receipt is the receipt of the obligation. */
export const EGP_EXPORT_KINDS: readonly EgpPostingKind[] = ['CONTRACTOR_PERFORMANCE', 'VIOLATION'];

/** The instant a day opens an obligation by hand: the first instant of the day in Vietnam; 422 `VALIDATION_FAILED` on `triggered_on` for anything that is not a real day. */
export function egpTriggerInstant(day: string, now: Date): string {
  const moment = egpDayOf(day) === undefined ? undefined : momentOf(egpDayOf(day) as string);
  if (moment === undefined || Date.parse(moment) > now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'triggered_on');
  return moment;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The milestones that an imported notice and result state.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpMilestoneDate {
  kind: MilestoneKind;
  /** An ISO date-time in UTC. */
  at: string;
}

/**
 * The milestones a notice of invitation states: the day it was published, the closing and the opening of the bids. A modification or a cancellation does not rewrite a milestone: it is a different statement that the
 * reconciliation shows, never one the register takes in silently.
 */
export function egpNoticeMilestones(record: Pick<EgpNoticeRecord, 'noticeKind' | 'publishedAt' | 'bidClosingAt' | 'bidOpeningAt'>): EgpMilestoneDate[] {
  if (record.noticeKind !== 'INVITATION') return [];
  const found: EgpMilestoneDate[] = [{ kind: 'INVITATION_PUBLISHED', at: record.publishedAt }];
  if (record.bidClosingAt !== null) found.push({ kind: 'BID_CLOSING', at: record.bidClosingAt });
  if (record.bidOpeningAt !== null) found.push({ kind: 'BID_OPENING', at: record.bidOpeningAt });
  return found;
}

/** The milestones a result states: the day it was published and, when the file gives it, the day it was approved (a day: its first instant in Vietnam). A cancelled result states none. */
export function egpResultMilestones(record: Pick<EgpResultRecord, 'resultKind' | 'publishedAt' | 'approvedOn'>): EgpMilestoneDate[] {
  if (record.resultKind === 'CANCELLED') return [];
  const found: EgpMilestoneDate[] = [{ kind: 'RESULT_PUBLISHED', at: record.publishedAt }];
  const approved = record.approvedOn === null ? undefined : momentOf(record.approvedOn);
  if (approved !== undefined) found.push({ kind: 'RESULT_APPROVED', at: approved });
  return found;
}

/** What the hook did with one date: filled the milestone, found it already there (by day), left it because the package says another day (the reconciliation shows it), or could not take it. */
export type EgpMilestoneOutcome = 'FILLED' | 'SAME_DAY' | 'KEPT_OURS' | 'ORDER_REFUSED' | 'IN_THE_FUTURE' | 'PACKAGE_CLOSED';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The reconciliation of a field.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The statement a difference is a fingerprint of: the subject, the field and both values as they stand. The same fingerprint is the same piece of work, so reading the same records again opens nothing new and a settled difference does not come back unless a figure moved. */
export function egpDifferenceFingerprint(subjectType: EgpSubjectType, subjectKey: string, difference: Pick<EgpFieldDifference, 'field' | 'kind' | 'ours' | 'theirs'>): string {
  return sha256Hex(JSON.stringify([subjectType, subjectKey, difference.field, difference.kind, difference.ours ?? null, difference.theirs ?? null]));
}

/** The subjects whose imported records are reconciled against ours: the ones whose fields we hold on our side (a project, a contract have no imported record yet). */
export const EGP_RECONCILE_SUBJECTS: readonly EgpSubjectType[] = ['PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACTOR'];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Evidence for the workflow of a package.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The evidence kind of the receipt of a posting (source `EXTERNAL_RECEIPT`: the evidence carries the reference the network gave). A rule `PROCUREMENT_WORKFLOW` version lists it on the step that posts the notice or the result. */
export const EGP_POSTING_RECEIPT_EVIDENCE = 'EGP_POSTING_RECEIPT';
registerEvidenceKind({ code: EGP_POSTING_RECEIPT_EVIDENCE, source: 'EXTERNAL_RECEIPT', label: message('bid.workflow.label.egp_posting_receipt'), module: 'BID' });

/** The state of an obligation that still asks something of a person. */
export const EGP_OPEN_STATES: ReadonlyArray<EgpObligation['state']> = ['DUE', 'PREPARED', 'REJECTED'];
