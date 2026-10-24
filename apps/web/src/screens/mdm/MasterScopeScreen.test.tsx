import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterScopeScreen from './MasterScopeScreen';
import { READER, client, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('MDM-33', 'FR-MDM-33');

const policy = (masterType: string, overrides: Record<string, unknown> = {}) => ({
  master_type: masterType,
  scope: 'TENANT_ONLY',
  retire_requires_successor: false,
  locked: false,
  source: 'BASELINE',
  platform_records: 0,
  tenant_records: 0,
  ...overrides,
});

afterEach(cleanup);

const rowOf = (type: string): HTMLElement => document.querySelector(`[data-master-type="${type}"]`) as HTMLElement;
const ready = () => waitFor(() => expect(document.querySelector('[data-master-type]')).not.toBeNull());

describe('MasterScopeScreen (MDM-33)', () => {
  it('shows each type with the entries of the platform and of the tenant, and what locks it', async () => {
    const state = world({
      policies: [
        policy('FUND_SOURCE', { scope: 'PLATFORM_ONLY', locked: true, retire_requires_successor: true, platform_records: 12 }),
        policy('SECTOR', { scope: 'PLATFORM_WITH_TENANT_EXTENSION', platform_records: 5, tenant_records: 3 }),
        policy('AGENCY', { source: 'TENANT', tenant_records: 7 }),
      ],
    });
    mount(<MasterScopeScreen route={ROUTE} />, client(state), READER);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.scope.page.title']);
    const fund = within(rowOf('FUND_SOURCE'));
    expect(fund.getByText(vi_['mdm.scope.platformOnly.label'])).toBeTruthy();
    expect(fund.getByText(vi_['mdm.scope.locked.pill'])).toBeTruthy();
    expect(fund.getByText(vi_['mdm.scope.successor.pill'])).toBeTruthy();
    expect(fund.getByText('12')).toBeTruthy();
    const sector = within(rowOf('SECTOR'));
    expect(sector.getByText(vi_['mdm.scope.extension.label'])).toBeTruthy();
    expect(sector.queryByText(vi_['mdm.scope.locked.pill'])).toBeNull();
    expect(sector.getByText('5')).toBeTruthy();
    expect(sector.getByText('3')).toBeTruthy();
    const agency = within(rowOf('AGENCY'));
    expect(agency.getByText(vi_['mdm.scope.tenantOnly.label'])).toBeTruthy();
    expect(agency.getByText(vi_['mdm.scope.override.pill'])).toBeTruthy();
  });

  it('explains the three scopes and says that a tenant only gives a platform entry an alias', async () => {
    mount(<MasterScopeScreen route={ROUTE} />, client(world({ policies: [policy('SECTOR')] })), READER);
    await ready();
    const legend = within(screen.getByLabelText(vi_['mdm.scope.legend.title']));
    expect(legend.getByText(vi_['mdm.scope.platformOnly.text'])).toBeTruthy();
    expect(legend.getByText(vi_['mdm.scope.extension.text'])).toBeTruthy();
    expect(legend.getByText(vi_['mdm.scope.tenantOnly.text'])).toBeTruthy();
    expect(legend.getByText(vi_['mdm.scope.alias.note'])).toBeTruthy();
  });

  it('shows the empty state and an error with a retry that reads again', async () => {
    mount(<MasterScopeScreen route={ROUTE} />, client(world({ policies: [] })), READER);
    await waitFor(() => expect(document.querySelector('[data-master-type]')).toBeNull());
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();
    const failing = world({ policies: [policy('SECTOR')], failing: new Set(['listMasterTypePolicies']) });
    mount(<MasterScopeScreen route={ROUTE} />, client(failing), READER);
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    failing.failing.clear();
    await userEvent.setup().click(retry);
    await ready();
  });
});
