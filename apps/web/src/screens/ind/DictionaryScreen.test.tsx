import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DictionaryScreen from './DictionaryScreen';
import { ADMIN, INDICATORS, PERIOD, PROJECT, READER, byOperation, client, detailOf, figure, mountScreen, problem, routeOf, version, violation, word, world } from './test/ind-test-support';
import type { MountOptions, World } from './test/ind-test-support';

const ROUTE = routeOf('IND-01', 'FR-IND-01');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(options: Options = {}) {
  const state = world(options.world);
  const h = client(state, options.command ?? byOperation({}));
  const mounted = mountScreen(<DictionaryScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const codes = (): string[] => Array.from(document.querySelectorAll('[data-testid="dictionary-table"] tbody tr[data-code]')).map((row) => row.getAttribute('data-code') ?? '');
const ready = async (): Promise<void> => {
  await screen.findByTestId('dictionary-table');
};
const select = async (code: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: word('ind.dict.select.label', { code }) }));
  await screen.findByTestId('indicator-detail');
  await screen.findByTestId('indicator-facts');
};

describe('DictionaryScreen (IND-01): the list', () => {
  it('UI-IND-01: names the screen and lists every indicator with its unit, how it is obtained, its version and whether the definition is the starting value nobody confirmed', async () => {
    open();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('ind.dict.page.title'));
    expect(codes()).toEqual(['TOTAL_INVESTMENT', 'CUMULATIVE_YTD', 'RATE_YEAR_IN_FORCE']);
    const row = (code: string): HTMLElement => document.querySelector(`[data-testid="dictionary-table"] tr[data-code="${code}"]`) as HTMLElement;
    expect(within(row('TOTAL_INVESTMENT')).getByText(word('ind.origin.defaultUnverified.label'))).toBeTruthy();
    expect(within(row('TOTAL_INVESTMENT')).getByText(word('ind.dict.column.versionDefault'))).toBeTruthy();
    expect(within(row('CUMULATIVE_YTD')).getByText(word('ind.origin.rule.label'))).toBeTruthy();
    expect(within(row('CUMULATIVE_YTD')).getByText('v2')).toBeTruthy();
    expect(within(row('RATE_YEAR_IN_FORCE')).getByText(word('ind.valueKind.derived.label'))).toBeTruthy();
    expect(within(row('TOTAL_INVESTMENT')).getByText(word('ind.unit.vnd.label'))).toBeTruthy();
    expect(row('TOTAL_INVESTMENT').getAttribute('data-origin')).toBe('DEFAULT');
  });

  it('says it is loading while the dictionary is read, and shows no table', async () => {
    open({ world: { hanging: new Set(['listIndicators']) } });
    expect((await screen.findByTestId('dictionary-loading')).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('dictionary-table')).toBeNull();
  });

  it('says in words that it could not be read, and reads again when asked', async () => {
    const { state, h } = open({ world: { failing: new Map([['listIndicators', new Error('down')]]) } });
    expect((await screen.findByTestId('dictionary-error')).textContent).toContain(word('ind.dict.state.error'));
    state.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await ready();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listIndicators').length).toBeGreaterThanOrEqual(2);
  });

  it('says it is not allowed for a refusal and shows no table', async () => {
    open({ world: { failing: new Map([['listIndicators', problem('FORBIDDEN', 403)]]) } });
    expect((await screen.findByTestId('dictionary-denied')).textContent).toBe(word('ind.dict.state.denied'));
    expect(screen.queryByTestId('dictionary-table')).toBeNull();
  });

  it('says the dictionary is empty, and that no indicator matches when a filter is set, with a way to clear it', async () => {
    const empty = open({ world: { indicators: [] } });
    expect((await screen.findByTestId('dictionary-empty')).textContent).toBe(word('ind.dict.state.empty'));
    empty.unmount();
    cleanup();
    open();
    await ready();
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.q')), { target: { value: 'nothing like this' } });
    expect((await screen.findByTestId('dictionary-empty')).textContent).toContain(word('ind.dict.state.emptyFiltered'));
    fireEvent.click(screen.getByRole('button', { name: word('ind.dict.filter.clear') }));
    await ready();
    expect(codes()).toHaveLength(3);
  });

  it('asks the server to filter by category, by how the figure is obtained, by entry and by words', async () => {
    const { h } = open();
    await ready();
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.category')), { target: { value: 'RATE' } });
    await waitFor(() => expect(codes()).toEqual(['RATE_YEAR_IN_FORCE']));
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.category')), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(word('ind.dict.filter.enterable')));
    await waitFor(() => expect(codes()).toEqual(['TOTAL_INVESTMENT', 'CUMULATIVE_YTD']));
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.kind')), { target: { value: 'DERIVED' } });
    await screen.findByTestId('dictionary-empty');
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.kind')), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(word('ind.dict.filter.enterable')));
    fireEvent.change(screen.getByLabelText(word('ind.dict.filter.q')), { target: { value: 'cumulative' } });
    await waitFor(() => expect(codes()).toEqual(['CUMULATIVE_YTD']));
    const asked = h.read.mock.calls.filter(([operation]) => operation === 'listIndicators').map(([, input]) => (input as { query: Record<string, unknown> }).query);
    expect(asked).toContainEqual(expect.objectContaining({ category: 'RATE' }));
    expect(asked).toContainEqual(expect.objectContaining({ enterable: 'true' }));
    expect(asked).toContainEqual(expect.objectContaining({ q: 'cumulative' }));
  });

  it('shows what must be settled before a form can be mapped, and nothing when there is nothing', async () => {
    open({ world: { findings: [{ code: 'ALIAS_SHARED', indicators: ['A_CODE', 'B_CODE'], detail: 'tiến độ' }] } });
    const banner = await screen.findByTestId('dictionary-findings');
    expect(within(banner).getByText(`${word('ind.finding.aliasShared.label', { detail: 'tiến độ' })} (A_CODE, B_CODE)`)).toBeTruthy();
    cleanup();
    open();
    await ready();
    expect(screen.queryByTestId('dictionary-findings')).toBeNull();
  });

  it('points to the governance rules for changing a definition', async () => {
    open();
    await ready();
    const note = screen.getByTestId('governance-note');
    expect(within(note).getByRole('link', { name: word('ind.common.governance.link') }).getAttribute('href')).toBe('/adm/adm-19');
  });
});

