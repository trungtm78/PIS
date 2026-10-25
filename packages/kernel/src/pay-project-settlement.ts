import { assertNotProposer } from './contract-halt.ts';
import { DomainError } from './errors.ts';
import { addCalendarDays } from './land-timers.ts';
import { signedDong, wholeVnd } from './pay-money.ts';

/**
 * The settlement of a project, of a year or of a contract (ST-PAY-009, PAY 3.5, BR-PAY-15, CXN-09): where a settlement stands, how many days the verification may take for the group of the project, what
 * is still owed when it is closed, and who may do what to it. Pure functions of their input, kept apart from the database so the cases of the settlement officer run without one.
 */

export const SETTLEMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFYING', 'VERIFIED', 'CLOSED', 'RETURNED', 'SUPERSEDED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_SCOPES = ['ANNUAL', 'PROJECT', 'CONTRACT'] as const;
export type SettlementScope = (typeof SETTLEMENT_SCOPES)[number];

/** The groups of a project the verification deadline is given for (QTQG is a project of national importance). */
export const SETTLEMENT_PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type SettlementProjectGroup = (typeof SETTLEMENT_PROJECT_GROUPS)[number];

/** The rule of master data that gives the days of the verification for each group of project (PAY.SETTLEMENT.VERIFY_DEADLINE, CXN-09), and its one key. */
export const SETTLEMENT_DEADLINE_RULE = 'PAY_SETTLEMENT_DEADLINE';
export const SETTLEMENT_DEADLINE_KEY = 'VERIFY_DEADLINE';

