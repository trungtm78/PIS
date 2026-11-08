import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import GeneratorScreen from './GeneratorScreen';
import { vietnamStamp } from './feed-model';
import { AS_OF, GENERATOR_PARAMS, client, connection, generatorRun, mountScreen, problem, routeOf, word, world } from './test/feed-test-support';
import type { MountOptions, World } from './test/feed-test-support';

const ROUTE = routeOf('FEED-05');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const RUNNING = { state: 'RUNNING', epoch: 2, parameters: GENERATOR_PARAMS };
const STOPPED = { state: 'STOPPED', epoch: 2, parameters: GENERATOR_PARAMS };
const RECEIPT = { operation_id: 'o', status: 'RUNNING', resource_version: 8, resource_id: 'c', generator: { state: 'RUNNING', epoch: 3, current_month: 11, seed: 57 }, run: { id: 'r', records_written: 600, records_skipped: 4 }, mappings_proposed: 5 };

interface Options extends MountOptions {
  generator?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(options: Options = {}) {
  const base = connection({ generator: options.generator ?? STOPPED, ...(options.connection ?? {}) }, options.actions ?? {});
  const state = world({ connection: base, runs: [generatorRun(2), generatorRun(3, { action: 'GENERATOR_TICK', seed: 57, epoch: 2 })], ...(options.world ?? {}) });
  const h = client(state, options.command ?? (() => RECEIPT));
  const mounted = mountScreen(<GeneratorScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('generator-state');
};
const testId = (id: string): HTMLElement => screen.getByTestId(id);
const content = (id: string): string => testId(id).textContent ?? '';
const move = (name: string): HTMLButtonElement => testId(`action-${name}`) as HTMLButtonElement;
const dialog = (): HTMLElement => screen.getByRole('dialog');
const reason = (text: string): void => {
  fireEvent.change(within(dialog()).getByRole('textbox', { name: /Lý do/ }), { target: { value: text } });
};
const input = (labelKey: string): HTMLInputElement => screen.getByLabelText(word(labelKey)) as HTMLInputElement;

describe('GeneratorScreen (FEED-05): the state of the data generator', () => {
  it('AC-ST-FEED-001-8 / UI-FEED-05: shows the state, the epoch, the month reached, the seed and every parameter, each with its "i"', async () => {
    open({ generator: RUNNING });
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('feed.generator.page.title'));
    expect(content('generator-running')).toContain(word('feed.generator.state.running'));
    expect(content('generator-epoch')).toContain('2');
    expect(content('generator-month')).toContain(word('feed.generator.month.value', { month: 10, year: 2026 }));
    expect(content('generator-seed')).toContain('57');
    expect(content('generator-projects')).toContain('120');
    expect(content('generator-late')).toContain('3');
    expect(content('generator-delayed')).toContain('22%');
    expect(content('generator-ahead')).toContain('12%');
    expect(content('generator-discrepancies')).toContain('6');
    expect(content('generator-anchors')).toContain('0');
    expect(within(testId('generator-state')).getAllByRole('button', { name: /Công thức và nguồn/ }).length).toBe(9);
  });

  it('says no word of simulation', async () => {
    open({ generator: RUNNING });
    await loaded();
    expect(document.body.textContent?.toLowerCase()).not.toContain('mô phỏng');
    expect(document.body.textContent).toContain(word('feed.common.channel.generator'));
  });

  it('opens the "i" of the month reached with its formula, source, moment and the epoch as version', async () => {
    open({ generator: RUNNING });
    await loaded();
    fireEvent.click(within(testId('generator-month')).getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.generator.month.label') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.generator.month.label') });
    expect(panel.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.generator.figure.month.formula'));
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.generator.figure.source'));
    expect(panel.querySelector('[data-field="asOf"] dd')?.textContent).toBe(vietnamStamp(AS_OF));
    expect(panel.querySelector('[data-field="version"] dd')?.textContent).toBe(word('feed.generator.figure.version', { epoch: 2 }));
  });

  it('says a generator that never started has no parameters, and shows dashes, not zeros', async () => {
    open({ generator: { state: 'STOPPED', epoch: 0, parameters: null } });
    await loaded();
    expect(content('generator-running')).toContain(word('feed.generator.state.stopped'));
    expect(content('generator-running')).toContain(word('feed.generator.state.never'));
    expect(content('generator-month')).toContain('–');
    expect(content('generator-seed')).toContain('–');
  });

  it('lists the runs the generator made and the moves in the history, with who and why', async () => {
    open({ generator: RUNNING });
    await loaded();
    await waitFor(() => expect(document.querySelectorAll('tr[data-run-id]')).toHaveLength(2));
    const rows = Array.from(document.querySelectorAll('tr[data-run-id]')) as HTMLElement[];
    expect(within(rows[0] as HTMLElement).getByTestId('seed').textContent).toBe(word('feed.runs.source.seed', { seed: 57, epoch: 2 }));
    expect(within(rows[1] as HTMLElement).getByText(word('feed.runs.action.generatorTick'))).toBeTruthy();
    expect(screen.getByText(word('feed.connection.history.action.generatorStarted'))).toBeTruthy();
    expect(screen.getByText('Khởi động để kiểm tra luồng')).toBeTruthy();
    expect(screen.queryByText(word('feed.connection.history.action.enabled'))).toBeNull();
  });

  it('says there is no run and no move yet', async () => {
    open({ world: { runs: [] }, connection: { history: [] } });
    await loaded();
    expect((await screen.findByTestId('produced-empty')).textContent).toBe(word('feed.generator.produced.empty.text'));
    expect(content('moves-empty')).toBe(word('feed.generator.moves.empty.text'));
  });

  it('says in the state card that the connection is off', async () => {
    open({ connection: { enabled: false } });
    await loaded();
    expect(content('generator-connection-off')).toBe(word('feed.generator.connectionOff.text'));
  });
});

