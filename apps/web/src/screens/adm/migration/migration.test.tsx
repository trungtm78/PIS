import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import MigrationScreen from './MigrationScreen';
import * as labels from './labels';
import { EMPTY_REGISTER, STATUSES, canApply, canDryRun, canRollback, describeProblem, errorsCsv, isWorking, reasonProblem, registerBody, toBatch, toUploadedFile, validateRegister } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0130'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-13', 'FR-ADM-13');
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = uuid(900);
const MANAGE = ['adm.migration.read', 'adm.migration.manage'];
const APPROVE = ['adm.migration.read', 'adm.migration.approve'];
const READ = ['adm.migration.read'];

const batch = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  source_system: 'LEGACY-ERP',
  target_entity: `LEDGER_${n}`,
  file_sha256: `${String(n).padStart(2, '0')}ab`.repeat(16),
  mapping_version: 'GENERIC-1',
  row_count: 120,
  error_count: 0,
  status: 'DryRunPassed',
  dry_run_report_ref: `migration_batch_error:${uuid(n)}`,
  control_totals: { expected: { rows: 120, amount: '7260000' } },
  rows_applied: 0,
  failure_code: null,
  created_by: OTHER,
  approved_by: null,
  applied_at: null,
  rolled_back_by: null,
  rolled_back_at: null,
  rollback_reason: null,
  created_at: '2026-11-01T01:00:00.000000Z',
  version: 3,
  ...extra,
});
const withErrors = (n: number, extra: Record<string, unknown> = {}) =>
  batch(n, {
    status: 'DryRunFailed',
    error_count: 2,
    errors: [
      { row_number: 17, line_number: 18, field: 'business_key', code: 'KEY_MISSING', message: 'the business key is empty' },
      { row_number: 42, line_number: 43, field: 'amount', code: 'AMOUNT_INVALID', message: 'amount is not a whole amount, "12.5"' },
    ],
    ...extra,
  });

interface World {
  rows: Array<Record<string, unknown>>;
  failing: Error | undefined;
  loading: boolean;
}

