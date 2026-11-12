import type { components } from '@machvon/contracts';
import type { Assignment, AssignmentRole, FormProblem } from '../model';
import { dayProblem, isDay, textProblem, wholeProblem } from '../model';

export type AssignmentInput = components['schemas']['PwfAssignmentInput'];

export const ROLES: readonly AssignmentRole[] = ['RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'];
export const MIN_SHARE = 1;
export const MAX_SHARE = 100;
export const MAX_ASSIGNMENT_REASON = 500;

export interface AssignmentForm {
  membershipId: string;
  role: AssignmentRole;
  validFrom: string;
  validTo: string;
  sharePct: string;
  reason: string;
}

export const EMPTY_FORM: AssignmentForm = { membershipId: '', role: 'RESPONSIBLE', validFrom: '', validTo: '', sharePct: '', reason: '' };

export type FormField = 'membershipId' | 'validFrom' | 'validTo' | 'sharePct' | 'reason';
export type FormProblems = Partial<Record<FormField, FormProblem>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What can be found wrong with the form before anything is sent; the server judges the rest. */
export function validateForm(form: AssignmentForm): FormProblems {
  const problems: FormProblems = {};
  if (!UUID.test(form.membershipId.trim())) problems.membershipId = 'pickOne';
  const from = dayProblem(form.validFrom);
  if (from !== undefined) problems.validFrom = from;
  const to = form.validTo.trim();
  if (to !== '' && (!isDay(to) || (from === undefined && to < form.validFrom.trim()))) problems.validTo = 'invalidDay';
  const share = wholeProblem(form.sharePct, MIN_SHARE, MAX_SHARE);
  if (share !== undefined) problems.sharePct = share;
  const reason = textProblem(form.reason, 1, MAX_ASSIGNMENT_REASON);
  if (reason !== undefined) problems.reason = reason;
  return problems;
}

export function assignmentBody(form: AssignmentForm): AssignmentInput {
  return {
    membership_id: form.membershipId.trim(),
    role: form.role,
    valid_from: form.validFrom.trim(),
    valid_to: form.validTo.trim() === '' ? null : form.validTo.trim(),
    share_pct: Number(form.sharePct.trim()),
    reason: form.reason.trim(),
  };
}

export interface LedgerCheck {
  /** The same person already holds the same role over a day of the new period. */
  overlap: boolean;
  /** On some day of the new period the shares of the same role add up to more than 100. */
  overShare: boolean;
}

const FAR = '9999-12-31';
const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string): boolean => aFrom <= bTo && bFrom <= aTo;

/**
 * Warns, before the form is sent, of what the server would refuse (PWF_ASSIGNMENT_INVALID): a person holding the same role twice over the same days, and the shares of one role adding up
 * to more than 100% on any day of the new period. The days that matter are the start of the new period and every start of another assignment inside it. The server stays the authority.
 */
export function checkLedger(ledger: readonly Assignment[], form: AssignmentForm): LedgerCheck {
  const none: LedgerCheck = { overlap: false, overShare: false };
  const problems = validateForm(form);
  if (problems.validFrom !== undefined || problems.validTo !== undefined || problems.sharePct !== undefined) return none;
  const from = form.validFrom.trim();
  const to = form.validTo.trim() === '' ? FAR : form.validTo.trim();
  const share = Number(form.sharePct.trim());
  const sameRole = ledger.filter((item) => item.role === form.role && overlaps(from, to, item.valid_from, item.valid_to ?? FAR));
  const overlap = sameRole.some((item) => item.membership_id === form.membershipId.trim());
  const days = [from, ...sameRole.map((item) => item.valid_from).filter((day) => day > from)];
  const overShare = days.some((day) => share + sameRole.filter((item) => item.valid_from <= day && day <= (item.valid_to ?? FAR)).reduce((total, item) => total + item.share_pct, 0) > MAX_SHARE);
  return { overlap, overShare };
}
