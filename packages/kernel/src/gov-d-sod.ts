import { DomainError } from './errors.ts';
import { validateRuleParams } from './governance-rules.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The separation of duties checked at commit (G4-1 of docs/governance-roadmap-10of10.md, ADM 3.6, `docs/gov-d-sod.md`). This module is pure. The matrix itself is the rule type `SOD_MATRIX` of the governance registry
 * (`conflicts[{action_a, action_b, scope, severity, exception_max_days}]`, `exception_approvers`); here are the catalogue of the duties a command can take, the reading of the matrix, the judgement of a command against the
 * duties its actor already holds in the same scope, and the life of a time-limited exception (two approvers who are neither the requester nor the person the exception covers). The database side (`SodStore`, `SodGuard`)
 * looks the duties up in the columns the modules already keep (who drafted, who sent, who checked); nothing here reads or writes.
 */

/** What a duty is about: one record, or everything of one project, contract or procurement package. */
export const SOD_SCOPES = ['SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE'] as const;
export type SodScope = (typeof SOD_SCOPES)[number];
export const SOD_SEVERITIES = ['BLOCK', 'WARN'] as const;
export type SodSeverity = (typeof SOD_SEVERITIES)[number];
export const isSodScope = (value: unknown): value is SodScope => typeof value === 'string' && (SOD_SCOPES as readonly string[]).includes(value);

/** The duty a command takes (and the duty a person is found to hold): `<area>.<verb>`. */
export interface SodActionInfo {
  code: string;
  module: 'CTR' | 'PAY' | 'BID';
  /** The i18n key of the plain-words name of the duty. */
  label: string;
}

export const SOD_ACTIONS: readonly SodActionInfo[] = [
  { code: 'contract.draft', module: 'CTR', label: 'govd.sod.action.contractDraft' },
  { code: 'contract.approve', module: 'CTR', label: 'govd.sod.action.contractApprove' },
  { code: 'measurement.record', module: 'CTR', label: 'govd.sod.action.measurementRecord' },
  { code: 'measurement.approve', module: 'CTR', label: 'govd.sod.action.measurementApprove' },
  { code: 'acceptance.record', module: 'CTR', label: 'govd.sod.action.acceptanceRecord' },
  { code: 'acceptance.approve', module: 'CTR', label: 'govd.sod.action.acceptanceApprove' },
  { code: 'payment.request', module: 'PAY', label: 'govd.sod.action.paymentRequest' },
  { code: 'payment.verify', module: 'PAY', label: 'govd.sod.action.paymentVerify' },
  { code: 'payment.approve', module: 'PAY', label: 'govd.sod.action.paymentApprove' },
  { code: 'advance.request', module: 'PAY', label: 'govd.sod.action.advanceRequest' },
  { code: 'advance.approve', module: 'PAY', label: 'govd.sod.action.advanceApprove' },
  { code: 'bid.evaluate', module: 'BID', label: 'govd.sod.action.bidEvaluate' },
  { code: 'bid.award', module: 'BID', label: 'govd.sod.action.bidAward' },
  { code: 'bid.sign_off', module: 'BID', label: 'govd.sod.action.bidSignOff' },
];
export const SOD_ACTION_CODES: readonly string[] = SOD_ACTIONS.map((action) => action.code);
export const isSodAction = (value: unknown): value is string => typeof value === 'string' && SOD_ACTION_CODES.includes(value);

export interface SodConflict {
  action_a: string;
  action_b: string;
  scope: SodScope;
  severity: SodSeverity;
  /** The longest an exception for this pair may run, in days; 0 means no exception is possible. */
  exception_max_days: number;
}

export interface SodMatrix {
  conflicts: SodConflict[];
  exception_approvers: number;
}

/** The fewest distinct approvers an exception ever needs, whatever the matrix says: the rule may ask for more, never fewer. */
export const SOD_MIN_EXCEPTION_APPROVERS = 2;
/** The window before the end of an exception in which it is listed as expiring (the alert type `SOD_EXCEPTION_EXPIRING`). */
export const SOD_EXPIRING_WITHIN_DAYS = 5;

/** The matrix as the code reads it, with the params checked by the registry's own schema (an unknown shape is 422 GOVERNANCE_RULE_PARAMS_INVALID). */
export function sodMatrixOf(params: RuleParams): SodMatrix {
  const checked = validateRuleParams('SOD_MATRIX', params);
  const conflicts = (checked.conflicts as Array<Record<string, unknown>>).map((entry) => ({
    action_a: String(entry.action_a),
    action_b: String(entry.action_b),
    scope: entry.scope as SodScope,
    severity: entry.severity as SodSeverity,
    exception_max_days: Number(entry.exception_max_days),
  }));
  return { conflicts, exception_approvers: Number(checked.exception_approvers) };
}

