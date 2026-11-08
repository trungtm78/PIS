import { DomainError } from './errors.ts';
import { foldForMatch } from './vendor-profile.ts';

/**
 * The accounts a contractor is paid into (VND-1, research V12; docs/vendor-management.md section 3). An account is never changed in place: a change is a request that two people approve in separate roles (the match of
 * the request with the contract file, the match of the account with its holder), that somebody confirms by calling the contractor back on the number the file already held, and that waits a period before a payment
 * may go to the new account. A payment is blocked while the contractor has no valid account to be paid into. Pure: the policy, the clock and the facts come in as arguments.
 */

/** The rule `VENDOR_PAYEE_ACCOUNT` (params). The numbers are our own operating choice (the law sets none), flagged unverified, and the agency sets its own. */
export interface PayeeAccountPolicy {
  /** Hours between the confirmation of a change and the first day a payment may go to the new account. */
  waiting_hours: number;
  /** Days a request may stay open before it expires. */
  request_valid_days: number;
  /** REQUIRE: the holder name must equal the legal name of the contractor (folded); WARN: a difference is shown to the approvers and kept on the request. */
  name_match: 'REQUIRE' | 'WARN';
  /** A payment to a contractor that has never had an account is refused (true) or only warned about (false). A contractor that has had accounts and has none valid is always refused. */
  require_registered_account: boolean;
  /** While the new account waits, the account it replaces may still be paid into (false: no payment goes anywhere until the wait ends). */
  old_account_pays_during_wait: boolean;
  /** The number on file that the call goes to must have been on the profile at least this many days (a number changed with the request proves nothing). */
  callback_number_min_age_days: number;
}

export const PAYEE_ACCOUNT_STATES = ['ACTIVE', 'SUPERSEDED', 'CLOSED'] as const;
export type PayeeAccountState = (typeof PAYEE_ACCOUNT_STATES)[number];

