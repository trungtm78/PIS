import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLATFORM_OPERATOR, SYSTEM_ADMIN, harness, mount, routeOf } from '../test-support';
import type { Harness } from '../test-support';
import { toTenantSummary } from '../tenants/types';
import HealthScreen from './HealthScreen';
import { PENDING_INDICATORS, healthOf } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeOf('SAS-18', 'FR-SAS-18');
const tenant = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${'0618'}${String(n).padStart(8, '0')}`,
  code: `tenant-${n}`,
  name: `Tên bí mật ${n}`,
  status: 'Active',
  isolation_mode: 'POOL',
  plan_code: 'STANDARD',
  license_status: 'FULL',
  ...extra,
});

function open(rows: Array<Record<string, unknown>> | Error, permissions: readonly string[] | undefined = PLATFORM_OPERATOR): Harness {
  const h = harness(() => new Error('unexpected read'));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
  mount(<HealthScreen route={ROUTE} />, h, permissions);
  return h;
}

afterEach(() => cleanup());

describe('the model of the health (ST-SAS-021)', () => {
  it('counts the tenants by life cycle, placement and licence, and lists them by code', () => {
    const health = healthOf(
      [
        tenant(2),
        tenant(1, { status: 'Failed', isolation_mode: 'SILO', license_status: 'EXPIRED' }),
        tenant(3, { status: 'Suspended', license_status: undefined, isolation_mode: undefined }),
        tenant(4, { license_status: 'REVOKED' }),
      ].map(toTenantSummary),
    );
    expect(health.tenants).toBe(4);
    expect(health.byStatus.find((entry) => entry.key === 'Active')?.count).toBe(2);
    expect(health.byStatus.find((entry) => entry.key === 'Archived')?.count).toBe(0);
    expect(health.byPlacement).toEqual([
      { key: 'POOL', count: 2 },
      { key: 'SILO', count: 1 },
      { key: '', count: 1 },
    ]);
    expect(health.byLicense).toEqual([
      { key: 'EXPIRED', count: 1 },
      { key: 'FULL', count: 1 },
      { key: '', count: 1 },
      { key: 'REVOKED', count: 1 },
    ]);
    expect(health.rows.map((row) => row.code)).toEqual(['tenant-1', 'tenant-2', 'tenant-3', 'tenant-4']);
    expect(health.attention).toBe(2);
  });

  it('counts nothing for an empty registry and keeps every life cycle in the list', () => {
    const health = healthOf([]);
    expect(health.tenants).toBe(0);
    expect(health.byStatus.every((entry) => entry.count === 0)).toBe(true);
    expect(health.byLicense).toEqual([]);
  });
});

describe('SAS-18: the health of the platform (ST-SAS-021, UAT-AC173)', () => {
  it('shows only operational figures by tenant code and never a tenant name', async () => {
    const h = open([tenant(1), tenant(2, { status: 'Suspended', isolation_mode: 'SILO' })]);
    const tiles = await screen.findByTestId('health-tiles');
    expect(within(screen.getByTestId('health-tenants')).getByText('2')).toBeTruthy();
    expect(tiles).toBeTruthy();
    expect(screen.getByRole('table', { name: word('sas.health.table.title') })).toBeTruthy();
    const row = document.querySelector('[data-tenant-code="tenant-2"]') as HTMLElement;
    expect(row.textContent).toContain(word('sas.tenants.status.suspended'));
    expect(row.textContent).toContain(word('sas.tenantCreate.isolation.silo'));
    expect(row.textContent).toContain(word('sas.entitlements.license.full'));
    expect(document.body.textContent).not.toContain('Tên bí mật');
    expect((h.client.readAll as unknown as { mock: { calls: string[][] } }).mock.calls).toEqual([['listSystemTenants']]);
    expect(screen.getByTestId('health-readat').textContent).toContain(word('sas.health.readat.text').split('{time}')[0]?.trim() ?? '');
  });

  it('names the indicators that have no source yet without a figure, instead of zero', async () => {
    open([tenant(1)]);
    const pending = await screen.findByTestId('health-pending');
    expect(within(pending).getAllByRole('listitem')).toHaveLength(PENDING_INDICATORS.length);
    expect(pending.textContent).toContain(word('sas.health.pending.slo'));
    expect(pending.textContent).toContain(word('sas.health.pending.incidents'));
    expect(pending.textContent).toContain(word('sas.health.pending.licenseLag'));
    expect(pending.textContent).toContain(word('sas.health.pending.outboxAge'));
    expect(pending.textContent).toContain(word('sas.health.pending.failedInbox'));
    expect(within(pending).getByRole('list').textContent).not.toMatch(/\d/);
  });

  it('counts the tenants that need attention', async () => {
    open([tenant(1, { status: 'Failed' }), tenant(2, { license_status: 'SUSPENDED' }), tenant(3)]);
    await screen.findByTestId('health-attention');
    expect(within(screen.getByTestId('health-attention')).getByText('2')).toBeTruthy();
  });

  it('shows a licence or isolation the registry left out as none', async () => {
    open([tenant(1, { license_status: undefined, isolation_mode: undefined, plan_code: undefined })]);
    await screen.findByTestId('health-tiles');
    const row = document.querySelector('[data-tenant-code="tenant-1"]') as HTMLElement;
    expect(within(row).getAllByText(word('sas.tenants.none'))).toHaveLength(3);
  });

  it('reads again on request', async () => {
    const h = open([tenant(1)]);
    await screen.findByTestId('health-tiles');
    fireEvent.click(screen.getByRole('button', { name: word('sas.health.refresh.action') }));
    await waitFor(() => expect(h.client.readAll as unknown as { mock: { calls: unknown[] } }).toSatisfy((mocked: { mock: { calls: unknown[] } }) => mocked.mock.calls.length === 2));
  });

  it('shows the empty state for a registry without tenants', async () => {
    open([]);
    await screen.findByText(word('states.empty.title'));
  });

  it('shows the denied state without reading when the member may not read the registry', () => {
    const h = open([tenant(1)], ['project.read']);
    expect(screen.getByTestId('health-denied')).toBeTruthy();
    expect(screen.getByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: word('sas.health.refresh.action') })).toBeNull();
    expect(h.client.readAll).not.toHaveBeenCalled();
  });

  it('reads when the permissions are not known; the API decides, and a refusal is the denied state', async () => {
    open(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c-1' }), undefined);
    await screen.findByText(word('states.denied.title'));
  });

  it('shows the error state and reads again on retry', async () => {
    const h = harness(() => new Error('x'));
    const readAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([tenant(1)]);
    (h.client as unknown as { readAll: unknown }).readAll = readAll;
    mount(<HealthScreen route={{ ...ROUTE, req: null }} />, h, SYSTEM_ADMIN);
    await screen.findByText(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('health-tiles');
    expect(readAll).toHaveBeenCalledTimes(2);
  });

  it('shows the loading state while the registry is read', () => {
    const h = harness(() => new Error('x'));
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<HealthScreen route={ROUTE} />, h, SYSTEM_ADMIN);
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });
});
