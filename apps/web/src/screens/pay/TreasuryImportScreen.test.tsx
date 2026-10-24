import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { SECOND_TENANT, mountInSession } from '../adm/security/test-support';
import TreasuryImportScreen from './TreasuryImportScreen';
import { FILE_ID, IMPORTER, IMPORT_ID, ME, READER, SCREEN_PATH, SHA, WRITER_ONLY, answer, difference, harness, importView, listItem, mount, routeOf, row, stagedFile } from './test-support';

const ROUTE = routeOf('PAY-13', 'FR-PAY-13');
const AT = `${SCREEN_PATH}?import=${IMPORT_ID}`;
const OTHER_IMPORT = '00000000-0000-4000-8000-00000000a002';
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

interface ClientOptions {
  /** What the upload answers for the file it is given (a value, or an error to refuse it). */
  upload?: (file: unknown) => unknown;
  /** The earlier imports. */
  recent?: unknown[];
}

/** A client that answers the import it is asked for, the list of imports, the upload of a file and the import command. */
function client(view: unknown = importView(), command: (operation: string, input: unknown) => unknown = () => answer(), options: ClientOptions = {}) {
  const h = harness((operation) => (operation === 'getTreasuryImport' ? view : new Error(`unexpected read ${operation}`)), command);
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const upload = vi.fn((_operation: string, input: { form: FormData }) => respond((options.upload ?? (() => stagedFile()))(input.form.get('file'))));
  const readAll = vi.fn((operation: string) => (operation === 'listTreasuryImports' ? Promise.resolve(options.recent ?? []) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  Object.assign(h.client, { upload, readAll });
  return Object.assign(h, { upload, readAll });
}

const ready = () => waitFor(() => expect(screen.getByTestId('summary')).toBeTruthy());
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
/** Picks a file the way a person does; the upload answers and the screen holds the file. */
const pick = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText(vi_['pay.import.form.file.label']), { target: { files: [new File(['a,b\n1,2\n'], 'sao-ke.csv', { type: 'text/csv' })] } });
  await waitFor(() => expect(screen.getByTestId('staged')).toBeTruthy());
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['pay.import.form.submit.action'] }));
};

