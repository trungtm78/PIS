import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import TenantDetailScreen from './TenantDetailScreen';
import { PLATFORM_OPERATOR, SYSTEM_ADMIN, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-03', 'FR-SAS-03');
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const PATH = `/sas/sas-03?tenant=${TENANT}`;
const STATUSES = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'] as const;
const REASON = 'The invoice of September is 45 days overdue.';

let current: string = 'Active';
let version = 5;

function answer(operation: string): unknown {
  if (operation === 'getSystemTenant') {
    return { id: TENANT, code: 'cao-bang', name: 'Ủy ban nhân dân tỉnh Cao Bằng', governing_body_type: 'PROVINCE', status: current, isolation_mode: 'POOL', placement_id: 'p1', version };
  }
  return new Error('unexpected read');
}

const open = (status: string, permissions: readonly string[] | undefined = SYSTEM_ADMIN, command?: (operation: string, input: unknown) => unknown) => {
  current = status;
  version = 5;
  const h = harness(answer, command);
  const view = mount(<TenantDetailScreen route={ROUTE} />, h, permissions, PATH);
  return { h, view };
};

afterEach(cleanup);

describe('SAS-03 tenant detail', () => {
  it('shows the tenant with its code, name, status, isolation, governing body and version', async () => {
    open('Active');
    expect(await screen.findByText('cao-bang')).toBeTruthy();
    expect(screen.getByText('Ủy ban nhân dân tỉnh Cao Bằng')).toBeTruthy();
    expect(screen.getByText(vi_['sas.tenants.status.active'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.tenantCreate.isolation.pool'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.tenantCreate.governingBody.province'])).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.tenantDetail.page.title'] })).toBeTruthy();
    expect(screen.getByText(vi_['sas.tenantDetail.footer.reference'].replace('{id}', 'SAS-03').replace('{req}', 'FR-SAS-03'))).toBeTruthy();
  });

  it.each(STATUSES.map((status) => [status] as const))('offers the buttons the state machine allows for a %s tenant: suspend for Active, resume for Suspended, none otherwise (AC-ST-SAS-004-3)', async (status) => {
    open(status);
    await screen.findByText('cao-bang');
    const suspend = screen.queryByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] });
    const resume = screen.queryByRole('button', { name: vi_['sas.tenantDetail.resume.action'] });
    expect([suspend !== null, resume !== null]).toEqual([status === 'Active', status === 'Suspended']);
  });

  it('links to the provisioning progress of the tenant, named in the address', async () => {
    open('Active');
    const link = await screen.findByRole('link', { name: vi_['sas.tenantDetail.provisioning.link'] });
    expect(link.getAttribute('href')).toBe(`/sas/sas-22?tenant=${TENANT}`);
  });

  it('links to the licenses of the tenant, named in the address', async () => {
    open('Active');
    const link = await screen.findByRole('link', { name: vi_['sas.tenantDetail.licenses.link'] });
    expect(link.getAttribute('href')).toBe(`/sas/sas-13?tenant=${TENANT}`);
  });

  it('gives a platform operator the reading only, with a notice instead of the buttons', async () => {
    open('Active', PLATFORM_OPERATOR);
    await screen.findByText('cao-bang');
    expect(screen.queryByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] })).toBeNull();
    expect(screen.getByText(vi_['sas.tenantDetail.lifecycle.readOnly.notice'])).toBeTruthy();
  });

  it('shows the buttons when the session does not state its permissions', async () => {
    open('Suspended', undefined);
    expect(await screen.findByRole('button', { name: vi_['sas.tenantDetail.resume.action'] })).toBeTruthy();
  });

  it('asks for a tenant when the address names none, and reads nothing', () => {
    current = 'Active';
    const h = harness(answer);
    mount(<TenantDetailScreen route={ROUTE} />, h, SYSTEM_ADMIN, '/sas/sas-03');
    expect(screen.getByText(vi_['sas.tenantDetail.missing.notice'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  describe('suspending', () => {
    const start = async (command?: (operation: string, input: unknown) => unknown) => {
      const user = userEvent.setup();
      const opened = open('Active', SYSTEM_ADMIN, command);
      await user.click(await screen.findByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] }));
      const dialog = screen.getByRole('dialog');
      return { user, dialog, ...opened };
    };

    it('opens a confirm dialog naming the tenant, with the policy of the reason code, and sends nothing yet', async () => {
      const { dialog, h } = await start();
      expect(within(dialog).getByText(vi_['sas.tenantDetail.suspend.dialog.title'].replace('{code}', 'cao-bang'))).toBeTruthy();
      expect(dialog.querySelector('[data-access-policy="READ_ONLY_EXPORT"]')).not.toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows no access as the policy of a security incident', async () => {
      const { user, dialog } = await start();
      await user.selectOptions(within(dialog).getByLabelText(vi_['sas.tenantDetail.reasonCode.label']), 'SECURITY_INCIDENT');
      expect(dialog.querySelector('[data-access-policy="NO_ACCESS"]')).not.toBeNull();
      expect(within(dialog).getByText(vi_['sas.tenantDetail.policy.noAccess'])).toBeTruthy();
    });

    it('refuses a reason that is too short and sends nothing', async () => {
      const { user, dialog, h } = await start();
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), 'short');
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      expect(within(dialog).getByText(vi_['sas.tenantDetail.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends one versioned command with the code, the reason and the policy for a double click, then closes and reports the new version', async () => {
      const { user, dialog, h } = await start(() => ({ tenant_id: TENANT, status: 'Suspended', version: 6 }));
      await user.selectOptions(within(dialog).getByLabelText(vi_['sas.tenantDetail.reasonCode.label']), 'NON_PAYMENT');
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), REASON);
      await user.dblClick(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: { tenantId: string }; body: Record<string, string>; ifMatchVersion: number }];
      expect(operation).toBe('suspendTenant');
      expect(input.path.tenantId).toBe(TENANT);
      expect(input.body).toEqual({ reason_code: 'NON_PAYMENT', reason: REASON, access_policy: 'READ_ONLY_EXPORT' });
      expect(input.ifMatchVersion).toBe(5);
      expect(await screen.findByText(vi_['sas.tenantDetail.done.suspended'].replace('{version}', '6'))).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('sends NO_ACCESS for a security incident', async () => {
      const { user, dialog, h } = await start(() => ({ tenant_id: TENANT, status: 'Suspended', version: 6 }));
      await user.selectOptions(within(dialog).getByLabelText(vi_['sas.tenantDetail.reasonCode.label']), 'SECURITY_INCIDENT');
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), REASON);
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, string> }).body).toMatchObject({ reason_code: 'SECURITY_INCIDENT', access_policy: 'NO_ACCESS' });
    });

    it('refreshes the tenant after the command, so the new status is shown', async () => {
      const { user, dialog } = await start(() => {
        current = 'Suspended';
        version = 6;
        return { tenant_id: TENANT, status: 'Suspended', version: 6 };
      });
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), REASON);
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      expect(await screen.findByRole('button', { name: vi_['sas.tenantDetail.resume.action'] })).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] })).toBeNull();
    });

    it('keeps the dialog and the typed reason when the version is stale, and says which version is current', async () => {
      const { user, dialog } = await start(() => new ApiError({ status: 409, code: 'VERSION_CONFLICT', extensions: { current_version: 9 }, correlationId: 'c' }));
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), REASON);
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      expect(await within(dialog).findByText(vi_['sas.tenantCreate.error.conflict'].replace('{version}', '9'))).toBeTruthy();
      expect((within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']) as HTMLTextAreaElement).value).toBe(REASON);
    });

    it('reuses the idempotency attempt when the same request is sent again after a lost answer', async () => {
      let calls = 0;
      const { user, dialog, h } = await start(() => {
        calls += 1;
        return calls === 1 ? new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) : { tenant_id: TENANT, status: 'Suspended', version: 6 };
      });
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), REASON);
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      await within(dialog).findByText(vi_['sas.tenantCreate.error.offline']);
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.suspend.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const [first, second] = h.command.mock.calls.map(([, input]) => (input as { attempt: unknown }).attempt);
      expect(second).toBe(first);
    });

    it('closes without sending anything on cancel and on the close button', async () => {
      const { user, dialog, h } = await start();
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.confirm.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['sas.tenantDetail.dialog.close.label'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('resuming', () => {
    const start = async (command?: (operation: string, input: unknown) => unknown) => {
      const user = userEvent.setup();
      const opened = open('Suspended', SYSTEM_ADMIN, command);
      await user.click(await screen.findByRole('button', { name: vi_['sas.tenantDetail.resume.action'] }));
      return { user, dialog: screen.getByRole('dialog'), ...opened };
    };

    it('has no reason code or policy to choose: only the reason', async () => {
      const { dialog } = await start();
      expect(within(dialog).queryByLabelText(vi_['sas.tenantDetail.reasonCode.label'])).toBeNull();
      expect(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label'])).toBeTruthy();
    });

    it('sends one versioned command with the reason and reports the new version', async () => {
      const { user, dialog, h } = await start(() => ({ tenant_id: TENANT, status: 'Active', version: 6 }));
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), 'The invoice was paid on 2026-10-20.');
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.resume.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, string>; ifMatchVersion: number }];
      expect(operation).toBe('resumeTenant');
      expect(input.body).toEqual({ reason: 'The invoice was paid on 2026-10-20.' });
      expect(input.ifMatchVersion).toBe(5);
      expect(await screen.findByText(vi_['sas.tenantDetail.done.resumed'].replace('{version}', '6'))).toBeTruthy();
    });

    it('refuses a short reason and shows the message of a tenant that is not Suspended any more', async () => {
      const { user, dialog, h } = await start(() => new ApiError({ status: 409, code: 'TENANT_STATE_INVALID', correlationId: 'c' }));
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), 'paid');
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.resume.confirm'] }));
      expect(within(dialog).getByText(vi_['sas.tenantDetail.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']));
      await user.type(within(dialog).getByLabelText(vi_['sas.tenantDetail.reason.label']), 'The invoice was paid.');
      await user.click(within(dialog).getByRole('button', { name: vi_['sas.tenantDetail.resume.confirm'] }));
      expect(await within(dialog).findByText(vi_['sas.tenantCreate.error.stateInvalid'])).toBeTruthy();
    });
  });

  describe('the seven states (AC-ST-SAS-004-3)', () => {
    it('shows the loading state first, then the tenant (default)', async () => {
      open('Active');
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText('cao-bang')).toBeTruthy();
    });

    it('shows the denied state for a refusal, with no lifecycle control', async () => {
      mount(<TenantDetailScreen route={ROUTE} />, harness(() => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), SYSTEM_ADMIN, PATH);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['sas.tenantDetail.suspend.action'] })).toBeNull();
    });

    it('shows the signed-out state for a lapsed session', async () => {
      mount(<TenantDetailScreen route={ROUTE} />, harness(() => new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), SYSTEM_ADMIN, PATH);
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    });

    it('shows the offline state when the network fails and the error state otherwise', async () => {
      mount(<TenantDetailScreen route={ROUTE} />, harness(() => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), SYSTEM_ADMIN, PATH);
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<TenantDetailScreen route={ROUTE} />, harness(() => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })), SYSTEM_ADMIN, PATH);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
