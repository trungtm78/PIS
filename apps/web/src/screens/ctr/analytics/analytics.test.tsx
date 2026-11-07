import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { message } from '../test-catalogue';
import BidVarianceScreen from './BidVarianceScreen';
import ConcentrationScreen from './ConcentrationScreen';
import HubScreen from './HubScreen';
import PortfolioScreen from './PortfolioScreen';
import { CONTRACT_A, CONTRACT_B, analyticsClient, concentrationBody, context, mount, portfolioBody, routeOf, snapshot } from './test-support';
import { REPORT_CODES } from './model';

const ANALYST = ['contract.read', 'contract.analytics.read', 'ledger.read'];
const refusal = () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} });
const reports = (h: ReturnType<typeof analyticsClient>): Array<{ code: string; query: Record<string, string> }> =>
  h.read.mock.calls.filter(([operation]) => operation === 'getContractReport').map(([, input]) => ({ code: (input as { path: { code: string } }).path.code, query: (input as { query: Record<string, string> }).query }));

afterEach(cleanup);

describe('the portfolio and status (CTR-29)', () => {
  const route = routeOf('CTR-29', 'FR-CTR-29');

  it('shows the context of its numbers, the indicators with their "i", the groups as bars, the table with the server totals and the formulas', async () => {
    mount(<PortfolioScreen route={route} />, analyticsClient({}), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(message('ca1.report.portfolioStatus.title'));
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    for (const text of [message('ca1.ctx.scope'), message('ca1.ctx.period'), message('ca1.ctx.cutoff'), message('ca1.ctx.freshness'), message('ca1.ctx.cutoff.none'), message('ca1.ctx.fresh.live')]) expect(bar.textContent).toContain(text);
    expect(bar.textContent).toContain(message('ui.unitChip.label', { unit: message('w2pay.ctx.unit') }));
    // the indicators of everything that matches, each with its "i"
    const kpis = screen.getByRole('group', { name: message('ca1.kpi.label') });
    expect(within(kpis).getByText('1,43%'.replace('.', ','))).toBeTruthy();
    expect(within(kpis).getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.changeGrowth.name') }) })).toBeTruthy();
    // the table: the total is the server's, not the sum of the two rows
    const totals = within(document.querySelector('tfoot') as HTMLElement);
    expect(totals.getByText('77.777.777.777')).toBeTruthy();
    expect(totals.getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.paidToAccepted.name') }) })).toBeTruthy();
    expect(screen.getByText(message('ca1.chart.title', { column: message('ca1.col.contractValueVnd') }))).toBeTruthy();
    expect(within(screen.getByTestId('breakdown')).getByText(vi_['ctr.status.draft.label'])).toBeTruthy();
    expect(within(screen.getByTestId('definitions')).getByText(message('ca1.indicator.changeGrowth.formula'))).toBeTruthy();
    // a trend is the series of BI over DS-CTR, not an endpoint of this screen
    expect(screen.getByTestId('trend-note').textContent).toContain('DS-CTR');
    expect(screen.getByRole('link', { name: message('ca1.trend.link') }).getAttribute('href')).toBe('/bi/bi-09');
  });

  it('opens the formula of a figure in the Vietnamese words of the screen, with its source', async () => {
    mount(<PortfolioScreen route={route} />, analyticsClient({}), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    const kpis = screen.getByRole('group', { name: message('ca1.kpi.label') });
    fireEvent.click(within(kpis).getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.paidToAccepted.name') }) }));
    const panel = screen.getByRole('dialog', { name: message('ca1.indicator.paidToAccepted.name') });
    expect(panel.textContent).toContain(message('ca1.indicator.paidToAccepted.formula'));
    expect(panel.textContent).toContain(message('ca1.indicator.paidToAccepted.numerator'));
    expect(panel.textContent).toContain('contract');
  });

  it('shows a ledger the reader may not see as a lock with its reason and never as zero, and says the totals cover some contracts only', async () => {
    const hidden = portfolioBody().items.map((item, position) =>
      position === 0 ? { ...item, cells: { ...item.cells, accepted_vnd: null, paid_vnd: null, paid_to_accepted_pct: null }, na: { accepted_vnd: 'LEDGER_DENIED', paid_vnd: 'LEDGER_DENIED', paid_to_accepted_pct: 'LEDGER_DENIED' } } : item,
    );
    mount(<PortfolioScreen route={route} />, analyticsClient({ portfolio: () => portfolioBody({ items: hidden, context: context({ ledger_rows: 1 }) }) }), { permissions: ['contract.read'] });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(screen.getAllByTestId('ledger-denied')).toHaveLength(3);
    expect(screen.getAllByTestId('ledger-denied')[0]?.textContent).toContain(message('ca1.na.ledgerDenied'));
    expect(screen.getByTestId('partial-notice').textContent).toBe(message('ca1.partial.notice', { ledger: 1, rows: 2 }));
  });

  it('shows an indicator the server could not give with its reason, not as zero', async () => {
    const empty = portfolioBody({
      totals: { ...portfolioBody().totals, indicators: [{ code: 'PAID_TO_ACCEPTED', value: null, status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR', numerator: '0', denominator: '0' }] },
    });
    mount(<PortfolioScreen route={route} />, analyticsClient({ portfolio: () => empty }), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('kpi-reason').textContent).toBe(message('ca1.na.zeroDenominator')));
  });

  it('exports Excel, CSV and PDF through the server and says when the snapshot is stale', async () => {
    const created = vi.fn(() => 'blob:x');
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const h = analyticsClient({
      exportFile: (_code, query) => ({ report: 'portfolio-status', format: query?.format, file_name: `portfolio-status.${query?.format}`, media_type: 'text/csv', size_bytes: 2, file_sha256: 'x', row_count: 2, stale: query?.format === 'csv', content_base64: 'aGk=' }),
    });
    mount(<PortfolioScreen route={route} />, h, { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: message('ca1.export.xlsx') }));
    await waitFor(() => expect(screen.getByTestId('export-done').textContent).toContain(message('ca1.export.done', { name: 'portfolio-status.xlsx', rows: 2 })));
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: message('ca1.export.csv') }));
    await waitFor(() => expect(screen.getByTestId('export-done').textContent).toContain(message('ca1.export.stale')));
    const sent = h.read.mock.calls.filter(([operation]) => operation === 'exportContractReport').map(([, input]) => (input as { query: Record<string, string> }).query.format);
    expect(sent).toEqual(['xlsx', 'csv']);
    vi.unstubAllGlobals();
    clicked.mockRestore();
  });

  it('says the file is too large when the server refuses it for its size, and that it failed otherwise', async () => {
    const h = analyticsClient({ exportFile: () => new ApiError({ status: 422, code: 'EXPORT_ROW_CAP_EXCEEDED', correlationId: 'c', extensions: {} }) });
    mount(<PortfolioScreen route={route} />, h, { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: message('ca1.export.pdf') }));
    await waitFor(() => expect(screen.getByTestId('export-error').textContent).toBe(message('ca1.export.tooLarge')));
  });

  it('reads nothing and shows the denied state to a member without the right to read contracts', async () => {
    const h = analyticsClient({});
    mount(<PortfolioScreen route={route} />, h, { permissions: ['project.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalledWith('getContractPortfolio', expect.anything());
  });
});

describe('the bid variance (CTR-30) and the other reports of the catalogue', () => {
  it('reads the report bid-variance with the analytics right and shows its title and columns', async () => {
    const h = analyticsClient({ report: () => portfolioBody({ code: 'bid-variance', ref: 'R1' }) });
    mount(<BidVarianceScreen route={routeOf('CTR-30', 'FR-CTR-30')} />, h, { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(message('ca1.report.bidVariance.title'));
    expect(reports(h)[0]).toMatchObject({ code: 'bid-variance', query: { sort: 'code', dir: 'asc', limit: '20' } });
    expect(screen.getByRole('columnheader', { name: message('ca1.col.contractValueVnd') })).toBeTruthy();
  });

  it('refuses a member who holds contract.read but not the analytics right', async () => {
    const h = analyticsClient({});
    mount(<BidVarianceScreen route={routeOf('CTR-30', 'FR-CTR-30')} />, h, { permissions: ['contract.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(reports(h)).toHaveLength(0);
  });

  it.each(['schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth'])('opens the report %s in the hub by its name, through the one generic screen', async (code) => {
    const h = analyticsClient({ report: (name) => portfolioBody({ code: name, ref: 'R', evm: { status: 'UNAVAILABLE', reason: 'NOT_WIRED' }, payment_clock: { acceptance_to_request_days: 14, request_to_treasury_days: 7 } }) });
    mount(<HubScreen route={routeOf('CTR-28', 'FR-CTR-28')} />, h, { permissions: ANALYST, path: `/ctr/ctr-28?report=${code}` });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(reports(h)[0]?.code).toBe(code);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(message(`ca1.report.${code.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())}.title`));
    if (code === 'schedule-delay') expect(screen.getByTestId('evm-slot').textContent).toBe(message('ca1.evm.unavailable'));
    if (code === 'payment-three-way') expect(screen.getByTestId('clock-note').textContent).toBe(message('ca1.clock.note', { acceptance: 14, treasury: 7 }));
  });

  it('says whether an empty answer is the filter or the portfolio, and offers to clear the filter', async () => {
    const none = (code: string) => portfolioBody({ code, items: [], totals: { ...portfolioBody().totals, rows: 0, cells: {} }, breakdown: null });
    const h = analyticsClient({ report: (code, query) => (query?.q === undefined ? portfolioBody({ code }) : none(code)) });
    mount(<BidVarianceScreen route={routeOf('CTR-30', 'FR-CTR-30')} />, h, { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.query.label']), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByTestId('no-match')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
  });

  it('shows the loading skeleton, the error with a retry that reads again, and flags a stale snapshot with the way to the newest', async () => {
    mount(<BidVarianceScreen route={routeOf('CTR-30', 'FR-CTR-30')} />, analyticsClient({ report: () => new Promise(() => undefined) }), { permissions: ANALYST });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] }).getAttribute('aria-busy')).toBe('true');
    cleanup();
    let calls = 0;
    mount(
      <BidVarianceScreen route={routeOf('CTR-30', 'FR-CTR-30')} />,
      analyticsClient({
        report: (code) => {
          calls += 1;
          if (calls === 1) return new Error('boom');
          return portfolioBody({ code, context: context({ freshness: { kind: 'SNAPSHOT', stale: true, snapshot: snapshot({ revision: 1, latest_revision: 3, stale: true }), latest_snapshot: snapshot({ revision: 3, latest_revision: 3 }) } }) });
        },
      }),
      { permissions: ANALYST },
    );
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(screen.getByTestId('stale-notice').textContent).toContain(message('ca1.stale.notice', { period: '2026-09', revision: 1, latest: 3 })));
    expect(screen.getByRole('group', { name: vi_['ui.contextBar.label'] }).textContent).toContain(message('ca1.ctx.period.snapshot', { period: '2026-09', revision: 1 }));
  });
});

describe('the hub of the reports (CTR-28)', () => {
  const route = routeOf('CTR-28', 'FR-CTR-28');

  it('lists every report of the catalogue with a link to it, and the frozen periods with the revision of each', async () => {
    const h = analyticsClient({
      snapshots: () => ({
        items: [snapshot({ revision: 2, latest_revision: 2 }), snapshot({ id: '00000000-0000-4000-8000-0000000000a2', revision: 1, latest_revision: 2, stale: true })],
        as_of: '2026-11-08T00:00:00.000Z',
      }),
    });
    mount(<HubScreen route={route} />, h, { permissions: ANALYST });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(message('ca1.hub.title'));
    const cards = within(screen.getByTestId('report-list')).getAllByRole('listitem');
    expect(cards).toHaveLength(REPORT_CODES.length);
    const link = (code: string) => within(screen.getByTestId('report-list').querySelector(`[data-report="${code}"]`) as HTMLElement).getByRole('link').getAttribute('href');
    expect(link('portfolio-status')).toBe('/ctr/ctr-29');
    expect(link('bid-variance')).toBe('/ctr/ctr-30');
    expect(link('contractor-concentration')).toBe('/ctr/ctr-31');
    expect(link('schedule-delay')).toBe('/ctr/ctr-28?report=schedule-delay');
    await waitFor(() => expect(screen.getByTestId('periods')).toBeTruthy());
    const periods = within(screen.getByTestId('periods')).getAllByRole('listitem');
    expect(periods[0]?.textContent).toContain(message('ca1.hub.periods.latest'));
    expect(periods[1]?.textContent).toContain(message('ca1.hub.periods.stale', { latest: 2 }));
    expect(periods[0]?.textContent).toContain('30/09/2026');
  });

  it('says there are no frozen periods, and that the list could not be read, without hiding the reports', async () => {
    mount(<HubScreen route={route} />, analyticsClient({}), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('periods-empty').textContent).toBe(message('ca1.hub.periods.empty')));
    cleanup();
    mount(<HubScreen route={route} />, analyticsClient({ snapshots: () => new Error('boom') }), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('periods-error')).toBeTruthy());
    expect(screen.getByTestId('report-list')).toBeTruthy();
  });

  it('is denied to a member without the analytics right', () => {
    mount(<HubScreen route={route} />, analyticsClient({}), { permissions: ['contract.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
  });
});

describe('the concentration and load of the contractors (CTR-31)', () => {
  const route = routeOf('CTR-31', 'FR-CTR-31');
  const answer = (over: Record<string, unknown> = {}) => analyticsClient({ report: () => concentrationBody(over) });

  it('shows the level, the top share and the HHI with their "i", the groups, the rule behind the thresholds and the load of each contractor', async () => {
    mount(<ConcentrationScreen route={route} />, answer(), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('dimension-contractor')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(message('ca1.report.contractorConcentration.title'));
    const contractor = screen.getByTestId('dimension-contractor');
    expect(contractor.getAttribute('data-level')).toBe('RED');
    expect(within(contractor).getByText(message('ca1.level.red'))).toBeTruthy();
    expect(within(contractor).getByText('88,89%')).toBeTruthy();
    expect(within(contractor).getByText('4321,00')).toBeTruthy();
    expect(within(contractor).getByRole('button', { name: message('ca1.info.open', { name: message('ca1.indicator.hhi.name') }) })).toBeTruthy();
    expect(within(contractor).getByText('Công ty An Phát')).toBeTruthy();
    expect(within(contractor).getByText(message('ca1.concentration.anomalies', { count: 1 }))).toBeTruthy();
    expect(screen.getByTestId('rule-note').textContent).toBe(message('ca1.rule.note', { version: 0, source: message('ca1.rule.source.default'), amber: '50', red: '70', hhiAmber: '1000', hhiRed: '1800', min: '10' }));
    expect(screen.getByText('33,33%')).toBeTruthy();
    const load = within(screen.getByTestId('load-table'));
    expect(load.getByText('6.000.000.000')).toBeTruthy();
    // a contractor that has only an award has load that is coming, not an active value of zero hidden
    expect(load.getByText('400.000.000')).toBeTruthy();
    expect(screen.getByTestId('trend-note').textContent).toContain('DS-CTR');
  });

  it('says that a dimension is not judged when there are too few contracts, and gives the reason of a figure it could not make', async () => {
    mount(<ConcentrationScreen route={route} />, answer(), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('dimension-unit')).toBeTruthy());
    const unit = screen.getByTestId('dimension-unit');
    expect(unit.getAttribute('data-level')).toBe('NOT_ENOUGH_DATA');
    expect(within(unit).getByText(message('ca1.level.notEnoughData'))).toBeTruthy();
    expect(within(unit).getByText(message('ca1.concentration.minimum', { min: '10' }))).toBeTruthy();
    expect(within(unit).getAllByText(message('ca1.na.noActiveContract'))).toHaveLength(2);
  });

  it('sends the filters to the server, exports through it, and reads the newest revision of a stale period', async () => {
    const stale = context({ rows: null, ledger_rows: null, freshness: { kind: 'SNAPSHOT', stale: true, snapshot: snapshot({ revision: 1, latest_revision: 2, stale: true }), latest_snapshot: snapshot({ revision: 2, latest_revision: 2 }) } });
    const h = analyticsClient({ report: () => concentrationBody({ context: stale }), exportFile: () => ({ report: 'contractor-concentration', format: 'pdf', file_name: 'c.pdf', media_type: 'application/pdf', size_bytes: 2, file_sha256: 'x', row_count: 9, stale: true, content_base64: 'aGk=' }) });
    mount(<ConcentrationScreen route={route} />, h, { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('stale-notice')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(vi_['ctr.list.status.label']), { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(reports(h).some((call) => call.query.status === 'ACTIVE')).toBe(true));
    expect(reports(h).every((call) => call.query.limit === undefined)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: message('ca1.stale.useLatest') }));
    await waitFor(() => expect(reports(h).some((call) => call.query.period === '2026-09')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: message('ca1.export.pdf') }));
    await waitFor(() => expect(screen.getByTestId('export-done').textContent).toContain(message('ca1.export.stale')));
  });

  it('shows the empty states, the denied state and the error with a retry', async () => {
    const none = { active_contracts: 0, active_value_vnd: '0', dimensions: [], contractors: [] };
    mount(<ConcentrationScreen route={route} />, answer(none), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('no-contracts').textContent).toContain(message('ca1.empty.none')));
    cleanup();
    mount(<ConcentrationScreen route={route} />, analyticsClient({ report: () => refusal() }), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    let calls = 0;
    mount(<ConcentrationScreen route={route} />, analyticsClient({ report: () => (calls++ === 0 ? new Error('boom') : concentrationBody()) }), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(screen.getByTestId('dimension-contractor')).toBeTruthy());
  });

  it('treats a body that is not the report as a failed read, not as no concentration', async () => {
    mount(<ConcentrationScreen route={route} />, analyticsClient({ report: () => ({ dimensions: [] }) }), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  it('is denied to a member without the analytics right, and reads nothing', () => {
    const h = answer();
    mount(<ConcentrationScreen route={route} />, h, { permissions: ['contract.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(reports(h)).toHaveLength(0);
  });
});

describe('the other contract of the screens', () => {
  beforeEach(() => undefined);
  it('uses the contract ids the rows carry for the link to the contract workspace', async () => {
    mount(<PortfolioScreen route={routeOf('CTR-29', 'FR-CTR-29')} />, analyticsClient({}), { permissions: ANALYST });
    await waitFor(() => expect(screen.getByTestId('report-table')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'HD-A-001' }).getAttribute('href')).toBe(`/ctr/ctr-03?id=${CONTRACT_A}`);
    expect(screen.getByRole('link', { name: 'HD-A-002' }).getAttribute('href')).toBe(`/ctr/ctr-03?id=${CONTRACT_B}`);
  });
});
