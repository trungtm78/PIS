import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { describeViolations, seriousViolations } from '../../test/axe';
import AccountsScreen from './accounts/AccountsScreen';
import ScopesKeysScreen from './accounts/ScopesKeysScreen';
import BiScreen from './bi/BiScreen';
import CodesScreen from './codes/CodesScreen';
import AccessLogScreen from './log/AccessLogScreen';
import { AS_OF, account, accountPage, clientFor, codePage, codeRow, credential, datasetList, logEntry, mount, readerPage, readerRow, routeFor, systemRow } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECRET = 'mvs_TopSecretValueShownOnceOnly0123456789abcd';
const CREATED = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'r', account_id: 'r', credential_id: 'c', client_id: 'mvc_newclientidnewclientidnew', client_secret: SECRET, secret_hint: 'mvs_TopS', shown_once: true, token_url: '/open/v1/token' };

describe('UAT-INT-A11-01 the secret that is shown once, and the tables of the open interface with data', () => {
  it('UAT-INT-A11-01 INT-01 opens an account with the keyboard, the secret is text in the dialog, its copy buttons work with the keys, nothing but the close button closes it, and it has no serious axe violation', async () => {
    const command = vi.fn(() => CREATED);
    const h = clientFor({ listMachineAccounts: accountPage([account(1)]) }, command);
    mount(<AccountsScreen route={routeFor('INT-01', 'FR-INT-01')} />, h, { permissions: undefined });
    const user = userEvent.setup();
    const opener = await screen.findByRole('button', { name: t('int.accounts.action.create') });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: t('int.accounts.create.title') });
    await user.click(within(dialog).getByLabelText(t('int.accounts.field.name.label')));
    await user.keyboard('Power BI ministry');
    within(dialog).getByLabelText(new RegExp(t('int.scope.projects'))).focus();
    await user.keyboard(' ');
    within(dialog).getByRole('button', { name: t('int.accounts.create.confirm.action') }).focus();
    await user.keyboard('{Enter}');

    const secretDialog = await screen.findByRole('dialog', { name: t('int.accounts.secret.created.title', { name: 'Power BI ministry' }) });
    // Readable: the secret is the text of an element that is in the accessibility tree, beside a warning that says it is shown once.
    const value = within(secretDialog).getByTestId(`secret-${t('int.accounts.secret.clientSecret.label')}`);
    expect(value.textContent).toBe(SECRET);
    expect(value.closest('[aria-hidden="true"]')).toBeNull();
    expect(within(secretDialog).getByRole('alert').textContent).toBe(t('int.common.secret.warning'));
    expect(secretDialog.contains(document.activeElement)).toBe(true);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);

    // The copy buttons are buttons with a name that says what they copy, and work with the Enter key.
    const copy = within(secretDialog).getByRole('button', { name: t('int.common.secret.copy.label', { label: t('int.accounts.secret.clientSecret.label') }) });
    copy.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(copy.textContent).toBe(t('int.common.secret.copied')));
    expect(await navigator.clipboard.readText()).toBe(SECRET);

    // Not closed by accident: a click on the backdrop, another copy with the Space key and a stray key leave the dialog open with the secret in it.
    await user.click(secretDialog.parentElement as HTMLElement);
    copy.focus();
    await user.keyboard(' ');
    await user.keyboard('x');
    expect(screen.queryByRole('dialog', { name: t('int.accounts.secret.created.title', { name: 'Power BI ministry' }) })).not.toBeNull();
    expect(within(secretDialog).getByTestId(`secret-${t('int.accounts.secret.clientSecret.label')}`).textContent).toBe(SECRET);

    // The close button closes it, and nothing of the secret stays on the page.
    within(secretDialog).getByRole('button', { name: t('int.common.secret.close.action') }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('UAT-INT-A11-01 INT-02 gives the call example, which scrolls when it is long, a name and a place in the Tab order, and has no serious axe violation', async () => {
    const detail = account(1, { credentials: [credential(2), credential(1, { state: 'RETIRING', superseded_at: '2026-11-10T02:00:00.000Z', expires_at: '2026-11-11T02:00:00.000Z' })] });
    mount(<ScopesKeysScreen route={routeFor('INT-02', 'FR-INT-02')} />, clientFor({ listMachineAccounts: accountPage([detail]), getMachineAccount: detail }), { permissions: undefined, path: `/?account=${detail.id}` });
    const snippet = await screen.findByTestId('call-snippet');
    expect(snippet.tabIndex).toBe(0);
    expect(screen.getByRole('region', { name: t('int.keys.call.title') })).toBe(snippet);
    for (const table of screen.getAllByRole('table')) expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-INT-A11-01 INT-04 has the table of BI accounts with column headers, the datasets as a table, and no serious axe violation', async () => {
    const h = clientFor({
      listBiReaders: readerPage([readerRow(1)]),
      listExportDatasets: datasetList(),
      getBiReader: { reader: readerRow(1), events: [], as_of: AS_OF },
    });
    mount(<BiScreen route={routeFor('INT-04', 'FR-INT-04')} />, h, { permissions: undefined });
    await waitFor(() => expect(document.querySelector('[data-reader-id]')).not.toBeNull());
    for (const table of screen.getAllByRole('table')) expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-INT-A11-01 INT-03 (codes) and INT-05 (access log) are tables with a caption and column headers and have no serious axe violation', async () => {
    mount(
      <CodesScreen route={routeFor('INT-03', 'FR-INT-03')} />,
      clientFor({ listProjectCodes: codePage([codeRow(1), codeRow(2, { status: 'ACTIVE', approved_by_name: 'Trần Thị Bình', approved_at: '2026-11-02T03:00:00.000Z', actions: { decide: false, retire: true } })]), listSourceSystems: { items: [systemRow(1)], kinds: ['ERP'], can_register: true, as_of: AS_OF } }),
      { permissions: undefined },
    );
    await waitFor(() => expect(document.querySelector('[data-code-id]')).not.toBeNull());
    for (const table of screen.getAllByRole('table')) expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    cleanup();
    const log = { items: [logEntry(1), logEntry(2, { outcome: 'RATE_LIMITED', status: 429, row_count: null, scope: null, query_keys: [] })], next_cursor: null, outcomes: ['OK', 'RATE_LIMITED'], as_of: AS_OF };
    mount(<AccessLogScreen route={routeFor('INT-05', 'FR-INT-05')} />, clientFor({ listOpenAccessLog: log }), { permissions: undefined });
    await waitFor(() => expect(document.querySelector('[data-entry-id]')).not.toBeNull());
    const table = screen.getByRole('table', { name: t('int.log.table.caption') });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(10);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('negative control: the axe helper reports a button without a name', async () => {
    document.body.innerHTML = '<main><h1>t</h1><button></button></main>';
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('button-name');
  });
});
