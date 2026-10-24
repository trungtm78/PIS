import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { NationalCodeImportPanel } from './NationalCodeImportPanel';
import { harness } from '../sas/test-support';
import { mount } from './test-support';

const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa';
const SHA = 'a'.repeat(64);
const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 120, format: 'csv', columns: ['internal_code', 'national_project_code'], row_count: 3 };
const PREVIEW = {
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  dry_run: true,
  adapter: { connector_code: 'NATIONAL_PIM_FILE', format_version: 'WORKING-ASSUMPTION-2026.1', status: 'PROPOSED' },
  file_sha256: SHA,
  already_applied: false,
  counts: { total: 3, valid: 2, duplicate: 0, conflict: 0, errors: 1 },
  rows: [
    { line: 2, internal_code: 'DA-001', status: 'VALID', outcome: 'ASSIGN', preview: { internal_code: 'DA-001', national_project_code: '7000001' } },
    { line: 3, internal_code: 'DA-002', status: 'VALID', outcome: 'MISMATCH', preview: { internal_code: 'DA-002', national_project_code: '7000002' } },
    { line: 4, internal_code: 'DA-003', status: 'ERROR', code: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code', preview: { internal_code: 'DA-003', national_project_code: '7000001' } },
  ],
  rows_truncated: false,
};
const APPLIED = {
  operation_id: 'o',
  status: 'APPLIED',
  resource_version: 1,
  resource_id: 'i',
  dry_run: false,
  adapter: { status: 'PROPOSED' },
  counts: { total: 3, applied: 2, duplicate: 0, conflict: 0, quarantined: 1, differencesOpened: 1 },
  assigned: 1,
  errors: [{ line: 4, internal_code: 'DA-003', code: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code', preview: { internal_code: 'DA-003', national_project_code: '7000001' } }],
  errors_truncated: false,
};
const problem = (code: string, status: number, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(cleanup);

function panel(options: { command?: (operation: string, input: unknown) => unknown; upload?: () => unknown; canImport?: boolean; wholeTenant?: boolean | undefined } = {}) {
  const h = harness(() => new Error('no read'), options.command ?? ((_operation, input) => ((input as { body: { dry_run: boolean } }).body.dry_run ? PREVIEW : APPLIED)));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<NationalCodeImportPanel canImport={options.canImport ?? true} wholeTenant={'wholeTenant' in options ? options.wholeTenant : true} />, h, { permissions: ['project.national_code.manage'] });
  return { h, upload };
}

const choose = (): void => {
  const input = screen.getByLabelText(vi_['prj.reconcile.import.file.label']) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['internal_code,national_project_code\nDA-001,7000001'], 'national_codes.csv', { type: 'text/csv' })] } });
};
const check = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.import.check.action'] }));
};

