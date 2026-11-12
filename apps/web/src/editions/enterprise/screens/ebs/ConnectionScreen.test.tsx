import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../../i18n';
import { EBS_ADMIN, EBS_READER, ebsClient, ebsConnection, ebsHealth, ebsNever, ebsRoute, mount, uuid, upload } from '../shared/test-support';
import type { EbsWorld } from '../shared/test-support';
import ConnectionScreen from './ConnectionScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = ebsRoute('EBS-01');
const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const preview = (over: Record<string, unknown> = {}) => ({
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  mode: 'DRY_RUN',
  layout_version: 'WORKING-ASSUMPTION-2026.1',
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: 'd'.repeat(64),
  already_applied: false,
  connection_enabled: true,
  counts: { total: 3, valid: 2, errors: 1, duplicate: 0, conflict: 0 },
  rows: [
    { line: 2, business_key: 'EBS-P001|2026-10|2026-11-02', status: 'VALID', code: null, field: null, outcome: 'RECORD', preview: null },
    { line: 3, business_key: 'UNKNOWN-1|2026-10|2026-11-02', status: 'VALID', code: null, field: null, outcome: 'RECORD_PROJECT_UNKNOWN', preview: null },
    { line: 4, business_key: null, status: 'ERROR', code: 'PERIOD_INVALID', field: 'period', outcome: null, preview: null },
  ],
  rows_truncated: false,
  ...over,
});
const applied = () => ({ operation_id: 'o', status: 'APPLIED', resource_version: 1, resource_id: uuid(30), mode: 'APPLY', layout_version: 'WORKING-ASSUMPTION-2026.1', acceptance: 'PENDING_EXTERNAL', file_sha256: 'd'.repeat(64), counts: { total: 3, applied: 2, duplicate: 0, conflict: 0, quarantined: 1, differences_opened: 0 }, unknown_projects: 1, errors: [], errors_truncated: false });

