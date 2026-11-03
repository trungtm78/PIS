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

/** The SQL that measures one table: the rows, the sum of a hash of the primary key of each row (the whole row for a table without a key) and the sum of each money column. Row-level security confines it to the tenant of the transaction. */
export function measureSql(table: string, keyColumns: readonly string[], moneyColumns: readonly string[]): string {
  const identity = keyColumns.length === 0 ? 'r' : `row(${keyColumns.map((column) => `r.${quote(column)}`).join(', ')})`;
  const money = moneyColumns.map((column, index) => `coalesce(sum(r.${quote(column)}), 0)::text as m${index}`);
  const columns = ['count(*)::text as n', `coalesce(sum(hashtextextended(${identity}::text, 0)::numeric), 0)::text as checksum`, ...money].join(', ');
  return `select ${columns} from machvon.${quote(table)} r`;
}

/**
 * Measures the data of the tenant of the transaction, table by table (SAS.md 3.3 step 1 and BR-SAS-05): the number of rows, a checksum of the primary keys that does not depend on the order of the rows, and the sum of every
 * numeric(24,0) money column. The same measure is taken on the copy; what differs is a difference in the data. Run it in a snapshot (`TenantDatabase.withSnapshot`) so every table is read at the same moment.
 */
export async function measureTenantTables(tx: TenantTx): Promise<MeasuredTenant> {
  const catalogue = await tx.query<CatalogueRow>(CATALOGUE_SQL);
  const tables: TableMeasure[] = [];
  const unreadable: string[] = [];
  for (const entry of catalogue) {
    if (!entry.readable) {
      unreadable.push(entry.table_name);
      continue;
    }
    const [row] = await tx.query<Record<string, string>>(measureSql(entry.table_name, entry.key_columns, entry.money_columns));
    const money: Record<string, string> = {};
    entry.money_columns.forEach((column, index) => {
      money[column] = row?.[`m${index}`] ?? '0';
    });
    tables.push({ table: entry.table_name, rows: Number(row?.n ?? 0), checksum: row?.checksum ?? '0', money });
  }
  return { tables, unreadable };
}
