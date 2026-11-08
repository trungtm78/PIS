import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { message } from '../test-catalogue';
import HubScreen from './HubScreen';
import { DEFINITIONS_CA2, analyticsClient, curveBody, evmBody, mount, portfolioBody, routeOf } from './test-support';

const ANALYST = ['contract.read', 'contract.analytics.read', 'ledger.read'];
const ROUTE = routeOf('CTR-28', 'FR-CTR-28');

const column = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({ key, kind, ledger: false, indicator: null, total: null, ...extra });
const IDENTITY = [column('code', 'TEXT'), column('title', 'TEXT')];
const group = (key: string, cells: Record<string, string | number | null>) => ({ key, totals: { rows: 1, ledger_rows: 1, cells, na: {}, indicators: [] } });
const rule = (type: string, over: Record<string, unknown> = {}) => ({ type, version: 0, source: 'DEFAULT', unverified: true, params: { tolerance_pct: 2, tolerance_vnd: 1000000 }, ...over });

/** A report body of the catalogue with the columns, rows and totals each test needs, over the definitions of CA-2. */
const body = (code: string, over: Record<string, unknown>) =>
  portfolioBody({
    code,
    ref: 'R',
    columns: IDENTITY,
    items: [],
    breakdown: null,
    totals: { rows: 3, ledger_rows: 3, cells: {}, na: {}, indicators: [] },
    definitions: DEFINITIONS_CA2,
    ...over,
  });

const open = (code: string, answers: Parameters<typeof analyticsClient>[0]) => {
  const h = analyticsClient(answers);
  mount(<HubScreen route={ROUTE} />, h, { permissions: ANALYST, path: `/ctr/ctr-28?report=${code}` });
  return h;
};
const reads = (h: ReturnType<typeof analyticsClient>, operation: string) => h.read.mock.calls.filter(([name]) => name === operation);

afterEach(cleanup);

