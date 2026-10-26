import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReportImportScreen from './ReportImportScreen';
import { IMPORTER, MAKER, PERIOD, client, mount, period, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-10', 'FR-DIS-10');
const BATCH = '00000000-0000-4000-8000-0000000000c1';
const STORED = { file_object_key: 'tenants/t/import/weekly', file_sha256: 'c'.repeat(64), size_bytes: 2048, format: 'XLSX', columns: ['project_code', 'cy_central', 'cy_local'], row_count: 20 };

afterEach(cleanup);

const batchRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: BATCH,
  period_id: PERIOD,
  file_sha256: 'c'.repeat(64),
  mapping_version: 'DIS-WEEKLY-1',
  status: 'DRY_RUN',
  total_rows: 20,
  valid_rows: 18,
  error_rows: 2,
  errors: [
    { line: 5, project_code: 'NO-SUCH', field: 'project_code', code: 'PROJECT_NOT_FOUND' },
    { line: 9, project_code: 'DA-2027-009', field: 'cy_central_ctmtqg', code: 'SUBSET_EXCEEDS_PARENT' },
  ],
  drafts_created: 0,
  drafts_updated: 0,
  applied_at: null,
  applied_by: null,
  created_at: '2027-01-05T03:00:00.000Z',
  created_by: '00000000-0000-4000-8000-000000000001',
  version: 1,
  ...over,
});
const validated = (over: Record<string, unknown> = {}) => batchRecord({ status: 'VALIDATED', valid_rows: 20, error_rows: 0, errors: [], ...over });

const open = (options: { path?: string; batch?: Record<string, unknown>; permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown; upload?: () => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = client(world({ imports: options.batch === undefined ? {} : { [BATCH]: options.batch } }), options.command ?? (() => ({ status: 'DRY_RUN', resource_version: 1, resource_id: BATCH })));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? STORED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<ReportImportScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : IMPORTER, path: options.path ?? '/dis/dis-10', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, upload };
};
const pickFile = async (name = 'weekly_w40.xlsx'): Promise<void> => {
  const input = (await screen.findByLabelText(vi_['dis.reportImport.file.label'])) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] } });
};
const sent = (h: { command: { mock: { calls: unknown[][] } } }, call = 0) => h.command.mock.calls[call] as [string, { body?: Record<string, unknown>; path?: { id: string }; ifMatchVersion?: number }];

