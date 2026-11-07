import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, mount, period, PERIOD, routeOf, world } from '../report/test-support';
import type { World } from '../report/test-support';
import ExportScreen from './ExportScreen';
import { COLUMN_KEYS, canChoose, canExport, describeExport, exportBody, exportIdOf, initialForm, linkOf, toDownload, validateForm } from './model';

const ROUTE = routeOf('DIS-17', 'FR-DIS-17');
const PATH = '/dis/dis-17';
const EXPORTER = ['report.export', 'disbursement.read'];
const SNAPSHOT = '00000000-0000-4000-8000-0000000000d1';
const EXPORT = '00000000-0000-4000-8000-0000000000e1';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const snapshotRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SNAPSHOT,
  period_id: PERIOD,
  snapshot_kind: 'PERIOD_CLOSE',
  status: 'FROZEN',
  as_of_date: '2027-10-10',
  treasury_cutoff_date: '2027-10-10',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 3,
  payload_sha256: 'a'.repeat(64),
  frozen_at: '2027-10-11T03:00:00Z',
  supersedes_id: null,
  created_at: '2027-10-11T02:00:00Z',
  version: 3,
  ...over,
});
const download = { export_id: EXPORT, url: `/report-exports/${EXPORT}/file?tenant=t&expires=1&signature=${'b'.repeat(64)}`, expires_at: '2027-10-15T03:05:00.000Z', format: 'XLSX', rows: 3, file_sha256: 'c'.repeat(64) };

