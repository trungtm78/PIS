import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { client as bidClient, mount as bidMount, treeDto, world } from '../../screens/bid/workflow/test-support';
import { describeViolations, seriousViolations } from '../../test/axe';
import FiguresDetailScreen from './FiguresDetailScreen';
import ProgressScreen, { outlineOf } from './ProgressScreen';
import { mountPwa, pwaClient, word } from './test-support';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanup);

describe('ProgressScreen (PWA-09): the procurement progress as a list', () => {
  it('UAT-PWA-02 step 2: lists the steps of each method in order with counts and lateness, the counts at the top and the ends apart', async () => {
    const h = bidClient(world());
    bidMount(<ProgressScreen />, h, { permissions: ['bid.read'], path: '/m/progress' });
    const kpis = await screen.findByTestId('kpis');
    expect(kpis.querySelector('[data-tile="total"]')?.textContent).toContain('4');
    expect(kpis.querySelector('[data-tile="late"]')?.getAttribute('data-tone')).toBe('danger');
    expect(kpis.querySelector('[data-tile="value"]')?.textContent).toContain('400');
    const method = document.querySelector('[data-method="OPEN_BIDDING"]') as HTMLElement;
    expect(method.textContent).toContain('Quy trình đấu thầu rộng rãi');
    const steps = Array.from(method.querySelectorAll('[data-step]')).map((item) => item.getAttribute('data-step'));
    expect(steps).toEqual(['S:OPEN_BIDDING:DOC_PREPARE', 'S:OPEN_BIDDING:EVALUATE']);
    const first = method.querySelector('[data-step="S:OPEN_BIDDING:DOC_PREPARE"]') as HTMLElement;
    expect(first.textContent).toContain('Lập hồ sơ mời thầu');
    expect(first.textContent).toContain('2 gói thầu');
    expect(first.textContent).toContain('1 trễ hạn');
    expect(first.textContent).toContain('trung vị 6 ngày');
    expect(screen.getByTestId('terminals').querySelector('[data-terminal="NOT_STARTED"]')?.textContent).toContain('1');
    expect(screen.getByTestId('pwa-full-tree').getAttribute('href')).toBe('/bid/bid-27');
    expect(h.read).toHaveBeenCalledWith('getPackageProcessTree', { query: {} });
  });

  it('UAT-PWA-02 step 2: opens the packages of a step on a tap and closes them on the next (AC-ST-PWA-002-2)', async () => {
    const h = bidClient(world());
    bidMount(<ProgressScreen />, h, { permissions: ['bid.read'], path: '/m/progress' });
    await screen.findByTestId('kpis');
    const step = document.querySelector('[data-step="S:OPEN_BIDDING:DOC_PREPARE"] [data-action="step"]') as HTMLElement;
    expect(step.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(step);
    const packages = await screen.findByTestId('packages');
    expect(step.getAttribute('aria-expanded')).toBe('true');
    expect(packages.querySelector('[data-package]')?.textContent).toContain('GT-1');
    expect(packages.textContent).toContain('Cầu qua sông');
    expect(packages.textContent).toContain('Nguyễn Văn An');
    expect(packages.textContent).toContain('Trễ 3 ngày');
    expect(h.read).toHaveBeenCalledWith('listPackageProcessTreeNodePackages', { query: expect.objectContaining({ node_id: 'S:OPEN_BIDDING:DOC_PREPARE' }) });
    fireEvent.click(step);
    expect(screen.queryByTestId('packages')).toBeNull();
  });

  it('UAT-PWA-02 step 3: says the scope is hidden without the right and asks the server nothing; an error retries in place', async () => {
    const hidden = bidClient(world());
    bidMount(<ProgressScreen />, hidden, { permissions: ['home.read'], path: '/m/progress' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(hidden.read).not.toHaveBeenCalled();
    cleanup();
    const state = world();
    state.failing = new Map([['getPackageProcessTree', { error: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), times: 1 }]]);
    bidMount(<ProgressScreen />, bidClient(state), { permissions: ['bid.read'], path: '/m/progress' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('kpis');
  });

  it('has no serious accessibility violation and the steps are touch targets', async () => {
    bidMount(<ProgressScreen />, bidClient(world()), { permissions: ['bid.read'], path: '/m/progress' });
    await screen.findByTestId('kpis');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    for (const control of document.querySelectorAll('[data-action="step"], [data-testid="pwa-back"]')) expect(control.className).toContain('pwa-touch');
  });

  it('builds the outline from the tree: methods with steps by order, terminals summed over methods', () => {
    const outline = outlineOf(treeDto() as never);
    expect(outline.methods).toHaveLength(1);
    expect(outline.methods[0]?.steps.map((step) => step.step_code)).toEqual(['DOC_PREPARE', 'EVALUATE']);
    expect(outline.terminals).toEqual([{ terminal: 'NOT_STARTED', count: 1 }]);
  });
});

const tile = (code: string, overrides: Record<string, unknown> = {}) => ({ metric_code: code, value: '60.0000', numerator: '600000000000', denominator: '1000000000000', null_reason: null, unit: 'PERCENT', formula: 'x', definition_status: 'PROPOSED_PENDING_SIGNOFF', context_token: `token-${code}.sig`, ...overrides });
const center = {
  snapshot_id: '00000000-0000-4000-8000-0000000000f2',
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: ['CXN-03'],
  scope: { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h' },
  tiles: [tile('DISBURSEMENT_RATE_PM'), tile('DISBURSED_TREASURY', { unit: 'VND', value: '600000000000', numerator: null, denominator: null }), tile('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', numerator: null, denominator: null })],
  projects_without_data: 0,
  open_warnings: 0,
  overdue_explanations: 0,
  pending_reallocations: 0,
  quality_badge: 'NOT_ASSESSED',
};

describe('FiguresDetailScreen (PWA-08): the drill-down of the command center', () => {
  it('UAT-PWA-02 step 1: shows the amounts of the snapshot in one column and keeps going when another card cannot be read (AC-ST-PWA-002-1)', async () => {
    const h = pwaClient({ read: (operation) => (operation === 'getCommandCenter' ? center : new Error(`unexpected read ${operation}`)) });
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['home.read'], path: '/m/dashboard/detail' });
    const amounts = await screen.findByTestId('figures-amounts');
    expect(amounts.textContent).toContain('600');
    expect(screen.getByTestId('figures-context').textContent).toContain('12/10/2027');
    expect(screen.getByTestId('figures-ranking')).toBeInTheDocument();
    // The line under the title names the six groups of the screen, the causes of slow disbursement and the warning level among them (UI-PWA-08).
    const subtitle = screen.getByText(word('scr4.pwa.figures.subtitle')).textContent?.toLowerCase() ?? '';
    for (const group of ['số tiền theo bản chốt', 'xếp hạng', 'nguyên nhân chậm giải ngân', 'dòng tiền', 'thay đổi so với bản chốt trước', 'mức cảnh báo']) expect(subtitle).toContain(group);
    expect(h.read).toHaveBeenCalledWith('getCommandCenter', expect.anything());
  });

  it('UAT-PWA-02 step 3: says the scope is hidden without the right to read the command center', async () => {
    const h = pwaClient({});
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['bid.read'], path: '/m/dashboard/detail' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(h.read).not.toHaveBeenCalled();
  });
});

// UAT-PWA-02 step 1 with the real answers of every card of the snapshot of HOME-09: the amounts, the ranking, the causes, the cash flow and the changes
// (the same shapes the server answers; `getCommandCenter` is `center` above).
const S_ID = center.snapshot_id;
const warning = (id: string, ruleCode: string, ruleName: string, projectId: string, projectName: string, plan: string, paid: string) => ({
  id,
  rule: { code: ruleCode, name: ruleName, metric_code: 'DISBURSEMENT_RATE_PM' },
  severity: 'WARNING',
  status: 'OPEN',
  project: { id: projectId, code: projectId.toUpperCase(), name: projectName },
  observed: {},
  snapshot_id: S_ID,
  opened_at: '2027-10-12T00:00:00Z',
  evidence: { snapshot_id: S_ID, as_of_date: '2027-10-12', cells: [{ bucket: 'Y', budget_level: 'CENTRAL', plan_pm_assigned_vnd: plan, plan_local_added_vnd: '0', disbursed_treasury_vnd: paid, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: null, treasury_coverage: 'COMPLETE' }] },
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
  snapshot_id: S_ID,
  plan_year: 2027,
  cutoff_month: 9,
  curve: [
    { month: 8, actual_cumulative_vnd: '150000000000', forecast_cumulative_vnd: null },
    { month: 9, actual_cumulative_vnd: '214710000000', forecast_cumulative_vnd: '214710000000' },
    { month: 10, actual_cumulative_vnd: null, forecast_cumulative_vnd: '300000000000' },
  ],
};
const RANKINGS = {
  snapshot_id: S_ID,
  as_of_date: '2027-10-12',
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
const changeLine = (overrides: Record<string, unknown> = {}) => ({ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '10.00', to: '12.50', delta: '2.50' }, link: 'DRILL', metric_code: 'DISBURSEMENT_RATE_PM', context_token: 'tok-rate.sig', ...overrides });
const CHANGES = {
  snapshot_id: S_ID,
  as_of_date: '2027-10-12',
  week_start: '2027-10-11',
  previous_week_start: '2027-10-04',
  previous_as_of_date: '2027-10-05',
  reason: null,
  max_lines: 5,
  lines: [
    changeLine(),
    changeLine({ kind: 'UNITS_TO_RED', direction: 'DOWN', params: { count: 2 }, link: 'RAG', metric_code: null, context_token: null }),
    changeLine({ kind: 'WARNINGS_DELTA', direction: 'UP', params: { from: '3', to: '4', delta: '1' }, link: 'WARNINGS', metric_code: null, context_token: null }),
  ],
};
const RAG = { snapshot_id: S_ID, as_of_date: '2027-10-12', week_start: '2027-10-11', model: { unverified: false, versions: {}, min_coverage_pct: 60, score_green: 30, score_amber: 60, factors: [] }, summary: { RED: 2, AMBER: 1, GREEN: 5, NO_DATA: 1 }, units: [] };
const failure = (): ApiError => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });

type CardRead = 'getDisbursementRankings' | 'getHomeWarnings' | 'getDisbursementForecast' | 'getHomeChanges';
const figuresClient = (failing: Partial<Record<CardRead, unknown>> = {}) => {
  const answers: Record<string, unknown> = { getCommandCenter: center, getDisbursementRankings: RANKINGS, getHomeWarnings: WARNINGS, getDisbursementForecast: FORECAST, getHomeChanges: CHANGES, getRagReading: RAG, ...failing };
  return pwaClient({ read: (operation) => (operation in answers ? answers[operation] : new Error(`unexpected read ${operation}`)) });
};
const cardOf = async (title: string): Promise<HTMLElement> => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement;

describe('UAT-PWA-02 step 1: the figures of the snapshot of HOME-09 on the phone, card by card', () => {
  it('UAT-PWA-02 step 1: reads the amounts, the ranking, the causes, the cash flow and the changes of the snapshot from their real answers', async () => {
    const h = figuresClient();
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['home.read'], path: '/m/dashboard/detail' });
    // the amounts of the snapshot
    const amounts = await screen.findByTestId('figures-amounts');
    expect(amounts.textContent).toContain('600');
    expect(screen.getByTestId('figures-context').textContent).toContain('12/10/2027');
    // the ranking of the units: names (not codes), in order, with the rate
    const ranking = await cardOf(word('home.ov.rank.title'));
    await waitFor(() => expect(within(ranking).getByText('Sở Giáo dục')).toBeTruthy());
    const rankRows = within(ranking).getAllByRole('row').slice(1);
    expect(rankRows).toHaveLength(2);
    expect(rankRows[0]?.textContent).toContain('Sở Giáo dục');
    expect(rankRows[0]?.textContent).toContain('50,00%');
    expect(rankRows[1]?.textContent).toContain('Sở Giao thông');
    expect(ranking.textContent).not.toContain('SGD');
    // the causes: the open warnings counted by the rule that raised them
    const causes = await cardOf(word('home.ov.cause.title'));
    await waitFor(() => expect(within(causes).getByText('Chậm giải phóng mặt bằng')).toBeTruthy());
    const causeRows = within(causes).getAllByRole('row').slice(1);
    expect(causeRows).toHaveLength(2);
    const gpmb = causeRows.find((row) => row.textContent?.includes('Chậm giải phóng mặt bằng')) as HTMLElement;
    expect(within(gpmb).getAllByRole('cell').map((cell) => cell.textContent)).toContain('2');
    expect(gpmb.textContent).toContain('Đường tỉnh 205');
    expect(causeRows.some((row) => row.textContent?.includes('Chậm thanh toán'))).toBe(true);
    // the cash flow: the actual line and the forecast, for the plan year of the snapshot
    const flow = await cardOf(word('home.ov.flow.title'));
    await waitFor(() => expect(flow.textContent).toContain(word('home.ov.flow.plan')));
    expect(flow.textContent).toContain(word('home.ov.flow.caption', { year: 2027 }));
    // the changes since the week before: the lines of the server as sentences, each with its direction
    const changes = await screen.findByTestId('changes-lines');
    const lines = Array.from(changes.querySelectorAll('li'));
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['RATE_CHANGE', 'UNITS_TO_RED', 'WARNINGS_DELTA']);
    expect(lines[0]?.textContent).toContain('12.50');
    expect(lines[0]?.textContent).toContain('10.00');
    expect(lines[1]?.getAttribute('data-direction')).toBe('DOWN');
    expect(screen.getByTestId('changes-range').textContent).toContain('04/10/2027');
    // every card read the snapshot it belongs to
    for (const operation of ['getCommandCenter', 'getDisbursementRankings', 'getHomeWarnings', 'getDisbursementForecast', 'getHomeChanges']) expect(h.read).toHaveBeenCalledWith(operation, expect.anything());
    expect(h.read).toHaveBeenCalledWith('getDisbursementForecast', { query: expect.objectContaining({ snapshot_id: S_ID }) });
  });

  const cards: Array<{ read: CardRead; name: string; title: string; source: string }> = [
    { read: 'getDisbursementRankings', name: 'ranking', title: 'home.ov.rank.title', source: 'home.ov.source.rankings' },
    { read: 'getHomeWarnings', name: 'causes', title: 'home.ov.cause.title', source: 'home.ov.source.warnings' },
    { read: 'getDisbursementForecast', name: 'cash flow', title: 'home.ov.flow.title', source: 'home.ov.source.cashflow' },
  ];
  it.each(cards)('UAT-PWA-02 step 1: a $name card that cannot be read is named in its own card and the other cards stay', async ({ read, title, source }) => {
    const h = figuresClient({ [read]: failure() });
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['home.read'], path: '/m/dashboard/detail' });
    expect((await screen.findByTestId('figures-amounts')).textContent).toContain('600');
    const failed = await cardOf(word(title));
    expect((await within(failed).findByTestId('source-error')).textContent).toContain(word('home.ov.source.error', { source: word(source) }));
    // the others are not hidden: only this one card is in error, the changes still list their lines and the amounts stand
    expect(screen.getAllByTestId('source-error')).toHaveLength(1);
    expect((await screen.findByTestId('changes-lines')).querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('figures-amounts').textContent).toContain('600');
  });

  it('UAT-PWA-02 step 1: a changes card that cannot be read is named in its own card and the other cards stay', async () => {
    const h = figuresClient({ getHomeChanges: failure() });
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['home.read'], path: '/m/dashboard/detail' });
    const error = await screen.findByTestId('changes-error');
    expect(error.textContent).toContain(word('home.ov.source.error', { source: word('govc.home.changes.source') }));
    expect(screen.queryByTestId('changes-lines')).toBeNull();
    const ranking = await cardOf(word('home.ov.rank.title'));
    await waitFor(() => expect(within(ranking).getByText('Sở Giáo dục')).toBeTruthy());
    expect(screen.getByTestId('figures-amounts').textContent).toContain('600');
    expect(screen.queryByTestId('source-error')).toBeNull();
  });

  it('UAT-PWA-02 negative control: a wrong expectation about a card makes the check throw', async () => {
    mountPwa(<FiguresDetailScreen />, figuresClient(), { permissions: ['home.read'], path: '/m/dashboard/detail' });
    const ranking = await cardOf(word('home.ov.rank.title'));
    await waitFor(() => expect(within(ranking).getByText('Sở Giáo dục')).toBeTruthy());
    expect(() => expect(within(ranking).getAllByRole('row')[1]?.textContent).toContain('Sở Giao thông')).toThrow();
    expect(() => expect(within(ranking).getAllByRole('row')[1]?.textContent).toContain('51,00%')).toThrow();
    expect(() => expect(screen.getByTestId('changes-lines').querySelectorAll('li')).toHaveLength(5)).toThrow();
    expect(() => expect(screen.getByTestId('figures-amounts').textContent).toContain('700')).toThrow();
  });
});

describe('the phone layout (360 px)', () => {
  // The stylesheet is written over several lines: the checks compare it with its whitespace collapsed.
  const css = readFileSync(join(__dirname, 'pwa.css'), 'utf8').replace(/\s+/g, ' ');

  it('keeps every screen to one column that never grows past the width, and wraps long words (AC-ST-PWA-002-3)', () => {
    expect(css).toMatch(/\.pwa-screen \{[^}]*max-width: 720px/);
    expect(css).toMatch(/\.pwa-screen \{[^}]*min-width: 0; overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^@]*\.pwa-screen table \{ display: block; overflow-x: auto; max-width: 100%; \}/);
    expect(css).toMatch(/\.pwa-tiles \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('gives every control a 44 px target and the step rows too', () => {
    expect(css).toMatch(/\.pwa-touch \{[^}]*min-height: 44px; min-width: 44px/);
    expect(css).toMatch(/\.pwa-step \{[^}]*width: 100%/);
    expect(css).toMatch(/\.pwa-sticky-actions \{[^}]*position: sticky; bottom: 0/);
  });

  it('moves the sheet to the bottom of a phone', () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^}]*\.pwa-sheet-backdrop \{ place-items: end center/);
  });
});
