import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import LicenseRenewScreen from './LicenseRenewScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-14', 'FR-SAS-14');
const LICENSE_ADMIN = ['system.license.manage', 'system.tenant.read'];
const LICENSE = '00000000-0000-4000-8000-0000000000c1';
const NEXT = '00000000-0000-4000-8000-0000000000c2';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const PATH = `/sas/sas-14?license=${LICENSE}`;
const REASON = 'The agency extended the contract for another year.';
const OK = { operation_id: 'o', status: 'RENEWED', resource_version: 1, resource_id: NEXT };

let status = 'Active';
const license = () => ({
  id: LICENSE,
  tenant_id: TENANT,
  serial: 'LIC-20261023-0001',
  revision: 1,
  edition: 'STANDARD',
  status,
  valid_from: '2026-10-01T00:00:00.000Z',
  valid_until: '2027-10-01T00:00:00.000Z',
  grace_until: '2027-10-31T00:00:00.000Z',
  seats: 50,
  quota: {},
  issuer: 'machvon-platform',
  key_id: 'kid-2026',
  entitlement_version_id: '00000000-0000-4000-8000-0000000000b1',
  signature_check: 'VALID',
  expiring: false,
  version: 3,
});

const answer = (operation: string): unknown => (operation === 'getSystemLicense' ? license() : new Error('unexpected read'));

const open = (state: string, permissions: readonly string[] | undefined = LICENSE_ADMIN, command?: (operation: string, input: unknown) => unknown, path = PATH) => {
  status = state;
  const h = harness(answer, command);
  mount(<LicenseRenewScreen route={ROUTE} />, h, permissions, path);
  return h;
};

const label = (key: keyof typeof vi_): string => vi_[key];
const fill = async (user: ReturnType<typeof userEvent.setup>, until: string, grace: string, reason = REASON): Promise<void> => {
  await user.type(screen.getByLabelText(label('sas.licenseRenew.field.validUntil')), until);
  await user.type(screen.getByLabelText(label('sas.licenseRenew.field.graceUntil')), grace);
  await user.type(screen.getByLabelText(label('sas.licenseRenew.field.reason')), reason);
};

afterEach(cleanup);