function mountWith(options: { world?: Partial<EbsWorld>; permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const world: EbsWorld = { connection: ebsConnection(), differences: [], ...options.world };
  const h = ebsClient(world, options.command ?? ((operation) => (operation === 'previewEbsFile' ? preview() : operation === 'importEbsFile' ? applied() : { operation_id: 'o', status: 'OK', resource_version: 6 })));
  mount(<ConnectionScreen route={route} />, h, { permissions: options.permissions ?? EBS_ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('status-card');
};
const content = (id: string): string => screen.getByTestId(id).textContent ?? '';
const chooseFile = (): void => {
  const input = screen.getByTestId('import-file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['project_code,period\nP1,2026-10'], 'ebs.csv', { type: 'text/csv' })] } });
};

describe('ConnectionScreen (EBS-01): the connection to Oracle EBS and the import of its files', () => {
  it('UI-EBS-01 UAT-EBS-PX-01: shows the connection as a file reader, PENDING-EXTERNAL, registered as a proposal, with the layout version and the columns it reads', async () => {
    mountWith();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('ebs.connection.page.title'));
    expect(content('status-card')).toContain('ebs.ledger');
    expect(content('status-card')).toContain('WORKING-ASSUMPTION-2026.1');
    expect(content('status-card')).toContain('PROPOSED');
    expect(content('layout-columns')).toContain('disbursed_vnd');
    expect(screen.getAllByText(word('ent.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(content('counts')).toContain('40');
    expect(await screen.findByTestId('pending-EBS_EXTRACT')).toBeTruthy();
  });

  it('reads the file step by step: upload, dry run that says what each row would do, apply; the figures of the dry run are the file\'s', async () => {
    const { h } = mountWith();
    await loaded();
    chooseFile();
    await screen.findByTestId('upload-result');
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.upload.mock.calls[0]?.[0]).toBe('uploadEbsFile');
    fireEvent.click(screen.getByTestId('dry-run-button'));
    const result = await screen.findByTestId('preview-result');
    expect(within(result).getByTestId('preview-counts').textContent).toContain('3');
    expect(h.command.mock.calls[0]?.[0]).toBe('previewEbsFile');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { file_object_key: 'tenants/t/import/0001', file_sha256: 'd'.repeat(64) } });
    expect(within(result).getAllByRole('row').length).toBeGreaterThan(3);
    fireEvent.click(screen.getByTestId('apply-button'));
    expect((await screen.findByTestId('apply-result')).textContent).toContain('2');
    expect(h.command.mock.calls[1]?.[0]).toBe('importEbsFile');
    fireEvent.click(screen.getByTestId('import-again'));
    expect(screen.getByTestId('import-flow').getAttribute('data-step')).not.toBe('APPLIED');
  });

  it('says which columns a file lacks and does not let it be read', async () => {
    const world: Partial<EbsWorld> = { upload: () => upload({ matches_layout: false, missing_columns: ['period', 'extract_date'] }) };
    mountWith({ world });
    await loaded();
    chooseFile();
    expect((await screen.findByTestId('upload-missing')).textContent?.length).toBeGreaterThan(20);
    expect((screen.getByTestId('dry-run-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says in words why the upload or the apply was refused', async () => {
    mountWith({ world: { upload: () => problem('FILE_NOT_CLEAN', 422) } });
    await loaded();
    chooseFile();
    expect((await screen.findByTestId('import-error')).textContent).not.toBe('');
    cleanup();
    mountWith({ command: (operation) => (operation === 'previewEbsFile' ? preview() : problem('IMPORT_FILE_ALREADY_APPLIED', 409)) });
    await loaded();
    chooseFile();
    await screen.findByTestId('upload-result');
    fireEvent.click(screen.getByTestId('dry-run-button'));
    await screen.findByTestId('preview-result');
    fireEvent.click(screen.getByTestId('apply-button'));
    expect((await screen.findByTestId('import-error')).textContent).not.toBe('');
  });

  it('keeps the apply off for a file already applied and for a connection that is off, while the dry run still reads', async () => {
    mountWith({ command: (operation) => (operation === 'previewEbsFile' ? preview({ already_applied: true }) : applied()) });
    await loaded();
    chooseFile();
    await screen.findByTestId('upload-result');
    fireEvent.click(screen.getByTestId('dry-run-button'));
    await screen.findByTestId('preview-result');
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('apply-blocked').textContent).toBe(word('ebs.import.blocked.already'));
    cleanup();
    mountWith({ world: { connection: ebsConnection({ enabled: false, health: ebsHealth({ apply_blocked: true }) }) }, command: (operation) => (operation === 'previewEbsFile' ? preview({ connection_enabled: false }) : applied()) });
    await loaded();
    chooseFile();
    await screen.findByTestId('upload-result');
    fireEvent.click(screen.getByTestId('dry-run-button'));
    await screen.findByTestId('preview-result');
    expect(screen.getByTestId('apply-blocked').textContent).toBe(word('ebs.import.blocked.disabled'));
  });

  it('offers the dry run to a previewer and the apply only to whoever holds the right to import', async () => {
    mountWith({ permissions: ['ebs.read', 'ebs.import.preview'], world: { connection: ebsConnection({}, { may_import: false, may_switch: false }) } });
    await loaded();
    chooseFile();
    await screen.findByTestId('upload-result');
    fireEvent.click(screen.getByTestId('dry-run-button'));
    await screen.findByTestId('preview-result');
    expect(screen.queryByTestId('apply-button')).toBeNull();
    expect(screen.getByTestId('apply-right')).toBeTruthy();
  });

  it('switches the connection off with a reason under the version it saw', async () => {
    const { h } = mountWith();
    await loaded();
    fireEvent.click(screen.getByTestId('switch-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The extract is being redesigned in EBS' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ent.switch.disable.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('setEbsConnectionState');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { enabled: false, reason: 'The extract is being redesigned in EBS' }, ifMatchVersion: 5 });
    expect((await screen.findByTestId('switch-receipt')).textContent).toBe(word('ebs.switch.done.disabled'));
  });

  it('is a hint, not an alarm, for a tenant that never imported; a stale file is a warning with its rule', async () => {
    mountWith({ world: { connection: ebsNever() } });
    await loaded();
    expect(content('health-explain')).toContain(word('ebs.health.explain.never'));
    expect(screen.getByTestId('runs-empty')).toBeTruthy();
    cleanup();
    mountWith({ world: { connection: ebsConnection({ health: ebsHealth({ status: 'STALE', age_hours: 200, alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' } }) }) } });
    await loaded();
    expect(content('health-explain')).toContain(word('ebs.health.explain.stale'));
    expect(screen.getByTestId('action-list').textContent).not.toBe('');
  });

  it('hides the actions from a reader and in a read-only workspace; the service error has a retry', async () => {
    mountWith({ permissions: EBS_READER, world: { connection: ebsConnection({}, { may_switch: false, may_preview: false, may_import: false, may_reconcile: false }) } });
    await loaded();
    expect(screen.queryByTestId('switch-button')).toBeNull();
    expect(screen.getByTestId('import-denied')).toBeTruthy();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('switch-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('ent.readonly.mode.text'));
    cleanup();
    const { h } = mountWith({ world: { failing: { getEbsConnection: { error: problem('SERVICE_UNAVAILABLE', 503), times: 1 } } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await loaded();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getEbsConnection').length).toBeGreaterThanOrEqual(2);
  });
});
