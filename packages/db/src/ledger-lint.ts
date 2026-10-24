import { Client } from 'pg';
import { LEDGER_LOCK_COLUMN } from './ledger-registry.ts';
import type { LedgerDeclaration } from './ledger-registry.ts';
import { APP_ROLE } from './roles.ts';

const SCHEMA = 'machvon';
const TENANT_COLUMN = 'tenant_id';
/** A table with one of these names holds money movements or balances, whether or not anybody declared it. */
const LEDGER_NAME = /(^|_)(ledger|balance)(_entry)?$/;

export interface LedgerCheck {
  name: string;
  definition: string;
  validated: boolean;
}

export interface LedgerUniqueIndex {
  name: string;
  /** The key columns in index order; an expression shows as `<expression>`. */
  columns: string[];
  partial: boolean;
}

export interface LedgerCatalogTable {
  name: string;
  columns: string[];
  checks: LedgerCheck[];
  uniqueIndexes: LedgerUniqueIndex[];
  appUpdate: boolean;
  appDelete: boolean;
}

export interface LedgerCatalog {
  tables: LedgerCatalogTable[];
}

export type LedgerFailureReason =
  | 'undeclared_ledger'
  | 'declared_table_missing'
  | 'unknown_column'
  | 'no_non_negative_check'
  | 'no_business_key'
  | 'no_lock_key'
  | 'duplicate_lock_rank'
  | 'entry_not_append_only';

export interface LedgerFailure {
  table: string;
  reason: LedgerFailureReason;
  column?: string;
}

export interface LedgerReport {
  ledgerTables: number;
  failures: LedgerFailure[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a CHECK keeps `column` at zero or above: PostgreSQL prints it as `column >= (0)::numeric` or `column > 0` inside the
 * definition, possibly as one conjunct of several. A definition with an OR in it does not count (the other branch may let a
 * negative value through), and neither does a constraint that was added NOT VALID (rows from before it may still be negative).
 */
function keepsNonNegative(check: LedgerCheck, column: string): boolean {
  if (!check.validated || /\bOR\b/i.test(check.definition)) return false;
  return new RegExp(`\\(${escapeRegExp(column)} >=? \\(?0\\)?(::[a-z]+)?\\)`).test(check.definition);
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

/** Whether an index is unique on `(tenant_id, ...columns)` and partial exactly when the declaration says so. */
function hasUniqueKey(table: LedgerCatalogTable, columns: readonly string[], partial: boolean): boolean {
  return table.uniqueIndexes.some((index) => index.partial === partial && sameColumns(index.columns, [TENANT_COLUMN, ...columns]));
}

function declarationFailures(declaration: LedgerDeclaration, table: LedgerCatalogTable): LedgerFailure[] {
  const failures: LedgerFailure[] = [];
  const fail = (reason: LedgerFailureReason, column?: string): void => {
    failures.push({ table: declaration.table, reason, ...(column === undefined ? {} : { column }) });
  };
  const columns = [...declaration.nonNegative, ...declaration.businessKey.columns, ...(declaration.versionColumn === undefined ? [] : [declaration.versionColumn])];
  for (const column of columns.filter((name) => !table.columns.includes(name))) fail('unknown_column', column);
  for (const column of declaration.nonNegative) {
    if (!table.checks.some((check) => keepsNonNegative(check, column))) fail('no_non_negative_check', column);
  }
  if (!hasUniqueKey(table, declaration.businessKey.columns, declaration.businessKey.partial ?? false)) fail('no_business_key');
  if (!hasUniqueKey(table, [LEDGER_LOCK_COLUMN], false)) fail('no_lock_key');
  if (declaration.kind === 'ENTRY' && (table.appUpdate || table.appDelete)) fail('entry_not_append_only');
  return failures;
}

/**
 * The ledger lint. Every declared ledger table must exist and have, in the database itself: a validated non-negative CHECK on each
 * amount column, a unique key for its business fact, a unique `(tenant_id, id)` to lock a row by, a lock rank of its own, and, for an
 * append-only entry table, no UPDATE or DELETE for the application role. Every table that looks like a ledger by name must be declared.
 */
export function ledgerReport(catalog: LedgerCatalog, declarations: readonly LedgerDeclaration[]): LedgerReport {
  const failures: LedgerFailure[] = [];
  const byName = new Map(catalog.tables.map((table) => [table.name, table]));
  const declaredNames = new Set(declarations.map((declaration) => declaration.table));
  for (const table of catalog.tables) {
    if (LEDGER_NAME.test(table.name) && !declaredNames.has(table.name)) failures.push({ table: table.name, reason: 'undeclared_ledger' });
  }
  const ranks = new Map<number, string>();
  for (const declaration of declarations) {
    if (ranks.has(declaration.lockRank)) failures.push({ table: declaration.table, reason: 'duplicate_lock_rank' });
    ranks.set(declaration.lockRank, declaration.table);
    const table = byName.get(declaration.table);
    if (table === undefined) failures.push({ table: declaration.table, reason: 'declared_table_missing' });
    else failures.push(...declarationFailures(declaration, table));
  }
  return { ledgerTables: declarations.length, failures };
}

interface TableRow {
  oid: string;
  name: string;
  columns: string[];
  app_update: boolean;
  app_delete: boolean;
}

const TABLES_SQL = `
  select c.oid::text as oid, c.relname as name,
         array(select a.attname::text from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum) as columns,
         has_table_privilege($2, c.oid, 'UPDATE') as app_update,
         has_table_privilege($2, c.oid, 'DELETE') as app_delete
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = $1 and c.relkind in ('r', 'p')
   order by c.relname`;

const CHECKS_SQL = `
  select conrelid::text as table_oid, conname as name, pg_get_constraintdef(oid) as definition, convalidated as validated
    from pg_constraint
   where contype = 'c' and connamespace = $1::regnamespace
   order by conname`;

const UNIQUE_SQL = `
  select i.indrelid::text as table_oid, ic.relname as name, i.indpred is not null as partial,
         array(select coalesce(a.attname::text, '<expression>')
                 from generate_series(1, i.indnkeyatts::int) as k(ord)
                 left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[k.ord - 1]
                order by k.ord) as columns
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid
   where i.indisunique and i.indisvalid and c.relnamespace = $1::regnamespace
   order by ic.relname`;

/** Reads the constraints, unique indexes and application privileges of the product schema through a privileged connection. */
export async function readLedgerCatalog(adminUrl: string): Promise<LedgerCatalog> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const tables = (await client.query<TableRow>(TABLES_SQL, [SCHEMA, APP_ROLE])).rows;
    const checks = (await client.query<{ table_oid: string; name: string; definition: string; validated: boolean }>(CHECKS_SQL, [SCHEMA])).rows;
    const indexes = (await client.query<{ table_oid: string; name: string; partial: boolean; columns: string[] }>(UNIQUE_SQL, [SCHEMA])).rows;
    return {
      tables: tables.map((row) => ({
        name: row.name,
        columns: row.columns,
        checks: checks.filter((check) => check.table_oid === row.oid).map((check) => ({ name: check.name, definition: check.definition, validated: check.validated })),
        uniqueIndexes: indexes.filter((index) => index.table_oid === row.oid).map((index) => ({ name: index.name, columns: index.columns, partial: index.partial })),
        appUpdate: row.app_update,
        appDelete: row.app_delete,
      })),
    };
  } finally {
    await client.end();
  }
}
