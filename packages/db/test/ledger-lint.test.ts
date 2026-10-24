import { resolve } from 'node:path';
import { Client } from 'pg';
import { LEDGER_TABLES, ledgerDeclaration, ledgerScale } from '../src/ledger-registry';
import type { LedgerDeclaration } from '../src/ledger-registry';
import { ledgerReport, readLedgerCatalog } from '../src/ledger-lint';
import type { LedgerCatalog, LedgerCatalogTable, LedgerFailure } from '../src/ledger-lint';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedTestDatabase(REPO_ROOT);
}, 180_000);

afterAll(async () => {
  await database.stop();
}, 60_000);

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const balance: LedgerDeclaration = {
  table: 'wallet_balance',
  kind: 'BALANCE',
  lockRank: 1,
  nonNegative: ['amount_vnd', 'held_vnd'],
  businessKey: { columns: ['owner_id'] },
  versionColumn: 'version',
};
const entry: LedgerDeclaration = {
  table: 'wallet_ledger_entry',
  kind: 'ENTRY',
  lockRank: 2,
  nonNegative: ['amount_vnd'],
  businessKey: { columns: ['reversal_of_id'], partial: true },
};

function balanceTable(overrides: Partial<LedgerCatalogTable> = {}): LedgerCatalogTable {
  return {
    name: 'wallet_balance',
    columns: ['tenant_id', 'id', 'owner_id', 'amount_vnd', 'held_vnd', 'version'],
    checks: [{ name: 'wallet_balance_chk', definition: 'CHECK (((amount_vnd >= (0)::numeric) AND (held_vnd >= (0)::numeric)))', validated: true }],
    uniqueIndexes: [
      { name: 'wallet_balance_pkey', columns: ['tenant_id', 'id'], partial: false },
      { name: 'wallet_balance_owner_uq', columns: ['tenant_id', 'owner_id'], partial: false },
    ],
    appUpdate: true,
    appDelete: false,
    ...overrides,
  };
}

function entryTable(overrides: Partial<LedgerCatalogTable> = {}): LedgerCatalogTable {
  return {
    name: 'wallet_ledger_entry',
    columns: ['tenant_id', 'id', 'amount_vnd', 'reversal_of_id'],
    checks: [{ name: 'wallet_entry_chk', definition: 'CHECK ((amount_vnd > (0)::numeric))', validated: true }],
    uniqueIndexes: [
      { name: 'wallet_entry_pkey', columns: ['tenant_id', 'id'], partial: false },
      { name: 'wallet_entry_reversal_uq', columns: ['tenant_id', 'reversal_of_id'], partial: true },
    ],
    appUpdate: false,
    appDelete: false,
    ...overrides,
  };
}

const failuresOf = (tables: LedgerCatalogTable[], declarations: readonly LedgerDeclaration[] = [balance, entry]): LedgerFailure[] =>
  ledgerReport({ tables }, declarations).failures;

