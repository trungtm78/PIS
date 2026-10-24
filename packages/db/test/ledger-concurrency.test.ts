import { assertOneWinner, outcomeLabel, runConcurrently, runLoops, succeeded, tallyOutcomes } from '@machvon/kernel';
import type { CommandOutcome } from '@machvon/kernel';
import { Pool } from 'pg';
import { creditBalance, debitBalance, lockLedgerRows, transferBalance } from '../src/ledger-lock';
import type { BalanceRef } from '../src/ledger-lock';
import { TenantDatabase, runInTransaction } from '../src/tenant-database';
import type { TenantTx } from '../src/tenant-database';
import { withUniqueClaim } from '../src/unique-claim';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
let appPool: Pool;
let adminPool: Pool;
let tenants: TenantDatabase;

const FAMILY = 0x70;
const LOOPS = 100;
const MILLION = 1_000_000;
const BALANCE_ID = id(FAMILY, 1);
const OTHER_ID = id(FAMILY, 2);
const LEDGER_ID = id(FAMILY, 3);
const ACCEPTANCE_ID = id(FAMILY, 4);
const CONTRACT_ID = id(FAMILY, 5);
const PROJECT_ID = id(FAMILY, 6);

const ref = (rowId: string, column = 'allocated_vnd'): BalanceRef => ({ table: 'allocation_balance', id: rowId, column });
const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => tenants.withTenant(contextFor(tenant, memberId(1)), work);
const money = (millions: number): string => String(millions * MILLION);

/** Statements of the seed run as the privileged role with foreign keys off, so a test does not have to build the parents of a row. */
async function seed(statements: Array<[string, unknown[]?]>, tenant = TENANT_A): Promise<void> {
  await runInTransaction(adminPool, tenant, async (tx) => {
    await tx.query('set local session_replication_role = replica');
    for (const [text, params] of statements) await tx.query(text, params);
  });
}

const insertBalance = (rowId: string, allocated: string, tenant = TENANT_A): [string, unknown[]] => [
  `insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, version) values ($1, $2, $3, $4::numeric, 1)
   on conflict (tenant_id, id) do update set allocated_vnd = excluded.allocated_vnd, version = 1`,
  [tenant, rowId, rowId, allocated],
];

async function read(rowId: string, tenant = TENANT_A): Promise<{ allocated: string; version: string }> {
  const [row] = await harness.owner<{ allocated: string; version: string }>(tenant, [['select allocated_vnd::text as allocated, version::text as version from machvon.allocation_balance where id = $1', [rowId]]]);
  return row as { allocated: string; version: string };
}

beforeAll(async () => {
  await harness.start();
  appPool = new Pool({ connectionString: harness.database.urlFor('machvon_app'), max: 16 });
  adminPool = new Pool({ connectionString: harness.database.adminUrl, max: 8 });
  tenants = new TenantDatabase(appPool);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await harness.stop();
}, 60_000);

