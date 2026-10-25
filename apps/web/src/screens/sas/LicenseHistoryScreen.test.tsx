import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import LicenseHistoryScreen from './LicenseHistoryScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-16', 'FR-SAS-16');
const LICENSE_ADMIN = ['system.license.manage', 'system.tenant.read'];
const READER = ['system.tenant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000a2';
const FIRST = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';

const revision = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: n === 1 ? FIRST : SECOND,
  tenant_id: TENANT,
  serial: 'LIC-20261023-0001',
  revision: n,
  edition: 'STANDARD',
  status: n === 1 ? 'Superseded' : 'Active',
  valid_from: n === 1 ? '2026-10-01T00:00:00.000Z' : '2027-08-01T00:00:00.000Z',
  valid_until: n === 1 ? '2027-10-01T00:00:00.000Z' : '2028-10-01T00:00:00.000Z',
  grace_until: n === 1 ? '2027-10-31T00:00:00.000Z' : '2028-10-31T00:00:00.000Z',
  seats: 50,
  quota: {},
  issuer: 'machvon-platform',
  status_reason: null,
  key_id: 'kid-2026',
  entitlement_version_id: '00000000-0000-4000-8000-0000000000b1',
  supersedes_id: n === 1 ? null : FIRST,
  signature_check: 'VALID',
  expiring: false,
  version: n === 1 ? 2 : 1,
  ...overrides,
});

let pages: Array<{ items: unknown[]; next_cursor: string | null }> = [];

function answer(operation: string, input: unknown): unknown {
  if (operation === 'listSystemTenantLicenses') {
    const query = (input as { query?: { cursor?: string } }).query;
    return query?.cursor === undefined ? pages[0] : pages[1];
  }
  if (operation === 'listSystemTenants') return { items: [{ id: TENANT, code: 'cao-bang', name: 'Cao Bằng', status: 'Active' }, { id: OTHER_TENANT, code: 'lang-son', name: 'Lạng Sơn', status: 'Active' }], next_cursor: null };
  return new Error('unexpected read');
}

const open = (path: string, permissions: readonly string[] | undefined = LICENSE_ADMIN, read: (operation: string, input: unknown) => unknown = answer) => {
  const h = harness(read);
  mount(<LicenseHistoryScreen route={ROUTE} />, h, permissions, path);
  return h;
};

afterEach(() => {
  cleanup();
  pages = [];
});

