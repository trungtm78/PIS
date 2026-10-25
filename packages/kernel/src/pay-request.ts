import { DomainError } from './errors.ts';

/** The kinds and states of a payment request (PAY 4, ST-PAY-002). */
export const PAYMENT_KINDS = ['ADVANCE', 'INTERIM', 'FINAL'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED', 'RETURNED', 'CANCELLED', 'REVERSED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** A request is revised, given documents and cancelled while it is a draft or has been returned. */
export const isEditable = (status: PaymentStatus): boolean => status === 'DRAFT' || status === 'RETURNED';

export const DOCUMENT_KINDS = ['INVOICE', 'ACCEPTANCE_MINUTES', 'GUARANTEE', 'CONTRACT_COPY', 'TREASURY_FORM', 'OTHER'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** What the contract in its state says about a request (BR-PAY-09); `undefined` when the request may be made. */
export interface ContractFacts {
  status: string;
  /** The Vietnam date the contract was suspended from, when it is suspended. */
  suspendedFrom: string | null;
  /** The Vietnam date the contract was terminated on, when it is. */
  terminatedOn: string | null;
}

/**
 * BR-PAY-09, the matrix of contract states: an active contract takes every kind; a suspended one takes an interim request for an acceptance approved before the day it was suspended and no
 * advance; a terminated one takes only the final request for an acceptance approved before the day it ended; a contract that is signed, completed or closed takes the final request only when it
 * is completed. `approvedOn` is the Vietnam date the acceptance was approved (none for an advance). Returns the reason the request is refused, or undefined.
 */
export function contractRefusal(contract: ContractFacts, kind: PaymentKind, approvedOn: string | null): string | undefined {
  switch (contract.status) {
    case 'ACTIVE':
      return undefined;
    case 'SUSPENDED':
      if (kind !== 'INTERIM') return 'KIND_NOT_ALLOWED_WHILE_SUSPENDED';
      if (approvedOn === null || contract.suspendedFrom === null || approvedOn >= contract.suspendedFrom) return 'ACCEPTED_AFTER_SUSPENSION';
      return undefined;
    case 'TERMINATED':
      if (kind !== 'FINAL') return 'KIND_NOT_ALLOWED_AFTER_TERMINATION';
      if (approvedOn === null || contract.terminatedOn === null || approvedOn > contract.terminatedOn) return 'ACCEPTED_AFTER_TERMINATION';
      return undefined;
    case 'COMPLETED':
      return kind === 'FINAL' ? undefined : 'KIND_NOT_ALLOWED_AFTER_COMPLETION';
    default:
      return 'CONTRACT_NOT_IN_PERFORMANCE';
  }
}

/** 409 `CONTRACT_STATE_INVALID` naming the state, the kind and the reason, unless the contract takes the request. */
export function assertContractAllows(contract: ContractFacts, kind: PaymentKind, approvedOn: string | null): void {
  const reason = contractRefusal(contract, kind, approvedOn);
  if (reason !== undefined) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status, request_kind: kind, reason } });
}

/** The days of a plan year a payment may still be made in: until the end of the year, or the day an extension with a document reaches. */
export function disbursementEnd(planYear: number, extendedTo: string | null): string {
  return extendedTo ?? `${String(planYear).padStart(4, '0')}-12-31`;
}

/**
 * BR-PAY-14, the year of the plan: the line a request draws on has a plan year no earlier than the year of the acceptance, and is still open for disbursement on the day (its year is not over, or
 * an extension reaches it). 422 `PLAN_YEAR_MISMATCH` naming the reason otherwise.
 */
export function assertPlanYear(planYear: number, acceptanceYear: number | null, extendedTo: string | null, today: string): void {
  if (acceptanceYear !== null && planYear < acceptanceYear) {
    throw new DomainError('PLAN_YEAR_MISMATCH', 422, 'allocation_line_id', { extensions: { reason: 'BEFORE_ACCEPTANCE', plan_year: planYear, acceptance_year: acceptanceYear } });
  }
  const end = disbursementEnd(planYear, extendedTo);
  if (today > end) throw new DomainError('PLAN_YEAR_MISMATCH', 422, 'allocation_line_id', { extensions: { reason: 'DISBURSEMENT_CLOSED', plan_year: planYear, open_until: end } });
}
