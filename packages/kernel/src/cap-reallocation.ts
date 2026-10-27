import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The reallocation of capital from slow to fast projects (ST-CAP-010, CAP 3.1 F5, BR-CAP-07): a proposal moves whole amounts from a line of the plan in force to another project that holds a line of the same
 * appropriation, so the total of the appropriation never changes. The states, the decisions and the arithmetic of the floor are here, with no store or clock of their own.
 */
export const REALLOCATION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED', 'REJECTED', 'WITHDRAWN'] as const;
export type ReallocationStatus = (typeof REALLOCATION_STATUSES)[number];
export const REALLOCATION_DECISIONS = ['approve', 'reject', 'return'] as const;
export type ReallocationDecision = (typeof REALLOCATION_DECISIONS)[number];

/** A whole positive amount in VND, as the contract writes it (a decimal string without sign or fraction). */
const POSITIVE_VND = /^[1-9][0-9]{0,23}$/;

/** The amount of a line of a proposal; anything that is not a whole positive number of dong is a fault of the request (422 VALIDATION_FAILED). */
export function positiveVnd(value: unknown, field: string): string {
  if (typeof value !== 'string' || !POSITIVE_VND.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The status a decision gives a proposal that waits for it: approve makes it APPROVED, reject closes it (REJECTED) and return sends it back to its author (DRAFT) to be changed and submitted again. A
 * proposal that is not waiting is 409 STAGE_TRANSITION_DENIED.
 */
export function decidedReallocation(status: ReallocationStatus, decision: ReallocationDecision): ReallocationStatus {
  if (status !== 'SUBMITTED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { reallocation_status: status } });
  return decision === 'approve' ? 'APPROVED' : decision === 'reject' ? 'REJECTED' : 'DRAFT';
}

/** What a line of the plan holds: the amount allocated and what is already spoken for on it. */
export interface LineHold {
  allocatedVnd: string;
  reservedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
}

/** A line that a proposal would reduce below what is spoken for on it. */
export interface BelowFloor {
  lineId: string;
  allocatedVnd: string;
  reducedVnd: string;
  floorVnd: string;
}

/** The sum of the reductions of each line: a line may be named by more than one line of the proposal. */
export function reductionsOf(lines: ReadonlyArray<{ fromLineId: string; amountVnd: string }>): Map<string, string> {
  const total = new Map<string, string>();
  for (const line of lines) total.set(line.fromLineId, addDecimal(total.get(line.fromLineId) ?? '0', line.amountVnd));
  return total;
}

/**
 * What each line loses in the end: what it gives less what it receives in the same proposal, for the lines that lose (a line that gives and receives is judged by the difference, as the revision that is made leaves it).
 */
export function netReductions(lines: ReadonlyArray<{ fromLineId: string; toLineId: string; amountVnd: string }>): Map<string, string> {
  const net = new Map<string, string>();
  for (const line of lines) {
    net.set(line.fromLineId, addDecimal(net.get(line.fromLineId) ?? '0', line.amountVnd));
    net.set(line.toLineId, subtractDecimal(net.get(line.toLineId) ?? '0', line.amountVnd));
  }
  return new Map([...net].filter(([, amount]) => compareDecimal(amount, '0') > 0));
}

/**
 * The lines that would end below what is reserved, committed and disbursed on them (BR-CAP-05): a donor line keeps at least that much. A line the proposal reduces and that has no balance row yet has nothing
 * spoken for and holds what the plan gave it.
 */
export function belowFloor(reductions: ReadonlyMap<string, string>, holds: ReadonlyMap<string, LineHold>): BelowFloor[] {
  const found: BelowFloor[] = [];
  for (const [lineId, reduced] of reductions) {
    const hold = holds.get(lineId);
    if (hold === undefined) continue;
    const floor = addDecimal(addDecimal(hold.reservedVnd, hold.committedVnd), hold.disbursedVnd);
    if (compareDecimal(reduced, hold.allocatedVnd) > 0 || compareDecimal(subtractDecimal(hold.allocatedVnd, reduced), floor) < 0) found.push({ lineId, allocatedVnd: hold.allocatedVnd, reducedVnd: reduced, floorVnd: floor });
  }
  return found.sort((a, b) => (a.lineId < b.lineId ? -1 : 1));
}
