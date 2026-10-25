import { DomainError } from './errors.ts';
import type { ContractStatus } from './contract-lifecycle.ts';

/**
 * What the suspension and the termination of a contract decide (ST-CTR-005, CTR 3.2, BR-PAY-09): the statuses in which new work may begin, how a guarantee is dealt with when a contract
 * ends, who proposed the end, the days the commands name and the suggestion of a violation that a termination leaves behind.
 */

/** The statuses in which new quantities and new advances may be recorded: a suspended or ended contract takes none (409 `CONTRACT_STATE_INVALID`). */
export const NEW_WORK_STATUSES: readonly ContractStatus[] = ['ACTIVE'];

export const acceptsNewWork = (status: ContractStatus): boolean => NEW_WORK_STATUSES.includes(status);

/** What a termination does with the performance guarantee: call it, release it against the decision, or leave it where it is until the settlement. */
export const GUARANTEE_ACTIONS = ['CALL', 'RELEASE', 'HOLD'] as const;
export type GuaranteeAction = (typeof GUARANTEE_ACTIONS)[number];

export const guaranteeActionOf = (value: unknown): GuaranteeAction | undefined => GUARANTEE_ACTIONS.find((action) => action === value);

/** The longest extension of the schedule a resumption may ask for, in days (ten years). An extension is a request only: the due date moves through an approved change. */
export const MAX_EXTENSION_DAYS = 3650;

/**
 * 403 `SELF_APPROVAL_DENIED` when the actor is one of the people who proposed the end of the contract: whoever made the decision document, and whoever drafted the contract or sent it
 * to review. The people are as the data says; the approver cannot choose them. Identifiers are compared as the lower-case text the database writes.
 */
export function assertNotProposer(actor: string, proposers: ReadonlyArray<string | null | undefined>): void {
  const who = actor.toLowerCase();
  if (proposers.some((proposer) => proposer !== null && proposer !== undefined && proposer.toLowerCase() === who)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/**
 * 422 `VALIDATION_FAILED` naming `field` unless `day` lies between `earliest` (when there is one) and `latest`, all as `YYYY-MM-DD` (which compare as text). The extensions say the
 * bounds, so the screen can show them.
 */
export function assertDayBetween(field: string, day: string, earliest: string | null, latest: string): void {
  if ((earliest !== null && day < earliest) || day > latest) {
    throw new DomainError('VALIDATION_FAILED', 422, field, { extensions: { earliest: earliest ?? null, latest } });
  }
}

/** The violation a termination suggests for the contractor: recorded for a person to confirm with a decision, never confirmed by the termination itself. */
export interface TerminationSuggestion {
  violationKind: 'OTHER';
  severity: 'MAJOR';
  penaltyKind: 'TERMINATION';
  penaltyAmountVnd: '0';
  occurredOn: string;
  description: string;
  decisionDocumentVersionId: string;
  sourceModule: 'CTR';
  sourceRefId: string;
}

export function terminationSuggestion(input: { contractId: string; terminatedOn: string; reason: string; decisionDocumentVersionId: string }): TerminationSuggestion {
  return {
    violationKind: 'OTHER',
    severity: 'MAJOR',
    penaltyKind: 'TERMINATION',
    penaltyAmountVnd: '0',
    occurredOn: input.terminatedOn,
    description: input.reason,
    decisionDocumentVersionId: input.decisionDocumentVersionId,
    sourceModule: 'CTR',
    sourceRefId: input.contractId,
  };
}
