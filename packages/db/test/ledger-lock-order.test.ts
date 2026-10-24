import { lockLedgerRows } from '../src/ledger-lock';
import type { TenantTx } from '../src/tenant-database';

const LOWER = 'a0000000-0000-4000-8000-000000000001';
const UPPER_OTHER = 'B0000000-0000-4000-8000-000000000002';

/** A transaction that records the rows it is asked to lock, in order, and finds each of them. */
function recorder(): { tx: TenantTx; locked: string[] } {
  const locked: string[] = [];
  const tx: TenantTx = {
    query: (_sql, params) => {
      locked.push(String(params?.[0]));
      return Promise.resolve([{ ok: 1 }] as never);
    },
  };
  return { tx, locked };
}

describe('lockLedgerRows (the one lock order, AC-ST-KERNEL-072-1)', () => {
  it('orders rows by their id as the database prints it, so an id written in capitals is locked where the same id in small letters is', async () => {
    // As typed, 'B...' (66) sorts before 'a...' (97); as the uuid type prints it, 'b...' sorts after 'a...'. Two commands that name the
    // same two rows in the two spellings would lock them in opposite orders, which is the deadlock the order exists to prevent.
    const capitals = recorder();
    await lockLedgerRows(capitals.tx, [
      { table: 'allocation_balance', id: UPPER_OTHER },
      { table: 'allocation_balance', id: LOWER },
    ]);
    const small = recorder();
    await lockLedgerRows(small.tx, [
      { table: 'allocation_balance', id: LOWER },
      { table: 'allocation_balance', id: UPPER_OTHER.toLowerCase() },
    ]);
    expect(capitals.locked).toEqual([LOWER, UPPER_OTHER.toLowerCase()]);
    expect(capitals.locked).toEqual(small.locked);
  });

  it('locks a row named twice, once in each spelling, only once', async () => {
    const { tx, locked } = recorder();
    await lockLedgerRows(tx, [
      { table: 'allocation_balance', id: UPPER_OTHER },
      { table: 'allocation_balance', id: UPPER_OTHER.toLowerCase() },
    ]);
    expect(locked).toEqual([UPPER_OTHER.toLowerCase()]);
  });
});
