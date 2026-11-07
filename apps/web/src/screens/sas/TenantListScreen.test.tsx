import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import TenantListScreen from './TenantListScreen';
import { PLATFORM_OPERATOR, SYSTEM_ADMIN, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-01', 'FR-SAS-01');
const STATUSES = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'] as const;
const LABEL: Record<(typeof STATUSES)[number], string> = {
  Requested: vi_['sas.tenants.status.requested'],
  Provisioning: vi_['sas.tenants.status.provisioning'],
  Active: vi_['sas.tenants.status.active'],
  Failed: vi_['sas.tenants.status.failed'],
  Suspended: vi_['sas.tenants.status.suspended'],
  Offboarding: vi_['sas.tenants.status.offboarding'],
  Archived: vi_['sas.tenants.status.archived'],
};

const row = (status: string, n: number) => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  code: `tenant-${n}`,
  name: `Tenant ${n}`,
  status,
  isolation_mode: 'POOL',
  plan_code: 'STANDARD',
  license_status: 'FULL',
});
const ROWS = STATUSES.map((status, index) => row(status, index + 1));
const idOf = (status: (typeof STATUSES)[number]): string => ROWS[STATUSES.indexOf(status)]?.id ?? '';

const RUN = {
  run_id: 'run-1',
  attempt: 1,
  current_step: 'ENTITLEMENT_V1',
  steps: [
    { step: 'IDP_ORG', status: 'DONE', attempts: 1 },
    { step: 'ENTITLEMENT_V1', status: 'RUNNING', attempts: 1 },
  ],
};
const FAILED_RUN = {
  run_id: 'run-2',
  attempt: 1,
  current_step: 'DNS_SUBDOMAIN',
  steps: [
    { step: 'IDP_ORG', status: 'DONE', attempts: 1 },
    { step: 'DNS_SUBDOMAIN', status: 'FAILED', attempts: 4, error_code: 'DOMAIN_TAKEN' },
  ],
};

function answer(operation: string, input: unknown): unknown {
  if (operation === 'listSystemTenants') return { items: ROWS, next_cursor: null };
  if (operation === 'getSystemTenant') {
    const id = (input as { path: { tenantId: string } }).path.tenantId;
    const found = ROWS.find((candidate) => candidate.id === id);
    return { id, code: found?.code, status: found?.status, version: 5, provisioning: found?.status === 'Failed' ? FAILED_RUN : RUN };
  }
  return new Error('unexpected read');
}

afterEach(cleanup);