/** The number of approvers an exception under this matrix needs. */
export const approversNeeded = (matrix: SodMatrix): number => Math.max(SOD_MIN_EXCEPTION_APPROVERS, matrix.exception_approvers);

/** The pair as the matrix names it, in the order the matrix lists it. */
export interface SodPair {
  action_a: string;
  action_b: string;
}
export const pairKey = (pair: SodPair): string => `${pair.action_a}|${pair.action_b}`;

/** The thing a command is about, as the keys of each scope: a null key means the record does not belong to that kind of group (a bid has no contract), so a conflict of that scope cannot be found. */
export interface SodSubject {
  record: string | null;
  project: string | null;
  contract: string | null;
  package: string | null;
}

export function subjectKeyOf(subject: SodSubject, scope: SodScope): string | null {
  switch (scope) {
    case 'SAME_RECORD':
      return subject.record;
    case 'SAME_PROJECT':
      return subject.project;
    case 'SAME_CONTRACT':
      return subject.contract;
    case 'SAME_PACKAGE':
      return subject.package;
  }
}

/** A conflict of the matrix seen from the duty being taken: the other duty it clashes with. */
export interface SodCheck extends SodPair {
  taking: string;
  other: string;
  scope: SodScope;
  severity: SodSeverity;
  exception_max_days: number;
}

/** The conflicts the matrix has for a duty (either side of a pair). */
export function checksFor(matrix: SodMatrix, taking: string): SodCheck[] {
  return matrix.conflicts
    .filter((conflict) => conflict.action_a === taking || conflict.action_b === taking)
    .map((conflict) => ({
      action_a: conflict.action_a,
      action_b: conflict.action_b,
      taking,
      other: conflict.action_a === taking ? conflict.action_b : conflict.action_a,
      scope: conflict.scope,
      severity: conflict.severity,
      exception_max_days: conflict.exception_max_days,
    }));
}

export const heldKey = (action: string, scope: SodScope): string => `${action}|${scope}`;

/**
 * The checks whose other duty the actor already holds in the same scope. `held` has `heldKey(action, scope)` for every duty found. A duty is never in conflict with itself: a pair that names the same duty twice
 * is a defect of the matrix and is read as one that cannot be held at all, so it is not judged here.
 */
export function violationsOf(matrix: SodMatrix, taking: string, held: ReadonlySet<string>): SodCheck[] {
  return checksFor(matrix, taking).filter((check) => check.other !== check.taking && held.has(heldKey(check.other, check.scope)));
}

/** The duties of the scopes a check needs to look up: what the store asks the database for (each duty once, with the scopes it is needed in). */
export function lookupsFor(matrix: SodMatrix, taking: string): Array<{ action: string; scope: SodScope }> {
  const seen = new Set<string>();
  const out: Array<{ action: string; scope: SodScope }> = [];
  for (const check of checksFor(matrix, taking)) {
    const key = heldKey(check.other, check.scope);
    if (check.other === taking || seen.has(key)) continue;
    seen.add(key);
    out.push({ action: check.other, scope: check.scope });
  }
  return out;
}

