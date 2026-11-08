import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import RiskSignalBoardScreen from './RiskSignalBoardScreen';

const words = vi_ as Record<string, string>;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), words[key] ?? key);
const ROUTE = routeOf('PRJ-28', 'FR-PRJ-28');
const PROJECT = line(1).id;
const ALERT_ID = '00000000-0000-4000-8000-0000000000a9';
const OK = { operation_id: 'o', status: 'ACKNOWLEDGED', resource_version: 3, resource_id: 'x' };
const refusal = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(cleanup);

const policy = (overrides: Record<string, unknown> = {}) => ({
  name: 'RISK_SIGNAL_POLICY',
  code: 'DEFAULT',
  formula: 'Likelihood from four thresholds, times the impact of the kind',
  source: 'Governance rule registry',
  as_of: '2026-11-08',
  legal_status: 'UNVERIFIED',
  unverified: true,
  version: 'built-in:1',
  owner: 'PRJ',
  params: {
    impact: { SCHEDULE_DELAY: 4, PAYMENT_INTEGRITY: 4, CLAIM_EARLY_WARNING: 3, FUNDING_GAP: 5, PROCUREMENT_DELAY: 3 },
    thresholds: {
      SPI_SHORTFALL_PCT: [5, 10, 20, 30],
      MILESTONE_SLIP_DAYS: [7, 14, 30, 60],
      PAYMENT_BLOCKED_DRAFTS: [1, 2, 3, 5],
      PAYMENT_SIGNAL_REQUESTS: [1, 2, 4, 8],
      OPEN_CLAIMS: [1, 2, 3, 5],
      EARLY_WARNINGS_HIGH: [1, 2, 3, 5],
      FUNDING_GAP_PCT: [5, 10, 20, 40],
      PROCUREMENT_SLIP_DAYS: [7, 14, 30, 60],
    },
    open_from_likelihood: 2,
    critical_score: 15,
    jump_points: 6,
  },
  ...overrides,
});

const evidence = { indicators: { MILESTONE_SLIP_DAYS: 45, SPI_SHORTFALL_PCT: null }, drivers: [{ indicator: 'MILESTONE_SLIP_DAYS', value: 45, likelihood: 4 }], unknown: ['SPI_SHORTFALL_PCT'], facts: { milestones: 3, milestones_late: 1, claim_register: false, funding_needed_vnd: '1200000000' } };

const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  origin: 'SIGNAL',
  id: `00000000-0000-4000-8000-0000000001${n}0`,
  project_id: PROJECT,
  project_code: 'DA-2026-001',
  project_name: 'Dự án số 1',
  kind: 'SCHEDULE_DELAY',
  title: null,
  likelihood: 4,
  impact: 4,
  score: 16,
  level: 'CRITICAL',
  previous_score: 12,
  trend: 'UP',
  scored_on: '2026-11-08',
  evidence,
  owner: { membership_id: '00000000-0000-4000-8000-0000000000a1', display_name: 'Nguyễn Văn An' },
  alert_open: true,
  rule_unverified: true,
  ...overrides,
});

const board = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  counts: { total: 3, critical: 1, medium: 1, low: 1, open_alerts: 2 },
  policy: policy(),
  as_of: '2026-11-08',
  ...overrides,
});

const historyRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000002${n}0`,
  subject_kind: 'SIGNAL',
  signal_id: 'line-1',
  risk_id: null,
  signal_kind: 'SCHEDULE_DELAY',
  source: 'JOB',
  scored_on: '2026-11-06',
  likelihood: 3,
  impact: 4,
  score: 12,
  level: 'MEDIUM',
  prior_score: null,
  status: 'ACTIVE',
  evidence,
  rule_version: 'built-in:1',
  scored_at: '2026-11-06T01:00:00.000Z',
  ...overrides,
});

const alertRow = (overrides: Record<string, unknown> = {}) => ({
  id: ALERT_ID,
  alert_type: 'RISK_SCORE_CRITICAL',
  subject_kind: 'SIGNAL',
  signal_kind: 'SCHEDULE_DELAY',
  score: 16,
  prior_score: 12,
  threshold: 15,
  rule_version: 'built-in:1',
  rule_unverified: true,
  status: 'OPEN',
  raised_on: '2026-11-07',
  acknowledged_at: null,
  acknowledge_note: null,
  resolved_on: null,
  version: 4,
  ...overrides,
});

const project = (overrides: Record<string, unknown> = {}) => ({
  project: { id: PROJECT, code: 'DA-2026-001', name: 'Dự án số 1', status: 'IMPLEMENTATION' },
  lines: [{ id: 'line-1', signal_kind: 'SCHEDULE_DELAY', status: 'ACTIVE', likelihood: 4, impact: 4, score: 16, evidence, rule_version: 'built-in:1', rule_unverified: true, first_scored_on: '2026-11-01', last_scored_on: '2026-11-08', cleared_on: null, version: 3 }],
  history: [
    historyRow(1),
    historyRow(2, { scored_on: '2026-11-07', likelihood: 4, score: 16, level: 'CRITICAL', prior_score: 12, scored_at: '2026-11-07T01:00:00.000Z' }),
    historyRow(3, { subject_kind: 'RISK', signal_id: null, risk_id: 'risk-1', signal_kind: null, source: 'MANUAL', score: 9, level: 'MEDIUM', evidence: {} }),
  ],
  alerts: [alertRow()],
  policy: policy(),
  can: { acknowledge_alert: true },
  as_of: '2026-11-08',
  ...overrides,
});

type Answer = unknown | ((input: Record<string, unknown> | undefined) => unknown);

function open(answers: Record<string, Answer>, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  const h = client(world(), command);
  const previous = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    const answer = answers[operation];
    if (answer === undefined) return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
    const value = typeof answer === 'function' ? (answer as (given: unknown) => unknown)(input) : answer;
    return value instanceof Error ? Promise.reject(value) : value instanceof Promise ? value : Promise.resolve(value);
  });
  return h;
}

const show = (h: Harness, options: { mode?: 'FULL' | 'READ_ONLY'; id?: boolean } = {}) =>
  mount(<RiskSignalBoardScreen route={ROUTE} />, h, { permissions: ['project.read'], ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/prj/prj-28${options.id === true ? `?id=${PROJECT}` : ''}` });

