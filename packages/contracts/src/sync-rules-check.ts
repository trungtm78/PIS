import { SYNC_TOKENS } from './dis-sync';
import type { SyncBucket, SyncTable } from './dis-sync';

/**
 * The static check of the sync rules of the phone (ST-MOB-007, TK-MOB-007-7, A1). PowerSync reads the write-ahead log and does
 * not pass row-level security, so what keeps a tenant off another tenant's phone is the text of the rules and nothing else. This
 * check reads that text, bucket by bucket, and names every rule it breaks; it runs on the rules in the repository and on any
 * rules a later story adds (the buckets of other modules), before they are deployed.
 *
 * The rules (each has a mutation in the test that must turn it red):
 *  - TENANT_PARAMETER: the parameter query takes the tenant from the token (`request.jwt()`), in a comparison with `tenant_id`;
 *  - MEMBERSHIP_PARAMETER: and the membership too;
 *  - CLIENT_PARAMETER: nothing the client sends (`request.parameters()`) decides who gets rows;
 *  - TENANT_DATA: every data query compares a `tenant_id` with the tenant of the bucket (the joins tie the other tables to it);
 *  - LITERAL_TENANT: no query names a tenant or a person by a literal id;
 *  - STAR: no query selects `*` or `alias.*`: the columns are listed;
 *  - COLUMN_NOT_ALLOWED: every selected column is on the allowlist of its table in the sync contract;
 *  - TABLE_NOT_ALLOWED: every table read is a table of the sync contract, none holds personal data;
 *  - MONEY_WRITABLE: a money column (a name ending `_vnd`) is marked read only in the contract.
 */
export type SyncRuleViolation = { bucket: string; rule: string; detail: string };

/** Tables that hold personal data of citizens or staff. They never go to a phone through the generic rules (design doc 07, the field flow). */
export const PERSONAL_DATA_TABLES: readonly string[] = ['household', 'household_member', 'citizen', 'resident', 'person', 'contact', 'user_account', 'device_registration', 'consent_record'];

const UUID_LITERAL = /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/;

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function comparesToken(sql: string, column: string, token: string): boolean {
  const text = normalize(sql);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b\\w+\\.${column}\\s*=\\s*${escaped}`).test(text) || new RegExp(`${escaped}\\s*=\\s*\\b\\w+\\.${column}\\b`).test(text);
}

interface Table {
  name: string;
  alias: string;
}

/** The tables of a query, `FROM name alias` and `JOIN name alias`, with the first one being the table the rows come from. */
function tablesOf(query: string): Table[] {
  const tables: Table[] = [];
  for (const match of normalize(query).matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?(?!ON\b|WHERE\b|JOIN\b|LEFT\b|INNER\b|WITH\b)([a-z_][a-z0-9_]*))?/gi)) {
    const name = match[1] as string;
    tables.push({ name, alias: match[2] ?? name });
  }
  return tables;
}

function selectedColumns(query: string): string[] {
  const text = normalize(query);
  const list = /^SELECT\s+(?:DISTINCT\s+)?(.*?)\s+FROM\b/i.exec(text)?.[1] ?? '';
  return list.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

/** Checks the buckets against the contract of the tables that may sync. An empty list means the rules pass. */
export function checkSyncBuckets(buckets: readonly SyncBucket[], contract: readonly SyncTable[], personalDataTables: readonly string[] = PERSONAL_DATA_TABLES): SyncRuleViolation[] {
  const violations: SyncRuleViolation[] = [];
  const add = (bucket: string, rule: string, detail: string): void => {
    violations.push({ bucket, rule, detail });
  };
  for (const table of contract) {
    for (const column of table.columns) {
      if (/_vnd$/.test(column.name) && column.readOnlyMoney !== true) add(`contract:${table.table}`, 'MONEY_WRITABLE', column.name);
    }
  }
  for (const bucket of buckets) {
    if (!comparesToken(bucket.parameters, 'tenant_id', SYNC_TOKENS.tenant)) add(bucket.name, 'TENANT_PARAMETER', 'the parameter query does not compare tenant_id with the tenant of the token');
    if (!comparesToken(bucket.parameters, 'membership_id', SYNC_TOKENS.membership)) add(bucket.name, 'MEMBERSHIP_PARAMETER', 'the parameter query does not compare membership_id with the membership of the token');
    const queries = [{ table: '(parameters)', query: bucket.parameters }, ...bucket.data];
    for (const entry of queries) {
      const where = entry.table;
      if (/request\.parameters\s*\(/i.test(entry.query)) add(bucket.name, 'CLIENT_PARAMETER', `${where} reads a parameter the client sends`);
      if (UUID_LITERAL.test(entry.query)) add(bucket.name, 'LITERAL_TENANT', `${where} names a row by a literal id`);
    }
    for (const entry of bucket.data) {
      const tables = tablesOf(entry.query);
      const first = tables[0];
      if (first === undefined || first.name !== entry.table) add(bucket.name, 'TABLE_NOT_ALLOWED', `${entry.table}: the rows do not come from the table the bucket says`);
      if (first !== undefined && !comparesToken(entry.query, 'tenant_id', SYNC_TOKENS.bucketTenant)) add(bucket.name, 'TENANT_DATA', `${entry.table}: the query does not compare tenant_id with the tenant of the bucket`);
      for (const table of tables) {
        if (personalDataTables.includes(table.name)) add(bucket.name, 'TABLE_NOT_ALLOWED', `${table.name} holds personal data`);
      }
      const allowed = contract.find((candidate) => candidate.table === entry.table);
      if (allowed === undefined) add(bucket.name, 'TABLE_NOT_ALLOWED', `${entry.table} is not a table of the sync contract`);
      const selected = selectedColumns(entry.query);
      for (const column of selected) {
        if (/(^|\.)\*$/.test(column)) {
          add(bucket.name, 'STAR', `${entry.table}: ${column}`);
          continue;
        }
        const name = column.split('.').pop() as string;
        if (allowed !== undefined && !allowed.columns.some((candidate) => candidate.name === name)) add(bucket.name, 'COLUMN_NOT_ALLOWED', `${entry.table}.${name}`);
      }
    }
  }
  return violations;
}