describe('SAS-14 renew a license', () => {
  it('shows the current revision beside the one that would replace it, what stays, and the propagation objective, and sends nothing yet', async () => {
    const h = open('Active');
    expect(await screen.findByText(vi_['sas.licenseRenew.current.title'].replace('{revision}', '1'))).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.licenseRenew.page.title'] })).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseRenew.proposal.title'].replace('{revision}', '2'))).toBeTruthy();
    expect(screen.getByText('LIC-20261023-0001')).toBeTruthy();
    expect(screen.getByText(vi_['sas.license.status.active'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseRenew.keeps.text'].replace('{edition}', vi_['sas.license.edition.standard']))).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseRenew.slo.text'])).toBeTruthy();
    expect(screen.getByTestId('proposed-from').textContent).not.toBe('');
    expect((screen.getByLabelText(label('sas.licenseRenew.field.seats')) as HTMLInputElement).placeholder).toBe('50');
    expect(screen.getByText(vi_['sas.licenseRenew.footer.reference'].replace('{id}', 'SAS-14').replace('{req}', 'FR-SAS-14'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-SAS-014-1: renews with the version the screen showed, the days at the start of the day in UTC and the reason, and then says the old revision is kept', async () => {
    const user = userEvent.setup();
    const h = open('Active', LICENSE_ADMIN, () => OK);
    await screen.findByText(vi_['sas.licenseRenew.current.title'].replace('{revision}', '1'));
    await fill(user, '2028-10-01', '2028-10-31');
    await user.type(screen.getByLabelText(label('sas.licenseRenew.field.seats')), '75');
    await user.click(screen.getByRole('button', { name: label('sas.licenseRenew.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'renewLicense',
      expect.objectContaining({ path: { id: LICENSE }, ifMatchVersion: 3, body: { valid_until: '2028-10-01T00:00:00.000Z', grace_until: '2028-10-31T00:00:00.000Z', seats: 75, reason: REASON } }),
    );
    expect((await screen.findByTestId('renewed')).textContent).toContain(vi_['sas.licenseRenew.done.notice'].replace('{version}', '1'));
    expect(screen.getByRole('link', { name: vi_['sas.licenseRenew.done.link'] }).getAttribute('href')).toBe(`/sas/sas-16?tenant=${TENANT}`);
  });

  it('refuses what is wrong before it sends anything: the dates, the grace period, the seats and the reason', async () => {
    const user = userEvent.setup();
    const h = open('Active');
    await screen.findByText(vi_['sas.licenseRenew.current.title'].replace('{revision}', '1'));
    await user.click(screen.getByRole('button', { name: label('sas.licenseRenew.submit.action') }));
    expect(screen.getAllByText(vi_['sas.licenseRenew.problem.required'])).toHaveLength(2);
    expect(screen.getByText(vi_['sas.licenseRenew.reason.tooShort'])).toBeTruthy();
    await user.type(screen.getByLabelText(label('sas.licenseRenew.field.validUntil')), '2027-09-01');
    await user.type(screen.getByLabelText(label('sas.licenseRenew.field.graceUntil')), '2027-08-01');
    await user.type(screen.getByLabelText(label('sas.licenseRenew.field.seats')), '0');
    expect(screen.getByText(vi_['sas.licenseRenew.problem.notLater'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.licenseRenew.problem.seats'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says what the server refused in the words of the license screens and keeps what was typed', async () => {
    const user = userEvent.setup();
    const refuse = (code: string, status = 409, extensions: Record<string, unknown> = {}) => () => new ApiError({ status, code, correlationId: 'c', extensions });
    const cases: Array<[() => unknown, string]> = [
      [refuse('LICENSE_STATE_INVALID'), vi_['sas.license.error.stateInvalid']],
      [refuse('LICENSE_RANGE_INVALID', 422), vi_['sas.license.error.rangeInvalid']],
      [refuse('VERSION_CONFLICT', 409, { current_version: 5 }), vi_['sas.license.error.conflict'].replace('{version}', '5')],
      [refuse('SIGNING_KEY_UNAVAILABLE', 503), vi_['sas.license.error.signingKey']],
      [refuse('LICENSE_TENANT_MISMATCH', 422), vi_['sas.license.error.tenantMismatch']],
    ];
    for (const [command, message] of cases) {
      open('Active', LICENSE_ADMIN, command);
      await screen.findByText(vi_['sas.licenseRenew.current.title'].replace('{revision}', '1'));
      fireEvent.change(screen.getByLabelText(label('sas.licenseRenew.field.validUntil')), { target: { value: '2028-10-01' } });
      fireEvent.change(screen.getByLabelText(label('sas.licenseRenew.field.graceUntil')), { target: { value: '2028-10-31' } });
      fireEvent.change(screen.getByLabelText(label('sas.licenseRenew.field.reason')), { target: { value: REASON } });
      await user.click(screen.getByRole('button', { name: label('sas.licenseRenew.submit.action') }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(message);
      expect((screen.getByLabelText(label('sas.licenseRenew.field.validUntil')) as HTMLInputElement).value).toBe('2028-10-01');
      cleanup();
    }
  });

  it.each(['Suspended', 'Revoked', 'Expired', 'Superseded', 'Draft'])('does not offer a renewal of a license that is %s', async (state) => {
    const h = open(state);
    expect((await screen.findByTestId('not-renewable')).textContent).toBe(vi_['sas.licenseRenew.notRenewable.notice'].replace('{status}', vi_[`sas.license.status.${state.toLowerCase()}` as keyof typeof vi_]));
    expect(screen.getByRole('button', { name: label('sas.licenseRenew.submit.action') })).toHaveProperty('disabled', true);
    expect((screen.getByLabelText(label('sas.licenseRenew.field.validUntil')) as HTMLInputElement).disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the license and no way to renew it to someone who cannot manage licenses', async () => {
    open('Active', ['system.tenant.read']);
    expect((await screen.findByText(vi_['sas.licenseRenew.readOnly.notice'])).textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: label('sas.licenseRenew.submit.action') })).toHaveProperty('disabled', true);
  });

  it('asks to open it from a license when the address names none', async () => {
    open('Active', LICENSE_ADMIN, undefined, '/sas/sas-14');
    expect((await screen.findByText(vi_['sas.licenseRenew.missing.notice'])).textContent).toBeTruthy();
  });

  it('shows the error state when the license cannot be read', async () => {
    const h = harness(() => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }));
    mount(<LicenseRenewScreen route={ROUTE} />, h, LICENSE_ADMIN, PATH);
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });

  describe('the seven states (AC-ST-SAS-014-4)', () => {
    const fail = (error: ApiError) => (): unknown => error;
    const mountFailing = (error: ApiError) => mount(<LicenseRenewScreen route={ROUTE} />, harness(fail(error)), LICENSE_ADMIN, PATH);

    it('shows a loading state first, then the denied, signed-out, offline and error states, and the default state with the license', async () => {
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
      cleanup();
      open('Active');
      expect(await screen.findByText(vi_['sas.licenseRenew.current.title'].replace('{revision}', '1'))).toBeTruthy();
    });
  });
});