describe('TreasuryImportScreen (PAY-13): the import of a Treasury statement file (UI-PAY-13)', () => {
  it('shows the result of an import: the counts of the whole file, the status, the hash and the certified total', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, AT);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.import.page.title']);
    expect([screen.getByTestId('count-total'), screen.getByTestId('count-new'), screen.getByTestId('count-duplicate'), screen.getByTestId('count-conflict'), screen.getByTestId('count-error')].map((cell) => cell.textContent)).toEqual(['6', '3', '1', '1', '1']);
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.import.status.partial.text']);
    expect(screen.getByTestId('file-hash').textContent).toBe(SHA);
    expect(screen.getByTestId('certified-rows').textContent).toBe('3');
    expect(screen.getByTestId('certified-amount').textContent).toBe(`12.000 ${vi_['pay.import.unit.vnd.text']}`);
    expect(screen.getByTestId('certified-open').textContent).toBe('1');
  });

  it('says that the adapter is PROPOSED and the Treasury API MISSING, always, and shows the layout version and the connector once an import is read', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, SCREEN_PATH);
    expect(screen.getByTestId('adapter-file').textContent).toBe(vi_['pay.import.adapterStatus.proposed.text']);
    expect(screen.getByTestId('adapter-api').textContent).toBe(vi_['pay.import.adapterStatus.missing.text']);
    expect(screen.getByTestId('adapter-assumption').textContent).toBe(vi_['pay.import.adapter.assumption.notice']);
    expect(screen.queryByTestId('adapter-version')).toBeNull();
    cleanup();
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, AT);
    await ready();
    expect(screen.getByTestId('adapter-version').textContent).toBe('ASSUMED-2026.1');
    expect(screen.getByTestId('adapter-connector').textContent).toBe(`TREASURY_STATEMENT_FILE · ${vi_['pay.import.connectorStatus.active.text']}`);
  });

  it('shows a connector that stopped with its last error', async () => {
    const stopped = importView({ adapter: { ...importView().adapter, connector_status: 'FAILED', last_error_code: 'IMPORT_SCHEMA_INVALID', last_success_at: null } });
    mount(<TreasuryImportScreen route={ROUTE} />, client(stopped), READER, AT);
    await ready();
    expect(screen.getByTestId('adapter-connector').textContent).toContain(vi_['pay.import.connectorStatus.failed.text']);
    expect(screen.getByTestId('adapter').textContent).toContain('IMPORT_SCHEMA_INVALID');
    expect(screen.getByTestId('adapter').textContent).toContain(vi_['pay.import.adapter.never.text']);
  });

  it('lists the quarantined rows with their reason, what was read with the account hidden, and the owner; the account number is never shown', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, AT);
    await ready();
    const rows = within(screen.getByTestId('quarantine')).getAllByTestId('quarantine-row');
    expect(rows).toHaveLength(1);
    const cells = Array.from(rows[0]?.querySelectorAll('td') ?? []).map((cell) => cell.textContent);
    expect(cells[0]).toBe('7');
    expect(cells[1]).toBe('KBNN_FILE|CT-7|2026-10-15|PRJ-A');
    expect(cells[2]).toContain(vi_['pay.import.rowError.amountInvalid.text']);
    expect(cells[2]).toContain('AMOUNT_INVALID');
    expect(screen.getByTestId('masked').textContent).toBe(
      `${vi_['pay.import.field.documentNo.label']}: CT-7 · ${vi_['pay.import.field.amount.label']}: 12x · ${vi_['pay.import.field.account.label']}: ***012`,
    );
    // No item for this row: its owner is the person who imported the file.
    expect(cells[4]).toBe('Nguyễn Văn An');
    expect(document.body.textContent).not.toContain('0123456789');
  });

  it('gives a quarantined row of a gap in master data the owner and the due time of its item', async () => {
    const gap = importView({
      rows: [row(2, 'ERROR', { error_code: 'CROSSWALK_MISSING' })],
      differences: [difference(2, { code: 'CROSSWALK_MISSING', expected: null, actual: null, difference: null, owner_name: null, owner_membership_id: '00000000-0000-4000-8000-0000000000f1' })],
    });
    mount(<TreasuryImportScreen route={ROUTE} />, client(gap), READER, AT);
    await ready();
    const cells = Array.from(within(screen.getByTestId('quarantine')).getByTestId('quarantine-row').querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells[2]).toContain(vi_['pay.import.rowError.crosswalkMissing.text']);
    expect(cells[4]).toBe('00000000-0000-4000-8000-0000000000f1');
    expect(cells[5]).not.toBe('');
  });

  it('lists the differences with the two figures and the signed gap, an owner and a due time', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, AT);
    await ready();
    const [item] = within(screen.getByTestId('differences')).getAllByTestId('difference-row');
    const cells = Array.from(item?.querySelectorAll('td') ?? []).map((cell) => cell.textContent);
    expect(cells[0]).toBe(vi_['pay.import.difference.duplicateConflict.text']);
    expect(cells.slice(2, 7)).toEqual(['2.000', '2.500', '+500', 'Nguyễn Văn An', expect.stringMatching(/\d/)]);
    expect(cells[7]).toBe(vi_['pay.import.itemStatus.open.text']);
  });

  it('lists every line with what became of it', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, AT);
    await ready();
    const lines = within(screen.getByTestId('lines')).getAllByTestId('line-row');
    expect(lines.map((line) => line.getAttribute('data-outcome'))).toEqual(['NEW', 'NEW', 'NEW', 'DUPLICATE', 'CONFLICT', 'ERROR']);
    expect(lines[5]?.textContent).toContain(vi_['pay.import.outcome.error.text']);
    expect(screen.queryByTestId('lines-truncated')).toBeNull();
  });

  it('says when the file had more lines than the page shows', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(importView({ rows_truncated: true, row_total: 503 })), READER, AT);
    await ready();
    expect(screen.getByTestId('lines-truncated').textContent).toBe(vi_['pay.import.lines.truncated.notice'].replace('{shown}', '6').replace('{total}', '503'));
  });

  it('says so when nothing was quarantined and no difference was left', async () => {
    mount(<TreasuryImportScreen route={ROUTE} />, client(importView({ rows: [row(2, 'NEW')], differences: [], status: 'APPLIED', row_error: 0, row_conflict: 0 })), READER, AT);
    await ready();
    expect(screen.getByTestId('quarantine-empty').textContent).toBe(vi_['pay.import.quarantine.empty']);
    expect(screen.getByTestId('differences-empty').textContent).toBe(vi_['pay.import.differences.empty']);
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.import.status.applied.text']);
  });

  describe('opening an import', () => {
    it('asks for an import when the address names none, and says so when it names something that is not an import', async () => {
      const first = client();
      mount(<TreasuryImportScreen route={ROUTE} />, first, READER, SCREEN_PATH);
      expect(screen.getByTestId('no-import').textContent).toBe(vi_['pay.import.none.notice']);
      expect(first.read).not.toHaveBeenCalled();
      cleanup();
      const second = client();
      mount(<TreasuryImportScreen route={ROUTE} />, second, READER, `${SCREEN_PATH}?import=../../x`);
      expect(screen.getByTestId('no-import').textContent).toBe(vi_['pay.import.notFound.notice']);
      expect(second.read).not.toHaveBeenCalled();
    });

    it('says the import is not there when the server does not know it (404), without a retry button', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(problem('RESOURCE_NOT_FOUND', 404)), READER, AT);
      await waitFor(() => expect(screen.getByTestId('import-missing').textContent).toBe(vi_['pay.import.notFound.notice']));
    });

    it('shows the denied state when the server refuses the read, and the error state for any other failure', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(problem('SCOPE_DENIED', 403)), READER, AT);
      await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
      cleanup();
      mount(<TreasuryImportScreen route={ROUTE} />, client(problem('INTERNAL_ERROR', 500)), READER, AT);
      await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    });

    it('does not read anything for a person who may not read imports', async () => {
      const h = client();
      mount(<TreasuryImportScreen route={ROUTE} />, h, WRITER_ONLY, AT);
      expect(screen.getByTestId('no-read').textContent).toBe(vi_['pay.import.read.denied.notice']);
      expect(h.read).not.toHaveBeenCalled();
    });
  });

  describe('importing a picked file', () => {
    it('uploads the file as soon as it is picked and shows what it holds: name, kind, rows, size, hash and that it has the columns of the layout', async () => {
      const h = client();
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      await pick();
      expect(h.upload).toHaveBeenCalledTimes(1);
      expect(h.upload.mock.calls[0]?.[0]).toBe('uploadTreasuryStatementFile');
      expect(screen.getByTestId('staged-name').textContent).toBe('sao-ke.csv');
      expect(screen.getByTestId('staged-hash').textContent).toBe(SHA);
      expect(screen.getByTestId('staged').textContent).toContain(vi_['pay.import.staged.rows.text'].replace('{count}', '2'));
      expect(screen.getByTestId('staged').textContent).toContain('CSV');
      expect(screen.getByTestId('layout-ok').textContent).toBe(vi_['pay.import.staged.layoutOk.text']);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says before the import which required columns the file lacks, names them, and does not send the file', async () => {
      const h = client(importView(), () => answer(), { upload: () => stagedFile({ layout_ok: false, missing_columns: ['document_date', 'treasury_office_code'] }) });
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      await pick();
      const names = `${vi_['pay.import.field.documentDate.label']}, ${vi_['pay.import.field.officeCode.label']}`;
      expect(screen.getByTestId('layout-bad').textContent).toBe(vi_['pay.import.staged.layoutBad.text'].replace('{columns}', names));
      submit();
      await waitFor(() => expect(screen.getByText(vi_['pay.import.fileError.layout.text'].replace('{columns}', names))).toBeTruthy());
      expect(h.command).not.toHaveBeenCalled();
    });

    it('refuses to import before a file is picked, and sends nothing', async () => {
      const h = client();
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      submit();
      expect(await screen.findByText(vi_['pay.import.fileError.required.text'])).toBeTruthy();
      expect(screen.getByLabelText(vi_['pay.import.form.file.label']).getAttribute('aria-invalid')).toBe('true');
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the stored file by its id and hash with its name, the kind and the date, then opens the import it made and tells what it did', async () => {
      const h = client(importView(), () => answer());
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      await pick();
      set(vi_['pay.import.form.sourceKind.label'], 'EXPORT_FILE');
      set(vi_['pay.import.form.statementDate.label'], '2026-10-16');
      submit();
      await waitFor(() => expect(h.command).toHaveBeenCalled());
      expect(h.command.mock.calls[0]?.[0]).toBe('importTreasuryStatement');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { file_object_id: FILE_ID, file_sha256: SHA, source_kind: 'EXPORT_FILE', statement_date: '2026-10-16', file_name: 'sao-ke.csv' } });
      await ready();
      expect(h.read).toHaveBeenCalledWith('getTreasuryImport', { path: { id: IMPORT_ID } });
      expect(screen.getByTestId('answer').textContent).toBe(vi_['pay.import.answer.partial.notice'].replace('{total}', '6').replace('{created}', '3').replace('{duplicate}', '1').replace('{conflict}', '1').replace('{error}', '1'));
      // The picker is clear again for the next file.
      expect(screen.queryByTestId('staged')).toBeNull();
    });

    it('tells a file that was imported before and opens the first import', async () => {
      const h = client(importView(), () => answer({ result: 'ALREADY_IMPORTED', status: 'ALREADY_IMPORTED', resource_id: OTHER_IMPORT, duplicate: true }));
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, AT);
      await ready();
      await pick();
      submit();
      await waitFor(() => expect(screen.getByTestId('answer')).toBeTruthy());
      expect(screen.getByTestId('answer').textContent).toContain(vi_['pay.import.answer.already.notice'].replace('{total}', '6'));
      expect(h.read).toHaveBeenCalledWith('getTreasuryImport', { path: { id: OTHER_IMPORT } });
    });

    it.each([
      ['FILE_TYPE_NOT_ALLOWED', 'pay.import.problem.fileType.error'],
      ['PAYLOAD_TOO_LARGE', 'pay.import.problem.tooLarge.error'],
      ['FILE_NOT_CLEAN', 'pay.import.problem.fileNotClean.error'],
      ['SCAN_PENDING', 'pay.import.problem.scanPending.error'],
      ['TREASURY_IMPORT_SCHEMA_INVALID', 'pay.import.problem.schemaInvalid.error'],
      ['SOMETHING', 'pay.import.problem.general.error'],
    ] as const)('shows the sentence for %s when the upload is refused, and no file is held', async (code, key) => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => answer(), { upload: () => problem(code) }), IMPORTER, SCREEN_PATH);
      await waitFor(() => expect(screen.getByLabelText(vi_['pay.import.form.file.label'])).toBeTruthy());
      fireEvent.change(screen.getByLabelText(vi_['pay.import.form.file.label']), { target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] } });
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_[key]));
      expect(screen.queryByTestId('staged')).toBeNull();
    });

    it('treats an upload answer it cannot read as a general failure, and a change that picks no file as clearing the file', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => answer(), { upload: () => ({ nothing: true }) }), IMPORTER, SCREEN_PATH);
      fireEvent.change(screen.getByLabelText(vi_['pay.import.form.file.label']), { target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] } });
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['pay.import.problem.general.error']));
      fireEvent.change(screen.getByLabelText(vi_['pay.import.form.file.label']), { target: { files: [] } });
      expect(screen.queryByTestId('problem')).toBeNull();
    });

    it.each([
      ['HASH_MISMATCH', 'pay.import.problem.hashMismatch.error'],
      ['RESOURCE_NOT_FOUND', 'pay.import.problem.notFound.error'],
      ['SCOPE_DENIED', 'pay.import.problem.denied.error'],
      ['STAGE_TRANSITION_DENIED', 'pay.import.problem.connectorStopped.error'],
      ['VALIDATION_FAILED', 'pay.import.problem.validation.error'],
      ['TREASURY_IMPORT_SCHEMA_INVALID', 'pay.import.problem.schemaInvalid.error'],
      ['SOMETHING', 'pay.import.problem.general.error'],
    ] as const)('shows the sentence for %s when the import is refused and keeps the picked file', async (code, key) => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => problem(code)), IMPORTER, SCREEN_PATH);
      await pick();
      submit();
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_[key]));
      expect(screen.getByTestId('staged-hash').textContent).toBe(SHA);
    });

    it('names the field the server refused', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => problem('VALIDATION_FAILED', 422, 'statement_date')), IMPORTER, SCREEN_PATH);
      await pick();
      submit();
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['pay.import.problem.validationField.error'].replace('{field}', 'statement_date')));
    });

    it('treats an import answer it cannot read as a general failure', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => ({ nothing: true })), IMPORTER, SCREEN_PATH);
      await pick();
      submit();
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['pay.import.problem.general.error']));
    });

    it('disables the button and says it is working while the file is imported, and ignores a second submit', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = client(importView(), () => new Promise((resolve) => (release = resolve)));
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      await pick();
      submit();
      const button = await screen.findByRole('button', { name: vi_['pay.import.form.submit.pending'] });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: vi_['pay.import.form.title'] }));
      release(answer());
      await ready();
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    it('says the file is being uploaded while it is, and does not import before the upload ends', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = client(importView(), () => answer(), { upload: () => new Promise((resolve) => (release = resolve)) });
      mount(<TreasuryImportScreen route={ROUTE} />, h, IMPORTER, SCREEN_PATH);
      fireEvent.change(screen.getByLabelText(vi_['pay.import.form.file.label']), { target: { files: [new File(['x'], 'a.csv', { type: 'text/csv' })] } });
      expect((await screen.findByTestId('uploading')).textContent).toBe(vi_['pay.import.form.uploading.status']);
      fireEvent.submit(screen.getByRole('form', { name: vi_['pay.import.form.title'] }));
      expect(h.command).not.toHaveBeenCalled();
      release(stagedFile());
      await waitFor(() => expect(screen.getByTestId('staged')).toBeTruthy());
      expect(screen.queryByTestId('uploading')).toBeNull();
    });
  });

  describe('the earlier imports', () => {
    it('lists them with the file, the time, the person, the status and the counts, and opens one', async () => {
      const h = client(importView(), () => answer(), { recent: [listItem(1), listItem(2, { status: 'APPLIED', row_error: 0, row_conflict: 0, file_name: 'thang-9.csv' })] });
      mount(<TreasuryImportScreen route={ROUTE} />, h, READER, `${SCREEN_PATH}?import=${IMPORT_ID}`);
      const rows = await screen.findAllByTestId('recent-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.getAttribute('aria-current')).toBe('true');
      expect(rows[1]?.getAttribute('aria-current')).toBeNull();
      expect(rows[1]?.textContent).toContain('thang-9.csv');
      expect(rows[1]?.textContent).toContain(vi_['pay.import.status.applied.text']);
      expect(rows[1]?.textContent).toContain('Nguyễn Văn An');
      fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['pay.import.recent.open.label'].replace('{name}', 'thang-9.csv') }));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getTreasuryImport', { path: { id: listItem(2).id } }));
    });

    it('says so when there is none, shows a person without a name by the id, and is not read for someone who may not read imports', async () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, SCREEN_PATH);
      expect((await screen.findByTestId('recent-empty')).textContent).toBe(vi_['pay.import.recent.empty']);
      cleanup();
      mount(<TreasuryImportScreen route={ROUTE} />, client(importView(), () => answer(), { recent: [listItem(1, { imported_by_name: null })] }), READER, SCREEN_PATH);
      expect((await screen.findByTestId('recent-row')).textContent).toContain(ME);
      cleanup();
      const h = client();
      mount(<TreasuryImportScreen route={ROUTE} />, h, WRITER_ONLY, SCREEN_PATH);
      expect(screen.queryByTestId('recent')).toBeNull();
      expect(h.readAll).not.toHaveBeenCalled();
    });
  });

  describe('who may import', () => {
    it('shows no form, only the reason, to a person who may read but not import', () => {
      mount(<TreasuryImportScreen route={ROUTE} />, client(), READER, SCREEN_PATH);
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['pay.import.readOnly.denied.notice']);
      expect(screen.queryByRole('button', { name: vi_['pay.import.form.submit.action'] })).toBeNull();
      expect(screen.queryByLabelText(vi_['pay.import.form.file.label'])).toBeNull();
    });

    it('shows no form, and says the tenant is read-only, when the tenant is frozen', () => {
      mountInSession(<TreasuryImportScreen route={ROUTE} />, client(), { permissions: IMPORTER, mode: 'READ_ONLY' });
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['pay.import.readOnly.frozen.notice']);
      expect(screen.queryByRole('button', { name: vi_['pay.import.form.submit.action'] })).toBeNull();
    });

    it('starts over when the tenant changes, so a file picked for one tenant is never sent to another', async () => {
      const view = mountInSession(<TreasuryImportScreen route={ROUTE} />, client(), { permissions: IMPORTER });
      await pick();
      view.rerenderWith({ permissions: IMPORTER, tenant: SECOND_TENANT });
      expect(screen.queryByTestId('staged')).toBeNull();
    });

    it('shows the form when the permissions are not known yet (the server decides)', () => {
      mountInSession(<TreasuryImportScreen route={ROUTE} />, client(), { permissions: undefined });
      expect(screen.getByRole('button', { name: vi_['pay.import.form.submit.action'] })).toBeTruthy();
    });
  });
});
