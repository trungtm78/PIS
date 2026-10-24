import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness } from '../sas/test-support';
import { ImportPanel } from './ImportPanel';
import { PROJECT, mount } from './test-support';

const FILE_ID = '00000000-0000-4000-8000-0000000000aa';
const SHA = 'a'.repeat(64);
const UPLOADED = { file_object_id: FILE_ID, file_sha256: SHA, size_bytes: 120, format: 'CSV', columns: ['parcel_code'], row_count: 3 };
const APPLIED = { operation_id: 'o', status: 'APPLIED', resource_version: 1, resource_id: 'i', result: 'APPLIED', duplicate: false, row_total: 3, row_created: 3, row_duplicate: 0, row_conflict: 0, row_refused: 0 };
const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

afterEach(cleanup);

function panel(options: { command?: (operation: string, input: unknown) => unknown; upload?: () => unknown; canImport?: boolean } = {}) {
  const h = harness(() => new Error('no read'), options.command ?? (() => APPLIED));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<ImportPanel projectId={PROJECT} canImport={options.canImport ?? true} />, h, { permissions: ['land.manage'] });
  return { h, upload };
}

const choose = (): void => {
  const input = screen.getByLabelText(vi_['lnd.import.file.label']) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['parcel_code\nTB-1'], 'parcels.csv', { type: 'text/csv' })] } });
};
const check = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['lnd.import.check.action'] }));
};
const run = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['lnd.import.run.action'] }));
};

describe('ImportPanel (the parcel list of LND-02, AC-ST-LND-001-2, UAT-PLAN-28)', () => {
  it('AC-ST-LND-001-2: tells that a parcel carries no owner, uploads the file, and imports it once into the project', async () => {
    const { h, upload } = panel();
    expect(screen.getByTestId('import-privacy').textContent).toBe(vi_['lnd.import.privacy.note']);
    expect((screen.getByRole('button', { name: vi_['lnd.import.check.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: vi_['lnd.import.run.action'] }) as HTMLButtonElement).disabled).toBe(true);
    choose();
    check();
    expect((await screen.findByTestId('import-layout')).textContent).toBe(vi_['lnd.import.stored.text'].replace('{rows}', '3').replace('{format}', 'CSV'));
    expect(upload).toHaveBeenCalledTimes(1);
    run();
    const result = await screen.findByTestId('import-result');
    expect(result.getAttribute('data-outcome')).toBe('APPLIED');
    expect(result.textContent).toBe(vi_['lnd.import.result.applied.text'].replace('{created}', '3').replace('{total}', '3'));
    expect(h.command).toHaveBeenCalledWith('importLandParcels', expect.objectContaining({ body: { project_id: PROJECT, file_object_id: FILE_ID, file_sha256: SHA } }));
    expect((screen.getByRole('button', { name: vi_['lnd.import.run.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('AC-ST-LND-001-2: says that the same file again created nothing', async () => {
    panel({ command: () => ({ ...APPLIED, status: 'ALREADY_IMPORTED', result: 'ALREADY_IMPORTED', duplicate: true }) });
    choose();
    check();
    await screen.findByTestId('import-layout');
    run();
    expect((await screen.findByTestId('import-result')).textContent).toBe(vi_['lnd.import.result.repeated.text'].replace('{created}', '3'));
  });

  it('reports the rows that were refused, repeated or in conflict', async () => {
    panel({ command: () => ({ ...APPLIED, status: 'PARTIALLY_APPLIED', result: 'PARTIALLY_APPLIED', row_total: 6, row_created: 1, row_duplicate: 1, row_conflict: 1, row_refused: 3 }) });
    choose();
    check();
    await screen.findByTestId('import-layout');
    run();
    expect((await screen.findByTestId('import-result')).textContent).toBe(
      vi_['lnd.import.result.partial.text'].replace('{created}', '1').replace('{total}', '6').replace('{refused}', '3').replace('{conflict}', '1').replace('{duplicate}', '1'),
    );
  });

  it('AC-ST-LND-001-2: names a column that a parcel must not carry and a column that is missing, keeps the file nowhere and offers no import', async () => {
    panel({ upload: () => problem('IMPORT_SCHEMA_INVALID', { unknown_columns: ['owner_name', 'phone'], missing_columns: ['land_use_group'] }) });
    choose();
    check();
    expect((await screen.findByTestId('import-unknown')).textContent).toBe(vi_['lnd.import.unknown.error'].replace('{columns}', 'owner_name, phone'));
    expect(screen.getByTestId('import-missing').textContent).toBe(vi_['lnd.import.missing.error'].replace('{columns}', 'land_use_group'));
    expect(screen.getByTestId('import-refusal').textContent).toBe(vi_['lnd.import.problem.schemaInvalid.error']);
    expect(screen.queryByTestId('import-layout')).toBeNull();
    expect((screen.getByRole('button', { name: vi_['lnd.import.run.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows only the missing columns when nothing else is wrong with the layout', async () => {
    panel({ upload: () => problem('IMPORT_SCHEMA_INVALID', { missing_columns: ['area_total_m2'] }) });
    choose();
    check();
    await screen.findByTestId('import-missing');
    expect(screen.queryByTestId('import-unknown')).toBeNull();
  });

  it('answers a refusal of the upload or of the import in words', async () => {
    panel({ upload: () => problem('FILE_NOT_CLEAN') });
    choose();
    check();
    expect((await screen.findByTestId('import-refusal')).textContent).toBe(vi_['lnd.import.problem.fileRefused.error']);
    cleanup();
    panel({
      command: () => {
        throw problem('IMPORT_SCHEMA_INVALID');
      },
    });
    choose();
    check();
    await screen.findByTestId('import-layout');
    run();
    expect((await screen.findByTestId('import-refusal')).textContent).toBe(vi_['lnd.import.problem.schemaInvalid.error']);
    cleanup();
    panel({
      command: () => {
        throw new Error('network');
      },
    });
    choose();
    check();
    await screen.findByTestId('import-layout');
    run();
    await waitFor(() => expect(screen.getByTestId('import-refusal').textContent).toBe(vi_['lnd.import.problem.general.error']));
  });

  it('does not send a second upload while one is running, and starts over when another file is chosen', async () => {
    const { upload } = panel();
    choose();
    check();
    await screen.findByTestId('import-layout');
    choose();
    expect(screen.queryByTestId('import-layout')).toBeNull();
    check();
    await screen.findByTestId('import-layout');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('offers nothing to a caller who may not import', () => {
    panel({ canImport: false });
    expect(screen.getByTestId('import-denied').textContent).toBe(vi_['lnd.import.denied.notice']);
    expect(screen.queryByLabelText(vi_['lnd.import.file.label'])).toBeNull();
  });
});