describe('DictionaryScreen (IND-01): one indicator', () => {
  it('shows the definition, says the starting value was not confirmed, tells where it is used and lists its versions with who made and who approved each', async () => {
    open();
    await ready();
    await select('TOTAL_INVESTMENT');
    const facts = screen.getByTestId('indicator-facts');
    expect(within(facts).getByText('Formula of TOTAL_INVESTMENT')).toBeTruthy();
    expect(within(facts).getByText('Alias of TOTAL_INVESTMENT')).toBeTruthy();
    expect(within(facts).getByText(word('ind.dict.detail.versionDefault'))).toBeTruthy();
    expect(screen.getByTestId('detail-unverified').textContent).toBe(word('ind.dict.detail.unverified'));
    const usage = screen.getByTestId('indicator-usage');
    expect(within(usage).getByText(/EQUITY_PLUS_DEBT_EQUALS_TOTAL/).textContent).toContain(word('ind.dict.usage.template'));
    expect(within(usage).getByText(/MONTHLY_FORM/).textContent).toContain(word('ind.dict.usage.active'));
    const versions = screen.getByTestId('versions-table');
    const rows = Array.from(versions.querySelectorAll('tbody tr[data-version]')).map((row) => [row.getAttribute('data-version'), row.getAttribute('data-status'), row.textContent ?? '']);
    expect(rows.map(([n, status]) => [n, status])).toEqual([['2', 'APPROVED'], ['1', 'RETIRED']]);
    expect(rows[0]?.[2]).toContain('Nguyễn Văn An');
    expect(rows[0]?.[2]).toContain('Trần Thị Bình');
    expect(rows[0]?.[2]).toContain('Lê Văn Cường');
    expect(within(screen.getByTestId('indicator-detail')).getByText(word('ind.common.governance.link'))).toBeTruthy();
  });

  it('does not call an approved version a starting value, and says a derived indicator cannot be entered', async () => {
    open();
    await ready();
    await select('CUMULATIVE_YTD');
    expect(screen.queryByTestId('detail-unverified')).toBeNull();
    expect(screen.getByTestId('indicator-detail').querySelector('[data-origin="RULE"]')).not.toBeNull();
    await select('RATE_YEAR_IN_FORCE');
    expect(screen.getByTestId('detail-derived-note').textContent).toBe(word('ind.dict.detail.derivedNote'));
    expect(screen.queryByRole('button', { name: word('ind.dict.detail.enter') })).toBeNull();
    expect(screen.getByTestId('versions-empty').textContent).toBe(word('ind.versions.empty.note'));
  });

  it('says in words when the detail cannot be read and closes on request', async () => {
    const { state } = open();
    await ready();
    state.failing.set('getIndicator', new Error('down'));
    fireEvent.click(await screen.findByRole('button', { name: word('ind.dict.select.label', { code: 'TOTAL_INVESTMENT' }) }));
    expect((await screen.findByTestId('detail-error')).textContent).toContain(word('ind.dict.detail.error'));
    state.failing.set('getIndicator', problem('FORBIDDEN', 403));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect((await screen.findByTestId('detail-denied')).textContent).toBe(word('ind.dict.detail.denied'));
    fireEvent.click(screen.getByRole('button', { name: word('ind.dict.detail.close') }));
    expect(screen.queryByTestId('indicator-detail')).toBeNull();
  });
});

