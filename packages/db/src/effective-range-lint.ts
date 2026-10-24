import type { Client } from 'pg';
import { EFFECTIVE_RANGE_TABLES } from './effective-range-registry.ts';
import type { RangeDeclaration } from './effective-range-registry.ts';

const SCHEMA = 'machvon';
/** The names a column that starts or ends a period of validity may have. */
const START_COLUMNS = ['effective_from', 'valid_from'] as const;
const END_COLUMNS = ['effective_until', 'valid_until'] as const;

export interface RangeCatalogTable {
  name: string;
  columns: string[];
  /** The definitions of the check constraints that name a start and an end column. */
  periodChecks: string[];
  /** The exclusion constraints and the triggers of the table, by name, with the exclusion definition. */
  exclusions: Array<{ name: string; definition: string }>;
  triggers: string[];
}

export interface RangeCatalog {
  tables: RangeCatalogTable[];
}

export type RangeFailureReason = 'undeclared_range' | 'declared_table_missing' | 'declared_without_range' | 'no_period_check' | 'guard_missing' | 'guard_not_a_range' | 'reason_missing' | 'rule_without_guard';

export interface RangeFailure {
  table: string;
  reason: RangeFailureReason;
}

export interface RangeReport {
  rangeTables: number;
  rules: number;
  pending: string[];
  failures: RangeFailure[];
}

export const hasRange = (columns: readonly string[]): boolean => START_COLUMNS.some((column) => columns.includes(column)) && END_COLUMNS.some((column) => columns.includes(column));

/** Reads, from the migrated database, the tables that carry both a start and an end of validity, with their period checks, exclusion constraints and triggers. */
export async function readRangeCatalog(client: Client): Promise<RangeCatalog> {
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = $1 order by c.table_name, c.ordinal_position`,
    [SCHEMA],
  );
  const byTable = new Map<string, string[]>();
  for (const row of columns.rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
  const names = [...byTable.entries()].filter(([, own]) => hasRange(own)).map(([name]) => name);
  const tables: RangeCatalogTable[] = [];
  for (const name of names) {
    const own = byTable.get(name) ?? [];
    const constraints = await client.query<{ type: string; name: string; definition: string }>(
      `select contype as type, conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = $1::regclass and contype in ('c', 'x')`,
      [`${SCHEMA}.${name}`],
    );
    const triggers = await client.query<{ name: string }>('select tgname as name from pg_trigger where tgrelid = $1::regclass and not tgisinternal', [`${SCHEMA}.${name}`]);
    const starts = START_COLUMNS.filter((column) => own.includes(column));
    const ends = END_COLUMNS.filter((column) => own.includes(column));
    tables.push({
      name,
      columns: own,
      periodChecks: constraints.rows.filter((row) => row.type === 'c' && starts.some((s) => row.definition.includes(s)) && ends.some((e) => row.definition.includes(e))).map((row) => row.definition),
      exclusions: constraints.rows.filter((row) => row.type === 'x').map((row) => ({ name: row.name, definition: row.definition })),
      triggers: triggers.rows.map((row) => row.name),
    });
  }
  return { tables };
}

/**
 * Judges the catalog against the registry: a table with a range must be declared; a declared table must exist and have a range; every range has a check that it ends after it
 * starts; a RULE has the guard it names (an exclusion constraint over a daterange, or a trigger); a VALIDITY, a SERIES and a PENDING entry says why in `reason`; and no RULE is
 * declared without a guard.
 */
export function rangeReport(catalog: RangeCatalog, declarations: readonly RangeDeclaration[] = EFFECTIVE_RANGE_TABLES): RangeReport {
  const failures: RangeFailure[] = [];
  const declared = new Map(declarations.map((declaration) => [declaration.table, declaration]));
  const present = new Map(catalog.tables.map((table) => [table.name, table]));
  for (const table of catalog.tables) {
    if (!declared.has(table.name)) failures.push({ table: table.name, reason: 'undeclared_range' });
    // The period check is the minimum of every range: an end before the start is never a period.
    if (table.periodChecks.length === 0) failures.push({ table: table.name, reason: 'no_period_check' });
  }
  for (const declaration of declarations) {
    const table = present.get(declaration.table);
    if (table === undefined) {
      failures.push({ table: declaration.table, reason: 'declared_table_missing' });
      continue;
    }
    if (declaration.kind === 'RULE') {
      const guard = declaration.guard;
      if (guard === undefined) failures.push({ table: declaration.table, reason: 'rule_without_guard' });
      else if (guard.type === 'EXCLUDE') {
        const found = table.exclusions.find((exclusion) => exclusion.name === guard.name);
        if (found === undefined) failures.push({ table: declaration.table, reason: 'guard_missing' });
        else if (!found.definition.includes('daterange(')) failures.push({ table: declaration.table, reason: 'guard_not_a_range' });
      } else if (!table.triggers.includes(guard.name)) failures.push({ table: declaration.table, reason: 'guard_missing' });
    } else if (declaration.reason === undefined || declaration.reason.trim() === '') failures.push({ table: declaration.table, reason: 'reason_missing' });
  }
  return {
    rangeTables: catalog.tables.length,
    rules: declarations.filter((declaration) => declaration.kind === 'RULE').length,
    pending: declarations.filter((declaration) => declaration.kind === 'PENDING').map((declaration) => declaration.table),
    failures,
  };
}
