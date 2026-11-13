import { ApiError } from '@machvon/api-client';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import OverviewScreen from './OverviewScreen';

const OV = routeOf('HOME-01', 'FR-HOME-01');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

/** The text the server writes for a figure (the register's decimals: a percent with two places, money whole). */
const shownOf = (unit: unknown, value: unknown): string | null => (typeof value !== 'string' ? null : unit === 'PERCENT' ? Number(value).toFixed(2) : value);

const tile = (code: string, overrides: Record<string, unknown> = {}) => {
  const base = {
  metric_code: code,
  value: '21.4710',
  numerator: '214710000000',
  denominator: '1000000000000',
  null_reason: null,
  unit: 'PERCENT',
  formula: 'disbursed_treasury_vnd / plan_pm_assigned_vnd * 100',
  definition_status: 'SIGNED',
  context_token: `token-${code}.sig`,
  ...overrides,
  };
  return { ...base, display_value: 'display_value' in overrides ? overrides.display_value : shownOf(base.unit, base.value) };
};

const center = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: S40,
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2026-09-30',
  treasury_cutoff_date: '2026-09-30',
  freshness: 'FRESH',
  definition_status: 'SIGNED',
  legal_confirmation_refs: [],
  scope: { unit_id: null, denominator_kind: null, projects: 10, scope_hash: 'h' },
  tiles: [
    tile('DISBURSEMENT_RATE_PM'),
    tile('DISBURSEMENT_RATE_TOTAL', { value: '17.1768', denominator: '1250000000000' }),
    tile('DISBURSED_TREASURY', { unit: 'VND', value: '214710000000', numerator: null, denominator: null }),
    tile('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', numerator: null, denominator: null }),
    tile('PLAN_TOTAL', { unit: 'VND', value: '1250000000000', numerator: null, denominator: null }),
  ],
  projects_without_data: 2,
  open_warnings: 4,
  overdue_explanations: 1,
  pending_reallocations: 3,
  quality_badge: 'NOT_ASSESSED',
  ...overrides,
});

const alertItem = (id: string, severity: string, title: string) => ({
  id,
  kind: 'PERMIT',
  source: 'PERMIT',
  severity,
  title,
  subtitle: null,
  status: 'OPEN',
  due_on: '2999-12-31',
  original_due_on: '2999-12-31',
  bucket: 'LATER',
  overdue: false,
  days_late: 0,
  target: { screen: 'PRJ-19', id },
  lifecycle: 'NEW',
  claimed_by: null,
  assignee: null,
  escalation: null,
  consequence: null,
  snoozed_until: null,
});

const BAND_ITEMS = [alertItem('a1', 'URGENT', 'Giấy phép XD DA-DT205 hết hạn'), alertItem('a2', 'ACTION', 'Báo cáo tuần 40 quá hạn')];
const alertCounts = (items: Array<{ severity: string }>) => ({ urgent: items.filter((entry) => entry.severity === 'URGENT').length, action: items.filter((entry) => entry.severity === 'ACTION').length, watch: 0, total: items.length });

const warning = (id: string, ruleCode: string, ruleName: string, projectId: string, projectName: string, plan: string, paid: string | null) => ({
  id,
  rule: { code: ruleCode, name: ruleName, metric_code: 'DISBURSEMENT_RATE_PM' },
  severity: 'WARNING',
  status: 'OPEN',
  project: { id: projectId, code: projectId.toUpperCase(), name: projectName },
  observed: {},
  snapshot_id: S40,
  opened_at: '2026-09-30T00:00:00Z',
  evidence: { snapshot_id: S40, as_of_date: '2026-09-30', cells: [{ bucket: 'Y', budget_level: 'CENTRAL', plan_pm_assigned_vnd: plan, plan_local_added_vnd: '0', disbursed_treasury_vnd: paid, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: null, treasury_coverage: 'COMPLETE' }] },
});

const WARNINGS = {
  items: [
    warning('w1', 'EW-GPMB', 'Chậm giải phóng mặt bằng', 'p1', 'Đường tỉnh 205', '500000000000', '100000000000'),
    warning('w2', 'EW-GPMB', 'Chậm giải phóng mặt bằng', 'p2', 'Cầu Bằng Giang', '200000000000', '50000000000'),
    warning('w3', 'EW-PAY', 'Chậm thanh toán', 'p3', 'Trường THPT', '100000000000', '90000000000'),
  ],
  next_cursor: null,
};