export const VERIFICATION_OUTCOMES = ['VERIFYING', 'VERIFIED', 'RETURNED'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** The statuses of a settlement that is still being worked: only one of them may stand for a project, a scope, a contract and a year (409 `SETTLEMENT_OPEN_EXISTS`). */
export const OPEN_SETTLEMENT_STATUSES: readonly SettlementStatus[] = ['DRAFT', 'SUBMITTED', 'VERIFYING', 'VERIFIED', 'RETURNED'];

export const isOpenSettlement = (status: string): boolean => (OPEN_SETTLEMENT_STATUSES as readonly string[]).includes(status);

/** A settlement can be sent, and its figures read again from the ledger, only while it is a draft or has been returned. */
export const isSettlementEditable = (status: string): boolean => status === 'DRAFT' || status === 'RETURNED';

/**
 * The status a verification leads to, or undefined when the move is not allowed (409 `SETTLEMENT_STATE_INVALID`): the file that was sent is taken up (VERIFYING), and then it is verified or given
 * back; a file that was sent can also be given back before it is taken up.
 */
export function verificationTarget(from: SettlementStatus, outcome: VerificationOutcome): SettlementStatus | undefined {
  if (outcome === 'VERIFYING') return from === 'SUBMITTED' ? 'VERIFYING' : undefined;
  if (outcome === 'VERIFIED') return from === 'VERIFYING' ? 'VERIFIED' : undefined;
  return from === 'SUBMITTED' || from === 'VERIFYING' ? 'RETURNED' : undefined;
}

/** The number of days the rule gives a group, or undefined when it gives none (the rule keeps one row for each group it knows). */
export function deadlineDays(rows: readonly { projectGroup: string; days: number }[], group: string): number | undefined {
  return rows.find((row) => row.projectGroup === group)?.days;
}

/** The last day of the verification: the day of the submission and the days of the group (BR-PAY-15), the first of them being the day after. */
export function verificationDueOn(submittedOn: string, days: number): string {
  return addCalendarDays(submittedOn, days);
}

export type DeadlineStage = 'T30' | 'T7' | 'OVERDUE';

const DAY_MS = 86_400_000;

/** The whole days from `from` to `to` (both calendar days); negative when `to` comes first. */
export function daysBetween(from: string, to: string): number {
  addCalendarDays(from, 0);
  addCalendarDays(to, 0);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Where a verification deadline stands on `today`: past its last day (OVERDUE), at most 7 days from it (T7), at most 30 days from it (T30), or far off (undefined). The last day itself is
 * not late. A reminder is sent once for each stage, and the stages only grow.
 */
export function deadlineStage(dueOn: string, today: string): DeadlineStage | undefined {
  const left = daysBetween(today, dueOn);
  if (left < 0) return 'OVERDUE';
  if (left <= 7) return 'T7';
  if (left <= 30) return 'T30';
  return undefined;
}

/** The figures a settlement is made of, in whole dong. */
export interface SettlementFigures {
  /** The value of what was paid (the gross of the payments, a reversal taking its own back). */
  settledVnd: string;
  /** What is still owed to the contractors: accepted work not paid yet, and the retention still held. */
  outstandingVnd: string;
  /** The advance that was paid and not recovered. */
  unrecoveredAdvanceVnd: string;
}

/** The sums of the ledgers a settlement reads, for the contracts in its scope. */
export interface LedgerSums {
  acceptedVnd: string;
  /** Everything paid up to the day the figures are read for. */
  paidVnd: string;
  /** What was paid in the period of a settlement of a year; a settlement of a project or of a contract is of everything paid. */
  paidInPeriodVnd?: string;
  retentionHeldVnd: string;
  advanceDisbursedVnd: string;
  advanceRecoveredVnd: string;
}

/**
 * The figures of a settlement from the sums of the ledgers (PAY 3.5 step 1). What is owed is the accepted work that is not paid plus the retention still held; what is unrecovered is the advance
 * paid less the advance recovered. A figure below nothing is a defect of the ledger and is refused, never shown as nothing (422 `VALIDATION_FAILED` naming the figure).
 */
export function settlementFigures(sums: LedgerSums): SettlementFigures {
  const accepted = wholeVnd(sums.acceptedVnd, 'accepted_vnd');
  const paid = wholeVnd(sums.paidVnd, 'paid_vnd');
  const retention = wholeVnd(sums.retentionHeldVnd, 'retention_held_vnd');
  const disbursed = wholeVnd(sums.advanceDisbursedVnd, 'advance_disbursed_vnd');
  const recovered = wholeVnd(sums.advanceRecoveredVnd, 'advance_recovered_vnd');
  const outstanding = accepted - paid + retention;
  const unrecovered = disbursed - recovered;
  if (outstanding < 0n) throw new DomainError('VALIDATION_FAILED', 422, 'outstanding_vnd', { extensions: { reason: 'NEGATIVE' } });
  if (unrecovered < 0n) throw new DomainError('VALIDATION_FAILED', 422, 'unrecovered_advance_vnd', { extensions: { reason: 'NEGATIVE' } });
  const settled = sums.paidInPeriodVnd === undefined ? paid : wholeVnd(sums.paidInPeriodVnd, 'paid_in_period_vnd');
  return { settledVnd: settled.toString(), outstandingVnd: outstanding.toString(), unrecoveredAdvanceVnd: unrecovered.toString() };
}

/** Whether the settlement still owes anything, which only an exception approved by someone else lets it close with. */
export const hasOutstanding = (figures: Pick<SettlementFigures, 'outstandingVnd' | 'unrecoveredAdvanceVnd'>): boolean =>
  signedDong(figures.outstandingVnd, 'outstanding_vnd') > 0n || signedDong(figures.unrecoveredAdvanceVnd, 'unrecovered_advance_vnd') > 0n;

/**
 * The close of a settlement (PAY 3.5 step 5, UAT-AC66): with something still owed it needs the exception that someone else approved (422 `SETTLEMENT_HAS_OUTSTANDING`, with the figures); the
 * figures stay as they are, they are never taken for nothing.
 */
export function assertClosable(figures: SettlementFigures, exceptionApproved: boolean): void {
  if (hasOutstanding(figures) && !exceptionApproved) {
    throw new DomainError('SETTLEMENT_HAS_OUTSTANDING', 422, 'id', { extensions: { outstanding_vnd: figures.outstandingVnd, unrecovered_advance_vnd: figures.unrecoveredAdvanceVnd } });
  }
}

/** An exception is asked for only when something is owed (422 `NO_OUTSTANDING_TO_EXCEPT`). */
export function assertExceptionNeeded(figures: SettlementFigures): void {
  if (!hasOutstanding(figures)) throw new DomainError('NO_OUTSTANDING_TO_EXCEPT', 422, 'id');
}

/** Whoever verifies a settlement is not the one who sent it (BR-PAY-16). */
export function assertVerifier(actor: string, submittedBy: string | null): void {
  assertNotProposer(actor, [submittedBy]);
}

/** Whoever approves the exception, or closes the settlement, is not one of the people who prepared it: who opened it and who sent it (BR-PAY-16). */
export function assertNotPreparer(actor: string, createdBy: string | null, submittedBy: string | null): void {
  assertNotProposer(actor, [createdBy, submittedBy]);
}
