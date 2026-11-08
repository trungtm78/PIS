import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import { account, accountPage, clientFor, credential, mount, problem, routeFor } from '../test-support';
import ScopesKeysScreen from './ScopesKeysScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeFor('INT-02', 'FR-INT-02');

describe('ScopesKeysScreen (INT-02): the scopes of the open API and the keys of an account', () => {
  it('UI-INT-02 AC-ST-INT-001-5: lists the scopes with the dataset behind each and how many accounts hold it, and never shows a secret', async () => {
    const h = clientFor({ listMachineAccounts: accountPage([account(1), account(2, { status: 'REVOKED', scopes: ['open.projects.read'] })]) });
    mount(<ScopesKeysScreen route={route} />, h);
    await waitFor(() => expect(document.querySelector('[data-scope]')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('int.keys.page.title'));
    expect(screen.getByTestId('secret-note').textContent).toBe(t('int.keys.note.secret'));
    const projects = document.querySelector('[data-scope="open.projects.read"]') as HTMLElement;
    expect(within(projects).getByText(t('int.keys.cell.register'))).toBeTruthy();
    // The revoked account holds nothing: one account holds the scope.
    expect(Array.from(projects.querySelectorAll('td')).pop()?.textContent).toBe('1');
    const disbursement = document.querySelector('[data-scope="open.disbursement.read"]') as HTMLElement;
    expect(within(disbursement).getByText('DS-DISB')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: t('int.keys.pick.title') })).toBeTruthy();
  });

  it('shows every credential of the chosen account with its hint and state, and the way to call', async () => {
    const detail = account(1, { credentials: [credential(2), credential(1, { state: 'RETIRING', superseded_at: '2026-11-10T02:00:00.000Z', expires_at: '2026-11-11T02:00:00.000Z' })] });
    const h = clientFor({ listMachineAccounts: accountPage([detail]), getMachineAccount: detail });
    mount(<ScopesKeysScreen route={route} />, h, { permissions: undefined, path: `/?account=${detail.id}` });
    await waitFor(() => expect(document.querySelectorAll('[data-credential-id]').length).toBe(2));
    expect(Array.from(document.querySelectorAll('[data-state]')).map((row) => row.getAttribute('data-state'))).toEqual(['ACTIVE', 'RETIRING']);
    expect(screen.getByTestId('call-snippet').textContent).toContain('/open/v1/token');
    expect(screen.getByTestId('call-snippet').textContent).toContain('<client_secret>');
    expect(document.body.textContent).not.toMatch(/mvs_[A-Za-z0-9_-]{20,}/);
  });

  it('says the account is not found, shows an error with a retry, and the denied state', async () => {
    const missing = clientFor({ listMachineAccounts: accountPage([account(1)]), getMachineAccount: problem('RESOURCE_NOT_FOUND', 404) });
    mount(<ScopesKeysScreen route={route} />, missing, { permissions: undefined, path: '/?account=00000000-0000-4000-8000-00a000000009' });
    expect(await screen.findByText(t('int.keys.notFound.title'))).toBeTruthy();
    cleanup();
    const failing = clientFor({ listMachineAccounts: new Error('boom') });
    mount(<ScopesKeysScreen route={route} />, failing);
    expect(await screen.findByTestId('error')).toBeTruthy();
    cleanup();
    const denied = clientFor({ listMachineAccounts: problem('SCOPE_DENIED', 403) });
    mount(<ScopesKeysScreen route={route} />, denied);
    expect(await screen.findByTestId('denied')).toBeTruthy();
  });

  it('says there are no accounts to choose when there are none', async () => {
    mount(<ScopesKeysScreen route={route} />, clientFor({ listMachineAccounts: accountPage([]) }));
    expect(await screen.findByTestId('empty')).toBeTruthy();
  });
});