const FORECAST = {
  snapshot_id: S40,
  plan_year: 2026,
  cutoff_month: 9,
  curve: [
    { month: 8, actual_cumulative_vnd: '150000000000', forecast_cumulative_vnd: null },
    { month: 9, actual_cumulative_vnd: '214710000000', forecast_cumulative_vnd: '214710000000' },
    { month: 10, actual_cumulative_vnd: null, forecast_cumulative_vnd: '300000000000' },
  ],
};

const RANKINGS = {
  snapshot_id: S40,
  as_of_date: '2026-09-30',
  definition_status: 'SIGNED',
  visibility: 'ALL',
  tables: [
    {
      comparison_group: 'Sở ngành',
      denominator_kind: 'PM_ASSIGNED',
      ranked: [
        { rank: 1, unit: { id: 'u1', code: 'SGD', name: 'Sở Giáo dục' }, plan_vnd: '300000000000', disbursed_vnd: '150000000000', rate_pct: '50.0000', excluded_reason: null },
        { rank: 2, unit: { id: 'u2', code: 'SGT', name: 'Sở Giao thông' }, plan_vnd: '700000000000', disbursed_vnd: '64710000000', rate_pct: '9.2443', excluded_reason: null },
      ],
      excluded: [],
    },
  ],
};

interface Answers {
  center?: () => unknown;
  work?: (view: string) => unknown;
  warnings?: () => unknown;
  forecast?: () => unknown;
  rankings?: () => unknown;
}

const viewOf = (input: unknown): string => (input as { query?: { view?: string } } | undefined)?.query?.view ?? 'mine';

function client(answers: Answers = {}): Harness {
  const h = harness((operation, input) => {
    switch (operation) {
      case 'getCommandCenter':
        return (answers.center ?? (() => center()))();
      case 'getMyWork': {
        const body = (answers.work ?? (() => ({ view: viewOf(input), items: BAND_ITEMS, counts: alertCounts(BAND_ITEMS), unavailable_sources: [], as_of: '2026-11-07T00:05:00Z', next_cursor: null })))(viewOf(input));
        return body;
      }
      case 'getMyWorkCounts': {
        const body = (answers.work ?? (() => ({ view: viewOf(input), items: BAND_ITEMS })))(viewOf(input));
        return body instanceof Error ? body : { view: viewOf(input), counts: alertCounts(BAND_ITEMS), unavailable_sources: [], as_of: '2026-11-07T00:05:00Z' };
      }
      case 'getHomeWarnings':
        return (answers.warnings ?? (() => WARNINGS))();
      case 'getDisbursementForecast':
        return (answers.forecast ?? (() => FORECAST))();
      case 'getDisbursementRankings':
        return (answers.rankings ?? (() => RANKINGS))();
      default:
        return new Error(`unexpected read ${operation}`);
    }
  });
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown> }).readAll = () => Promise.resolve([]);
  return h;
}

const sectionOf = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// The screens read several sources at once; under the load of a whole run the default second is too short to prove them wrong.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanup);

