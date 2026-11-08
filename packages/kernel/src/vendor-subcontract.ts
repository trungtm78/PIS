import { DomainError } from './errors.ts';
import { deadlineClock } from './vendor-restriction.ts';
import type { DeadlineClockState } from './vendor-restriction.ts';

/**
 * Subcontractors (VND-2, research V11; docs/vendor-controls.md section 6). The law forbids the prime contractor to hand over more than the part of the work it named in its bid (Article 16 Procurement Law 22/2023, the
 * transfer beyond the subcontract part declared). A subcontract is **proposed**, **approved** by a person other than the proposer (the gate action SUBCONTRACT of VND-1 runs then: a subcontractor under a restriction or
 * without the certificate the package asks for is refused), and ends **terminated** or **rejected**. The sum of the shares of the approved subcontracts is judged against the share declared in the bid and the minimum the
 * prime keeps; a subcontractor the bid did not name, or a share over what the bid declared, needs an exception that the approver gives with a reason (or the rule blocks it). After each payment request of the prime the
 * contract manager records what the prime paid each subcontractor (the amount, the day, the reference); the subcontractor confirms it later through the supplier portal. Pure; numbers are the rule `VENDOR_SUBCONTRACT`.
 */

const isRealDay = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const VENDOR_SUBCONTRACT_RULE_TYPE = 'VENDOR_SUBCONTRACT';

export interface SubcontractPolicy {
  /** The share, in percent of the contract value, that the prime must keep for itself (a floor; the research set none, the tenant states its own). */
  prime_min_share_pct: number;
  /** What happens to a share above the one declared in the bid, or a subcontractor the bid did not name: BLOCK refuses; EXCEPTION lets the approver approve with a reason. */
  over_declared: 'BLOCK' | 'EXCEPTION';
  undeclared_subcontractor: 'BLOCK' | 'EXCEPTION';
  /** Days after a payment request is paid within which the prime records what it paid each subcontractor. */
  confirm_payment_within_days: number;
  /** The warning days before that limit. */
  remind_before_days: number;
}

export const SUBCONTRACT_POLICY_DEFAULTS: SubcontractPolicy = { prime_min_share_pct: 51, over_declared: 'EXCEPTION', undeclared_subcontractor: 'EXCEPTION', confirm_payment_within_days: 14, remind_before_days: 3 };

export function subcontractPolicyOf(params: unknown): SubcontractPolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const choice = (field: string): 'BLOCK' | 'EXCEPTION' => {
    const value = params[field];
    if (value !== 'BLOCK' && value !== 'EXCEPTION') throw invalid(field);
    return value;
  };
  return { prime_min_share_pct: whole('prime_min_share_pct', 0, 100), over_declared: choice('over_declared'), undeclared_subcontractor: choice('undeclared_subcontractor'), confirm_payment_within_days: whole('confirm_payment_within_days', 1, 180), remind_before_days: whole('remind_before_days', 0, 30) };
}

export const SUBCONTRACT_STATES = ['PROPOSED', 'APPROVED', 'REJECTED', 'TERMINATED'] as const;
export type SubcontractState = (typeof SUBCONTRACT_STATES)[number];
export type SubcontractMove = 'APPROVE' | 'REJECT' | 'TERMINATE' | 'WITHDRAW';

/** PROPOSED -> APPROVED or REJECTED (a person other than the proposer); APPROVED -> TERMINATED; a proposal is withdrawn by its proposer (REJECTED). REJECTED and TERMINATED are final. */
export function moveSubcontract(state: SubcontractState, move: SubcontractMove, actor: string, proposedBy: string): SubcontractState {
  const deny = (): never => {
    throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { status: state, move } });
  };
  if (move === 'APPROVE' || move === 'REJECT') {
    if (state !== 'PROPOSED') return deny();
    if (actor === proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    return move === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  }
  if (move === 'WITHDRAW') return state === 'PROPOSED' ? 'REJECTED' : deny();
  return state === 'APPROVED' ? 'TERMINATED' : deny();
}

export interface SubcontractFacts {
  id: string;
  contractorId: string;
  /** The value of the subcontract in dong. */
  value: number;
  /** The share of the contract value, percent with two decimals. */
  sharePct: number;
  state: SubcontractState;
  /** An exception was approved for it (over the declared share or not named in the bid). */
  exceptionApproved: boolean;
}

export interface BidDeclaration {
  /** The subcontractors the bid named, by contractor id, and the share of the contract value the bid declared for subcontracting in total. */
  declaredContractorIds: readonly string[];
  declaredSharePct: number;
}

export const SUBCONTRACT_FINDINGS = ['OVER_DECLARED_SHARE', 'NOT_NAMED_IN_BID', 'PRIME_SHARE_BELOW_MINIMUM', 'VALUE_SHARE_MISMATCH', 'SAME_AS_PRIME', 'DUPLICATE_SUBCONTRACTOR'] as const;
export type SubcontractFinding = (typeof SUBCONTRACT_FINDINGS)[number];

export interface SubcontractAssessment {
  findings: SubcontractFinding[];
  /** The total of the approved shares if this one is approved, percent. */
  totalSharePct: number;
  primeSharePct: number;
  /** The rule refuses it outright. */
  blocked: boolean;
  /** It may be approved only with an exception and a reason. */
  needsException: boolean;
}