describe('SAS-01 tenant list', () => {
  it('shows every tenant with its own status label for each of the seven states (AC-ST-SAS-001-4)', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    for (const status of STATUSES) {
      const tenantRow = document.querySelector(`tr[data-tenant-id="${idOf(status)}"]`) as HTMLElement;
      expect(within(tenantRow).getAllByText(LABEL[status]).length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(LABEL)).size).toBe(7);
    expect(screen.getByText('7 tenant')).toBeTruthy();
  });

  it('draws each status as a pill of the kit (settled green, waiting amber, failed red, closed grey) and counts the applied filters', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    const pillOf = (status: (typeof STATUSES)[number]): string =>
      (within(document.querySelector(`tr[data-tenant-id="${idOf(status)}"]`) as HTMLElement).getAllByText(LABEL[status])[0]?.closest('.ui-pill') as HTMLElement).className;
    expect(pillOf('Active')).toContain('ui-tone-success');
    expect(pillOf('Provisioning')).toContain('ui-tone-warning');
    expect(pillOf('Failed')).toContain('ui-tone-danger');
    expect(pillOf('Archived')).toContain('ui-tone-neutral');
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['sas.tenants.status.label']), 'Active');
    await user.click(screen.getByRole('button', { name: vi_['sas.tenants.filter.action'] }));
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy();
  });

  it('shows the step of a provisioning tenant and the failed step of a failed one', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    const provisioning = document.querySelector(`tr[data-tenant-id="${idOf('Provisioning')}"]`) as HTMLElement;
    expect(await within(provisioning).findByText(vi_['sas.tenants.run.at'].replace('{step}', vi_['sas.tenants.step.entitlementV1']))).toBeTruthy();
    const failed = document.querySelector(`tr[data-tenant-id="${idOf('Failed')}"]`) as HTMLElement;
    const text = vi_['sas.tenants.run.failedAt'].replace('{step}', vi_['sas.tenants.step.dnsTls']).replace('{status}', vi_['sas.tenants.run.failed']);
    expect(await within(failed).findByText(text)).toBeTruthy();
  });

  it('does not ask for the run of a tenant that is settled', async () => {
    const h = harness(answer);
    mount(<TenantListScreen route={ROUTE} />, h);
    await screen.findByRole('table');
    await screen.findByText(vi_['sas.tenants.run.at'].replace('{step}', vi_['sas.tenants.step.entitlementV1']));
    const asked = h.read.mock.calls.filter(([operation]) => operation === 'getSystemTenant').map(([, input]) => (input as { path: { tenantId: string } }).path.tenantId);
    expect(new Set(asked)).toEqual(new Set([idOf('Requested'), idOf('Provisioning'), idOf('Failed')]));
  });

  it('filters by status and by text when the filter is applied', async () => {
    const user = userEvent.setup();
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText(vi_['sas.tenants.status.label']), 'Active');
    await user.click(screen.getByRole('button', { name: vi_['sas.tenants.filter.action'] }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(vi_['sas.tenants.status.label']), '');
    await user.type(screen.getByLabelText(vi_['sas.tenants.search.label']), 'tenant-5');
    await user.click(screen.getByRole('button', { name: vi_['sas.tenants.filter.action'] }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    await user.clear(screen.getByLabelText(vi_['sas.tenants.search.label']));
    await user.type(screen.getByLabelText(vi_['sas.tenants.search.label']), 'nothing-like-this');
    await user.click(screen.getByRole('button', { name: vi_['sas.tenants.filter.action'] }));
    expect(screen.getByText(vi_['sas.tenants.filtered.empty'])).toBeTruthy();
  });

  it('loads the next page by cursor on request', async () => {
    const user = userEvent.setup();
    const second = row('Active', 9);
    const h = harness((operation, input) => {
      if (operation !== 'listSystemTenants') return answer(operation, input);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: ROWS, next_cursor: 'next-1' } : { items: [second], next_cursor: null };
    });
    mount(<TenantListScreen route={ROUTE} />, h);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: vi_['sas.tenants.more.action'] }));
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(8));
    expect(screen.queryByRole('button', { name: vi_['sas.tenants.more.action'] })).toBeNull();
    expect(h.read).toHaveBeenCalledWith('listSystemTenants', { query: { limit: 50, cursor: 'next-1' } });
  });

  it('links every tenant to its entitlements and the create action to SAS-02 for an administrator', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    const links = screen.getAllByRole('link', { name: vi_['sas.tenants.entitlements.action'] });
    expect(links).toHaveLength(7);
    expect(links[0]?.getAttribute('href')).toContain('?tenant=');
    expect(screen.getByRole('link', { name: vi_['sas.tenants.create.action'] })).toBeTruthy();
  });

  describe('retrying a failed tenant', () => {
    const open = async () => {
      const user = userEvent.setup();
      const h = harness(answer);
      mount(<TenantListScreen route={ROUTE} />, h);
      const failed = (await screen.findByRole('table')).querySelector(`tr[data-tenant-id="${idOf('Failed')}"]`) as HTMLElement;
      await user.click(await within(failed).findByRole('button', { name: vi_['sas.tenants.retry.action'] }));
      return { user, h, failed };
    };

    it('refuses a reason that is too short and sends nothing', async () => {
      const { user, h, failed } = await open();
      await user.type(within(failed).getByLabelText(vi_['sas.tenants.retry.reason.label']), 'short');
      await user.click(within(failed).getByRole('button', { name: vi_['sas.tenants.retry.submit'] }));
      expect(within(failed).getByText(vi_['sas.tenants.retry.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends one versioned command for a double click', async () => {
      const { user, h, failed } = await open();
      await user.type(within(failed).getByLabelText(vi_['sas.tenants.retry.reason.label']), 'The subdomain was released.');
      await user.dblClick(within(failed).getByRole('button', { name: vi_['sas.tenants.retry.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: { tenantId: string }; body: { reason: string }; ifMatchVersion: number }];
      expect(operation).toBe('retryTenantProvisioning');
      expect(input.path.tenantId).toBe(idOf('Failed'));
      expect(input.body.reason).toBe('The subdomain was released.');
      expect(input.ifMatchVersion).toBe(5);
    });

    it('reuses the idempotency attempt when the same retry is sent again after a failure', async () => {
      const user = userEvent.setup();
      let calls = 0;
      const h = harness(answer, () => {
        calls += 1;
        return calls === 1 ? new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) : { tenant_id: idOf('Failed'), status: 'Provisioning', version: 6 };
      });
      mount(<TenantListScreen route={ROUTE} />, h);
      const failed = (await screen.findByRole('table')).querySelector(`tr[data-tenant-id="${idOf('Failed')}"]`) as HTMLElement;
      await user.click(await within(failed).findByRole('button', { name: vi_['sas.tenants.retry.action'] }));
      await user.type(within(failed).getByLabelText(vi_['sas.tenants.retry.reason.label']), 'The subdomain was released.');
      await user.click(within(failed).getByRole('button', { name: vi_['sas.tenants.retry.submit'] }));
      await within(failed).findByText(vi_['sas.tenantCreate.error.offline']);
      await user.click(within(failed).getByRole('button', { name: vi_['sas.tenants.retry.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const [first, second] = h.command.mock.calls.map(([, input]) => (input as { attempt: unknown }).attempt);
      expect(second).toBe(first);
    });

    it('shows the stale-version message of the registry', async () => {
      const user = userEvent.setup();
      const h = harness(answer, () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', extensions: { current_version: 9 }, correlationId: 'c' }));
      mount(<TenantListScreen route={ROUTE} />, h);
      const failed = (await screen.findByRole('table')).querySelector(`tr[data-tenant-id="${idOf('Failed')}"]`) as HTMLElement;
      await user.click(await within(failed).findByRole('button', { name: vi_['sas.tenants.retry.action'] }));
      await user.type(within(failed).getByLabelText(vi_['sas.tenants.retry.reason.label']), 'The subdomain was released.');
      await user.click(within(failed).getByRole('button', { name: vi_['sas.tenants.retry.submit'] }));
      expect(await within(failed).findByText(vi_['sas.tenantCreate.error.conflict'].replace('{version}', '9'))).toBeTruthy();
    });
  });

  it('shows no create or retry control to a platform operator', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer), PLATFORM_OPERATOR);
    await screen.findByRole('table');
    await screen.findByText(vi_['sas.tenants.run.failedAt'].replace('{step}', vi_['sas.tenants.step.dnsTls']).replace('{status}', vi_['sas.tenants.run.failed']));
    expect(screen.queryByRole('link', { name: vi_['sas.tenants.create.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.tenants.retry.action'] })).toBeNull();
  });

  it('shows the controls when the session does not state its permissions', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer), undefined);
    await screen.findByRole('table');
    expect(await screen.findByRole('button', { name: vi_['sas.tenants.retry.action'] })).toBeTruthy();
  });

  describe('the seven states (AC-ST-SAS-001-4)', () => {
    it('shows the denied state for a refusal, not an empty list', async () => {
      mount(<TenantListScreen route={ROUTE} />, harness(() => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), SYSTEM_ADMIN);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(screen.queryByRole('link', { name: vi_['sas.tenants.create.action'] })).toBeNull();
    });

    it('shows the signed-out state for a lapsed session', async () => {
      mount(<TenantListScreen route={ROUTE} />, harness(() => new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    });

    it('shows the offline state when the network fails and the error state otherwise', async () => {
      mount(<TenantListScreen route={ROUTE} />, harness(() => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<TenantListScreen route={ROUTE} />, harness(() => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('shows the empty state for a registry with no tenant, and a loading state first', async () => {
      mount(<TenantListScreen route={ROUTE} />, harness((operation) => (operation === 'listSystemTenants' ? { items: [], next_cursor: null } : {})));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });
  });

  it('writes the reference footer of the screen', async () => {
    mount(<TenantListScreen route={ROUTE} />, harness(answer));
    await screen.findByRole('table');
    expect(screen.getByText(vi_['sas.tenants.footer.reference'].replace('{id}', 'SAS-01').replace('{req}', 'FR-SAS-01'))).toBeTruthy();
    expect(SYSTEM_ADMIN).toContain('system.tenant.manage');
  });
});
