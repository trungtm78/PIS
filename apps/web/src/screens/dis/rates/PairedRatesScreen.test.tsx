import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PERIOD, RATE_READER, client, mount, routeOf, world } from '../report/test-support';
import PairedRatesScreen from './PairedRatesScreen';
import { OTHER_SNAPSHOT, SNAPSHOT, UNIT, answerFor, figures, groupRecord, notFound, ratesRecord } from './rates-test-support';

const ROUTE = routeOf('DIS-19', 'FR-DIS-19');

afterEach(cleanup);

const frozen = (id: string, over: Record<string, unknown> = {}) => ({
  id,
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
  ...over,
});

const open = (options: { rates?: ReturnType<typeof world>['rates']; path?: string; permissions?: readonly string[] | undefined } = {}) => {
  const h = client(
    world({
      rates: 'rates' in options ? options.rates : answerFor(ratesRecord(), [groupRecord('DA-2027-001'), groupRecord('DA-2027-002', { rate_pm_pct: null, rate_total_pct: null, rate_null_reason: 'ZERO_DENOMINATOR', plan_pm_assigned_vnd: '0', plan_local_added_vnd: '0', plan_total_vnd: '0', treasury_coverage: 'NONE' })]),
      snapshots: { '': { items: [frozen(SNAPSHOT), frozen(OTHER_SNAPSHOT, { treasury_cutoff_date: '2027-01-03' })], next_cursor: null, pending_reports: null } },
    }),
  );
  mount(<PairedRatesScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : RATE_READER, path: options.path ?? '/dis/dis-19' });
  return h;
};
const queries = (h: { read: { mock: { calls: unknown[][] } } }) => h.read.mock.calls.filter((call) => call[0] === 'getDisbursementRates').map((call) => (call[1] as { query: Record<string, string> }).query);

