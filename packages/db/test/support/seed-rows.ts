import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Inserts a row as the administrator with the checks of the foreign keys and the guards of the modules off: a record is seeded as it stands, not as a command would have made it. The columns the table needs and the test does not care
 * about get a value of their type (a column that has a default, is computed or may be null is left to that); the `day` and the `instant` are what the dates and the timestamps get.
 */
export async function seedRow(adminUrl: string, table: string, tenant: string, values: Record<string, unknown>, filler: { day: string; instant: string } = { day: '2027-10-15', instant: '2027-10-15T03:00:00.000Z' }): Promise<string> {
  const rowId = (values.id as string | undefined) ?? randomUUID();
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const columns = (
      await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
        `select column_name, data_type, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'machvon' and table_name = $1`,
        [table],
      )
    ).rows;
    const all: Record<string, unknown> = { tenant_id: tenant, id: rowId, ...values };
    const json = new Set(columns.filter((column) => column.data_type === 'jsonb').map((column) => column.column_name));
    for (const column of columns) {
      if (column.column_name in all || column.is_generated === 'ALWAYS' || column.is_nullable === 'YES' || column.column_default !== null) continue;
      all[column.column_name] =
        column.data_type === 'uuid'
          ? randomUUID()
          : ['integer', 'smallint', 'bigint', 'numeric'].includes(column.data_type)
            ? 1
            : column.data_type === 'boolean'
              ? false
              : column.data_type === 'date'
                ? filler.day
                : column.data_type.startsWith('timestamp')
                  ? filler.instant
                  : column.data_type === 'jsonb'
                    ? {}
                    : column.data_type === 'ARRAY'
                      ? []
                      : column.data_type === 'character'
                        ? 'VND'
                        : 'text-value';
    }
    const names = Object.keys(all).filter((name) => columns.some((column) => column.column_name === name));
    const params = names.map((name) => {
      const value = all[name];
      return json.has(name) || (typeof value === 'object' && value !== null && !Array.isArray(value)) ? JSON.stringify(value) : value;
    });
    await client.query(`insert into machvon.${table} (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')})`, params);
  } finally {
    await client.end();
  }
  return rowId;
}
