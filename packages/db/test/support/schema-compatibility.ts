/**
 * The compatibility harness of the deployment pipeline (ST-KERNEL-014): it reads the shape of the schema that application N-1 runs against and the shape that application N migrated it to, and names every
 * change that application N-1 cannot live with. It reads the catalog of the database, not the text of the migrations (`scripts/expand-contract-check.mjs` reads the text), so a destructive step that the text
 * check cannot see (dynamic SQL, a function that alters a table) is found as well.
 *
 * What application N-1 depends on in a table is: that the table and each of its columns exist with the type it reads and writes, that a column it may write as null still accepts null, and that a column it
 * does not know is not required of its inserts.
 */
export interface SchemaQuery {
  query<T extends object>(text: string): Promise<{ rows: T[] }>;
}

export interface ColumnShape {
  /** `format_type`: the type with its length, precision and array dimensions, so a widened numeric is a different shape. */
  type: string;
  notNull: boolean;
  /** A default, an identity or a generated expression: the database fills the column when an insert leaves it out. */
  filled: boolean;
}

/** Table (or view) name to column name to shape, for the `machvon` schema. */
export type SchemaShape = ReadonlyMap<string, ReadonlyMap<string, ColumnShape>>;

export type BreakKind = 'TABLE_REMOVED' | 'COLUMN_REMOVED' | 'COLUMN_RETYPED' | 'COLUMN_REQUIRED' | 'COLUMN_FILL_REMOVED' | 'REQUIRED_COLUMN_ADDED';

export interface CompatibilityBreak {
  kind: BreakKind;
  table: string;
  column?: string;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  type: string;
  not_null: boolean;
  filled: boolean;
}

const SHAPE_SQL = `select c.relname as table_name, a.attname as column_name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
    (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') as filled
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'machvon' and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`;

/** The shape of the `machvon` schema as the database has it now. */
export async function readSchemaShape(client: SchemaQuery): Promise<SchemaShape> {
  const { rows } = await client.query<ColumnRow>(SHAPE_SQL);
  const tables = new Map<string, Map<string, ColumnShape>>();
  for (const row of rows) {
    const columns = tables.get(row.table_name) ?? new Map<string, ColumnShape>();
    columns.set(row.column_name, { type: row.type, notNull: row.not_null, filled: row.filled });
    tables.set(row.table_name, columns);
  }
  return tables;
}

/**
 * What application N-1 can no longer do on the schema `next`, given the schema `previous` it was built for. An empty list means N-1 reads and writes still succeed. A column that was only added is a break only
 * when the table existed before (N-1 inserts into it) and the column is required with nothing to fill it.
 */
export function compatibilityBreaks(previous: SchemaShape, next: SchemaShape): CompatibilityBreak[] {
  const breaks: CompatibilityBreak[] = [];
  for (const [table, columns] of previous) {
    const after = next.get(table);
    if (after === undefined) {
      breaks.push({ kind: 'TABLE_REMOVED', table });
      continue;
    }
    for (const [column, before] of columns) {
      const now = after.get(column);
      if (now === undefined) breaks.push({ kind: 'COLUMN_REMOVED', table, column });
      else if (now.type !== before.type) breaks.push({ kind: 'COLUMN_RETYPED', table, column });
      else if (!before.notNull && now.notNull) breaks.push({ kind: 'COLUMN_REQUIRED', table, column });
      else if (before.filled && !now.filled && now.notNull) breaks.push({ kind: 'COLUMN_FILL_REMOVED', table, column });
    }
    for (const [column, now] of after) {
      if (!columns.has(column) && now.notNull && !now.filled) breaks.push({ kind: 'REQUIRED_COLUMN_ADDED', table, column });
    }
  }
  return breaks;
}