describe('DictionaryScreen (IND-01): the figures typed by hand', () => {
  const nameProject = (): void => {
    fireEvent.change(screen.getByLabelText(word('ind.fig.project.label')), { target: { value: PROJECT } });
    fireEvent.change(screen.getByLabelText(word('ind.fig.period.label')), { target: { value: PERIOD } });
  };
  const load = async (): Promise<void> => {
    await ready();
    nameProject();
    fireEvent.click(screen.getByRole('button', { name: word('ind.fig.load.action') }));
    await waitFor(() => expect(screen.queryByTestId('figures-loading')).toBeNull());
  };
  const fill = async (code: string, value: string, index = 0): Promise<void> => {
    const lines = screen.getAllByTestId('entry-line');
    fireEvent.change(within(lines[index] as HTMLElement).getByLabelText(word('ind.fig.line.indicator')), { target: { value: code } });
    fireEvent.change(within(lines[index] as HTMLElement).getByLabelText(word('ind.fig.line.value')), { target: { value } });
  };
  const save = (): void => {
    fireEvent.click(screen.getByRole('button', { name: word('ind.fig.entry.action') }));
  };

  it('asks for ids in UUID form, holds the load until both are valid, and says there is no figure yet', async () => {
    open();
    await ready();
    const load = screen.getByRole('button', { name: word('ind.fig.load.action') }) as HTMLButtonElement;
    expect(load.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('ind.fig.project.label')), { target: { value: 'not an id' } });
    expect(screen.getByTestId('project-invalid').textContent).toBe(word('ind.fig.project.invalid'));
    nameProject();
    expect(load.disabled).toBe(false);
    fireEvent.click(load);
    expect((await screen.findByTestId('figures-empty')).textContent).toBe(word('ind.fig.state.empty'));
  });

  it('lists the figures in force with their source and shows every revision of one', async () => {
    const imported = figure(2, { indicator_code: 'CUMULATIVE_YTD', source: 'IMPORT', mapping_code: 'MONTHLY_FORM', mapping_version: 1, import_line: 4, value: '250' });
    open({ world: { figures: [figure(1, { revision: 2, reason: 'The plan was adjusted' }), imported], history: [figure(1, { revision: 2 }), figure(3, { revision: 1 })] } });
    await load();
    const table = await screen.findByTestId('figures-table');
    const rows = Array.from(table.querySelectorAll('tbody tr[data-indicator]')).map((row) => [row.getAttribute('data-indicator'), row.getAttribute('data-revision'), row.textContent ?? '']);
    expect(rows.map(([code, revision]) => [code, revision])).toEqual([['TOTAL_INVESTMENT', '2'], ['CUMULATIVE_YTD', '1']]);
    expect(rows[0]?.[2]).toContain('The plan was adjusted');
    expect(rows[1]?.[2]).toContain(word('ind.fig.source.import', { mapping: 'MONTHLY_FORM', version: 1, line: 4 }));
    fireEvent.click(within(table).getByRole('button', { name: word('ind.fig.history.label', { code: 'TOTAL_INVESTMENT' }) }));
    const history = await screen.findByTestId('history-table');
    expect(Array.from(history.querySelectorAll('tbody tr[data-revision]')).map((row) => row.getAttribute('data-revision'))).toEqual(['2', '1']);
  });

  it('enters figures: sends the project, the period and each line, then says what was created, revised and left unchanged', async () => {
    const { h } = open();
    await load();
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(true);
    await fill('TOTAL_INVESTMENT', ' 1000 ');
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(false);
    save();
    expect((await screen.findByTestId('entry-result')).textContent).toContain(word('ind.fig.result.summary', { created: 1, revised: 0, unchanged: 0 }));
    expect(h.command).toHaveBeenCalledWith('enterIndicatorFigures', expect.objectContaining({ body: { project_id: PROJECT, period_id: PERIOD, figures: [{ indicator_code: 'TOTAL_INVESTMENT', value: '1000' }] } }));
  });

  it('refuses a number written with a comma, an indicator used twice, and holds a correction until its reason is given', async () => {
    const { h } = open({ world: { figures: [figure(1)] } });
    await load();
    await fill('TOTAL_INVESTMENT', '1,5');
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(word('ind.fig.fault.value'))).toBeTruthy();
    await fill('TOTAL_INVESTMENT', '1200');
    expect(screen.getByText(word('ind.fig.fault.reason'))).toBeTruthy();
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('ind.fig.line.reason')), { target: { value: 'The plan was adjusted' } });
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: word('ind.fig.line.add') }));
    await fill('TOTAL_INVESTMENT', '5', 1);
    expect(screen.getAllByText(word('ind.fig.fault.duplicate')).length).toBe(2);
    expect((screen.getByRole('button', { name: word('ind.fig.entry.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: word('ind.fig.line.remove') })[1] as HTMLElement);
    save();
    await screen.findByTestId('entry-result');
    expect(h.command).toHaveBeenCalledWith('enterIndicatorFigures', expect.objectContaining({ body: expect.objectContaining({ figures: [{ indicator_code: 'TOTAL_INVESTMENT', value: '1200', reason: 'The plan was adjusted' }] }) }));
  });

  it('shows the rules that blocked the entry with the words of their maker, and shows a warning beside the saved figures', async () => {
    const blocked = open({ command: () => problem('IND_ENTRY_RULE_VIOLATED', 422, { violations: [violation()] }, 'EQUITY_PLUS_DEBT_EQUALS_TOTAL') });
    await load();
    await fill('CUMULATIVE_YTD', '400');
    save();
    const note = await screen.findByTestId('problem-note');
    expect(note.getAttribute('data-problem')).toBe('ruleViolated');
    const list = within(note).getByTestId('problem-violations');
    expect(within(list).getByText(violation().message, { exact: false })).toBeTruthy();
    expect(list.querySelector('[data-rule="EQUITY_PLUS_DEBT_EQUALS_TOTAL"]')?.getAttribute('data-severity')).toBe('BLOCK');
    expect(within(list).getByText(word('ind.violation.detail.note', { fields: 'EQUITY, DEBT, TOTAL', detail: violation().detail }))).toBeTruthy();
    expect(screen.queryByTestId('entry-result')).toBeNull();
    blocked.unmount();
    cleanup();
    open({ command: byOperation({ enter: { operation_id: 'o', status: 'ENTERED', resource_version: 1, created: 1, revised: 0, unchanged: 0, warnings: [violation({ severity: 'WARN', rule_code: 'PROGRESS_WARNING' })], figures: [figure(1)] } }) });
    await load();
    await fill('TOTAL_INVESTMENT', '10');
    save();
    const result = await screen.findByTestId('entry-result');
    expect(within(result).getByTestId('entry-warnings').querySelector('[data-severity="WARN"]')).not.toBeNull();
  });

  it('says a locked period takes no figure and a project outside the scope is not found', async () => {
    open({ command: () => problem('PERIOD_LOCKED', 409) });
    await load();
    await fill('TOTAL_INVESTMENT', '10');
    save();
    expect((await screen.findByTestId('problem-note')).textContent).toContain(word('ind.problem.periodLocked.text'));
    cleanup();
    open({ command: () => problem('RESOURCE_NOT_FOUND', 404) });
    await load();
    await fill('TOTAL_INVESTMENT', '10');
    save();
    expect((await screen.findByTestId('problem-note')).textContent).toContain(word('ind.problem.notFound.text'));
  });

  it('offers no entry to a reader or to a read-only session, and reads the figures all the same', async () => {
    open({ permissions: READER });
    await load();
    expect(screen.getByTestId('entry-noauthority').textContent).toBe(word('ind.fig.entry.noAuthority'));
    expect(screen.queryByRole('button', { name: word('ind.fig.entry.action') })).toBeNull();
    cleanup();
    open({ permissions: ADMIN, mode: 'READ_ONLY' });
    await load();
    expect(screen.getByTestId('entry-readonly').textContent).toBe(word('ind.fig.entry.readOnly'));
    expect(screen.queryByRole('button', { name: word('ind.fig.entry.action') })).toBeNull();
  });

  it('starts the entry from the indicator that was open', async () => {
    open({ world: { indicators: INDICATORS, details: { TOTAL_INVESTMENT: detailOf('TOTAL_INVESTMENT', { versions: [version(1)] }) } } });
    await ready();
    await select('TOTAL_INVESTMENT');
    fireEvent.click(await screen.findByRole('button', { name: word('ind.dict.detail.enter') }));
    await waitFor(() => expect((within(screen.getAllByTestId('entry-line')[0] as HTMLElement).getByLabelText(word('ind.fig.line.indicator')) as HTMLSelectElement).value).toBe('TOTAL_INVESTMENT'));
  });
});