describe('DIS-19 the two rates side by side', () => {
  it('AC-ST-DIS-010-1 / AC-ST-DIS-010-5 / UI-DIS-19: shows the two rates together over one numerator, with the formula and its reference, and the label that the formulas await D03', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.paired.page.title'] })).toBeTruthy();
    const pair = await screen.findByTestId('rate-pair');
    expect(within(pair).getByTestId('rate-pm').textContent).toBe('60.0000%');
    expect(within(pair).getByTestId('rate-total').textContent).toBe('48.0000%');
    expect(within(pair).getByTestId('fact-numerator').textContent).toBe('600.000.000');
    expect(within(pair).getByTestId('fact-plan-pm').textContent).toBe('1.000.000.000');
    expect(within(pair).getByTestId('fact-plan-total').textContent).toBe('1.250.000.000');
    expect(within(pair).getByTestId('fact-cutoff').textContent).toBe('2027-01-10');
    // The formula is in the tooltip of each rate, with the reference, and in the text that opens.
    expect(pair.querySelector('[data-rate="pm"]')?.getAttribute('title')).toContain('CXN-03');
    expect(pair.querySelector('[data-rate="total"]')?.getAttribute('title')).toContain('CXN-03');
    expect(within(pair).getByText(/CXN-03/, { selector: 'p' })).toBeTruthy();
    expect(within(pair).getByTestId('definition-pending').textContent).toBe('CHỜ KÝ D03');
    expect(within(pair).queryByTestId('rate-pm-over')).toBeNull();
  });

  it('AC-ST-DIS-010-5: never shows one rate alone: the pair, the headers and the cells of every row come together, whatever is shown', async () => {
    open();
    const table = await screen.findByTestId('paired-table');
    expect(within(table).getByRole('columnheader', { name: vi_['dis.rates.col.ratePm'] })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: vi_['dis.rates.col.rateTotal'] })).toBeTruthy();
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      expect(row.querySelectorAll('[data-rate="pm"]')).toHaveLength(1);
      expect(row.querySelectorAll('[data-rate="total"]')).toHaveLength(1);
    }
    const first = table.querySelector('tr[data-project="DA-2027-001"]') as HTMLElement;
    expect(Array.from(first.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['DA-2027-001Tên DA-2027-001', '1.000.000.000', '250.000.000', '600.000.000', '60.0000%', '48.0000%', vi_['dis.rates.coverage.complete']]);
  });

  it('AC-ST-DIS-010-3 / UAT-AC04: says "Chưa có cơ sở tính" for a project with no plan, never 0% and never an infinite rate, with the Treasury coverage of the project', async () => {
    open();
    const table = await screen.findByTestId('paired-table');
    const row = table.querySelector('tr[data-project="DA-2027-002"]') as HTMLElement;
    expect(row.querySelector('[data-rate="pm"]')?.textContent).toBe('Chưa có cơ sở tính');
    expect(row.querySelector('[data-rate="total"]')?.textContent).toBe('Chưa có cơ sở tính');
    expect(row.textContent).not.toMatch(/0(\.0+)?%|Infinity|NaN/);
    expect(within(row).getByText(vi_['dis.rates.coverage.none'])).toBeTruthy();
    expect(vi_['dis.rates.reason.zeroDenominator']).toBe('Chưa có cơ sở tính');
  });

  it('says why a rate is missing in the words of the reason: no data, and a Treasury that booked nothing', async () => {
    open({ rates: answerFor(ratesRecord(figures({ numerator_disbursed_vnd: null, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: 'NO_DATA', treasury_coverage: 'PARTIAL' })), []) });
    expect((await screen.findByTestId('rate-pm')).textContent).toBe(vi_['dis.rates.reason.noData']);
    expect(screen.getByTestId('fact-numerator').textContent).toBe('—');
    cleanup();
    open({ rates: answerFor(ratesRecord(figures({ numerator_disbursed_vnd: null, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: 'TREASURY_COVERAGE_NONE', treasury_coverage: 'NONE' })), []) });
    expect((await screen.findByTestId('rate-total')).textContent).toBe(vi_['dis.rates.reason.noTreasury']);
    expect(screen.getByTestId('paired-empty').textContent).toBe(vi_['dis.paired.table.empty.text']);
  });

  it('notes that the rate on the plan of the Prime Minister can pass 100% when the province adds capital', async () => {
    open({ rates: answerFor(ratesRecord(figures({ numerator_disbursed_vnd: '1500000000', rate_pm_pct: '150.0000', rate_total_pct: '120.0000' })), []) });
    expect((await screen.findByTestId('rate-pm')).textContent).toBe('150.0000%');
    expect(screen.getByTestId('rate-pm-over').textContent).toBe(vi_['dis.rates.pair.over.note']);
  });

  it('reads the most recent frozen snapshot when none is chosen, and asks for the one that is chosen, for the capital carried over and for one unit', async () => {
    const user = userEvent.setup();
    const h = open({ rates: (query) => ({ ...ratesRecord({ basis: query.bucket }), groups: [] }) });
    await screen.findByTestId('rate-pair');
    expect(queries(h)).toEqual([{ bucket: 'CURRENT_YEAR', group_by: 'PROJECT' }]);
    await user.selectOptions(screen.getByLabelText(vi_['dis.rates.snapshot.label']), OTHER_SNAPSHOT);
    await waitFor(() => expect(queries(h).some((query) => query.snapshot_id === OTHER_SNAPSHOT)).toBe(true));
    await user.selectOptions(screen.getByLabelText(vi_['dis.rates.basis.label']), 'CARRYOVER');
    await waitFor(() => expect(queries(h).some((query) => query.bucket === 'CARRYOVER' && query.snapshot_id === OTHER_SNAPSHOT)).toBe(true));
    expect((await screen.findByRole('heading', { level: 2, name: vi_['dis.rates.pair.title.carryover'] })).textContent).toBe(vi_['dis.rates.pair.title.carryover']);
  });

  it('opens on one unit from the address, says so, and goes back to all of them', async () => {
    const user = userEvent.setup();
    const h = open({ path: `/dis/dis-19?snapshot=${SNAPSHOT}&unit=${UNIT}` });
    expect((await screen.findByTestId('paired-unit')).textContent).toContain(vi_['dis.paired.unit.text']);
    expect(queries(h).every((query) => query.unit_id === UNIT && query.snapshot_id === SNAPSHOT)).toBe(true);
    await user.click(screen.getByRole('button', { name: vi_['dis.paired.unit.clear.action'] }));
    await waitFor(() => expect(screen.queryByTestId('paired-unit')).toBeNull());
    expect(queries(h).some((query) => query.unit_id === undefined)).toBe(true);
  });

  it('says there is nothing to read when no snapshot was frozen, and tells a refusal in words', async () => {
    open({ rates: undefined });
    expect((await screen.findByTestId('rates-refusal')).textContent).toContain(vi_['dis.rates.problem.notFound']);
    cleanup();
    open({ rates: () => notFound() });
    expect((await screen.findByTestId('rates-refusal')).textContent).toContain(vi_['dis.rates.problem.notFound']);
    cleanup();
    open({ rates: () => new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c' }) });
    expect((await screen.findByTestId('rates-refusal')).textContent).toContain(vi_['dis.rates.problem.validation']);
  });

  it('lets a person try again after a failure, and the answer that follows replaces the message', async () => {
    const user = userEvent.setup();
    let failing = true;
    open({ rates: (query) => (failing ? new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c' }) : answerFor(ratesRecord(), [groupRecord('DA-2027-001')])(query)) });
    expect((await screen.findByTestId('rates-refusal')).textContent).toContain(vi_['dis.rates.problem.general']);
    failing = false;
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('rate-pair')).toBeTruthy();
    expect(screen.queryByTestId('rates-refusal')).toBeNull();
  });

  it('shows the signed label once the formulas are signed', async () => {
    open({ rates: answerFor(ratesRecord({ definition_status: 'SIGNED' }), []) });
    expect(await screen.findByTestId('definition-signed')).toBeTruthy();
    expect(screen.queryByTestId('definition-pending')).toBeNull();
  });
});