describe('HOME-01 the leader home: work first, then the numbers (decision 2A)', () => {
  it('shows the sections in the order: scope line, what needs action, command block with four tiles, bottlenecks, cash flow and ranking', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    await screen.findByTestId('home-kpis');
    const context = screen.getByTestId('home-context');
    const band = screen.getByTestId('home-band');
    const hero = screen.getByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2026' }) });
    const kpis = screen.getByTestId('home-kpis');
    const causes = sectionOf(tr('home.ov.cause.title'));
    const flow = sectionOf(tr('home.ov.flow.title'));
    const ranking = sectionOf(tr('home.ov.rank.title'));
    const order = [context, band, hero, kpis, causes, flow, ranking];
    for (let index = 0; index < order.length - 1; index += 1) expect(follows(order[index] as Element, order[index + 1] as Element)).toBe(true);
    expect(within(kpis).getAllByText(/./).length).toBeGreaterThan(0);
  });

  it('has no Save or Continue button: the home is read and acted on, not filled in', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    await screen.findByTestId('home-kpis');
    await waitFor(() => expect(screen.getByTestId('home-band').textContent).toContain('Giấy phép XD'));
    expect(screen.queryByRole('button', { name: /^(Lưu|Tiếp tục)/ })).toBeNull();
    expect(document.querySelector('form')).toBeNull();
  });

  it('shows the band of the scope by default, with the work first and the counts by level', async () => {
    const h = client();
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    const band = screen.getByTestId('home-band');
    await waitFor(() => expect(band.textContent).toContain('Giấy phép XD DA-DT205 hết hạn'));
    expect(band.getAttribute('data-view')).toBe('scope');
    expect(band.textContent).toContain('Báo cáo tuần 40 quá hạn');
    expect(h.read.mock.calls.some(([operation, input]) => operation === 'getMyWork' && viewOf(input) === 'scope')).toBe(true);
  });

  it('falls back to the work of the person when the server refuses the scope, and shows no error', async () => {
    const h = client({ work: (view) => (view === 'scope' ? failure(403, 'FORBIDDEN') : { view, items: [alertItem('a3', 'WATCH', 'Việc của riêng tôi')], counts: { urgent: 0, action: 0, watch: 1, total: 1 }, unavailable_sources: [], as_of: null, next_cursor: null }) });
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    const band = screen.getByTestId('home-band');
    await waitFor(() => expect(band.textContent).toContain('Việc của riêng tôi'));
    expect(band.getAttribute('data-view')).toBe('mine');
    expect(within(band).queryByRole('alert')).toBeNull();
  });

  it('names a failure of the band and keeps the numbers: the work is never shown as "none" when it could not be read', async () => {
    mount(<OverviewScreen route={OV} />, client({ work: () => failure(500, 'INTERNAL_ERROR') }), { permissions: READER });
    await screen.findByTestId('home-kpis');
    const band = screen.getByTestId('home-band');
    await waitFor(() => expect(within(band).getByRole('alert')).toBeTruthy());
    expect(band.textContent).not.toContain(tr('alerts.band.noneNoTime'));
  });

  describe('the command block', () => {
    it('gives the amount disbursed as the text of the server, the ring, and the two rates side by side, each with its "i"', async () => {
      mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
      const hero = await screen.findByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2026' }) });
      // The text is the server's `display_value`: nothing is re-formatted here.
      expect(hero.textContent).toContain('214710000000');
      expect(hero.textContent).toContain(tr('govc.home.unit.vnd'));
      expect(hero.textContent).toContain(fill(tr('home.tile.value.percent'), { value: '21.47' }));
      expect(hero.textContent).toContain(fill(tr('home.tile.value.percent'), { value: '17.18' }));
      expect(hero.textContent).toContain(tr('home.ov.hero.chip.pm'));
      expect(hero.textContent).toContain(tr('home.ov.hero.chip.total'));
      expect(within(hero).getByRole('img', { name: /21%/ })).toBeTruthy();
      expect(within(hero).getByRole('link', { name: tr('home.ov.hero.action.sources') }).getAttribute('href')).toBe('/home/home-10?token=token-DISBURSED_TREASURY.sig');
      expect(within(hero).getByRole('link', { name: tr('home.ov.hero.action.ranking') }).getAttribute('href')).toBe('/home/home-04');
    });

    it('shows an amount of 0 as 0, and a missing amount as missing with the reason, never as 0', async () => {
      mount(<OverviewScreen route={OV} />, client({ center: () => center({ tiles: [tile('DISBURSEMENT_RATE_PM', { value: '0.0000', numerator: '0' }), tile('DISBURSEMENT_RATE_TOTAL', { value: '0.0000', numerator: '0' }), tile('DISBURSED_TREASURY', { unit: 'VND', value: '0', numerator: null, denominator: null })] }) }), { permissions: READER });
      const hero = await screen.findByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2026' }) });
      expect(hero.textContent).toContain(fill(tr('home.tile.value.percent'), { value: '0.00' }));
      expect(hero.textContent).not.toContain(tr('home.ov.hero.noData'));
      cleanup();
      mount(<OverviewScreen route={OV} />, client({ center: () => center({ tiles: [tile('DISBURSEMENT_RATE_PM', { value: null, null_reason: 'NO_DATA', numerator: null }), tile('DISBURSEMENT_RATE_TOTAL', { value: null, null_reason: 'NO_DATA', numerator: null }), tile('DISBURSED_TREASURY', { unit: 'VND', value: null, null_reason: 'NO_DATA', numerator: null, denominator: null })] }) }), { permissions: READER });
      const missing = await screen.findByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2026' }) });
      expect(missing.textContent).toContain(tr('home.ov.hero.noData'));
      expect(missing.textContent).not.toContain('0.00');
      expect(missing.textContent).not.toMatch(/\b0\b/);
      expect(missing.textContent).toContain(tr('home.tile.nullReason.noData'));
    });

    it('keeps the empty state of a tenant with no snapshot closed, with its words, and still shows the work', async () => {
      mount(<OverviewScreen route={OV} />, client({ center: () => failure(404, 'RESOURCE_NOT_FOUND') }), { permissions: READER });
      const empty = await screen.findByTestId('home-empty');
      expect(within(empty).getByText(tr('home.empty.title'))).toBeTruthy();
      expect(screen.queryByTestId('home-kpis')).toBeNull();
      await waitFor(() => expect(screen.getByTestId('home-band').textContent).toContain('Giấy phép XD'));
    });

    it('shows a loading state while the figures are read, and no zero in it', () => {
      mount(<OverviewScreen route={OV} />, harness(() => new Promise(() => undefined)), { permissions: READER });
      expect(screen.queryByTestId('home-kpis')).toBeNull();
      expect(screen.queryByRole('region', { name: fill(tr('home.ov.hero.label'), { year: '2026' }) })).toBeNull();
      expect(screen.getByTestId('home-context').textContent).not.toMatch(/\b0\b/);
    });
  });

  describe('the four tiles', () => {
    it('gives the plan, the early warnings with the overdue explanations, the reallocations awaiting a decision, and the coverage of the projects', async () => {
      mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
      const kpis = await screen.findByTestId('home-kpis');
      expect(kpis.textContent).toContain('1250000000000');
      expect(kpis.textContent).toContain(fill(tr('govc.home.kpi.plan.sub'), { pm: '1000000000000' }));
      expect(kpis.textContent).toContain(tr('home.ov.kpi.openWarnings.label'));
      expect(kpis.textContent).toContain(fill(tr('home.ov.kpi.warnings.sub'), { count: 1 }));
      expect(kpis.textContent).toContain(tr('home.ov.kpi.realloc.label'));
      expect(kpis.textContent).toContain(tr('home.ov.kpi.coverage.title'));
      // Ten projects, two of them without a figure.
      expect(kpis.textContent).toContain('8');
      expect(kpis.textContent).toContain('10');
    });
  });

  describe('the bottlenecks', () => {
    it('groups the open warnings by cause, heaviest plan not yet disbursed first, and never lists the items of the band', async () => {
      mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.cause.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(within(section).getByText('Chậm giải phóng mặt bằng')).toBeTruthy());
      const body = within(section).getAllByRole('row').slice(1);
      expect(body).toHaveLength(2);
      // GPMB: (500 - 100) + (200 - 50) = 550 billion over 2 projects; payment: 100 - 90 = 10 billion.
      expect(body[0]?.textContent).toContain('Chậm giải phóng mặt bằng');
      expect(body[0]?.textContent).toContain('550,00');
      expect(body[0]?.textContent).toContain('Đường tỉnh 205');
      expect(body[1]?.textContent).toContain('Chậm thanh toán');
      expect(body[1]?.textContent).toContain('10,00');
      // What the band lists is not listed here.
      for (const entry of BAND_ITEMS) expect(section.textContent).not.toContain(entry.title);
    });

    it('says there is no bottleneck only when the source answered with no open warning', async () => {
      mount(<OverviewScreen route={OV} />, client({ warnings: () => ({ items: [], next_cursor: null }) }), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.cause.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(section.textContent).toContain(tr('home.ov.cause.empty')));
    });

    it('names the source when the warnings cannot be read, and the rest of the page stands', async () => {
      mount(<OverviewScreen route={OV} />, client({ warnings: () => failure(500, 'INTERNAL_ERROR') }), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.cause.title') }).then((heading) => heading.closest('section') as HTMLElement);
      const error = await within(section).findByTestId('source-error');
      expect(error.textContent).toContain(fill(tr('home.ov.source.error'), { source: tr('home.ov.source.warnings') }));
      expect(section.textContent).not.toContain(tr('home.ov.cause.empty'));
      expect(screen.getByTestId('home-kpis')).toBeTruthy();
    });
  });

  describe('the cash flow and the ranking', () => {
    it('draws the cumulative cash flow with the actual line and the dashed forecast, each labelled', async () => {
      mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.flow.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(section.textContent).toContain(tr('home.ov.flow.actual')));
      expect(section.textContent).toContain(tr('home.ov.flow.plan'));
      expect(section.textContent).toContain(fill(tr('home.ov.flow.caption'), { year: 2026 }));
      expect(section.querySelector('svg')).not.toBeNull();
    });

    it('says the empty curve is empty, and names the source when it cannot be read', async () => {
      mount(<OverviewScreen route={OV} />, client({ forecast: () => ({ ...FORECAST, curve: [] }) }), { permissions: READER });
      const empty = await screen.findByRole('heading', { name: tr('home.ov.flow.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(empty.textContent).toContain(tr('ui.flowChart.empty')));
      cleanup();
      mount(<OverviewScreen route={OV} />, client({ forecast: () => failure(500, 'INTERNAL_ERROR') }), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.flow.title') }).then((heading) => heading.closest('section') as HTMLElement);
      expect((await within(section).findByTestId('source-error')).textContent).toContain(fill(tr('home.ov.source.error'), { source: tr('home.ov.source.cashflow') }));
    });

    it('ranks the units of the plan the Prime Minister gave, in a table with the link to the full ranking', async () => {
      mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
      const section = await screen.findByRole('heading', { name: tr('home.ov.rank.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(within(section).getByText('Sở Giáo dục')).toBeTruthy());
      const rows = within(section).getAllByRole('row').slice(1);
      expect(rows[0]?.textContent).toContain('Sở Giáo dục');
      expect(rows[0]?.textContent).toContain('50,00%');
      expect(rows[1]?.textContent).toContain('Sở Giao thông');
      expect(within(section).getByRole('link', { name: fill(tr('home.ov.rank.more'), { total: 2 }) }).getAttribute('href')).toBe('/home/home-04');
    });

    it('names the source when the ranking cannot be read and says nothing is ranked when it answered with no table', async () => {
      mount(<OverviewScreen route={OV} />, client({ rankings: () => failure(500, 'INTERNAL_ERROR') }), { permissions: READER });
      const failed = await screen.findByRole('heading', { name: tr('home.ov.rank.title') }).then((heading) => heading.closest('section') as HTMLElement);
      expect((await within(failed).findByTestId('source-error')).textContent).toContain(fill(tr('home.ov.source.error'), { source: tr('home.ov.source.rankings') }));
      cleanup();
      mount(<OverviewScreen route={OV} />, client({ rankings: () => ({ ...RANKINGS, tables: [] }) }), { permissions: READER });
      const empty = await screen.findByRole('heading', { name: tr('home.ov.rank.title') }).then((heading) => heading.closest('section') as HTMLElement);
      await waitFor(() => expect(empty.textContent).toContain(tr('ui.dataTable.emptyNone')));
      expect(empty.querySelector('[data-testid="source-error"]')).toBeNull();
    });
  });

  it('keeps the formula, the denominator and the way to the source of every figure, folded under the numbers', async () => {
    mount(<OverviewScreen route={OV} />, client(), { permissions: READER });
    const details = await screen.findByTestId('home-details');
    expect(within(details).getByTestId('tile-formula-DISBURSEMENT_RATE_PM').textContent).toContain('plan_pm_assigned_vnd');
    expect(within(details).getByTestId('tile-sums-DISBURSEMENT_RATE_PM').textContent).toContain('214.710.000.000');
    expect(within(details).getByTestId('context-snapshot').getAttribute('title')).toBe(S40);
  });
});
