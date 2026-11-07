import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import { PLATFORM_TENANT, harness, mount } from '../sas/test-support';
import EffectiveAccessScreen from './EffectiveAccessScreen';
import { effectiveAccessKey } from './effective-access/hooks';

const ROUTE: WebRoute = { id: 'IAM-09', path: '/iam/iam-09', title: 'IAM-09', kind: 'detail', area: 'overview', module: 'IAM', group: 'Không gian cá nhân', role: 'workspace', parent: null, req: 'FR-IAM-09' };
const MEMBER = ['session.self'];
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000000e9';

const crumbs = [
  { id: 'u1', code: 'U1', name: 'Tập đoàn' },
  { id: 'u2', code: 'U2', name: 'Ban A' },
];

const grant = (overrides: Record<string, unknown>) => ({
  id: 'g',
  role_code: 'MEMBER',
  role_name: 'iam.role.MEMBER.name',
  rank: 5,
  scope_kind: 'TENANT',
  scope_ref_ids: [],
  scope: { units: [], projects: [], contracts: [] },
  permissions: ['session.self'],
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_until: null,
  state: 'ACTIVE',
  ...overrides,
});

const access = (scopeVersion: number, extra: Array<Record<string, unknown>> = []) => ({
  membership_id: MEMBERSHIP_ID,
  scope_version: scopeVersion,
  entitlement_hash: 'hash-1',
  grants: [
    grant({ id: 'g-member' }),
    grant({
      id: 'g-admin',
      role_code: 'UNIT_ADMIN',
      role_name: 'iam.role.UNIT_ADMIN.name',
      rank: 70,
      scope_kind: 'UNIT_SUBTREE',
      scope_ref_ids: ['u2'],
      scope: { units: [{ ...crumbs[1], path: '/u1/u2/', breadcrumb: crumbs }], projects: [], contracts: [] },
      permissions: ['iam.member.*', 'session.self'],
    }),
    grant({ id: 'g-ended', role_code: 'LEADER', role_name: 'Trưởng nhóm', rank: 60, scope_kind: 'PROJECT', scope: { units: [], projects: [{ id: 'p1', code: 'P-1', name: 'Cầu A' }], contracts: [] }, permissions: ['approval.decide'], effective_until: '2026-02-01T00:00:00.000Z', state: 'EXPIRED' }),
    grant({ id: 'g-later', role_code: 'AUDITOR', rank: 25, scope_kind: 'CONTRACT', scope: { units: [], projects: [], contracts: [{ id: 'c1', code: 'HĐ-1' }] }, permissions: ['audit.read'], effective_from: '2027-01-01T00:00:00.000Z', state: 'FUTURE' }),
    ...extra,
  ],
  delegations_in: [{ id: 'd1', delegator_membership_id: 'm2', permissions: ['report.export'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [], valid_from: '2026-03-01T00:00:00.000Z', valid_until: '2026-03-10T00:00:00.000Z', state: 'ACTIVE' }],
});

const plan = {
  version_no: 2,
  entitlements_hash: 'hash-1',
  license_status: 'FULL',
  features: [
    { feature_code: 'reporting', allowed: true, source: 'PLAN', mode: 'FULL' },
    { feature_code: 'ai.analysis', allowed: false, limit: '0', source: 'PLAN', mode: 'DENIED' },
  ],
};

interface Answers {
  access?: unknown;
  plan?: unknown;
}

function setup(answers: Answers = {}) {
  const current = { access: answers.access ?? access(3), plan: answers.plan ?? plan };
  const h = harness((operation) => (operation === 'getMyEffectiveAccess' ? current.access : operation === 'getMyEntitlements' ? current.plan : new Error('unexpected')));
  return { h, current };
}

const loaded = () => screen.findByRole('region', { name: vi_['iam.effectiveAccess.section.active'] });
const sectionOf = (title: string): HTMLElement => screen.getByRole('region', { name: title });

afterEach(cleanup);

describe('IAM-09: my effective access', () => {
  it('keeps the title of the card outside the data, so the frame of the page is there in every state', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    expect(screen.getByRole('heading', { level: 1, name: vi_['iam.effectiveAccess.page.title'] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: vi_['iam.effectiveAccess.card.title'] })).toBeTruthy();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('getMyEffectiveAccess');
  });

  it('shows the five fields of the screen as a summary of the grants, delegations and plan', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    expect(screen.getByText(vi_['iam.effectiveAccess.summary.role.value'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByText(vi_['iam.effectiveAccess.summary.scope.value'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByText(vi_['iam.effectiveAccess.summary.validity.value'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByText(vi_['iam.effectiveAccess.summary.delegations.value'].replace('{count}', '1'))).toBeTruthy();
    await waitFor(() => expect(screen.getByText(vi_['iam.effectiveAccess.summary.plan.value'].replace('{count}', '1'))).toBeTruthy());
  });

  it('separates the grants in force from the ones that ended and the ones that have not started', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const active = sectionOf(vi_['iam.effectiveAccess.section.active']);
    const future = sectionOf(vi_['iam.effectiveAccess.section.future']);
    const ended = sectionOf(vi_['iam.effectiveAccess.section.expired']);
    expect([...active.querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'))).toEqual(['g-member', 'g-admin']);
    expect([...future.querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'))).toEqual(['g-later']);
    expect([...ended.querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'))).toEqual(['g-ended']);
    expect(within(future.querySelector('article') as HTMLElement).getByText(vi_['iam.effectiveAccess.state.future'])).toBeTruthy();
    expect(within(ended.querySelector('article') as HTMLElement).getByText(vi_['iam.effectiveAccess.state.expired'])).toBeTruthy();
  });

  it('names each scope: the unit with its place in the tree, the project and the contract, and a custom role by its name', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const admin = document.querySelector('[data-grant-id="g-admin"]') as HTMLElement;
    expect(admin.querySelector('[data-breadcrumb]')?.textContent).toBe('Tập đoàn › Ban A');
    expect(within(admin).getByText(vi_['iam.effectiveAccess.scope.unitSubtree'])).toBeTruthy();
    expect(within(admin).queryByText(/iam\.role\.UNIT_ADMIN\.name/)).toBeNull();
    const ended = document.querySelector('[data-grant-id="g-ended"]') as HTMLElement;
    expect(within(ended).getByText(/P-1 · Cầu A/)).toBeTruthy();
    expect(within(ended).getByText(/Trưởng nhóm/)).toBeTruthy();
    const later = document.querySelector('[data-grant-id="g-later"]') as HTMLElement;
    expect(within(later).getByText(/HĐ-1/)).toBeTruthy();
  });

  it('lists the effective permissions with the role that gives each (only the grants in force) and the delegated ones', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const rowOf = (permission: string) => document.querySelector(`tr[data-permission="${permission}"]`) as HTMLElement;
    expect(within(rowOf('session.self')).getByText('MEMBER, UNIT_ADMIN')).toBeTruthy();
    expect(within(rowOf('iam.member.*')).getByText('UNIT_ADMIN')).toBeTruthy();
    expect(within(rowOf('report.export')).getByText(vi_['iam.effectiveAccess.permissions.delegated'])).toBeTruthy();
    // A permission of a grant that ended, or has not started, is not one the person holds.
    expect(rowOf('approval.decide')).toBeNull();
    expect(rowOf('audit.read')).toBeNull();
  });

  it('shows the delegations received with their period and state', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const row = document.querySelector('tr[data-delegation-state="ACTIVE"]') as HTMLElement;
    expect(within(row).getByText('report.export')).toBeTruthy();
    expect(within(row).getByText('2026-03-01 → 2026-03-10')).toBeTruthy();
  });

  it('draws the state of a delegation as a pill of the kit and keeps both tables in scroll regions of their own', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const row = document.querySelector('tr[data-delegation-state="ACTIVE"]') as HTMLElement;
    expect(row.querySelector('.ui-pill')?.className).toContain('ui-tone-success');
    expect(screen.getByRole('region', { name: translator.t('w2iam.effectiveAccess.table.permissions') })).toBeTruthy();
    expect(screen.getByRole('region', { name: translator.t('w2iam.effectiveAccess.table.delegations') })).toBeTruthy();
  });

  it('filters the grants by permission and by scope, and says when nothing is left', async () => {
    const user = userEvent.setup();
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    await user.type(screen.getByLabelText(vi_['iam.effectiveAccess.filter.permission.label']), 'iam.member');
    expect([...document.querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'))).toEqual(['g-admin']);
    expect(within(sectionOf(vi_['iam.effectiveAccess.section.expired'])).getByText(vi_['iam.effectiveAccess.section.empty'])).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['iam.effectiveAccess.filter.scope.label']), 'TENANT');
    expect(document.querySelectorAll('[data-grant-id]')).toHaveLength(0);
    await user.clear(screen.getByLabelText(vi_['iam.effectiveAccess.filter.permission.label']));
    expect([...document.querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'))).toEqual(['g-member']);
    await user.selectOptions(screen.getByLabelText(vi_['iam.effectiveAccess.filter.scope.label']), 'ALL');
    expect(document.querySelectorAll('[data-grant-id]')).toHaveLength(4);
  });

  it('warns when a newer reading has another scope version, keeps what is shown, and reloads on request (AC-ST-IAM-005-2)', async () => {
    const user = userEvent.setup();
    const { h, current } = setup();
    const view = mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    expect(document.querySelector('[data-stale-banner]')).toBeNull();

    current.access = access(4, [grant({ id: 'g-new', role_code: 'BILLING_VIEWER', permissions: ['invoice_line.read'] })]);
    await act(async () => {
      await view.queries.invalidateQueries({ queryKey: effectiveAccessKey(TENANT_ID, MEMBERSHIP_ID) });
    });
    const banner = await waitFor(() => {
      const found = document.querySelector('[data-stale-banner]');
      if (found === null) throw new Error('no banner yet');
      return found as HTMLElement;
    });
    expect(within(banner).getByText(vi_['iam.effectiveAccess.stale.banner'])).toBeTruthy();
    expect(document.querySelector('[data-grant-id="g-new"]')).toBeNull();

    await user.click(within(banner).getByRole('button', { name: vi_['iam.effectiveAccess.stale.reload'] }));
    expect(document.querySelector('[data-grant-id="g-new"]')).not.toBeNull();
    expect(document.querySelector('[data-stale-banner]')).toBeNull();
  });

  it('does not warn when a newer reading has the same scope version', async () => {
    const { h } = setup();
    const view = mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    await act(async () => {
      await view.queries.invalidateQueries({ queryKey: effectiveAccessKey(TENANT_ID, MEMBERSHIP_ID) });
    });
    expect(document.querySelector('[data-stale-banner]')).toBeNull();
  });

  it('takes a newer reading of the same scope version on its own: a grant that became active with the clock moves to the active section', async () => {
    const { h, current } = setup();
    const view = mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    const sectionIdsOf = (title: string): Array<string | null> => [...sectionOf(title).querySelectorAll('[data-grant-id]')].map((node) => node.getAttribute('data-grant-id'));
    expect(sectionIdsOf(vi_['iam.effectiveAccess.section.future'])).toEqual(['g-later']);

    // The start date of the grant passed: the server computes another state for the same scope version.
    const reading = access(3);
    current.access = { ...reading, grants: reading.grants.map((entry) => (entry.id === 'g-later' ? { ...entry, state: 'ACTIVE' } : entry)) };
    await act(async () => {
      await view.queries.invalidateQueries({ queryKey: effectiveAccessKey(TENANT_ID, MEMBERSHIP_ID) });
    });
    await waitFor(() => expect(sectionIdsOf(vi_['iam.effectiveAccess.section.active'])).toContain('g-later'));
    expect(sectionIdsOf(vi_['iam.effectiveAccess.section.future'])).toEqual([]);
    expect(document.querySelector('[data-stale-banner]')).toBeNull();
  });

  it('shows nothing of the previous tenant after the session changes tenant, even when both memberships have the same scope version', async () => {
    const OTHER_TENANT = { ...PLATFORM_TENANT, id: '00000000-0000-4000-8000-0000000000bb', name: 'Other', membershipId: '00000000-0000-4000-8000-0000000000e8' };
    const answers = new Map<string, unknown>([
      [PLATFORM_TENANT.id, access(3)],
      [OTHER_TENANT.id, { ...access(3), membership_id: OTHER_TENANT.membershipId, entitlement_hash: 'hash-other', grants: [grant({ id: 'g-other', role_code: 'OTHER_ROLE' })], delegations_in: [] }],
    ]);
    let active = PLATFORM_TENANT;
    const h = harness((operation) => (operation === 'getMyEffectiveAccess' ? answers.get(active.id) : operation === 'getMyEntitlements' ? plan : new Error('unexpected')));
    const view = mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    expect(document.querySelector('[data-grant-id="g-admin"]')).not.toBeNull();

    active = OTHER_TENANT;
    const session: SessionValue = {
      tenant: OTHER_TENANT,
      tenants: [PLATFORM_TENANT, OTHER_TENANT],
      user: { displayName: 'Admin', initials: 'AD' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: MEMBER,
    };
    view.rerender(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={view.queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={['/']}>
              <EffectiveAccessScreen route={ROUTE} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    await waitFor(() => expect(document.querySelector('[data-grant-id="g-other"]')).not.toBeNull());
    expect(document.querySelector('[data-grant-id="g-admin"]')).toBeNull();
    expect(screen.queryByText('hash-1')).toBeNull();
    expect(document.querySelector('[data-stale-banner]')).toBeNull();
  });

  describe('plan benefits', () => {
    it('lists the features the plan allows with their mode, and the entitlement hash', async () => {
      const { h } = setup();
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      const card = (await waitFor(() => {
        const found = document.querySelector('[data-plan-card] [data-feature="reporting"]');
        if (found === null) throw new Error('no plan yet');
        return found;
      })).closest('[data-plan-card]') as HTMLElement;
      expect(within(card).getByText(vi_['sas.entitlements.mode.full'])).toBeTruthy();
      expect(card.querySelector('[data-feature="ai.analysis"]')).toBeNull();
      expect(within(card).getByText('hash-1')).toBeTruthy();
    });

    it('fails on its own: the access stays and the plan card offers to retry', async () => {
      const user = userEvent.setup();
      const { h, current } = setup({ plan: new Error('plan down') });
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      await loaded();
      const alert = await screen.findByText(vi_['iam.effectiveAccess.plan.error']);
      expect(screen.getByText(vi_['iam.effectiveAccess.summary.plan.unavailable'])).toBeTruthy();
      current.plan = plan;
      await user.click(within(alert.closest('p') as HTMLElement).getByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(document.querySelector('[data-plan-card] [data-feature="reporting"]')).not.toBeNull());
    });

    it('says so when the plan opens no feature', async () => {
      const { h } = setup({ plan: { ...plan, features: [] } });
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      expect(await screen.findByText(vi_['iam.effectiveAccess.plan.empty'])).toBeTruthy();
    });
  });

  describe('states (AC-ST-IAM-005-3)', () => {
    it('shows the loading card while the access is read', async () => {
      const h = harness((operation) => (operation === 'getMyEntitlements' ? plan : new Promise(() => undefined)));
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    });

    it('is denied for a 403, offline for a network failure, signed out for a lapsed session, and an error otherwise', async () => {
      const failures: Array<[unknown, string]> = [
        [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
        [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
        [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
        [new Error('boom'), vi_['states.error.title']],
      ];
      for (const [failure, title] of failures) {
        const { h } = setup({ access: failure });
        mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
        expect(await screen.findByText(title)).toBeTruthy();
        expect(document.querySelector('[data-grant-id]')).toBeNull();
        cleanup();
      }
    });

    it('retries the reading from the error card', async () => {
      const user = userEvent.setup();
      const { h, current } = setup({ access: new Error('boom') });
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      await screen.findByText(vi_['states.error.title']);
      current.access = access(3);
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await loaded()).toBeTruthy();
    });

    it('is empty when the person has neither a grant nor a delegation', async () => {
      const { h } = setup({ access: { membership_id: MEMBERSHIP_ID, scope_version: 1, grants: [], delegations_in: [] } });
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('tells a person with no permission in force so, and shows the summary without a validity count when nothing ended', async () => {
      const { h } = setup({ access: { membership_id: MEMBERSHIP_ID, scope_version: 1, grants: [grant({ id: 'only', permissions: [] })], delegations_in: [] } });
      mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
      expect(await screen.findByText(vi_['iam.effectiveAccess.permissions.empty'])).toBeTruthy();
      expect(screen.getByText(vi_['iam.effectiveAccess.summary.validity.none'])).toBeTruthy();
      expect(screen.getByText(vi_['iam.effectiveAccess.grant.noPermissions'])).toBeTruthy();
      expect(screen.getByText(vi_['iam.effectiveAccess.delegations.empty'])).toBeTruthy();
    });
  });

  it('carries the screen id and the reference footer', async () => {
    const { h } = setup();
    mount(<EffectiveAccessScreen route={ROUTE} />, h, MEMBER);
    await loaded();
    expect(document.querySelector('[data-screen-id="IAM-09"]')).not.toBeNull();
    expect(screen.getByText(vi_['iam.effectiveAccess.footer.reference'].replace('{id}', 'IAM-09').replace('{req}', 'FR-IAM-09'))).toBeTruthy();
  });
});
