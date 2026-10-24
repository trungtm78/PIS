import { resolve } from 'node:path';
import { Client } from 'pg';
import { EFFECTIVE_RANGE_TABLES } from '../src/effective-range-registry';
import type { RangeDeclaration } from '../src/effective-range-registry';
import { hasRange, rangeReport, readRangeCatalog } from '../src/effective-range-lint';
import type { RangeCatalog, RangeCatalogTable } from '../src/effective-range-lint';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedTestDatabase(REPO_ROOT);
}, 180_000);

afterAll(async () => {
  await database.stop();
}, 60_000);

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const table = (overrides: Partial<RangeCatalogTable> = {}): RangeCatalogTable => ({
  name: 'rule_version',
  columns: ['tenant_id', 'effective_from', 'effective_until'],
  periodChecks: ['CHECK (((effective_until IS NULL) OR (effective_until > effective_from)))'],
  exclusions: [{ name: 'rule_version_no_overlap', definition: "EXCLUDE USING gist (tenant_id WITH =, daterange(effective_from, effective_until, '[)'::text) WITH &&)" }],
  triggers: [],
  ...overrides,
});
const rule = (guard: RangeDeclaration['guard'] | null = { type: 'EXCLUDE', name: 'rule_version_no_overlap' }): RangeDeclaration => ({ table: 'rule_version', kind: 'RULE', ...(guard === null ? {} : { guard }) });
const catalog = (...tables: RangeCatalogTable[]): RangeCatalog => ({ tables });
const reasons = (report: ReturnType<typeof rangeReport>): string[] => report.failures.map((failure) => `${failure.table}:${failure.reason}`);

describe('the effective ranges of the schema (ST-KERNEL-060, AC-ST-KERNEL-060-1)', () => {
  it('declares every table of the migrated schema that has a start and an end of validity, and every declared guard exists', async () => {
    const found = await admin((client) => readRangeCatalog(client));
    const report = rangeReport(found);
    expect(report.failures).toEqual([]);
    expect(found.tables.map((entry) => entry.name).sort()).toEqual(EFFECTIVE_RANGE_TABLES.map((declaration) => declaration.table).sort());
    expect(report.rules).toBeGreaterThanOrEqual(13);
    // What is still without its guard is named, so a new one is noticed and a table that gets its guard leaves the list.
    expect(report.pending).toEqual(['metric_definition']);
  });

  it('keeps two published versions of one rule from covering the same day: the tables that used to hold only a start date now refuse an overlap', async () => {
    const tenant = '00000000-0000-4000-8000-00000000000a';
    const insertType = (client: Client, from: string, until: string | null, status = 'PUBLISHED'): Promise<unknown> =>
      client.query(
        `insert into machvon.doc_type (tenant_id, id, code, name, symbol_kind, symbol_pattern, register_code, legal_basis, effective_from, effective_until, status, created_by, updated_by)
         values ($1, gen_random_uuid(), 'RANGE-LINT', 'Probe', 'DECISION', '{number}/{type}', 'REG', 'basis', $2::date, $3::date, $4, $1, $1)`,
        [tenant, from, until, status],
      );
    await admin(async (client) => {
      await client.query('begin');
      try {
        await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
        await insertType(client, '2026-01-01', '2026-12-31');
        await insertType(client, '2027-01-01', null);
        await insertType(client, '2026-06-01', '2026-06-30', 'DRAFT');
        await expect(
          (async () => {
            await insertType(client, '2026-12-31', '2027-02-01');
            await client.query('set constraints all immediate');
          })(),
        ).rejects.toMatchObject({ code: '23P01' });
      } finally {
        await client.query('rollback');
      }
    });
  });

  describe('the judgement of a catalog', () => {
    it('passes a rule whose guard exists, and a trigger guard that exists', () => {
      expect(rangeReport(catalog(table()), [rule()]).failures).toEqual([]);
      expect(rangeReport(catalog(table({ triggers: ['rule_guard'] })), [rule({ type: 'TRIGGER', name: 'rule_guard' })]).failures).toEqual([]);
    });

    it('refuses a table that has a range and is not declared', () => {
      expect(reasons(rangeReport(catalog(table(), table({ name: 'new_rule_version' })), [rule()]))).toEqual(['new_rule_version:undeclared_range']);
    });

    it('refuses a declared table that is not there, and one that has no range', () => {
      expect(reasons(rangeReport(catalog(), [rule()]))).toEqual(['rule_version:declared_table_missing']);
      expect(hasRange(['id', 'effective_from'])).toBe(false);
      expect(hasRange(['id', 'valid_from', 'valid_until'])).toBe(true);
    });

    it('refuses a range with no check that it ends after it starts', () => {
      expect(reasons(rangeReport(catalog(table({ periodChecks: [] })), [rule()]))).toEqual(['rule_version:no_period_check']);
    });

    it('refuses a rule whose guard is missing, is not over a daterange, or is not named', () => {
      expect(reasons(rangeReport(catalog(table({ exclusions: [] })), [rule()]))).toEqual(['rule_version:guard_missing']);
      expect(reasons(rangeReport(catalog(table({ exclusions: [{ name: 'rule_version_no_overlap', definition: 'EXCLUDE USING gist (tenant_id WITH =)' }] })), [rule()]))).toEqual(['rule_version:guard_not_a_range']);
      expect(reasons(rangeReport(catalog(table()), [rule({ type: 'TRIGGER', name: 'gone' })]))).toEqual(['rule_version:guard_missing']);
      expect(reasons(rangeReport(catalog(table()), [rule(null)]))).toEqual(['rule_version:rule_without_guard']);
    });

    it('wants a reason for what is not a rule, and lists what is pending', () => {
      const validity: RangeDeclaration = { table: 'rule_version', kind: 'VALIDITY', reason: '  ' };
      expect(reasons(rangeReport(catalog(table()), [validity]))).toEqual(['rule_version:reason_missing']);
      const pending = rangeReport(catalog(table()), [{ table: 'rule_version', kind: 'PENDING', reason: 'the publisher is not built yet' }]);
      expect(pending.failures).toEqual([]);
      expect(pending.pending).toEqual(['rule_version']);
    });
  });
});
