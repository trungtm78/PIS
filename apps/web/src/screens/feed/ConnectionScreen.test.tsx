import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import ConnectionScreen from './ConnectionScreen';
import { numberText, vietnamStamp } from './feed-model';
import { AS_OF, client, connection, health, indicator, mountScreen, policy, problem, quality, routeOf, rule, staleHealth, unusedConnection, word, world } from './test/feed-test-support';
import type { MountOptions, World } from './test/feed-test-support';

const ROUTE = routeOf('FEED-01');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  connection?: Record<string, unknown>;
  failing?: World['failing'];
  command?: (operation: string, input: unknown) => unknown;
}

function open(options: Options = {}) {
  const state = world({ connection: options.connection ?? connection(), ...(options.failing === undefined ? {} : { failing: options.failing }) });
  const h = client(state, options.command ?? (() => ({ operation_id: 'o', status: 'DISABLED', resource_version: 8 })));
  const mounted = mountScreen(<ConnectionScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const testId = (id: string): HTMLElement => screen.getByTestId(id);
const content = (id: string): string => testId(id).textContent ?? '';
const loaded = async (): Promise<void> => {
  await screen.findByTestId('status-card');
};
const infoOf = (name: string): HTMLButtonElement => screen.getAllByRole('button', { name: word('feed.common.info.open.label', { name }) })[0] as HTMLButtonElement;

describe('ConnectionScreen (FEED-01): the connection to the application of the Finance Department', () => {
  it('AC-ST-FEED-001-4 / UI-FEED-01: shows the status card with the code, the state, who switched it and why, the assumed layout and the word that no call leaves the machine', async () => {
    open();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('feed.connection.page.title'));
    expect(content('status-code')).toContain('fin.sotaichinh');
    expect(content('status-state')).toContain(word('feed.connection.status.state.enabled'));
    expect(content('status-reason')).toContain('Bắt đầu nhận số liệu thử');
    expect(content('status-changed')).toContain(word('feed.connection.status.changed.text', { name: 'Nguyễn Văn An', time: '05/11/2026 09:30' }));
    expect(content('status-layout')).toContain('WORKING-ASSUMPTION-FIN-2026.1');
    expect(content('status-layout')).toContain(word('feed.connection.status.layout.pending'));
    expect(content('status-egress')).toContain(word('feed.connection.status.egress.text'));
    expect(screen.getAllByTestId('acceptance-badge')[0]?.textContent).toContain(word('feed.common.acceptance.pending'));
  });

  it('says no word of simulation anywhere: the data generator is only the data generator and every channel is shown alike', async () => {
    open();
    await loaded();
    const page = document.body.textContent?.toLowerCase() ?? '';
    expect(page).not.toContain('mô phỏng');
    expect(page).not.toContain('simulat');
    expect(page).toContain(word('feed.common.channel.generator').toLowerCase());
  });

  it('does not call the layout an assumption once the Finance Department confirmed it', async () => {
    open({ connection: connection({ acceptance: 'ACCEPTABLE', layout_version: 'FIN-2027.1' }) });
    await loaded();
    expect(content('status-layout')).toContain(word('feed.connection.status.layout.accepted'));
    expect(content('status-layout')).not.toContain(word('feed.connection.status.layout.pending'));
    expect(screen.getAllByTestId('acceptance-badge')[0]?.getAttribute('data-acceptance')).toBe('ACCEPTABLE');
  });

  it('lists the three channels with the status of each adapter, the reason the push is missing, no call out and the last run of each', async () => {
    open();
    await loaded();
    const channels = within(screen.getByRole('region', { name: word('feed.connection.channels.caption') }));
    const rows = Array.from(document.querySelectorAll('tr[data-channel]')).filter((row) => channels.queryAllByRole('row').includes(row as HTMLElement));
    expect(rows.map((row) => row.getAttribute('data-channel'))).toEqual(['FILE', 'API_PUSH', 'GENERATOR']);
    const file = within(rows[0] as HTMLElement);
    expect(file.getByText(word('feed.connection.adapter.proposed'))).toBeTruthy();
    expect(file.getByText(word('feed.connection.channels.network.no'))).toBeTruthy();
    expect(file.getByText('07/11/2026 08:00')).toBeTruthy();
    const push = within(rows[1] as HTMLElement);
    expect(push.getByText(word('feed.connection.adapter.missing'))).toBeTruthy();
    expect(push.getByText(word('feed.connection.channel.reason.machineAccount'))).toBeTruthy();
    expect(push.getByText(word('feed.connection.channels.last.none'))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(word('feed.connection.adapter.mock'))).toBeTruthy();
  });

  it('shows how fresh the data is by the rule: the age against the lines, the last run with its channel, no alert and the totals open', async () => {
    open();
    await loaded();
    expect(content('health-status')).toContain(word('feed.connection.health.status.fresh'));
    expect(content('health-explain')).toBe(word('feed.connection.health.explain.fresh'));
    expect(content('health-age')).toContain(word('feed.connection.health.age.value', { hours: numberText(12.5, 'vi') }));
    expect(content('health-last')).toContain('07/11/2026 21:30');
    expect(content('health-last')).toContain(word('feed.common.channel.file'));
    expect(content('health-thresholds')).toContain(word('feed.connection.health.thresholds.value', { warn: '48', max: '96' }));
    expect(content('health-alert')).toContain(word('feed.connection.health.alert.none'));
    expect(content('health-figures')).toContain(word('feed.connection.health.figures.open'));
  });

  it('opens the "i" of the age: the formula, the source, the day it is as of and the version with its legal status', async () => {
    open();
    await loaded();
    fireEvent.click(infoOf(word('feed.connection.figure.age.name')));
    const panel = screen.getByRole('dialog', { name: word('feed.connection.figure.age.name') });
    const field = (name: string): string => panel.querySelector(`[data-field="${name}"] dd`)?.textContent ?? '';
    expect(field('formula')).toBe('Độ tuổi = bây giờ − lúc áp dụng lần nhận gần nhất');
    expect(field('source')).toBe('Dòng nhận gần nhất của sổ các lần nhận');
    expect(field('asOf')).toBe('08/11/2026');
    expect(field('version')).toBe(word('feed.connection.figure.age.version', { version: 0, source: word('feed.connection.figure.rule.default'), legal: word('feed.connection.figure.legal.unverified') }));
    expect(panel.querySelector('[data-field="unverified"]')?.textContent).toBe(word('feed.common.info.unverified.text'));
  });

  it('does not call the rule unverified once the unit approved its own', async () => {
    open({ connection: connection({ health: health({ rule: rule({ source: 'RULE', version: 2, unverified: false, legal_status: 'QĐ 12/2026' }), policy: policy({ source: 'RULE', version: 3, unverified: false, legal_status: 'QĐ 12/2026' }) }) }) });
    await loaded();
    expect(screen.queryByTestId('health-unverified')).toBeNull();
    fireEvent.click(infoOf(word('feed.connection.figure.age.name')));
    const panel = screen.getByRole('dialog', { name: word('feed.connection.figure.age.name') });
    expect(panel.querySelector('[data-field="version"] dd')?.textContent).toBe(word('feed.connection.figure.age.version', { version: 2, source: word('feed.connection.figure.rule.tenant'), legal: 'QĐ 12/2026' }));
    expect(panel.querySelector('[data-field="unverified"]')).toBeNull();
  });

  it('says the data is stale in words and in the action list, with the severity, and does not call it "no data"', async () => {
    open({ connection: connection({ health: staleHealth() }) });
    await loaded();
    expect(content('health-status')).toContain(word('feed.connection.health.status.stale'));
    expect(content('health-explain')).toBe(word('feed.connection.health.explain.stale'));
    expect(content('health-alert')).toContain('FEED_STALE');
    expect(content('health-alert')).toContain(word('feed.common.severity.watch'));
    expect(content('action-stale')).toContain(word('feed.connection.action.stale.text', { hours: '130', max: '96' }));
    expect(screen.getByText(word('feed.connection.page.title'))).toBeTruthy();
    // The last data is still shown, and the context bar says it is as of the last run, not of now.
    expect(document.querySelector('.ui-context')?.textContent).toContain(vietnamStamp('2026-11-02T14:30:00.000Z'));
    expect(content('record-counts')).toContain('120');
  });

  it('says when the totals are blocked by a stale feed', async () => {
    open({ connection: connection({ health: staleHealth({ figures_blocked: true }) }) });
    await loaded();
    expect(content('health-figures')).toContain(word('feed.connection.health.figures.blocked'));
  });

  it('shows the three indicators of the quality with the percent, the two numbers and the day, and opens the "i" with numerator and denominator', async () => {
    open();
    await loaded();
    expect(content('quality-period')).toBe(word('feed.connection.quality.period.text', { month: 10, year: 2026, due: '05/11/2026' }));
    expect(content('indicator-FEED_COMPLETENESS')).toContain(word('feed.connection.quality.completeness.label'));
    expect(content('indicator-FEED_COMPLETENESS')).toContain('90%');
    expect(content('indicator-FEED_COMPLETENESS-ratio')).toBe(word('feed.connection.quality.ratio.text', { numerator: '18', denominator: '20', unit: word('feed.connection.quality.units.unit') }));
    expect(content('indicator-FEED_TIMELINESS-ratio')).toBe(word('feed.connection.quality.ratio.text', { numerator: '14', denominator: '18', unit: word('feed.connection.quality.units.unit') }));
    expect(content('indicator-FEED_DISCREPANCY_RATE-ratio')).toBe(word('feed.connection.quality.ratio.text', { numerator: '3', denominator: '120', unit: word('feed.connection.quality.figures.unit') }));
    fireEvent.click(within(testId('indicator-FEED_COMPLETENESS')).getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.connection.quality.completeness.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.connection.quality.completeness.name') });
    expect(panel.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.connection.quality.completeness.formula'));
    expect(panel.querySelector('[data-field="numerator"] dd')?.textContent).toBe('18');
    expect(panel.querySelector('[data-field="denominator"] dd')?.textContent).toBe('20');
    expect(panel.querySelector('[data-field="asOf"] dd')?.textContent).toBe('08/11/2026');
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.connection.quality.completeness.source'));
  });

  it('says "not computable" for an indicator with nothing to divide, never 0%', async () => {
    open({ connection: connection({ quality: quality({ indicators: [indicator('FEED_COMPLETENESS', null, 0, 0), indicator('FEED_TIMELINESS', '100', 3, 3), indicator('FEED_DISCREPANCY_RATE', '0', 0, 12)] }) }) });
    await loaded();
    expect(content('indicator-FEED_COMPLETENESS')).toContain(word('feed.connection.quality.notComputable.text'));
    expect(content('indicator-FEED_COMPLETENESS')).not.toContain('0%');
    expect(content('indicator-FEED_DISCREPANCY_RATE')).toContain('0%');
    expect(screen.queryByTestId('quality-partial')).toBeNull();
  });

  it('says the period has nothing to count yet when no indicator can be computed (partial)', async () => {
    open({ connection: connection({ quality: quality({ indicators: [indicator('FEED_COMPLETENESS', null, 0, 0), indicator('FEED_TIMELINESS', null, 0, 0), indicator('FEED_DISCREPANCY_RATE', null, 0, 0)] }) }) });
    await loaded();
    expect(content('quality-partial')).toBe(word('feed.connection.quality.partial.text'));
  });

  it('lists the late units, or says that none is late', async () => {
    open();
    await loaded();
    const rows = Array.from(document.querySelectorAll('tr[data-investor]'));
    expect(rows.map((row) => row.getAttribute('data-investor'))).toEqual(['CDT-2', 'CDT-3']);
    expect(within(rows[0] as HTMLElement).getByText(word('feed.connection.unit.status.late'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('05/11/2026')).toBeTruthy();
    expect(content('action-late')).toContain(word('feed.connection.action.late.text', { count: 2 }));
    cleanup();
    open({ connection: connection({ quality: quality({ late_units: [] }), alerts: [] }) });
    await loaded();
    expect(content('late-empty')).toBe(word('feed.connection.late.empty.text'));
    expect(screen.queryByTestId('action-late')).toBeNull();
  });

  it('lists the open alerts with their severity and the findings with their count, and says when the list of findings is cut', async () => {
    open({ connection: connection({ quality: quality({ findings_total: 250 }) }) });
    await loaded();
    const alerts = within(testId('alerts-list'));
    expect(alerts.getByText(word('feed.connection.alert.unitLate.text', { subject: 'CDT-2' }))).toBeTruthy();
    expect(alerts.getByText(word('feed.connection.alert.discrepancy.text', { subject: 'FIN-0001|2026|DISBURSED_VS_DIS' }))).toBeTruthy();
    expect(alerts.getByText(word('feed.common.severity.action'))).toBeTruthy();
    expect(content('findings-count')).toContain(word('feed.connection.findings.count.text', { count: '250' }));
    expect(document.querySelector('tr[data-code="OVER_PLAN"]')?.textContent).toContain(word('feed.connection.finding.overPlan'));
    expect(content('findings-truncated')).toBe(word('feed.connection.findings.truncated.text', { shown: 1, total: 250 }));
  });

  it('says there is no alert and no finding when there is none', async () => {
    open({ connection: connection({ alerts: [], quality: quality({ findings: [], findings_total: 0, late_units: [] }) }) });
    await loaded();
    expect(content('alerts-empty')).toBe(word('feed.connection.alerts.empty.text'));
    expect(content('findings-count')).toContain(word('feed.connection.findings.count.text', { count: '0' }));
    expect(screen.queryByTestId('findings-truncated')).toBeNull();
    expect(content('action-large')).toContain(word('feed.connection.action.large.text', { count: 1 }));
  });

  it('counts the records by kind, the mappings by state and the open differences, each with its "i" and a link to its screen', async () => {
    open();
    await loaded();
    const records = within(testId('record-counts'));
    expect(records.getByText(word('feed.common.kind.project'))).toBeTruthy();
    expect(document.querySelector('[data-kind="DISBURSEMENT"]')?.textContent).toContain('900');
    expect(content('mapping-counts')).toBe(
      [
        `${word('feed.mapping.status.proposed')}: 2`,
        `${word('feed.mapping.status.active')}: 40`,
        `${word('feed.mapping.status.rejected')}: 1`,
        `${word('feed.mapping.status.retired')}: 0`,
      ].join(' · '),
    );
    expect(screen.getByRole('link', { name: word('feed.connection.counts.mappings.link') }).getAttribute('href')).toBe('/feed/feed-03');
    expect(screen.getByRole('link', { name: word('feed.connection.counts.differences.link') }).getAttribute('href')).toBe('/feed/feed-04');
    fireEvent.click(infoOf(word('feed.connection.figure.records.name')));
    expect(screen.getByRole('dialog', { name: word('feed.connection.figure.records.name') }).querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.connection.figure.records.source'));
  });

  it('lists the last runs of every channel alike, the channel only as a small column, and the seed of the generator beside its run', async () => {
    open();
    await loaded();
    const rows = Array.from(document.querySelectorAll('tr[data-run-id]'));
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('channel-tag').textContent).toBe(word('feed.common.channel.file'));
    expect(within(rows[0] as HTMLElement).getByText(word('feed.common.kind.disbursement'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByTestId('run-counts').textContent).toContain(word('feed.runs.counts.text', { total: '40', written: '30', skipped: '8', rejected: '2' }));
    expect(within(rows[1] as HTMLElement).getByTestId('channel-tag').textContent).toBe(word('feed.common.channel.generator'));
    expect(within(rows[1] as HTMLElement).getByTestId('seed').textContent).toBe(word('feed.runs.source.seed', { seed: 57, epoch: 2 }));
    expect(within(rows[1] as HTMLElement).getByText(word('feed.runs.action.generatorStart'))).toBeTruthy();
    expect(screen.getAllByTestId('acceptance-badge').length).toBeGreaterThan(2);
  });

  it('lists what is pending from outside and the columns of every layout', async () => {
    open();
    await loaded();
    const pending = Array.from(document.querySelectorAll('tr[data-code^="FEED_"]'));
    expect(pending).toHaveLength(7);
    expect(within(pending[0] as HTMLElement).getByText(word('feed.connection.pending.what.sample', { kind: word('feed.common.kind.project') }))).toBeTruthy();
    expect(within(document.querySelector('tr[data-code="FEED_MACHINE_ACCOUNT"]') as HTMLElement).getByText(word('feed.connection.pending.owner.integration'))).toBeTruthy();
    expect(content('layouts-version')).toBe(word('feed.connection.layouts.version.text', { version: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    expect(document.querySelectorAll('[data-testid="layout"]')).toHaveLength(4);
    expect(document.querySelector('[data-testid="layout"][data-kind="PLAN"] summary')?.textContent).toBe(word('feed.connection.layouts.summary.text', { kind: word('feed.common.kind.plan'), count: 2 }));
  });

  it('lists the positions of the four kinds of file with their last success and last error', async () => {
    open();
    await loaded();
    const plan = document.querySelector('tr[data-kind="PLAN"]') as HTMLElement;
    expect(within(plan).getByText(word('feed.connection.cursor.failed'))).toBeTruthy();
    expect(within(plan).getByText('IMPORT_SCHEMA_INVALID')).toBeTruthy();
    expect(within(document.querySelector('tr[data-kind="MILESTONE"]') as HTMLElement).getByText(word('feed.connection.cursor.never'))).toBeTruthy();
    expect(within(document.querySelector('tr[data-kind="PROJECT"]') as HTMLElement).getByText('07/11/2026 08:00')).toBeTruthy();
  });

  it('keeps the history of the switches and of the generator, with who and why', async () => {
    open();
    await loaded();
    expect(screen.getByText(word('feed.connection.history.action.enabled'))).toBeTruthy();
    expect(screen.getByText(word('feed.connection.history.action.generatorStarted'))).toBeTruthy();
    expect(screen.getByText(word('feed.connection.history.action.created'))).toBeTruthy();
    expect(screen.getByText(word('feed.connection.history.reason.none'))).toBeTruthy();
    expect(screen.getByText(word('feed.connection.history.who.none'))).toBeTruthy();
  });

  it('says that a tenant that never used the connection has not begun, and does not alarm', async () => {
    open({ connection: unusedConnection() });
    await loaded();
    expect(content('status-state')).toContain(word('feed.connection.status.state.unused'));
    expect(content('health-status')).toContain(word('feed.connection.health.status.never'));
    expect(content('health-explain')).toBe(word('feed.connection.health.explain.never'));
    expect(content('health-age')).toContain(word('feed.connection.health.age.none'));
    expect(content('health-last')).toContain(word('feed.connection.health.last.none'));
    expect(content('action-first-use')).toContain(word('feed.connection.firstUse.title'));
    expect(screen.queryByTestId('action-stale')).toBeNull();
    expect(screen.queryByTestId('status-reason')).toBeNull();
    expect(content('runs-empty')).toBe(word('feed.connection.runs.empty.text'));
    expect(content('history-empty')).toBe(word('feed.connection.history.empty.text'));
    expect(content('quality-partial')).toBe(word('feed.connection.quality.partial.text'));
  });

  it('says a connection that was switched off is off, and gives the way to switch it on', async () => {
    open({ connection: connection({ enabled: false, state_reason: 'Chờ mẫu chính thức' }) });
    await loaded();
    expect(content('status-state')).toContain(word('feed.connection.status.state.disabled'));
    expect(content('action-disabled')).toContain(word('feed.connection.action.disabled.text'));
    expect(testId('switch-button').textContent).toBe(word('feed.connection.header.enable.action'));
  });
});

describe('ConnectionScreen (FEED-01): the one command, switching the connection on or off with a reason', () => {
  const press = (): void => {
    fireEvent.click(testId('switch-button'));
  };
  const dialog = (): HTMLElement => screen.getByRole('dialog');
  const confirm = (name: string): HTMLButtonElement => within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
  const type = (text: string): void => {
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: text } });
  };

  it('asks for a reason of at least ten characters before the button is live, then sends it under the version the person saw', async () => {
    const { h } = open();
    await loaded();
    press();
    expect(within(dialog()).getByText(word('feed.connection.dialog.disable.note'))).toBeTruthy();
    expect(confirm(word('feed.connection.dialog.disable.confirm')).disabled).toBe(true);
    type('quá ngắn');
    expect(confirm(word('feed.connection.dialog.disable.confirm')).disabled).toBe(true);
    type('  Chờ mẫu tệp chính thức của Sở  ');
    expect(confirm(word('feed.connection.dialog.disable.confirm')).disabled).toBe(false);
    fireEvent.click(confirm(word('feed.connection.dialog.disable.confirm')));
    await screen.findByTestId('switch-receipt');
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('setFinanceFeedConnectionState');
    expect(input.body).toEqual({ enabled: false, reason: 'Chờ mẫu tệp chính thức của Sở' });
    expect(input.ifMatchVersion).toBe(7);
    expect(content('switch-receipt')).toContain('fin.sotaichinh');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads the connection again after the switch', async () => {
    const { h, state } = open();
    await loaded();
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getFinanceFeedConnection').length;
    state.connection = connection({ enabled: false, version: 8, state_reason: 'Chờ mẫu tệp chính thức của Sở' });
    press();
    type('Chờ mẫu tệp chính thức của Sở');
    fireEvent.click(confirm(word('feed.connection.dialog.disable.confirm')));
    await waitFor(() => expect(content('status-state')).toContain(word('feed.connection.status.state.disabled')));
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getFinanceFeedConnection').length).toBeGreaterThan(before);
    expect(testId('switch-button').textContent).toBe(word('feed.connection.header.enable.action'));
  });

  it('switches it on with a reason when it is off', async () => {
    const { h } = open({ connection: connection({ enabled: false }), command: () => ({ operation_id: 'o', status: 'ENABLED', resource_version: 8 }) });
    await loaded();
    press();
    expect(within(dialog()).getByText(word('feed.connection.dialog.enable.note'))).toBeTruthy();
    type('Mẫu tệp đã có, bắt đầu nhận số liệu');
    fireEvent.click(confirm(word('feed.connection.dialog.enable.confirm')));
    await screen.findByTestId('switch-receipt');
    expect((h.command.mock.calls[0] as [string, { body: { enabled: boolean } }])[1].body.enabled).toBe(true);
    expect(content('switch-receipt')).toBe(word('feed.connection.success.enabled.text', { code: 'fin.sotaichinh', time: content('switch-receipt').match(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)?.[0] ?? '' }));
  });

  it('sends once when the button is pressed twice', async () => {
    const { h } = open();
    await loaded();
    press();
    type('Chờ mẫu tệp chính thức của Sở');
    const button = confirm(word('feed.connection.dialog.disable.confirm'));
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByTestId('switch-receipt');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('says in the dialog that the version moved, and offers the reload', async () => {
    const { h } = open({
      command: () => problem('VERSION_CONFLICT', 409),
    });
    await loaded();
    press();
    type('Chờ mẫu tệp chính thức của Sở');
    fireEvent.click(confirm(word('feed.connection.dialog.disable.confirm')));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(word('feed.common.problem.versionConflict'));
    const before = h.read.mock.calls.length;
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.common.problem.reload.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByTestId('switch-receipt')).toBeNull();
  });

  it('says in the dialog why a refusal of the server happened and keeps the dialog open', async () => {
    open({ command: () => problem('VALIDATION_FAILED', 422, 'reason') });
    await loaded();
    press();
    type('Chờ mẫu tệp chính thức của Sở');
    fireEvent.click(confirm(word('feed.connection.dialog.disable.confirm')));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(word('feed.common.problem.validation', { field: 'reason' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('cancels with Escape and sends nothing', async () => {
    const { h } = open();
    await loaded();
    press();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('offers no button in a read-only workspace and says why', async () => {
    open({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('switch-button')).toBeNull();
    expect(content('readonly-note')).toBe(word('feed.common.readonly.mode'));
  });

  it('offers no button to a person who was not given the command and says why', async () => {
    open({ connection: connection({}, { set_state: false }) });
    await loaded();
    expect(screen.queryByTestId('switch-button')).toBeNull();
    expect(content('readonly-note')).toBe(word('feed.common.readonly.right'));
  });
});

describe('ConnectionScreen (FEED-01): the states of the screen', () => {
  it('shows a loading card and no number while the connection loads', () => {
    const state = world();
    state.hanging.add('getFinanceFeedConnection');
    mountScreen(<ConnectionScreen route={ROUTE} />, client(state));
    expect(screen.getByRole('status', { name: word('states.loading.label') }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('status-card')).toBeNull();
    expect(screen.queryByTestId('switch-button')).toBeNull();
  });

  it('shows an error with a new try when the read fails, and then the connection when it works', async () => {
    const failing = new Map([['getFinanceFeedConnection', new Error('down')]]);
    const { state } = open({ failing });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    expect(screen.queryByTestId('status-card')).toBeNull();
    state.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await loaded();
  });

  it('shows the forbidden card for a 403, with no button to retry that would help', async () => {
    open({ failing: new Map([['getFinanceFeedConnection', problem('SCOPE_DENIED', 403)]]) });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(screen.queryByTestId('status-card')).toBeNull();
  });

  it('says the session lapsed for SESSION_EXPIRED', async () => {
    open({ failing: new Map([['getFinanceFeedConnection', problem('SESSION_EXPIRED', 401)]]) });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.signedOut.title'));
  });

  it('treats an answer of the wrong shape as an error, never as an empty screen', async () => {
    open({ connection: { connector_code: 'fin.sotaichinh' } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    expect(screen.queryByTestId('action-none')).toBeNull();
  });

  it('keeps the last figures and says the refresh failed (stale), with the moment they are as of', async () => {
    const { queries, state } = open();
    await loaded();
    state.failing.set('getFinanceFeedConnection', new Error('down'));
    await act(async () => {
      await queries.invalidateQueries();
    });
    const note = await screen.findByTestId('stale');
    expect(note.textContent).toContain(word('feed.common.state.stale.text', { time: vietnamStamp(AS_OF) }));
    expect(content('status-code')).toContain('fin.sotaichinh');
    expect(document.querySelector('.ui-context')?.textContent).toContain(word('ui.contextBar.staleAsOf', { time: vietnamStamp(AS_OF) }));
    state.failing.clear();
    fireEvent.click(within(note).getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(screen.queryByTestId('stale')).toBeNull());
  });

  it('shows the figures in English when the language is English, with the same structure', async () => {
    translator.setLocale('en');
    open();
    await screen.findByTestId('status-card');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Data connection to the application of the Finance Department');
    expect(content('status-layout')).toContain('Layout is an assumption (PENDING-EXTERNAL)');
    expect(screen.getByRole('heading', { level: 2, name: 'Freshness of the data' })).toBeTruthy();
  });
});