describe('SAS-16 license history', () => {
  it('AC-ST-SAS-014-3: shows the chain of revisions in order with the state, the window, what each replaced, the signature, the revision in force and the propagation objective', async () => {
    pages = [{ items: [revision(2), revision(1)], next_cursor: null }];
    open(`/sas/sas-16?tenant=${TENANT}`);
    const chain = await screen.findByTestId('chain');
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.licenseHistory.page.title'] })).toBeTruthy();
    const items = Array.from(chain.querySelectorAll('li'));
    expect(items.map((item) => item.getAttribute('data-license-id'))).toEqual([FIRST, SECOND]);
    expect(items.map((item) => item.getAttribute('data-current'))).toEqual(['false', 'true']);
    expect(within(items[0] as HTMLElement).getByText(vi_['sas.license.status.superseded'])).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(vi_['sas.license.status.active'])).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByTestId('current-mark').textContent).toContain(vi_['sas.licenseHistory.current.label']);
    expect(within(items[1] as HTMLElement).getByTestId('supersedes').textContent).toBe(vi_['sas.licenseHistory.supersedes.text'].replace('{revision}', '1'));
    expect(within(items[0] as HTMLElement).queryByTestId('supersedes')).toBeNull();
    expect(within(items[0] as HTMLElement).getByText(vi_['sas.license.signature.valid'])).toBeTruthy();
    expect(screen.getByTestId('slo').textContent).toContain(vi_['sas.licenseHistory.slo.text']);
    expect(screen.getByText(vi_['sas.licenseHistory.footer.reference'].replace('{id}', 'SAS-16').replace('{req}', 'FR-SAS-16'))).toBeTruthy();
    // The revision in force can be renewed, the replaced one cannot.
    expect(within(items[1] as HTMLElement).getByRole('link', { name: vi_['sas.licenseHistory.renew.action'] }).getAttribute('href')).toBe(`/sas/sas-14?license=${SECOND}`);
    expect(within(items[0] as HTMLElement).queryByRole('link', { name: vi_['sas.licenseHistory.renew.action'] })).toBeNull();
    expect(within(items[0] as HTMLElement).getByRole('link', { name: vi_['sas.licenseHistory.open.action'] }).getAttribute('href')).toBe(`/sas/sas-13?license=${FIRST}`);
  });

  it('offers no renewal to someone who may only read, and shows the reason of a suspension', async () => {
    pages = [{ items: [revision(1, { status: 'Suspended', status_reason: 'Under review of the contract.' })], next_cursor: null }];
    open(`/sas/sas-16?tenant=${TENANT}`, READER);
    await screen.findByTestId('chain');
    expect(screen.queryByRole('link', { name: vi_['sas.licenseHistory.renew.action'] })).toBeNull();
    expect(screen.getByText(vi_['sas.licenseHistory.reason.text'].replace('{reason}', 'Under review of the contract.'))).toBeTruthy();
  });

  it('asks for a tenant first, and reads the history of the one chosen', async () => {
    const user = userEvent.setup();
    pages = [{ items: [revision(2), revision(1)], next_cursor: null }];
    const h = open('/sas/sas-16');
    expect((await screen.findByTestId('choose-tenant')).textContent).toBe(vi_['sas.licenseHistory.missing.notice']);
    expect(h.read).not.toHaveBeenCalledWith('listSystemTenantLicenses', expect.anything());
    await screen.findByRole('option', { name: 'Cao Bằng' });
    await user.selectOptions(screen.getByLabelText(vi_['sas.licenseHistory.tenant.label']), TENANT);
    await screen.findByTestId('chain');
    expect(h.read).toHaveBeenCalledWith('listSystemTenantLicenses', expect.objectContaining({ path: { tenantId: TENANT } }));
  });

  it('loads the next page on request', async () => {
    const user = userEvent.setup();
    pages = [
      { items: [revision(1)], next_cursor: 'next' },
      { items: [revision(2)], next_cursor: null },
    ];
    open(`/sas/sas-16?tenant=${TENANT}`);
    await screen.findByTestId('chain');
    expect(document.querySelectorAll('[data-license-id]')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseHistory.more.action'] }));
    await waitFor(() => expect(document.querySelectorAll('li[data-license-id]')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: vi_['sas.licenseHistory.more.action'] })).toBeNull();
  });

  it('says so when the tenant has no license', async () => {
    pages = [{ items: [], next_cursor: null }];
    open(`/sas/sas-16?tenant=${TENANT}`);
    expect((await screen.findByTestId('no-licenses')).textContent).toBe(vi_['sas.licenseHistory.empty.notice']);
  });

  it('shows the error state when the licenses cannot be read, and reads them again on retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    pages = [{ items: [revision(1)], next_cursor: null }];
    const h = open(`/sas/sas-16?tenant=${TENANT}`, LICENSE_ADMIN, (operation, input) => (operation === 'listSystemTenantLicenses' && fail ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) : answer(operation, input)));
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    fail = false;
    await user.click(retry);
    await screen.findByTestId('chain');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listSystemTenantLicenses').length).toBeGreaterThanOrEqual(2);
  });

  describe('the seven states (AC-ST-SAS-014-3)', () => {
    const mountFailing = (error: ApiError) =>
      open(`/sas/sas-16?tenant=${TENANT}`, LICENSE_ADMIN, (operation, input) => (operation === 'listSystemTenantLicenses' ? error : answer(operation, input)));

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      mountFailing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mountFailing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mountFailing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mountFailing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