const boardReads = (h: Harness) => h.read.mock.calls.filter(([name]) => name === 'getRiskSignalBoard').map(([, input]) => input as { query?: Record<string, unknown> });
const rowOf = (selector: string) =>
  waitFor(() => {
    const found = document.querySelector(selector);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
const infoButtons = (root: HTMLElement | Document = document) => within(root as HTMLElement).queryAllByRole('button', { name: /^Công thức và nguồn của/ });

describe('RiskSignalBoardScreen (PRJ-28): the board', () => {
  it('lists each line with the score, the level in words, the trend as an arrow and a word, the figures with their units, the figure that could not be known, the alert and the rule state', async () => {
    const h = open({ getRiskSignalBoard: board([item(1), item(2, { id: 'reg-1', origin: 'REGISTER', kind: 'REGISTER', title: 'Đền bù chậm', likelihood: 2, impact: 3, score: 6, level: 'MEDIUM', previous_score: null, trend: 'NEW', evidence: {}, owner: null, alert_open: false, rule_unverified: false })]) });
    show(h);
    expect(await screen.findByRole('heading', { level: 1, name: text('mr1.risk.board.title') })).toBeTruthy();
    const first = await rowOf('tr[data-origin="SIGNAL"]');
    expect(first.getAttribute('data-level')).toBe('CRITICAL');
    expect(first.textContent).toContain('DA-2026-001');
    expect(first.textContent).toContain('16');
    expect(first.textContent).toContain(text('mr1.risk.level.critical'));
    expect(first.textContent).toContain(text('mr1.risk.kind.scheduleDelay'));
    expect(first.querySelector('.rs-trend')?.getAttribute('data-trend')).toBe('UP');
    expect(first.querySelector('.rs-trend')?.textContent).toContain(text('mr1.risk.trend.up'));
    expect(first.querySelector('.rs-trend')?.textContent).toContain(text('mr1.risk.trend.previous', { score: 12 }));
    expect(first.querySelector('.rs-trend [aria-hidden="true"]')?.textContent).toBe('↑');
    expect(first.textContent).toContain(text('mr1.risk.unit.days', { value: '45' }));
    expect(first.querySelector('[data-indicator="SPI_SHORTFALL_PCT"]')?.textContent).toContain(text('mr1.risk.evidence.unknown'));
    expect(first.querySelector('[data-indicator="SPI_SHORTFALL_PCT"]')?.textContent).not.toMatch(/(^|\D)0(\D|$)/);
    expect(first.textContent).toContain(text('mr1.risk.alert.open'));
    expect(first.textContent).toContain(text('mr1.risk.unverified.pill'));
    expect(first.textContent).toContain('Nguyễn Văn An');
    const register = document.querySelector('tr[data-origin="REGISTER"]') as HTMLElement;
    expect(register.textContent).toContain('Đền bù chậm');
    expect(register.textContent).toContain(text('mr1.risk.evidence.none'));
    expect(register.textContent).toContain(text('mr1.risk.trend.new'));
    expect(register.textContent).toContain(text('mr1.risk.alert.none'));
    expect(register.textContent).toContain(text('mr1.risk.owner.none'));
    expect(register.textContent).toContain(text('mr1.risk.verified.pill'));
    expect(within(register).getByTestId('open-register').getAttribute('href')).toBe(`/prj/prj-16?id=${PROJECT}`);
    expect(within(first).getByTestId('open-project').getAttribute('href')).toContain(`id=${PROJECT}`);
  });

  it('says the level and the trend in words in every row, never by colour alone', async () => {
    const h = open({ getRiskSignalBoard: board([item(1), item(2, { level: 'MEDIUM', score: 9, trend: 'DOWN' }), item(3, { level: 'LOW', score: 3, trend: 'FLAT' })]) });
    show(h);
    await screen.findByText(text('mr1.risk.level.critical'), { selector: '.ui-pill span:last-child' });
    for (const [level, trend] of [['CRITICAL', 'up'], ['MEDIUM', 'down'], ['LOW', 'flat']] as const) {
      const row = document.querySelector(`tr[data-level="${level}"]`) as HTMLElement;
      expect(row.textContent).toContain(text(`mr1.risk.level.${level.toLowerCase()}`));
      expect(row.textContent).toContain(text(`mr1.risk.trend.${trend}`));
    }
  });

  it('shows the five counts as tiles, each with its "i", and the number comes from the server', async () => {
    const h = open({ getRiskSignalBoard: board([item(1)], { counts: { total: 11, critical: 4, medium: 5, low: 2, open_alerts: 3 } }) });
    show(h);
    const strip = await screen.findByRole('group', { name: text('mr1.risk.kpi.label') });
    for (const [label, value] of [['mr1.risk.kpi.total', '11'], ['mr1.risk.kpi.critical', '4'], ['mr1.risk.kpi.medium', '5'], ['mr1.risk.kpi.low', '2'], ['mr1.risk.kpi.alerts', '3']] as const) {
      const tile = within(strip).getByText(text(label)).closest('article') as HTMLElement;
      expect(tile.textContent).toContain(value);
      expect(infoButtons(tile).length).toBe(1);
    }
    expect(screen.getByText(text('mr1.risk.kpi.critical.sub', { score: 15 }))).toBeTruthy();
  });

  it('puts an "i" on every score and opens it on the formula, the source, the day, the owner, the version and the unverified flag', async () => {
    const h = open({ getRiskSignalBoard: board([item(1)]) });
    show(h);
    const row = await rowOf('tr[data-origin="SIGNAL"]');
    const info = infoButtons(row);
    expect(info.length).toBe(1);
    fireEvent.click(info[0] as HTMLElement);
    const panel = screen.getByRole('dialog', { name: /./ });
    expect(panel.textContent).toContain('Likelihood from four thresholds');
    expect(panel.textContent).toContain('Governance rule registry');
    expect(panel.textContent).toContain('08/11/2026');
    expect(panel.textContent).toContain('built-in:1');
    expect(panel.textContent).toContain(text('mr1.info.unverified'));
  });

  it('says "default, not confirmed" for the rule and shows its thresholds, impacts and lines', async () => {
    const h = open({ getRiskSignalBoard: board([item(1)]) });
    show(h);
    expect((await screen.findAllByTestId('unverified-notice')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('unverified-notice')[0]?.textContent).toBe(text('mr1.risk.unverified.notice'));
    const spi = within(screen.getByTestId('thresholds')).getByText(text('mr1.risk.indicator.spiShortfall')).closest('tr') as HTMLElement;
    expect(spi.textContent).toContain(text('mr1.risk.unit.percent', { value: '5' }));
    expect(spi.textContent).toContain(text('mr1.risk.unit.percent', { value: '30' }));
    const slip = within(screen.getByTestId('thresholds')).getByText(text('mr1.risk.indicator.milestoneSlip')).closest('tr') as HTMLElement;
    expect(slip.textContent).toContain(text('mr1.risk.unit.days', { value: '60' }));
    const lines = screen.getByTestId('rule-lines').textContent ?? '';
    expect(lines).toContain(text('mr1.risk.rule.critical', { value: 15 }));
    expect(lines).toContain(text('mr1.risk.rule.jump', { value: 6 }));
    expect(lines).toContain(text('mr1.risk.rule.impact', { kind: text('mr1.risk.kind.fundingGap'), value: 5 }));
  });

  it('does not say "default" when the rule is confirmed', async () => {
    const h = open({ getRiskSignalBoard: board([item(1, { rule_unverified: false })], { policy: policy({ unverified: false, legal_status: 'VERIFIED' }) }) });
    show(h);
    await screen.findByTestId('thresholds');
    expect(screen.queryByTestId('unverified-notice')).toBeNull();
    expect(screen.getAllByText(text('mr1.risk.verified.pill')).length).toBeGreaterThanOrEqual(1);
  });

  it('shows a skeleton and not a single zero while the board loads', () => {
    const h = open({ getRiskSignalBoard: new Promise(() => undefined) });
    show(h);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('thresholds')).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('says it could not load, names retry, and reads again on retry', async () => {
    let calls = 0;
    const h = open({
      getRiskSignalBoard: () => {
        calls += 1;
        return calls === 1 ? new Error('down') : board([item(1)]);
      },
    });
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: /Thử lại/ }));
    expect(await screen.findByTestId('thresholds')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('says in words that the scope is hidden when the read is refused (403)', async () => {
    const h = open({ getRiskSignalBoard: refusal('SCOPE_DENIED', 403) });
    show(h);
    expect((await screen.findByRole('alert')).textContent).toContain('Bạn chưa có quyền truy cập');
  });

  it('says there is nothing yet (none) and, under a filter, that the filter found nothing and clears it', async () => {
    const h = open({
      getRiskSignalBoard: (input: Record<string, unknown> | undefined) => (input?.query !== undefined && (input.query as Record<string, unknown>).level === 'LOW' ? board([], { counts: { total: 0, critical: 0, medium: 0, low: 0, open_alerts: 0 } }) : board([item(1)])),
    });
    show(h);
    await screen.findByTestId('thresholds');
    fireEvent.change(screen.getByTestId('filter-level'), { target: { value: 'LOW' } });
    expect(await screen.findByText('Không có kết quả phù hợp với bộ lọc')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    expect(await screen.findByTestId('open-project')).toBeTruthy();
    expect((screen.getByTestId('filter-level') as HTMLSelectElement).value).toBe('');
    cleanup();
    const none = open({ getRiskSignalBoard: board([], { counts: { total: 0, critical: 0, medium: 0, low: 0, open_alerts: 0 } }) });
    show(none);
    expect(await screen.findByText('Chưa có dữ liệu')).toBeTruthy();
  });

  it('filters by kind and by level on the server, and pages with the cursor, adding to the table', async () => {
    const h = open({
      getRiskSignalBoard: (input: Record<string, unknown> | undefined) => {
        const query = (input?.query ?? {}) as Record<string, unknown>;
        if (query.cursor === 'next-1') return board([item(2, { id: 'second', project_code: 'DA-2026-002' })], { next_cursor: null });
        return board([item(1)], { next_cursor: 'next-1' });
      },
    });
    show(h);
    await screen.findByTestId('load-more');
    expect(boardReads(h)[0]?.query).toEqual({ limit: 25 });
    fireEvent.click(screen.getByTestId('load-more'));
    expect(await screen.findByText('DA-2026-002')).toBeTruthy();
    expect(boardReads(h)[1]?.query).toEqual({ limit: 25, cursor: 'next-1' });
    expect(screen.getByText('DA-2026-001')).toBeTruthy();
    expect(screen.queryByTestId('load-more')).toBeNull();
    fireEvent.change(screen.getByTestId('filter-kind'), { target: { value: 'FUNDING_GAP' } });
    await waitFor(() => expect(boardReads(h).some((read) => read.query?.kind === 'FUNDING_GAP')).toBe(true));
    fireEvent.change(screen.getByTestId('filter-level'), { target: { value: 'CRITICAL' } });
    await waitFor(() => expect(boardReads(h).some((read) => read.query?.kind === 'FUNDING_GAP' && read.query?.level === 'CRITICAL')).toBe(true));
  });
});

describe('RiskSignalBoardScreen (PRJ-28): one project', () => {
  it('shows the lines with their evidence and facts, the score history newest first, a chart with its table, and the alerts', async () => {
    const h = open({ getProjectRiskSignals: project() });
    show(h, { id: true });
    expect(await screen.findByRole('heading', { level: 1, name: text('mr1.risk.project.titleOf', { code: 'DA-2026-001' }) })).toBeTruthy();
    expect(h.read.mock.calls.find(([name]) => name === 'getProjectRiskSignals')?.[1]).toMatchObject({ path: { id: PROJECT } });
    const lineRow = document.querySelector('tr[data-line="line-1"]') as HTMLElement;
    expect(lineRow.textContent).toContain(text('mr1.risk.lines.active'));
    expect(lineRow.textContent).toContain(text('mr1.risk.unit.days', { value: '45' }));
    expect(lineRow.textContent).toContain(text('mr1.risk.evidence.unknown'));
    expect(within(lineRow).getByTestId('facts').textContent).toContain(text('mr1.risk.fact.milestones'));
    expect(within(lineRow).getByTestId('facts').textContent).toContain('1200000000');
    expect(within(lineRow).getByTestId('facts').textContent).toContain(text('mr1.risk.fact.no'));
    // The level of a line is the one the server wrote with its newest score.
    expect(lineRow.textContent).toContain(text('mr1.risk.level.critical'));
    const rows = Array.from(document.querySelectorAll('tr[data-history]'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('07/11/2026');
    expect(rows[rows.length - 1]?.textContent).toContain('06/11/2026');
    expect(rows.some((row) => row.textContent?.includes(text('mr1.risk.history.source.manual')))).toBe(true);
    const tracks = document.querySelectorAll('[data-track]');
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.querySelector('svg[role="img"]')).not.toBeNull();
    expect(tracks[0]?.querySelector('table')).not.toBeNull();
    expect(tracks[0]?.textContent).toContain(text('mr1.risk.chart.critical', { score: 15 }));
    const alert = document.querySelector('tr[data-alert]') as HTMLElement;
    expect(alert.textContent).toContain(text('mr1.risk.alert.status.open'));
    expect(alert.textContent).toContain(text('mr1.risk.alerts.critical', { score: 16, threshold: 15 }));
    expect(infoButtons(alert).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('unverified-notice').length).toBeGreaterThanOrEqual(1);
  });

  it('says in words that the project is not there for the caller (404) and that a refused read is hidden (403)', async () => {
    show(open({ getProjectRiskSignals: refusal('RESOURCE_NOT_FOUND', 404) }), { id: true });
    expect((await screen.findByTestId('project-missing')).textContent).toBe(text('mr1.risk.project.missing'));
    cleanup();
    show(open({ getProjectRiskSignals: refusal('SCOPE_DENIED', 403) }), { id: true });
    expect((await screen.findByRole('alert')).textContent).toContain('Bạn chưa có quyền truy cập');
  });

  it('says there is no history to draw when there is none', async () => {
    show(open({ getProjectRiskSignals: project({ history: [], lines: [], alerts: [] }) }), { id: true });
    expect((await screen.findByTestId('no-history')).textContent).toBe(text('mr1.risk.charts.none'));
  });

  it('acknowledges an alert with a required note, under the version it saw, then reads again and says it is done', async () => {
    const h = open({ getProjectRiskSignals: project() });
    show(h, { id: true });
    fireEvent.click(await screen.findByRole('button', { name: text('mr1.risk.alerts.acknowledge') }));
    const dialog = screen.getByRole('dialog', { name: text('mr1.risk.acknowledge.title') });
    const confirm = within(dialog).getByRole('button', { name: text('mr1.risk.alerts.acknowledge') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Seen by the PMU, the milestone is being recovered' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('acknowledgeProjectRiskAlert');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ALERT_ID }, ifMatchVersion: 4, body: { note: 'Seen by the PMU, the milestone is being recovered' } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('mr1.risk.acknowledge.done'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'getProjectRiskSignals').length).toBeGreaterThanOrEqual(2));
  });

  it.each([
    ['RISK_ALERT_STATE_INVALID', 409, 'mr1.risk.refusal.alertState'],
    ['VERSION_CONFLICT', 409, 'mr1.risk.refusal.versionConflict'],
    ['SCOPE_DENIED', 403, 'mr1.risk.refusal.denied'],
    ['VALIDATION_FAILED', 422, 'mr1.risk.refusal.validation'],
  ])('says the refusal %s inside the dialog and keeps the dialog open', async (code, status, key) => {
    const h = open({ getProjectRiskSignals: project() }, () => refusal(code, status));
    show(h, { id: true });
    fireEvent.click(await screen.findByRole('button', { name: text('mr1.risk.alerts.acknowledge') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Noted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('mr1.risk.alerts.acknowledge') }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(text(key)));
    expect(screen.queryByTestId('message')).toBeNull();
  });

  it('offers no button to a reader (the server says no), to a read-only session, or for an alert that is not open', async () => {
    show(open({ getProjectRiskSignals: project({ can: { acknowledge_alert: false } }) }), { id: true });
    await screen.findByTestId('thresholds');
    expect(screen.queryByRole('button', { name: text('mr1.risk.alerts.acknowledge') })).toBeNull();
    cleanup();
    show(open({ getProjectRiskSignals: project() }), { id: true, mode: 'READ_ONLY' });
    await screen.findByTestId('thresholds');
    expect(screen.queryByRole('button', { name: text('mr1.risk.alerts.acknowledge') })).toBeNull();
    cleanup();
    show(open({ getProjectRiskSignals: project({ alerts: [alertRow({ status: 'ACKNOWLEDGED', acknowledged_at: '2026-11-08T02:00:00.000Z', acknowledge_note: 'Seen' })] }) }), { id: true });
    await screen.findByTestId('thresholds');
    expect(screen.queryByRole('button', { name: text('mr1.risk.alerts.acknowledge') })).toBeNull();
    expect(screen.getByText(text('mr1.risk.alert.status.acknowledged'))).toBeTruthy();
  });
});

describe('PRJ-28 sources', () => {
  it('use no raw colour: every colour is a token', () => {
    const folder = __dirname;
    for (const name of readdirSync(folder).filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\./.test(file))) {
      const source = readFileSync(join(folder, name), 'utf8');
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, name).not.toMatch(/\brgba?\(/);
    }
  });
});
