import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import LicenseDetailScreen from './LicenseDetailScreen';
import { PLATFORM_OPERATOR, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-13', 'FR-SAS-13');
const LICENSE_ADMIN = ['system.license.manage', 'system.tenant.read'];
const LICENSE = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000a2';
const ENTITLEMENT = '00000000-0000-4000-8000-0000000000b1';

const license = (overrides: Record<string, unknown> = {}) => ({
  id: LICENSE,
  tenant_id: TENANT,
  serial: 'LIC-20261023-0001',
  revision: 1,
  edition: 'STANDARD',
  status: 'Active',
  valid_from: '2026-10-01T00:00:00.000Z',
  valid_until: '2027-10-01T00:00:00.000Z',
  grace_until: '2027-10-31T00:00:00.000Z',
  seats: 50,
  quota: {},
  issuer: 'machvon-platform',
  issued_by: null,
  issued_at: null,
  status_reason: null,
  deployment_binding: null,
  offline_lease_until: null,
  key_id: 'kid-2026',
  entitlement_version_id: ENTITLEMENT,
  supersedes_id: null,
  signature_check: 'VALID',
  expiring: false,
  version: 3,
  ...overrides,
});

let current: Record<string, unknown> = license();
let pages: Array<{ items: unknown[]; next_cursor: string | null }> = [];

function answer(operation: string, input: unknown): unknown {
  if (operation === 'getSystemLicense') return current;
  if (operation === 'listSystemTenantLicenses') {
    const query = (input as { query?: { cursor?: string } }).query;
    return query?.cursor === undefined ? pages[0] : pages[1];
  }
  if (operation === 'listSystemTenants') {
    return { items: [{ id: TENANT, code: 'cao-bang', name: 'Cao Bằng', status: 'Active' }, { id: OTHER_TENANT, code: 'lang-son', name: 'Lạng Sơn', status: 'Active' }], next_cursor: null };
  }
  return new Error('unexpected read');
}

const open = (path: string, permissions: readonly string[] | undefined = LICENSE_ADMIN, read: (operation: string, input: unknown) => unknown = answer) => {
  const h = harness(read);
  mount(<LicenseDetailScreen route={ROUTE} />, h, permissions, path);
  return h;
};

afterEach(() => {
  cleanup();
  current = license();
  pages = [];
});

describe('SAS-13 license detail', () => {
  it('shows the revision with its identity, window, seats, key, entitlement and the result of the signature check', async () => {
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByText('LIC-20261023-0001')).toBeTruthy();
    expect(screen.getByText(vi_['sas.license.status.active'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.license.edition.standard'])).toBeTruthy();
    expect(screen.getByText('50')).toBeTruthy();
    expect(screen.getByText('kid-2026')).toBeTruthy();
    expect(screen.getByText(ENTITLEMENT)).toBeTruthy();
    expect(screen.getByText(vi_['sas.license.signature.valid'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.licenseDetail.page.title'] })).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseDetail.footer.reference'].replace('{id}', 'SAS-13').replace('{req}', 'FR-SAS-13'))).toBeTruthy();
  });

  it('writes the window in UTC whatever the zone of the browser', async () => {
    open(`/sas/sas-13?license=${LICENSE}`);
    await screen.findByText('LIC-20261023-0001');
    const from = new Intl.DateTimeFormat('vi', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date('2026-10-01T00:00:00.000Z'));
    expect(screen.getByText(from)).toBeTruthy();
  });

  it('shows what the server wrote for a date it cannot read', async () => {
    current = license({ valid_from: 'soon' });
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByText('soon')).toBeTruthy();
  });

  it.each([
    ['Draft', 'sas.license.status.draft'],
    ['Scheduled', 'sas.license.status.scheduled'],
    ['Active', 'sas.license.status.active'],
    ['Grace', 'sas.license.status.grace'],
    ['Expired', 'sas.license.status.expired'],
    ['Suspended', 'sas.license.status.suspended'],
    ['Revoked', 'sas.license.status.revoked'],
    ['Superseded', 'sas.license.status.superseded'],
  ] as const)('shows the %s state with its own label and badge colour', async (status, key) => {
    current = license({ status });
    open(`/sas/sas-13?license=${LICENSE}`);
    await screen.findByText('LIC-20261023-0001');
    const badge = document.querySelector('[data-license-status]');
    expect(badge?.textContent).toBe(vi_[key]);
    expect(badge?.getAttribute('data-license-status')).toBe(status);
  });

  it('marks a license that is about to end as expiring, and shows the reason of a suspension', async () => {
    current = license({ expiring: true, status: 'Active' });
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByText(vi_['sas.licenseDetail.expiring.label'])).toBeTruthy();
    cleanup();
    current = license({ status: 'Suspended', status_reason: 'Held for the review of the contract.' });
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByText('Held for the review of the contract.')).toBeTruthy();
  });

  it.each([
    ['VALID', 'sas.license.signature.valid'],
    ['MALFORMED', 'sas.license.signature.malformed'],
    ['UNKNOWN_KEY', 'sas.license.signature.unknownKey'],
    ['BAD_SIGNATURE', 'sas.license.signature.badSignature'],
    ['CLAIMS_MISMATCH', 'sas.license.signature.claimsMismatch'],
  ] as const)('tells a %s signature in its own words, and only a valid one is green', async (check, key) => {
    current = license({ signature_check: check });
    open(`/sas/sas-13?license=${LICENSE}`);
    const badge = await screen.findByText(vi_[key]);
    expect(badge.closest('[data-signature-check]')?.getAttribute('data-signature-check')).toBe(check);
    expect(badge.closest('.ui-pill')?.className).toContain(check === 'VALID' ? 'ui-tone-success' : 'ui-tone-danger');
  });

  it('shows the signed-claims text the server gave for a state it does not know, and a dash for what the revision lacks', async () => {
    current = license({ signature_check: 'FUTURE_CHECK', status: 'Quarantined', seats: null });
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByText('FUTURE_CHECK')).toBeTruthy();
    expect(screen.getByText('Quarantined')).toBeTruthy();
    expect(screen.getAllByText(vi_['sas.licenseDetail.none.text']).length).toBeGreaterThan(0);
  });

  it('offers the change of state to a person who manages licenses, naming the license', async () => {
    open(`/sas/sas-13?license=${LICENSE}`);
    const link = await screen.findByRole('link', { name: vi_['sas.licenseDetail.actions.change'] });
    expect(link.getAttribute('href')).toBe(`/sas/sas-15?license=${LICENSE}`);
  });

  it('offers it for a suspended license, and nothing for a revoked, expired or superseded one', async () => {
    current = license({ status: 'Suspended', status_reason: 'Held for the review.' });
    open(`/sas/sas-13?license=${LICENSE}`);
    expect(await screen.findByRole('link', { name: vi_['sas.licenseDetail.actions.change'] })).toBeTruthy();
    for (const status of ['Revoked', 'Expired', 'Superseded']) {
      cleanup();
      current = license({ status });
      open(`/sas/sas-13?license=${LICENSE}`);
      await screen.findByText(vi_['sas.licenseDetail.actions.none']);
      expect(screen.queryByRole('link', { name: vi_['sas.licenseDetail.actions.change'] })).toBeNull();
    }
  });

  it('gives a registry reader the reading only, with a notice instead of the link', async () => {
    open(`/sas/sas-13?license=${LICENSE}`, PLATFORM_OPERATOR);
    await screen.findByText('LIC-20261023-0001');
    expect(screen.getByText(vi_['sas.licenseDetail.readOnly.notice'])).toBeTruthy();
    expect(screen.queryByRole('link', { name: vi_['sas.licenseDetail.actions.change'] })).toBeNull();
  });

  it('shows the link when the session does not state its permissions', async () => {
    open(`/sas/sas-13?license=${LICENSE}`, undefined);
    expect(await screen.findByRole('link', { name: vi_['sas.licenseDetail.actions.change'] })).toBeTruthy();
  });

  describe('the revisions of a tenant', () => {
    it('lists them with serial, edition, state, end and signature, each with a link to its detail', async () => {
      pages = [{ items: [license(), license({ id: SECOND, revision: 2, serial: 'LIC-20261023-0002', status: 'Scheduled', signature_check: 'CLAIMS_MISMATCH' })], next_cursor: null }];
      const h = open(`/sas/sas-13?tenant=${TENANT}`);
      const table = await screen.findByRole('table');
      expect(within(table).getByText('LIC-20261023-0001')).toBeTruthy();
      expect(within(table).getByText(vi_['sas.license.status.scheduled'])).toBeTruthy();
      expect(within(table).getByText(vi_['sas.license.signature.claimsMismatch'])).toBeTruthy();
      expect(within(table).getAllByRole('link', { name: vi_['sas.licenseDetail.open.action'] }).map((link) => link.getAttribute('href'))).toEqual([`/sas/sas-13?license=${LICENSE}`, `/sas/sas-13?license=${SECOND}`]);
      expect(h.read).toHaveBeenCalledWith('listSystemTenantLicenses', { path: { tenantId: TENANT }, query: { limit: 50 } });
    });

    it('loads the next page by its cursor and shows both pages', async () => {
      pages = [
        { items: [license()], next_cursor: 'c1' },
        { items: [license({ id: SECOND, revision: 2, serial: 'LIC-20261023-0002' })], next_cursor: null },
      ];
      const user = userEvent.setup();
      const h = open(`/sas/sas-13?tenant=${TENANT}`);
      await screen.findByText('LIC-20261023-0001');
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseDetail.more.action'] }));
      expect(await screen.findByText('LIC-20261023-0002')).toBeTruthy();
      expect(h.read).toHaveBeenLastCalledWith('listSystemTenantLicenses', { path: { tenantId: TENANT }, query: { limit: 50, cursor: 'c1' } });
      expect(screen.queryByRole('button', { name: vi_['sas.licenseDetail.more.action'] })).toBeNull();
    });

    it('shows the empty state for a tenant that has no license', async () => {
      pages = [{ items: [], next_cursor: null }];
      open(`/sas/sas-13?tenant=${TENANT}`);
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });
  });

  describe('without a license or a tenant in the address', () => {
    it('asks for a tenant, reads only the registry, and lists the licenses of the tenant that is chosen', async () => {
      pages = [{ items: [license()], next_cursor: null }];
      const user = userEvent.setup();
      const h = open('/sas/sas-13');
      expect(screen.getByText(vi_['sas.licenseDetail.missing.notice'])).toBeTruthy();
      const select = (await screen.findByLabelText(vi_['sas.licenseDetail.tenant.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(3));
      expect(h.read.mock.calls.map((call) => call[0])).toEqual(['listSystemTenants']);
      await user.selectOptions(select, OTHER_TENANT);
      expect(await screen.findByRole('table')).toBeTruthy();
      expect(h.read).toHaveBeenLastCalledWith('listSystemTenantLicenses', { path: { tenantId: OTHER_TENANT }, query: { limit: 50 } });
    });
  });

  describe('the tenant picker beyond the first page', () => {
    const LATE = '00000000-0000-4000-8000-0000000000aa';

    it('loads the next page of tenants on request and lists the licenses of a tenant that was on it', async () => {
      pages = [{ items: [license()], next_cursor: null }];
      const user = userEvent.setup();
      const h = open('/sas/sas-13', LICENSE_ADMIN, (operation, input) => {
        if (operation === 'listSystemTenants') {
          const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
          return cursor === undefined ? { items: [{ id: TENANT, code: 'cao-bang', name: 'Cao Bằng', status: 'Active' }], next_cursor: 'page-2' } : { items: [{ id: LATE, code: 'late', name: 'Tenant Late', status: 'Active' }], next_cursor: null };
        }
        return answer(operation, input);
      });
      const select = (await screen.findByLabelText(vi_['sas.licenseDetail.tenant.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(2));
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseTenants.more.action'] }));
      await waitFor(() => expect(select.options.length).toBe(3));
      await user.selectOptions(select, LATE);
      expect(await screen.findByRole('table')).toBeTruthy();
      expect(h.read).toHaveBeenLastCalledWith('listSystemTenantLicenses', { path: { tenantId: LATE }, query: { limit: 50 } });
    });

    it('says that the list could not be read instead of showing an empty picker', async () => {
      open('/sas/sas-13', LICENSE_ADMIN, (operation, input) => (operation === 'listSystemTenants' ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : answer(operation, input)));
      expect(await screen.findByText((content) => content.startsWith(vi_['sas.licenseTenants.error.notice']))).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['sas.licenseTenants.retry.action'] })).toBeTruthy();
    });
  });

  describe('the seven states (AC-ST-SAS-003-10)', () => {
    const fail = (error: ApiError) => (): unknown => error;

    it('shows the denied state for a refusal, never an empty card', async () => {
      open(`/sas/sas-13?license=${LICENSE}`, LICENSE_ADMIN, fail(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('shows the signed-out state for a lapsed session', async () => {
      open(`/sas/sas-13?license=${LICENSE}`, LICENSE_ADMIN, fail(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    });

    it('shows the offline state when the network fails, the error state otherwise, and a loading state first', async () => {
      open(`/sas/sas-13?license=${LICENSE}`, LICENSE_ADMIN, fail(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      open(`/sas/sas-13?license=${LICENSE}`, LICENSE_ADMIN, fail(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('shows the error state for a license that does not exist, with a way to try again', async () => {
      const user = userEvent.setup();
      let healthy = false;
      open(`/sas/sas-13?license=${LICENSE}`, LICENSE_ADMIN, (operation, input) => (healthy ? answer(operation, input) : new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })));
      await screen.findByText(vi_['states.error.title']);
      healthy = true;
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('LIC-20261023-0001')).toBeTruthy();
    });
  });
});
