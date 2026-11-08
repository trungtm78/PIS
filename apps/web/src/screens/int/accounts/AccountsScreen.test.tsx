import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import { account, accountPage, clientFor, credential, mount, problem, routeFor } from '../test-support';
import AccountsScreen from './AccountsScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeFor('INT-01', 'FR-INT-01');
const ONCE_VALUE = 'mvs_TopSecretValueShownOnceOnly0123456789abcd';

function mountWith(items: unknown[] = [account(1), account(2, { status: 'SUSPENDED', status_reason: 'Khóa tạm để kiểm tra', actions: { update: true, decide: true, rotate: false } })], options: { page?: Record<string, unknown>; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; list?: unknown } = {}) {
  const h = clientFor({ listMachineAccounts: options.list ?? accountPage(items, options.page) }, options.command);
  mount(<AccountsScreen route={route} />, h, { permissions: undefined, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-account-id="00000000-0000-4000-8000-00a0${String(n).padStart(8, '0')}"]`) as HTMLElement;
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-account-id]')).not.toBeNull());
};

describe('AccountsScreen (INT-01): the machine accounts of the open API', () => {
  it('UI-INT-01: shows the title, the secret note and the columns of the catalogue', async () => {
    mountWith();
    await rowsShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('int.accounts.page.title'));
    expect(screen.getByTestId('secret-note').textContent).toBe(t('int.accounts.note.secret'));
    const table = screen.getByRole('table', { name: t('int.accounts.table.caption') });
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent);
    expect(headers).toEqual(['name', 'status', 'scopes', 'rate', 'expires', 'credentials', 'lastUsed', 'actions'].map((column) => t(`int.accounts.column.${column}` as never)));
  });

  it('shows an account in words: its scopes, the rate, the hint of its secret (never the secret), the state of the key and the reason of a suspension', async () => {
    mountWith();
    await rowsShown();
    const first = rowOf(1);
    expect(within(first).getByText(t('int.scope.projects'))).toBeTruthy();
    expect(within(first).getByText(t('int.accounts.cell.rate', { rate: 60 }))).toBeTruthy();
    expect(within(first).getByTestId('credential').textContent).toBe(t('int.accounts.cell.credential', { hint: 'mvs_Ab12', state: t('int.accounts.credential.active') }));
    expect(within(rowOf(2)).getByText(t('int.accounts.cell.reason', { reason: 'Khóa tạm để kiểm tra' }))).toBeTruthy();
    expect(within(rowOf(2)).queryByRole('button', { name: t('int.accounts.action.rotate.label', { name: 'Lakehouse 2' }) })).toBeNull();
    expect(within(rowOf(2)).getByRole('button', { name: t('int.accounts.action.reactivate.label', { name: 'Lakehouse 2' }) })).toBeTruthy();
    expect(document.body.textContent).not.toContain('mvs_Ab12abcdefghijklmnopqrstuvwxyz');
  });

  it('shows the loading state while the list is on its way', async () => {
    const h = clientFor({ listMachineAccounts: () => new Promise(() => undefined) });
    mount(<AccountsScreen route={route} />, h);
    await waitFor(() => expect(screen.getByRole('table', { name: t('int.accounts.table.caption') })).toBeTruthy());
    expect(document.querySelector('[data-account-id]')).toBeNull();
  });

  it('says why a list is empty, and offers to open the first account', async () => {
    mountWith([]);
    expect(await screen.findByTestId('empty')).toBeTruthy();
    expect(screen.getByText(t('int.accounts.empty.title'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('int.accounts.action.create') })).toBeTruthy();
  });

  it('shows a failed read as an error with a retry, never as no data', async () => {
    const h = clientFor({ listMachineAccounts: new Error('boom') });
    mount(<AccountsScreen route={route} />, h);
    expect(await screen.findByTestId('error')).toBeTruthy();
    expect(screen.queryByTestId('empty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listMachineAccounts').length).toBeGreaterThan(1));
  });

  it('shows the denied state when the read is refused for scope', async () => {
    mountWith([], { list: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByTestId('denied')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('int.accounts.action.create') })).toBeNull();
  });

  it('is read-only for a person who may not create: the note is there and no action is offered', async () => {
    mountWith([account(1, { actions: { update: false, decide: false, rotate: false } })], { page: { can_create: false } });
    await rowsShown();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('int.accounts.readonly.notice'));
    expect(screen.queryByRole('button', { name: t('int.accounts.action.create') })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button', { name: t('int.accounts.action.revoke.label', { name: 'Lakehouse 1' }) })).toBeNull();
  });

  it('offers no action to a frozen session (the tenant is read-only)', async () => {
    mountWith(undefined, { mode: 'READ_ONLY' });
    await rowsShown();
    expect(screen.queryByRole('button', { name: t('int.accounts.action.create') })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button', { name: t('int.accounts.action.suspend.label', { name: 'Lakehouse 1' }) })).toBeNull();
  });

  it('puts the status chosen on a chip in the address and asks for it', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(screen.getByRole('button', { name: t('int.accounts.chip.label', { label: t('int.accounts.status.suspended'), count: 0 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?status=SUSPENDED'));
    await waitFor(() => expect(h.read.mock.calls.some(([, input]) => (input as { query?: Record<string, unknown> }).query?.status === 'SUSPENDED')).toBe(true));
  });

  it('opens an account: validates the form, sends the body, shows the secret once with a warning, and forgets it when the dialog is closed', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'r', account_id: 'r', credential_id: 'c', client_id: 'mvc_newclientidnewclientidnew', client_secret: ONCE_VALUE, secret_hint: 'mvs_TopS', shown_once: true, token_url: '/open/v1/token' }));
    mountWith(undefined, { command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.accounts.action.create') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.accounts.create.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.accounts.create.confirm.action') }));
    expect(within(dialog).getByText(t('int.accounts.error.name'))).toBeTruthy();
    expect(within(dialog).getByText(t('int.accounts.error.scopes'))).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('int.accounts.field.name.label')), { target: { value: 'Power BI ministry' } });
    fireEvent.click(within(dialog).getByLabelText(new RegExp(t('int.scope.projects'))));
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.accounts.field.rate.label', { min: 1, max: 6000 }).slice(0, 12))), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.accounts.create.confirm.action') }));
    const secretDialog = await screen.findByRole('dialog', { name: t('int.accounts.secret.created.title', { name: 'Power BI ministry' }) });
    expect(command).toHaveBeenCalledWith('createMachineAccount', expect.objectContaining({ body: { name: 'Power BI ministry', scopes: ['open.projects.read'], rate_limit_per_minute: 120 } }));
    expect(within(secretDialog).getByTestId('secret-warning').textContent).toBe(t('int.common.secret.warning'));
    expect(within(secretDialog).getByTestId(`secret-${t('int.accounts.secret.clientSecret.label')}`).textContent).toBe(ONCE_VALUE);
    fireEvent.click(within(secretDialog).getByRole('button', { name: t('int.common.secret.close.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(ONCE_VALUE);
    expect(screen.getByTestId('receipt').textContent).toBe(t('int.accounts.success.created', { name: 'Power BI ministry' }));
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('says in the dialog that the name is taken, and keeps the form', async () => {
    const command = vi.fn(() => problem('OPEN_ACCOUNT_NAME_TAKEN', 409));
    mountWith(undefined, { command });
    fireEvent.click(await screen.findByRole('button', { name: t('int.accounts.action.create') }));
    const dialog = await screen.findByRole('dialog', { name: t('int.accounts.create.title') });
    fireEvent.change(within(dialog).getByLabelText(t('int.accounts.field.name.label')), { target: { value: 'Taken' } });
    fireEvent.click(within(dialog).getByLabelText(new RegExp(t('int.scope.contracts'))));
    fireEvent.click(within(dialog).getByRole('button', { name: t('int.accounts.create.confirm.action') }));
    await waitFor(() => expect(within(dialog).getAllByText(t('int.common.problem.nameTaken')).length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog', { name: t('int.accounts.secret.created.title', { name: 'Taken' }) })).toBeNull();
  });

  it('suspends with a reason and the version the person was shown', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'SUSPENDED', resource_version: 4, resource_id: 'r' }));
    mountWith(undefined, { command });
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('int.accounts.action.suspend.label', { name: 'Lakehouse 1' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('int.accounts.suspend.title') });
    const confirm = within(dialog).getByRole('button', { name: t('int.accounts.suspend.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: 'Khóa vì nghi lộ bí mật' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(command).toHaveBeenCalledWith('decideMachineAccount', expect.objectContaining({ path: { id: rowOf(1).dataset.accountId }, body: { decision: 'SUSPEND', reason: 'Khóa vì nghi lộ bí mật' }, ifMatchVersion: 3 })));
    await waitFor(() => expect(screen.getByTestId('receipt').textContent).toBe(t('int.accounts.success.suspended', { name: 'Lakehouse 1' })));
  });

  it('answers a version conflict in the dialog with a reload, and rotates a key showing the new secret once', async () => {
    let calls = 0;
    const command = vi.fn((operation: string) => {
      if (operation === 'decideMachineAccount') return problem('VERSION_CONFLICT', 409, { current_version: 9 });
      calls += 1;
      return { operation_id: 'o', status: 'ACTIVE', resource_version: 5, resource_id: 'r', account_id: 'r', credential_id: 'c', client_id: 'mvc_rotatedclientidrotatedcl', client_secret: ONCE_VALUE, secret_hint: 'mvs_TopS', shown_once: true, token_url: '/open/v1/token' };
    });
    mountWith(undefined, { command });
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('int.accounts.action.revoke.label', { name: 'Lakehouse 1' }) }));
    const stale = await screen.findByRole('dialog', { name: t('int.accounts.revoke.title') });
    fireEvent.change(within(stale).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: 'Thu hồi vì hết hợp đồng' } });
    fireEvent.click(within(stale).getByRole('button', { name: t('int.accounts.revoke.confirm.action') }));
    await waitFor(() => expect(within(stale).getAllByText(t('int.common.problem.versionConflict')).length).toBeGreaterThan(0));
    expect(within(stale).getByRole('button', { name: t('int.common.problem.reload.action') })).toBeTruthy();
    fireEvent.click(within(stale).getByRole('button', { name: t('int.common.dialog.cancel.action') }));
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('int.accounts.action.rotate.label', { name: 'Lakehouse 1' }) }));
    const rotate = await screen.findByRole('dialog', { name: t('int.accounts.rotate.title') });
    fireEvent.change(within(rotate).getByLabelText(t('int.accounts.field.grace.label')), { target: { value: '99' } });
    fireEvent.change(within(rotate).getByLabelText(new RegExp(t('int.common.dialog.reason.label'))), { target: { value: 'Đổi khóa định kỳ hằng quý' } });
    fireEvent.click(within(rotate).getByRole('button', { name: t('int.accounts.rotate.confirm.action') }));
    expect(within(rotate).getByText(t('int.accounts.error.grace'))).toBeTruthy();
    fireEvent.change(within(rotate).getByLabelText(t('int.accounts.field.grace.label')), { target: { value: '12' } });
    fireEvent.click(within(rotate).getByRole('button', { name: t('int.accounts.rotate.confirm.action') }));
    const secretDialog = await screen.findByRole('dialog', { name: t('int.accounts.secret.rotated.title', { name: 'Lakehouse 1' }) });
    expect(calls).toBe(1);
    expect(within(secretDialog).getByTestId(`secret-${t('int.accounts.secret.clientSecret.label')}`).textContent).toBe(ONCE_VALUE);
    expect(command).toHaveBeenCalledWith('rotateMachineCredential', expect.objectContaining({ body: { reason: 'Đổi khóa định kỳ hằng quý', grace_hours: 12 }, ifMatchVersion: 3 }));
  });

  it('shows a second page when the server gives a cursor', async () => {
    const list = vi.fn((input: unknown) => ((input as { query: Record<string, unknown> }).query.cursor === undefined ? accountPage([account(1)], { next_cursor: 'c2' }) : accountPage([account(2)])));
    const h = clientFor({ listMachineAccounts: list });
    mount(<AccountsScreen route={route} />, h);
    await rowsShown();
    fireEvent.click(await screen.findByRole('button', { name: t('int.common.paging.more') }));
    await waitFor(() => expect(rowOf(2)).not.toBeNull());
    expect(screen.getByTestId('shown').textContent).toBe(t('int.common.paging.summary', { shown: 2 }));
    expect(credential(1).state).toBe('ACTIVE');
  });
});
