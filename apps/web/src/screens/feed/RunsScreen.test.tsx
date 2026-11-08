import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import RunsScreen from './RunsScreen';
import { ROW_CODES, camelOf, vietnamStamp } from './feed-model';
import { AS_OF, APPLIED, KEY, PREVIEW, SHA, UPLOADED, client, connection, detail, generatorRun, mountScreen, previewRow, problem, rowError, routeOf, runId, word, world } from './test/feed-test-support';
import type { MountOptions, World } from './test/feed-test-support';

const ROUTE = routeOf('FEED-02');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

const byOperation = (answers: { preview?: unknown; apply?: unknown } = {}) => (operation: string): unknown => (operation === 'previewFinanceFeedFile' ? (answers.preview ?? PREVIEW) : operation === 'importFinanceFeedFile' ? (answers.apply ?? APPLIED) : {});

function open(options: Options = {}) {
  const state = world(options.world);
  const h = client(state, options.command ?? byOperation());
  const mounted = mountScreen(<RunsScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const chooseKind = (kind: string): void => {
  fireEvent.change(screen.getByLabelText(word('feed.runs.flow.kind.label')), { target: { value: kind } });
};
const chooseFile = (file: File = new File(['feed_project_code,disbursed_month\nFIN-0001,100'], 'giai-ngan.csv', { type: 'text/csv' })): void => {
  fireEvent.change(screen.getByLabelText(word('feed.runs.flow.file.label')), { target: { files: [file] } });
};
const upload = async (kind = 'DISBURSEMENT'): Promise<void> => {
  await screen.findByLabelText(word('feed.runs.flow.file.label'));
  chooseKind(kind);
  chooseFile();
  fireEvent.click(button(word('feed.runs.flow.upload.action')));
  await screen.findByTestId('import-file');
};
const dryRun = async (): Promise<void> => {
  await upload();
  fireEvent.click(button(word('feed.runs.flow.preview.action')));
  await screen.findByTestId('import-preview');
};
const applyNow = async (): Promise<void> => {
  fireEvent.click(button(word('feed.runs.flow.apply.action')));
  fireEvent.click(await screen.findByRole('button', { name: word('feed.runs.confirm.action') }));
};
const rowsOf = (testId: string): string[][] =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"] tbody tr[data-line]`)).map((row) => [row.getAttribute('data-line') ?? '', ...Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')]);
const runRows = (): HTMLElement[] => Array.from(document.querySelectorAll('tr[data-run-id]')) as HTMLElement[];
const history = async (): Promise<void> => {
  await waitFor(() => expect(runRows().length).toBeGreaterThan(0));
};
const tileOf = (labelKey: string): HTMLElement => within(screen.getByRole('group', { name: word('feed.runs.tile.group.label') })).getByText(word(labelKey)).closest('article') as HTMLElement;
const openButton = (row: HTMLElement): HTMLElement => within(row).getByRole('button', { name: /Xem chi tiết/ });

describe('RunsScreen (FEED-02): the runs of the feed', () => {
  it('AC-ST-FEED-001-5 / UI-FEED-02: lists the runs of every channel alike with kind, layout, hash or seed, counts and who, and says the layout is an assumption', async () => {
    open();
    await history();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('feed.runs.page.title'));
    expect(within(screen.getByTestId('import-badges')).getByTestId('acceptance-badge').textContent).toContain(word('feed.common.acceptance.pending'));
    const rows = runRows();
    expect(rows).toHaveLength(3);
    const file = within(rows[0] as HTMLElement);
    expect(file.getByText(word('feed.common.kind.disbursement'))).toBeTruthy();
    expect(file.getByTestId('channel-tag').textContent).toBe(word('feed.common.channel.file'));
    expect(file.getByText('WORKING-ASSUMPTION-FIN-2026.1')).toBeTruthy();
    expect(file.getByTestId('acceptance-badge').textContent).toContain(word('feed.common.acceptance.pending'));
    expect(file.getByTestId('hash').querySelector('code')?.textContent).toBe('111111111111');
    expect(file.getByTestId('run-counts').textContent).toContain(word('feed.runs.counts.text', { total: '40', written: '30', skipped: '8', rejected: '2' }));
    expect(file.getByText('Lê Thị Hoa')).toBeTruthy();
    expect(file.getByText(vietnamStamp('2026-11-07T01:00:00.000Z'))).toBeTruthy();
    const generated = within(rows[1] as HTMLElement);
    expect(generated.getByTestId('channel-tag').textContent).toBe(word('feed.common.channel.generator'));
    expect(generated.getByTestId('seed').textContent).toBe(word('feed.runs.source.seed', { seed: 57, epoch: 2 }));
    expect(generated.getByText(word('feed.runs.action.generatorStart'))).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('mô phỏng');
  });

  it('opens the "i" of the counts of a run: the formula, the source with the layout, the moment and the unconfirmed layout', async () => {
    open();
    await history();
    const first = within(runRows()[0] as HTMLElement);
    fireEvent.click(first.getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.runs.figure.counts.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.runs.figure.counts.name') });
    expect(panel.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.runs.figure.counts.formula'));
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.runs.figure.counts.source', { layout: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    expect(panel.querySelector('[data-field="asOf"] dd')?.textContent).toBe(vietnamStamp('2026-11-07T01:00:00.000Z'));
    expect(panel.querySelector('[data-field="unverified"]')).toBeTruthy();
  });

  it('narrows the list by channel and by kind, keeps the filter in the address and clears it', async () => {
    const { h } = open();
    await history();
    fireEvent.change(screen.getByLabelText(word('feed.runs.filter.channel.label')), { target: { value: 'GENERATOR' } });
    await waitFor(() => expect(runRows()).toHaveLength(1));
    expect(within(runRows()[0] as HTMLElement).getByTestId('channel-tag').textContent).toBe(word('feed.common.channel.generator'));
    expect(h.read.mock.calls.some(([operation, input]) => operation === 'listFinanceFeedRuns' && (input as { query: { channel?: string } }).query.channel === 'GENERATOR')).toBe(true);
    fireEvent.change(screen.getByLabelText(word('feed.runs.filter.kind.label')), { target: { value: 'PLAN' } });
    expect((await screen.findByTestId('empty')).textContent).toContain(word('feed.runs.empty.filtered.title'));
    fireEvent.click(screen.getByRole('button', { name: word('feed.runs.filter.clear.action') }));
    await waitFor(() => expect(runRows()).toHaveLength(3));
    expect((screen.getByLabelText(word('feed.runs.filter.channel.label')) as HTMLSelectElement).value).toBe('');
  });

  it('starts from the filter in the address', async () => {
    open({ path: '/?channel=FILE&kind=PLAN' });
    await history();
    expect(runRows()).toHaveLength(1);
    expect((screen.getByLabelText(word('feed.runs.filter.kind.label')) as HTMLSelectElement).value).toBe('PLAN');
  });

  it('loads the next page when asked and says how many rows it shows', async () => {
    open({ world: { pageSize: 2 } });
    await history();
    expect(runRows()).toHaveLength(2);
    expect(screen.getByTestId('shown').textContent).toBe(word('feed.common.paging.summary', { shown: 2 }));
    fireEvent.click(screen.getByRole('button', { name: word('feed.common.paging.more') }));
    await waitFor(() => expect(runRows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: word('feed.common.paging.more') })).toBeNull();
  });

  it('says in words that the next page failed and keeps what is shown', async () => {
    const { state } = open({ world: { pageSize: 2 } });
    await history();
    state.failing.set('listFinanceFeedRuns', new Error('down'));
    fireEvent.click(screen.getByRole('button', { name: word('feed.common.paging.more') }));
    expect((await screen.findByText(word('feed.common.paging.error'))).getAttribute('role')).toBe('alert');
    expect(runRows()).toHaveLength(2);
  });

  it('opens a run to its counts and to the rows it refused, masked, with the reason in words', async () => {
    open();
    await history();
    fireEvent.click(within(runRows()[0] as HTMLElement).getByRole('button', { name: word('feed.runs.open.label', { time: vietnamStamp('2026-11-07T01:00:00.000Z') }) }));
    const panel = within(await screen.findByTestId('run-detail'));
    await screen.findByTestId('detail-counts');
    expect(within(screen.getByTestId('detail-counts')).getByText('40')).toBeTruthy();
    expect(screen.getByTestId('detail-facts').textContent).toContain(word('feed.runs.detail.facts.text', { what: word('feed.common.kind.disbursement'), time: vietnamStamp('2026-11-07T01:00:00.000Z'), layout: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    const errors = rowsOf('run-detail');
    expect(errors.map((row) => row[0])).toEqual(['4', '7']);
    expect(errors[0]?.[3]).toBe(word('feed.runs.code.moneyInvalid'));
    expect(errors[0]?.[4]).toContain('disbursed_month');
    expect(errors[0]?.[5]).toContain('12x');
    expect(errors[1]?.[3]).toBe(word('feed.runs.code.none'));
    expect(panel.queryByTestId('detail-truncated')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('feed.runs.detail.close.action') }));
    expect(screen.queryByTestId('run-detail')).toBeNull();
  });

  it('says that a run that refused nothing refused nothing, and that a list of refused rows was cut', async () => {
    open({ world: { details: { [runId(1)]: detail(1, { errors_truncated: true }), [runId(2)]: detail(2, { errors: [], run: generatorRun(2) }) } } });
    await history();
    fireEvent.click(openButton(runRows()[1] as HTMLElement));
    expect((await screen.findByTestId('detail-no-errors')).textContent).toBe(word('feed.runs.detail.errors.none'));
    fireEvent.click(openButton(runRows()[0] as HTMLElement));
    expect((await screen.findByTestId('detail-truncated')).textContent).toBe(word('feed.runs.detail.errors.truncated', { shown: 2 }));
  });

  it('says a run could not be loaded, and that it may not be seen', async () => {
    const { state } = open();
    await history();
    state.failing.set('getFinanceFeedRun', problem('SCOPE_DENIED', 403));
    fireEvent.click(openButton(runRows()[0] as HTMLElement));
    expect((await within(screen.getByTestId('run-detail')).findByTestId('denied')).textContent).toContain(word('feed.common.state.denied.title'));
    cleanup();
    const second = open();
    await history();
    second.state.failing.set('getFinanceFeedRun', problem('RESOURCE_NOT_FOUND', 404));
    fireEvent.click(openButton(runRows()[0] as HTMLElement));
    expect((await within(screen.getByTestId('run-detail')).findByTestId('error')).textContent).toContain(word('feed.common.state.error.title'));
  });
});

describe('RunsScreen (FEED-02): the states of the list', () => {
  it('shows a loading card and no row while the runs load', async () => {
    const state = world();
    state.hanging.add('listFinanceFeedRuns');
    mountScreen(<RunsScreen route={ROUTE} />, client(state, byOperation()));
    expect((await screen.findByTestId('loading')).getAttribute('aria-busy')).toBe('true');
    expect(runRows()).toHaveLength(0);
  });

  it('says there is no run yet, and what to do', async () => {
    open({ world: { runs: [] } });
    const empty = await screen.findByTestId('empty');
    expect(empty.textContent).toContain(word('feed.runs.empty.title'));
    expect(empty.textContent).toContain(word('feed.runs.empty.body'));
  });

  it('shows an error with a new try, then the runs', async () => {
    const { state } = open({ world: { failing: new Map([['listFinanceFeedRuns', new Error('down')]]) } });
    const error = await screen.findByTestId('error');
    expect(error.textContent).toContain(word('feed.common.state.error.title'));
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: word('states.retry.action') }));
    await history();
  });

  it('shows the forbidden card for a 403', async () => {
    open({ world: { failing: new Map([['listFinanceFeedRuns', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByTestId('denied')).textContent).toContain(word('feed.common.state.denied.title'));
    expect(runRows()).toHaveLength(0);
  });

  it('says the network is down, and that the session lapsed', async () => {
    open({ world: { failing: new Map([['listFinanceFeedRuns', problem('NETWORK_ERROR', 0)]]) } });
    const state = await screen.findByTestId('error');
    expect(['offline', 'error']).toContain(state.getAttribute('data-state'));
    cleanup();
    open({ world: { failing: new Map([['listFinanceFeedRuns', problem('SESSION_EXPIRED', 401)]]) } });
    expect((await screen.findByTestId('error')).getAttribute('data-state')).toBe('signedOut');
  });

  it('keeps the runs it has and says the refresh failed (stale)', async () => {
    const { queries, state } = open();
    await history();
    state.failing.set('listFinanceFeedRuns', new Error('down'));
    await act(async () => {
      await queries.invalidateQueries({ queryKey: ['finance-feed'], predicate: (query) => query.queryKey.includes('runs') });
    });
    const note = await screen.findByTestId('stale');
    expect(note.textContent).toContain(word('feed.common.state.stale.text', { time: vietnamStamp(AS_OF) }));
    expect(runRows()).toHaveLength(3);
  });
});

describe('RunsScreen (FEED-02): who may import', () => {
  it('says the workspace is read-only and offers no upload', async () => {
    open({ mode: 'READ_ONLY' });
    expect((await screen.findByTestId('import-readonly')).textContent).toBe(word('feed.runs.state.readOnly'));
    expect(screen.queryByLabelText(word('feed.runs.flow.file.label'))).toBeNull();
    await history();
  });

  it('says a person who may not dry run has no import, and still reads the runs', async () => {
    open({ world: { connection: connection({}, { preview: false, apply: false }) } });
    expect((await screen.findByTestId('import-no-preview')).textContent).toBe(word('feed.runs.state.noPreview'));
    expect(screen.queryByLabelText(word('feed.runs.flow.file.label'))).toBeNull();
    await history();
  });

  it('says it cannot know what the person may do when the connection is forbidden, and offers a new try when it failed', async () => {
    open({ world: { failing: new Map([['getFinanceFeedConnection', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByTestId('import-denied')).textContent).toBe(word('feed.runs.state.connectionDenied'));
    cleanup();
    const second = open({ world: { failing: new Map([['getFinanceFeedConnection', new Error('down')]]) } });
    const error = await screen.findByTestId('import-connection-error');
    second.state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: word('states.retry.action') }));
    await screen.findByLabelText(word('feed.runs.flow.file.label'));
  });
});

describe('RunsScreen (FEED-02): the file, the dry run and the apply', () => {
  it('shows the expected columns of the chosen kind, required or optional', async () => {
    open();
    await screen.findByLabelText(word('feed.runs.flow.file.label'));
    chooseKind('PLAN');
    const columns = screen.getByTestId('expected-columns');
    expect(columns.querySelector('summary')?.textContent).toBe(word('feed.runs.columns.summary', { kind: word('feed.common.kind.plan'), version: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    expect(columns.textContent).toContain('fund_code');
    expect(columns.textContent).toContain(word('feed.runs.columns.required'));
    expect(columns.textContent).toContain('NSTW, NSDP');
  });

  it('sends the file to the upload pipeline and says its format, rows, size and hash', async () => {
    const { upload: sent } = open();
    await upload();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('import-file').textContent).toBe(word('feed.runs.file.summary', { format: 'CSV', rows: '6', size: '2', unit: 'KB', hash: SHA.slice(0, 12) }));
    expect(screen.queryByTestId('kind-fit')).toBeNull();
    expect(button(word('feed.runs.flow.upload.action')).disabled).toBe(true);
  });

  it('tells which kinds the file fits and never changes the kind for the person', async () => {
    open();
    await upload('PROJECT');
    const fit = screen.getByTestId('kind-fit');
    expect(fit.getAttribute('data-fit')).toBe('other');
    expect(fit.textContent).toBe(word('feed.runs.fit.other', { kinds: word('feed.common.kind.disbursement'), chosen: word('feed.common.kind.project') }));
    expect((screen.getByLabelText(word('feed.runs.flow.kind.label')) as HTMLSelectElement).value).toBe('PROJECT');
    cleanup();
    open({ upload: () => ({ ...UPLOADED, matching_kinds: [] }) });
    await upload('PLAN');
    expect(screen.getByTestId('kind-fit').textContent).toBe(word('feed.runs.fit.none', { kinds: '', chosen: '' }));
  });

  it('refuses a file larger than ten megabytes before it is sent', async () => {
    const { upload: sent } = open();
    await screen.findByLabelText(word('feed.runs.flow.file.label'));
    const big = new File(['x'], 'lon.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    chooseFile(big);
    expect(screen.getByTestId('problem').getAttribute('data-problem')).toBe('tooLarge');
    expect(button(word('feed.runs.flow.upload.action')).disabled).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it.each([
    ['IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['feed_project_code', 'project_name'] }, word('feed.common.problem.schemaColumns', { columns: 'feed_project_code, project_name' })],
    ['IMPORT_EMPTY', 422, {}, word('feed.common.problem.empty')],
    ['FILE_NOT_CLEAN', 422, {}, word('feed.common.problem.fileRefused')],
    ['SCAN_PENDING', 409, {}, word('feed.common.problem.scanPending')],
  ])('says in place why the upload was refused: %s', async (code, status, extensions, expected) => {
    open({ upload: () => problem(code, status, undefined, extensions) });
    await screen.findByLabelText(word('feed.runs.flow.file.label'));
    chooseKind('PROJECT');
    chooseFile();
    fireEvent.click(button(word('feed.runs.flow.upload.action')));
    expect((await screen.findByTestId('problem')).textContent).toContain(expected);
    expect(screen.queryByTestId('import-file')).toBeNull();
    expect(button(word('feed.runs.flow.preview.action')).disabled).toBe(true);
  });

  it('AC-ST-FEED-001-5 / UI-FEED-02: runs the dry run, writes nothing, and shows the five figures and every row with its verdict, reason and outcome', async () => {
    const { h } = open();
    await dryRun();
    const call = h.command.mock.calls.find(([operation]) => operation === 'previewFinanceFeedFile') as [string, { body: unknown }];
    expect(call[1].body).toEqual({ kind: 'DISBURSEMENT', file_object_key: KEY, file_sha256: SHA });
    expect(h.command.mock.calls.some(([operation]) => operation === 'importFinanceFeedFile')).toBe(false);
    expect(screen.getByTestId('preview-facts').textContent).toContain(word('feed.runs.preview.mode', { mode: word('feed.runs.mode.dryRun') }));
    expect(screen.getByTestId('preview-layout').textContent).toBe(word('feed.runs.preview.layout', { version: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    expect(within(screen.getByTestId('import-preview')).getAllByTestId('acceptance-badge')[0]?.textContent).toContain(word('feed.common.acceptance.pending'));
    expect(tileOf('feed.runs.tile.valid.label').textContent).toContain('3');
    expect(tileOf('feed.runs.tile.errors.label').textContent).toContain('1');
    expect(tileOf('feed.runs.tile.total.label').textContent).toContain('6');
    expect(screen.getByTestId('import-partial').textContent).toBe(word('feed.runs.preview.partial', { errors: 1 }));
    const rows = rowsOf('preview-rows');
    expect(rows.map((row) => row[0])).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(rows[1]?.[6]).toBe(word('feed.runs.outcome.recordDifference'));
    expect(rows[2]?.[6]).toBe(word('feed.runs.outcome.recordPropose'));
    expect(rows[3]).toEqual(['4', '4', 'FIN-0004', `✕${word('feed.runs.row.status.error')}`, word('feed.runs.code.moneyInvalid'), 'disbursed_month', word('feed.runs.outcome.none')]);
    expect(rows[4]?.[4]).toBe(word('feed.runs.code.rowDuplicate'));
    expect(rows[5]?.[4]).toBe(word('feed.runs.code.other', { code: 'WEIRD_CODE' }));
  });

  it('opens the "i" of a figure of the dry run with the hash and the layout as its source', async () => {
    open();
    await dryRun();
    fireEvent.click(within(tileOf('feed.runs.tile.valid.label')).getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.runs.tile.valid.label') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.runs.tile.valid.label') });
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.runs.tileInfo.source', { hash: SHA.slice(0, 12), layout: 'WORKING-ASSUMPTION-FIN-2026.1' }));
    expect(panel.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('feed.runs.tileInfo.verdict', { verdict: word('feed.runs.row.status.valid') }));
    expect(panel.querySelector('[data-field="unverified"]')).toBeTruthy();
  });

  it('filters the rows of the dry run by verdict', async () => {
    open();
    await dryRun();
    fireEvent.change(screen.getByLabelText(word('feed.runs.filter.status.label')), { target: { value: 'ERROR' } });
    expect(rowsOf('preview-rows').map((row) => row[0])).toEqual(['4']);
    fireEvent.change(screen.getByLabelText(word('feed.runs.filter.status.label')), { target: { value: 'VALID' } });
    expect(rowsOf('preview-rows').map((row) => row[0])).toEqual(['1', '2', '3']);
  });

  it('says that the list of rows of a dry run was cut and that the rest is counted', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, rows_truncated: true } }) });
    await dryRun();
    expect(screen.getByTestId('preview-truncated').textContent).toBe(word('feed.runs.preview.truncated', { shown: 500, total: 6 }));
  });

  it('keeps the apply closed until a dry run of this file and kind, and says why', async () => {
    open();
    await upload();
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noPreview');
    expect(screen.getByTestId('apply-reason').textContent).toBe(word('feed.runs.block.noPreview'));
    fireEvent.click(button(word('feed.runs.flow.preview.action')));
    await screen.findByTestId('import-preview');
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(false);
    expect(screen.queryByTestId('apply-reason')).toBeNull();
    chooseKind('PLAN');
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(true);
  });

  it('applies the file once after the person confirmed, says what was taken and refreshes the runs', async () => {
    const { h } = open();
    await dryRun();
    const before = h.read.mock.calls.filter(([operation]) => operation === 'listFinanceFeedRuns').length;
    fireEvent.click(button(word('feed.runs.flow.apply.action')));
    expect((await screen.findByTestId('confirm-irreversible')).textContent).toBe(word('feed.runs.confirm.irreversible'));
    fireEvent.click(screen.getByRole('button', { name: word('feed.runs.confirm.action') }));
    await screen.findByTestId('import-result');
    expect(h.command.mock.calls.filter(([operation]) => operation === 'importFinanceFeedFile')).toHaveLength(1);
    expect(screen.getByTestId('result-summary').textContent).toBe(word('feed.runs.result.applied.text', { applied: '3', total: '6' }));
    expect(within(screen.getByTestId('result-counts')).getByText(word('feed.runs.result.differences.label')).parentElement?.textContent).toContain('2');
    expect(screen.getByTestId('result-facts').textContent).toContain(word('feed.runs.result.mappings.text', { count: 2 }));
    expect(rowsOf('import-result').map((row) => row[0])).toEqual(['4']);
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('done');
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listFinanceFeedRuns').length).toBeGreaterThan(before));
  });

  it('says in place that a file loaded before is already applied, and closes the apply for it', async () => {
    open({ command: (operation) => (operation === 'importFinanceFeedFile' ? problem('IMPORT_FILE_ALREADY_APPLIED', 409, 'file') : PREVIEW) });
    await dryRun();
    await applyNow();
    const note = await screen.findByTestId('problem');
    expect(note.getAttribute('data-problem')).toBe('alreadyApplied');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain(word('feed.common.problem.alreadyApplied'));
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('alreadyApplied');
    expect(screen.getByTestId('import-already').textContent).toBe(word('feed.runs.preview.already'));
  });

  it('says on the dry run itself that the file was applied before', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, already_applied: true } }) });
    await dryRun();
    expect(screen.getByTestId('import-already').textContent).toBe(word('feed.runs.preview.already'));
    expect(button(word('feed.runs.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('alreadyApplied');
  });

  it('closes the apply when the connection is off, from the dry run or from the connection itself', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, connection_enabled: false } }) });
    await dryRun();
    expect(screen.getByTestId('import-disabled').textContent).toContain(word('feed.runs.preview.disabled'));
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('connectionDisabled');
    cleanup();
    open({ world: { connection: connection({ enabled: false }) } });
    await dryRun();
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('connectionDisabled');
  });

  it('says the connection was switched off when the apply is refused for it', async () => {
    open({ command: (operation) => (operation === 'importFinanceFeedFile' ? problem('FEED_CONNECTION_DISABLED', 409, 'connection') : PREVIEW) });
    await dryRun();
    await applyNow();
    expect((await screen.findByTestId('problem')).textContent).toContain(word('feed.common.problem.connectionDisabled'));
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('connectionDisabled');
  });

  it('closes the apply when the dry run has no valid row, and when the person has no right to apply', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, counts: { total: 2, valid: 0, errors: 2, duplicate: 0, conflict: 0 }, rows: [previewRow(1, { status: 'ERROR', code: 'FIELD_REQUIRED', outcome: null })] } }) });
    await dryRun();
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noValid');
    cleanup();
    open({ world: { connection: connection({}, { apply: false }) } });
    await dryRun();
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noAuthority');
  });

  it('shows a refused file whole: nothing was taken and every refused row is listed', async () => {
    const refused = problem('IMPORT_HAS_ERRORS', 422, 'file', { counts: { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differences_opened: 0 }, errors: [rowError(1), rowError(2, { code: 'FIELD_REQUIRED', field: 'project_name' })], errors_truncated: true });
    open({ command: (operation) => (operation === 'importFinanceFeedFile' ? refused : PREVIEW) });
    await dryRun();
    await applyNow();
    const result = await screen.findByTestId('import-result');
    expect(result.getAttribute('data-refused')).toBe('true');
    expect(screen.getByTestId('result-summary').textContent).toBe(word('feed.runs.result.refused.text'));
    expect(rowsOf('import-result').map((row) => row[0])).toEqual(['1', '2']);
    expect(screen.getByTestId('result-truncated').textContent).toBe(word('feed.runs.detail.errors.truncated', { shown: 2 }));
    expect(screen.getByTestId('problem').getAttribute('data-problem')).toBe('hasErrors');
  });

  it.each([
    ['HASH_MISMATCH', 422, {}, word('feed.common.problem.hashMismatch')],
    ['FEED_LAYOUT_VERSION_UNKNOWN', 422, { layout_version: 'V9', supported: ['V1', 'V2'] }, word('feed.common.problem.layoutUnknown', { version: 'V9', supported: 'V1, V2' })],
    ['FEED_API_UNAVAILABLE', 503, {}, word('feed.common.problem.apiUnavailable')],
    ['SOMETHING_ELSE', 500, {}, word('feed.common.problem.general')],
  ])('says in place why the dry run was refused: %s', async (code, status, extensions, expected) => {
    open({ command: () => problem(code, status, undefined, extensions) });
    await upload();
    fireEvent.click(button(word('feed.runs.flow.preview.action')));
    expect((await screen.findByTestId('problem')).textContent).toContain(expected);
    expect(screen.queryByTestId('import-preview')).toBeNull();
  });

  it('has a sentence for every code a row can be refused for', () => {
    for (const code of ROW_CODES) expect(word(`feed.runs.code.${camelOf(code)}`).length).toBeGreaterThan(0);
  });
});
