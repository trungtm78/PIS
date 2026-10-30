import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DeviceListScreen from './DeviceListScreen';
import { canReceivePush, shortId, toDevice, toDevicePage } from './device/model';
import { harness, mount, routeOf } from './delivery/test-support';

const READER = ['device_registration.read'];
const NOBODY = ['delivery_attempt.read'];
const MEMBER = '00000000-0000-4000-8000-0000000000c5';

const deviceRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `device-${n}`,
  membership_id: MEMBER,
  platform: 'android',
  device_hint: 'beta…0001',
  permission_state: 'granted',
  app_version: '1.4.2',
  locale: 'vi-VN',
  last_seen_at: '2026-10-30T02:00:00Z',
  status: 'Active',
  revoked_at: null,
  revoke_reason: null,
  ...overrides,
});

afterEach(cleanup);

function open(permissions: readonly string[], answer: (query: Record<string, unknown>) => unknown) {
  const h = harness((operation, input) => (operation === 'get_resources_device_registration' ? answer(((input as { query?: Record<string, unknown> }).query ?? {})) : new Error('unexpected')));
  const element = <DeviceListScreen route={routeOf('NOT-14', 'FR-NOT-14')} />;
  return { h, ...mount(element, h, { permissions }) };
}

describe('NOT-14 the push devices (UI-NOT-14)', () => {
  it('AC-ST-NOT-006-3 UI-NOT-14: lists the devices with the hint of the public id, the member, the platform, the permission and the app, and never a token or a whole id', async () => {
    open(READER, () => ({ items: [deviceRow(1), deviceRow(2, { platform: 'ios', permission_state: 'denied' })], next_cursor: null }));
    const table = await screen.findByRole('table');
    for (const key of ['device', 'member', 'platform', 'permission', 'app', 'seen', 'status']) expect(within(table).getByRole('columnheader', { name: vi_[`not.device.col.${key}` as keyof typeof vi_] })).toBeTruthy();
    const first = table.querySelector('[data-device-id="device-1"]') as HTMLElement;
    expect(within(first).getByText('beta…0001')).toBeTruthy();
    expect(within(first).getByText(MEMBER.slice(0, 8))).toBeTruthy();
    expect(within(first).getByText(vi_['not.device.platform.android'])).toBeTruthy();
    expect(within(first).getByText(vi_['not.device.permission.granted'])).toBeTruthy();
    expect(within(first).getByText(vi_['not.device.status.active'])).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret:|fingerprint|fcm-token/);
    expect(document.body.textContent).not.toContain(MEMBER);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.device.page.title']);
  });

  it('AC-ST-NOT-006-3 UI-NOT-14: shows a device that was removed as removed, with when and why, after a permanent failure of the provider too', async () => {
    open(READER, () => ({ items: [deviceRow(1, { status: 'Revoked', revoked_at: '2026-10-30T03:00:00Z', revoke_reason: 'PROVIDER_UNREGISTERED', permission_state: 'granted' })], next_cursor: null }));
    const row = (await screen.findByRole('table')).querySelector('[data-device-id="device-1"]') as HTMLElement;
    expect(row.getAttribute('data-status')).toBe('Revoked');
    expect(within(row).getByText(vi_['not.device.status.revoked'])).toBeTruthy();
    expect(row.querySelector('[data-revoke-reason]')?.textContent).toContain('PROVIDER_UNREGISTERED');
  });

  it('asks for the devices of the status and the platform chosen', async () => {
    const queries: Array<Record<string, unknown>> = [];
    open(READER, (query) => {
      queries.push(query);
      return { items: [deviceRow(1)], next_cursor: null };
    });
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText(vi_['not.device.filter.status.label']), { target: { value: 'Revoked' } });
    fireEvent.change(screen.getByLabelText(vi_['not.device.filter.platform.label']), { target: { value: 'ios' } });
    await waitFor(() => expect(queries.at(-1)).toEqual({ status: 'Revoked', platform: 'ios' }));
    expect(queries[0]).toEqual({});
  });

  it('loads the older devices on request', async () => {
    open(READER, (query) => (query.cursor === undefined ? { items: [deviceRow(1)], next_cursor: 'c2' } : { items: [deviceRow(2)], next_cursor: null }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: vi_['not.device.list.more.action'] }));
    await waitFor(() => expect(document.querySelectorAll('[data-device-id]')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: vi_['not.device.list.more.action'] })).toBeNull();
  });

  it('AC-ST-NOT-006-3 UI-NOT-14: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no device', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(READER, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = open(READER, () => ({ items: [], next_cursor: null }));
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['not.device.list.none'])).toBeTruthy();
    cleanup();
    const { h } = open(NOBODY, () => ({ items: [], next_cursor: null }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('the model of NOT-14', () => {
  it('reads a device and a page, and takes what is not one for nothing', () => {
    expect(toDevice(null)).toBeUndefined();
    expect(toDevice({ membership_id: 'x' })).toBeUndefined();
    expect(toDevice(deviceRow(1))).toMatchObject({ id: 'device-1', platform: 'android', deviceHint: 'beta…0001', permissionState: 'granted', status: 'Active', revokedAt: undefined, revokeReason: undefined });
    expect(toDevice(deviceRow(1, { permission_state: 'weird', status: 'Revoked', revoked_at: '2026-10-30T03:00:00Z' }))).toMatchObject({ permissionState: 'unknown', status: 'Revoked', revokedAt: '2026-10-30T03:00:00Z' });
    expect(toDevicePage({ items: [deviceRow(1), 4], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toDevicePage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('knows which device can be pushed to: a registered one that the operating system allowed', () => {
    const device = toDevice(deviceRow(1)) as NonNullable<ReturnType<typeof toDevice>>;
    expect([canReceivePush(device), canReceivePush({ ...device, permissionState: 'provisional' }), canReceivePush({ ...device, permissionState: 'denied' }), canReceivePush({ ...device, status: 'Revoked' })]).toEqual([true, true, false, false]);
    expect(shortId(MEMBER)).toBe('00000000');
  });
});
