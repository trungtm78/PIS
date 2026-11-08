import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as word, translator } from '../../i18n';
import DashboardScreen from './DashboardScreen';
import { AUDITOR, READER, alert, feed, harness, mount, never, problem, routeOf, uuid, workspace, world } from './test/support';

const route = routeOf('BAN-01', 'FR-BAN-01');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function open(overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = READER, path = '/') {
  const h = harness(world(overrides));
  mount(<DashboardScreen route={route} />, h, { permissions, path });
  return h;
}

const calls = (h: ReturnType<typeof harness>, operation: string) => h.read.mock.calls.filter(([name]) => name === operation);

describe('BAN-01, the workspace of the head of the committee', () => {
  it('UI-BAN-01: shows the figures with their "i", the province against plan, last year and the curve, and the band of the year', async () => {
    open();
    const rate = await screen.findByTestId('figure-COMMITTEE_DISBURSEMENT_RATE');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('ban.dash.page.title'));
    expect(screen.getByTestId('figures').querySelectorAll('[data-metric]')).toHaveLength(8);
    expect(rate.textContent).toContain(word('ban.fig.disbursementRate.label'));
    expect(rate.textContent).toContain('60,00');
    // The "i" opens the formula, the source, the day, the owner, the version and that the definition is unverified.
    fireEvent.click(within(rate).getByRole('button', { name: word('govc.home.info.open', { name: 'Chỉ tiêu COMMITTEE_DISBURSEMENT_RATE' }) }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Công thức của COMMITTEE_DISBURSEMENT_RATE');
    expect(panel.textContent).toContain('Lõi dữ liệu đầu tư công');
    expect(panel.textContent).toContain('08/11/2026');
    expect(panel.textContent).toContain('COMMITTEE_SECRETARIAT');
    expect(panel.textContent).toContain(word('govc.home.info.unverified'));
    expect(panel.querySelector('[data-field="version"]')?.textContent).toContain(word('govc.home.info.version.default', { version: 0 }));
    const province = screen.getByTestId('province');
    expect(within(province).getByTestId('province-plan').textContent).toBe('1.000.000.000.000');
    expect(within(province).getByTestId('province-disbursed').textContent).toBe('600.000.000.000');
    expect(within(province).getByTestId('province-rate').textContent).toBe('60,00%');
    expect(within(province).getByTestId('province-expected').textContent).toBe('64,00%');
    expect(within(province).getByTestId('province-gap').textContent).toBe(word('ban.dash.fact.gapPoints', { points: '-4,00' }));
    expect(within(province).getByTestId('province-outlook').textContent).toContain(word('ban.outlook.range.text', { low: '800.000.000.000', high: '950.000.000.000' }));
  });

  it('says that last year is known for only some lines, and that an unknown amount is no data and never 0', async () => {
    open();
    const province = await screen.findByTestId('province');
    expect(within(province).getByTestId('province-last-year').textContent).toBe(word('ban.lastYear.partial.text', { known: 6, total: 10 }));
    expect(within(province).getByTestId('province-change').textContent).toBe(word('ban.common.noData.text'));
    const lastYear = screen.getByTestId('figure-COMMITTEE_DISBURSED_LAST_YEAR');
    expect(lastYear.textContent).toContain(word('home.tile.nullReason.noData'));
    expect(lastYear.textContent).not.toMatch(/\b0\b/);
    const agriculture = within(screen.getByTestId('cut-panel')).getByText('Nông nghiệp').closest('tr') as HTMLElement;
    expect(within(agriculture).getAllByText(word('ban.common.noData.text')).length).toBeGreaterThanOrEqual(2);
  });

  it('shows the colour as a word and a shape, never as a colour alone', async () => {
    open();
    const province = await screen.findByTestId('province');
    const status = province.closest('section')?.querySelector('[data-rag]') as HTMLElement;
    expect(status.getAttribute('data-rag')).toBe('AMBER');
    expect(status.textContent).toContain(word('ban.rag.amber.label'));
    expect(status.textContent).toContain('◆');
    const sector = within(screen.getByTestId('cut-panel')).getByText('Giao thông').closest('tr') as HTMLElement;
    expect(sector.querySelector('[data-rag="RED"]')?.textContent).toContain(word('ban.rag.red.label'));
    expect(sector.querySelector('[data-rag="RED"]')?.textContent).toContain('▲');
  });

  it('cuts the province by sector, district, investor and funding source in tabs that follow the arrow keys', async () => {
    open();
    await screen.findByTestId('cut-panel');
    expect(screen.getByTestId('cut-panel').getAttribute('data-dimension')).toBe('sector');
    fireEvent.click(screen.getByRole('tab', { name: word('ban.dash.tab.district') }));
    await waitFor(() => expect(screen.getByTestId('cut-panel').getAttribute('data-dimension')).toBe('district'));
    expect(within(screen.getByTestId('cut-panel')).getByText('Thành phố Cao Bằng')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { name: word('ban.dash.tab.district') }), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('cut-panel').getAttribute('data-dimension')).toBe('investor'));
    fireEvent.click(screen.getByRole('tab', { name: word('ban.dash.tab.fundSource') }));
    await waitFor(() => expect(within(screen.getByTestId('cut-panel')).getByText('Ngân sách trung ương')).toBeTruthy());
  });

  it('keeps the four filters in the address, asks the server with them, and clears them', async () => {
    const h = open({}, READER, '/?sector_code=GT&fund_source_code=NSTW&view=fundSource');
    await screen.findByTestId('figures');
    expect(h.read).toHaveBeenCalledWith('getCommitteeWorkspace', { query: { sector_code: 'GT', fund_source_code: 'NSTW' } });
    expect(screen.getByTestId('cut-panel').getAttribute('data-dimension')).toBe('fundSource');
    fireEvent.click(screen.getByTestId('filters-clear'));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('getCommitteeWorkspace', { query: {} }));
  });

  it('narrows by a sector chosen in the filter', async () => {
    const h = open();
    await screen.findByTestId('figures');
    expect(calls(h, 'getCommitteeWorkspace')).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: word('ban.dash.filter.sector') }), { target: { value: 'GT' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('getCommitteeWorkspace', { query: { sector_code: 'GT' } }));
    expect(calls(h, 'getCommitteeWorkspace')).toHaveLength(2);
  });

  it('says what changed since last week, the top attention with the way to BAN-02, the units not reporting, the live alerts and the directives', async () => {
    open();
    const changes = await screen.findByTestId('changes');
    expect(changes.textContent).toContain(word('govc.home.changes.rate.up', { from: '55.00', to: '60.00', delta: '5.00' }));
    expect(screen.getByTestId('go-attention').getAttribute('href')).toBe('/ban/ban-02');
    expect(screen.getByText('DA-1')).toBeTruthy();
    expect(screen.getByText('Ban quản lý dự án 3').closest('tr')?.textContent).toContain(word('ban.unit.reason.never'));
    expect(screen.queryByText('Ban quản lý dự án 2')).toBeNull();
    const live = screen.getByTestId('alerts-live');
    expect(live.textContent).toContain('Sở Tài chính');
    expect(live.textContent).toContain('Họp với các chủ đầu tư chậm');
    expect(live.textContent).toContain('Năm đóng với vốn chưa giải ngân');
    expect(screen.getByTestId('go-alerts').getAttribute('href')).toBe('/ban/ban-05');
    const directives = screen.getByTestId('directive-summary');
    expect(directives.textContent).toContain('4');
    expect(screen.getByTestId('go-tracker').getAttribute('href')).toBe('/ban/ban-04');
    expect(screen.getByTestId('directive-worst').textContent).toContain('Ban quản lý dự án 1');
  });

  it('says that the thresholds are starting values nobody verified, with their formula behind an i', async () => {
    open();
    const notice = await screen.findByTestId('policy-notice');
    expect(notice.getAttribute('data-unverified')).toBe('true');
    expect(notice.textContent).toContain(word('ban.policy.unverified.text', { code: 'DEFAULT' }));
    fireEvent.click(within(notice).getByRole('button', { name: word('ban.policy.info.open') }));
    const panel = await screen.findByRole('dialog', { name: word('ban.policy.info.name', { code: 'DEFAULT' }) });
    expect(panel.textContent).toContain('Đường kỳ vọng nội suy theo tháng');
    expect(panel.textContent).toContain('Quy tắc COMMITTEE_POLICY');
  });

  it('writes sentences of the week only for lines it can say, and says when there is no week before or nothing changed', async () => {
    open({ getCommitteeWorkspace: workspace({ changes: { lines: [{ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '1' }, link: 'DRILL', metric_code: null }], previous_as_of: '2026-11-01', reason: null } }) });
    expect(await screen.findByTestId('changes-none')).toBeTruthy();
    cleanup();
    open({ getCommitteeWorkspace: workspace({ changes: { lines: [], previous_as_of: null, reason: 'NO_PREVIOUS_WEEK' } }) });
    expect(await screen.findByTestId('changes-no-previous')).toBeTruthy();
  });

  it('gives each empty part its own reason: no data at all, nobody late, no alert, no directive', async () => {
    open({
      getCommitteeWorkspace: workspace({
        feed: feed({ empty: true, projects: 0, lines: 0 }),
        attention: [],
        attention_total: 0,
        units: [],
        alerts: [],
        by_sector: [],
        directives: { ...workspace().directives, units: [], directives: [], totals: { open: 0, overdue: 0, escalated: 0 } },
      }),
    });
    expect(await screen.findByTestId('feed-empty')).toBeTruthy();
    expect(screen.getByTestId('attention-empty').textContent).toBe(word('ban.dash.attention.noData.text'));
    expect(screen.getByTestId('units-empty').textContent).toBe(word('ban.dash.units.noUnits.text'));
    expect(screen.getByTestId('alerts-empty').textContent).toBe(word('ban.dash.alerts.none.text'));
    expect(screen.getByTestId('directives-empty').textContent).toBe(word('ban.dash.directives.none.text'));
    expect(screen.getByTestId('cut-empty').textContent).toBe(word('ban.dash.cuts.empty.text'));
  });

  it('tells a filter that found nothing from a province that has no data', async () => {
    open({ getCommitteeWorkspace: workspace({ by_sector: [], attention: [], attention_total: 0 }) }, READER, '/?sector_code=XX');
    expect((await screen.findByTestId('cut-empty')).textContent).toBe(word('ban.dash.cuts.emptyFiltered.text'));
    expect(screen.getByTestId('attention-empty').textContent).toBe(word('ban.dash.attention.none.text'));
  });

  it('shows the seven states: loading, service error with retry, permission denied by the server and by a missing right', async () => {
    const loading = open({ getCommitteeWorkspace: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    expect(loading.read).toHaveBeenCalled();
    cleanup();
    let failing = true;
    const h = harness((operation) => (failing ? problem('INTERNAL_ERROR', 500) : world()(operation)));
    mount(<DashboardScreen route={route} />, h, { permissions: READER });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('figures')).toBeTruthy();
    cleanup();
    open({ getCommitteeWorkspace: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const without = open({}, AUDITOR);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(without.read).not.toHaveBeenCalled();
  });

  it('is written to the audit of views once per view: no refetch on focus, no polling, and the audit itself is never read here', async () => {
    const h = open();
    await screen.findByTestId('figures');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls(h, 'getCommitteeWorkspace')).toHaveLength(1);
    expect(calls(h, 'listCommitteeViewAudit')).toHaveLength(0);
    expect(h.read.mock.calls.map(([name]) => name)).toEqual(['getCommitteeWorkspace']);
  });

  it('writes the money in the locale and keeps every digit of an amount no float can hold', async () => {
    const big = workspace({ province: { ...workspace().province, plan_vnd: '9223372036854775809' } });
    open({ getCommitteeWorkspace: big });
    expect((await screen.findByTestId('province-plan')).textContent).toBe('9.223.372.036.854.775.809');
    cleanup();
    translator.setLocale('en');
    open({ getCommitteeWorkspace: big });
    expect((await screen.findByTestId('province-plan')).textContent).toBe('9,223,372,036,854,775,809');
  });

  it('shows the live alerts of the workspace as cards with their ids', async () => {
    open({ getCommitteeWorkspace: workspace({ alerts: [alert(7, { id: uuid(307) })] }) });
    expect(await screen.findByTestId(`alert-${uuid(307)}`)).toBeTruthy();
  });
});
