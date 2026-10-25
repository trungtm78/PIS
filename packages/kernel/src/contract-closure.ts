import { compareDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The closure of a contract after its completion or its termination (ST-CTR-012, CTR 3.1 step 7, state machine of section 4, UAT-AC300): what stands between the contract and the status CLOSED. A
 * contract is closed only when its settlement is closed, when no advance is left unrecovered unless the settlement closed with an approved exception, and when the retention is resolved: released,
 * or carried by the warranty that has not ended. Pure functions of their input, kept apart from the database.
 */

export const CLOSURE_GUARDS = ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'] as const;
export type ClosureGuard = (typeof CLOSURE_GUARDS)[number];

/** What a closure is judged on, read from the database inside the transaction of the command. */
export interface ClosureFacts {
  /** The settlement the command names (or, for the readiness, the latest one that could serve); undefined when there is none. */
  settlement: { status: string; excepted: boolean } | undefined;
  /** What was paid out as advance less what was recovered, whole VND. */
  advanceOutstandingVnd: string;
  /** The holds of retention with something still held that nothing carries, and what is held in them. */
  retention: { holds: number; unresolvedVnd: string };
}

/** The guards that are not met, in the order they are told: the settlement, then the advance, then the retention. */
export function unmetClosureGuards(facts: ClosureFacts): ClosureGuard[] {
  const unmet: ClosureGuard[] = [];
  const settled = facts.settlement?.status === 'CLOSED';
  if (!settled) unmet.push('SETTLEMENT_NOT_CLOSED');
  // An advance still owed is accepted only when the settlement that closed carries the exception approved for it.
  if (compareDecimal(facts.advanceOutstandingVnd, '0') > 0 && !(settled && facts.settlement?.excepted === true)) unmet.push('ADVANCE_OUTSTANDING');
  if (facts.retention.holds > 0) unmet.push('RETENTION_UNRESOLVED');
  return unmet;
}

/**
 * 422 with the code of the first guard that is not met (and the list of all of them in `unmet`), unless the contract may be closed. The state of the contract does not change on a refusal.
 */
export function assertContractClosure(facts: ClosureFacts): void {
  const unmet = unmetClosureGuards(facts);
  const first = unmet[0];
  if (first === undefined) return;
  const details: Record<ClosureGuard, Record<string, unknown>> = {
    SETTLEMENT_NOT_CLOSED: { settlement_status: facts.settlement?.status ?? null },
    ADVANCE_OUTSTANDING: { advance_outstanding_vnd: facts.advanceOutstandingVnd },
    RETENTION_UNRESOLVED: { retention_holds: facts.retention.holds, retention_unresolved_vnd: facts.retention.unresolvedVnd },
  };
  throw new DomainError(first, 422, 'id', { extensions: { ...details[first], unmet } });
}
