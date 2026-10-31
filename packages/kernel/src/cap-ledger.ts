/**
 * The capital ledger read as balances (ST-CAP-014, CAP 3.4, BR-CAP-06): every entry of the ledger moves one column of the balance of a line, up or down, and a reversal undoes the entry it reverses. The balance at a chosen
 * moment is therefore the sum of the entries posted up to it, which is what CAP-21 shows next to the entries. Pure functions of their input.
 */
export const LEDGER_COLUMNS = ['appropriated', 'allocated', 'reserved', 'committed', 'disbursed'] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];

export interface LedgerEffect {
  column: LedgerColumn;
  /** +1 adds the amount of the entry to the column, -1 takes it away. */
  sign: 1 | -1;
}

/** The column each kind of entry moves, and the way (the reversal has none of its own: it undoes the entry it reverses). */
const EFFECTS: Readonly<Record<string, LedgerEffect>> = {
  APPROPRIATE: { column: 'appropriated', sign: 1 },
  ALLOCATE: { column: 'allocated', sign: 1 },
  REDUCE: { column: 'allocated', sign: -1 },
  TRANSFER_IN: { column: 'allocated', sign: 1 },
  TRANSFER_OUT: { column: 'allocated', sign: -1 },
  EXTEND_IN: { column: 'allocated', sign: 1 },
  EXTEND_OUT: { column: 'allocated', sign: -1 },
  LAPSE: { column: 'allocated', sign: -1 },
  RESERVE: { column: 'reserved', sign: 1 },
  RELEASE: { column: 'reserved', sign: -1 },
  COMMIT: { column: 'committed', sign: 1 },
  UNCOMMIT: { column: 'committed', sign: -1 },
  DISBURSE: { column: 'disbursed', sign: 1 },
};

/** What an entry does to a balance: its own effect, or for a reversal the opposite of the effect of the entry type it reverses; none for an entry type the ledger does not know. */
export function ledgerEffect(entryType: string, reversedType: string | null): LedgerEffect | undefined {
  if (entryType === 'REVERSAL') {
    const original = reversedType === null ? undefined : EFFECTS[reversedType];
    return original === undefined ? undefined : { column: original.column, sign: original.sign === 1 ? -1 : 1 };
  }
  return EFFECTS[entryType];
}

export interface LedgerTotal {
  entryType: string;
  /** For a reversal, the type of the entry it reverses. */
  reversedType: string | null;
  /** The whole dong the entries of this kind add up to. */
  amountVnd: string;
}

/** The balance the entries add up to, column by column, in whole dong; an entry of a kind that moves no column adds nothing. */
export function foldBalance(totals: readonly LedgerTotal[]): Record<LedgerColumn, string> {
  const sums: Record<LedgerColumn, bigint> = { appropriated: 0n, allocated: 0n, reserved: 0n, committed: 0n, disbursed: 0n };
  for (const total of totals) {
    const effect = ledgerEffect(total.entryType, total.reversedType);
    if (effect !== undefined) sums[effect.column] += BigInt(effect.sign) * BigInt(total.amountVnd);
  }
  return { appropriated: sums.appropriated.toString(), allocated: sums.allocated.toString(), reserved: sums.reserved.toString(), committed: sums.committed.toString(), disbursed: sums.disbursed.toString() };
}