describe('concurrent spends of one balance (AC-ST-KERNEL-072-1)', () => {
  it('lets exactly one of two parallel spends of 150,000,000 out of 200,000,000 win, 100 times, and never goes negative (AC-ST-KERNEL-072-1)', async () => {
    const rounds = await runLoops({
      loops: LOOPS,
      reset: () => seed([insertBalance(BALANCE_ID, money(200))]),
      commands: () => ['key-a', 'key-b'].map(() => () => as((tx) => debitBalance(tx, ref(BALANCE_ID), money(150))).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['409 BALANCE_INSUFFICIENT', '409 VERSION_CONFLICT']);
        expect(await read(BALANCE_ID)).toEqual({ allocated: money(50), version: '2' });
      },
    });
    expect(rounds).toHaveLength(LOOPS);
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': LOOPS, '409 BALANCE_INSUFFICIENT': LOOPS });
  }, 180_000);

  it('answers 409 VERSION_CONFLICT to the spend that read an old version, 100 times (AC-ST-KERNEL-072-1)', async () => {
    const rounds = await runLoops({
      loops: LOOPS,
      reset: () => seed([insertBalance(BALANCE_ID, money(200))]),
      commands: () => [1, 2].map(() => () => as((tx) => debitBalance(tx, ref(BALANCE_ID), money(10), { expectedVersion: '1' })).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['409 VERSION_CONFLICT']);
        expect(await read(BALANCE_ID)).toEqual({ allocated: money(190), version: '2' });
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': LOOPS, '409 VERSION_CONFLICT': LOOPS });
  }, 180_000);

  it('serialises ten parallel spends so that exactly as many succeed as the balance can pay (AC-ST-KERNEL-072-1)', async () => {
    await runLoops({
      loops: 20,
      reset: () => seed([insertBalance(BALANCE_ID, money(200))]),
      commands: () => Array.from({ length: 10 }, () => () => as((tx) => debitBalance(tx, ref(BALANCE_ID), money(30))).then(() => undefined)),
      verify: async ({ outcomes }) => {
        expect(tallyOutcomes(outcomes)).toEqual({ '200': 6, '409 BALANCE_INSUFFICIENT': 4 });
        expect(await read(BALANCE_ID)).toEqual({ allocated: money(20), version: '7' });
      },
    });
  }, 180_000);

  it('keeps the total of two balances while opposite transfers run together, without a deadlock (AC-ST-KERNEL-072-1)', async () => {
    const rounds = await runLoops({
      loops: LOOPS,
      reset: () => seed([insertBalance(BALANCE_ID, money(100)), insertBalance(OTHER_ID, money(100))]),
      commands: () => [
        () => as((tx) => transferBalance(tx, ref(BALANCE_ID), ref(OTHER_ID), money(10))).then(() => undefined),
        () => as((tx) => transferBalance(tx, ref(OTHER_ID), ref(BALANCE_ID), money(25))).then(() => undefined),
        () => as((tx) => transferBalance(tx, ref(BALANCE_ID), ref(OTHER_ID), money(5))).then(() => undefined),
        () => as((tx) => transferBalance(tx, ref(OTHER_ID), ref(BALANCE_ID), money(15))).then(() => undefined),
      ],
      verify: async ({ outcomes }) => {
        expect(tallyOutcomes(outcomes)).toEqual({ '200': 4 });
        const [first, second] = [await read(BALANCE_ID), await read(OTHER_ID)];
        expect(BigInt(first.allocated) + BigInt(second.allocated)).toBe(BigInt(money(200)));
        expect(first.allocated).toBe(money(125));
      },
    });
    expect(rounds).toHaveLength(LOOPS);
  }, 240_000);

  it('would be caught by the harness if two transactions locked the same rows in opposite orders (AC-ST-KERNEL-072-1)', async () => {
    await seed([insertBalance(BALANCE_ID, money(100)), insertBalance(OTHER_ID, money(100))]);
    const lockInOrder = (first: string, second: string) => (): Promise<void> =>
      as(async (tx) => {
        await tx.query('select 1 from machvon.allocation_balance where id = $1::uuid for update', [first]);
        await tx.query('select pg_sleep(0.3)');
        await tx.query('select 1 from machvon.allocation_balance where id = $1::uuid for update', [second]);
      });
    const outcomes = await runConcurrently([lockInOrder(BALANCE_ID, OTHER_ID), lockInOrder(OTHER_ID, BALANCE_ID)]);
    expect(outcomes.map(outcomeLabel).sort()).toEqual(['200', expect.stringMatching(/^500 /)]);
  }, 60_000);
});

describe('row-lock ordering and balance operations (AC-ST-KERNEL-072-1)', () => {
  beforeAll(async () => {
    await seed([
      insertBalance(BALANCE_ID, money(200)),
      insertBalance(OTHER_ID, money(50)),
      [
        `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, created_by, updated_by)
         values ($1, $2, $3, $3, $3, $3, $3) on conflict do nothing`,
        [TENANT_A, LEDGER_ID, CONTRACT_ID],
      ],
    ]);
  });

  it('locks rows of several tables in the one order whatever order the command names them in (AC-ST-KERNEL-072-1)', async () => {
    const locked: string[] = [];
    await as(async (tx) => {
      const recording: TenantTx = {
        query: (sql, params) => {
          if (/for update/.test(sql)) locked.push(`${/machvon\.(\w+)/.exec(sql)?.[1]}:${String(params?.[0])}`);
          return tx.query(sql, params);
        },
      };
      await lockLedgerRows(recording, [
        { table: 'cumulative_ledger', id: LEDGER_ID },
        { table: 'allocation_balance', id: OTHER_ID },
        { table: 'allocation_balance', id: BALANCE_ID },
        { table: 'allocation_balance', id: OTHER_ID },
      ]);
    });
    expect(locked).toEqual([`allocation_balance:${BALANCE_ID}`, `allocation_balance:${OTHER_ID}`, `cumulative_ledger:${LEDGER_ID}`]);
  });

  it('answers 404 for a row that does not exist or belongs to another tenant, and refuses a table that is not a ledger (AC-ST-KERNEL-072-1)', async () => {
    await expect(as((tx) => lockLedgerRows(tx, [{ table: 'allocation_balance', id: id(FAMILY, 0x999) }]))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    await expect(as((tx) => lockLedgerRows(tx, [{ table: 'allocation_balance', id: BALANCE_ID }]), TENANT_B)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    await expect(as((tx) => debitBalance(tx, ref(id(FAMILY, 0x999)), money(1)))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    await expect(as((tx) => lockLedgerRows(tx, [{ table: 'contract', id: BALANCE_ID }]))).rejects.toThrow('contract is not a declared ledger table');
    await expect(as((tx) => debitBalance(tx, { table: 'capital_ledger_entry', id: BALANCE_ID, column: 'amount_vnd' }, '1'))).rejects.toThrow('not a balance column');
    await expect(as((tx) => debitBalance(tx, ref(BALANCE_ID, 'version'), '1'))).rejects.toThrow('not a balance column');
  });

  it('debits, credits and reports the new balance and version, exactly (AC-ST-KERNEL-072-1)', async () => {
    await seed([insertBalance(BALANCE_ID, money(200))]);
    expect(await as((tx) => debitBalance(tx, ref(BALANCE_ID), '1'))).toEqual({ balance: '199999999', version: '2' });
    expect(await as((tx) => creditBalance(tx, ref(BALANCE_ID), '1', { expectedVersion: '2' }))).toEqual({ balance: money(200), version: '3' });
    await expect(as((tx) => creditBalance(tx, ref(BALANCE_ID), '1', { expectedVersion: '2' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
      extensions: { current_version: '3' },
    });
    expect((await read(BALANCE_ID)).allocated).toBe(money(200));
  });

  it('refuses an amount the column cannot hold exactly instead of rounding it, and a spend above the balance (AC-ST-KERNEL-072-1)', async () => {
    await seed([insertBalance(BALANCE_ID, money(200))]);
    for (const amount of ['0', '-5', '1.5', 'abc']) {
      await expect(as((tx) => debitBalance(tx, ref(BALANCE_ID), amount))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    }
    await expect(as((tx) => debitBalance(tx, ref(BALANCE_ID), money(201)))).rejects.toMatchObject({ code: 'BALANCE_INSUFFICIENT', status: 409 });
    await expect(as((tx) => transferBalance(tx, ref(BALANCE_ID), ref(OTHER_ID), '2.5'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await read(BALANCE_ID)).allocated).toBe(money(200));
  });

  it('rolls a transfer back whole when the source cannot pay, so no amount is lost or created (AC-ST-KERNEL-072-1)', async () => {
    await seed([insertBalance(BALANCE_ID, money(10)), insertBalance(OTHER_ID, money(50))]);
    await expect(as((tx) => transferBalance(tx, ref(BALANCE_ID), ref(OTHER_ID), money(11)))).rejects.toMatchObject({ code: 'BALANCE_INSUFFICIENT' });
    expect([(await read(BALANCE_ID)).allocated, (await read(OTHER_ID)).allocated]).toEqual([money(10), money(50)]);
    const moved = await as((tx) => transferBalance(tx, ref(BALANCE_ID), ref(OTHER_ID), money(10)));
    expect([moved.from.balance, moved.to.balance]).toEqual(['0', money(60)]);
  });

  it('is stopped by the CHECK of the column when a writer skips the application check (AC-ST-KERNEL-072-1)', async () => {
    await seed([insertBalance(BALANCE_ID, money(5))]);
    await expect(as((tx) => tx.query('update machvon.allocation_balance set allocated_vnd = allocated_vnd - $2::numeric where id = $1::uuid', [BALANCE_ID, money(6)]))).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('two payment requests for one acceptance (AC-ST-KERNEL-072-2)', () => {
  const CLAIM = { constraint: 'payment_request_active_acceptance_uq', code: 'ACCEPTANCE_ALREADY_CLAIMED' };

  const insertRequest = (tx: TenantTx, requestId: string, key: string, status = 'SUBMITTED', claims = true): Promise<unknown[]> =>
    tx.query(
      `insert into machvon.payment_request
         (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no)
       values ($1, $2, $3, $4, $5, 'VND', 150000000, 0, 0, 0, 150000000, $6, 1, $7, $8)`,
      [TENANT_A, requestId, PROJECT_ID, CONTRACT_ID, ACCEPTANCE_ID, status, claims, key],
    );

  const claimAs = (key: string, requestId: string) => async (): Promise<CommandOutcome> => {
    await runInTransaction(adminPool, TENANT_A, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await withUniqueClaim(tx, CLAIM, () => insertRequest(tx, requestId, key));
    });
    return succeeded();
  };

  const requestsOf = async (): Promise<number> => {
    const [row] = await harness.owner<{ n: string }>(TENANT_A, [['select count(*)::text as n from machvon.payment_request where acceptance_id = $1 and claims_acceptance', [ACCEPTANCE_ID]]]);
    return Number(row?.n);
  };

  it('lets one succeed and answers the other 409 ACCEPTANCE_ALREADY_CLAIMED with the unique index intact, 100 times (AC-ST-KERNEL-072-2)', async () => {
    const rounds = await runLoops({
      loops: LOOPS,
      reset: () => seed([['delete from machvon.payment_request where acceptance_id = $1', [ACCEPTANCE_ID]]]),
      commands: (loop) => [claimAs(`key-${loop}-a`, id(FAMILY, 0x1000 + loop * 2)), claimAs(`key-${loop}-b`, id(FAMILY, 0x1001 + loop * 2))],
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['409 ACCEPTANCE_ALREADY_CLAIMED']);
        expect(await requestsOf()).toBe(1);
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': LOOPS, '409 ACCEPTANCE_ALREADY_CLAIMED': LOOPS });
    const [index] = await harness.owner<{ def: string }>(TENANT_A, [["select indexdef as def from pg_indexes where indexname = 'payment_request_active_acceptance_uq'"]]);
    expect(index?.def).toContain('UNIQUE');
  }, 240_000);

  it('keeps the transaction usable after the refusal and lets the acceptance be claimed again once the claim is released (AC-ST-KERNEL-072-2)', async () => {
    await seed([['delete from machvon.payment_request where acceptance_id = $1', [ACCEPTANCE_ID]]]);
    await runInTransaction(adminPool, TENANT_A, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await withUniqueClaim(tx, CLAIM, () => insertRequest(tx, id(FAMILY, 0x20), 'first'));
      await expect(withUniqueClaim(tx, CLAIM, () => insertRequest(tx, id(FAMILY, 0x21), 'second'))).rejects.toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED', status: 409 });
      expect(await tx.query('select 1 as ok')).toEqual([{ ok: 1 }]);
      await tx.query('update machvon.payment_request set status = $2, claims_acceptance = false where id = $1', [id(FAMILY, 0x20), 'CANCELLED']);
      await withUniqueClaim(tx, CLAIM, () => insertRequest(tx, id(FAMILY, 0x22), 'third'));
    });
    expect(await requestsOf()).toBe(1);
  });

  it('passes on a failure that is not the claim: another constraint, or the work itself (AC-ST-KERNEL-072-2)', async () => {
    await seed([['delete from machvon.payment_request where acceptance_id = $1', [ACCEPTANCE_ID]]]);
    const other = { constraint: 'some_other_uq', code: 'OTHER' };
    const failure = runInTransaction(adminPool, TENANT_A, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await insertRequest(tx, id(FAMILY, 0x30), 'one');
      await withUniqueClaim(tx, other, () => insertRequest(tx, id(FAMILY, 0x31), 'two'));
    });
    await expect(failure).rejects.toMatchObject({ code: '23505', constraint: 'payment_request_active_acceptance_uq' });
    await expect(runInTransaction(adminPool, TENANT_A, (tx) => withUniqueClaim(tx, CLAIM, () => Promise.reject(new TypeError('boom'))))).rejects.toThrow('boom');
    await expect(runInTransaction(adminPool, TENANT_A, (tx) => withUniqueClaim(tx, CLAIM, () => Promise.reject(undefined)))).rejects.toBeUndefined();
    await expect(
      runInTransaction(adminPool, TENANT_A, async (tx) => {
        await tx.query('set local session_replication_role = replica');
        await insertRequest(tx, id(FAMILY, 0x32), 'three');
        await withUniqueClaim(tx, { ...CLAIM, status: 422 }, () => insertRequest(tx, id(FAMILY, 0x33), 'four'));
      }),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED', status: 422 });
  });
});
