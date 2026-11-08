import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { camelOf, ROW_CODES } from './import-model';
import { APPLIED, KEY, PLANNER, PREVIEW, READER, SHA, UPLOADED, byOperation, client, connection, detail, mountScreen, previewRow, problem, routeOf, run, runId, rowError, word, world } from './import-test-support';
import type { MountOptions, World } from './import-test-support';
import ImportScreen from './ImportScreen';

const ROUTE = routeOf('BID-24', 'FR-BID-24');
const KHLCNT = word('egp.import.kind.khlcnt');
const TBMT = word('egp.import.kind.tbmt');

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
  const mounted = mountScreen(<ImportScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const chooseFile = (file: File = new File(['plan_code,package_external_code\nPL-1,GT-1'], 'plan.csv', { type: 'text/csv' })): void => {
  fireEvent.change(screen.getByLabelText(word('egp.import.flow.file.label')), { target: { files: [file] } });
};
const upload = async (): Promise<void> => {
  await screen.findByLabelText(word('egp.import.flow.file.label'));
  chooseFile();
  fireEvent.click(button(word('egp.import.flow.upload.action')));
  await screen.findByTestId('import-file');
};
const dryRun = async (): Promise<void> => {
  await upload();
  fireEvent.click(button(word('egp.import.flow.preview.action')));
  await screen.findByTestId('import-preview');
};
const applyNow = async (): Promise<void> => {
  fireEvent.click(button(word('egp.import.flow.apply.action')));
  fireEvent.click(await screen.findByRole('button', { name: word('egp.import.confirm.action') }));
};
const tileOf = (labelKey: string): HTMLElement => within(screen.getByTestId('import-preview')).getByText(word(labelKey)).closest('article') as HTMLElement;
const rowsOf = (testId: string): string[][] =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"] tbody tr[data-line]`)).map((row) => [row.getAttribute('data-line') ?? '', ...Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')]);
const waitReady = async (): Promise<void> => {
  await screen.findByTestId('history-table');
};

describe('ImportScreen (BID-24): the history of the import runs', () => {
  it('UI-BID-24: says the adapter is a proposal and the layout a working assumption, and lists the runs with kind, layout, hash, status, counts, differences, who and when', async () => {
    open();
    await waitReady();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('egp.import.page.title'));
    expect(screen.getByTestId('adapter-note').textContent).toBe(word('egp.import.adapter.note'));
    expect(within(screen.getByTestId('import-badges')).getByTestId('acceptance-badge').textContent).toContain(word('egp.import.acceptance.pending'));
    expect(screen.getByRole('table', { name: word('egp.import.history.caption') })).toBeTruthy();
    const rows = Array.from(document.querySelectorAll('[data-run-id]'));
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText(KHLCNT)).toBeTruthy();
    expect(first.getByText('WORKING-ASSUMPTION-2026.2')).toBeTruthy();
    expect(first.getByTestId('acceptance-badge').textContent).toContain(word('egp.import.acceptance.pending'));
    expect(first.getByTestId('hash').querySelector('code')?.textContent).toBe('111111111111');
    expect(first.getByTestId('run-status').textContent).toContain(word('egp.import.runStatus.applied'));
    const cells = Array.from((rows[0] as HTMLElement).querySelectorAll('td')).map((cell) => cell.textContent ?? '');
    // kind, layout, hash, status, valid, refused, duplicate, conflict, open differences, who, when, detail
    expect(cells.slice(4, 11)).toEqual(['6', '2', '1', '1', '2', 'Nguyễn Văn An', '2026-11-10 08:05']);
    expect(within(rows[1] as HTMLElement).getByText(TBMT)).toBeTruthy();
    expect(screen.getByText(word('egp.import.history.note'))).toBeTruthy();
  });

  it('shows the acceptance word of a confirmed layout instead of the working-assumption badge', async () => {
    open({ world: { connection: connection({ acceptance: 'ACCEPTABLE' }) } });
    await waitReady();
    await waitFor(() => expect(within(screen.getByTestId('import-badges')).getByTestId('acceptance-badge').getAttribute('data-acceptance')).toBe('ACCEPTABLE'));
    expect(within(screen.getByTestId('import-badges')).getByTestId('acceptance-badge').textContent).toContain(word('egp.import.acceptance.acceptable'));
  });

  it('copies the full hash of a file and says whether it worked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open();
    await waitReady();
    fireEvent.click(screen.getAllByRole('button', { name: word('egp.import.hash.copy', { hash: '111111111111' }) })[0] as HTMLElement);
    await screen.findByText(word('egp.import.hash.copied'));
    expect(writeText).toHaveBeenCalledWith('1'.repeat(64));
    cleanup();
    writeText.mockRejectedValue(new Error('denied'));
    open();
    await waitReady();
    fireEvent.click(screen.getAllByRole('button', { name: word('egp.import.hash.copy', { hash: '111111111111' }) })[0] as HTMLElement);
    await screen.findByText(word('egp.import.hash.copyFailed'));
  });

  it('loads more runs a page at a time with the cursor of the server, and filters by kind', async () => {
    const runs = [run(1), run(2, { kind: 'TBMT' }), run(3), run(4, { kind: 'TBMT' }), run(5)];
    const { h } = open({ world: { runs, pageSize: 2 } });
    await waitReady();
    expect(document.querySelectorAll('[data-run-id]')).toHaveLength(2);
    fireEvent.click(button(word('egp.import.history.more.action')));
    await waitFor(() => expect(document.querySelectorAll('[data-run-id]')).toHaveLength(4));
    expect(h.read).toHaveBeenCalledWith('listEgpImports', { query: { cursor: '2', limit: 20 } });
    fireEvent.click(button(word('egp.import.history.more.action')));
    await waitFor(() => expect(document.querySelectorAll('[data-run-id]')).toHaveLength(5));
    expect(screen.queryByRole('button', { name: word('egp.import.history.more.action') })).toBeNull();
    fireEvent.change(screen.getByLabelText(word('egp.import.filter.kind.label')), { target: { value: 'TBMT' } });
    await waitFor(() => expect(document.querySelectorAll('[data-run-id]')).toHaveLength(2));
    expect(h.read).toHaveBeenCalledWith('listEgpImports', { query: { kind: 'TBMT', limit: 20 } });
  });

  it('says there is no import yet, and that a kind has none', async () => {
    open({ world: { runs: [] } });
    expect((await screen.findByTestId('history-empty')).textContent).toBe(word('egp.import.history.empty'));
    cleanup();
    open();
    await waitReady();
    fireEvent.change(screen.getByLabelText(word('egp.import.filter.kind.label')), { target: { value: 'RESTRICTION' } });
    expect((await screen.findByTestId('history-empty')).textContent).toBe(word('egp.import.history.emptyFiltered'));
  });

  it('shows a skeleton while the history loads, an error with a retry, and forbidden for a 403', async () => {
    open({ world: { hanging: new Set(['listEgpImports']) } });
    await screen.findByTestId('import-badges');
    await waitFor(() => expect(document.querySelector('table[aria-busy="true"]')).not.toBeNull());
    cleanup();
    const failing = new Map<string, Error>([['listEgpImports', new Error('down')]]);
    const { state } = open({ world: { failing } });
    expect(await screen.findByText(word('ui.dataTable.error'))).toBeTruthy();
    failing.clear();
    expect(state.failing.size).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: word('ui.common.retry') }));
    await waitReady();
    cleanup();
    open({ world: { failing: new Map([['listEgpImports', problem('PERMISSION_DENIED', 403)]]) } });
    expect((await screen.findByTestId('history-denied')).textContent).toBe(word('egp.import.history.denied'));
    expect(document.querySelector('[data-run-id]')).toBeNull();
  });

  it('tells in words why a run failed, from its error code', async () => {
    open({
      world: {
        runs: [run(1, { status: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID' }), run(2, { status: 'FAILED', error_code: 'WEIRD_CODE' }), run(3, { status: 'FAILED', error_code: null }), run(4, { status: 'IMPORTING', completed_at: null })],
      },
    });
    await waitReady();
    const failure = (id: number): string => within(document.querySelector(`[data-run-id="${runId(id)}"]`) as HTMLElement).getByTestId('run-status').textContent ?? '';
    expect(failure(1)).toContain(word('egp.import.runStatus.failed'));
    expect(failure(1)).toContain(word('egp.import.runFailed.reason', { reason: word('egp.import.problem.schemaPlain') }));
    expect(failure(2)).toContain(word('egp.import.runFailed.other', { code: 'WEIRD_CODE' }));
    expect(failure(3)).toContain(word('egp.import.runFailed.none'));
    expect(failure(4)).toContain(word('egp.import.runStatus.importing'));
  });

  it('opens the rows a run refused, with the line, the reason in words, the field and the masked preview, and closes them again', async () => {
    const { h } = open();
    await waitReady();
    fireEvent.click(screen.getAllByRole('button', { name: word('egp.import.history.select.label', { kind: KHLCNT, when: '2026-11-10 08:05' }) })[0] as HTMLElement);
    const panel = await screen.findByRole('group', { name: word('egp.import.detail.title', { kind: KHLCNT, when: '2026-11-10 08:05' }) });
    await screen.findByTestId('detail-errors');
    expect(h.read).toHaveBeenCalledWith('getEgpImport', { path: { id: runId(1) } });
    expect(document.activeElement).toBe(panel);
    expect(rowsOf('detail-errors').map((row) => [row[0], row[3], row[4]])).toEqual([
      ['4', word('egp.import.rowCode.moneyInvalid'), 'estimated_price'],
      ['7', word('egp.import.rowCode.fieldRequired'), 'plan_code'],
    ]);
    expect(rowsOf('detail-errors')[0]?.[5]).toContain('1.200.000');
    expect(within(panel).getByText(word('egp.import.history.summary', { valid: 6, errors: 2, duplicate: 1, conflict: 1, differences: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('egp.import.detail.close') }));
    expect(screen.queryByTestId('import-detail')).toBeNull();
  });

  it('says when a run refused nothing, when its rows are cut, and what a failed run died of', async () => {
    open({
      world: {
        runs: [run(1), run(2), run(3, { status: 'FAILED', error_code: 'IMPORT_EMPTY' })],
        details: {
          [runId(1)]: detail(1, { errors: [], errors_truncated: false }),
          [runId(2)]: detail(2, { errors_truncated: true }),
          [runId(3)]: detail(3, { run: run(3, { status: 'FAILED', error_code: 'IMPORT_EMPTY' }), errors: [] }),
        },
      },
    });
    await waitReady();
    const select = (n: number): void => {
      fireEvent.click(document.querySelector(`[data-run-id="${runId(n)}"] button[aria-pressed]`) as HTMLElement);
    };
    select(1);
    expect((await screen.findByTestId('detail-empty')).textContent).toBe(word('egp.import.detail.empty'));
    select(2);
    await screen.findByTestId('detail-errors');
    expect(screen.getByText(word('egp.import.errors.truncated'))).toBeTruthy();
    select(3);
    expect((await screen.findByTestId('detail-failed')).textContent).toBe(word('egp.import.runFailed.reason', { reason: word('egp.import.problem.empty') }));
  });

  it('shows the detail states: reading, error with a retry, and forbidden', async () => {
    const failing = new Map<string, Error>([['getEgpImport', new Error('down')]]);
    const { state } = open({ world: { failing } });
    await waitReady();
    const select = (): void => {
      fireEvent.click(document.querySelector(`[data-run-id="${runId(1)}"] button[aria-pressed]`) as HTMLElement);
    };
    select();
    expect(await screen.findByTestId('detail-error')).toBeTruthy();
    state.failing.clear();
    fireEvent.click(within(screen.getByTestId('detail-error')).getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('detail-errors');
    cleanup();
    open({ world: { failing: new Map([['getEgpImport', problem('SCOPE_DENIED', 403)]]) } });
    await waitReady();
    select();
    expect((await screen.findByTestId('detail-denied')).textContent).toBe(word('egp.import.detail.denied'));
    cleanup();
    open({ world: { hanging: new Set(['getEgpImport']) } });
    await waitReady();
    select();
    expect(await screen.findByTestId('detail-loading')).toBeTruthy();
  });
});

describe('ImportScreen (BID-24): choosing the kind and the file', () => {
  it('offers the five kinds by their Vietnamese names and shows the expected columns of the chosen layout, collapsed', async () => {
    open();
    const kind = (await screen.findByLabelText(word('egp.import.flow.kind.label'))) as HTMLSelectElement;
    expect(Array.from(kind.options).map((option) => option.textContent)).toEqual([KHLCNT, TBMT, word('egp.import.kind.result'), word('egp.import.kind.contractor'), word('egp.import.kind.restriction')]);
    const columns = screen.getByTestId('expected-columns') as HTMLDetailsElement;
    expect(columns.open).toBe(false);
    expect(within(columns).getByText(word('egp.import.columns.summary', { kind: KHLCNT, version: 'WORKING-ASSUMPTION-2026.2' }))).toBeTruthy();
    expect(within(columns).getByText('plan_code')).toBeTruthy();
    expect(within(columns).getByText('OPEN_BIDDING, LIMITED_BIDDING')).toBeTruthy();
    expect(within(columns).getAllByText(word('egp.import.need.required'))).toHaveLength(2);
    fireEvent.change(kind, { target: { value: 'TBMT' } });
    expect(within(screen.getByTestId('expected-columns')).getByText('notice_code')).toBeTruthy();
    expect(within(screen.getByTestId('expected-columns')).getByText(word('egp.import.need.header'))).toBeTruthy();
    expect(within(screen.getByTestId('expected-columns')).queryByText('plan_code')).toBeNull();
  });

  it('uploads the file as one part and tells what it holds; the buttons follow the steps', async () => {
    const { upload: send } = open();
    await screen.findByLabelText(word('egp.import.flow.file.label'));
    expect(button(word('egp.import.flow.upload.action')).disabled).toBe(true);
    expect(button(word('egp.import.flow.preview.action')).disabled).toBe(true);
    chooseFile();
    expect(button(word('egp.import.flow.upload.action')).disabled).toBe(false);
    fireEvent.click(button(word('egp.import.flow.upload.action')));
    expect((await screen.findByTestId('import-file')).textContent).toBe(word('egp.import.file.summary', { format: 'CSV', rows: 5, size: 2, unit: 'KB', hash: 'aaaaaaaaaaaa' }));
    expect(send).toHaveBeenCalledTimes(1);
    const [operation, input] = send.mock.calls[0] as unknown as [string, { form: FormData }];
    expect(operation).toBe('uploadEgpFile');
    expect((input.form.get('file') as File).name).toBe('plan.csv');
    expect(button(word('egp.import.flow.preview.action')).disabled).toBe(false);
    expect(screen.queryByTestId('kind-fit')).toBeNull();
  });

  it('says which kinds the file fits when the chosen kind is not one, and never switches the kind', async () => {
    open({ upload: () => ({ ...UPLOADED, matching_kinds: ['TBMT', 'RESULT'] }) });
    await upload();
    expect((await screen.findByTestId('kind-fit')).textContent).toBe(word('egp.import.fit.other', { kinds: `${TBMT}, ${word('egp.import.kind.result')}`, chosen: KHLCNT }));
    expect((screen.getByLabelText(word('egp.import.flow.kind.label')) as HTMLSelectElement).value).toBe('KHLCNT');
    cleanup();
    open({ upload: () => ({ ...UPLOADED, matching_kinds: [] }) });
    await upload();
    expect((await screen.findByTestId('kind-fit')).textContent).toBe(word('egp.import.fit.none'));
  });

  it('refuses a file over 10 MiB before sending it, and starts over when another file is chosen', async () => {
    const { upload: send } = open();
    await screen.findByLabelText(word('egp.import.flow.file.label'));
    const big = new File(['x'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    chooseFile(big);
    expect((await screen.findByTestId('import-problem')).textContent).toBe(word('egp.import.problem.tooLarge'));
    expect(button(word('egp.import.flow.upload.action')).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    chooseFile();
    expect(screen.queryByTestId('import-problem')).toBeNull();
    expect(button(word('egp.import.flow.upload.action')).disabled).toBe(false);
  });

  it('tells why the upload was refused, each in its own words, with the missing columns of a schema problem', async () => {
    const cases: Array<[Error, string]> = [
      [problem('IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['plan_code', 'package_external_code'] }), word('egp.import.problem.schemaInvalid', { columns: 'plan_code, package_external_code' })],
      [problem('IMPORT_SCHEMA_INVALID', 422), word('egp.import.problem.schemaPlain')],
      [problem('IMPORT_EMPTY', 422), word('egp.import.problem.empty')],
      [problem('FILE_TYPE_NOT_ALLOWED', 422), word('egp.import.problem.fileRefused')],
      [problem('FILE_NOT_CLEAN', 422), word('egp.import.problem.fileRefused')],
      [problem('PAYLOAD_TOO_LARGE', 413), word('egp.import.problem.tooLarge')],
      [problem('SCAN_PENDING', 409), word('egp.import.problem.scanPending')],
      [new Error('network'), word('egp.import.problem.general')],
    ];
    for (const [error, message] of cases) {
      const { h } = open({ upload: () => error });
      await screen.findByLabelText(word('egp.import.flow.file.label'));
      chooseFile();
      fireEvent.click(button(word('egp.import.flow.upload.action')));
      expect((await screen.findByTestId('import-problem')).textContent).toBe(message);
      expect(screen.queryByTestId('import-file')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe('ImportScreen (BID-24): the dry run', () => {
  it('AC-BID-24-1: runs the dry run on the stored file, writes nothing, and shows the five figures with their "i"', async () => {
    const { h } = open();
    await dryRun();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('previewEgpFile', expect.objectContaining({ body: { kind: 'KHLCNT', file_object_key: KEY, file_sha256: SHA } }));
    const figures: Array<[string, string]> = [
      ['egp.import.tile.valid.label', '3'],
      ['egp.import.tile.errors.label', '1'],
      ['egp.import.tile.duplicate.label', '1'],
      ['egp.import.tile.conflict.label', '1'],
      ['egp.import.tile.total.label', '6'],
    ];
    for (const [key, value] of figures) expect(tileOf(key).querySelector('.ui-kpi__value')?.textContent, key).toBe(value);
    const preview = within(screen.getByTestId('import-preview'));
    expect(preview.getByTestId('preview-layout').textContent).toBe(word('egp.import.preview.layout', { version: 'WORKING-ASSUMPTION-2026.2' }));
    expect(preview.getByTestId('acceptance-badge').textContent).toContain(word('egp.import.acceptance.pending'));
    fireEvent.click(within(tileOf('egp.import.tile.valid.label')).getByRole('button', { name: word('egp.import.info.open', { name: word('egp.import.tile.valid.label') }) }));
    const info = await screen.findByRole('dialog', { name: word('egp.import.tile.valid.label') });
    const field = (name: string): string => info.querySelector(`[data-field="${name}"] dd`)?.textContent ?? '';
    expect(field('formula')).toBe(word('egp.import.tileInfo.verdict', { verdict: word('egp.import.status.valid') }));
    expect(field('source')).toBe(word('egp.import.tileInfo.source', { hash: 'aaaaaaaaaaaa', layout: 'WORKING-ASSUMPTION-2026.2' }));
    expect(field('asOf')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(info.querySelector('[data-field="unverified"]')?.textContent).toBe(word('egp.import.info.unverified'));
  });

  it('shows the total with its own formula and no PENDING badge in the dry run once the layout is confirmed', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, acceptance: 'ACCEPTABLE' } }) });
    await dryRun();
    fireEvent.click(within(tileOf('egp.import.tile.total.label')).getByRole('button'));
    const info = await screen.findByRole('dialog', { name: word('egp.import.tile.total.label') });
    expect(info.querySelector('[data-field="formula"] dd')?.textContent).toBe(word('egp.import.tileInfo.total'));
    expect(info.querySelector('[data-field="unverified"]')).toBeNull();
    expect(within(screen.getByTestId('import-preview')).getByTestId('acceptance-badge').textContent).toContain(word('egp.import.acceptance.acceptable'));
  });

  it('lists every row with its verdict in words, the reason in words, the field and what the apply would do, and says the dry run has errors without hiding them', async () => {
    open();
    await dryRun();
    expect(screen.getByTestId('import-partial').textContent).toBe(word('egp.import.preview.partial', { errors: 1 }));
    const rows = rowsOf('preview-rows');
    expect(rows.map((row) => row[0])).toEqual(['2', '3', '4', '5', '6', '7']);
    const verdict = (row: string[]): string => row[3] ?? '';
    expect(verdict(rows[0]!)).toContain(word('egp.import.status.valid'));
    expect(verdict(rows[3]!)).toContain(word('egp.import.status.error'));
    expect(verdict(rows[4]!)).toContain(word('egp.import.status.duplicate'));
    expect(verdict(rows[5]!)).toContain(word('egp.import.status.conflict'));
    expect(rows.map((row) => row[4])).toEqual(['—', '—', '—', word('egp.import.rowCode.moneyInvalid'), word('egp.import.rowCode.rowDuplicate'), word('egp.import.rowCode.rowConflict')]);
    expect(rows.map((row) => row[5])).toEqual(['—', '—', '—', 'estimated_price', '—', '—']);
    expect(rows.map((row) => row[6])).toEqual([
      word('egp.import.outcome.record'),
      word('egp.import.outcome.recordAndPropose'),
      word('egp.import.outcome.recordAndDifference'),
      word('egp.import.outcome.reported'),
      word('egp.import.outcome.skipped'),
      word('egp.import.outcome.refused'),
    ]);
    expect(rows[3]?.[2]).toBe('PL-5|GT-5');
    expect(screen.queryByTestId('preview-truncated')).toBeNull();
  });

  it('filters the rows by verdict and says when none is left', async () => {
    open();
    await dryRun();
    const filter = screen.getByLabelText(word('egp.import.filter.status.label'));
    fireEvent.change(filter, { target: { value: 'ERROR' } });
    expect(rowsOf('preview-rows').map((row) => row[0])).toEqual(['5']);
    fireEvent.change(filter, { target: { value: 'VALID' } });
    expect(rowsOf('preview-rows').map((row) => row[0])).toEqual(['2', '3', '4']);
    fireEvent.change(filter, { target: { value: '' } });
    expect(rowsOf('preview-rows')).toHaveLength(6);
    cleanup();
    open({ command: byOperation({ preview: { ...PREVIEW, counts: { total: 1, valid: 1, errors: 0, duplicate: 0, conflict: 0 }, rows: [previewRow(2, 'VALID', { outcome: 'RECORD' })] } }) });
    await dryRun();
    expect(screen.queryByTestId('import-partial')).toBeNull();
    fireEvent.change(screen.getByLabelText(word('egp.import.filter.status.label')), { target: { value: 'CONFLICT' } });
    expect(screen.getByText(word('ui.dataTable.emptyFiltered'))).toBeTruthy();
  });

  it('writes the reason of every row code of the layouts in words, and any other code as it came', async () => {
    const rows = [...ROW_CODES.map((code, index) => previewRow(2 + index, 'ERROR', { code, field: 'f' })), previewRow(30, 'ERROR', { code: 'SOMETHING_NEW', field: 'g' })];
    open({ command: byOperation({ preview: { ...PREVIEW, rows, counts: { total: rows.length, valid: 0, errors: rows.length, duplicate: 0, conflict: 0 } } }) });
    await dryRun();
    const shown = rowsOf('preview-rows');
    ROW_CODES.forEach((code, index) => expect(shown[index]?.[4], code).toBe(word(`egp.import.rowCode.${camelOf(code)}`)));
    expect(shown[ROW_CODES.length]?.[4]).toBe(word('egp.import.rowCode.other', { code: 'SOMETHING_NEW' }));
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noValid');
  });

  it('tells when the rows are cut at 500', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, rows_truncated: true, counts: { total: 900, valid: 800, errors: 100, duplicate: 0, conflict: 0 } } }) });
    await dryRun();
    expect(screen.getByTestId('preview-truncated').textContent).toBe(word('egp.import.preview.truncated', { shown: 500, total: 900 }));
  });

  it('tells why the dry run was refused: layout unknown with the versions, empty file, hash, schema with the missing columns', async () => {
    const cases: Array<[Error, string]> = [
      [problem('EGP_LAYOUT_VERSION_UNKNOWN', 422, { layout_version: 'V9', supported: ['WORKING-ASSUMPTION-2026.2', 'V2'] }), word('egp.import.problem.layoutUnknown', { version: 'V9', supported: 'WORKING-ASSUMPTION-2026.2, V2' })],
      [problem('EGP_LAYOUT_VERSION_UNKNOWN', 422), word('egp.import.problem.layoutPlain')],
      [problem('IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['notice_code'] }), word('egp.import.problem.schemaInvalid', { columns: 'notice_code' })],
      [problem('IMPORT_EMPTY', 422), word('egp.import.problem.empty')],
      [problem('HASH_MISMATCH', 422), word('egp.import.problem.hashMismatch')],
      [problem('VALIDATION_FAILED', 422, { field: 'mapping_version' }), word('egp.import.problem.validation')],
    ];
    for (const [error, message] of cases) {
      open({ command: () => error });
      await upload();
      fireEvent.click(button(word('egp.import.flow.preview.action')));
      expect((await screen.findByTestId('import-problem')).textContent).toBe(message);
      expect(screen.queryByTestId('import-preview')).toBeNull();
      cleanup();
    }
  });

  it('starts the dry run over when the kind changes: the old result is gone and the apply is closed', async () => {
    open();
    await dryRun();
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(word('egp.import.flow.kind.label')), { target: { value: 'TBMT' } });
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noPreview');
  });
});

describe('ImportScreen (BID-24): the apply', () => {
  it('AC-BID-24-2: opens only after a dry run, asks once in a dialog that says it cannot be undone, and shows what was written', async () => {
    const { h } = open();
    await upload();
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').textContent).toBe(word('egp.import.applyReason.noPreview'));
    fireEvent.click(button(word('egp.import.flow.preview.action')));
    await screen.findByTestId('import-preview');
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(false);
    expect(screen.queryByTestId('apply-reason')).toBeNull();
    fireEvent.click(button(word('egp.import.flow.apply.action')));
    const dialog = await screen.findByRole('dialog', { name: word('egp.import.confirm.title') });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByTestId('confirm-irreversible').textContent).toBe(word('egp.import.confirm.irreversible'));
    expect(dialog.textContent).toContain(KHLCNT);
    expect(dialog.textContent).toContain('aaaaaaaaaaaa');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: word('egp.import.confirm.action') }));
    await screen.findByTestId('import-applied');
    expect(h.command).toHaveBeenLastCalledWith('importEgpFile', expect.objectContaining({ body: { kind: 'KHLCNT', file_object_key: KEY, file_sha256: SHA } }));
    expect(screen.queryByRole('dialog', { name: word('egp.import.confirm.title') })).toBeNull();
    const fact = (name: string): string => document.querySelector(`[data-fact="${name}"] dd`)?.textContent ?? '';
    expect(['total', 'applied', 'duplicate', 'conflict', 'quarantined', 'differences', 'mappings', 'restrictions'].map(fact)).toEqual(['6', '3', '1', '1', '1', '1', '2', '0']);
    expect(within(screen.getByTestId('mappings-link')).getByRole('link').getAttribute('href')).toBe('/bid/bid-23');
    expect(within(screen.getByTestId('mappings-link')).getByRole('link').textContent).toBe(word('egp.import.result.mappings.link', { count: 2 }));
    expect(rowsOf('import-errors').map((row) => [row[0], row[3], row[4]])).toEqual([['5', word('egp.import.rowCode.moneyInvalid'), 'estimated_price']]);
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').textContent).toBe(word('egp.import.applyReason.done'));
    // The history is read again so that the new run shows.
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listEgpImports').length).toBeGreaterThanOrEqual(2));
  });

  it('does nothing when the dialog is cancelled or closed with Escape', async () => {
    const { h } = open();
    await dryRun();
    fireEvent.click(button(word('egp.import.flow.apply.action')));
    fireEvent.click(await screen.findByRole('button', { name: word('egp.import.confirm.cancel') }));
    expect(screen.queryByRole('dialog', { name: word('egp.import.confirm.title') })).toBeNull();
    fireEvent.click(button(word('egp.import.flow.apply.action')));
    fireEvent.keyDown(await screen.findByRole('dialog', { name: word('egp.import.confirm.title') }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: word('egp.import.confirm.title') })).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('keeps the apply closed, with the reason beside it, when the file has no valid row, was loaded before, the connection is off, or the caller may not apply', async () => {
    const cases: Array<{ name: string; preview?: Record<string, unknown>; conn?: Record<string, unknown>; actions?: Record<string, boolean>; health?: Record<string, unknown>; reason: string; key: string; extra?: string }> = [
      { name: 'no valid row', preview: { counts: { total: 2, valid: 0, errors: 2, duplicate: 0, conflict: 0 } }, reason: 'noValid', key: 'egp.import.applyReason.noValid' },
      { name: 'loaded before', preview: { already_applied: true }, reason: 'alreadyApplied', key: 'egp.import.applyReason.alreadyApplied', extra: 'import-already' },
      { name: 'connection off in the dry run', preview: { connection_enabled: false }, reason: 'connectionDisabled', key: 'egp.import.applyReason.connectionDisabled', extra: 'import-disabled' },
      { name: 'health blocks the apply', health: { apply_blocked: true }, reason: 'connectionDisabled', key: 'egp.import.applyReason.connectionDisabled' },
      { name: 'no right to apply', actions: { apply: false }, reason: 'noAuthority', key: 'egp.import.applyReason.noAuthority' },
    ];
    for (const one of cases) {
      const { h } = open({ world: { connection: connection({}, one.actions, one.health) }, command: byOperation({ preview: { ...PREVIEW, ...(one.preview ?? {}) } }) });
      await dryRun();
      expect(button(word('egp.import.flow.apply.action')).disabled, one.name).toBe(true);
      expect(screen.getByTestId('apply-reason').getAttribute('data-reason'), one.name).toBe(one.reason);
      expect(screen.getByTestId('apply-reason').textContent, one.name).toBe(word(one.key));
      expect(screen.getByRole('button', { name: word('egp.import.flow.apply.action') }).getAttribute('aria-describedby'), one.name).toBe(screen.getByTestId('apply-reason').id);
      if (one.extra !== undefined) expect(screen.getByTestId(one.extra), one.name).toBeTruthy();
      // The dry run itself is not hidden by any of these.
      expect(screen.getByTestId('preview-rows'), one.name).toBeTruthy();
      expect(h.command, one.name).toHaveBeenCalledTimes(1);
      cleanup();
    }
    open({ command: byOperation({ preview: { ...PREVIEW, connection_enabled: false } }) });
    await dryRun();
    expect(within(screen.getByTestId('import-disabled')).getByRole('link').getAttribute('href')).toBe('/bid/bid-22');
  });

  it('answers a file that was loaded before as information, not as a failure, and closes the apply for it', async () => {
    open({ command: (operation) => (operation === 'previewEgpFile' ? PREVIEW : problem('IMPORT_FILE_ALREADY_APPLIED', 409)) });
    await dryRun();
    await applyNow();
    const note = await screen.findByTestId('import-info');
    expect(note.textContent).toBe(word('egp.import.problem.alreadyApplied'));
    expect(note.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('import-problem')).toBeNull();
    expect(screen.queryByRole('dialog', { name: word('egp.import.confirm.title') })).toBeNull();
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('alreadyApplied');
    expect(screen.getByTestId('import-already')).toBeTruthy();
    expect(screen.queryByTestId('import-result')).toBeNull();
  });

  it('answers a connection that was switched off with a link to the connection screen', async () => {
    open({ command: (operation) => (operation === 'previewEgpFile' ? PREVIEW : problem('EGP_CONNECTION_DISABLED', 409)) });
    await dryRun();
    await applyNow();
    const note = await screen.findByTestId('import-problem');
    expect(note.textContent).toContain(word('egp.import.problem.connectionDisabled'));
    expect(within(note).getByRole('link').getAttribute('href')).toBe('/bid/bid-22');
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('connectionDisabled');
  });

  it('tells a caller with the right on a unit only that the apply needs the whole organisation (403 SCOPE_DENIED), and keeps the dry run', async () => {
    open({ command: (operation) => (operation === 'previewEgpFile' ? PREVIEW : problem('SCOPE_DENIED', 403)) });
    await dryRun();
    await applyNow();
    const note = await screen.findByTestId('import-problem');
    expect(note.textContent).toBe(word('egp.import.problem.scopeDenied'));
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.getAttribute('data-problem')).toBe('scopeDenied');
    expect(screen.getByTestId('preview-rows')).toBeTruthy();
    expect(screen.queryByTestId('import-result')).toBeNull();
  });

  it('lists the rows IMPORT_HAS_ERRORS refused when nothing could be taken', async () => {
    const hasErrors = problem('IMPORT_HAS_ERRORS', 422, {
      counts: { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differences_opened: 0 },
      errors: [rowError(2, { code: 'FIELD_REQUIRED', field: 'plan_code' }), rowError(3, { code: 'DAY_INVALID', field: 'approved_on' })],
      errors_truncated: true,
    });
    open({ command: (operation) => (operation === 'previewEgpFile' ? PREVIEW : hasErrors) });
    await dryRun();
    await applyNow();
    expect((await screen.findByTestId('import-problem')).textContent).toBe(word('egp.import.problem.hasErrors'));
    expect(screen.getByTestId('import-refused').textContent).toBe(word('egp.import.result.refused'));
    expect(screen.getByTestId('import-result').getAttribute('data-refused')).toBe('true');
    expect(rowsOf('import-errors').map((row) => [row[0], row[3], row[4]])).toEqual([
      ['2', word('egp.import.rowCode.fieldRequired'), 'plan_code'],
      ['3', word('egp.import.rowCode.dayInvalid'), 'approved_on'],
    ]);
    expect(screen.getByText(word('egp.import.errors.truncated'))).toBeTruthy();
    expect(screen.queryByTestId('import-applied')).toBeNull();
  });

  it('tells a hash that no longer matches and any other failure of the apply', async () => {
    for (const [error, message] of [
      [problem('HASH_MISMATCH', 422), word('egp.import.problem.hashMismatch')],
      [new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), word('egp.import.problem.general')],
    ] as Array<[Error, string]>) {
      open({ command: (operation) => (operation === 'previewEgpFile' ? PREVIEW : error) });
      await dryRun();
      await applyNow();
      expect((await screen.findByTestId('import-problem')).textContent).toBe(message);
      cleanup();
    }
  });

  it('shows the restrictions a restriction file wrote', async () => {
    open({ command: byOperation({ apply: { ...APPLIED, kind: 'RESTRICTION', mappings_proposed: 0, restrictions_written: 4, errors: [] } }) });
    await dryRun();
    await applyNow();
    await screen.findByTestId('import-applied');
    expect(document.querySelector('[data-fact="restrictions"] dd')?.textContent).toBe('4');
    expect(screen.queryByTestId('mappings-link')).toBeNull();
    expect(screen.queryByTestId('import-errors')).toBeNull();
  });
});

