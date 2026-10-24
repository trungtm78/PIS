import { DomainError, creditAmount, debitAmount, orderLockTargets, requirePositiveAmount } from '@machvon/kernel';
import { LEDGER_LOCK_COLUMN, ledgerDeclaration, ledgerScale } from './ledger-registry.ts';
import type { LedgerDeclaration } from './ledger-registry.ts';
import type { TenantTx } from './tenant-database.ts';

/** One row of a declared ledger table, named by its `id`. */
export interface LedgerRowRef {
  table: string;
  id: string;
}

/** One amount column of one balance row. */
export interface BalanceRef extends LedgerRowRef {
  column: string;
}

export interface BalanceState {
  balance: string;
  /** The row version after the change, when the table keeps one. */
  version: string | undefined;
}

export interface BalanceOptions {
  /** The version the caller read (If-Match); a different one answers 409 VERSION_CONFLICT. */
  expectedVersion?: string;
}

function declared(table: string): LedgerDeclaration {
  const declaration = ledgerDeclaration(table);
  if (declaration === undefined) throw new Error(`${table} is not a declared ledger table`);
  return declaration;
}

function balanceDeclaration(ref: BalanceRef): LedgerDeclaration {
  const declaration = declared(ref.table);
  if (declaration.kind !== 'BALANCE' || !declaration.nonNegative.includes(ref.column)) throw new Error(`${ref.table}.${ref.column} is not a balance column of a declared ledger`);
  return declaration;
}

/**
 * Locks the rows with `SELECT ... FOR UPDATE`, always in the one order of orderLockTargets (table rank, table, id) and each row once,
 * whatever order the command names them in. A row that does not exist (or belongs to another tenant) answers 404. The locks last
 * until the transaction ends.
 */
export async function lockLedgerRows(tx: TenantTx, refs: readonly LedgerRowRef[]): Promise<void> {
  const targets = refs.map((ref) => ({ rank: declared(ref.table).lockRank, table: ref.table, key: ref.id }));
  for (const target of orderLockTargets(targets)) {
    const rows = await tx.query(`select 1 from machvon.${target.table} where ${LEDGER_LOCK_COLUMN} = $1::uuid for update`, [target.key]);
    if (rows.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }
}

async function changeBalance(tx: TenantTx, ref: BalanceRef, options: BalanceOptions, next: (balance: string, scale: number) => string): Promise<BalanceState> {
  const declaration = balanceDeclaration(ref);
  const { versionColumn } = declaration;
  const versionSelect = versionColumn === undefined ? 'null::text' : `${versionColumn}::text`;
  const [row] = await tx.query<{ balance: string; version: string | null }>(
    `select ${ref.column}::text as balance, ${versionSelect} as version from machvon.${ref.table} where ${LEDGER_LOCK_COLUMN} = $1::uuid for update`,
    [ref.id],
  );
  if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (options.expectedVersion !== undefined && options.expectedVersion !== row.version) {
    throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: row.version } });
  }
  const balance = next(row.balance, ledgerScale(declaration));
  const bump = versionColumn === undefined ? '' : `, ${versionColumn} = ${versionColumn} + 1`;
  const [updated] = await tx.query<{ version: string | null }>(
    `update machvon.${ref.table} set ${ref.column} = $2::numeric${bump} where ${LEDGER_LOCK_COLUMN} = $1::uuid returning ${versionSelect} as version`,
    [ref.id, balance],
  );
  return { balance, version: updated?.version ?? undefined };
}

/**
 * Pays `amount` out of a balance: the row is locked, the balance is read under the lock, checked and written back in the same
 * transaction, so two parallel spends are serialised and the second one sees what the first one left. A spend above the balance
 * answers 409 BALANCE_INSUFFICIENT; the CHECK constraint of the column is the last guard behind that check.
 */
export function debitBalance(tx: TenantTx, ref: BalanceRef, amount: string, options: BalanceOptions = {}): Promise<BalanceState> {
  return changeBalance(tx, ref, options, (balance, scale) => debitAmount(balance, amount, scale));
}

/** Adds `amount` to a balance under the same row lock. */
export function creditBalance(tx: TenantTx, ref: BalanceRef, amount: string, options: BalanceOptions = {}): Promise<BalanceState> {
  return changeBalance(tx, ref, options, (balance, scale) => creditAmount(balance, amount, scale));
}

/**
 * Moves `amount` from one balance to another. Both rows are locked first, in the one lock order, so a transfer from A to B and a
 * transfer from B to A running together never deadlock; the amount leaves one row and enters the other in the same transaction,
 * so the total of the two never changes.
 */
export async function transferBalance(tx: TenantTx, from: BalanceRef, to: BalanceRef, amount: string): Promise<{ from: BalanceState; to: BalanceState }> {
  requirePositiveAmount(amount, ledgerScale(balanceDeclaration(from)));
  balanceDeclaration(to);
  await lockLedgerRows(tx, [from, to]);
  return { from: await debitBalance(tx, from, amount), to: await creditBalance(tx, to, amount) };
}
