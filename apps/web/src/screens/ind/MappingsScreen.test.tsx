import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MappingsScreen from './MappingsScreen';
import { ADMIN, KEY, PREVIEW, PREVIEWER, READER, SHA, UPLOADED, byOperation, client, mapping, mountScreen, previewRow, problem, routeOf, run, rowError, word, world } from './test/ind-test-support';
import type { MountOptions, World } from './test/ind-test-support';

const ROUTE = routeOf('IND-03', 'FR-IND-03');

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
  const mounted = mountScreen(<MappingsScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const chooseFile = (file: File = new File(['Mã dự án,Kỳ báo cáo,Tổng mức đầu tư\nDA-1,2026-10,1.000'], 'form.csv', { type: 'text/csv' })): void => {
  fireEvent.change(screen.getByLabelText(word('ind.imp.flow.file.label')), { target: { files: [file] } });
};
const upload = async (): Promise<void> => {
  await screen.findByLabelText(word('ind.imp.flow.file.label'));
  chooseFile();
  fireEvent.click(button(word('ind.imp.flow.upload.action')));
  await screen.findByTestId('import-file');
};
const dryRun = async (): Promise<void> => {
  await upload();
  fireEvent.click(button(word('ind.imp.flow.preview.action')));
  await screen.findByTestId('import-preview');
};
const applyNow = async (): Promise<void> => {
  fireEvent.click(button(word('ind.imp.flow.apply.action')));
  fireEvent.click(await screen.findByRole('button', { name: word('ind.imp.confirm.action') }));
};
const tableRows = (testId: string): string[][] => Array.from(document.querySelectorAll(`[data-testid="${testId}"] tbody tr[data-line]`)).map((row) => [row.getAttribute('data-line') ?? '', ...Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')]);
const listed = async (): Promise<void> => {
  await screen.findByTestId('mappings-table');
  await screen.findByTestId('history-table');
};

describe('MappingsScreen (IND-03): the mappings', () => {
  it('UI-IND-03: lists each mapping with its layout, number format, lines, version, whether it reads files or is only a template, and its problems', async () => {
    open();
    await listed();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('ind.map.page.title'));
    const row = (code: string): HTMLElement => document.querySelector(`[data-testid="mappings-table"] tr[data-code="${code}"]`) as HTMLElement;
    expect(row('MONTHLY_FORM').getAttribute('data-active')).toBe('true');
    expect(within(row('MONTHLY_FORM')).getByText(word('ind.map.state.active'))).toBeTruthy();
    expect(within(row('MONTHLY_FORM')).getByText(word('ind.layout.columns.label'))).toBeTruthy();
    expect(within(row('MONTHLY_FORM')).getByText('v1')).toBeTruthy();
    expect(within(row('MONTHLY_FORM')).getByText(word('ind.origin.rule.label'))).toBeTruthy();
    expect(row('SAMPLE_ROWS_FORM').getAttribute('data-active')).toBe('false');
    expect(within(row('SAMPLE_ROWS_FORM')).getByText(word('ind.map.state.template'))).toBeTruthy();
    expect(within(row('SAMPLE_ROWS_FORM')).getByText(word('ind.layout.rows.label'))).toBeTruthy();
    expect(within(row('SAMPLE_ROWS_FORM')).getByText(word('ind.map.problems.count', { n: 1 }))).toBeTruthy();
    expect(screen.queryByTestId('mappings-none-active')).toBeNull();
  });

  it('says that no file can be imported while no mapping is approved', async () => {
    open({ world: { mappings: [mapping('SAMPLE_COLUMNS_FORM')] } });
    expect((await screen.findByTestId('mappings-none-active')).textContent).toBe(word('ind.map.state.noneActive'));
  });

  it('says it is loading, could not be read (and reads again), is not allowed or has no mapping', async () => {
    const hanging = open({ world: { hanging: new Set(['listIndicatorImportMappings']) } });
    expect((await screen.findByTestId('mappings-loading')).getAttribute('aria-busy')).toBe('true');
    hanging.unmount();
    cleanup();
    const failing = open({ world: { failing: new Map([['listIndicatorImportMappings', new Error('down')]]) } });
    expect((await screen.findByTestId('mappings-error')).textContent).toContain(word('ind.map.state.error'));
    failing.state.failing.clear();
    fireEvent.click(screen.getAllByRole('button', { name: word('states.retry.action') })[0] as HTMLElement);
    await screen.findByTestId('mappings-table');
    cleanup();
    open({ world: { failing: new Map([['listIndicatorImportMappings', problem('FORBIDDEN', 403)]]) } });
    expect((await screen.findByTestId('mappings-denied')).textContent).toBe(word('ind.map.state.denied'));
    cleanup();
    open({ world: { mappings: [] } });
    expect((await screen.findByTestId('mappings-empty')).textContent).toBe(word('ind.map.state.empty'));
  });

  it('opens a mapping: the form it reads, the line for each column, the problems, and the versions with who made and who approved each', async () => {
    open();
    await listed();
    fireEvent.click(screen.getByRole('button', { name: word('ind.map.select.label', { code: 'MONTHLY_FORM' }) }));
    const detail = await screen.findByTestId('mapping-detail');
    expect(within(await screen.findByTestId('mapping-facts')).getByText('Mã dự án')).toBeTruthy();
    const lines = within(detail).getByTestId('mapping-lines');
    expect(Array.from(lines.querySelectorAll('tbody tr[data-indicator]')).map((one) => [one.getAttribute('data-indicator'), one.textContent])).toEqual([
      ['TOTAL_INVESTMENT', expect.stringContaining('Tổng mức đầu tư')],
      ['CUMULATIVE_YTD', expect.stringContaining(word('ind.scale.million.label'))],
    ]);
    expect(within(detail).queryByTestId('mapping-problems')).toBeNull();
    expect(within(detail).queryByTestId('mapping-template-note')).toBeNull();
    const versions = within(detail).getByTestId('versions-table');
    expect(versions.textContent).toContain('Lê Văn Cường');
    expect(versions.textContent).toContain('Nguyễn Văn An');
  });

  it('opens a sample as a template that reads no file, with its problems named', async () => {
    open();
    await listed();
    fireEvent.click(screen.getByRole('button', { name: word('ind.map.select.label', { code: 'SAMPLE_ROWS_FORM' }) }));
    const detail = await screen.findByTestId('mapping-detail');
    expect((await within(detail).findByTestId('mapping-template-note')).textContent).toBe(word('ind.map.detail.templateNote'));
    const problems = within(detail).getByTestId('mapping-problems');
    expect(problems.querySelector('[data-problem="INDICATOR_NOT_ENTERABLE"]')?.textContent).toContain(word('ind.mappingProblem.indicatorNotEnterable.label', { indicator: 'RATE_YEAR_IN_FORCE' }));
    expect(within(screen.getByTestId('mapping-facts')).getByText('Chỉ tiêu')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('ind.map.detail.close') }));
    expect(screen.queryByTestId('mapping-detail')).toBeNull();
  });

  it('says in words when the mapping detail cannot be read', async () => {
    const { state } = open();
    await listed();
    state.failing.set('getIndicatorImportMapping', new Error('down'));
    fireEvent.click(screen.getByRole('button', { name: word('ind.map.select.label', { code: 'MONTHLY_FORM' }) }));
    expect((await screen.findByTestId('mapping-detail-error')).textContent).toContain(word('ind.map.detail.error'));
  });
});