describe('DIS-10 bulk import of weekly reports', () => {
  it('AC-ST-DIS-008-1 / UI-DIS-10: uploads the workbook, shows how many rows and columns it has, and runs the dry run for the period chosen with the layout named', async () => {
    const user = userEvent.setup();
    const { h, upload } = open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reportImport.page.title'] })).toBeTruthy();
    expect(((await screen.findByLabelText(vi_['dis.reportImport.mapping.label'])) as HTMLSelectElement).disabled).toBe(true);
    // Nothing is sent before the file and the period are chosen.
    await user.click(screen.getByRole('button', { name: vi_['dis.reportImport.check.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByText(vi_['dis.reportImport.period.required.error'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportImport.file.required.error'])).toBeTruthy();
    await pickFile();
    expect((await screen.findByTestId('import-stored')).textContent).toBe('weekly_w40.xlsx: 20 dòng, 3 cột.');
    expect(upload).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.year.label']), '2027');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.period.label']), PERIOD);
    await user.click(screen.getByRole('button', { name: vi_['dis.reportImport.check.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['createReportImport', expect.objectContaining({ body: { period_id: PERIOD, file_object_key: STORED.file_object_key, file_sha256: STORED.file_sha256, mapping_version: 'DIS-WEEKLY-1' } })]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-10?import=${BATCH}`));
  });

  it('AC-ST-DIS-008-1: tells the error rows of a dry run with the line, the project, the column and the reason, counts them, and does not let the file be applied', async () => {
    const { h } = open({ path: `/dis/dis-10?import=${BATCH}`, batch: batchRecord() });
    expect((await screen.findByTestId('import-status')).textContent).toBe(vi_['dis.reportImport.status.dryRun']);
    expect([screen.getByTestId('count-total').textContent, screen.getByTestId('count-valid').textContent, screen.getByTestId('count-error').textContent]).toEqual(['20', '18', '2']);
    const table = screen.getByTestId('faults');
    const rows = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['5', 'NO-SUCH', 'project_code', vi_['dis.reportImport.fault.projectNotFound']],
      ['9', 'DA-2027-009', 'cy_central_ctmtqg', vi_['dis.reportImport.fault.subsetExceeds']],
    ]);
    const apply = screen.getByRole('button', { name: vi_['dis.reportImport.apply.action'] }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByText(vi_['dis.reportImport.apply.blocked.text'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('filters the errors by kind and by the project code, and says how many of them are shown', async () => {
    const user = userEvent.setup();
    open({ path: `/dis/dis-10?import=${BATCH}`, batch: batchRecord() });
    await screen.findByTestId('faults');
    expect(screen.getByTestId('faults-shown').textContent).toBe('Hiển thị 2 trên 2 lỗi.');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.faults.code.label']), 'SUBSET_EXCEEDS_PARENT');
    expect(within(screen.getByTestId('faults')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByTestId('faults-shown').textContent).toBe('Hiển thị 1 trên 2 lỗi.');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.faults.code.label']), '');
    await user.type(screen.getByLabelText(vi_['dis.reportImport.faults.project.label']), 'no-such');
    expect(screen.getByTestId('faults-shown').textContent).toBe('Hiển thị 1 trên 2 lỗi.');
    expect(within(screen.getByTestId('faults')).getByText('NO-SUCH')).toBeTruthy();
  });

  it('applies a file without a fault under the version the screen showed, and then says what was made, with no way to apply it again', async () => {
    const user = userEvent.setup();
    let batch = validated();
    const { h } = open({ path: `/dis/dis-10?import=${BATCH}`, batch, command: () => ({ status: 'APPLIED', resource_version: 2, resource_id: BATCH }) });
    expect((await screen.findByTestId('import-status')).textContent).toBe(vi_['dis.reportImport.status.validated']);
    expect(screen.getByTestId('faults-none').textContent).toBe(vi_['dis.reportImport.faults.none.text']);
    await user.click(screen.getByRole('button', { name: vi_['dis.reportImport.apply.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['applyReportImport', expect.objectContaining({ path: { id: BATCH }, ifMatchVersion: 1 })]);
    batch = validated({ status: 'APPLIED', version: 2, drafts_created: 20, drafts_updated: 0 });
    cleanup();
    open({ path: `/dis/dis-10?import=${BATCH}`, batch });
    expect((await screen.findByTestId('import-status')).textContent).toBe(vi_['dis.reportImport.status.applied']);
    expect([screen.getByTestId('count-created').textContent, screen.getByTestId('count-updated').textContent]).toEqual(['20', '0']);
    expect(screen.queryByRole('button', { name: vi_['dis.reportImport.apply.action'] })).toBeNull();
    expect(screen.getByRole('link', { name: vi_['dis.reportImport.applied.link'] }).getAttribute('href')).toBe('/dis/dis-01');
  });

  it('AC-ST-DIS-008-1: tells in words that the file was applied already, that errors came up since the dry run, that the period is locked, and that the version moved', async () => {
    const user = userEvent.setup();
    let failure = new ApiError({ status: 409, code: 'IMPORT_FILE_ALREADY_APPLIED', correlationId: 'c' });
    open({ path: `/dis/dis-10?import=${BATCH}`, batch: validated(), command: () => failure });
    const apply = await screen.findByRole('button', { name: vi_['dis.reportImport.apply.action'] });
    for (const [code, status, key] of [
      ['IMPORT_FILE_ALREADY_APPLIED', 409, 'alreadyApplied'],
      ['IMPORT_HAS_ERRORS', 422, 'hasErrors'],
      ['PERIOD_LOCKED', 409, 'periodLocked'],
      ['VERSION_CONFLICT', 409, 'versionConflict'],
      ['SCOPE_DENIED', 403, 'scopeDenied'],
    ] as const) {
      failure = new ApiError({ status, code, correlationId: 'c' });
      await user.click(apply);
      await waitFor(() => expect(screen.getByTestId('apply-refusal').textContent).toBe(vi_[`dis.reportImport.problem.${key}`]));
    }
  });

  it('tells in words why a file is refused at the upload door or at the dry run: infected, not a table, not the layout, a layout that is not known, a file already applied', async () => {
    const user = userEvent.setup();
    let uploadFailure: Error | undefined = new ApiError({ status: 422, code: 'FILE_NOT_CLEAN', correlationId: 'c' });
    let createFailure: Error = new ApiError({ status: 422, code: 'IMPORT_SCHEMA_INVALID', correlationId: 'c' });
    open({ command: () => createFailure, upload: () => uploadFailure ?? STORED });
    await pickFile();
    expect((await screen.findByTestId('import-refusal')).textContent).toBe(vi_['dis.reportImport.problem.fileInfected']);
    uploadFailure = new ApiError({ status: 422, code: 'FILE_TYPE_NOT_ALLOWED', correlationId: 'c' });
    await pickFile('weekly.pdf');
    await waitFor(() => expect(screen.getByTestId('import-refusal').textContent).toBe(vi_['dis.reportImport.problem.fileType']));
    uploadFailure = undefined;
    await pickFile();
    await screen.findByTestId('import-stored');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.year.label']), '2027');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportImport.period.label']), PERIOD);
    for (const [code, status, key] of [
      ['IMPORT_SCHEMA_INVALID', 422, 'schemaInvalid'],
      ['MAPPING_VERSION_UNKNOWN', 422, 'mappingUnknown'],
      ['IMPORT_FILE_ALREADY_APPLIED', 409, 'alreadyApplied'],
    ] as const) {
      createFailure = new ApiError({ status, code, correlationId: 'c' });
      await user.click(screen.getByRole('button', { name: vi_['dis.reportImport.check.action'] }));
      await waitFor(() => expect(screen.getByTestId('import-refusal').textContent).toBe(vi_[`dis.reportImport.problem.${key}`]));
    }
  });

  it('offers the weeks of the year and no other kind of period', async () => {
    const h = client(world({ periods: [period(PERIOD, '2027-W01', 'OPEN'), { ...period('00000000-0000-4000-8000-004200000009', '2027-M01', 'OPEN'), period_type: 'MONTH' }] }));
    mount(<ReportImportScreen route={ROUTE} />, h, { permissions: IMPORTER, path: '/dis/dis-10' });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText(vi_['dis.reportImport.year.label']), '2027');
    const options = within(screen.getByLabelText(vi_['dis.reportImport.period.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual([vi_['dis.reportImport.period.choose.option'], '2027-W01']);
  });

  it('is not offered to a person who may not import, and the page of a batch that is not there is told as empty', async () => {
    open({ permissions: MAKER });
    expect((await screen.findByTestId('import-denied')).textContent).toBe(vi_['dis.reportImport.denied.note']);
    expect((screen.getByLabelText(vi_['dis.reportImport.file.label']) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: vi_['dis.reportImport.check.action'] }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    open({ path: `/dis/dis-10?import=${BATCH}`, batch: undefined });
    await screen.findByTestId('import-form');
    await waitFor(() => expect(screen.queryByTestId('import-batch')).toBeNull());
  });
});
