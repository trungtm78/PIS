import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/** Amounts of the ledgers are VND in whole units (numeric(24,0)); a table with more digits says so with `scale`. */
export const VND_SCALE = 0;

const NON_NEGATIVE_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
/** Every amount column of the ledgers is numeric(24, scale): digits before and after the point together. */
export const MAX_AMOUNT_DIGITS = 24;

/**
 * Checks that a string is a positive amount with at most `scale` digits after the point and returns it unchanged. An amount
 * is never rounded on its way into a ledger: a value the column cannot hold exactly is refused, so no cent is created or lost.
 * An amount with more digits than the column holds is refused here too, so it is a 422 and not a numeric overflow of the database.
 */
export function requirePositiveAmount(amount: string, scale: number = VND_SCALE): string {
  if (typeof amount !== 'string' || !NON_NEGATIVE_DECIMAL.test(amount)) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  const [whole = '', fraction = ''] = amount.split('.');
  if (fraction.length > scale || whole.length + scale > MAX_AMOUNT_DIGITS || compareDecimal(amount, '0') <= 0) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  return amount;
}

/** The balance after paying out `amount`; refuses with 409 BALANCE_INSUFFICIENT when the balance would go below zero. */
export function debitAmount(balance: string, amount: string, scale: number = VND_SCALE): string {
  requirePositiveAmount(amount, scale);
  if (compareDecimal(balance, amount) < 0) throw new DomainError('BALANCE_INSUFFICIENT', 409, 'amount');
  return subtractDecimal(balance, amount);
}

/** The balance after receiving `amount`. */
export function creditAmount(balance: string, amount: string, scale: number = VND_SCALE): string {
  requirePositiveAmount(amount, scale);
  const total = addDecimal(balance, amount);
  // The sum must fit the column too, or the update would fail as a numeric overflow of the database.
  if ((total.split('.')[0] ?? '').length + scale > MAX_AMOUNT_DIGITS) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  return total;
}

/** A row that a command locks: `rank` orders the tables of one transaction, `key` the rows of one table. */
export interface LockTarget {
  rank: number;
  table: string;
  key: string;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The one order in which every transaction locks ledger rows (table rank, then table name, then key, compared as plain code
 * units so it never depends on a collation), without duplicates. Two transactions that lock the same rows in this order
 * cannot wait for each other in a cycle, so they never deadlock; a row asked for twice is locked once.
 */
export function orderLockTargets<T extends LockTarget>(targets: readonly T[]): T[] {
  const sorted = [...targets].sort((a, b) => a.rank - b.rank || compareText(a.table, b.table) || compareText(a.key, b.key));
  return sorted.filter((target, index) => {
    const previous = sorted[index - 1];
    return previous === undefined || previous.rank !== target.rank || previous.table !== target.table || previous.key !== target.key;
  });
}

/** An entry of an append-only ledger: `delta` is signed, a reversal points at the entry it cancels. */
export interface LedgerEntry {
  id: string;
  kind: string;
  delta: string;
  reversalOfId?: string;
}

function negate(delta: string): string {
  return subtractDecimal('0', delta);
}

/**
 * The entry that cancels `original`: the opposite delta and a pointer back to it. An entry is never edited or deleted, and a
 * reversal is itself final: reversing a reversal is refused, a new forward entry is posted instead.
 */
export function reverseEntry(original: LedgerEntry, reversalId: string, kind: string): LedgerEntry {
  if (original.reversalOfId !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'reversal');
  return { id: reversalId, kind, delta: negate(original.delta), reversalOfId: original.id };
}

/** Whether `reversal` cancels `original` exactly: it points at it and the two deltas add up to zero. */
export function reversalCancels(original: LedgerEntry, reversal: LedgerEntry): boolean {
  return reversal.reversalOfId === original.id && compareDecimal(addDecimal(original.delta, reversal.delta), '0') === 0;
}

/** The net of a list of entries, exactly. */
export function netOfEntries(entries: readonly LedgerEntry[]): string {
  return entries.reduce((total, entry) => addDecimal(total, entry.delta), '0');
}

/** The entries that are still in force: neither reversed by another entry nor a reversal themselves. */
export function entriesInForce(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const reversed = new Set(entries.flatMap((entry) => (entry.reversalOfId === undefined ? [] : [entry.reversalOfId])));
  return entries.filter((entry) => entry.reversalOfId === undefined && !reversed.has(entry.id));
}
