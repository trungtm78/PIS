import { MIGRATION_MAPPINGS, checkReferences, checkRegistration, judgeMigrationFile, migrationMappingOf, totalsMatch } from '../src/migration-batch.ts';
import type { MigrationMapping } from '../src/migration-batch.ts';

const generic = MIGRATION_MAPPINGS.get('GENERIC-1') as MigrationMapping;
const child = MIGRATION_MAPPINGS.get('GENERIC-CHILD-1') as MigrationMapping;
const table = (headers: string[], rows: string[][]) => ({ headers, rows, lines: rows.map((_, index) => index + 2) });
const thrown = (run: () => unknown): { code: string; status: number; detail?: string } => {
  try {
    run();
  } catch (error) {
    return error as never;
  }
  throw new Error('nothing was thrown');
};

describe('the judgement of a conversion file (ST-ADM-020, BR-ADM-12, UAT-AC143)', () => {
  it('lists the bad rows of a 120-row file with their place, and sums the control totals of the rest as integers', () => {
    const rows = Array.from({ length: 120 }, (_, index) => [`K${index + 1}`, String((index + 1) * 1000), `name ${index + 1}`]);
    rows[16] = ['', '5', 'no key'];
    rows[41] = ['K42', '12.5', 'bad amount'];
    const judged = judgeMigrationFile(table(['business_key', 'amount', 'name'], rows), generic);
    expect(judged.errors.map((error) => [error.rowNumber, error.lineNumber, error.field, error.code])).toEqual([
      [17, 18, 'business_key', 'KEY_MISSING'],
      [42, 43, 'amount', 'AMOUNT_INVALID'],
    ]);
    expect(judged.errorCount).toBe(2);
    expect(judged.rowCount).toBe(120);
    expect(judged.rows).toHaveLength(118);
    const expected = Array.from({ length: 120 }, (_, index) => (index + 1) * 1000).reduce((sum, amount, index) => (index === 16 || index === 41 ? sum : sum + amount), 0);
    expect(judged.totals).toEqual({ rows: 118, amount: String(expected) });
    expect(judged.rows[0]).toMatchObject({ rowNumber: 1, businessKey: 'K1', amount: '1000', payload: { business_key: 'K1', amount: '1000', name: 'name 1' }, refs: [] });
  });

  it('sums money without a float: 24 digits stay exact, a sign counts, an amount may be left out', () => {
    const big = '999999999999999999999999';
    const judged = judgeMigrationFile(
      table(
        ['business_key', 'amount'],
        [
          ['A', big],
          ['B', big],
          ['C', '-1'],
          ['D', ''],
          ['E', '+5'],
          ['F', '1000000000000000000000000'],
        ],
      ),
      generic,
    );
    expect(judged.totals).toEqual({ rows: 4, amount: (BigInt(big) * 2n - 1n).toString() });
    expect(judged.errors.map((error) => [error.rowNumber, error.code])).toEqual([
      [5, 'AMOUNT_INVALID'],
      [6, 'AMOUNT_INVALID'],
    ]);
    expect(judged.rows.find((row) => row.businessKey === 'D')?.amount).toBeNull();
  });

  it('refuses a key that is empty, too long or on an earlier row, and a cell that is too long, naming where', () => {
    const judged = judgeMigrationFile(
      table(
        ['business_key', 'amount', 'note'],
        [
          ['A', '1', 'x'],
          ['A', '2', 'y'],
          ['k'.repeat(201), '3', 'z'],
          ['B', '4', 'n'.repeat(2001)],
        ],
      ),
      generic,
    );
    expect(judged.errors.map((error) => [error.rowNumber, error.field, error.code])).toEqual([
      [2, 'business_key', 'DUPLICATE_KEY'],
      [3, 'business_key', 'KEY_TOO_LONG'],
      [4, 'note', 'FIELD_TOO_LONG'],
    ]);
    expect(judged.errors[0]?.message).toBe('the business key is also on row 1');
    expect(judged.totals).toEqual({ rows: 1, amount: '1' });
  });

  it('judges a file with a column missing by that alone, and a file with too many rows by that alone', () => {
    const missing = judgeMigrationFile(table(['business_key'], [['A']]), child);
    expect(missing.errors.map((error) => [error.field, error.code])).toEqual([
      ['parent_key', 'COLUMN_MISSING'],
      ['amount', 'COLUMN_MISSING'],
    ]);
    expect(missing.rows).toEqual([]);
    const many = judgeMigrationFile({ headers: ['business_key'], rows: Array.from({ length: 100_001 }, (_, index) => [`K${index}`]), lines: [] }, generic);
    expect(many.errors.map((error) => error.code)).toEqual(['COLUMN_MISSING', 'TOO_MANY_ROWS']);
    expect(many.rowCount).toBe(100_001);
  });

  it('keeps at most the first 1000 problems but counts them all', () => {
    const judged = judgeMigrationFile(
      table(
        ['business_key', 'amount'],
        Array.from({ length: 1500 }, () => ['', '1']),
      ),
      generic,
    );
    expect(judged.errors).toHaveLength(1000);
    expect(judged.errorCount).toBe(1500);
  });

  it('keeps a column called like what an object inherits, as the source called it', () => {
    const judged = judgeMigrationFile(table(['business_key', '__proto__', 'constructor', 'amount'], [['A', 'one', 'two', '5']]), generic);
    expect(judged.errors).toEqual([]);
    const payload = judged.rows[0]?.payload as Record<string, string>;
    expect(Object.keys(payload)).toEqual(['business_key', '__proto__', 'constructor', 'amount']);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(JSON.parse('{"business_key":"A","__proto__":"one","constructor":"two","amount":"5"}'));
  });

  it('judges a missing required cell and a row whose lines are not known', () => {
    const judged = judgeMigrationFile({ headers: ['business_key', 'amount', 'parent_key'], rows: [['A', '1', '']], lines: [] }, child);
    expect(judged.errors).toEqual([{ rowNumber: 1, lineNumber: 2, field: 'parent_key', code: 'FIELD_MISSING', message: 'parent_key is empty' }]);
  });

  it('checks the rows that refer to a row nobody migrated, and drops them from the totals', () => {
    const judged = judgeMigrationFile(
      table(
        ['business_key', 'amount', 'parent_key'],
        [
          ['C1', '10', 'P1'],
          ['C2', '20', 'P9'],
          ['C3', '30', 'P1'],
        ],
      ),
      child,
    );
    expect(judged.errors).toEqual([]);
    const checked = checkReferences(judged, child, new Map([['PARENT', new Set(['P1'])]]));
    expect(checked.errors).toEqual([{ rowNumber: 2, lineNumber: 3, field: 'parent_key', code: 'REFERENCE_UNKNOWN', message: 'no PARENT was migrated under that key' }]);
    expect(checked.errorCount).toBe(1);
    expect(checked.rows.map((row) => row.businessKey)).toEqual(['C1', 'C3']);
    expect(checked.totals).toEqual({ rows: 2, amount: '40' });
    expect(checkReferences(judged, child, new Map()).errorCount).toBe(3);
  });

  it('knows the mappings, and names a registration the way the platform does', () => {
    expect(migrationMappingOf('GENERIC-1').version).toBe('GENERIC-1');
    expect(thrown(() => migrationMappingOf('NOPE')).detail).toBe('mapping_version');
    expect(() => checkRegistration({ sourceSystem: 'LEGACY-ERP.1', targetEntity: 'ACCOUNT', mappingVersion: 'GENERIC-1' })).not.toThrow();
    expect(thrown(() => checkRegistration({ sourceSystem: '', targetEntity: 'ACCOUNT', mappingVersion: 'GENERIC-1' })).detail).toBe('source_system');
    expect(thrown(() => checkRegistration({ sourceSystem: 'ERP', targetEntity: 'account', mappingVersion: 'GENERIC-1' })).detail).toBe('target_entity');
    expect(thrown(() => checkRegistration({ sourceSystem: 'ERP', targetEntity: 'ACCOUNT', mappingVersion: 'NOPE' })).detail).toBe('mapping_version');
  });

  it('compares what was written with what the file said', () => {
    expect(totalsMatch({ rows: 2, amount: '40' }, { rows: 2, amount: '40' })).toBe(true);
    expect(totalsMatch({ rows: 2, amount: '40' }, { rows: 2, amount: '41' })).toBe(false);
    expect(totalsMatch({ rows: 2, amount: '40' }, { rows: 3, amount: '40' })).toBe(false);
  });
});
