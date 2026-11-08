import type { TenantTx } from '@machvon/db';
import { DisPeriodReopenPort } from './hpm-store.ts';

const NOW = new Date('2026-11-08T03:00:00Z');
const REOPEN = '33333333-3333-4333-8333-333333333333';

type Row = { status: string; window_until: string | null; scope_kind: string; start_date: string; end_date: string };
const open: Row = { status: 'APPROVED', window_until: '2026-11-10 00:00:00+00', scope_kind: 'PERIOD', start_date: '2026-10-10', end_date: '2026-10-16' };

/** A transaction that answers the one query of the port with the rows given; the statement is kept to see what was asked. */
function txOf(rows: Row[]): { tx: TenantTx; asked: Array<{ sql: string; params: unknown[] }> } {
  const asked: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: (sql: string, params: unknown[] = []): Promise<Row[]> => {
      asked.push({ sql, params });
      return Promise.resolve(rows);
    },
  } as unknown as TenantTx;
  return { tx, asked };
}

describe('the reopening of DIS, judged for the period of the report being corrected', () => {
  const port = new DisPeriodReopenPort();

  it('says nothing is there for an id that is not a reopening of this tenant', async () => {
    const { tx, asked } = txOf([]);
    expect(await port.status(tx, REOPEN, '2026-M10', NOW)).toBe('MISSING');
    expect(asked[0]?.params).toEqual([REOPEN]);
    expect(asked[0]?.sql).toContain('machvon.reporting_period');
  });

  it('is open for an approved reopening of the whole period whose window is not over and whose days fall within the report period', async () => {
    expect(await port.status(txOf([open]).tx, REOPEN, '2026-M10', NOW)).toBe('OPEN');
    expect(await port.status(txOf([open]).tx, REOPEN, '2026-Q4', NOW)).toBe('OPEN');
    expect(await port.status(txOf([open]).tx, REOPEN, '2026', NOW)).toBe('OPEN');
  });

  it('is the reopening of another period when its days do not touch the days of the report: October reopened does not let September be replaced', async () => {
    expect(await port.status(txOf([open]).tx, REOPEN, '2026-M09', NOW)).toBe('OTHER_PERIOD');
    expect(await port.status(txOf([open]).tx, REOPEN, '2026-M11', NOW)).toBe('OTHER_PERIOD');
    expect(await port.status(txOf([open]).tx, REOPEN, '2025-M10', NOW)).toBe('OTHER_PERIOD');
  });

  it('does not cover the report of an organisation when it reopens some projects only', async () => {
    expect(await port.status(txOf([{ ...open, scope_kind: 'PROJECTS' }]).tx, REOPEN, '2026-M10', NOW)).toBe('OTHER_PERIOD');
  });

  it('is closed when the reopening is not approved or its window is over', async () => {
    expect(await port.status(txOf([{ ...open, status: 'REQUESTED', window_until: null }]).tx, REOPEN, '2026-M10', NOW)).toBe('CLOSED');
    expect(await port.status(txOf([{ ...open, status: 'REJECTED' }]).tx, REOPEN, '2026-M10', NOW)).toBe('CLOSED');
    expect(await port.status(txOf([{ ...open, status: 'EXPIRED', window_until: '2026-11-07 00:00:00+00' }]).tx, REOPEN, '2026-M10', NOW)).toBe('CLOSED');
    expect(await port.status(txOf([{ ...open, window_until: '2026-11-08 02:59:59+00' }]).tx, REOPEN, '2026-M10', NOW)).toBe('CLOSED');
  });
});
