import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterImportScreen from './MasterImportScreen';
import { ME, OTHER, PUBLISHER, READER, REVIEWER, batch, client, mount, routeOf, world } from './test-support';
import type { Harness, World } from './test-support';

const ROUTE = routeOf('MDM-29', 'FR-MDM-29');
const IMPORTER = ['master.import', 'master.read'];
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const FILE = {
  file_object_key: 'tenants/t/import/file-1',
  file_sha256: 'b'.repeat(64),
  size_bytes: 2048,
  format: 'CSV',
  columns: ['Mã', 'Tên', 'Từ ngày', 'Mã cha', 'Loại nguồn', 'Quan hệ', 'Ghi chú'],
  row_count: 10,
};
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

afterEach(cleanup);

/** The client of the screen with an upload that answers `answer`. */
function withUpload(state: World, command: (operation: string, input: unknown) => unknown = () => ({}), answer: unknown = FILE): { h: Harness; upload: ReturnType<typeof vi.fn> } {
  const h = client(state, command);
  const upload = vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  (h.client as unknown as { upload: unknown }).upload = upload;
  return { h, upload: upload as unknown as ReturnType<typeof vi.fn> };
}

/** The screen shows itself once the list of batches is read. */
const formReady = () => waitFor(() => expect(screen.getByLabelText(vi_['mdm.import.file.label'])).toBeTruthy());

const csvFile = (): File => new File(['Mã,Tên\nA,Alpha\n'], 'nguon-von.csv', { type: 'text/csv' });
const at = (id?: string): string => (id === undefined ? '/mdm/mdm-29' : `/mdm/mdm-29?batch=${id}`);

