import { compareDecimal, multiplyDecimal, roundDecimal } from './decimal.ts';
import type { RoundingMode } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The acceptance of work done under a contract (ST-CTR-009, CTR 3.4, BR-CTR-05): approved measurements are accepted as a priced record, an approver other than whoever made it decides, and
 * the accepted value of the contract never goes above its value. The price of a line is the price in the revision in force on the day of the acceptance, kept with the line.
 */
export const WORK_ACCEPTANCE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type WorkAcceptanceStatus = (typeof WORK_ACCEPTANCE_STATUSES)[number];

export const WORK_ACCEPTANCE_COMMANDS = ['submit', 'approve', 'reject', 'return', 'revoke'] as const;
export type WorkAcceptanceCommand = (typeof WORK_ACCEPTANCE_COMMANDS)[number];

const TRANSITIONS: Readonly<Record<WorkAcceptanceCommand, { from: WorkAcceptanceStatus; to: WorkAcceptanceStatus }>> = {
  submit: { from: 'DRAFT', to: 'SUBMITTED' },
  approve: { from: 'SUBMITTED', to: 'APPROVED' },
  reject: { from: 'SUBMITTED', to: 'REJECTED' },
  return: { from: 'SUBMITTED', to: 'DRAFT' },
  revoke: { from: 'APPROVED', to: 'REVOKED' },
};

/** 409 `ACCEPTANCE_STATE_INVALID` (with the status) unless the command applies to the status; otherwise the status the command leads to. */
export function assertWorkAcceptanceTransition(command: WorkAcceptanceCommand, status: WorkAcceptanceStatus): WorkAcceptanceStatus {
  const rule = TRANSITIONS[command];
  if (rule.from !== status) throw new DomainError('ACCEPTANCE_STATE_INVALID', 409, 'status', { extensions: { acceptance_status: status } });
  return rule.to;
}

/** The statuses of acceptance in which the work counts as accepted: only an approved acceptance does. */
export const isAccepted = (status: WorkAcceptanceStatus): boolean => status === 'APPROVED';

/** The value of a line in whole dong: the quantity times the price taken from the revision, rounded the way that line of the BOQ is rounded (BR-CTR-05). */
export function lineAmount(quantity: string, unitPrice: string, rounding: RoundingMode): string {
  return roundDecimal(multiplyDecimal(quantity, unitPrice), 0, rounding);
}

/** The sum of whole-dong amounts. */
export function sumAmounts(amounts: readonly string[]): string {
  return amounts.reduce((total, amount) => (BigInt(total) + BigInt(amount)).toString(), '0');
}

/**
 * 422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT` unless what is accepted already plus this acceptance stays within the value of the contract (CHECK `contract_ledger_order_chk` says the same
 * to the database). The extensions say the figures, so the screen can show how much is left.
 */
export function assertWithinContractValue(acceptedTotal: string, amount: string, contractValue: string): void {
  const after = (BigInt(acceptedTotal) + BigInt(amount)).toString();
  if (compareDecimal(after, contractValue) > 0) {
    throw new DomainError('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422, 'accepted_amount_vnd', {
      extensions: { accepted_total_vnd: acceptedTotal, amount_vnd: amount, contract_value_vnd: contractValue, remaining_vnd: (BigInt(contractValue) - BigInt(acceptedTotal)).toString() },
    });
  }
}

/** The measurements asked for that are not in the approved set, in the order they were asked: the ones 422 `MEASUREMENT_NOT_APPROVED` names. */
export function notApproved(asked: readonly string[], approved: ReadonlySet<string>): string[] {
  return asked.filter((id) => !approved.has(id));
}
