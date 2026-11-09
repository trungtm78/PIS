import type { TenantTx } from '@machvon/db';
import { ORG_PACK_MAPPING, judgeMigrationFile, orgPackCsv, readTabularFile } from '@machvon/kernel';
import type { JudgedRow } from '@machvon/kernel';
import { pvfccoTemplatePack } from './pvfcco-template.ts';
import { orgPackCatalogueVerifier, registerEnterpriseOrgPack } from './register.ts';

const packRows = (): JudgedRow[] => judgeMigrationFile(readTabularFile(new TextEncoder().encode(orgPackCsv(pvfccoTemplatePack()))), ORG_PACK_MAPPING).rows;

/** Replaces the attributes of one entry in the rows, the way a customer would edit the file. */
const withAttributes = (rows: JudgedRow[], businessKey: string, change: (attributes: Record<string, unknown>) => void): JudgedRow[] =>
  rows.map((row) => {
    if (row.businessKey !== businessKey) return row;
    const data = JSON.parse(row.payload.data ?? '{}') as { attributes: Record<string, unknown> };
    change(data.attributes);
    return { ...row, payload: { ...row.payload, data: JSON.stringify(data) } };
  });

interface Call {
  sql: string;
  params: unknown[];
}
const txAnswering = (answer: () => unknown[] | Error): { tx: TenantTx; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    tx: {
      query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
        calls.push({ sql, params });
        const result = answer();
        if (result instanceof Error) throw result;
        return result as R[];
      },
    },
  };
};

describe('orgPackCatalogueVerifier (the dry run of the catalogue entries of a pack file)', () => {
  it('finds nothing wrong in the committed template pack, and needs no read of the tenant because the entries refer to each other', async () => {
    const { tx, calls } = txAnswering(() => []);
    expect(await orgPackCatalogueVerifier(tx, packRows())).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('names the row and the field of an entry that does not meet the rules of its type', async () => {
    const rows = withAttributes(packRows(), 'ENTRY:REPORTING_PERIOD_KIND:MONTH', (attributes) => {
      attributes.grain = 'FORTNIGHT';
    });
    const errors = await orgPackCatalogueVerifier(txAnswering(() => []).tx, rows);
    const row = rows.find((one) => one.businessKey === 'ENTRY:REPORTING_PERIOD_KIND:MONTH');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rowNumber: row?.rowNumber, lineNumber: row?.lineNumber, code: 'PACK_INVALID' });
    expect(errors[0]?.message).toContain('ENTRY_CONTENT: REPORTING_PERIOD_KIND MONTH does not meet the rules of its type');
  });

  it('reports every bad entry, not only the first', async () => {
    let rows = withAttributes(packRows(), 'ENTRY:REPORTING_PERIOD_KIND:MONTH', (attributes) => {
      attributes.grain = 'FORTNIGHT';
    });
    rows = withAttributes(rows, 'ENTRY:REPORTING_PERIOD_KIND:YEAR', (attributes) => {
      attributes.grain = 'DECADE';
    });
    const errors = await orgPackCatalogueVerifier(txAnswering(() => []).tx, rows);
    expect(errors.map((error) => error.message.match(/REPORTING_PERIOD_KIND (\w+)/)?.[1]).sort()).toEqual(['MONTH', 'YEAR']);
  });

  it('looks for a type that the pack does not carry among the entries of the tenant, and accepts what it finds', async () => {
    const without = packRows().filter((row) => !row.businessKey.startsWith('ENTRY:REPORTING_PERIOD_KIND:'));
    const { tx, calls } = txAnswering(() => [{ attributes: { grain: 'MONTH', months: 1, entry_deadline_working_days: 5 } }]);
    expect(await orgPackCatalogueVerifier(tx, without)).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.sql).toContain("r.status not in ('RETIRED', 'MERGED')");
    expect(calls[0]?.params[0]).toBe('REPORTING_PERIOD_KIND');
  });

  it('refuses the report types whose period kind is neither in the pack nor in the tenant', async () => {
    const without = packRows().filter((row) => !row.businessKey.startsWith('ENTRY:REPORTING_PERIOD_KIND:'));
    const errors = await orgPackCatalogueVerifier(txAnswering(() => []).tx, without);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.code === 'PACK_INVALID' && error.message.includes('REPORT_TYPE'))).toBe(true);
  });

  it('does not swallow a failure that is not a rule of the data: a lost connection stops the dry run', async () => {
    const without = packRows().filter((row) => !row.businessKey.startsWith('ENTRY:REPORTING_PERIOD_KIND:'));
    await expect(orgPackCatalogueVerifier(txAnswering(() => new Error('connection lost')).tx, without)).rejects.toThrow('connection lost');
  });
});

describe('registerEnterpriseOrgPack', () => {
  it('can be called again without a complaint (the edition may load twice in one process)', () => {
    registerEnterpriseOrgPack();
    expect(() => registerEnterpriseOrgPack()).not.toThrow();
  });
});
