import { VND_SCALE } from '@machvon/kernel';

/** A balance is updated in place under a row lock; an entry is appended once and never changed (it is reversed by another entry). */
export type LedgerKind = 'BALANCE' | 'ENTRY';

/** A unique index on `(tenant_id, ...columns)` that stops the same business fact from being posted twice. */
export interface BusinessKey {
  columns: readonly string[];
  /** True when the key is a partial index on purpose (a reversal is unique where it exists); a key that is partial by accident does not count. */
  partial?: boolean;
}

export interface LedgerDeclaration {
  table: string;
  kind: LedgerKind;
  /**
   * The place of the table in the one lock order of the product: a transaction that locks rows of several ledger tables locks
   * the table with the lower rank first (see orderLockTargets), so two transactions never wait for each other in a cycle.
   * Every rank is used once.
   */
  lockRank: number;
  /** Columns that hold an amount that can never be below zero: each needs a validated CHECK in the database. */
  nonNegative: readonly string[];
  businessKey: BusinessKey;
  /** Digits after the point of the amount columns (0 for whole VND). */
  scale?: number;
  /** The row version of a balance, bumped by every change (the If-Match counter). */
  versionColumn?: string;
}

/** Rows are locked by their primary key `(tenant_id, id)`: the tenant comes from row-level security, the `id` from the command. */
export const LEDGER_LOCK_COLUMN = 'id';

/**
 * The ledger tables of the product. A table named `*_ledger`, `*_ledger_entry` or `*_balance` that is not listed here fails the
 * ledger lint; a slice that adds a ledger declares it here, with the CHECK constraints, unique key and lock rank it relies on.
 */
export const LEDGER_TABLES: readonly LedgerDeclaration[] = [
  {
    table: 'allocation_balance',
    kind: 'BALANCE',
    lockRank: 10,
    nonNegative: ['allocated_vnd', 'reserved_vnd', 'committed_vnd', 'disbursed_vnd'],
    businessKey: { columns: ['allocation_line_id'] },
    versionColumn: 'version',
  },
  {
    table: 'cumulative_ledger',
    kind: 'BALANCE',
    lockRank: 20,
    nonNegative: ['accepted_vnd', 'requested_vnd', 'paid_vnd', 'advance_recovered_vnd', 'retention_held_vnd'],
    businessKey: { columns: ['contract_id', 'boq_item_id', 'acceptance_id', 'party_id'] },
    versionColumn: 'version',
  },
  {
    table: 'capital_ledger_entry',
    kind: 'ENTRY',
    lockRank: 30,
    nonNegative: ['amount_vnd'],
    businessKey: { columns: ['source_ref_kind', 'source_ref_id', 'entry_type', 'allocation_line_id', 'source_ref_seq'] },
  },
  {
    table: 'cumulative_ledger_entry',
    kind: 'ENTRY',
    lockRank: 40,
    nonNegative: ['advance_outstanding_after_vnd'],
    businessKey: { columns: ['reversal_of_id'], partial: true },
  },
  {
    table: 'advance_ledger_entry',
    kind: 'ENTRY',
    lockRank: 50,
    nonNegative: ['amount_vnd', 'outstanding_after_vnd'],
    businessKey: { columns: ['reversal_of_id'], partial: true },
  },
  {
    // The reserve of a project (contingency and management reserve): the balance sits on reserve_fund and the posting trigger moves it under the lock of the fund; an entry is a drawdown or a funding, one entry for each drawdown.
    table: 'reserve_ledger_entry',
    kind: 'ENTRY',
    lockRank: 60,
    nonNegative: ['amount_vnd', 'balance_after_vnd'],
    businessKey: { columns: ['drawdown_id'], partial: true },
  },
];

const BY_TABLE = new Map(LEDGER_TABLES.map((declaration) => [declaration.table, declaration]));

/** The declaration of a ledger table, or undefined when the table is not a declared ledger. */
export function ledgerDeclaration(table: string): LedgerDeclaration | undefined {
  return BY_TABLE.get(table);
}

/** The digits after the point of the amount columns of a ledger table. */
export function ledgerScale(declaration: LedgerDeclaration): number {
  return declaration.scale ?? VND_SCALE;
}
