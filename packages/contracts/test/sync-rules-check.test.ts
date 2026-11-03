import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIS_SYNC_BUCKETS, DIS_SYNC_TABLES, syncRulesYaml } from '../src/dis-sync';
import type { SyncBucket, SyncTable } from '../src/dis-sync';
import { checkSyncBuckets } from '../src/sync-rules-check';

const rules = (violations: ReturnType<typeof checkSyncBuckets>): string[] => violations.map((violation) => violation.rule);

/** The buckets with the first one changed. */
function mutated(change: (bucket: SyncBucket) => SyncBucket): SyncBucket[] {
  const [first, ...rest] = DIS_SYNC_BUCKETS as readonly SyncBucket[];
  return [change(first as SyncBucket), ...rest];
}

const withData = (bucket: SyncBucket, change: (query: string) => string): SyncBucket => ({ ...bucket, data: bucket.data.map((entry) => ({ ...entry, query: change(entry.query) })) });

describe('the static check of the sync rules (ST-MOB-007, TK-MOB-007-7)', () => {
  it('AC-ST-MOB-007-1 UAT-AC500: the rules of the repository pass: every bucket is read from the tenant and membership of the token and every table from the tenant of the bucket', () => {
    expect(checkSyncBuckets(DIS_SYNC_BUCKETS, DIS_SYNC_TABLES)).toEqual([]);
  });

  it('checks the text that is committed: the rules file holds exactly the queries that were checked', () => {
    const file = readFileSync(resolve(__dirname, '..', '..', '..', 'infra', 'powersync', 'sync-rules.reference.yaml'), 'utf8');
    expect(file).toBe(syncRulesYaml());
    for (const bucket of DIS_SYNC_BUCKETS) {
      expect(file).toContain(bucket.name);
      expect(file).toContain(bucket.parameters.split('\n').join('\n      '));
    }
  });

  describe('AC-ST-MOB-007-3 UAT-NFR-TENANCY-07: each rule turns red when it is broken', () => {
    it('TENANT_PARAMETER: a parameter query that takes the tenant from anything but the token', () => {
      const broken = mutated((bucket) => ({ ...bucket, parameters: bucket.parameters.replace("s.tenant_id = request.jwt() ->> 'tenant_id'", "s.tenant_id = request.parameters() ->> 'tenant_id'") }));
      expect(rules(checkSyncBuckets(broken, DIS_SYNC_TABLES))).toEqual(expect.arrayContaining(['TENANT_PARAMETER', 'CLIENT_PARAMETER']));
    });

    it('TENANT_PARAMETER: a parameter query with no tenant condition at all', () => {
      const broken = mutated((bucket) => ({ ...bucket, parameters: bucket.parameters.replace("s.tenant_id = request.jwt() ->> 'tenant_id'\n  AND ", '') }));
      expect(rules(checkSyncBuckets(broken, DIS_SYNC_TABLES))).toContain('TENANT_PARAMETER');
    });

    it('MEMBERSHIP_PARAMETER: a parameter query that does not filter by the membership of the token', () => {
      const broken = mutated((bucket) => ({ ...bucket, parameters: bucket.parameters.replace("AND s.membership_id = request.jwt() ->> 'membership_id'\n", '') }));
      expect(rules(checkSyncBuckets(broken, DIS_SYNC_TABLES))).toContain('MEMBERSHIP_PARAMETER');
    });

    it('TENANT_DATA: a data query that does not compare the tenant with the tenant of the bucket', () => {
      const broken = mutated((bucket) => withData(bucket, (query) => query.split('= bucket.tenant_id').join('IS NOT NULL')));
      expect(rules(checkSyncBuckets(broken, DIS_SYNC_TABLES))).toContain('TENANT_DATA');
    });

    it('LITERAL_TENANT: a query that names a tenant by its id', () => {
      const broken = mutated((bucket) => withData(bucket, (query) => `${query}\n  OR p.tenant_id = '00000000-0000-4000-8000-00000000000a'`));
      expect(rules(checkSyncBuckets(broken, DIS_SYNC_TABLES))).toContain('LITERAL_TENANT');
    });

    it('STAR: a query that selects every column', () => {
      const qualified = mutated((bucket) => withData(bucket, (query) => query.replace(/^SELECT .*?\nFROM/s, 'SELECT p.*\nFROM')));
      expect(rules(checkSyncBuckets(qualified, DIS_SYNC_TABLES))).toContain('STAR');
      const bare = mutated((bucket) => withData(bucket, (query) => query.replace(/^SELECT .*?\nFROM/s, 'SELECT *\nFROM')));
      expect(rules(checkSyncBuckets(bare, DIS_SYNC_TABLES))).toContain('STAR');
    });

    it('COLUMN_NOT_ALLOWED: a column that is not on the allowlist of its table', () => {
      const broken = mutated((bucket) => withData(bucket, (query) => query.replace('p.name', 'p.name, p.investment_total_vnd')));
      expect(checkSyncBuckets(broken, DIS_SYNC_TABLES)).toContainEqual({ bucket: 'dis_projects', rule: 'COLUMN_NOT_ALLOWED', detail: 'project.investment_total_vnd' });
    });

    it('TABLE_NOT_ALLOWED: a table that holds personal data, a table outside the contract, and rows that do not come from the table the bucket names', () => {
      const personal = mutated((bucket) => withData(bucket, (query) => query.replace('FROM project p', 'FROM project p\nJOIN household h ON h.tenant_id = p.tenant_id')));
      expect(checkSyncBuckets(personal, DIS_SYNC_TABLES)).toContainEqual({ bucket: 'dis_projects', rule: 'TABLE_NOT_ALLOWED', detail: 'household holds personal data' });
      const outside = mutated((bucket) => ({ ...bucket, data: [{ table: 'contract', query: (bucket.data[0] as { query: string }).query.replace('FROM project p', 'FROM contract p') }] }));
      expect(rules(checkSyncBuckets(outside, DIS_SYNC_TABLES))).toContain('TABLE_NOT_ALLOWED');
      const wrongSource = mutated((bucket) => ({ ...bucket, data: bucket.data.map((entry) => ({ ...entry, table: 'reporting_period' })) }));
      expect(rules(checkSyncBuckets(wrongSource, DIS_SYNC_TABLES))).toContain('TABLE_NOT_ALLOWED');
    });

    it('MONEY_WRITABLE: a money column of the contract that is not marked read only', () => {
      const tables: SyncTable[] = DIS_SYNC_TABLES.map((table) => ({ ...table, columns: table.columns.map((column) => (column.name === 'disbursed_cumulative_vnd' ? { name: column.name } : column)) }));
      expect(checkSyncBuckets(DIS_SYNC_BUCKETS, tables)).toContainEqual({ bucket: 'contract:funding_snapshot_line', rule: 'MONEY_WRITABLE', detail: 'disbursed_cumulative_vnd' });
    });
  });

  it('money is read only everywhere in the contract of the phone, and no personal-data column is on it', () => {
    for (const table of DIS_SYNC_TABLES) {
      for (const column of table.columns) {
        if (/_vnd$/.test(column.name)) expect(column.readOnlyMoney).toBe(true);
        expect(column.name).not.toMatch(/(^|_)(phone|email|address|citizen|cccd|national_id|birth)(_|$)/);
      }
    }
  });
});