const cents = (percent: number): number => Math.round(percent * 100);

/**
 * Judges a proposed subcontract against the contract: the approved ones already there, the declaration of the bid and the rule. The share and the value must agree within one part in a thousand of the contract value
 * (a share is what the law reads, the value is what is paid); the same subcontractor twice is refused as a duplicate; the prime may not be its own subcontractor.
 */
export function assessSubcontract(input: { contractValue: number; primeContractorIds: readonly string[]; approved: readonly SubcontractFacts[]; proposal: { contractorId: string; value: number; sharePct: number }; declaration: BidDeclaration | null }, policy: SubcontractPolicy): SubcontractAssessment {
  const findings: SubcontractFinding[] = [];
  const { proposal } = input;
  if (input.primeContractorIds.includes(proposal.contractorId)) findings.push('SAME_AS_PRIME');
  if (input.approved.some((one) => one.contractorId === proposal.contractorId)) findings.push('DUPLICATE_SUBCONTRACTOR');
  const approvedTotal = input.approved.reduce((sum, one) => sum + cents(one.sharePct), 0);
  const total = approvedTotal + cents(proposal.sharePct);
  const impliedShare = input.contractValue === 0 ? 0 : (proposal.value * 10_000) / input.contractValue;
  if (input.contractValue > 0 && Math.abs(impliedShare - cents(proposal.sharePct)) > 10) findings.push('VALUE_SHARE_MISMATCH');
  const declaration = input.declaration;
  const declaredCents = declaration === null ? 0 : cents(declaration.declaredSharePct);
  if (declaration === null || !declaration.declaredContractorIds.includes(proposal.contractorId)) findings.push('NOT_NAMED_IN_BID');
  if (total > declaredCents) findings.push('OVER_DECLARED_SHARE');
  const primeShare = 10_000 - total;
  if (primeShare < cents(policy.prime_min_share_pct)) findings.push('PRIME_SHARE_BELOW_MINIMUM');
  const hard = findings.some((one) => one === 'SAME_AS_PRIME' || one === 'DUPLICATE_SUBCONTRACTOR' || one === 'VALUE_SHARE_MISMATCH' || one === 'PRIME_SHARE_BELOW_MINIMUM');
  const overBlocked = findings.includes('OVER_DECLARED_SHARE') && policy.over_declared === 'BLOCK';
  const namedBlocked = findings.includes('NOT_NAMED_IN_BID') && policy.undeclared_subcontractor === 'BLOCK';
  const blocked = hard || overBlocked || namedBlocked;
  const needsException = !blocked && (findings.includes('OVER_DECLARED_SHARE') || findings.includes('NOT_NAMED_IN_BID'));
  return { findings, totalSharePct: total / 100, primeSharePct: primeShare / 100, blocked, needsException };
}

/** The approval of a subcontract: blocked is refused; one that needs an exception takes the exception reason (20 characters); a clean one needs none. */
export function assertSubcontractApproval(assessment: SubcontractAssessment, exceptionReason: string | undefined): { exception: boolean } {
  if (assessment.blocked) throw new DomainError('SUBCONTRACT_LIMIT_EXCEEDED', 422, 'share_pct');
  if (assessment.needsException) {
    if (exceptionReason === undefined || exceptionReason.trim().length < 20) throw new DomainError('REASON_REQUIRED', 422, 'exception_reason');
    return { exception: true };
  }
  return { exception: false };
}

// -- What the prime paid the subcontractor ------------------------------------------------------------------------------------------------------------------------------------------------------

export type PaymentConfirmationState = DeadlineClockState | 'NOT_REQUIRED';

/** Where the record of what the prime paid a subcontractor stands for a payment request that was paid on `paidOn`: due `confirm_payment_within_days` after it, DUE_SOON in the window before, OVERDUE after. */
export function paymentConfirmationState(input: { requestPaidOn: string | null; recordedAt: Date | null; now: Date; subcontractApproved: boolean }, policy: SubcontractPolicy): PaymentConfirmationState {
  if (!input.subcontractApproved || input.requestPaidOn === null) return 'NOT_REQUIRED';
  const due = new Date(Date.parse(`${input.requestPaidOn}T23:59:59.999Z`) + policy.confirm_payment_within_days * 86_400_000);
  return deadlineClock({ dueAt: due, doneAt: input.recordedAt, now: input.now, remindBeforeDays: policy.remind_before_days });
}

/** Checks the record of a payment to a subcontractor: a positive whole amount, a real day, a reference of at least 3 characters. */
export function assertSubcontractPayment(input: { paidAmount: number; paidOn: string; reference: string }): void {
  if (!Number.isSafeInteger(input.paidAmount) || input.paidAmount <= 0) throw invalid('paid_amount');
  if (!isRealDay(input.paidOn)) throw invalid('paid_on');
  if (input.reference.trim().length < 3 || input.reference.length > 100) throw invalid('reference');
}

/** The sum paid to a subcontractor may not pass the value of its subcontract (OVER_PAID), a signal the contract manager must explain; returns the excess in dong (0 when none). */
export const paidExcess = (subcontractValue: number, paid: readonly number[]): number => Math.max(0, paid.reduce((sum, one) => sum + one, 0) - subcontractValue);