/** The refusal: the two duties of the pair, the one being taken and the one already held, never the person or the record that made the actor hold it. */
export function violationError(check: SodCheck, exceptionPossible: boolean): DomainError {
  return new DomainError('SOD_VIOLATION', 422, undefined, {
    extensions: { action_a: check.action_a, action_b: check.action_b, taking: check.taking, held: check.other, scope: check.scope, exception_possible: exceptionPossible && check.exception_max_days > 0 },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Exceptions: a person may hold both duties of a pair for a limited time when two other people agree.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type SodExceptionStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export type SodExceptionView = SodExceptionStatus | 'EXPIRED';
export const SOD_EXCEPTION_STATUSES: readonly SodExceptionStatus[] = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
export const isSodDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && Number.isFinite(dayNumber(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** The conflict of the matrix that an exception is asked for; a pair the matrix does not list is 422 on `pair`. */
export function conflictOf(matrix: SodMatrix, pair: SodPair, scope: SodScope): SodConflict {
  const found = matrix.conflicts.find((conflict) => conflict.action_a === pair.action_a && conflict.action_b === pair.action_b && conflict.scope === scope);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'pair');
  return found;
}

/**
 * The window of an exception: from today or later, ending on or after its start, and no longer than the pair allows (`exception_max_days`, counting both days). A pair that allows 0 days takes no exception: 422
 * SOD_EXCEPTION_WINDOW_INVALID on `valid_to`. Backdating is refused on `valid_from`, so no use can be excused after the fact.
 */
export function assertExceptionWindow(conflict: SodConflict, validFrom: string, validTo: string, today: string): void {
  if (!isSodDay(validFrom) || !isSodDay(today)) throw new DomainError('VALIDATION_FAILED', 422, 'valid_from');
  if (!isSodDay(validTo)) throw new DomainError('VALIDATION_FAILED', 422, 'valid_to');
  if (validFrom < today) throw new DomainError('SOD_EXCEPTION_WINDOW_INVALID', 422, 'valid_from');
  if (validTo < validFrom) throw new DomainError('SOD_EXCEPTION_WINDOW_INVALID', 422, 'valid_to');
  const days = dayNumber(validTo) - dayNumber(validFrom) + 1;
  if (conflict.exception_max_days === 0 || days > conflict.exception_max_days) throw new DomainError('SOD_EXCEPTION_WINDOW_INVALID', 422, 'valid_to');
}

export interface SodExceptionFacts {
  status: SodExceptionStatus;
  requestedBy: string;
  /** The person the exception lets hold both duties. */
  member: string;
  validFrom: string;
  validTo: string;
  approvedBy: readonly string[];
  approversNeeded: number;
}

/** The status a reader sees: an approved or requested exception whose last day has passed has expired (nothing is written when time passes). */
export function viewOf(facts: Pick<SodExceptionFacts, 'status' | 'validTo'>, today: string): SodExceptionView {
  return (facts.status === 'APPROVED' || facts.status === 'REQUESTED') && facts.validTo < today ? 'EXPIRED' : facts.status;
}

/** Whether the exception excuses a command taken on `today`: approved, and inside its days. */
export const usable = (facts: Pick<SodExceptionFacts, 'status' | 'validFrom' | 'validTo'>, today: string): boolean => facts.status === 'APPROVED' && facts.validFrom <= today && today <= facts.validTo;

/** Whether an approved exception ends within the days given (and has not ended). */
export function expiringWithin(facts: Pick<SodExceptionFacts, 'status' | 'validTo'>, today: string, days: number = SOD_EXPIRING_WITHIN_DAYS): boolean {
  return facts.status === 'APPROVED' && facts.validTo >= today && dayNumber(facts.validTo) - dayNumber(today) <= days;
}

/**
 * Who may approve or reject: neither the person who asked nor the person the exception covers (403 SELF_APPROVAL_DENIED), and nobody twice (409 SOD_EXCEPTION_STATE_INVALID). The rule is the same for rejecting,
 * so the two people who are party to the exception have no say in it either way.
 */
export function assertMayDecide(facts: SodExceptionFacts, actor: string): void {
  if (facts.status !== 'REQUESTED') throw new DomainError('SOD_EXCEPTION_STATE_INVALID', 409, 'status');
  if (actor === facts.requestedBy || actor === facts.member) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  if (facts.approvedBy.includes(actor)) throw new DomainError('SOD_EXCEPTION_STATE_INVALID', 409, 'approver');
}

/** The status after an approval: approved once the number of distinct approvers the matrix asked for is reached. The window must still be ahead (an exception nobody approved in time is not approved late). */
export function afterApproval(facts: SodExceptionFacts, actor: string, today: string): { status: SodExceptionStatus; approvals: number } {
  assertMayDecide(facts, actor);
  if (facts.validTo < today) throw new DomainError('SOD_EXCEPTION_WINDOW_INVALID', 422, 'valid_to');
  const approvals = facts.approvedBy.length + 1;
  return { status: approvals >= facts.approversNeeded ? 'APPROVED' : 'REQUESTED', approvals };
}

/** A rejection by one eligible person ends the request. */
export function afterRejection(facts: SodExceptionFacts, actor: string): SodExceptionStatus {
  assertMayDecide(facts, actor);
  return 'REJECTED';
}

/** An exception that is still asked or approved can be taken back (by the administrator who holds the revoke grant, whoever asked); one that ended cannot. */
export function afterRevocation(facts: Pick<SodExceptionFacts, 'status'>): SodExceptionStatus {
  if (facts.status !== 'REQUESTED' && facts.status !== 'APPROVED') throw new DomainError('SOD_EXCEPTION_STATE_INVALID', 409, 'status');
  return 'REVOKED';
}

/** The reason an exception is given: words, not a blank (a decision with no reason cannot be audited). */
export function assertReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason.trim();
}