describe('ledger lint over the real schema (AC-ST-KERNEL-072-3)', () => {
  it('finds every ledger table of the schema declared and fully guarded by the database (AC-ST-KERNEL-072-3)', async () => {
    const catalog = await readLedgerCatalog(database.adminUrl);
    const report = ledgerReport(catalog, LEDGER_TABLES);
    expect(report.failures).toEqual([]);
    expect(report.ledgerTables).toBe(LEDGER_TABLES.length);
    const named = catalog.tables.filter((table) => /(^|_)(ledger|balance)(_entry)?$/.test(table.name)).map((table) => table.name);
    expect(named.sort()).toEqual(LEDGER_TABLES.map((declaration) => declaration.table).sort());
  });

  it('fails when the non-negative CHECK of a balance column is dropped from the database (AC-ST-KERNEL-072-3)', async () => {
    const name = 'allocation_balance_reserved_vnd_check';
    const before = await admin((client) => client.query('select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1', [name]));
    expect(before.rowCount).toBe(1);
    const definition = (before.rows[0] as { def: string }).def;
    await admin((client) => client.query(`alter table machvon.allocation_balance drop constraint ${name}`));
    try {
      const failures = ledgerReport(await readLedgerCatalog(database.adminUrl), LEDGER_TABLES).failures;
      expect(failures).toEqual([{ table: 'allocation_balance', reason: 'no_non_negative_check', column: 'reserved_vnd' }]);
    } finally {
      await admin((client) => client.query(`alter table machvon.allocation_balance add constraint ${name} ${definition}`));
    }
    expect(ledgerReport(await readLedgerCatalog(database.adminUrl), LEDGER_TABLES).failures).toEqual([]);
  });

  it('fails when a new table named like a ledger is not declared (AC-ST-KERNEL-072-3)', async () => {
    await admin((client) => client.query('create table machvon.escrow_balance (tenant_id uuid not null, id uuid not null, amount_vnd numeric(24,0) not null, primary key (tenant_id, id))'));
    try {
      const failures = ledgerReport(await readLedgerCatalog(database.adminUrl), LEDGER_TABLES).failures;
      expect(failures).toEqual([{ table: 'escrow_balance', reason: 'undeclared_ledger' }]);
    } finally {
      await admin((client) => client.query('drop table machvon.escrow_balance'));
    }
  });

  it('reads a NOT VALID check as unvalidated and a partial unique index as partial (AC-ST-KERNEL-072-3)', async () => {
    await admin((client) => client.query('create table machvon.probe_ledger (tenant_id uuid not null, id uuid not null, amount_vnd numeric(24,0) not null, ref uuid, primary key (tenant_id, id))'));
    try {
      await admin((client) => client.query('alter table machvon.probe_ledger add constraint probe_amount_chk check (amount_vnd >= 0) not valid'));
      await admin((client) => client.query('create unique index probe_ref_uq on machvon.probe_ledger (tenant_id, ref) where ref is not null'));
      const probe = (await readLedgerCatalog(database.adminUrl)).tables.find((table) => table.name === 'probe_ledger') as LedgerCatalogTable;
      expect(probe.checks).toEqual([{ name: 'probe_amount_chk', definition: 'CHECK ((amount_vnd >= (0)::numeric)) NOT VALID', validated: false }]);
      expect(probe.uniqueIndexes).toEqual([
        { name: 'probe_ledger_pkey', columns: ['tenant_id', 'id'], partial: false },
        { name: 'probe_ref_uq', columns: ['tenant_id', 'ref'], partial: true },
      ]);
    } finally {
      await admin((client) => client.query('drop table machvon.probe_ledger'));
    }
  });
});

