import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import LicenseIssueScreen from './LicenseIssueScreen';
import { PLATFORM_OPERATOR, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-12', 'FR-SAS-12');
const LICENSE_ADMIN = ['system.license.manage', 'system.tenant.read'];
const ACTIVE = '00000000-0000-4000-8000-0000000000a1';
const SUSPENDED = '00000000-0000-4000-8000-0000000000a2';
const REQUESTED = '00000000-0000-4000-8000-0000000000a3';
const ARCHIVED = '00000000-0000-4000-8000-0000000000a4';
const EMPTY = '00000000-0000-4000-8000-0000000000a5';
const VERSION_ID = '00000000-0000-4000-8000-0000000000b1';
const LICENSE_ID = '00000000-0000-4000-8000-0000000000c1';

const tenant = (id: string, name: string, status: string) => ({ id, code: name.toLowerCase().replace(/\s/g, '-'), name, status, isolation_mode: 'POOL', plan_code: 'STANDARD', license_status: 'FULL' });
const TENANTS = [tenant(ACTIVE, 'Tenant Active', 'Active'), tenant(SUSPENDED, 'Tenant Suspended', 'Suspended'), tenant(REQUESTED, 'Tenant Requested', 'Requested'), tenant(ARCHIVED, 'Tenant Archived', 'Archived'), tenant(EMPTY, 'Tenant Empty', 'Active')];

function answer(operation: string, input: unknown): unknown {
  if (operation === 'listSystemTenants') return { items: TENANTS, next_cursor: null };
  if (operation === 'getTenantEntitlements') {
    const id = (input as { path: { tenantId: string } }).path.tenantId;
    return id === EMPTY ? { version_no: 0, entitlements_hash: 'h', features: [] } : { version_id: VERSION_ID, version_no: 3, entitlements_hash: 'h', features: [] };
  }
  return new Error('unexpected read');
}

const open = (permissions: readonly string[] | undefined = LICENSE_ADMIN, command?: (operation: string, input: unknown) => unknown, path = '/sas/sas-12') => {
  const h = harness(answer, command);
  mount(<LicenseIssueScreen route={ROUTE} />, h, permissions, path);
  return h;
};

const field = (label: string): HTMLElement => screen.getByLabelText(label);
const setDate = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } });
};

/** Chooses a tenant once the list of tenants has arrived. */
async function chooseTenant(user: ReturnType<typeof userEvent.setup>, tenantId: string): Promise<void> {
  const select = (await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(select.options).some((option) => option.value === tenantId)).toBe(true));
  await user.selectOptions(select, tenantId);
}

/** Fills the form with a good window for the tenant (the select is chosen through the user). */
async function fill(user: ReturnType<typeof userEvent.setup>, tenantId: string): Promise<void> {
  await chooseTenant(user, tenantId);
  await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.current'].replace('{version}', '3'));
  setDate(vi_['sas.licenseIssue.validFrom.label'], '2027-01-01');
  setDate(vi_['sas.licenseIssue.validUntil.label'], '2028-01-01');
  setDate(vi_['sas.licenseIssue.graceUntil.label'], '2028-01-31');
}

afterEach(cleanup);

