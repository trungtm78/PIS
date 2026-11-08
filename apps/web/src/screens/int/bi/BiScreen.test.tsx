import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import { clientFor, datasetList, datasetRow, id, mount, problem, readerPage, readerRow, routeFor } from '../test-support';
import BiScreen from './BiScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeFor('INT-04', 'FR-INT-04');
const REASON = 'Đổi mật khẩu định kỳ hằng quý';
const PASSWORD = 'Zx9QpLmN2vBt7YcKd4WfRs8H';

function mountWith(options: { readers?: unknown; datasets?: unknown; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = clientFor(
    {
      listBiReaders: options.readers ?? readerPage([readerRow(1)]),
      listExportDatasets: options.datasets ?? datasetList(),
      getBiReader: { reader: readerRow(1), events: [{ id: id('00f0', 1), action: 'PROVISIONED', reason: null, actor_name: 'Nguyễn Văn An', reader_version: 1, occurred_at: '2026-11-01T02:00:00.000Z' }], as_of: '2026-11-12T03:00:00.000Z' },
    },
    options.command,
  );
  mount(<BiScreen route={route} />, h, { permissions: undefined, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const readerEl = (n: number): HTMLElement => document.querySelector(`[data-reader-id="00000000-0000-4000-8000-0080${String(n).padStart(8, '0')}"]`) as HTMLElement;
const readersShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-reader-id]')).not.toBeNull());
};

describe('BiScreen (INT-04): certified datasets and the logins of BI tools', () => {
  it('UI-INT-04: says how a login is bound, shows each dataset with its gate and the schema to point a tool at', async () => {
    mountWith();
    await readersShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('int.bi.page.title'));
    expect(screen.getByTestId('binding-note').textContent).toBe(t('int.bi.note.binding'));
    await waitFor(() => expect(document.querySelector('[data-dataset="DS-DISB"]')).not.toBeNull());
    const disb = document.querySelector('[data-dataset="DS-DISB"]') as HTMLElement;
    expect(disb.dataset.open).toBe('false');
    expect(within(disb).getByText(t('int.bi.gate.disabled'))).toBeTruthy();
    expect(screen.getByTestId('schema-note').textContent).toBe(t('int.bi.list.schema', { schema: 'machvon_bi', views: 'v_disbursement_lines, v_contract_lines' }));
    expect(screen.getAllByTestId('view-entry')).toHaveLength(2);
    const table = screen.getByRole('table', { name: t('int.bi.table.caption') });
    expect(Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent)).toEqual(['name', 'tool', 'login', 'status', 'limit', 'rotated', 'actions'].map((column) => t(`int.bi.column.${column}` as never)));
  });

  it('shows a dataset that is open and a closed one with the reason it carries', async () => {
    mountWith({ datasets: datasetList([datasetRow('DS-DISB', { enabled: true, product_code: 'DP-A', certification: 'CERTIFIED', certification_expires_on: '2099-01-01', gate: { open: true, reason: null } }), datasetRow('DS-CTR', { enabled: true, product_code: 'DP-B', certification: 'REVOKED', gate: { open: false, reason: 'NOT_CERTIFIED' } })]) });
    await waitFor(() => expect(document.querySelector('[data-dataset="DS-CTR"]')).not.toBeNull());
    expect(within(document.querySelector('[data-dataset="DS-CTR"]') as HTMLElement).getByText(t('int.bi.gate.notCertified'))).toBeTruthy();
    expect((document.querySelector('[data-dataset="DS-DISB"]') as HTMLElement).dataset.open).toBe('true');
  });

  it('shows the empty, error, denied, read-only and frozen states', async () => {
    mountWith({ readers: readerPage([]) });
    expect(await screen.findByTestId('empty')).toBeTruthy();
    cleanup();
    mountWith({ readers: new Error('x'), datasets: new Error('y') });
    await waitFor(() => expect(screen.getAllByTestId('error').length).toBeGreaterThan(0));
    cleanup();
    mountWith({ readers: problem('SCOPE_DENIED', 403), datasets: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByTestId('denied')).toBeTruthy();
    cleanup();
    mountWith({ readers: readerPage([readerRow(1, { actions: { rotate: false, decide: false } })], { can_create: false }) });
    expect(await screen.findByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('int.bi.action.create') })).toBeNull();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await readersShown();
    expect(screen.queryByRole('button', { name: t('int.bi.action.create') })).toBeNull();
    expect(within(readerEl(1)).queryByRole('button', { name: t('int.bi.action.rotate.label', { name: 'Power BI 1' }) })).toBeNull();
  });

  it('makes a login, shows the password once with its warning and forgets it when the dialog is closed', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'r', reader_id: 'r', login_name: 'machvon_bi_abcdefabcdef', password: PASSWORD, shown_once: true, schema_name: 'machvon_bi' }));
    mountWith({ command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.bi.action.create') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.bi.create.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.bi.create.confirm.action') }));
    expect(within(dialog).getByText(t('int.bi.error.name'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('int.bi.field.name.label')), { target: { value: 'Power BI Desktop' } });
    fireEvent.change(within(dialog).getByLabelText(t('int.bi.field.limit.label')), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.bi.create.confirm.action') }));
    const secret = await screen.findByRole('dialog', { name: t('int.bi.secret.created.title', { name: 'Power BI Desktop' }) });
    expect(command).toHaveBeenCalledWith('createBiReader', expect.objectContaining({ body: { name: 'Power BI Desktop', connection_limit: 3 } }));
    expect(within(secret).getByTestId('secret-warning')).toBeTruthy();
    expect(within(secret).getByTestId(`secret-${t('int.bi.secret.password.label')}`).textContent).toBe(PASSWORD);
    fireEvent.click(within(secret).getByRole('button', { name: t('int.common.secret.close.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('rotates with a reason and the version shown, says when the environment cannot make logins, and retires with a warning', async () => {
    const command = vi.fn((operation: string) => (operation === 'rotateBiReaderPassword' ? problem('BI_PROVISIONING_UNAVAILABLE', 503) : { operation_id: 'o', status: 'RETIRED', resource_version: 2, resource_id: 'r' }));
    mountWith({ command });
    await readersShown();
    fireEvent.click(within(readerEl(1)).getByRole('button', { name: t('int.bi.action.rotate.label', { name: 'Power BI 1' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('int.bi.rotate.title') });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.bi.rotate.confirm.action') }));
    await waitFor(() => expect(within(dialog).getAllByText(t('int.common.problem.provisioning')).length).toBeGreaterThan(0));
    expect(command).toHaveBeenCalledWith('rotateBiReaderPassword', expect.objectContaining({ body: { reason: REASON }, ifMatchVersion: 1 }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.common.dialog.cancel.action') }));
    fireEvent.click(within(readerEl(1)).getByRole('button', { name: t('int.bi.action.retire.label', { name: 'Power BI 1' }) }));
    const retire = await screen.findByRole('dialog', { name: t('int.bi.retire.title') });
    expect(within(retire).getByText(t('int.bi.retire.effect'))).toBeTruthy();
    fireEvent.change(within(retire).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(retire).getByRole('button', { name: t('int.bi.retire.confirm.action') }));
    await waitFor(() => expect(screen.getByTestId('receipt').textContent).toBe(t('int.bi.success.retired', { name: 'Power BI 1' })));
  });

  it('switches a dataset on with a product chosen, a reason and the version shown', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'ENABLED', resource_version: 1, resource_id: 'r' }));
    mountWith({ command });
    await waitFor(() => expect(document.querySelector('[data-dataset="DS-DISB"]')).not.toBeNull());
    fireEvent.click(within(document.querySelector('[data-dataset="DS-DISB"]') as HTMLElement).getByRole('button', { name: t('int.bi.datasetActionEnable.label', { name: t('int.bi.dataset.name.disbursement') }) }));
    const dialog = await screen.findByRole('dialog', { name: t('int.bi.dataset.enable.title') });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.bi.datasetEnableConfirm.action') }));
    await waitFor(() => expect(command).toHaveBeenCalledWith('setExportDataset', expect.objectContaining({ body: { dataset_code: 'DS-DISB', enabled: true, product_id: id('0070', 1), reason: REASON }, ifMatchVersion: 1 })));
  });

  it('shows the history of a login', async () => {
    mountWith();
    await readersShown();
    fireEvent.click(within(readerEl(1)).getByRole('button', { name: t('int.bi.action.history.label', { name: 'Power BI 1' }) }));
    const history = await screen.findByTestId('history');
    expect(history.textContent).toContain(t('int.bi.event.provisioned'));
  });
});
