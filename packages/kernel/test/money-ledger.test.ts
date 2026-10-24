import * as fc from 'fast-check';
import { DomainError } from '../src/errors';
import { compareDecimal } from '../src/decimal';
import {
  creditAmount,
  debitAmount,
  entriesInForce,
  netOfEntries,
  orderLockTargets,
  requirePositiveAmount,
  reversalCancels,
  reverseEntry,
} from '../src/money-ledger';
import type { LedgerEntry, LockTarget } from '../src/money-ledger';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('amounts of a ledger (integer VND)', () => {
  it('accepts a positive whole amount and nothing else', () => {
    expect(requirePositiveAmount('150000000')).toBe('150000000');
    for (const bad of ['0', '-5', '1.5', '1.0', '01', '', '1e3', ' 5', 'abc']) {
      expect(refusal(() => requirePositiveAmount(bad))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount' });
    }
    expect(refusal(() => requirePositiveAmount(150 as unknown as string))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts as many digits after the point as the column holds, never rounding', () => {
    expect(requirePositiveAmount('12.34', 2)).toBe('12.34');
    expect(refusal(() => requirePositiveAmount('12.345', 2)).code).toBe('VALIDATION_FAILED');
  });

  it('pays out down to zero and refuses 409 BALANCE_INSUFFICIENT below it', () => {
    expect(debitAmount('200000000', '150000000')).toBe('50000000');
    expect(debitAmount('50000000', '50000000')).toBe('0');
    expect(refusal(() => debitAmount('50000000', '150000000'))).toMatchObject({ code: 'BALANCE_INSUFFICIENT', status: 409 });
    expect(creditAmount('50000000', '150000000')).toBe('200000000');
  });

  it('never lets a sequence of valid debits and credits leave the balance negative or off the exact sum', () => {
    const steps = fc.array(fc.tuple(fc.boolean(), fc.bigInt({ min: 1n, max: 10n ** 12n })), { maxLength: 40 });
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), steps, (start, moves) => {
        let balance = start.toString();
        let expected = start;
        for (const [credit, amount] of moves) {
          if (credit) {
            balance = creditAmount(balance, amount.toString());
            expected += amount;
          } else if (expected >= amount) {
            balance = debitAmount(balance, amount.toString());
            expected -= amount;
          } else {
            expect(() => debitAmount(balance, amount.toString())).toThrow();
          }
          expect(balance).toBe(expected.toString());
          expect(compareDecimal(balance, '0')).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('the order in which rows are locked', () => {
  const target = (rank: number, table: string, key: string): LockTarget => ({ rank, table, key });

  it('sorts by table rank, table name and key, and locks a row asked for twice once', () => {
    const ordered = orderLockTargets([target(2, 'b', 'k2'), target(1, 'z', 'k9'), target(2, 'a', 'k5'), target(2, 'b', 'k1'), target(1, 'z', 'k9')]);
    expect(ordered.map((entry) => `${entry.rank}.${entry.table}.${entry.key}`)).toEqual(['1.z.k9', '2.a.k5', '2.b.k1', '2.b.k2']);
  });

  it('gives the same order whatever order the command asks in (so two transactions cannot wait for each other)', () => {
    const targets = fc.array(fc.record({ rank: fc.integer({ min: 0, max: 3 }), table: fc.constantFrom('x', 'y'), key: fc.string({ maxLength: 3 }) }), { maxLength: 12 });
    fc.assert(
      fc.property(targets, fc.integer(), (list, seed) => {
        const shuffled = [...list].sort((a, b) => ((a.key.length * 31 + seed) % 7) - ((b.key.length * 17 + seed) % 7));
        expect(orderLockTargets(shuffled)).toEqual(orderLockTargets(list));
      }),
      { numRuns: 100 },
    );
  });

  it('does not touch the list it is given', () => {
    const list = [target(2, 'b', 'k'), target(1, 'a', 'k')];
    orderLockTargets(list);
    expect(list.map((entry) => entry.rank)).toEqual([2, 1]);
  });
});

describe('reversal entries', () => {
  const claim: LedgerEntry = { id: 'e1', kind: 'CLAIM', delta: '150000000' };

  it('cancels the original exactly, points back at it and keeps the net of the pair at zero', () => {
    const reversal = reverseEntry(claim, 'e2', 'CLAIM_RELEASE');
    expect(reversal).toEqual({ id: 'e2', kind: 'CLAIM_RELEASE', delta: '-150000000', reversalOfId: 'e1' });
    expect(reversalCancels(claim, reversal)).toBe(true);
    expect(netOfEntries([claim, reversal])).toBe('0');
  });

  it('is not a reversal of anything else, and a reversal cannot be reversed again', () => {
    const reversal = reverseEntry(claim, 'e2', 'CLAIM_RELEASE');
    expect(reversalCancels({ ...claim, id: 'other' }, reversal)).toBe(false);
    expect(reversalCancels(claim, { ...reversal, delta: '-1' })).toBe(false);
    expect(refusal(() => reverseEntry(reversal, 'e3', 'CLAIM'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reversal' });
  });

  it('leaves in force only the entries that nothing reversed', () => {
    const second: LedgerEntry = { id: 'e3', kind: 'CLAIM', delta: '10' };
    const entries = [claim, second, reverseEntry(claim, 'e2', 'CLAIM_RELEASE')];
    expect(entriesInForce(entries).map((entry) => entry.id)).toEqual(['e3']);
    expect(netOfEntries(entriesInForce(entries))).toBe(netOfEntries(entries));
  });

  it('preserves the total whatever mix of entries is reversed', () => {
    const delta = fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }).map((value) => value.toString());
    fc.assert(
      fc.property(fc.array(fc.tuple(delta, fc.boolean()), { maxLength: 20 }), (items) => {
        const entries: LedgerEntry[] = items.map(([amount], index) => ({ id: `f${index}`, kind: 'POST', delta: amount }));
        const reversals = items.flatMap(([, reversed], index) => (reversed ? [reverseEntry(entries[index] as LedgerEntry, `r${index}`, 'UNDO')] : []));
        const all = [...entries, ...reversals];
        expect(netOfEntries(entriesInForce(all))).toBe(netOfEntries(all));
      }),
      { numRuns: 100 },
    );
  });
});