function open(
  state: Partial<World> = {},
  options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {},
): Harness & { world: World } {
  const world: World = { rows: [], failing: undefined, loading: false, ...state };
  const h = baseHarness((operation, input) => {
    if (operation === 'getMigrationBatch') {
      const found = world.rows.find((row) => row.id === (input as { path: { batchId: string } }).path.batchId);
      return found === undefined ? problem(404, 'RESOURCE_NOT_FOUND') : found;
    }
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation !== 'listMigrationBatches') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    if (world.loading) return new Promise(() => undefined);
    return world.failing === undefined ? Promise.resolve(world.rows) : Promise.reject(world.failing);
  });
  mountInSession(<MigrationScreen route={ROUTE} />, h, { permissions: options.permissions ?? MANAGE, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-13');
  return Object.assign(h, { world });
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const textOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
const detail = (): HTMLElement => screen.getByTestId('batch-detail');
const openBatch = async (n: number): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: fill(word('adm.migration.open.action'), { entity: `LEDGER_${n}` }) }));
  await within(await screen.findByTestId('batch-detail')).findByTestId('detail-status');
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the model of the conversion batches (ST-ADM-020)', () => {
  it('reads a batch with its totals and its errors, and leaves out what is not one', () => {
    const read = toBatch(withErrors(1));
    expect(read).toMatchObject({
      id: uuid(1),
      targetEntity: 'LEDGER_1',
      status: 'DryRunFailed',
      rowCount: 120,
      errorCount: 2,
      version: 3,
      totals: { expected: { rows: 120, amount: '7260000' }, actual: null, matched: null },
    });
    expect(read?.errors).toEqual([
      { rowNumber: 17, lineNumber: 18, field: 'business_key', code: 'KEY_MISSING', message: 'the business key is empty' },
      { rowNumber: 42, lineNumber: 43, field: 'amount', code: 'AMOUNT_INVALID', message: 'amount is not a whole amount, "12.5"' },
    ]);
    const applied = toBatch(batch(2, { status: 'Applied', control_totals: { expected: { rows: 1, amount: '5' }, actual: { rows: 1, amount: '5' }, matched: true }, approved_by: ME, applied_at: 'x' }));
    expect(applied?.totals).toEqual({ expected: { rows: 1, amount: '5' }, actual: { rows: 1, amount: '5' }, matched: true });
    expect(applied).toMatchObject({ approvedBy: ME, appliedAt: 'x' });
    expect(toBatch(batch(3, { control_totals: null, errors: [3, { row_number: 1 }] }))).toMatchObject({ totals: { expected: null, actual: null, matched: null }, errors: [] });
    expect(toBatch(batch(4, { control_totals: { expected: { rows: '1' }, matched: 'yes' }, row_count: 'x' }))).toMatchObject({ totals: { expected: null, matched: null }, rowCount: 0 });
    for (const bad of [null, {}, batch(5, { status: 'LOST' }), batch(5, { version: '3' }), batch(5, { created_by: 3 })]) expect(toBatch(bad)).toBeUndefined();
  });

  it('reads what the upload answers', () => {
    expect(toUploadedFile({ file_id: uuid(1), row_count: 3, columns: ['business_key', 7, 'amount'] })).toEqual({ fileId: uuid(1), rows: 3, columns: ['business_key', 'amount'] });
    for (const bad of [null, {}, { file_id: uuid(1), row_count: '3', columns: [] }, { file_id: uuid(1), row_count: 3, columns: 'x' }]) expect(toUploadedFile(bad)).toBeUndefined();
  });

  it('knows which commands a state allows', () => {
    const allowed = (check: (status: (typeof STATUSES)[number]) => boolean) => STATUSES.filter(check);
    expect(allowed(canDryRun)).toEqual(['Uploaded', 'DryRunFailed', 'Failed']);
    expect(allowed(canApply)).toEqual(['DryRunPassed']);
    expect(allowed(canRollback)).toEqual(['Applied']);
    expect(allowed(isWorking)).toEqual(['Validating', 'Applying']);
    expect(isWorking(undefined)).toBe(false);
  });

  it('checks a registration and builds what is sent', () => {
    expect(validateRegister(EMPTY_REGISTER)).toEqual({ sourceSystem: 'required', targetEntity: 'required', fileId: 'required' });
    expect(validateRegister({ sourceSystem: '-x', targetEntity: 'lower', fileId: 'not-a-uuid', mappingVersion: 'GENERIC-1' })).toEqual({
      sourceSystem: 'invalid',
      targetEntity: 'invalid',
      fileId: 'invalid',
    });
    const good = { sourceSystem: ' LEGACY-ERP ', targetEntity: ' LEDGER_ACCOUNT ', fileId: ` ${uuid(1).toUpperCase()} `, mappingVersion: 'GENERIC-CHILD-1' };
    expect(validateRegister(good)).toEqual({});
    expect(registerBody(good)).toEqual({ source_system: 'LEGACY-ERP', target_entity: 'LEDGER_ACCOUNT', file_id: uuid(1), mapping_version: 'GENERIC-CHILD-1' });
    expect(reasonProblem('  ')).toBe('required');
    expect(reasonProblem('short')).toBe('invalid');
    expect(reasonProblem('x'.repeat(2001))).toBe('invalid');
    expect(reasonProblem('A reason that is long enough.')).toBeUndefined();
  });

  it('makes the CSV of the errors: quoted where it must be, never a formula for a spreadsheet', () => {
    const csv = errorsCsv([
      { rowNumber: 1, lineNumber: 2, field: 'name', code: 'FIELD_TOO_LONG', message: 'a, "quoted"\nvalue' },
      { rowNumber: 2, lineNumber: 3, field: '=cmd', code: 'X', message: '+1' },
    ]);
    expect(csv).toBe('row_number,line_number,field,code,message\r\n1,2,name,FIELD_TOO_LONG,"a, ""quoted""\nvalue"\r\n2,3,\'=cmd,X,\'+1\r\n');
    expect(errorsCsv([])).toBe('row_number,line_number,field,code,message\r\n');
  });

  it('says what a refusal means, and has a word for everything it names', () => {
    const cases: Array<[string, string]> = [
      ['FILE_TYPE_NOT_ALLOWED', 'file'],
      ['FILE_NOT_CLEAN', 'file'],
      ['SCAN_PENDING', 'file'],
      ['PAYLOAD_TOO_LARGE', 'file'],
      ['MIGRATION_FILE_ALREADY_REGISTERED', 'duplicate'],
      ['MIGRATION_STATE_INVALID', 'state'],
      ['MIGRATION_FILE_ALREADY_APPLIED', 'applied'],
      ['MIGRATION_DEPENDENTS_EXIST', 'dependents'],
      ['SELF_APPROVAL_DENIED', 'self'],
      ['SCOPE_DENIED', 'scope'],
      ['VERSION_CONFLICT', 'stale'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['VALIDATION_FAILED', 'validation'],
      ['OTHER', 'general'],
    ];
    for (const [code, reason] of cases) expect(describeProblem(problem(409, code, 'field'))).toEqual({ reason, detail: 'field' });
    expect(describeProblem(problem(409, 'SCOPE_DENIED'))).toEqual({ reason: 'scope', detail: '' });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', detail: '' });
    const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);
    for (const status of STATUSES) expect(labels.statusLabel(t, status)).toMatch(/^adm\.migration\.status\./);
    for (const [, reason] of cases) expect(labels.problemMessage(t, { reason: reason as never, detail: 'f' })).toMatch(/^adm\.migration\.problem\./);
  });
});