describe('SAS-12 issue a license', () => {
  it('lists the tenants a license can be issued to, not a Requested or an Archived one', async () => {
    open();
    const select = (await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['sas.licenseIssue.tenant.choose'], 'Tenant Active', 'Tenant Suspended', 'Tenant Empty']);
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.licenseIssue.page.title'] })).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseIssue.footer.reference'].replace('{id}', 'SAS-12').replace('{req}', 'FR-SAS-12'))).toBeTruthy();
  });

  it('shows the current entitlement version of the chosen tenant, read from the control plane', async () => {
    const h = open();
    const user = userEvent.setup();
    await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label']);
    expect((field(vi_['sas.licenseIssue.entitlement.label']) as HTMLInputElement).value).toBe(vi_['sas.licenseIssue.entitlement.choose']);
    await chooseTenant(user, ACTIVE);
    expect(await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.current'].replace('{version}', '3'))).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getTenantEntitlements', { path: { tenantId: ACTIVE } });
  });

  it('takes the tenant of the address when it names one', async () => {
    open(LICENSE_ADMIN, undefined, `/sas/sas-12?tenant=${SUSPENDED}`);
    expect(await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.current'].replace('{version}', '3'))).toBeTruthy();
    expect((screen.getByLabelText(vi_['sas.licenseIssue.tenant.label']) as HTMLSelectElement).value).toBe(SUSPENDED);
  });

  it('refuses a tenant without an entitlement version before anything is sent', async () => {
    const user = userEvent.setup();
    const h = open();
    await chooseTenant(user, EMPTY);
    expect(await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.none'])).toBeTruthy();
    setDate(vi_['sas.licenseIssue.validFrom.label'], '2027-01-01');
    setDate(vi_['sas.licenseIssue.validUntil.label'], '2028-01-01');
    setDate(vi_['sas.licenseIssue.graceUntil.label'], '2028-01-31');
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    expect(screen.getByText(vi_['sas.licenseIssue.problem.entitlement'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('refuses a bad window on the fields, keeps what was typed and sends nothing', async () => {
    const user = userEvent.setup();
    const h = open();
    await fill(user, ACTIVE);
    setDate(vi_['sas.licenseIssue.graceUntil.label'], '2027-11-01');
    await user.type(field(vi_['sas.licenseIssue.seats.label']), '0');
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(
      expect.arrayContaining([vi_['sas.licenseIssue.problem.seats'], vi_['sas.licenseIssue.problem.grace']]),
    );
    expect((field(vi_['sas.licenseIssue.validFrom.label']) as HTMLInputElement).value).toBe('2027-01-01');
    expect((field(vi_['sas.licenseIssue.seats.label']) as HTMLInputElement).value).toBe('0');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('clears the message of a field when the field is edited', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    expect(screen.getAllByText(vi_['sas.licenseIssue.problem.required']).length).toBeGreaterThan(0);
    await chooseTenant(user, ACTIVE);
    expect(document.querySelector('[data-field="tenant_id"] .field-error')).toBeNull();
  });

  it('sends one command with the window, the edition and the entitlement version for a double click, then reports the license and empties the form', async () => {
    const user = userEvent.setup();
    const h = open(LICENSE_ADMIN, () => ({ operation_id: 'o', status: 'ISSUED', resource_version: 1, resource_id: LICENSE_ID }));
    await fill(user, ACTIVE);
    await user.type(field(vi_['sas.licenseIssue.seats.label']), '50');
    await user.dblClick(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('post_licenses');
    expect(input.body).toEqual({
      tenant_id: ACTIVE,
      edition: 'STANDARD',
      valid_from: '2027-01-01T00:00:00.000Z',
      valid_until: '2028-01-01T00:00:00.000Z',
      grace_until: '2028-01-31T00:00:00.000Z',
      entitlement_version_id: VERSION_ID,
      seats: 50,
    });
    expect(await screen.findByText((content) => content.startsWith(vi_['sas.licenseIssue.accepted.notice'].replace('{version}', '1')))).toBeTruthy();
    const link = screen.getByRole('link', { name: vi_['sas.licenseIssue.accepted.link'] });
    expect(link.getAttribute('href')).toBe(`/sas/sas-13?license=${LICENSE_ID}`);
    expect((field(vi_['sas.licenseIssue.validFrom.label']) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(vi_['sas.licenseIssue.tenant.label']) as HTMLSelectElement).value).toBe('');
  });

  it('shows the private-deployment fields only for the PRIVATE edition and sends them then', async () => {
    const user = userEvent.setup();
    const h = open(LICENSE_ADMIN, () => ({ operation_id: 'o', status: 'ISSUED', resource_version: 1, resource_id: LICENSE_ID }));
    await fill(user, ACTIVE);
    expect(screen.queryByLabelText(vi_['sas.licenseIssue.binding.label'])).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['sas.licenseIssue.edition.label']), 'PRIVATE');
    await user.type(screen.getByLabelText(vi_['sas.licenseIssue.binding.label']), 'site-7');
    await user.type(screen.getByLabelText(vi_['sas.licenseIssue.lease.label']), '14');
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ edition: 'PRIVATE', deployment_binding: 'site-7', offline_lease_days: 14 });
  });

  it('shows a refusal of the server on its field, keeps the typed values, and a refusal without a field in a notice', async () => {
    const user = userEvent.setup();
    let failure: ApiError = new ApiError({ status: 422, code: 'LICENSE_RANGE_INVALID', detail: 'valid_from', correlationId: 'c' });
    const h = open(LICENSE_ADMIN, () => failure);
    await fill(user, ACTIVE);
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    expect(await screen.findByText(vi_['sas.license.error.rangeInvalid'])).toBeTruthy();
    expect(document.querySelector('[data-field="valid_from"] .field-error')?.textContent).toBe(vi_['sas.license.error.rangeInvalid']);
    expect((field(vi_['sas.licenseIssue.validUntil.label']) as HTMLInputElement).value).toBe('2028-01-01');
    failure = new ApiError({ status: 503, code: 'SIGNING_KEY_UNAVAILABLE', correlationId: 'c' });
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    expect(await screen.findByText(vi_['sas.license.error.signingKey'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('reuses the idempotency attempt for the same form after a lost answer, and starts a new one when a value changes', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = open(LICENSE_ADMIN, () => {
      calls += 1;
      return calls < 3 ? new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c' }) : { operation_id: 'o', status: 'ISSUED', resource_version: 1, resource_id: LICENSE_ID };
    });
    await fill(user, ACTIVE);
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    await screen.findByText(vi_['sas.license.error.general']);
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const attempts = h.command.mock.calls.map((call) => (call[1] as { attempt: unknown }).attempt);
    expect(attempts[1]).toBe(attempts[0]);
    setDate(vi_['sas.licenseIssue.graceUntil.label'], '2028-02-15');
    await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect((h.command.mock.calls[2]?.[1] as { attempt: unknown }).attempt).not.toBe(attempts[0]);
  });

  it('gives a registry reader the reading only: a notice and no button', async () => {
    open(PLATFORM_OPERATOR);
    expect(await screen.findByText(vi_['sas.licenseIssue.readOnly.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.licenseIssue.submit.action'] })).toBeNull();
  });

  it('shows the button when the session does not state its permissions, and sends nothing for a read-only submit', async () => {
    open(undefined);
    expect(await screen.findByRole('button', { name: vi_['sas.licenseIssue.submit.action'] })).toBeTruthy();
    cleanup();
    const h = open(PLATFORM_OPERATOR);
    await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label']);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(h.command).not.toHaveBeenCalled();
  });

  describe('the registry and the entitlement read can be incomplete or fail', () => {
    const LATE = '00000000-0000-4000-8000-0000000000a9';
    const openWith = (reads: (operation: string, input: unknown) => unknown, path = '/sas/sas-12', command?: (operation: string, input: unknown) => unknown) => {
      const h = harness(reads, command);
      mount(<LicenseIssueScreen route={ROUTE} />, h, LICENSE_ADMIN, path);
      return h;
    };

    it('loads the next page of tenants on request, so a tenant beyond the first page can be chosen', async () => {
      const user = userEvent.setup();
      const h = openWith((operation, input) => {
        if (operation === 'listSystemTenants') {
          const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
          return cursor === undefined ? { items: [TENANTS[0]], next_cursor: 'page-2' } : { items: [tenant(LATE, 'Tenant Late', 'Active')], next_cursor: null };
        }
        return answer(operation, input);
      });
      const select = (await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(2));
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseTenants.more.action'] }));
      await waitFor(() => expect(Array.from(select.options).some((option) => option.value === LATE)).toBe(true));
      expect(screen.queryByRole('button', { name: vi_['sas.licenseTenants.more.action'] })).toBeNull();
      await user.selectOptions(select, LATE);
      expect(h.read).toHaveBeenCalledWith('listSystemTenants', { query: { limit: expect.any(Number) as unknown as number, cursor: 'page-2' } });
    });

    it('keeps the tenant named by the address as an option while its page is not loaded', async () => {
      openWith(
        (operation, input) => {
          if (operation === 'listSystemTenants') return { items: [TENANTS[0]], next_cursor: 'page-2' };
          if (operation === 'getSystemTenant') return { id: LATE, code: 'late', name: 'Tenant Late', status: 'Active', version: 1 };
          return answer(operation, input);
        },
        `/sas/sas-12?tenant=${LATE}`,
      );
      const select = (await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe(LATE));
      await waitFor(() => expect(Array.from(select.options).map((option) => option.textContent)).toContain('Tenant Late'));
    });

    it('says that a later page of tenants could not be read, keeps the form, and reads again on request', async () => {
      const user = userEvent.setup();
      let failing = false;
      openWith((operation, input) => {
        if (operation === 'listSystemTenants') {
          const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
          if (cursor !== undefined && failing) return new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });
          return cursor === undefined ? { items: [TENANTS[0]], next_cursor: 'page-2' } : { items: [tenant(LATE, 'Tenant Late', 'Active')], next_cursor: null };
        }
        return answer(operation, input);
      });
      const select = (await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(2));
      failing = true;
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseTenants.more.action'] }));
      expect(await screen.findByText((content) => content.startsWith(vi_['sas.licenseTenants.error.notice']))).toBeTruthy();
      expect(screen.getByLabelText(vi_['sas.licenseIssue.tenant.label'])).toBe(select);
      failing = false;
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseTenants.retry.action'] }));
      await waitFor(() => expect(screen.queryByText((content) => content.startsWith(vi_['sas.licenseTenants.error.notice']))).toBeNull());
      await user.click(await screen.findByRole('button', { name: vi_['sas.licenseTenants.more.action'] }));
      await waitFor(() => expect(Array.from(select.options).some((option) => option.value === LATE)).toBe(true));
    });

    it('tells a failed read of the entitlement version from a tenant without one, sends nothing, and keeps the typed values for the retry', async () => {
      const user = userEvent.setup();
      let failing = true;
      const h = openWith(
        (operation, input) => {
          if (operation === 'getTenantEntitlements' && failing) return new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });
          return answer(operation, input);
        },
        '/sas/sas-12',
        () => ({ operation_id: 'o', status: 'ISSUED', resource_version: 1, resource_id: LICENSE_ID }),
      );
      await chooseTenant(user, ACTIVE);
      expect(await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.error'])).toBeTruthy();
      expect(screen.queryByDisplayValue(vi_['sas.licenseIssue.entitlement.none'])).toBeNull();
      setDate(vi_['sas.licenseIssue.validFrom.label'], '2027-01-01');
      setDate(vi_['sas.licenseIssue.validUntil.label'], '2028-01-01');
      setDate(vi_['sas.licenseIssue.graceUntil.label'], '2028-01-31');
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
      expect(screen.queryByText(vi_['sas.licenseIssue.problem.entitlement'])).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
      expect(screen.getByText((content) => content.startsWith(vi_['sas.licenseIssue.entitlement.error.notice']))).toBeTruthy();

      failing = false;
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.entitlement.retry.action'] }));
      await screen.findByDisplayValue(vi_['sas.licenseIssue.entitlement.current'].replace('{version}', '3'));
      expect((field(vi_['sas.licenseIssue.validUntil.label']) as HTMLInputElement).value).toBe('2028-01-01');
      await user.click(screen.getByRole('button', { name: vi_['sas.licenseIssue.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    });
  });

  describe('the seven states (AC-ST-SAS-003-9)', () => {
    const mountFailing = (error: ApiError) => mount(<LicenseIssueScreen route={ROUTE} />, harness(() => error), LICENSE_ADMIN, '/sas/sas-12');

    it('shows a loading state first, then the denied, signed-out, offline and error states, and the form as the default state', async () => {
      mountFailing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['sas.licenseIssue.submit.action'] })).toBeNull();
      cleanup();
      mountFailing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mountFailing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      open();
      expect(await screen.findByRole('button', { name: vi_['sas.licenseIssue.submit.action'] })).toBeTruthy();
    });

    it('says the registry could not be read and reads it again on request, keeping nothing half drawn', async () => {
      const user = userEvent.setup();
      let failing = true;
      mount(
        <LicenseIssueScreen route={ROUTE} />,
        harness((operation, input) => (operation === 'listSystemTenants' && failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : answer(operation, input))),
        LICENSE_ADMIN,
        '/sas/sas-12',
      );
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByLabelText(vi_['sas.licenseIssue.tenant.label'])).toBeTruthy();
      expect(screen.queryByText(vi_['states.error.title'])).toBeNull();
    });

    it('shows the empty state when no tenant can take a license yet', async () => {
      mount(
        <LicenseIssueScreen route={ROUTE} />,
        harness((operation, input) => (operation === 'listSystemTenants' ? { items: [TENANTS[2], TENANTS[3]], next_cursor: null } : answer(operation, input))),
        LICENSE_ADMIN,
        '/sas/sas-12',
      );
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });
  });
});