const open = (overrides: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => ({ status: 'READY', resource_id: EXPORT, resource_version: 1 }), permissions: readonly string[] | undefined = EXPORTER) => {
  const h = client(world({ periods: [period(PERIOD, '2027-W40', 'OPEN')], snapshots: { '': { items: [snapshotRecord()], next_cursor: null, pending_reports: null } }, downloads: { [EXPORT]: download }, ...overrides }), command);
  mount(<ExportScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};
const sent = (h: ReturnType<typeof client>): Record<string, unknown> => (h.command.mock.calls.find((call) => call[0] === 'createReportExport')?.[1] as { body: Record<string, unknown> }).body;

describe('DIS-17 report export', () => {
  it('AC-ST-DIS-016-1 / UAT-AC261: makes the file of the snapshot that was chosen in the format and unit that were chosen, then asks for the link, which comes with its expiry and the number of lines', async () => {
    const user = userEvent.setup();
    const h = open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.export.page.title'] })).toBeTruthy();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.format.label']), 'CSV');
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.scale.label']), 'MILLION_VND');
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    expect(await screen.findByTestId('export-ready')).toBeTruthy();
    expect(sent(h)).toEqual({ snapshot_id: SNAPSHOT, format: 'CSV', unit_scale: 'MILLION_VND' });
    expect(screen.queryByTestId('download-link')).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['dis.export.download.action'] }));
    const link = await screen.findByRole('link', { name: vi_['dis.export.download.link'] });
    expect(link.getAttribute('href')).toBe(download.url);
    expect(screen.getByTestId('download-link').textContent).toContain('03:05');
    expect(h.read.mock.calls.some((call) => call[0] === 'getReportExportDownload' && (call[1] as { path: { id: string } }).path.id === EXPORT)).toBe(true);
  });

  it('resolves the link against the base the web app calls the API on (a proxy prefix), and offers a new link after one was issued because a link lives a few minutes', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/');
    const user = userEvent.setup();
    const h = open();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    await user.click(await screen.findByRole('button', { name: vi_['dis.export.download.action'] }));
    expect((await screen.findByRole('link', { name: vi_['dis.export.download.link'] })).getAttribute('href')).toBe(`/api${download.url}`);
    await user.click(screen.getByRole('button', { name: vi_['dis.export.download.renew.action'] }));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getReportExportDownload')).toHaveLength(2));
  });

  it('says the file will carry the sign-off notice while the definitions are not signed, and says nothing once they are', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    expect(screen.getByTestId('export-pending-note').textContent).toBe(vi_['dis.export.pending.note']);
    // The status of the definitions is told in words on the form too, with the rows the file will carry.
    expect(screen.getByText('Định nghĩa chờ ký')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Số dòng của snapshot' })).toBeTruthy();
    cleanup();
    open({ snapshots: { '': { items: [snapshotRecord({ definition_status: 'SIGNED' })], next_cursor: null, pending_reports: null } } });
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    expect(screen.queryByTestId('export-pending-note')).toBeNull();
    expect(screen.getByText('Định nghĩa đã ký')).toBeTruthy();
  });

  it('sends only the columns that were kept, asks for a snapshot and for at least one column before it sends anything', async () => {
    const user = userEvent.setup();
    const h = open();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    expect(await screen.findByText(vi_['dis.export.snapshot.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    for (const key of ['dis.export.col.projectName', 'dis.export.col.unitName']) await user.click(screen.getByLabelText(vi_[key as keyof typeof vi_]));
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(sent(h).columns).toEqual(COLUMN_KEYS.filter((key) => key !== 'project_name' && key !== 'unit_name'));
    cleanup();
    const none = open();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    expect(await screen.findByText(vi_['dis.export.columns.required'])).toBeTruthy();
    expect(none.command).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: vi_['dis.export.columns.all.action'] }));
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((box) => box.checked)).toBe(true);
  });

  it('AC-ST-DIS-016-1: tells a person whose scope has narrowed since the file was made that the link is not issued and that they make the file again', async () => {
    const user = userEvent.setup();
    const state = world({ periods: [period(PERIOD, '2027-W40', 'OPEN')], snapshots: { '': { items: [snapshotRecord()], next_cursor: null, pending_reports: null } } });
    state.failing.set('getReportExportDownload', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    const h = client(state, () => ({ status: 'READY', resource_id: EXPORT, resource_version: 1 }));
    mount(<ExportScreen route={ROUTE} />, h, { permissions: EXPORTER, path: PATH });
    await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
    await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
    await user.click(await screen.findByRole('button', { name: vi_['dis.export.download.action'] }));
    expect((await screen.findByTestId('download-refusal')).textContent).toBe(vi_['dis.export.problem.scopeDenied']);
    expect(screen.queryByTestId('download-link')).toBeNull();
  });

  it('shows the refusals of the server in words: a snapshot that is not frozen, a file above the cap, a request that is not valid', async () => {
    const user = userEvent.setup();
    for (const [code, status, key] of [
      ['SNAPSHOT_NOT_FROZEN', 422, 'dis.export.problem.notFrozen'],
      ['EXPORT_ROW_CAP_EXCEEDED', 422, 'dis.export.problem.rowCap'],
      ['VALIDATION_FAILED', 422, 'dis.export.problem.validation'],
      ['INTERNAL_ERROR', 500, 'dis.export.problem.general'],
    ] as const) {
      cleanup();
      open({}, () => new ApiError({ status, code, correlationId: 'c' }));
      await waitFor(() => expect(within(screen.getByLabelText(vi_['dis.export.snapshot.label'])).getAllByRole('option')).toHaveLength(2));
      await user.selectOptions(screen.getByLabelText(vi_['dis.export.snapshot.label']), SNAPSHOT);
      await user.click(screen.getByRole('button', { name: vi_['dis.export.submit.action'] }));
      expect((await screen.findByTestId('export-refusal')).textContent).toBe(vi_[key]);
    }
  });

  it('tells a person who may export but not read the figures which permission is missing, and asks for no snapshot', async () => {
    const h = open({}, undefined, ['report.export']);
    expect(await screen.findByTestId('export-read-needed')).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['dis.export.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.read.mock.calls.some((call) => call[0] === 'listPeriodSnapshots')).toBe(false);
  });

  it('keeps the form closed to a person without the permission, who is told so', async () => {
    const h = open({}, undefined, ['report.read']);
    expect(await screen.findByTestId('export-denied')).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['dis.export.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('is in each of the seven states: loading, no frozen snapshot, denied, signed out, offline, error, and the form', async () => {
    open({ snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      cleanup();
      const state = world({ periods: [period(PERIOD, '2027-W40', 'OPEN')] });
      state.failing.set('listPeriodSnapshots', error);
      mount(<ExportScreen route={ROUTE} />, client(state), { permissions: EXPORTER, path: PATH });
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });
});

describe('the export model', () => {
  it('builds the request in the words of the contract, judges the form, reads the answers, and names the refusals', () => {
    const form = initialForm();
    expect(exportBody({ ...form, snapshotId: 's' })).toEqual({ snapshot_id: 's', format: 'XLSX' });
    expect(exportBody({ ...form, snapshotId: 's', scale: 'MILLION_VND', columns: ['project_code'] })).toEqual({ snapshot_id: 's', format: 'XLSX', unit_scale: 'MILLION_VND', columns: ['project_code'] });
    expect(validateForm(form)).toBe('snapshotRequired');
    expect(validateForm({ ...form, snapshotId: 's', columns: [] })).toBe('columnsRequired');
    expect(validateForm({ ...form, snapshotId: 's' })).toBeUndefined();
    expect(exportIdOf({ resource_id: 'x' })).toBe('x');
    expect(exportIdOf(undefined)).toBeUndefined();
    expect(toDownload(download)).toMatchObject({ exportId: EXPORT, rows: 3 });
    expect(toDownload({ export_id: 'x' })).toBeUndefined();
    expect([linkOf('/report-exports/x/file?a=1', ''), linkOf('/report-exports/x/file', 'https://api.example.org/'), linkOf('report-exports/x', '/api'), linkOf('https://files.example.org/x', '/api')]).toEqual(['/report-exports/x/file?a=1', 'https://api.example.org/report-exports/x/file', '/api/report-exports/x', 'https://files.example.org/x']);
    expect(canExport(['report.export'])).toBe(true);
    expect(canExport(['report.read'])).toBe(false);
    expect(canExport(undefined)).toBe(true);
    expect([canChoose(['disbursement.read']), canChoose(['report.export']), canChoose(undefined)]).toEqual([true, false, true]);
    expect([describeExport(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })), describeExport(new Error('x'))]).toEqual(['notFound', 'general']);
  });
});
