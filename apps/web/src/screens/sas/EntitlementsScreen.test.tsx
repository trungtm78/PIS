import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import EntitlementsScreen from './EntitlementsScreen';
import { entitlementsKey } from './tenants/hooks';
import { PLATFORM_OPERATOR, PLATFORM_TENANT, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-25', 'FR-SAS-25');
const TENANT_A = { id: '00000000-0000-4000-8000-0000000000a1', code: 'cao-bang', name: 'Cao Bằng', status: 'Active' };
const TENANT_B = { id: '00000000-0000-4000-8000-0000000000b1', code: 'lao-cai', name: 'Lào Cai', status: 'Active' };

const view = (versionNo: number, hash: string, extra: Array<Record<string, unknown>> = []) => ({
  version_no: versionNo,
  entitlements_hash: hash,
  license_status: 'FULL',
  features: [
    { feature_code: 'reporting', allowed: true, source: 'PLAN', mode: 'FULL' },
    { feature_code: 'export', allowed: true, source: 'PLAN', mode: 'EXPORT_ONLY' },
    { feature_code: 'ai.analysis', allowed: false, limit: '0', source: 'PLAN', mode: 'DENIED' },
    ...extra,
  ],
});

const CONTROL_READER = ['system.tenant.read'];

afterEach(cleanup);

describe('SAS-25 entitlements', () => {
  it('shows the table of the tenant plane with the hash, the version and the mode of every feature', async () => {
    const h = harness((operation) => (operation === 'getMyEntitlements' ? view(3, 'abc123') : new Error('unexpected')));
    mount(<EntitlementsScreen route={ROUTE} />, h, ['session.self']);
    const hash = await screen.findByText('abc123');
    expect(hash.getAttribute('data-entitlements-hash')).not.toBeNull();
    expect(screen.getByText(vi_['sas.entitlements.version.text'].replace('{version}', '3'))).toBeTruthy();
    const reporting = document.querySelector('tr[data-feature="reporting"]') as HTMLElement;
    expect(within(reporting).getByText(vi_['sas.entitlements.feature.reporting'])).toBeTruthy();
    expect(within(reporting).getByText(vi_['sas.entitlements.mode.full'])).toBeTruthy();
    const denied = document.querySelector('tr[data-feature="ai.analysis"]') as HTMLElement;
    expect(within(denied).getByText(vi_['sas.entitlements.mode.denied'])).toBeTruthy();
    expect(within(denied).getByText('0')).toBeTruthy();
    expect(within(document.querySelector('tr[data-feature="export"]') as HTMLElement).getByText(vi_['sas.entitlements.mode.exportOnly'])).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getMyEntitlements');
    expect(h.read.mock.calls.some(([operation]) => operation === 'listSystemTenants')).toBe(false);
  });

  it('shows an override as the source of a feature and keeps unknown feature codes as written', async () => {
    const h = harness(() => view(4, 'h4', [{ feature_code: 'new.feature', allowed: true, source: 'OVERRIDE', mode: 'READ_ONLY', limit: '10', used: '3' }]));
    mount(<EntitlementsScreen route={ROUTE} />, h, ['session.self']);
    const row = (await screen.findByText('new.feature', { selector: 'b' })).closest('tr') as HTMLElement;
    expect(within(row).getByText(vi_['sas.entitlements.source.override'])).toBeTruthy();
    expect(within(row).getByText('10')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(row).getByText(vi_['sas.entitlements.mode.readOnly'])).toBeTruthy();
  });

  it('lets the control plane choose a tenant and reads that tenant', async () => {
    const user = userEvent.setup();
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [TENANT_A, TENANT_B], next_cursor: null };
      const tenantId = (input as { path: { tenantId: string } }).path.tenantId;
      return tenantId === TENANT_A.id ? view(1, 'hash-a') : view(7, 'hash-b');
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER);
    expect(await screen.findByText('hash-a')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['sas.entitlements.tenant.label']), TENANT_B.id);
    expect(await screen.findByText('hash-b')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getTenantEntitlements', { path: { tenantId: TENANT_B.id } });
    expect(h.read.mock.calls.some(([operation]) => operation === 'getMyEntitlements')).toBe(false);
  });

  it('shows the overrides of the chosen tenant to the control plane and none to the tenant plane (UI-SAS-25)', async () => {
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [TENANT_A, TENANT_B], next_cursor: null };
      if (operation === 'listTenantEntitlementOverrides') return { items: [], next_cursor: null };
      return view(1, (input as { path?: { tenantId: string } }).path?.tenantId === TENANT_B.id ? 'hash-b' : 'hash-a');
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, [...CONTROL_READER, 'system.billing.manage']);
    expect(await screen.findByText('hash-a')).toBeTruthy();
    expect(await screen.findByText(vi_['sas.overrides.empty'])).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['sas.overrides.form.aria'] })).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listTenantEntitlementOverrides', { path: { tenantId: TENANT_A.id }, query: { limit: 50 } });
    cleanup();
    const tenantPlane = harness(() => view(3, 'abc123'));
    mount(<EntitlementsScreen route={ROUTE} />, tenantPlane, ['session.self']);
    await screen.findByText('abc123');
    expect(screen.queryByTestId('overrides')).toBeNull();
    expect(tenantPlane.read.mock.calls.some(([operation]) => operation === 'listTenantEntitlementOverrides')).toBe(false);
  });

  it('opens the tenant named in the address', async () => {
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [TENANT_A, TENANT_B], next_cursor: null };
      return (input as { path: { tenantId: string } }).path.tenantId === TENANT_B.id ? view(7, 'hash-b') : view(1, 'hash-a');
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER, `/?tenant=${TENANT_B.id}`);
    expect(await screen.findByText('hash-b')).toBeTruthy();
  });

  it('keeps the tenant selector when the table is empty or fails, so another tenant can still be chosen', async () => {
    const user = userEvent.setup();
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [TENANT_A, TENANT_B], next_cursor: null };
      // The overrides of the tenant have their own part of the screen: they read fine while the table fails.
      if (operation === 'listTenantEntitlementOverrides') return { items: [], next_cursor: null };
      const tenantId = (input as { path: { tenantId: string } }).path.tenantId;
      if (tenantId === TENANT_A.id) return { version_no: 0, entitlements_hash: '', features: [] };
      return new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    const select = screen.getByLabelText(vi_['sas.entitlements.tenant.label']);
    await user.selectOptions(select, TENANT_B.id);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.entitlements.tenant.label'])).toBeTruthy();
  });

  it('loads further pages of the registry on request, so a tenant beyond the first page can be chosen', async () => {
    const user = userEvent.setup();
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? { items: [TENANT_A], next_cursor: 'c1' } : { items: [TENANT_B], next_cursor: null };
      }
      return view(1, (input as { path: { tenantId: string } }).path.tenantId === TENANT_B.id ? 'hash-b' : 'hash-a');
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER);
    await screen.findByText('hash-a');
    expect(screen.queryByRole('option', { name: /Lào Cai/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['sas.entitlements.tenant.more.action'] }));
    await user.selectOptions(screen.getByLabelText(vi_['sas.entitlements.tenant.label']), TENANT_B.id);
    expect(await screen.findByText('hash-b')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.entitlements.tenant.more.action'] })).toBeNull();
  });

  it('selects the tenant named in the address even when it is not in the loaded page, instead of showing another option', async () => {
    const unknown = '00000000-0000-4000-8000-0000000000f9';
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [TENANT_A], next_cursor: 'c1' };
      return (input as { path: { tenantId: string } }).path.tenantId === unknown ? view(9, 'hash-far') : view(1, 'hash-a');
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER, `/?tenant=${unknown}`);
    expect(await screen.findByText('hash-far')).toBeTruthy();
    expect((screen.getByLabelText(vi_['sas.entitlements.tenant.label']) as HTMLSelectElement).value).toBe(unknown);
  });

  it('retries the registry listing, not the entitlement query, when the registry failed and no tenant is chosen', async () => {
    const user = userEvent.setup();
    let listed = 0;
    const h = harness((operation) => {
      if (operation !== 'listSystemTenants') return view(1, 'hash-a');
      listed += 1;
      return listed === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : { items: [TENANT_A], next_cursor: null };
    });
    mount(<EntitlementsScreen route={ROUTE} />, h, CONTROL_READER);
    await screen.findByText(vi_['states.error.title']);
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByText('hash-a')).toBeTruthy();
    expect(listed).toBe(2);
  });

  it('shows the new table when the entitlement query is invalidated by the push', async () => {
    let current = view(1, 'before');
    const h = harness(() => current);
    const { queries } = mount(<EntitlementsScreen route={ROUTE} />, h, ['session.self']);
    await screen.findByText('before');
    current = view(2, 'after');
    await act(async () => {
      await queries.invalidateQueries({ queryKey: entitlementsKey(PLATFORM_TENANT.id, undefined) });
    });
    expect(await screen.findByText('after')).toBeTruthy();
    expect(screen.getByText(vi_['sas.entitlements.version.text'].replace('{version}', '2'))).toBeTruthy();
  });

  it('shows the empty state for a tenant without features and the denied state for a refusal', async () => {
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => ({ version_no: 0, entitlements_hash: '', features: [] })), ['session.self']);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => new ApiError({ status: 403, code: 'ENTITLEMENT_DENIED', correlationId: 'c' })), ['session.self']);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('shows the loading, signed-out, offline and error states', async () => {
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => view(1, 'x')), ['session.self']);
    expect(screen.getByRole('status')).toBeTruthy();
    await screen.findByText('x');
    cleanup();
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), ['session.self']);
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), ['session.self']);
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), ['session.self']);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  it('shows the control-plane error when the registry cannot be listed, and the licence label of the tenant', async () => {
    mount(<EntitlementsScreen route={ROUTE} />, harness((operation) => (operation === 'listSystemTenants' ? new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) : view(1, 'x'))), PLATFORM_OPERATOR);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<EntitlementsScreen route={ROUTE} />, harness(() => ({ ...view(1, 'h'), license_status: 'GRACE' })), ['session.self']);
    expect(await screen.findByText(new RegExp(vi_['sas.entitlements.license.grace']))).toBeTruthy();
    await waitFor(() => expect(screen.getByText(vi_['sas.entitlements.footer.reference'].replace('{id}', 'SAS-25').replace('{req}', 'FR-SAS-25'))).toBeTruthy());
  });
});
