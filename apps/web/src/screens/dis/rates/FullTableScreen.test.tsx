import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PERIOD, RATE_READER, client, mount, routeOf, world } from '../report/test-support';
import FullTableScreen from './FullTableScreen';
import { SNAPSHOT, ratesRecord } from './rates-test-support';

const ROUTE = routeOf('DIS-16', 'FR-DIS-16');
const LINE = (n: number) => `00000000-0000-4000-8000-00000000e${String(n).padStart(3, '0')}`;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const snapshot = {
  id: SNAPSHOT,
  period_id: PERIOD,
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_at: '2027-01-12T03:00:00.000Z',
  as_of_date: '2027-01-10',
  treasury_cutoff_date: '2027-01-10',
  status: 'FROZEN',
  metric_set_version: 'DIS-METRICS-R1-PROPOSED',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 6,
  payload_sha256: 'a'.repeat(64),
  version: 2,
  created_at: '2027-01-12T02:00:00.000Z',
};

/** The six cells of FX-DIS-001: 100/200/30/70/0/20 million, 420 million in all, and 40 million of CTMTQG inside the first cell. */
const cells: Array<[string, string, string, string | null]> = [
  ['CURRENT_YEAR', 'CENTRAL', '100000000', '40000000'],
  ['CURRENT_YEAR', 'LOCAL', '200000000', null],
  ['CARRYOVER', 'CENTRAL', '30000000', null],
  ['CARRYOVER', 'LOCAL', '70000000', null],
  ['OTHER', 'CENTRAL', '0', null],
  ['OTHER', 'LOCAL', '20000000', null],
];
const line = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const [bucket, level, reported, ctmtqg] = cells[n] as [string, string, string, string | null];
  return {
    id: LINE(n),
    project_id: '00000000-0000-4000-8000-000000000041',
    project_code: 'DA-2027-001',
    unit_id: '00000000-0000-4000-8000-000000000051',
    fund_source_version_id: null,
    bucket,
    budget_level: level,
    plan_pm_assigned_vnd: '500000000',
    plan_local_added_vnd: '0',
    plan_total_vnd: '500000000',
    disbursed_treasury_vnd: n === 0 ? '250000000' : null,
    disbursed_reported_vnd: reported,
    period_delta_vnd: n === 0 ? '-20000000' : null,
    ctmtqg_subset_vnd: ctmtqg,
    rate_pm_pct: n === 0 ? '50.0000' : null,
    rate_total_pct: n === 0 ? '50.0000' : null,
    rate_null_reason: n === 0 ? null : 'NO_DATA',
    treasury_coverage: n === 0 ? 'PARTIAL' : 'NONE',
    ...over,
  };
};

const open = (pages: Record<string, Record<string, unknown>> = { '': { snapshot, items: [0, 1, 2, 3, 4, 5].map((n) => line(n)), next_cursor: null } }) => {
  const h = client(world({ rates: { ...ratesRecord(), groups: [] }, snapshots: { '': { items: [snapshot], next_cursor: null, pending_reports: null } }, snapshotLines: { [SNAPSHOT]: pages } }));
  mount(<FullTableScreen route={ROUTE} />, h, { permissions: RATE_READER, path: '/dis/dis-16' });
  return h;
};
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((header) => header.textContent);