describe('ledger lint rules (AC-ST-KERNEL-072-3)', () => {
  it('passes a balance and an entry table that carry every guard (AC-ST-KERNEL-072-3)', () => {
    expect(failuresOf([balanceTable(), entryTable()])).toEqual([]);
  });

  it('requires a validated CHECK without an OR on each amount column (AC-ST-KERNEL-072-3)', () => {
    const only = (definition: string, validated = true): LedgerFailure[] =>
      failuresOf([balanceTable({ checks: [{ name: 'c', definition, validated }] }), entryTable()]).filter((failure) => failure.table === 'wallet_balance');
    expect(only('CHECK ((amount_vnd >= (0)::numeric))')).toEqual([{ table: 'wallet_balance', reason: 'no_non_negative_check', column: 'held_vnd' }]);
    expect(only('CHECK ((amount_vnd >= (0)::numeric) AND (held_vnd > (0)::numeric))')).toEqual([]);
    expect(only('CHECK (((amount_vnd >= (0)::numeric) OR (held_vnd >= (0)::numeric)))').map((failure) => failure.column)).toEqual(['amount_vnd', 'held_vnd']);
    expect(only('CHECK (((amount_vnd >= (0)::numeric) AND (held_vnd >= (0)::numeric)))', false).map((failure) => failure.column)).toEqual(['amount_vnd', 'held_vnd']);
    expect(only('CHECK ((amount_vnd >= (held_vnd + (1)::numeric)))').map((failure) => failure.column)).toEqual(['amount_vnd', 'held_vnd']);
    expect(only('CHECK (((not_amount_vnd >= (0)::numeric) AND (held_vnd >= 0)))').map((failure) => failure.column)).toEqual(['amount_vnd']);
  });

  it('requires a unique business key, partial exactly when declared (AC-ST-KERNEL-072-3)', () => {
    const owner = { name: 'wallet_balance_owner_uq', columns: ['tenant_id', 'owner_id'], partial: false };
    const pkey = { name: 'wallet_balance_pkey', columns: ['tenant_id', 'id'], partial: false };
    expect(failuresOf([balanceTable({ uniqueIndexes: [pkey] }), entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'no_business_key' }]);
    expect(failuresOf([balanceTable({ uniqueIndexes: [pkey, { ...owner, partial: true }] }), entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'no_business_key' }]);
    expect(failuresOf([balanceTable({ uniqueIndexes: [pkey, { ...owner, columns: ['owner_id'] }] }), entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'no_business_key' }]);
    const reversal = { name: 'wallet_entry_reversal_uq', columns: ['tenant_id', 'reversal_of_id'], partial: false };
    expect(failuresOf([balanceTable(), entryTable({ uniqueIndexes: [{ name: 'wallet_entry_pkey', columns: ['tenant_id', 'id'], partial: false }, reversal] })])).toEqual([
      { table: 'wallet_ledger_entry', reason: 'no_business_key' },
    ]);
  });

  it('requires a unique (tenant_id, id) to lock a row by and a lock rank of its own (AC-ST-KERNEL-072-3)', () => {
    const owner = { name: 'wallet_balance_owner_uq', columns: ['tenant_id', 'owner_id'], partial: false };
    expect(failuresOf([balanceTable({ uniqueIndexes: [owner] }), entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'no_lock_key' }]);
    expect(failuresOf([balanceTable(), entryTable()], [balance, { ...entry, lockRank: 1 }])).toEqual([{ table: 'wallet_ledger_entry', reason: 'duplicate_lock_rank' }]);
  });

  it('requires an entry table to be append-only for the application role (AC-ST-KERNEL-072-3)', () => {
    expect(failuresOf([balanceTable(), entryTable({ appUpdate: true })])).toEqual([{ table: 'wallet_ledger_entry', reason: 'entry_not_append_only' }]);
    expect(failuresOf([balanceTable(), entryTable({ appDelete: true })])).toEqual([{ table: 'wallet_ledger_entry', reason: 'entry_not_append_only' }]);
  });

  it('names a declared table or column that the schema does not have (AC-ST-KERNEL-072-3)', () => {
    expect(failuresOf([entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'declared_table_missing' }]);
    const without = balanceTable({ columns: ['tenant_id', 'id', 'owner_id', 'amount_vnd', 'held_vnd'] });
    expect(failuresOf([without, entryTable()])).toEqual([{ table: 'wallet_balance', reason: 'unknown_column', column: 'version' }]);
  });

  it('flags a table that looks like a ledger by its name and is not declared (AC-ST-KERNEL-072-3)', () => {
    const names = ['pool_balance', 'x_ledger', 'x_ledger_entry', 'ledger', 'ledger_note'];
    const catalog: LedgerCatalog = { tables: [balanceTable(), entryTable(), ...names.map((name) => balanceTable({ name }))] };
    expect(ledgerReport(catalog, [balance, entry]).failures).toEqual(['pool_balance', 'x_ledger', 'x_ledger_entry', 'ledger'].map((table) => ({ table, reason: 'undeclared_ledger' })));
  });
});

describe('ledger registry (AC-ST-KERNEL-072-3)', () => {
  it('uses safe identifiers, one lock rank per table and one declaration per table (AC-ST-KERNEL-072-3)', () => {
    const identifier = /^[a-z][a-z0-9_]*$/;
    for (const declaration of LEDGER_TABLES) {
      const names = [declaration.table, ...declaration.nonNegative, ...declaration.businessKey.columns, ...(declaration.versionColumn === undefined ? [] : [declaration.versionColumn])];
      expect(names.every((name) => identifier.test(name))).toBe(true);
      expect(declaration.nonNegative.length).toBeGreaterThan(0);
    }
    expect(new Set(LEDGER_TABLES.map((declaration) => declaration.lockRank)).size).toBe(LEDGER_TABLES.length);
    expect(new Set(LEDGER_TABLES.map((declaration) => declaration.table)).size).toBe(LEDGER_TABLES.length);
  });

  it('finds a declaration by table name and defaults the amounts to whole VND (AC-ST-KERNEL-072-3)', () => {
    expect(ledgerDeclaration('allocation_balance')?.kind).toBe('BALANCE');
    expect(ledgerDeclaration('contract')).toBeUndefined();
    expect(ledgerScale(balance)).toBe(0);
    expect(ledgerScale({ ...balance, scale: 8 })).toBe(8);
  });
});
