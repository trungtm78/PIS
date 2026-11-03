import type { TableMeasure } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** What the original holds, table by table, and the tables the reader could not look at. */
export interface MeasuredTenant {
  tables: TableMeasure[];
  /** Tables of the tenant plane that the role of the worker cannot read (the theme drafts, reviews and assets): they are named in the report as not compared, never written as empty. */
  unreadable: string[];
}

interface CatalogueRow {
  table_name: string;
  readable: boolean;
  key_columns: string[];
  money_columns: string[];
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

// The tables of the tenant plane: with row-level security, and carrying the tenant. Their primary key columns, and the columns that hold money (numeric(24,0)) come with them.
const CATALOGUE_SQL = `
  select c.relname as table_name,
         has_table_privilege(c.oid, 'select') as readable,
         coalesce((select array_agg(a.attname::text order by k.ord) from pg_index i
                     cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                    where i.indrelid = c.oid and i.indisprimary), '{}') as key_columns,
         coalesce((select array_agg(a.attname::text order by a.attnum) from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = 'numeric(24,0)'), '{}') as money_columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'machvon' and c.relkind in ('r', 'p') and c.relrowsecurity
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
   order by c.relname`;

/**
 * The tables that the promotion itself writes in every step (its status, version, comparison and timestamps change after the copy and after the comparison that lets the routing switch). Their content is no write of the tenant and
 * no difference of the copy, so they are measured by key alone (the rows and the checksum of the primary keys), not by content: otherwise every step of the promotion would read as a change to the silo.
 */
export const PROMOTION_RECORD_TABLES: ReadonlySet<string> = new Set(['tenant_placement_migration']);

// The settings that decide how a value is written as text. The checksum hashes that text, so both sides are read with the same ones, whatever the session of the role that measures.
const TEXT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['TimeZone', 'UTC'],
  ['DateStyle', 'ISO, YMD'],
  ['IntervalStyle', 'iso_8601'],
  ['bytea_output', 'hex'],
  ['extra_float_digits', '1'],
];

/**
 * The SQL that measures one table: the rows, the checksum of the content and the sum of each money column. The checksum is the sum, over the rows, of a 64-bit hash of the whole row written as `jsonb` text, so it sees a change
 * to ANY column (a status, a name, a date, a document reference), not only to the key or to money, and it does not depend on the order of the rows. `jsonb` names every column and keeps them in one order whatever the physical order
 * of the columns is; the system columns of the storage (ctid, xmin) are not part of a row. `keyColumns`, given only for a table of the promotion's own record, hashes the primary key instead of the content.
 * Row-level security confines the read to the tenant of the transaction.
 */
export function measureSql(table: string, moneyColumns: readonly string[], keyColumns?: readonly string[]): string {
  const identity = keyColumns === undefined ? 'to_jsonb(r)::text' : `row(${keyColumns.map((column) => `r.${quote(column)}`).join(', ')})::text`;
  const money = moneyColumns.map((column, index) => `coalesce(sum(r.${quote(column)}), 0)::text as m${index}`);
  const columns = ['count(*)::text as n', `coalesce(sum(hashtextextended(${identity}, 0)::numeric), 0)::text as checksum`, ...money].join(', ');
  return `select ${columns} from machvon.${quote(table)} r`;
}

/**
 * Measures the data of the tenant of the transaction, table by table (SAS.md 3.3 step 1 and BR-SAS-05): the number of rows, a checksum of the content of every column of every row that does not depend on the order of the
 * rows, and the sum of every numeric(24,0) money column. The same measure is taken on the copy; what differs is a difference in the data, and the same measure of the silo later tells whether anything was written to it.
 * Run it in a snapshot (`TenantDatabase.withSnapshot`) so every table is read at the same moment.
 */
export async function measureTenantTables(tx: TenantTx): Promise<MeasuredTenant> {
  for (const [name, value] of TEXT_SETTINGS) await tx.query('select set_config($1, $2, true)', [name, value]);
  const catalogue = await tx.query<CatalogueRow>(CATALOGUE_SQL);
  const tables: TableMeasure[] = [];
  const unreadable: string[] = [];
  for (const entry of catalogue) {
    if (!entry.readable) {
      unreadable.push(entry.table_name);
      continue;
    }
    const [row] = await tx.query<Record<string, string>>(measureSql(entry.table_name, entry.money_columns, PROMOTION_RECORD_TABLES.has(entry.table_name) ? entry.key_columns : undefined));
    const money: Record<string, string> = {};
    entry.money_columns.forEach((column, index) => {
      money[column] = row?.[`m${index}`] ?? '0';
    });
    tables.push({ table: entry.table_name, rows: Number(row?.n ?? 0), checksum: row?.checksum ?? '0', money });
  }
  return { tables, unreadable };
}
