import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { DEVICE_STORAGE_KEY } from '../push-client';
import type { PushControlDeps } from '../usePushControl';
import PwaNotificationsScreen from './PwaNotificationsScreen';
import { mountPwa, pwaClient } from './test-support';

const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const SUBSCRIPTION = { endpoint: 'https://push.example/send/abc', keys: { p256dh: 'BPk', auth: 'a' } };

function storage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) } as unknown as Storage;
}

function deps(options: { subscribed?: boolean; support?: PushControlDeps['support']; permission?: NotificationPermission; registered?: boolean } = {}): PushControlDeps {
  let subscribed = options.subscribed ?? false;
  const subscription = { toJSON: () => SUBSCRIPTION, unsubscribe: vi.fn(() => ((subscribed = false), Promise.resolve(true))) };
  const registration = {
    pushManager: { getSubscription: () => Promise.resolve(subscribed ? subscription : null), subscribe: vi.fn(() => ((subscribed = true), Promise.resolve(subscription))) },
  } as unknown as ServiceWorkerRegistration;
  return {
    support: options.support ?? 'supported',
    vapidPublicKey: 'AQID',
    registration: () => Promise.resolve(registration),
    permission: () => options.permission ?? 'granted',
    requestPermission: () => Promise.resolve('granted'),
    storage: storage(options.registered === false ? {} : { [DEVICE_STORAGE_KEY]: JSON.stringify({ publicId: 'web-abc', registrationId: DEVICE }) }),
  };
}

function open(pushDeps: PushControlDeps, command?: (operation: string, input: unknown) => unknown) {
  const h = pwaClient({ command: command ?? (() => ({ operation_id: 'op', status: 'SENT', resource_version: 1, resource_id: DEVICE })) });
  const mounted = mountPwa(<PwaNotificationsScreen pushDeps={pushDeps} />, h, { permissions: [], path: '/m/notifications' });
  return { ...h, ...mounted };
}

afterEach(cleanup);

describe('PwaNotificationsScreen (PWA-10): the notification settings of the installed application', () => {
  it('shows the permission the browser holds and that this device is subscribed', async () => {
    open(deps({ subscribed: true, permission: 'granted' }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    expect(screen.getByTestId('webpush-permission').getAttribute('data-permission')).toBe('granted');
    expect(screen.getByRole('button', { name: /gửi thông báo thử/i })).toBeEnabled();
    expect(screen.queryByTestId('webpush-test-needs-on')).toBeNull();
  });

  it('sends the test notification to this device record and says it was sent', async () => {
    const view = open(deps({ subscribed: true }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    fireEvent.click(screen.getByRole('button', { name: /gửi thông báo thử/i }));
    await waitFor(() => expect(screen.getByTestId('webpush-test-state').getAttribute('data-state')).toBe('SENT'));
    expect(view.command).toHaveBeenCalledTimes(1);
    const [operation, input] = view.command.mock.calls[0] as [string, { path: { deviceId: string }; attempt: unknown }];
    expect(operation).toBe('sendMyTestPush');
    expect(input.path).toEqual({ deviceId: DEVICE });
    expect(screen.getByTestId('webpush-test-state').textContent).toMatch(/Đã gửi/);
  });

  it('says each outcome in words, and a failure of the request as a failure', async () => {
    for (const [status, text] of [
      ['GONE', /không còn nhận thiết bị/],
      ['RETRY_LATER', /chưa trả lời/],
      ['CHANNEL_NOT_ACTIVE', /chưa được kích hoạt/],
      ['NO_TOKEN', /chưa đăng ký/],
    ] as const) {
      const view = open(deps({ subscribed: true }), () => ({ operation_id: 'op', status, resource_version: 1, resource_id: DEVICE }));
      await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
      fireEvent.click(screen.getByRole('button', { name: /gửi thông báo thử/i }));
      await waitFor(() => expect(screen.getByTestId('webpush-test-state').getAttribute('data-state')).toBe(status));
      expect(screen.getByTestId('webpush-test-state').textContent, status).toMatch(text);
      view.unmount();
    }
    open(deps({ subscribed: true }), () => new Error('429'));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    fireEvent.click(screen.getByRole('button', { name: /gửi thông báo thử/i }));
    await waitFor(() => expect(screen.getByTestId('webpush-test-state').getAttribute('data-state')).toBe('failed'));
  });

  it('does not send a test while push is off, and offers to turn it on', async () => {
    const view = open(deps({ subscribed: false, permission: 'default' }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
    expect(screen.getByRole('button', { name: /gửi thông báo thử/i })).toBeDisabled();
    expect(screen.getByTestId('webpush-test-needs-on')).toBeTruthy();
    expect(screen.getByTestId('webpush-permission').getAttribute('data-permission')).toBe('default');
    expect(screen.getByRole('button', { name: /bật thông báo đẩy/i })).toBeTruthy();
    expect(view.command).not.toHaveBeenCalled();
  });

  it('turns push off for this device and reads the state again', async () => {
    const view = open(deps({ subscribed: true }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    fireEvent.click(screen.getByRole('button', { name: /tắt thông báo đẩy/i }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('off'));
    expect(view.command.mock.calls.map((call) => call[0])).toEqual(['revokeMyDevice']);
  });

  it('tells a blocked permission, an unsupported browser and a deployment without keys, and offers nothing it cannot do', async () => {
    open(deps({ subscribed: false, permission: 'denied' }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('blocked'));
    expect(screen.getByTestId('webpush-permission').textContent).toMatch(/bị chặn/);
    cleanup();
    for (const support of ['unsupported', 'unconfigured'] as const) {
      open(deps({ support }));
      expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe(support);
      expect(screen.getByRole('button', { name: /gửi thông báo thử/i })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /bật thông báo đẩy/i })).toBeNull();
      cleanup();
    }
  });

  it('tells a device that was never registered, instead of calling the server with nothing', async () => {
    const view = open(deps({ subscribed: true, registered: false }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    fireEvent.click(screen.getByRole('button', { name: /gửi thông báo thử/i }));
    await waitFor(() => expect(screen.getByTestId('webpush-test-state').getAttribute('data-state')).toBe('NO_TOKEN'));
    expect(view.command).not.toHaveBeenCalled();
  });

  it('has no serious accessibility violation', async () => {
    const view = open(deps({ subscribed: true }));
    await waitFor(() => expect(screen.getByTestId('push-state').getAttribute('data-state')).toBe('on'));
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
  });
});
