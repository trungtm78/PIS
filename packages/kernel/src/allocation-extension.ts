import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { isCalendarDate } from './retention.ts';

/** Why the capital of a line is carried over to the next year (the closed list of the contract; KHAC asks for words). */
export const EXTENSION_REASON_CODES = ['GPMB_CHAM', 'VUONG_MAC_PHAP_LY', 'THIEN_TAI_DICH_BENH', 'KHAC'] as const;
export type ExtensionReasonCode = (typeof EXTENSION_REASON_CODES)[number];

export const MIN_JUSTIFICATION = 20;
export const MAX_JUSTIFICATION = 2000;
export const MIN_DECISION_REASON = 5;
export const MAX_DECISION_REASON = 2000;

export type ExtensionIssueReason = 'AMOUNT_INVALID' | 'DATE_INVALID' | 'EXTENDED_TO_TOO_EARLY' | 'EXTENDED_TO_TOO_LATE' | 'REASON_UNKNOWN' | 'JUSTIFICATION_REQUIRED' | 'JUSTIFICATION_LENGTH';

export interface ExtensionIssue {
  field: 'amount_vnd' | 'extended_to' | 'reason_code' | 'justification';
  reason: ExtensionIssueReason;
}

export interface ExtensionRequestFacts {
  /** Whole VND as text. */
  amountVnd: string;
  /** The last day the carried-over capital may be disbursed, `YYYY-MM-DD`, entered from the approving document and never computed. */
  extendedTo: string;
  reasonCode: string;
  justification?: string | undefined;
  /** The year of the plan the line belongs to. */
  fromPlanYear: number;
}

const AMOUNT = /^[1-9][0-9]{0,23}$/;

/** The first and the last day on which carried-over capital of a year may still be disbursed: the year after it. */
export function extensionWindow(fromPlanYear: number): { from: string; to: string } {
  return { from: `${fromPlanYear + 1}-01-01`, to: `${fromPlanYear + 1}-12-31` };
}

/**
 * What is wrong with a request to carry capital over (422), in the order of the form: the amount is whole VND above zero, the last day of disbursement is a calendar day
 * inside the year after the plan year (the rule of the day is awaiting CXN-31, so the window is the widest the law could give: the whole next year), the reason is one of the
 * four, and a reason of KHAC (other) is explained in 20 to 2000 characters, as is any justification that is given.
 */
export function extensionIssues(facts: ExtensionRequestFacts): ExtensionIssue[] {
  const issues: ExtensionIssue[] = [];
  if (!AMOUNT.test(facts.amountVnd)) issues.push({ field: 'amount_vnd', reason: 'AMOUNT_INVALID' });
  if (!isCalendarDate(facts.extendedTo)) issues.push({ field: 'extended_to', reason: 'DATE_INVALID' });
  else {
    const window = extensionWindow(facts.fromPlanYear);
    if (facts.extendedTo < window.from) issues.push({ field: 'extended_to', reason: 'EXTENDED_TO_TOO_EARLY' });
    else if (facts.extendedTo > window.to) issues.push({ field: 'extended_to', reason: 'EXTENDED_TO_TOO_LATE' });
  }
  if (!(EXTENSION_REASON_CODES as readonly string[]).includes(facts.reasonCode)) issues.push({ field: 'reason_code', reason: 'REASON_UNKNOWN' });
  const justification = facts.justification?.trim();
  if (justification === undefined || justification === '') {
    if (facts.reasonCode === 'KHAC') issues.push({ field: 'justification', reason: 'JUSTIFICATION_REQUIRED' });
  } else if (justification.length < MIN_JUSTIFICATION || justification.length > MAX_JUSTIFICATION) {
    issues.push({ field: 'justification', reason: 'JUSTIFICATION_LENGTH' });
  }
  return issues;
}

export interface LineFigures {
  allocatedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
}

/**
 * What of a line can still be carried over: allocated less committed and disbursed (a reservation is not a commitment and does not hold capital back, BR-CAP-06 judges it)
 * less what other open requests on the same line already ask for, so two requests never promise the same capital twice. Never below zero.
 */
export function undisbursedVnd(figures: LineFigures, openRequestsVnd: string = '0'): string {
  const taken = addDecimal(addDecimal(figures.committedVnd, figures.disbursedVnd), openRequestsVnd);
  return compareDecimal(figures.allocatedVnd, taken) > 0 ? subtractDecimal(figures.allocatedVnd, taken) : '0';
}