describe('GeneratorScreen (FEED-05): which move is open', () => {
  it('offers stop, reseed and tick while it runs, and says why start is closed', async () => {
    open({ generator: RUNNING });
    await loaded();
    expect(move('start').disabled).toBe(true);
    expect(move('stop').disabled).toBe(false);
    expect(move('reseed').disabled).toBe(false);
    expect(move('tick').disabled).toBe(false);
    expect(content('why-start')).toBe(word('feed.generator.block.line', { action: word('feed.generator.action.start'), why: word('feed.generator.block.running') }));
    expect(move('start').getAttribute('aria-describedby')).toBe('feed-generator-why-START');
  });

  it('offers start and reseed when it is stopped, and says why stop and tick are closed', async () => {
    open({ generator: STOPPED });
    await loaded();
    expect(move('start').disabled).toBe(false);
    expect(move('reseed').disabled).toBe(false);
    expect(move('stop').disabled).toBe(true);
    expect(move('tick').disabled).toBe(true);
    expect(testId('why-stop').getAttribute('data-reason')).toBe('stopped');
    expect(testId('why-tick').getAttribute('data-reason')).toBe('stopped');
  });

  it('says a generator that never started cannot tick', async () => {
    open({ generator: { state: 'STOPPED', epoch: 0, parameters: null } });
    await loaded();
    expect(testId('why-tick').getAttribute('data-reason')).toBe('neverStarted');
  });

  it('says a year that ran to December cannot tick', async () => {
    open({ generator: { ...RUNNING, parameters: { ...GENERATOR_PARAMS, current_month: 12 } } });
    await loaded();
    expect(move('tick').disabled).toBe(true);
    expect(testId('why-tick').getAttribute('data-reason')).toBe('yearComplete');
  });

  it('closes start, reseed and tick when the connection is off, and says so', async () => {
    open({ generator: RUNNING, connection: { enabled: false } });
    await loaded();
    for (const name of ['start', 'reseed', 'tick']) expect(move(name).disabled).toBe(true);
    expect(testId('why-reseed').getAttribute('data-reason')).toBe('connection');
    expect(move('stop').disabled).toBe(false);
  });

  it('closes every move and every field for a person without the right, and in a read-only workspace', async () => {
    open({ generator: RUNNING, actions: { control_generator: false } });
    await loaded();
    for (const name of ['start', 'stop', 'reseed', 'tick']) expect(move(name).disabled).toBe(true);
    expect(input('feed.generator.field.seed.label').disabled).toBe(true);
    expect(content('readonly-note')).toBe(word('feed.common.readonly.right'));
    expect(screen.queryByTestId('why-start')).toBeNull();
    cleanup();
    open({ generator: RUNNING, mode: 'READ_ONLY' });
    await loaded();
    expect(move('stop').disabled).toBe(true);
    expect(content('readonly-note')).toBe(word('feed.common.readonly.mode'));
  });
});