describe('DIS-16 the full table and the configuration of its columns', () => {
  it('AC-ST-DIS-010-4 / UAT-AC240 / FX-DIS-001: shows the CTMTQG of 40 million as a column of its own, apart from the 420 million of the cells, and does not add it to the total', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.full.page.title'] })).toBeTruthy();
    const table = await screen.findByTestId('full-table');
    expect(headers(table)).toContain(vi_['dis.full.col.ctmtqg']);
    expect(table.querySelector('tr[data-line="' + LINE(0) + '"] [data-col="ctmtqg"]')?.textContent).toBe('40.000.000');
    expect(table.querySelector('tr[data-line="' + LINE(0) + '"] [data-col="reported"]')?.textContent).toBe('100.000.000');
    expect(screen.getByTestId('total-reported').textContent).toBe('420.000.000');
    expect(screen.getByTestId('total-ctmtqg').textContent).toBe('40.000.000');
    expect(screen.getByText(vi_['dis.full.total.note'])).toBeTruthy();
  });

  it('opens on the most recent frozen close snapshot, says the day of the cutoff, and carries the label that the formulas await D03', async () => {
    const h = open();
    expect((await screen.findByTestId('full-cutoff')).textContent).toContain('Số Kho bạc tính đến hết ngày 2027-01-10');
    expect(screen.getByTestId('definition-pending').textContent).toBe('CHỜ KÝ D03');
    expect(h.read.mock.calls.some((call) => call[0] === 'listPeriodSnapshotLines' && (call[1] as { path: { id: string } }).path.id === SNAPSHOT)).toBe(true);
    expect(screen.getByRole('link', { name: vi_['dis.full.link.paired'] }).getAttribute('href')).toBe(`/dis/dis-19?snapshot=${SNAPSHOT}`);
  });

  it('pins the project and the cell, and shows both rates for every line with a dash and its reason where a line has none', async () => {
    open();
    const table = await screen.findByTestId('full-table');
    const first = table.querySelector('tr[data-line="' + LINE(0) + '"]') as HTMLElement;
    expect(first.querySelectorAll('.pinned')).toHaveLength(2);
    expect(headers(table).slice(0, 2)).toEqual([vi_['dis.snapshot.line.project'], vi_['dis.snapshot.line.cell']]);
    expect(first.querySelector('[data-rate="pm"]')?.textContent).toBe('50.0000%');
    expect(first.querySelector('[data-rate="total"]')?.textContent).toBe('50.0000%');
    const second = table.querySelector('tr[data-line="' + LINE(1) + '"]') as HTMLElement;
    expect(second.querySelector('[data-rate="pm"]')?.textContent).toBe(vi_['dis.rates.reason.noData']);
    expect(first.textContent).toContain('-20.000.000');
  });

  it('lets a person choose the columns, keeps the two rates as one choice, and remembers the choice for the next visit', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('full-table');
    await user.click(screen.getByRole('button', { name: vi_['dis.full.columns.action'] }));
    const config = await screen.findByTestId('column-config');
    await user.click(within(config).getByLabelText(vi_['dis.full.column.treasury']));
    await user.click(within(config).getByLabelText(vi_['dis.full.column.rates']));
    const table = screen.getByTestId('full-table');
    expect(headers(table)).not.toContain(vi_['dis.snapshot.line.treasury']);
    // Both rates leave together: never one alone.
    expect(headers(table)).not.toContain(vi_['dis.rates.col.ratePm']);
    expect(headers(table)).not.toContain(vi_['dis.rates.col.rateTotal']);
    expect(table.querySelectorAll('[data-rate]')).toHaveLength(0);
    // The CTMTQG stays, and the pinned columns cannot be switched off.
    expect(headers(table)).toContain(vi_['dis.full.col.ctmtqg']);
    expect(within(config).queryByLabelText(vi_['dis.snapshot.line.project'])).toBeNull();
    cleanup();
    open();
    const again = await screen.findByTestId('full-table');
    expect(headers(again)).not.toContain(vi_['dis.snapshot.line.treasury']);
    expect(again.querySelectorAll('[data-rate]')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: vi_['dis.full.columns.action'] }));
    await user.click(within(await screen.findByTestId('column-config')).getByLabelText(vi_['dis.full.column.rates']));
    expect(headers(screen.getByTestId('full-table'))).toEqual(expect.arrayContaining([vi_['dis.rates.col.ratePm'], vi_['dis.rates.col.rateTotal']]));
  });

  it('loads the next page of lines and adds them to the totals of the lines loaded', async () => {
    const user = userEvent.setup();
    open({
      '': { snapshot, items: [line(0)], next_cursor: 'next' },
      next: { snapshot, items: [line(1)], next_cursor: null },
    });
    await screen.findByTestId('full-table');
    expect(screen.getByTestId('total-reported').textContent).toBe('100.000.000');
    await user.click(screen.getByRole('button', { name: vi_['dis.snapshot.lines.more.action'] }));
    await waitFor(() => expect(screen.getByTestId('total-reported').textContent).toBe('300.000.000'));
    expect(screen.queryByRole('button', { name: vi_['dis.snapshot.lines.more.action'] })).toBeNull();
  });
});
