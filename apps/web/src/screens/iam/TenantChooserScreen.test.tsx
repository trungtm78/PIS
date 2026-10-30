import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue, TenantCandidate } from '../../session/SessionContext';
import { TENANT_A, TENANT_B } from '../../test/render';
import TenantChooserScreen from './TenantChooserScreen';

const ROUTE: WebRoute = { id: 'IAM-04', path: '/iam/iam-04', title: 'Chọn tổ chức', kind: 'cards', area: 'admin', module: 'IAM', group: 'Tài khoản', role: 'workspace', parent: null, req: 'FR-IAM-04' };

const staff = (over: Partial<TenantCandidate>): TenantCandidate => ({
  tenant_id: 't-a',
  tenant_name: 'Cao Bằng',
  tenant_status: 'Active',
  membership_id: 'm-a',
  membership_type: 'STAFF',
  status: 'Active',
  valid_from: '2020-01-01T00:00:00.000Z',
  valid_until: null,
  ...over,
});

const ACTIVE = staff({});
const SUSPENDED = staff({ tenant_id: 't-s', tenant_name: 'Hà Giang', tenant_status: 'Suspended', membership_id: 'm-s' });
const GUEST = staff({ tenant_id: 't-g', tenant_name: 'Lào Cai', membership_id: 'm-g', membership_type: 'GUEST_CONTRACTOR' });
const ENDED = staff({ tenant_id: 't-e', tenant_name: 'Bắc Kạn', membership_id: 'm-e', status: 'Ended' });
const PROVISIONING = staff({ tenant_id: 't-p', tenant_name: 'Tuyên Quang', membership_id: 'm-p', tenant_status: 'Provisioning' });

const text = (key: keyof typeof vi_, params: Record<string, string> = {}): string =>
  Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), vi_[key]);

function problem(code: string, status = 403): ApiError {
  return new ApiError({ status, code, correlationId: 'corr-1' });
}

interface Options {
  candidates?: readonly TenantCandidate[] | Error | Promise<readonly TenantCandidate[]>;
  selectTenant?: SessionValue['selectTenant'];
  requestStepUp?: SessionValue['requestStepUp'];
  oidc?: boolean;
  url?: string;
}