describe('GeneratorScreen (FEED-05): the moves', () => {
  it('opens the form on the stored parameters', async () => {
    open({ generator: STOPPED });
    await loaded();
    expect(input('feed.generator.field.seed.label').value).toBe('57');
    expect(input('feed.generator.field.fiscalYear.label').value).toBe('2026');
    expect(input('feed.generator.field.currentMonth.label').value).toBe('10');
    expect(input('feed.generator.field.projectCount.label').value).toBe('120');
    expect(input('feed.generator.field.delayedPct.label').value).toBe('22');
  });

  it('starts with a reason, sends the parameters of the form under the version the person saw, and says what was done', async () => {
    const { h } = open({ generator: { state: 'STOPPED', epoch: 0, parameters: null } });
    await loaded();
    fireEvent.change(input('feed.generator.field.seed.label'), { target: { value: '99' } });
    fireEvent.change(input('feed.generator.field.projectCount.label'), { target: { value: '200' } });
    fireEvent.click(move('start'));
    expect(within(dialog()).getByTestId('generator-effect').textContent).toBe(word('feed.generator.effect.start'));
    expect(within(dialog()).getByText(word('feed.generator.dialog.state.change', { from: word('feed.generator.state.stopped'), to: word('feed.generator.state.running') }))).toBeTruthy();
    expect(within(dialog()).getByText(word('feed.generator.dialog.epoch.raised', { from: 0, to: 1 }))).toBeTruthy();
    const confirm = within(dialog()).getByRole('button', { name: word('feed.generator.action.start') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    reason('Khởi động để kiểm tra luồng');
    fireEvent.click(confirm);
    const receipt = await screen.findByTestId('generator-receipt');
    expect(receipt.textContent).toContain(word('feed.generator.receipt.text', { action: word('feed.generator.action.start') }));
    expect(content('generator-receipt-facts')).toBe(word('feed.generator.receipt.facts', { state: word('feed.generator.state.running'), epoch: '3', month: 11, written: '600', skipped: '4', mappings: '5' }));
    const [operation, call] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('controlFinanceFeedGenerator');
    expect(call.ifMatchVersion).toBe(7);
    expect(call.body).toMatchObject({ action: 'START', reason: 'Khởi động để kiểm tra luồng', seed: 99, project_count: 200, late_units: 3 });
    expect(call.body).not.toHaveProperty('fiscal_year');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads the connection again after a move', async () => {
    const { h, state } = open({ generator: STOPPED });
    await loaded();
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getFinanceFeedConnection').length;
    state.connection = connection({ generator: RUNNING, version: 8 });
    fireEvent.click(move('start'));
    reason('Khởi động lại để thử tiếp');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.generator.action.start') }));
    await waitFor(() => expect(content('generator-running')).toContain(word('feed.generator.state.running')));
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getFinanceFeedConnection').length).toBeGreaterThan(before);
  });

  it('stops with a reason and no parameters', async () => {
    const { h } = open({ generator: RUNNING, command: () => ({ ...RECEIPT, generator: { state: 'STOPPED', epoch: 2, current_month: 10, seed: 57 }, run: null, mappings_proposed: 0 }) });
    await loaded();
    fireEvent.click(move('stop'));
    expect(within(dialog()).getByTestId('generator-effect').textContent).toBe(word('feed.generator.effect.stop'));
    reason('Xong việc kiểm tra tháng này');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.generator.action.stop') }));
    await screen.findByTestId('generator-receipt');
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ action: 'STOP', reason: 'Xong việc kiểm tra tháng này' });
    expect(content('generator-receipt-facts')).toContain('–');
  });

  it('ticks one month with a reason and no parameters', async () => {
    const { h } = open({ generator: RUNNING });
    await loaded();
    fireEvent.click(move('tick'));
    expect(within(dialog()).getByTestId('generator-effect').textContent).toBe(word('feed.generator.effect.tick'));
    reason('Đi tiếp sang tháng sau');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.generator.action.tick') }));
    await screen.findByTestId('generator-receipt');
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ action: 'TICK', reason: 'Đi tiếp sang tháng sau' });
  });

  it('reseeds with a new seed and says the epoch is raised', async () => {
    const { h } = open({ generator: RUNNING });
    await loaded();
    fireEvent.change(input('feed.generator.field.seed.label'), { target: { value: '7' } });
    fireEvent.click(move('reseed'));
    expect(within(dialog()).getByText(word('feed.generator.dialog.epoch.raised', { from: 2, to: 3 }))).toBeTruthy();
    expect(within(dialog()).getByText(word('feed.generator.dialog.state.label'))).toBeTruthy();
    reason('Thử hạt giống khác để so sánh');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.generator.action.reseed') }));
    await screen.findByTestId('generator-receipt');
    const body = (h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(body).toMatchObject({ action: 'RESEED', seed: 7, project_count: 120 });
    expect(body).not.toHaveProperty('fiscal_year');
  });

  it('checks the numbers in place before the dialog opens: the limits, the whole numbers, the share, the seed of a reseed', async () => {
    const { h } = open({ generator: STOPPED });
    await loaded();
    fireEvent.change(input('feed.generator.field.projectCount.label'), { target: { value: '5' } });
    fireEvent.change(input('feed.generator.field.lateUnits.label'), { target: { value: 'abc' } });
    fireEvent.click(move('start'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(testId('error-projectCount').textContent).toBe(word('feed.generator.issue.range', { min: 10, max: 1000 }));
    expect(testId('error-lateUnits').textContent).toBe(word('feed.generator.issue.integer'));
    fireEvent.change(input('feed.generator.field.projectCount.label'), { target: { value: '100' } });
    fireEvent.change(input('feed.generator.field.lateUnits.label'), { target: { value: '3' } });
    fireEvent.change(input('feed.generator.field.delayedPct.label'), { target: { value: '80' } });
    fireEvent.change(input('feed.generator.field.aheadPct.label'), { target: { value: '30' } });
    fireEvent.click(move('start'));
    expect(testId('error-aheadPct').textContent).toBe(word('feed.generator.issue.share'));
    fireEvent.change(input('feed.generator.field.delayedPct.label'), { target: { value: '22' } });
    fireEvent.change(input('feed.generator.field.aheadPct.label'), { target: { value: '12' } });
    fireEvent.change(input('feed.generator.field.seed.label'), { target: { value: '' } });
    fireEvent.click(move('reseed'));
    expect(testId('error-seed').textContent).toBe(word('feed.generator.issue.required'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('needs a reason of ten characters before the move is live, and cancels with nothing sent', async () => {
    const { h } = open({ generator: RUNNING });
    await loaded();
    fireEvent.click(move('stop'));
    reason('ngắn');
    expect((within(dialog()).getByRole('button', { name: word('feed.generator.action.stop') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.common.dialog.cancel.action') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends once when the move is pressed twice', async () => {
    const { h } = open({ generator: RUNNING });
    await loaded();
    fireEvent.click(move('tick'));
    reason('Đi tiếp sang tháng sau');
    const button = within(dialog()).getByRole('button', { name: word('feed.generator.action.tick') });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByTestId('generator-receipt');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['FEED_GENERATOR_STATE_INVALID', 409, 'connection', word('feed.generator.refusal.connection')],
    ['FEED_GENERATOR_STATE_INVALID', 409, 'year_complete', word('feed.generator.refusal.yearComplete')],
    ['FEED_GENERATOR_STATE_INVALID', 409, 'state', word('feed.generator.refusal.state')],
    ['VALIDATION_FAILED', 422, 'seed', word('feed.common.problem.validation', { field: 'seed' })],
    ['VERSION_CONFLICT', 409, undefined, word('feed.common.problem.versionConflict')],
    ['SCOPE_DENIED', 403, undefined, word('feed.common.problem.scopeDenied')],
  ])('says in the dialog why the server refused: %s %s', async (code, status, detail, expected) => {
    open({ generator: RUNNING, command: () => problem(code, status, detail) });
    await loaded();
    fireEvent.click(move('tick'));
    reason('Đi tiếp sang tháng sau');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.generator.action.tick') }));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(expected);
    expect(screen.queryByTestId('generator-receipt')).toBeNull();
  });
});

describe('GeneratorScreen (FEED-05): the states', () => {
  it('shows a loading card and no number while the connection loads', () => {
    const state = world();
    state.hanging.add('getFinanceFeedConnection');
    mountScreen(<GeneratorScreen route={ROUTE} />, client(state));
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    expect(screen.queryByTestId('generator-state')).toBeNull();
  });

  it('shows an error with a new try, the forbidden card for a 403 and the lapsed session', async () => {
    const first = open({ world: { failing: new Map([['getFinanceFeedConnection', new Error('down')]]) } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    first.state.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await loaded();
    cleanup();
    open({ world: { failing: new Map([['getFinanceFeedConnection', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    cleanup();
    open({ world: { failing: new Map([['getFinanceFeedConnection', problem('SESSION_EXPIRED', 401)]]) } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.signedOut.title'));
  });

  it('keeps the state and says the refresh failed (stale)', async () => {
    const { queries, state } = open({ generator: RUNNING });
    await loaded();
    state.failing.set('getFinanceFeedConnection', new Error('down'));
    await act(async () => {
      await queries.invalidateQueries({ predicate: (query) => query.queryKey.includes('connection') });
    });
    expect((await screen.findByTestId('stale')).textContent).toContain(word('feed.common.state.stale.text', { time: vietnamStamp(AS_OF) }));
    expect(content('generator-running')).toContain(word('feed.generator.state.running'));
  });

  it('says the list of produced runs could not be read without hiding the state, and that it may not be seen', async () => {
    const { state } = open({ generator: RUNNING });
    state.failing.set('listFinanceFeedRuns', new Error('down'));
    await loaded();
    expect((await screen.findByTestId('error')).textContent).toContain(word('feed.common.state.error.title'));
    cleanup();
    open({ generator: RUNNING, world: { failing: new Map([['listFinanceFeedRuns', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByTestId('denied')).textContent).toContain(word('feed.common.state.denied.title'));
    expect(content('generator-running')).toContain(word('feed.generator.state.running'));
  });
});