export const BANK_CHANGE_STATES = ['REQUESTED', 'ACTIVATED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const;
export type BankChangeState = (typeof BANK_CHANGE_STATES)[number];
/** The two approval roles: the match of the request with the contract and profile documents, and the match of the account with its holder and bank. */
export const BANK_APPROVAL_ROLES = ['CONTRACT_MATCH', 'ACCOUNT_MATCH'] as const;
export type BankApprovalRole = (typeof BANK_APPROVAL_ROLES)[number];
export const CALLBACK_OUTCOMES = ['CONFIRMED', 'NOT_CONFIRMED'] as const;
export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The holder name compared with the legal name of the contractor: same words after folding, in any order of the words that count. */
export function holderMatchesLegalName(holder: string, legalName: string): boolean {
  const left = foldForMatch(holder).split(' ').filter((word) => word !== '').sort().join(' ');
  const right = foldForMatch(legalName).split(' ').filter((word) => word !== '').sort().join(' ');
  return left !== '' && left === right;
}

/** An account number as it is compared and indexed: digits and letters only, upper case, 6 to 30 characters. */
export function normaliseAccountNumber(raw: string): string {
  const compact = raw.replace(/[\s.-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{6,30}$/.test(compact)) throw invalid('account_number');
  return compact;
}

export interface BankChangeFacts {
  state: BankChangeState;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  contractMatchBy: string | null;
  accountMatchBy: string | null;
  callbackBy: string | null;
  callbackOutcome: CallbackOutcome | null;
  nameMatch: boolean;
}

export type BankChangeMove =
  | { move: 'APPROVE'; role: BankApprovalRole; by: string; at: Date }
  | { move: 'CALLBACK'; by: string; at: Date; outcome: CallbackOutcome; usedNumberOnFile: boolean; numberMatchesFile: boolean; numberOnFileSince: Date | null }
  | { move: 'REJECT'; by: string; at: Date; reason: string }
  | { move: 'CANCEL'; by: string; at: Date; reason: string };

export interface BankChangeEffect {
  /** The facts after the move. */
  facts: BankChangeFacts;
  /** True when the move completed the change: the account becomes ACTIVE and its waiting period starts. */
  activated: boolean;
  /** A callback that did not confirm rejects the request at once. */
  autoRejected: boolean;
}

const notOpen = (state: string): DomainError => new DomainError('BANK_CHANGE_STATE_INVALID', 409, 'status', { extensions: { status: state } });

/**
 * One move of a change request. The refusals, in order: the request is not open or has run out (409 `BANK_CHANGE_STATE_INVALID`); the person is the one who asked or the other approver (403 `SELF_APPROVAL_DENIED`:
 * every role of the change is another person than the requester, and the two approval roles are two people); the call did not use the number on file, that number is not the one on file, or the number is too recent
 * to prove anything (422 `BANK_CHANGE_CALLBACK_INVALID`). A callback that does not confirm rejects the request.
 */
export function moveBankChange(facts: BankChangeFacts, move: BankChangeMove, policy: PayeeAccountPolicy): BankChangeEffect {
  if (facts.state !== 'REQUESTED') throw notOpen(facts.state);
  if (move.at.getTime() > facts.expiresAt.getTime() && move.move !== 'CANCEL' && move.move !== 'REJECT') throw notOpen('EXPIRED');
  if (move.by === facts.requestedBy && move.move !== 'CANCEL') throw new DomainError('SELF_APPROVAL_DENIED', 403);
  if (move.move === 'REJECT') return { facts: { ...facts, state: 'REJECTED' }, activated: false, autoRejected: false };
  if (move.move === 'CANCEL') {
    if (move.by !== facts.requestedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    return { facts: { ...facts, state: 'CANCELLED' }, activated: false, autoRejected: false };
  }
  let next: BankChangeFacts = facts;
  if (move.move === 'APPROVE') {
    const other = move.role === 'CONTRACT_MATCH' ? facts.accountMatchBy : facts.contractMatchBy;
    if (other === move.by) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if ((move.role === 'CONTRACT_MATCH' ? facts.contractMatchBy : facts.accountMatchBy) !== null) throw notOpen(`${move.role}_DONE`);
    next = move.role === 'CONTRACT_MATCH' ? { ...facts, contractMatchBy: move.by } : { ...facts, accountMatchBy: move.by };
  } else {
    if (facts.callbackBy !== null) throw notOpen('CALLBACK_DONE');
    if (!move.usedNumberOnFile || !move.numberMatchesFile) throw new DomainError('BANK_CHANGE_CALLBACK_INVALID', 422, 'called_number', { extensions: { reason: 'NUMBER_NOT_ON_FILE' } });
    const minAgeMs = policy.callback_number_min_age_days * 86_400_000;
    if (move.numberOnFileSince === null || move.at.getTime() - move.numberOnFileSince.getTime() < minAgeMs) {
      throw new DomainError('BANK_CHANGE_CALLBACK_INVALID', 422, 'called_number', { extensions: { reason: 'NUMBER_TOO_RECENT', min_age_days: policy.callback_number_min_age_days } });
    }
    if (move.outcome === 'NOT_CONFIRMED') return { facts: { ...facts, state: 'REJECTED', callbackBy: move.by, callbackOutcome: 'NOT_CONFIRMED' }, activated: false, autoRejected: true };
    next = { ...facts, callbackBy: move.by, callbackOutcome: 'CONFIRMED' };
  }
  const complete = next.contractMatchBy !== null && next.accountMatchBy !== null && next.callbackOutcome === 'CONFIRMED';
  return { facts: complete ? { ...next, state: 'ACTIVATED' } : next, activated: complete, autoRejected: false };
}

/** What is still missing before the change can take effect, in the order a person does it. */
export function bankChangeProgress(facts: Pick<BankChangeFacts, 'contractMatchBy' | 'accountMatchBy' | 'callbackOutcome'>): Array<'CONTRACT_MATCH' | 'ACCOUNT_MATCH' | 'CALLBACK'> {
  const left: Array<'CONTRACT_MATCH' | 'ACCOUNT_MATCH' | 'CALLBACK'> = [];
  if (facts.contractMatchBy === null) left.push('CONTRACT_MATCH');
  if (facts.accountMatchBy === null) left.push('ACCOUNT_MATCH');
  if (facts.callbackOutcome !== 'CONFIRMED') left.push('CALLBACK');
  return left;
}

/** The first moment a payment may go to an account that was confirmed at `confirmedAt`. */
export const effectiveAfterOf = (confirmedAt: Date, policy: Pick<PayeeAccountPolicy, 'waiting_hours'>): Date => new Date(confirmedAt.getTime() + policy.waiting_hours * 3_600_000);

// -- The verdict a payment asks (V12: block the payment when the account is not valid) ------------------------------------------------------------------------------------------------------------

export interface PayeeAccountFacts {
  id: string;
  state: PayeeAccountState;
  effectiveAfter: Date;
  /** The account that this one replaced, while that one may still be paid into. */
  supersededById: string | null;
  supersededAt: Date | null;
}

export type PayeeBlockReason = 'NO_ACCOUNT_REGISTERED' | 'IN_WAITING_PERIOD' | 'NO_VALID_ACCOUNT' | 'CHANGE_UNDER_REVIEW';
export type PayeeWarning = 'PAYEE_ACCOUNT_NOT_REGISTERED' | 'PAYEE_CHANGE_PENDING';

export interface PayeeVerdict {
  allowed: boolean;
  reason: PayeeBlockReason | null;
  warnings: PayeeWarning[];
  /** The account a payment goes to when it may; absent when it is blocked or when the contractor has none and the policy only warns. */
  accountId: string | null;
  /** The day the waiting period ends, when that is what blocks. */
  validFrom: string | null;
}

/**
 * Whether a payment to a contractor may go on `now`. The valid account is the ACTIVE one whose waiting period has ended. A contractor that never had an account is warned about, or refused when the policy requires a registered
 * account. A contractor whose newest account is still in its waiting period is refused (the account it replaced is usable only when the policy says so). A change that is still being decided is a warning: the payment goes to
 * the account that is valid.
 */
export function payeeVerdict(accounts: readonly PayeeAccountFacts[], changePending: boolean, now: Date, policy: PayeeAccountPolicy): PayeeVerdict {
  const warnings: PayeeWarning[] = [];
  if (changePending) warnings.push('PAYEE_CHANGE_PENDING');
  if (accounts.length === 0) {
    if (policy.require_registered_account) return { allowed: false, reason: 'NO_ACCOUNT_REGISTERED', warnings, accountId: null, validFrom: null };
    warnings.push('PAYEE_ACCOUNT_NOT_REGISTERED');
    return { allowed: true, reason: null, warnings, accountId: null, validFrom: null };
  }
  const active = accounts.filter((account) => account.state === 'ACTIVE');
  const ready = active.find((account) => account.effectiveAfter.getTime() <= now.getTime());
  if (ready !== undefined) return { allowed: true, reason: null, warnings, accountId: ready.id, validFrom: null };
  const waiting = active.sort((x, y) => y.effectiveAfter.getTime() - x.effectiveAfter.getTime())[0];
  if (waiting !== undefined) {
    if (policy.old_account_pays_during_wait) {
      const old = accounts.find((account) => account.state === 'SUPERSEDED' && account.supersededById === waiting.id);
      if (old !== undefined) return { allowed: true, reason: null, warnings, accountId: old.id, validFrom: null };
    }
    return { allowed: false, reason: 'IN_WAITING_PERIOD', warnings, accountId: null, validFrom: waiting.effectiveAfter.toISOString().slice(0, 10) };
  }
  return { allowed: false, reason: 'NO_VALID_ACCOUNT', warnings, accountId: null, validFrom: null };
}

export const PAYEE_POLICY_RULE_TYPE = 'VENDOR_PAYEE_ACCOUNT';
export const PAYEE_POLICY_RULE_CODE = 'DEFAULT';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the params of the rule `VENDOR_PAYEE_ACCOUNT`; anything that does not fit is 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field. */
export function payeeAccountPolicyOf(params: unknown): PayeeAccountPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (!isRecord(params)) throw bad('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const flag = (field: string): boolean => {
    const value = params[field];
    if (typeof value !== 'boolean') throw bad(field);
    return value;
  };
  const nameMatch = params.name_match;
  if (nameMatch !== 'REQUIRE' && nameMatch !== 'WARN') throw bad('name_match');
  return {
    waiting_hours: whole('waiting_hours', 0, 720),
    request_valid_days: whole('request_valid_days', 1, 365),
    name_match: nameMatch,
    require_registered_account: flag('require_registered_account'),
    old_account_pays_during_wait: flag('old_account_pays_during_wait'),
    callback_number_min_age_days: whole('callback_number_min_age_days', 0, 365),
  };
}

/** Starting values: three days of waiting, a request valid for 30 days, the holder must be the contractor, a payment to a contractor with no account is warned about, nothing is paid during the wait, the number on file at least 7 days old. Our operating choices, not legal numbers. */
export const PAYEE_ACCOUNT_DEFAULTS: PayeeAccountPolicy = {
  waiting_hours: 72,
  request_valid_days: 30,
  name_match: 'REQUIRE',
  require_registered_account: false,
  old_account_pays_during_wait: false,
  callback_number_min_age_days: 7,
};