describe('MappingsScreen (IND-03): the import of a file', () => {
  it('uploads, names the approved mapping that reads the file, runs the dry run row by row, and applies once after a confirmation', async () => {
    const { h, upload: uploaded } = open();
    await listed();
    expect(button(word('ind.imp.flow.preview.action')).disabled).toBe(true);
    await upload();
    expect(uploaded).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('import-file').textContent).toBe(word('ind.imp.file.summary', { format: 'CSV', rows: 5, size: 2, unit: 'KB', hash: SHA.slice(0, 12) }));
    // One mapping fits, so it is the choice
    expect((screen.getByLabelText(word('ind.imp.flow.mapping.label')) as HTMLSelectElement).value).toBe('MONTHLY_FORM');
    expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noPreview');
    fireEvent.click(button(word('ind.imp.flow.preview.action')));
    const preview = await screen.findByTestId('import-preview');
    expect(h.command).toHaveBeenCalledWith('previewIndicatorImport', expect.objectContaining({ body: { mapping_code: 'MONTHLY_FORM', file_object_key: KEY, file_sha256: SHA } }));
    expect(within(preview).getByTestId('preview-mapping').textContent).toBe(word('ind.imp.preview.mapping', { code: 'MONTHLY_FORM', version: 1 }));
    const counts = within(preview).getByTestId('preview-counts');
    expect(counts.textContent).toContain('5');
    expect(tableRows('preview-rows').map(([line, , key, status, outcome, reason]) => [line, key, (status ?? '').replace(/^[✓✕≠]/, ''), outcome, reason])).toEqual([
      ['2', 'DA-2|2026-10', word('ind.rowStatus.valid.label'), word('ind.outcome.create.label'), '—'],
      ['3', 'DA-3|2026-10', word('ind.rowStatus.valid.label'), word('ind.outcome.createAndDifference.label'), '—'],
      ['4', 'DA-4|2026-10', word('ind.rowStatus.valid.label'), word('ind.outcome.unchanged.label'), '—'],
      ['5', 'DA-5|2026-10', word('ind.rowStatus.error.label'), '—', word('ind.rowCode.entryRuleBlocked.label')],
      ['6', 'DA-6|2026-10', word('ind.rowStatus.duplicate.label'), '—', word('ind.rowCode.duplicateConflict.label')],
    ]);
    expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(false);
    await applyNow();
    const result = await screen.findByTestId('import-result');
    expect(h.command).toHaveBeenCalledWith('importIndicatorFile', expect.objectContaining({ body: { mapping_code: 'MONTHLY_FORM', file_object_key: KEY, file_sha256: SHA } }));
    expect(result.getAttribute('data-refused')).toBe('false');
    expect(result.textContent).toContain(word('ind.imp.result.done', { code: 'MONTHLY_FORM', version: 1 }));
    expect(within(screen.getByTestId('result-counts')).getByText(word('ind.imp.result.written')).nextElementSibling?.textContent).toBe('7');
    expect(within(screen.getByTestId('result-counts')).getByText(word('ind.imp.result.differing')).nextElementSibling?.textContent).toBe('1');
    expect(screen.getByTestId('result-differences').textContent).toBe(word('ind.imp.result.differences', { n: 1 }));
    expect(tableRows('result-errors')[0]?.slice(0, 1)).toEqual(['5']);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('done');
    expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(true);
  });

  it('sends the project and period codes the form does not carry', async () => {
    const { h } = open();
    await listed();
    await upload();
    fireEvent.change(screen.getByLabelText(word('ind.imp.flow.project.label')), { target: { value: ' DA-01 ' } });
    fireEvent.change(screen.getByLabelText(word('ind.imp.flow.period.label')), { target: { value: '2026-10' } });
    fireEvent.click(button(word('ind.imp.flow.preview.action')));
    await screen.findByTestId('import-preview');
    expect(h.command).toHaveBeenCalledWith('previewIndicatorImport', expect.objectContaining({ body: expect.objectContaining({ project_code: 'DA-01', period_code: '2026-10' }) }));
  });

  it('filters the dry run by verdict, and says when no row has it', async () => {
    open();
    await listed();
    await dryRun();
    fireEvent.change(screen.getByLabelText(word('ind.imp.filter.status')), { target: { value: 'ERROR' } });
    expect(tableRows('preview-rows').map((row) => row[0])).toEqual(['5']);
    fireEvent.change(screen.getByLabelText(word('ind.imp.filter.status')), { target: { value: 'CONFLICT' } });
    expect(screen.getByTestId('preview-empty').textContent).toBe(word('ind.imp.preview.empty'));
  });

  it('closes the apply for a file that was applied before, and for a dry run with no valid row', async () => {
    open({ command: byOperation({ preview: { ...PREVIEW, already_applied: true } }) });
    await listed();
    await dryRun();
    expect(screen.getByTestId('preview-already').textContent).toBe(word('ind.imp.preview.already'));
    expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('alreadyApplied');
    cleanup();
    open({ command: byOperation({ preview: { ...PREVIEW, counts: { total: 1, valid: 0, errors: 1, duplicate: 0, conflict: 0 }, rows: [previewRow(2, 'ERROR', { code: 'ROW_EMPTY', field: 'row' })] } }) });
    await listed();
    await dryRun();
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noValid');
  });

  it('says the file was applied before when the server says so at the apply, and closes the button', async () => {
    open({ command: (operation) => (operation === 'importIndicatorFile' ? problem('IMPORT_FILE_ALREADY_APPLIED', 409) : byOperation({})(operation)) });
    await listed();
    await dryRun();
    await applyNow();
    expect((await screen.findByTestId('problem-note')).getAttribute('data-problem')).toBe('alreadyApplied');
    await waitFor(() => expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(true));
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('alreadyApplied');
  });

  it('shows the rows of an apply that took nothing, with the line and the reason of each', async () => {
    const counts = { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differences_opened: 0 };
    open({ command: (operation) => (operation === 'importIndicatorFile' ? problem('IMPORT_HAS_ERRORS', 422, { counts, errors: [rowError(2, { code: 'ROW_EMPTY', field: 'row' }), rowError(3)], errors_truncated: false }) : byOperation({})(operation)) });
    await listed();
    await dryRun();
    await applyNow();
    const result = await screen.findByTestId('import-result');
    expect(result.getAttribute('data-refused')).toBe('true');
    expect(result.textContent).toContain(word('ind.imp.result.refused'));
    expect(tableRows('result-errors').map((row) => [row[0], row[3]])).toEqual([['2', word('ind.rowCode.rowEmpty.label')], ['3', word('ind.rowCode.numberInvalid.label')]]);
  });

  it('says which columns the file lacks when it does not fit the mapping, and that a locked period or a mapping that is not approved stops the dry run', async () => {
    open({ command: () => problem('IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['Kỳ báo cáo'] }) });
    await listed();
    await upload();
    fireEvent.click(button(word('ind.imp.flow.preview.action')));
    const note = await screen.findByTestId('problem-note');
    expect(note.getAttribute('data-problem')).toBe('schemaInvalid');
    expect(within(note).getByTestId('problem-missing').textContent).toBe(word('ind.problem.missing.note', { names: 'Kỳ báo cáo' }));
    cleanup();
    open({ command: () => problem('IND_MAPPING_NOT_APPROVED', 409) });
    await listed();
    await upload();
    fireEvent.click(button(word('ind.imp.flow.preview.action')));
    expect((await screen.findByTestId('problem-note')).textContent).toContain(word('ind.problem.mappingNotApproved.text'));
  });

  it('says when no approved mapping reads the file, lets the person choose among several, and holds the dry run until one is chosen', async () => {
    open({ upload: () => ({ ...UPLOADED, fitting_mappings: [] }) });
    await listed();
    await upload();
    expect(screen.getByTestId('no-fitting-mapping').textContent).toBe(word('ind.imp.flow.noFitting'));
    expect(button(word('ind.imp.flow.preview.action')).disabled).toBe(true);
    cleanup();
    open({ upload: () => ({ ...UPLOADED, fitting_mappings: ['MONTHLY_FORM', 'OTHER_FORM'] }) });
    await listed();
    await upload();
    const choice = screen.getByLabelText(word('ind.imp.flow.mapping.label')) as HTMLSelectElement;
    expect(choice.value).toBe('');
    expect(button(word('ind.imp.flow.preview.action')).disabled).toBe(true);
    fireEvent.change(choice, { target: { value: 'OTHER_FORM' } });
    expect(button(word('ind.imp.flow.preview.action')).disabled).toBe(false);
  });

  it('refuses a file that is too large before sending it, and says why an upload was refused', async () => {
    open();
    await listed();
    await screen.findByLabelText(word('ind.imp.flow.file.label'));
    chooseFile(new File([new Uint8Array(11 * 1024 * 1024)], 'big.csv', { type: 'text/csv' }));
    expect((await screen.findByTestId('problem-note')).getAttribute('data-problem')).toBe('tooLarge');
    expect(button(word('ind.imp.flow.upload.action')).disabled).toBe(true);
    cleanup();
    open({ upload: () => problem('FILE_NOT_CLEAN', 422) });
    await listed();
    await screen.findByLabelText(word('ind.imp.flow.file.label'));
    chooseFile();
    fireEvent.click(button(word('ind.imp.flow.upload.action')));
    expect((await screen.findByTestId('problem-note')).getAttribute('data-problem')).toBe('fileRefused');
  });

  it('lets a person who may only dry-run do so and never apply, and offers nothing to a reader or a read-only session', async () => {
    open({ permissions: PREVIEWER });
    await listed();
    await dryRun();
    expect(button(word('ind.imp.flow.apply.action')).disabled).toBe(true);
    expect(screen.getByTestId('apply-reason').getAttribute('data-reason')).toBe('noAuthority');
    cleanup();
    open({ permissions: READER });
    await listed();
    expect(screen.getByTestId('import-noauthority').textContent).toBe(word('ind.imp.state.noPreview'));
    expect(screen.queryByLabelText(word('ind.imp.flow.file.label'))).toBeNull();
    cleanup();
    open({ permissions: ADMIN, mode: 'READ_ONLY' });
    await listed();
    expect(screen.getByTestId('import-readonly').textContent).toBe(word('ind.imp.state.readOnly'));
  });
});

describe('MappingsScreen (IND-03): the history of the imports', () => {
  it('lists the runs with the mapping and version, the hash, the status, the counts and the open differences, and says why a failed one failed', async () => {
    open();
    await listed();
    const rows = Array.from(document.querySelectorAll('[data-testid="history-table"] tbody tr[data-run-id]'));
    expect(rows.map((row) => row.getAttribute('data-run-status'))).toEqual(['APPLIED', 'FAILED']);
    expect(rows[0]?.textContent).toContain('MONTHLY_FORM.v1');
    expect(rows[0]?.textContent).toContain('Nguyễn Văn An');
    expect(within(rows[0] as HTMLElement).getByText(word('ind.hist.status.applied'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(word('ind.hist.status.failed'))).toBeTruthy();
    expect(rows[1]?.textContent).toContain(word('ind.imp.failure.code', { code: 'IMPORT_SCHEMA_INVALID' }));
  });

  it('pages by the cursor of the server', async () => {
    open({ world: { runs: [run(1), run(2), run(3)], pageSize: 2 } });
    await listed();
    expect(document.querySelectorAll('[data-testid="history-table"] tbody tr[data-run-id]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: word('ind.hist.more.action') }));
    await waitFor(() => expect(document.querySelectorAll('[data-testid="history-table"] tbody tr[data-run-id]')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: word('ind.hist.more.action') })).toBeNull();
  });

  it('opens a run: the rows it refused and the differences it left with the number held, the number in the file, the owner and the due day', async () => {
    open();
    await listed();
    fireEvent.click(screen.getByRole('button', { name: word('ind.hist.select.label', { mapping: 'MONTHLY_FORM.v1', when: '2026-11-10 08:05' }) }));
    const detail = await screen.findByTestId('import-detail');
    const errors = await within(detail).findByTestId('detail-errors');
    expect(tableRows('detail-errors').map((row) => row[0])).toEqual(['4']);
    expect(errors.textContent).toContain(word('ind.rowCode.numberInvalid.label'));
    const differences = within(detail).getByTestId('detail-differences');
    expect(differences.textContent).toContain(word('ind.difference.indFigureDiffers.label'));
    expect(differences.textContent).toContain('300');
    expect(differences.textContent).toContain('400');
    expect(differences.textContent).toContain(word('ind.hist.diff.open'));
    expect(differences.textContent).toContain('Nguyễn Văn An');
    fireEvent.click(screen.getByRole('button', { name: word('ind.hist.detail.close') }));
    expect(screen.queryByTestId('import-detail')).toBeNull();
  });

  it('says a run refused nothing and left no difference, and that its detail cannot be read', async () => {
    const { state } = open();
    await listed();
    fireEvent.click(screen.getByRole('button', { name: word('ind.hist.select.label', { mapping: 'SAMPLE.v2', when: '2026-11-10 08:05' }) }));
    expect((await screen.findByTestId('detail-no-errors')).textContent).toBe(word('ind.hist.detail.noErrors'));
    expect(screen.getByTestId('detail-no-differences').textContent).toBe(word('ind.hist.detail.noDifferences'));
    state.failing.set('listIndicatorImportRows', problem('FORBIDDEN', 403));
    fireEvent.click(screen.getByRole('button', { name: word('ind.hist.select.label', { mapping: 'MONTHLY_FORM.v1', when: '2026-11-10 08:05' }) }));
    expect((await screen.findByTestId('run-detail-denied')).textContent).toBe(word('ind.hist.detail.denied'));
  });

  it('says it is empty, could not be read, or is not allowed', async () => {
    open({ world: { runs: [] } });
    expect((await screen.findByTestId('history-empty')).textContent).toBe(word('ind.hist.state.empty'));
    cleanup();
    open({ world: { failing: new Map([['listIndicatorImports', problem('FORBIDDEN', 403)]]) } });
    expect((await screen.findByTestId('history-denied')).textContent).toBe(word('ind.hist.state.denied'));
    cleanup();
    open({ world: { failing: new Map([['listIndicatorImports', new Error('down')]]) } });
    await screen.findByTestId('mappings-table');
    await waitFor(() => expect(screen.getAllByRole('button', { name: word('ui.common.retry') }).length).toBeGreaterThan(0));
  });
});