describe('MasterImportScreen (MDM-29): the file, the mapping and the dry run', () => {
  it('uploads the file, shows its columns, suggests the mapping from the headers and the type, and sends the dry run with it', async () => {
    const staged = batch(1, { mode: 'ATOMIC', total_rows: 10, error_rows: 2, errors: [{ row: 4, field: 'parent_key', code: 'INVALID_VALUE' }, { row: 7, field: 'business_key', code: 'DUPLICATE_KEY' }] });
    const state = world({ records: [], imports: [] });
    const { h, upload } = withUpload(state, (operation) => {
      if (operation === 'stageMasterImport') {
        state.imports.push(staged);
        return { operation_id: 'o1', status: 'VALIDATED', resource_version: 1, resource_id: staged.id };
      }
      return {};
    });
    mount(<MasterImportScreen route={ROUTE} />, h, IMPORTER, at());
    await formReady();
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.import.page.title']);
    expect(screen.getByRole('button', { name: vi_['mdm.import.upload.action'] })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.type.label']), { target: { value: 'FUND_SOURCE' } });
    await user.upload(screen.getByLabelText(vi_['mdm.import.file.label']), csvFile());
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.upload.action'] }));
    await waitFor(() => expect(screen.getByTestId('mapping')).toBeTruthy());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe('uploadMasterImportFile');
    expect(within(screen.getByTestId('file')).getByText('10')).toBeTruthy();
    expect(within(screen.getByTestId('file')).getByText('CSV · 2 KB')).toBeTruthy();
    expect(screen.getByTestId('file').textContent).toContain('Mã, Tên, Từ ngày, Mã cha, Loại nguồn, Quan hệ, Ghi chú');
    // The names that people use, and the attributes of the type, are found in the columns.
    expect((screen.getByLabelText(vi_['mdm.import.map.key.label']) as HTMLSelectElement).value).toBe('Mã');
    expect((screen.getByLabelText(vi_['mdm.import.map.label.label']) as HTMLSelectElement).value).toBe('Tên');
    expect((screen.getByLabelText(vi_['mdm.import.map.validFrom.label']) as HTMLSelectElement).value).toBe('Từ ngày');
    expect((screen.getByLabelText(vi_['mdm.import.map.parentKey.label']) as HTMLSelectElement).value).toBe('Mã cha');
    expect((screen.getByLabelText(vi_['mdm.import.map.validUntil.label']) as HTMLSelectElement).value).toBe('');
    // The columns that are not named like an attribute are chosen by hand.
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.map.attribute.label'].replace('{name}', 'category')), { target: { value: 'Loại nguồn' } });
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.map.attribute.label'].replace('{name}', 'relation')), { target: { value: 'Quan hệ' } });
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.check.action'] }));
    await waitFor(() => expect(screen.getByTestId('errors')).toBeTruthy());
    expect(h.command).toHaveBeenCalledWith(
      'stageMasterImport',
      expect.objectContaining({
        body: {
          master_type: 'FUND_SOURCE',
          file_object_key: FILE.file_object_key,
          file_sha256: FILE.file_sha256,
          mapping: { key: 'Mã', label: 'Tên', valid_from: 'Từ ngày', parent_key: 'Mã cha', attributes: { category: 'Loại nguồn', relation: 'Quan hệ' } },
          mode: 'ATOMIC',
        },
      }),
    );
    // The dry run is shown: the rows, each error with its row, its field and what is wrong with it.
    const errors = within(screen.getByTestId('errors'));
    expect(errors.getByText(vi_['mdm.import.error.invalidValue.text'])).toBeTruthy();
    expect(document.querySelector('[data-row="7"]')?.textContent).toBe(`7${vi_['mdm.import.field.key.text']}${vi_['mdm.import.error.duplicateKey.text']}`);
    expect(document.querySelector('[data-row="4"]')?.textContent).toContain(vi_['mdm.import.field.parent.text']);
    expect(screen.getByTestId('blocked').textContent).toBe(vi_['mdm.import.apply.blocked.notice']);
    expect(screen.getByRole('button', { name: vi_['mdm.import.apply.action'] })).toBeDisabled();
  });

  it('needs the three parts of an entry before the dry run, and a catalogue type', async () => {
    const { h } = withUpload(world());
    mount(<MasterImportScreen route={ROUTE} />, h, IMPORTER, at());
    await formReady();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(vi_['mdm.import.file.label']), csvFile());
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.upload.action'] }));
    await waitFor(() => expect(screen.getByTestId('mapping')).toBeTruthy());
    expect(screen.getByRole('button', { name: vi_['mdm.import.check.action'] })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.type.label']), { target: { value: 'AREA' } });
    expect(screen.getByRole('button', { name: vi_['mdm.import.check.action'] })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.map.key.label']), { target: { value: '' } });
    expect(screen.getByRole('button', { name: vi_['mdm.import.check.action'] })).toBeDisabled();
    // A type without a form has no attribute to map.
    expect(screen.queryByLabelText(vi_['mdm.import.map.attribute.label'].replace('{name}', 'category'))).toBeNull();
  });

  it('says what the server refused for the file and for the dry run, in the words of the screen', async () => {
    const infected = withUpload(world(), () => ({}), problem('FILE_NOT_CLEAN'));
    mount(<MasterImportScreen route={ROUTE} />, infected.h, IMPORTER, at());
    await formReady();
    await userEvent.setup().upload(screen.getByLabelText(vi_['mdm.import.file.label']), csvFile());
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.import.upload.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.fileRefused.error'])).closest('[role="alert"]')).not.toBeNull();
    cleanup();
    const again = withUpload(world(), () => {
      throw problem('IMPORT_FILE_ALREADY_APPLIED');
    });
    mount(<MasterImportScreen route={ROUTE} />, again.h, IMPORTER, at());
    await formReady();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText(vi_['mdm.import.type.label']), { target: { value: 'AREA' } });
    await user.upload(screen.getByLabelText(vi_['mdm.import.file.label']), csvFile());
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.upload.action'] }));
    await waitFor(() => expect(screen.getByTestId('mapping')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.check.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.alreadyApplied.error'])).closest('[role="alert"]')).not.toBeNull();
  });

  it('is read-only for someone who may not import, and while the tenant is suspended', async () => {
    mount(<MasterImportScreen route={ROUTE} />, withUpload(world()).h, READER, at());
    await formReady();
    expect(screen.getByText(vi_['mdm.readOnly.denied.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.import.upload.action'] })).toBeNull();
    expect(screen.getByLabelText(vi_['mdm.import.file.label'])).toBeDisabled();
  });
});

describe('MasterImportScreen (MDM-29): applying, reviewing and publishing the batch', () => {
  const open = (batchRow: Record<string, unknown>, permissions: readonly string[], extra: Partial<World> = {}) => {
    const state = world({ imports: [batchRow], ...extra });
    const { h } = withUpload(state, () => ({ operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: batchRow.id }));
    mount(<MasterImportScreen route={ROUTE} />, h, permissions, at(batchRow.id as string));
    return { h, state };
  };
  const ready = () => waitFor(() => expect(screen.getByTestId('batch')).toBeTruthy());

  it('applies a batch without errors with the version that was read', async () => {
    const { h } = open(batch(1, { version: 3 }), IMPORTER);
    await ready();
    expect(screen.getByTestId('no-errors').textContent).toBe(vi_['mdm.import.errors.none.text']);
    expect(screen.getByTestId('batch').textContent).toContain(vi_['mdm.import.status.validated.text']);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.import.apply.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('applyMasterImport', expect.objectContaining({ path: { id: batch(1).id }, ifMatchVersion: 3 })));
  });

  it('applies a PARTIAL batch with errors only after the person has seen the rows that are left out', async () => {
    const { h } = open(batch(2, { mode: 'PARTIAL', error_rows: 3, errors: [{ row: 2, field: 'label', code: 'REQUIRED' }], total_rows: 10 }), IMPORTER);
    await ready();
    expect(screen.queryByTestId('blocked')).toBeNull();
    expect(screen.getByText(vi_['mdm.import.errors.truncated.text'].replace('{shown}', '1').replace('{total}', '3'))).toBeTruthy();
    const apply = screen.getByRole('button', { name: vi_['mdm.import.apply.action'] });
    expect(apply).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: vi_['mdm.import.apply.skipped.label'].replace('{count}', '3') }));
    expect(apply).toBeEnabled();
    await userEvent.setup().click(apply);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('applyMasterImport', expect.objectContaining({ ifMatchVersion: 1 })));
  });

  it('exports the row errors as a CSV file with the words of the screen', async () => {
    open(batch(3, { error_rows: 1, errors: [{ row: 5, field: 'attributes.category', code: 'INVALID_VALUE' }] }), IMPORTER);
    await ready();
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((made: Blob) => {
      blob = made;
      return 'blob:errors';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.import.export.action'] }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as Blob);
    });
    expect(text).toContain(`${vi_['mdm.import.errors.row.column']},${vi_['mdm.import.errors.field.column']},${vi_['mdm.import.errors.problem.column']}`);
    expect(text).toContain(`5,${vi_['mdm.import.field.attribute.text'].replace('{name}', 'category')},${vi_['mdm.import.error.invalidValue.text']}`);
    click.mockRestore();
  });

  it('lets a reviewer approve or reject the whole batch with a reason, and sends the version that was read', async () => {
    const { h } = open(batch(4, { status: 'IN_REVIEW', version: 2, changes: { IN_REVIEW: 10 } }), REVIEWER);
    await ready();
    expect(screen.getByTestId('changes').textContent).toBe('IN_REVIEW: 10');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.review.approve.action'] }));
    expect(await screen.findByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Checked against the decision' } });
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.review.approve.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideMasterImport', expect.objectContaining({ path: { id: batch(4).id }, body: { decision: 'approve', reason: 'Checked against the decision' }, ifMatchVersion: 2 })));
    fireEvent.change(screen.getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Not the right catalogue' } });
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.review.reject.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideMasterImport', expect.objectContaining({ body: { decision: 'reject', reason: 'Not the right catalogue' } })));
  });

  it('offers a publisher the publication of an approved batch on a decision document, and refuses an id that is not one', async () => {
    const { h } = open(batch(5, { status: 'IN_REVIEW', reviewed_by: OTHER, version: 4 }), PUBLISHER);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.publish.action'] }));
    expect(await screen.findByText(vi_['mdm.approval.document.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['mdm.approval.document.label']), { target: { value: DOCUMENT.toUpperCase() } });
    await user.click(screen.getByRole('button', { name: vi_['mdm.import.publish.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishMasterImport', expect.objectContaining({ path: { id: batch(5).id }, body: { decision_document_id: DOCUMENT }, ifMatchVersion: 4 })));
  });

  it('offers nothing to the person who applied the batch, and waits for the right person when someone else may', async () => {
    open(batch(6, { status: 'IN_REVIEW', created_by: ME }), [...REVIEWER, ...PUBLISHER]);
    await ready();
    expect(screen.getByTestId('own-batch').textContent).toBe(vi_['mdm.import.review.own.hint']);
    expect(screen.queryByRole('button', { name: vi_['mdm.import.review.approve.action'] })).toBeNull();
    cleanup();
    open(batch(7, { status: 'IN_REVIEW', reviewed_by: OTHER, created_by: ME }), PUBLISHER);
    await ready();
    expect(screen.getByTestId('own-batch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.import.publish.action'] })).toBeNull();
    cleanup();
    open(batch(8, { status: 'IN_REVIEW' }), READER);
    await ready();
    expect(screen.getByText(vi_['mdm.import.review.waiting.text'])).toBeTruthy();
    cleanup();
    open(batch(9, { status: 'IN_REVIEW', reviewed_by: OTHER }), READER);
    await ready();
    expect(screen.getByText(vi_['mdm.import.publish.waiting.text'])).toBeTruthy();
  });

  it('says that a batch is published or rejected, with the state of its steps', async () => {
    open(batch(10, { status: 'APPLIED', reviewed_by: OTHER, published_by: OTHER, applied_at: '2026-10-24', changes: { APPLIED: 10 } }), READER);
    await ready();
    expect(screen.getByText(vi_['mdm.import.applied.notice'])).toBeTruthy();
    expect(document.querySelector('[data-step="5"]')?.getAttribute('data-state')).toBe('done');
    cleanup();
    open(batch(11, { status: 'CANCELLED', reviewed_by: OTHER }), READER);
    await ready();
    expect(screen.getByText(vi_['mdm.import.cancelled.notice'])).toBeTruthy();
    expect(document.querySelector('[data-step="5"]')?.getAttribute('data-state')).toBe('problem');
  });

  it('lists the recent batches and opens the one that is chosen, and says so when there is none or the list cannot be read', async () => {
    const rows = [batch(12, { master_type: 'AREA', status: 'APPLIED' }), batch(13, { master_type: 'SECTOR', error_rows: 2 })];
    const state = world({ imports: rows });
    mount(<MasterImportScreen route={ROUTE} />, withUpload(state).h, IMPORTER, at());
    await waitFor(() => expect(screen.getByTestId('recent')).toBeTruthy());
    expect(within(screen.getByTestId('recent')).getAllByRole('button')).toHaveLength(2);
    await userEvent.setup().click(within(screen.getByTestId('recent')).getByText(/SECTOR/));
    await waitFor(() => expect(screen.getByTestId('batch').textContent).toContain('SECTOR'));
    cleanup();
    mount(<MasterImportScreen route={ROUTE} />, withUpload(world()).h, IMPORTER, at());
    expect(await screen.findByText(vi_['mdm.import.recent.empty.text'])).toBeTruthy();
    cleanup();
    mount(<MasterImportScreen route={ROUTE} />, withUpload(world({ failing: new Set(['listMasterImports']) })).h, IMPORTER, at());
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