describe('ImportScreen (BID-24): the states of the flow', () => {
  it('has no controls in a read-only session and says so, while the history stays readable', async () => {
    open({ mode: 'READ_ONLY' });
    expect((await screen.findByTestId('import-readonly')).textContent).toBe(word('egp.import.state.readOnly'));
    await waitReady();
    expect(screen.queryByLabelText(word('egp.import.flow.file.label'))).toBeNull();
    expect(screen.queryByRole('button', { name: word('egp.import.flow.preview.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('egp.import.flow.apply.action') })).toBeNull();
  });

  it('has no controls for a caller who may not dry run, and says so', async () => {
    open({ permissions: READER, world: { connection: connection({}, { preview: false, apply: false }) } });
    expect((await screen.findByTestId('import-no-preview')).textContent).toBe(word('egp.import.state.noPreview'));
    expect(screen.queryByLabelText(word('egp.import.flow.file.label'))).toBeNull();
    await waitReady();
  });

  it('keeps the dry run and drops the apply for a planner who may dry run but not apply', async () => {
    open({ permissions: PLANNER, world: { connection: connection({}, { apply: false }) } });
    await dryRun();
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').textContent).toBe(word('egp.import.applyReason.noAuthority'));
  });

  it('says the connection is being read, and keeps the controls away until it is known', async () => {
    open({ world: { hanging: new Set(['getEgpConnection']) } });
    expect((await screen.findByTestId('import-connection-loading')).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByLabelText(word('egp.import.flow.file.label'))).toBeNull();
    await waitReady();
  });

  it('says a failed read of the connection and offers a retry that brings the controls', async () => {
    const failing = new Map<string, Error>([['getEgpConnection', new Error('down')]]);
    const { state } = open({ world: { failing } });
    expect(await screen.findByTestId('import-connection-error')).toBeTruthy();
    expect(screen.getByText(word('egp.import.state.connectionError'))).toBeTruthy();
    state.failing.clear();
    fireEvent.click(within(screen.getByTestId('import-connection-error')).getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByLabelText(word('egp.import.flow.file.label'))).toBeTruthy();
    cleanup();
    open({ world: { failing: new Map([['getEgpConnection', problem('PERMISSION_DENIED', 403)]]) } });
    expect((await screen.findByTestId('import-denied')).textContent).toBe(word('egp.import.state.connectionDenied'));
  });

  it('starts over when the file is changed after a dry run', async () => {
    open();
    await dryRun();
    chooseFile(new File(['other'], 'other.csv', { type: 'text/csv' }));
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(screen.queryByTestId('import-file')).toBeNull();
    expect(button(word('egp.import.flow.preview.action')).disabled).toBe(true);
    expect(button(word('egp.import.flow.apply.action')).disabled).toBe(true);
  });

  it('links to the connection and the mapping screens', async () => {
    open();
    await waitReady();
    expect(screen.getByRole('link', { name: word('egp.import.link.connection') }).getAttribute('href')).toBe('/bid/bid-22');
    expect(screen.getByRole('link', { name: word('egp.import.link.mapping') }).getAttribute('href')).toBe('/bid/bid-23');
    expect(screen.getByText(word('egp.import.footer.reference', { id: 'BID-24', req: 'FR-BID-24' }))).toBeTruthy();
  });
});