describe('NationalCodeImportPanel (PRJ-21): the reconciliation file', () => {
  it('AC-ST-PRJ-004-2: uploads the file, shows the dry run row by row with the row error, and applies it once', async () => {
    const { h, upload } = panel();
    expect(screen.getByRole('button', { name: vi_['prj.reconcile.import.check.action'] })).toHaveProperty('disabled', true);
    choose();
    check();
    await screen.findByTestId('import-rows');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('importNationalProjectCodes', expect.objectContaining({ body: { file_object_key: KEY, file_sha256: SHA, dry_run: true } }));
    expect(screen.getByTestId('import-file').textContent).toBe(vi_['prj.reconcile.import.file.text'].replace('{rows}', '3').replace('{format}', 'CSV'));
    expect(screen.getByTestId('import-counts').textContent).toBe(vi_['prj.reconcile.import.preview.counts'].replace('{total}', '3').replace('{valid}', '2').replace('{repeats}', '0').replace('{errors}', '1'));
    const rows = Array.from(document.querySelectorAll('[data-line]')).map((row) => [row.getAttribute('data-line'), row.getAttribute('data-status'), ...Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)]);
    expect(rows).toEqual([
      ['2', 'VALID', 'DA-001', '7000001', vi_['prj.reconcile.importRow.assign.text']],
      ['3', 'VALID', 'DA-002', '7000002', vi_['prj.reconcile.importRow.mismatch.text']],
      ['4', 'ERROR', 'DA-003', '7000001', vi_['prj.reconcile.importRow.duplicate.text']],
    ]);
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.import.apply.action'] }));
    await screen.findByTestId('import-applied');
    expect(h.command).toHaveBeenLastCalledWith('importNationalProjectCodes', expect.objectContaining({ body: { file_object_key: KEY, file_sha256: SHA, dry_run: false } }));
    expect(screen.getByTestId('import-counts').textContent).toBe(vi_['prj.reconcile.import.applied.counts'].replace('{assigned}', '1').replace('{errors}', '1').replace('{differences}', '1'));
    expect(within(screen.getByTestId('import-rows')).getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: vi_['prj.reconcile.import.apply.action'] })).toBeNull();
  });

  it('AC-ST-PRJ-004-2: a file that was applied before is told so and cannot be applied again', async () => {
    panel({ command: () => ({ ...PREVIEW, already_applied: true, counts: { total: 3, valid: 0, duplicate: 2, conflict: 0, errors: 1 } }) });
    choose();
    check();
    expect((await screen.findByTestId('import-already')).textContent).toBe(vi_['prj.reconcile.import.already.notice']);
    expect(screen.getByRole('button', { name: vi_['prj.reconcile.import.apply.action'] })).toHaveProperty('disabled', true);
  });

  it('AC-ST-PRJ-004-2: a refusal of the apply is told with its reason, and IMPORT_HAS_ERRORS lists the lines that failed', async () => {
    const { h } = panel({
      command: (_operation, input) =>
        (input as { body: { dry_run: boolean } }).body.dry_run
          ? PREVIEW
          : problem('IMPORT_HAS_ERRORS', 422, {
              counts: { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differencesOpened: 0 },
              errors: [
                { line: 2, internal_code: 'NO-1', code: 'PROJECT_NOT_FOUND', field: 'internal_code', preview: { internal_code: 'NO-1', national_project_code: '7000001' } },
                { line: 3, internal_code: 'NO-2', code: 'PROJECT_NOT_FOUND', field: 'internal_code', preview: { internal_code: 'NO-2', national_project_code: '7000002' } },
              ],
            }),
    });
    choose();
    check();
    await screen.findByTestId('import-rows');
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.import.apply.action'] }));
    expect((await screen.findByTestId('import-problem')).textContent).toBe(vi_['prj.reconcile.importProblem.hasErrors.error']);
    expect(document.querySelectorAll('[data-status="ERROR"]')).toHaveLength(2);
    expect(within(screen.getByTestId('import-rows')).getAllByText(vi_['prj.reconcile.importRow.notFound.text'])).toHaveLength(2);
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('tells why the file was refused: hash, layout, empty, a file that is not clean, a project that moved, nothing readable', async () => {
    const cases: Array<[Error, string]> = [
      [problem('IMPORT_FILE_ALREADY_APPLIED', 409), 'prj.reconcile.importProblem.alreadyApplied.error'],
      [problem('HASH_MISMATCH', 422), 'prj.reconcile.importProblem.hashMismatch.error'],
      [problem('IMPORT_SCHEMA_INVALID', 422), 'prj.reconcile.importProblem.schemaInvalid.error'],
      [problem('IMPORT_EMPTY', 422), 'prj.reconcile.importProblem.empty.error'],
      [problem('FILE_NOT_CLEAN', 422), 'prj.reconcile.importProblem.fileRefused.error'],
      [problem('VERSION_CONFLICT', 409), 'prj.reconcile.importProblem.versionConflict.error'],
      [problem('RESOURCE_NOT_FOUND', 404), 'prj.reconcile.importProblem.notFound.error'],
      [problem('SCOPE_DENIED', 403), 'prj.reconcile.importProblem.denied.error'],
      [problem('OTHER', 500), 'prj.reconcile.importProblem.general.error'],
    ];
    for (const [error, key] of cases) {
      panel({ upload: () => error });
      choose();
      check();
      expect((await screen.findByTestId('import-problem')).textContent).toBe(vi_[key as keyof typeof vi_]);
      cleanup();
    }
    panel({ command: () => problem('IMPORT_SCHEMA_INVALID', 422) });
    choose();
    check();
    expect((await screen.findByTestId('import-problem')).textContent).toBe(vi_['prj.reconcile.importProblem.schemaInvalid.error']);
  });

  it('AC-ST-PRJ-004-2: a unit-scoped officer checks the file but cannot apply it: the notice says only the whole-tenant officer applies it, and no apply is sent', async () => {
    const { h } = panel({ wholeTenant: false });
    expect(screen.getByTestId('import-scope-notice').textContent).toBe(vi_['prj.reconcile.import.wholeTenant.notice']);
    choose();
    check();
    await screen.findByTestId('import-rows');
    expect(screen.queryByRole('button', { name: vi_['prj.reconcile.import.apply.action'] })).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('importNationalProjectCodes', expect.objectContaining({ body: { file_object_key: KEY, file_sha256: SHA, dry_run: true } }));
  });

  it('keeps the apply out of sight, without a notice, while it is not yet known whether the officer holds the permission on the whole tenant', async () => {
    panel({ wholeTenant: undefined });
    expect(screen.queryByTestId('import-scope-notice')).toBeNull();
    choose();
    check();
    await screen.findByTestId('import-rows');
    expect(screen.queryByRole('button', { name: vi_['prj.reconcile.import.apply.action'] })).toBeNull();
  });

  it('offers no file to someone who may not import, and starts over when another file is chosen', async () => {
    panel({ canImport: false });
    expect(screen.getByTestId('import-denied').textContent).toBe(vi_['prj.reconcile.import.denied.notice']);
    expect(screen.queryByLabelText(vi_['prj.reconcile.import.file.label'])).toBeNull();
    cleanup();
    panel();
    choose();
    check();
    await screen.findByTestId('import-rows');
    choose();
    await waitFor(() => expect(screen.queryByTestId('import-result')).toBeNull());
  });
});
