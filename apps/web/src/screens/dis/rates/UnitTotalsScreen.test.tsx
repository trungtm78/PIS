import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { RATE_READER, client, mount, routeOf, world } from '../report/test-support';
import UnitTotalsScreen from './UnitTotalsScreen';
import { SNAPSHOT, UNIT, answerFor, figures, groupRecord, ratesRecord } from './rates-test-support';

const ROUTE = routeOf('DIS-12', 'FR-DIS-12');
const OTHER_UNIT = '00000000-0000-4000-8000-000000000052';

afterEach(cleanup);

/** FX-DIS-003: two projects of 50/100 and 90/900 million in a unit, which is 140/1,000 million = 14%, with a unit of FX-DIS-004 next to it. */
const open = () => {
  const whole = ratesRecord(figures({ projects: 3, numerator_disbursed_vnd: '740000000', plan_pm_assigned_vnd: '2000000000', plan_local_added_vnd: '250000000', plan_total_vnd: '2250000000', rate_pm_pct: '37.0000', rate_total_pct: '32.8889' }));
  const groups = [
    groupRecord('U-1', { id: UNIT, name: 'Ban quản lý 1', projects: 2, numerator_disbursed_vnd: '140000000', plan_pm_assigned_vnd: '1000000000', plan_local_added_vnd: '0', plan_total_vnd: '1000000000', rate_pm_pct: '14.0000', rate_total_pct: '14.0000' }),
    groupRecord('U-2', { id: OTHER_UNIT, name: 'Ban quản lý 2' }),
  ];
  const h = client(world({ rates: answerFor(whole, groups), snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } }));
  mount(<UnitTotalsScreen route={ROUTE} />, h, { permissions: RATE_READER, path: '/dis/dis-12' });
  return h;
};

describe('DIS-12 totals by investor', () => {
  it('AC-ST-DIS-010-2 / FX-DIS-003 / UAT-AC242: shows a row for each unit with the rate of its sums (14%, not the mean of 50% and 10%), the two rates together, and the day the Treasury figures are cut off', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.unitTotals.page.title'] })).toBeTruthy();
    const table = await screen.findByRole('table', { name: vi_['dis.unitTotals.table.aria'] });
    const one = within(table).getByRole('row', { name: /Ban quản lý 1/ });
    expect(Array.from(one.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['Ban quản lý 1U-1', '2', '1.000.000.000', '0', '140.000.000', '14.0000%', '14.0000%', vi_['dis.rates.coverage.complete'], '2027-01-10']);
    const two = within(table).getByRole('row', { name: /Ban quản lý 2/ });
    expect(two.querySelector('[data-rate="pm"]')?.textContent).toBe('60.0000%');
    expect(two.querySelector('[data-rate="total"]')?.textContent).toBe('48.0000%');
    expect((await screen.findByTestId('totals-cutoff')).textContent).toBe('Số Kho bạc tính đến hết ngày 2027-01-10.');
  });

  it('closes with the row of all the units, made from the sums over the sums and not from the rates of the rows, and carries the label that the formulas await D03', async () => {
    open();
    const table = await screen.findByRole('table', { name: vi_['dis.unitTotals.table.aria'] });
    const row = table.querySelector('tfoot tr') as HTMLElement;
    expect(Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['3', '2.000.000.000', '250.000.000', '740.000.000', '37.0000%', '32.8889%', vi_['dis.rates.coverage.complete'], '2027-01-10']);
    expect(within(row).getByRole('rowheader').textContent).toBe(vi_['dis.unitTotals.total.label']);
    expect(screen.getByTestId('definition-pending').textContent).toBe('CHỜ KÝ D03');
  });

  it('leads each unit to its projects on DIS-19 over the same snapshot, and reads the units with the grouping of the contract', async () => {
    const h = open();
    const link = (await screen.findByRole('link', { name: 'Ban quản lý 1' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/dis/dis-19?snapshot=${SNAPSHOT}&unit=${UNIT}`);
    const asked = h.read.mock.calls.filter((call) => call[0] === 'getDisbursementRates').map((call) => (call[1] as { query: Record<string, string> }).query);
    expect(asked).toContainEqual({ bucket: 'CURRENT_YEAR', group_by: 'UNIT' });
  });
});