const states: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

describe('MigrationScreen (ADM-13): the conversion of legacy data (ST-ADM-020, UI-ADM-13)', () => {
  it('UI-ADM-13: lists the batches with the entity, the source, the hash, the rows, the errors and the state', async () => {
    open({ rows: [batch(1), withErrors(2), batch(3, { status: 'Applied', approved_by: ME })] });
    const table = await screen.findByTestId('batches');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.migration.title'));
    const row = (n: number) => table.querySelector(`[data-batch="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.migration.status.passed'));
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('adm.migration.status.dryfailed'));
    expect(within(row(3)).getByTestId('status').textContent).toBe(word('adm.migration.status.applied'));
    expect(row(2).textContent).toContain('LEDGER_2');
    expect(row(2).textContent).toContain('LEGACY-ERP');
    expect(row(2).textContent).toContain(batch(2).file_sha256.slice(0, 12));
    expect(row(2).textContent).toContain('GENERIC-1');
  });

  it('UI-ADM-13, AC-ST-ADM-020-3: opens a batch to its dry-run result: the errors row by row, the control totals, and the error CSV to download', async () => {
    const urls: Blob[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((blob: Blob) => (urls.push(blob), 'blob:errors')), revokeObjectURL: vi.fn() });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open({ rows: [withErrors(1)] });
    await openBatch(1);
    expect(within(detail()).getByTestId('detail-hash').textContent).toBe(batch(1).file_sha256);
    expect(within(detail()).getByTestId('totals-expected').textContent).toContain(fill(word('adm.migration.detail.totals'), { rows: 120, amount: '7260000' }));
    expect(within(detail()).getByTestId('totals-actual').textContent).toContain('—');
    const errors = within(detail()).getByTestId('errors');
    expect(Array.from(errors.querySelectorAll('tbody tr')).map((tr) => [tr.getAttribute('data-row'), tr.querySelectorAll('td')[1]?.textContent, tr.querySelectorAll('td')[3]?.textContent])).toEqual([
      ['17', '18', 'KEY_MISSING'],
      ['42', '43', 'AMOUNT_INVALID'],
    ]);
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.errors.download') }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(1);
    expect(await textOf(urls[0] as Blob)).toBe(errorsCsv(toBatch(withErrors(1))?.errors ?? []));
    vi.unstubAllGlobals();
  });

  it('shows the control totals of an applied batch against what the file said, and says so when they differ', async () => {
    const applied = batch(1, { status: 'Applied', approved_by: ME, control_totals: { expected: { rows: 3, amount: '60' }, actual: { rows: 3, amount: '60' }, matched: true } });
    open({
      rows: [
        applied,
        batch(2, { status: 'Failed', failure_code: 'CONTROL_TOTALS_MISMATCH', control_totals: { expected: { rows: 3, amount: '60' }, actual: { rows: 1, amount: '11' }, matched: false } }),
      ],
    });
    await openBatch(1);
    expect(within(detail()).getByTestId('totals-matched').textContent).toBe(word('adm.migration.detail.match'));
    expect(within(detail()).getByTestId('totals-actual').textContent).toContain(fill(word('adm.migration.detail.totals'), { rows: 3, amount: '60' }));
    expect(within(detail()).getByTestId('no-errors').textContent).toBe(word('adm.migration.errors.none'));
    cleanup();
    open({
      rows: [batch(2, { status: 'Failed', failure_code: 'CONTROL_TOTALS_MISMATCH', control_totals: { expected: { rows: 3, amount: '60' }, actual: { rows: 1, amount: '11' }, matched: false } })],
    });
    await openBatch(2);
    expect(within(detail()).getByTestId('totals-matched').textContent).toBe(word('adm.migration.detail.mismatch'));
    expect(within(detail()).getByTestId('failure-code').textContent).toBe(fill(word('adm.migration.detail.failure'), { code: 'CONTROL_TOTALS_MISMATCH' }));
  });

  it('says a batch is being worked on while it is validated or applied, and shows a rollback with its reason', async () => {
    open({ rows: [batch(1, { status: 'Validating' }), batch(2, { status: 'RolledBack', rolled_back_at: 'x', rollback_reason: 'Loaded from an old extract.' })] });
    await openBatch(1);
    expect(within(detail()).getByTestId('working').textContent).toBe(word('adm.migration.detail.working'));
    cleanup();
    open({ rows: [batch(2, { status: 'RolledBack', rolled_back_at: 'x', rollback_reason: 'Loaded from an old extract.' })] });
    await openBatch(2);
    expect(within(detail()).getByTestId('rollback-reason').textContent).toBe('Loaded from an old extract.');
    expect(within(detail()).queryByTestId('working')).toBeNull();
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.detail.close') }));
    expect(screen.queryByTestId('batch-detail')).toBeNull();
  });

  it('registers a file: checked first, then sent, and the refusal of the server (the file is registered already) is shown', async () => {
    const h = open({ rows: [] }, { command: () => Promise.reject(problem(409, 'MIGRATION_FILE_ALREADY_REGISTERED')) });
    expect((await screen.findByTestId('no-batches')).textContent).toBe(word('adm.migration.none'));
    const form = screen.getByRole('form', { name: word('adm.migration.register.title') });
    fireEvent.click(within(form).getByRole('button', { name: word('adm.migration.register.submit') }));
    expect((await within(form).findAllByText(word('adm.migration.form.required'))).length).toBe(3);
    expect(h.command).not.toHaveBeenCalled();
    type('migration-source', '-x');
    type('migration-entity', 'lower');
    type('migration-file', 'nope');
    fireEvent.click(within(form).getByRole('button', { name: word('adm.migration.register.submit') }));
    expect(await within(form).findByText(word('adm.migration.register.source.invalid'))).toBeTruthy();
    expect(within(form).getByText(word('adm.migration.register.entity.invalid'))).toBeTruthy();
    expect(within(form).getByText(word('adm.migration.register.file.invalid'))).toBeTruthy();
    type('migration-source', 'LEGACY-ERP');
    type('migration-entity', 'LEDGER_ACCOUNT');
    type('migration-file', uuid(7));
    fireEvent.change(document.getElementById('migration-mapping') as HTMLElement, { target: { value: 'GENERIC-CHILD-1' } });
    fireEvent.click(within(form).getByRole('button', { name: word('adm.migration.register.submit') }));
    expect((await within(form).findByTestId('register-refusal')).getAttribute('data-reason')).toBe('duplicate');
    expect(commandsCalled(h, 'registerMigrationBatch')[0]?.body).toEqual({ source_system: 'LEGACY-ERP', target_entity: 'LEDGER_ACCOUNT', file_id: uuid(7), mapping_version: 'GENERIC-CHILD-1' });
  });

  it('uploads the file of a registrar, shows what the server read of it and fills the id; a file the server refuses is said so', async () => {
    const h = open({ rows: [] }, { command: () => ({ operation_id: 'o', status: 'Uploaded', resource_version: 1, resource_id: uuid(9) }) });
    const upload = vi.fn((operation: string, input: { form: FormData }) =>
      (input.form.get('file') as File).name === 'bad.csv'
        ? Promise.reject(problem(422, 'FILE_NOT_CLEAN'))
        : Promise.resolve({ file_id: uuid(9), file_sha256: 'a'.repeat(64), size_bytes: 20, format: 'CSV', columns: ['business_key', 'amount'], row_count: 2 }),
    );
    (h.client as unknown as { upload: unknown }).upload = upload;
    await screen.findByTestId('no-batches');
    fireEvent.change(document.getElementById('migration-upload') as HTMLElement, { target: { files: [new File(['business_key,amount\nA,1\nB,2\n'], 'bad.csv', { type: 'text/csv' })] } });
    expect((await screen.findByTestId('upload-refusal')).getAttribute('data-reason')).toBe('file');
    fireEvent.change(document.getElementById('migration-upload') as HTMLElement, { target: { files: [new File(['business_key,amount\nA,1\nB,2\n'], 'ledger.csv', { type: 'text/csv' })] } });
    expect((await screen.findByTestId('upload-done')).textContent).toBe(fill(word('adm.migration.upload.done'), { rows: 2, columns: 'business_key, amount' }));
    expect((document.getElementById('migration-file') as HTMLInputElement).value).toBe(uuid(9));
    expect(upload.mock.calls.map((call) => call[0])).toEqual(['uploadMigrationFile', 'uploadMigrationFile']);
    // No file chosen is nothing to upload.
    fireEvent.change(document.getElementById('migration-upload') as HTMLElement, { target: { files: [] } });
    expect(upload).toHaveBeenCalledTimes(2);
    type('migration-source', 'LEGACY-ERP');
    type('migration-entity', 'LEDGER_ACCOUNT');
    fireEvent.click(screen.getByRole('button', { name: word('adm.migration.register.submit') }));
    expect((await screen.findByTestId('register-saved')).textContent).toBe(word('adm.migration.register.saved'));
    expect(commandsCalled(h, 'registerMigrationBatch')[0]?.body).toMatchObject({ file_id: uuid(9) });
    expect(screen.queryByTestId('upload-done')).toBeNull();
  });

  it('forgets the file that was chosen before as soon as another is chosen, and does not register while the new one goes up', async () => {
    const h = open({ rows: [] });
    let finish: (value: unknown) => void = () => undefined;
    const upload = vi.fn((operation: string, input: { form: FormData }) =>
      (input.form.get('file') as File).name === 'slow.csv'
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ file_id: uuid(9), file_sha256: 'a'.repeat(64), size_bytes: 20, format: 'CSV', columns: ['business_key'], row_count: 1 }),
    );
    (h.client as unknown as { upload: unknown }).upload = upload;
    await screen.findByTestId('no-batches');
    const choose = (name: string): void => {
      fireEvent.change(document.getElementById('migration-upload') as HTMLElement, { target: { files: [new File(['business_key\nA\n'], name, { type: 'text/csv' })] } });
    };
    choose('first.csv');
    await screen.findByTestId('upload-done');
    expect((document.getElementById('migration-file') as HTMLInputElement).value).toBe(uuid(9));
    choose('slow.csv');
    await waitFor(() => expect(screen.queryByTestId('upload-done')).toBeNull());
    expect((document.getElementById('migration-file') as HTMLInputElement).value).toBe('');
    type('migration-source', 'LEGACY-ERP');
    type('migration-entity', 'LEDGER_ACCOUNT');
    type('migration-file', uuid(9));
    expect((screen.getByRole('button', { name: word('adm.migration.register.submit') }) as HTMLButtonElement).disabled).toBe(true);
    // The picker is closed while a file goes up: a second choice cannot be lost behind the first.
    expect((document.getElementById('migration-upload') as HTMLInputElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: word('adm.migration.register.title') }));
    expect(commandsCalled(h, 'registerMigrationBatch')).toHaveLength(0);
    finish({ file_id: uuid(10), file_sha256: 'b'.repeat(64), size_bytes: 20, format: 'CSV', columns: ['business_key'], row_count: 1 });
    await waitFor(() => expect((document.getElementById('migration-file') as HTMLInputElement).value).toBe(uuid(10)));
    expect((screen.getByRole('button', { name: word('adm.migration.register.submit') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('registers a file that the server accepts, and clears the form', async () => {
    const h = open({ rows: [] }, { command: () => ({ operation_id: 'o', status: 'Uploaded', resource_version: 1, resource_id: uuid(8) }) });
    await screen.findByTestId('no-batches');
    type('migration-source', 'LEGACY-ERP');
    type('migration-entity', 'LEDGER_ACCOUNT');
    type('migration-file', uuid(8));
    fireEvent.click(screen.getByRole('button', { name: word('adm.migration.register.submit') }));
    expect((await screen.findByTestId('register-saved')).textContent).toBe(word('adm.migration.register.saved'));
    expect(commandsCalled(h, 'registerMigrationBatch')).toHaveLength(1);
    expect((document.getElementById('migration-source') as HTMLInputElement).value).toBe('');
  });

  it('dry-runs a batch that is registered or failed, against the version that was read, with a reason', async () => {
    const h = open({ rows: [batch(1, { status: 'DryRunFailed' })] }, { command: () => ({ operation_id: 'o', status: 'Validating', resource_version: 4, resource_id: uuid(1) }) });
    await openBatch(1);
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.action.dryrun') }));
    expect(await within(detail()).findByText(word('adm.migration.form.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    type(`migration-reason-${uuid(1)}`, 'short');
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.action.dryrun') }));
    expect(await within(detail()).findByText(word('adm.migration.detail.reason.invalid'))).toBeTruthy();
    type(`migration-reason-${uuid(1)}`, '  The file was mended and loaded again.  ');
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.action.dryrun') }));
    await waitFor(() => expect(commandsCalled(h, 'dryRunMigrationBatch')).toHaveLength(1));
    expect(commandsCalled(h, 'dryRunMigrationBatch')[0]).toMatchObject({ path: { batchId: uuid(1) }, ifMatchVersion: 3, body: { reason: 'The file was mended and loaded again.' } });
    expect(within(detail()).queryByRole('button', { name: word('adm.migration.action.apply') })).toBeNull();
  });

  it('applies a batch that passed its dry run when somebody else registered it; the registrar cannot', async () => {
    const h = open({ rows: [batch(1), batch(2, { created_by: ME })] }, { permissions: APPROVE, command: () => ({ operation_id: 'o', status: 'Applying', resource_version: 4, resource_id: uuid(1) }) });
    await openBatch(2);
    expect((within(detail()).getByRole('button', { name: word('adm.migration.action.apply') }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(detail()).getByTestId('self-hint').textContent).toBe(word('adm.migration.action.selfhint'));
    expect(within(detail()).queryByRole('button', { name: word('adm.migration.action.dryrun') })).toBeNull();
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.detail.close') }));
    await openBatch(1);
    expect(within(detail()).queryByTestId('self-hint')).toBeNull();
    type(`migration-reason-${uuid(1)}`, 'The totals were checked against the ledger.');
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.action.apply') }));
    await waitFor(() => expect(commandsCalled(h, 'applyMigrationBatch')).toHaveLength(1));
    expect(commandsCalled(h, 'applyMigrationBatch')[0]).toMatchObject({ path: { batchId: uuid(1) }, ifMatchVersion: 3 });
  });

  it('rolls an applied batch back, and shows the refusal when others were built on its rows', async () => {
    const h = open({ rows: [batch(1, { status: 'Applied', approved_by: ME })] }, { permissions: APPROVE, command: () => Promise.reject(problem(409, 'MIGRATION_DEPENDENTS_EXIST')) });
    await openBatch(1);
    type(`migration-reason-${uuid(1)}`, 'The rows were loaded from an old extract.');
    fireEvent.click(within(detail()).getByRole('button', { name: word('adm.migration.action.rollback') }));
    expect((await within(detail()).findByTestId('action-refusal')).getAttribute('data-reason')).toBe('dependents');
    expect(commandsCalled(h, 'rollbackMigrationBatch')[0]).toMatchObject({ path: { batchId: uuid(1) }, ifMatchVersion: 3 });
  });

  it('gives no button to who may not: a reader sees the batches and their errors only, and a read-only session none', async () => {
    open({ rows: [withErrors(1), batch(2, { status: 'Applied', approved_by: ME })] }, { permissions: READ });
    await openBatch(1);
    expect(screen.queryByRole('form')).toBeNull();
    expect(within(detail()).getByTestId('errors')).toBeTruthy();
    cleanup();
    open({ rows: [withErrors(1)] }, { permissions: [...MANAGE, ...APPROVE], mode: 'READ_ONLY' });
    await openBatch(1);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: word('adm.migration.register.submit') })).toBeNull();
    cleanup();
    open({ rows: [batch(1)] }, { permissions: MANAGE });
    await openBatch(1);
    expect(within(detail()).queryByRole('button', { name: word('adm.migration.action.apply') })).toBeNull();
    expect(within(detail()).queryByRole('button', { name: word('adm.migration.action.rollback') })).toBeNull();
  });

  it.each(states)('UI-ADM-13 shows the %s state when the batches cannot be read', async (_name, answer, title) => {
    open({ failing: answer });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('UI-ADM-13 shows the loading state while the batches are read, and the error state when a batch cannot be opened', async () => {
    open({ loading: true });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ rows: [batch(1)] });
    fireEvent.click(await screen.findByRole('button', { name: fill(word('adm.migration.open.action'), { entity: 'LEDGER_1' }) }));
    await within(await screen.findByTestId('batch-detail')).findByTestId('detail-status');
    cleanup();
    const h = open({ rows: [batch(1)] });
    (h.client as unknown as { read: unknown }).read = vi.fn(() => Promise.reject(problem(500, 'INTERNAL_ERROR')));
    fireEvent.click(await screen.findByRole('button', { name: fill(word('adm.migration.open.action'), { entity: 'LEDGER_1' }) }));
    expect(await within(await screen.findByTestId('batch-detail')).findByText(word('states.error.title'))).toBeTruthy();
  });
});