describe('schedule delay with the earned value and the S-curve (R3)', () => {
  const schedule = (over: Record<string, unknown> = {}) =>
    body('schedule-delay', {
      columns: [...IDENTITY, column('spi', 'INDEX', { ledger: true, total: 'RATIO', indicator: 'SPI' }), column('earned_value_vnd', 'MONEY', { ledger: true, total: 'SUM' })],
      items: [
        { contract_id: '00000000-0000-4000-8000-001000000001', cells: { code: 'HD-1', title: 'A', spi: '0.8000', earned_value_vnd: '1200000000' }, na: {} },
        { contract_id: '00000000-0000-4000-8000-001000000002', cells: { code: 'HD-2', title: 'B', spi: null, earned_value_vnd: null }, na: { spi: 'NO_BASELINE', earned_value_vnd: 'NO_BASELINE' } },
      ],
      totals: { rows: 3, ledger_rows: 3, cells: { spi: '0.8000', earned_value_vnd: '2000000000' }, na: {}, indicators: [{ code: 'SPI', value: '0.8000', status: 'OK', reason: null, numerator: '2000000000', denominator: '2500000000' }] },
      evm: evmBody(),
      ...over,
    });

  it('shows the figures of the selection, how many contracts have them and why the others have none, with the "i" of each index', async () => {
    open('schedule-delay', { report: () => schedule() });
    await waitFor(() => expect(screen.getByTestId('evm-coverage')).toBeTruthy());
    const strip = screen.getByRole('group', { name: message('ca2.evm.label') });
    expect(within(strip).getByText('4.000.000.000')).toBeTruthy();
    expect(within(strip).getByText('0,8000')).toBeTruthy();
    expect(within(strip).getByText('0,9091')).toBeTruthy();
    expect(within(strip).getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.spi.name') }) })).toBeTruthy();
    expect(screen.getByTestId('evm-coverage').textContent).toContain(message('ca2.evm.coverage', { covered: 2, contracts: 3 }));
    expect(screen.getByTestId('evm-missing').textContent).toContain(message('ca2.evm.missing', { count: 1, reason: message('ca1.na.noContractLink') }));
  });

  it('writes an index as the language does, and a contract that has none says why in words, never 0', async () => {
    open('schedule-delay', { report: () => schedule() });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    const table = within(screen.getByTestId('report-table'));
    expect(table.getAllByText('0,8000').length).toBeGreaterThan(0);
    expect(table.getAllByText(message('ca1.na.noBaseline')).length).toBeGreaterThan(0);
    expect(table.queryByText('0')).toBeNull();
  });

  it('draws the curve from its own read of the same filter, with the plan, the earned value and the cost in a table for those who cannot see it', async () => {
    const h = open('schedule-delay', { report: () => schedule() });
    await waitFor(() => expect(screen.getByTestId('s-curve')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('img', { name: message('ca2.curve.caption') })).toBeTruthy());
    const call = reads(h, 'getContractScheduleSCurve')[0]?.[1] as { query: Record<string, string> };
    expect(call.query).not.toHaveProperty('sort');
    expect(call.query).not.toHaveProperty('period');
    const chart = within(screen.getByTestId('s-curve'));
    for (const label of [message('ca2.curve.series.ev'), message('ca2.curve.series.ac'), message('ca2.curve.series.pvCurrent'), message('ca2.curve.series.pvV0')]) expect(chart.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('v0-partial')).toBeNull();
  });

  it('says the original plan covers some contracts only when not all have version 0, and draws no flat line for a missing one', async () => {
    const partial = curveBody({ curve: { ...curveBody().curve, v0_complete: false, points: curveBody().curve.points.map((point) => ({ ...point, pv_v0_vnd: null })) } });
    open('schedule-delay', { report: () => schedule(), curve: () => partial });
    await waitFor(() => expect(screen.getByTestId('v0-partial').textContent).toBe(message('ca2.curve.v0Partial')));
    expect(within(screen.getByTestId('s-curve')).queryByText(message('ca2.curve.series.pvV0'))).toBeNull();
  });

  it('keeps the figures when the curve fails, and reads the curve again on retry', async () => {
    let attempts = 0;
    const h = open('schedule-delay', {
      report: () => schedule(),
      curve: () => {
        attempts += 1;
        return attempts === 1 ? new Error('boom') : curveBody();
      },
    });
    await waitFor(() => expect(within(screen.getByTestId('s-curve')).getByRole('alert')).toBeTruthy());
    expect(screen.getByTestId('evm-coverage')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('s-curve')).getByRole('button', { name: message('ui.common.retry') }));
    await waitFor(() => expect(reads(h, 'getContractScheduleSCurve').length).toBe(2));
    await waitFor(() => expect(screen.getByRole('img', { name: message('ca2.curve.caption') })).toBeTruthy());
  });

  it('says a frozen period holds no earned value and does not ask for a curve', async () => {
    const h = open('schedule-delay', { report: () => schedule({ evm: { status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' } }) });
    await waitFor(() => expect(screen.getByTestId('evm-unavailable').textContent).toBe(message('ca2.evm.unavailable', { reason: message('ca1.na.notInSnapshot') })));
    expect(screen.queryByTestId('s-curve')).toBeNull();
    expect(reads(h, 'getContractScheduleSCurve')).toHaveLength(0);
  });
});

describe('the three-way match and the payment clock (R4)', () => {
  const payments = (over: Record<string, unknown> = {}) =>
    body('payment-three-way', {
      columns: [...IDENTITY, column('match_status', 'TEXT', { ledger: true }), column('on_time_payment_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'ON_TIME_PAYMENT_RATE' }), column('requested_vnd', 'MONEY', { ledger: true, total: 'SUM' })],
      items: [
        { contract_id: '00000000-0000-4000-8000-001000000001', cells: { code: 'HD-1', title: 'A', match_status: 'OVER_PAID', on_time_payment_pct: '50.00', requested_vnd: '900000000' }, na: {} },
        { contract_id: '00000000-0000-4000-8000-001000000002', cells: { code: 'HD-2', title: 'B', match_status: 'NO_ACTIVITY', on_time_payment_pct: null, requested_vnd: '0' }, na: { on_time_payment_pct: 'NO_PAYMENT_JUDGED' } },
      ],
      totals: { rows: 3, ledger_rows: 3, cells: { on_time_payment_pct: '50.00', requested_vnd: '900000000' }, na: {}, indicators: [{ code: 'ON_TIME_PAYMENT_RATE', value: '50.00', status: 'OK', reason: null, numerator: '1', denominator: '2' }] },
      breakdown: { dimension: 'match_status', groups: [group('OVER_PAID', { requested_vnd: '900000000' }), group('NO_ACTIVITY', { requested_vnd: '0' })] },
      payment_clock: { acceptance_to_request_days: 14, request_to_treasury_days: 7 },
      rules: [rule('CONTRACT_THREE_WAY_MATCH'), rule('CONTRACT_PAYMENT_CLOCK', { params: { acceptance_to_request_days: 14, request_to_treasury_days: 7 } })],
      ...over,
    });

  it('writes the status of a contract in words, the share of requests on time with its "i", and why a contract has none', async () => {
    open('payment-three-way', { report: () => payments() });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    const table = within(screen.getByTestId('report-table'));
    expect(table.getByText(message('ca1.group.overPaid'))).toBeTruthy();
    expect(table.getByText(message('ca1.group.noActivity'))).toBeTruthy();
    expect(table.getByText(message('ca1.na.noPaymentJudged'))).toBeTruthy();
    const kpis = within(screen.getByRole('group', { name: message('ca1.kpi.label') }));
    expect(kpis.getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.onTimePaymentRate.name') }) })).toBeTruthy();
    expect(screen.getByTestId('clock-note')).toBeTruthy();
  });

  it('names the rules the report was judged by, their version and source, and flags a starting value nobody confirmed', async () => {
    open('payment-three-way', { report: () => payments({ rules: [rule('CONTRACT_THREE_WAY_MATCH', { version: 3, source: 'RULE', unverified: false }), rule('CONTRACT_PAYMENT_CLOCK')] }) });
    await waitFor(() => expect(screen.getByTestId('rules-used')).toBeTruthy());
    const list = within(screen.getByTestId('rules-used'));
    const match = list.getByText(message('ca2.rule.contractThreeWayMatch')).closest('li') as HTMLElement;
    expect(match.textContent).toContain(message('ca2.rules.line', { version: 3, source: message('ca2.rules.source.rule') }));
    expect(within(match).queryByText(message('ca1.info.unverified'))).toBeNull();
    const clock = list.getByText(message('ca2.rule.contractPaymentClock')).closest('li') as HTMLElement;
    expect(within(clock).getByText(message('ca1.info.unverified'))).toBeTruthy();
  });

  it('shows no figure of the clock for a reader without the ledger, as a lock with its reason', async () => {
    const hidden = payments();
    (hidden.items as Array<{ cells: Record<string, unknown>; na: Record<string, string> }>)[0] = { ...(hidden.items[0] as object), cells: { code: 'HD-1', title: 'A', match_status: null, on_time_payment_pct: null, requested_vnd: null }, na: { match_status: 'LEDGER_DENIED', on_time_payment_pct: 'LEDGER_DENIED', requested_vnd: 'LEDGER_DENIED' } } as never;
    open('payment-three-way', { report: () => hidden });
    await waitFor(() => expect(screen.getAllByTestId('ledger-denied').length).toBeGreaterThan(0));
  });
});

describe('advance ageing and recovery (R5)', () => {
  it('draws every breakdown of the report: the age by what is outstanding, the recovery by what is short', async () => {
    open('advance-ageing', {
      report: () =>
        body('advance-ageing', {
          columns: [...IDENTITY, column('advance_outstanding_vnd', 'MONEY', { ledger: true, total: 'SUM' }), column('advance_recovery_shortfall_vnd', 'MONEY', { ledger: true, total: 'SUM', indicator: 'ADVANCE_RECOVERY_SHORTFALL' }), column('recovery_status', 'TEXT', { ledger: true })],
          items: [{ contract_id: '00000000-0000-4000-8000-001000000001', cells: { code: 'HD-1', title: 'A', advance_outstanding_vnd: '150000000', advance_recovery_shortfall_vnd: '110000000', recovery_status: 'BEHIND' }, na: {} }],
          totals: { rows: 1, ledger_rows: 1, cells: { advance_outstanding_vnd: '150000000', advance_recovery_shortfall_vnd: '110000000' }, na: {}, indicators: [{ code: 'ADVANCE_RECOVERY_SHORTFALL', value: '110000000', status: 'OK', reason: null, numerator: '110000000', denominator: null }] },
          breakdowns: [
            { dimension: 'age_bucket', groups: [group('UP_TO_90', { advance_outstanding_vnd: '150000000' })] },
            { dimension: 'recovery_status', groups: [group('BEHIND', { advance_recovery_shortfall_vnd: '110000000' }), group('RECOVERED', { advance_recovery_shortfall_vnd: '0' })] },
          ],
        }),
    });
    await waitFor(() => expect(screen.getByTestId('breakdown')).toBeTruthy());
    expect(screen.getByText(message('ca1.chart.title', { column: message('ca1.col.advanceOutstandingVnd') }))).toBeTruthy();
    const second = within(screen.getByTestId('breakdown-recovery_status'));
    expect(second.getByText(message('ca1.group.behind'))).toBeTruthy();
    expect(second.getByText(message('ca1.group.recovered'))).toBeTruthy();
    expect(screen.getByText(message('ca1.chart.title', { column: message('ca1.col.advanceRecoveryShortfallVnd') }))).toBeTruthy();
    expect(within(screen.getByTestId('report-table')).getByText(message('ca1.group.behind'))).toBeTruthy();
  });
});

describe('retention and guarantee falling due (R6)', () => {
  const steps = (keys: string[], amounts: string[]) => keys.map((key, index) => ({ key, count: index, amount_vnd: amounts[index] ?? '0' }));

  it('lists what falls due in the order of the days, a step with nothing as a count of zero', async () => {
    open('retention-guarantee', {
      report: () =>
        body('retention-guarantee', {
          ladders: { retention: steps(['DUE_NOW', 'WITHIN_30', 'WITHIN_90', 'LATER', 'NO_DATE'], ['25000000']), guarantee: steps(['LAPSED', 'WITHIN_30', 'WITHIN_90', 'LATER'], ['0', '100000000']) },
        }),
    });
    await waitFor(() => expect(screen.getByTestId('ladder-guarantee')).toBeTruthy());
    const guarantee = within(screen.getByTestId('ladder-guarantee'));
    expect(guarantee.getAllByRole('row').slice(1).map((row) => row.getAttribute('data-step'))).toEqual(['LAPSED', 'WITHIN_30', 'WITHIN_90', 'LATER']);
    expect(guarantee.getByText(message('ca1.group.lapsed'))).toBeTruthy();
    expect(guarantee.getByText('100.000.000')).toBeTruthy();
    expect(within(screen.getByTestId('ladder-retention')).getByText(message('ca1.group.dueNow'))).toBeTruthy();
    expect(within(screen.getByTestId('ladder-retention')).getByText(message('ca1.group.noDate'))).toBeTruthy();
  });

  it('says a frozen period holds no ladder', async () => {
    open('retention-guarantee', { report: () => body('retention-guarantee', { ladders: { status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' } }) });
    await waitFor(() => expect(screen.getByTestId('ladder-unavailable').textContent).toBe(message('ca2.ladder.unavailable', { reason: message('ca1.na.notInSnapshot') })));
    expect(screen.queryByTestId('ladder-guarantee')).toBeNull();
  });
});

describe('growth through changes by tier (R7)', () => {
  const tiers = {
    original_value_vnd: '10000000000',
    total_delta_vnd: '60000000',
    total_count: 4,
    groups: [
      { key: 'TIER_1', count: 1, delta_vnd: '20000000', growth: { code: 'CHANGE_TIER_GROWTH', value: '0.20', status: 'OK', reason: null, numerator: '20000000', denominator: '10000000000' }, share_of_growth_pct: '33.33', max_cumulative_variation_pct: '2.00' },
      { key: 'TIER_2', count: 2, delta_vnd: '40000000', growth: { code: 'CHANGE_TIER_GROWTH', value: '0.40', status: 'OK', reason: null, numerator: '40000000', denominator: '10000000000' }, share_of_growth_pct: '66.67', max_cumulative_variation_pct: '10.00' },
      { key: 'TIER_3', count: 0, delta_vnd: null, growth: { code: 'CHANGE_TIER_GROWTH', value: null, status: 'NOT_APPLICABLE', reason: 'NO_CHANGE', numerator: null, denominator: null }, share_of_growth_pct: null, max_cumulative_variation_pct: null },
    ],
  };
  const growth = () =>
    body('change-growth', {
      columns: [...IDENTITY, column('change_growth_pct', 'PERCENT', { total: 'RATIO', indicator: 'CHANGE_GROWTH' })],
      totals: { rows: 3, ledger_rows: 3, cells: { change_growth_pct: '0.60' }, na: {}, indicators: [] },
      tier_split: tiers,
    });

  it('shows each tier with its growth over the one denominator, a tier nobody changed with its reason and not 0, and the total', async () => {
    open('change-growth', { report: () => growth() });
    await waitFor(() => expect(screen.getByTestId('tier-split')).toBeTruthy());
    const table = within(screen.getByTestId('tier-split'));
    const tier1 = within(table.getByText(message('ca1.group.tier1')).closest('tr') as HTMLElement);
    expect(tier1.getByText('0,20%')).toBeTruthy();
    expect(tier1.getByText('33,33%')).toBeTruthy();
    const tier3 = within(table.getByText(message('ca1.group.tier3')).closest('tr') as HTMLElement);
    expect(tier3.getByText(message('ca1.na.noChange'))).toBeTruthy();
    expect(tier3.queryByText('0,00%')).toBeNull();
    const total = within(document.querySelector('[data-testid="tier-split"] tfoot') as HTMLElement);
    expect(total.getByText('60.000.000')).toBeTruthy();
    expect(total.getByText('0,60%')).toBeTruthy();
    expect(table.getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.changeTierGrowth.name') }) })).toBeTruthy();
  });

  it('says a frozen period holds no split by tier', async () => {
    open('change-growth', { report: () => body('change-growth', { tier_split: { status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' } }) });
    await waitFor(() => expect(screen.getByTestId('tier-unavailable').textContent).toBe(message('ca2.tier.unavailable', { reason: message('ca1.na.notInSnapshot') })));
  });
});

describe('a selection too large for the earned value', () => {
  it('tells the reader to narrow the filter, and does not show a part of the answer', async () => {
    open('schedule-delay', { report: () => new ApiError({ status: 422, code: 'REPORT_SELECTION_TOO_LARGE', correlationId: 'c', extensions: { cap: 5000, linked: 7000 } }) });
    await waitFor(() => expect(screen.getByTestId('selection-too-large').textContent).toBe(message('ca2.error.tooLarge')));
    expect(screen.queryByTestId('report-table')).toBeNull();
  });
});