function mount(options: Options = {}) {
  const { candidates = [ACTIVE, SUSPENDED, GUEST], oidc = true, url = '/iam/iam-04' } = options;
  const loadCandidates = vi.fn(() => (candidates instanceof Error ? Promise.reject(candidates) : Promise.resolve(candidates)));
  const selectTenant = options.selectTenant ?? vi.fn(() => Promise.resolve());
  const switchTenant = vi.fn();
  const session: SessionValue = {
    tenant: undefined,
    tenants: oidc ? [] : [TENANT_A, TENANT_B],
    user: { displayName: 'Nguyễn An', initials: 'NA' },
    access: ALL_MODULES_VISIBLE,
    switchTenant,
    getSession: () => Promise.resolve(undefined),
    ...(oidc ? { status: 'identified' as const, loadCandidates, selectTenant } : {}),
    requestStepUp: options.requestStepUp,
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/iam/iam-04" element={<TenantChooserScreen route={ROUTE} />} />
            <Route path="/home/home-01" element={<p>home</p>} />
            <Route path="/adm/adm-01" element={<p>units</p>} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { ...view, loadCandidates, selectTenant, switchTenant };
}

const cardOf = (name: string): HTMLElement => screen.getByRole('article', { name });

afterEach(cleanup);

describe('IAM-04 tenant chooser', () => {
  it('lists the memberships as cards with the kind, the state of the tenant and a read-only note for a suspended one (AC-ST-IAM-003-3)', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: text('iam.tenantChooser.page.title') })).toBeTruthy();
    expect(await screen.findAllByRole('article')).toHaveLength(3);
    const active = within(cardOf('Cao Bằng'));
    expect(active.getByText(text('iam.tenantChooser.tenantStatus.active.label'))).toBeTruthy();
    expect(active.queryByText(text('iam.tenantChooser.readOnly.note'))).toBeNull();
    const suspended = within(cardOf('Hà Giang'));
    expect(suspended.getByText(text('iam.tenantChooser.tenantStatus.suspended.label'))).toBeTruthy();
    expect(suspended.getByText(text('iam.tenantChooser.readOnly.note'))).toBeTruthy();
    expect(within(cardOf('Lào Cai')).getByText(new RegExp(text('iam.tenantChooser.type.guest.label')))).toBeTruthy();
  });

  it('shows the membership of the tenant of the verified domain first, and keeps the order of the others (ST-SAS-017)', async () => {
    mount({ candidates: [ACTIVE, { ...SUSPENDED, preselected: false }, { ...GUEST, preselected: true }] });
    const cards = await screen.findAllByRole('article');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual(['Lào Cai', 'Cao Bằng', 'Hà Giang']);
  });

  it('gives every choose button its own accessible name', async () => {
    mount();
    await screen.findAllByRole('article');
    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(3);
    expect(names).toContain(text('iam.tenantChooser.select.label', { name: 'Cao Bằng' }));
  });

  it('shows a membership that is not in force or a tenant that is not ready, and cannot choose it', async () => {
    mount({ candidates: [ACTIVE, ENDED, PROVISIONING] });
    await screen.findAllByRole('article');
    const ended = within(cardOf('Bắc Kạn'));
    expect(ended.getByText(text('iam.tenantChooser.membership.inactive.label'))).toBeTruthy();
    expect((ended.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect((within(cardOf('Tuyên Quang')).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(within(cardOf('Tuyên Quang')).getByText(text('iam.tenantChooser.unavailable.note'))).toBeTruthy();
    expect((within(cardOf('Cao Bằng')).getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('chooses once for a double click and then continues at the home screen', async () => {
    let finish: () => void = () => undefined;
    const selectTenant = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mount({ selectTenant });
    await screen.findAllByRole('article');
    const button = within(cardOf('Cao Bằng')).getByRole('button');
    await userEvent.dblClick(button);
    expect(selectTenant).toHaveBeenCalledTimes(1);
    expect(selectTenant).toHaveBeenCalledWith(ACTIVE);
    expect(screen.getAllByRole('button').every((candidate) => (candidate as HTMLButtonElement).disabled)).toBe(true);
    finish();
    expect(await screen.findByText('home')).toBeTruthy();
  });

  it('continues at the address in next when it is local and ignores one that is not', async () => {
    mount({ url: '/iam/iam-04?next=/adm/adm-01' });
    await screen.findAllByRole('article');
    await userEvent.click(within(cardOf('Cao Bằng')).getByRole('button'));
    expect(await screen.findByText('units')).toBeTruthy();
    cleanup();
    mount({ url: '/iam/iam-04?next=//evil.test/x' });
    await screen.findAllByRole('article');
    await userEvent.click(within(cardOf('Cao Bằng')).getByRole('button'));
    expect(await screen.findByText('home')).toBeTruthy();
  });

  it.each([
    ['TENANT_SELECTION_INVALID', 'iam.tenantChooser.error.invalid' as const],
    ['MEMBERSHIP_INACTIVE', 'iam.tenantChooser.error.inactive' as const],
    ['TENANT_SUSPENDED', 'iam.tenantChooser.error.suspended' as const],
    ['SOMETHING_ELSE', 'iam.tenantChooser.error.generic' as const],
  ])('explains %s without leaving the chooser', async (code, key) => {
    mount({ selectTenant: vi.fn(() => Promise.reject(problem(code))) });
    await screen.findAllByRole('article');
    await userEvent.click(within(cardOf('Cao Bằng')).getByRole('button'));
    expect((await screen.findByRole('alert')).textContent).toBe(text(key));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect((within(cardOf('Cao Bằng')).getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the step-up prompt on MFA_REQUIRED and chooses again once the second factor is given', async () => {
    const selectTenant = vi
      .fn<(candidate: TenantCandidate) => Promise<void>>()
      .mockRejectedValueOnce(problem('MFA_REQUIRED'))
      .mockResolvedValueOnce(undefined);
    const requestStepUp = vi.fn(() => Promise.resolve());
    mount({ selectTenant, requestStepUp });
    await screen.findAllByRole('article');
    await userEvent.click(within(cardOf('Cao Bằng')).getByRole('button'));
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(vi_['adm.roles.stepUp.title'])).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(within(prompt).getByRole('button', { name: vi_['adm.roles.stepUp.confirm.action'] }));
    expect(await screen.findByText('home')).toBeTruthy();
    expect(requestStepUp).toHaveBeenCalledTimes(1);
    expect(selectTenant).toHaveBeenCalledTimes(2);
  });

  it('leaves the choice alone when the step-up is cancelled', async () => {
    const selectTenant = vi.fn(() => Promise.reject(problem('MFA_REQUIRED')));
    mount({ selectTenant, requestStepUp: vi.fn() });
    await screen.findAllByRole('article');
    await userEvent.click(within(cardOf('Cao Bằng')).getByRole('button'));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: vi_['adm.roles.stepUp.cancel.action'] }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(selectTenant).toHaveBeenCalledTimes(1);
  });

  it('works for a session without memberships to ask for: it lists the tenants of the session and switches to the chosen one', async () => {
    const { switchTenant, loadCandidates } = mount({ oidc: false });
    await screen.findAllByRole('article');
    expect(loadCandidates).not.toHaveBeenCalled();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await userEvent.click(within(cardOf('Lào Cai')).getByRole('button'));
    expect(switchTenant).toHaveBeenCalledWith(TENANT_B.id);
    expect(await screen.findByText('home')).toBeTruthy();
  });

  describe('the standard UI states (AC-ST-IAM-003-3)', () => {
    it('shows loading while the memberships load', () => {
      mount({ candidates: new Promise<readonly TenantCandidate[]>(() => undefined) });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    });

    it('shows the empty state for a person with no membership', async () => {
      mount({ candidates: [] });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it.each([
      ['denied', problem('SCOPE_DENIED'), 'states.denied.title' as const],
      ['signed out (a lapsed session)', problem('SESSION_EXPIRED', 401), 'states.signedOut.title' as const],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title' as const],
      ['error', new Error('boom'), 'states.error.title' as const],
    ])('shows the %s state', async (_label, failure, key) => {
      mount({ candidates: failure });
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: vi_[key] })).toBeTruthy());
    });
  });
});
