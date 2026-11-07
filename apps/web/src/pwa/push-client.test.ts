import type { ApiClient } from '@machvon/api-client';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_STORAGE_KEY, applicationServerKey, enablePush, hasPushSubscription, newDevicePublicId, permissionStateOf, pushSupport, readStoredDevice, revokeDevice, unsubscribePush, writeStoredDevice } from './push-client';

const DEVICE_PUBLIC_ID = /^[A-Za-z0-9._:-]{16,128}$/;
const SUBSCRIPTION = { endpoint: 'https://push.example/send/abc', expirationTime: null, keys: { p256dh: 'BPk', auth: 'a-secret' } };

function memoryStorage() {
  const data = new Map<string, string>();
  return Object.assign({ data }, { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) }) as unknown as Storage & { data: Map<string, string> };
}

function registration(existing: boolean) {
  const subscription = { toJSON: () => SUBSCRIPTION, unsubscribe: vi.fn(() => Promise.resolve(true)) };
  const subscribe = vi.fn(() => Promise.resolve(subscription));
  return {
    subscribe,
    subscription,
    registration: { pushManager: { getSubscription: () => Promise.resolve(existing ? subscription : null), subscribe } } as unknown as ServiceWorkerRegistration,
  };
}

describe('the push subscription of the page', () => {
  it('turns the VAPID key of the deployment into the bytes the push API wants', () => {
    // 65 bytes of an uncompressed P-256 point, written in base64url without padding.
    const bytes = Uint8Array.from({ length: 65 }, (_, index) => (index * 7 + 4) % 256);
    const base64Url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(Array.from(applicationServerKey(base64Url))).toEqual(Array.from(bytes));
  });

  it('makes a device id the server accepts and keeps it only as an opaque record', () => {
    expect(newDevicePublicId()).toMatch(DEVICE_PUBLIC_ID);
    expect(newDevicePublicId(() => new Uint8Array(16))).toBe(`web-${'00'.repeat(16)}`);
    const storage = memoryStorage();
    expect(readStoredDevice(storage)).toBeUndefined();
    writeStoredDevice(storage, { publicId: 'web-1', registrationId: 'r-1' });
    expect(readStoredDevice(storage)).toEqual({ publicId: 'web-1', registrationId: 'r-1' });
    storage.setItem(DEVICE_STORAGE_KEY, 'not json');
    expect(readStoredDevice(storage)).toBeUndefined();
    expect(readStoredDevice(undefined)).toBeUndefined();
  });

  it('says whether this browser and this deployment can push', () => {
    const full = { Notification: {}, PushManager: {} };
    const worker = {} as ServiceWorkerContainer;
    expect(pushSupport({ VITE_WEBPUSH_VAPID_PUBLIC_KEY: 'key' }, full, worker)).toBe('supported');
    expect(pushSupport({}, full, worker)).toBe('unconfigured');
    expect(pushSupport({ VITE_WEBPUSH_VAPID_PUBLIC_KEY: '' }, full, worker)).toBe('unconfigured');
    expect(pushSupport({ VITE_WEBPUSH_VAPID_PUBLIC_KEY: 'key' }, { Notification: {} }, worker)).toBe('unsupported');
    expect(pushSupport({ VITE_WEBPUSH_VAPID_PUBLIC_KEY: 'key' }, full, undefined)).toBe('unsupported');
    expect(permissionStateOf('granted')).toBe('granted');
    expect(permissionStateOf('denied')).toBe('denied');
    expect(permissionStateOf('default')).toBe('unknown');
  });

  it('subscribes after the person allowed notifications and registers the device as a web device', async () => {
    const world = registration(false);
    const command = vi.fn(() => Promise.resolve({ resource_id: 'reg-1' }));
    const storage = memoryStorage();
    const result = await enablePush({
      client: { command } as unknown as ApiClient,
      vapidPublicKey: 'AQID',
      locale: 'vi',
      registration: world.registration,
      requestPermission: () => Promise.resolve('granted'),
      storage,
    });
    expect(result).toEqual({ kind: 'enabled', registrationId: 'reg-1' });
    expect(world.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const [operation, input] = command.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('registerDevice');
    expect(input.body).toMatchObject({ platform: 'web', permission_state: 'granted', locale: 'vi-VN' });
    expect(input.body.device_public_id).toMatch(DEVICE_PUBLIC_ID);
    expect(JSON.parse(input.body.push_token as string)).toEqual(SUBSCRIPTION);
    expect(readStoredDevice(storage)?.registrationId).toBe('reg-1');
  });

  it('reuses the subscription and the device id it already has, so a second tap updates one record', async () => {
    const world = registration(true);
    const command = vi.fn(() => Promise.resolve({ resource_id: 'reg-1' }));
    const storage = memoryStorage();
    writeStoredDevice(storage, { publicId: 'web-keep-this-id-1234' });
    await enablePush({ client: { command } as unknown as ApiClient, vapidPublicKey: 'AQID', locale: 'en', registration: world.registration, requestPermission: () => Promise.resolve('granted'), storage });
    expect(world.subscribe).not.toHaveBeenCalled();
    const input = (command.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1];
    expect(input.body.device_public_id).toBe('web-keep-this-id-1234');
    expect(input.body.locale).toBe('en-US');
  });

  it('does not subscribe when the permission is refused, and says so when the registration fails', async () => {
    const refused = registration(false);
    const command = vi.fn();
    expect(await enablePush({ client: { command } as unknown as ApiClient, vapidPublicKey: 'AQID', locale: 'vi', registration: refused.registration, requestPermission: () => Promise.resolve('denied'), storage: undefined })).toEqual({ kind: 'denied' });
    expect(refused.subscribe).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    const failing = registration(false);
    const result = await enablePush({ client: { command: () => Promise.reject(new Error('server')) } as unknown as ApiClient, vapidPublicKey: 'AQID', locale: 'vi', registration: failing.registration, requestPermission: () => Promise.resolve('granted'), storage: undefined });
    expect(result).toEqual({ kind: 'failed' });
  });

  it('reads and ends the subscription, and forgets a failure of the push manager', async () => {
    const world = registration(true);
    expect(await hasPushSubscription(world.registration)).toBe(true);
    expect(await unsubscribePush(world.registration)).toBe(true);
    expect(world.subscription.unsubscribe).toHaveBeenCalled();
    const empty = registration(false);
    expect(await hasPushSubscription(empty.registration)).toBe(false);
    expect(await unsubscribePush(empty.registration)).toBe(false);
    expect(await hasPushSubscription(undefined)).toBe(false);
    const broken = { pushManager: { getSubscription: () => Promise.reject(new Error('x')) } } as unknown as ServiceWorkerRegistration;
    expect(await hasPushSubscription(broken)).toBe(false);
    expect(await unsubscribePush(broken)).toBe(false);
  });

  it('removes the device at the server while the session can still ask, and forgets the record either way', async () => {
    const storage = memoryStorage();
    writeStoredDevice(storage, { publicId: 'web-1', registrationId: '00000000-0000-4000-8000-000000000001' });
    const command = vi.fn(() => Promise.resolve({}));
    expect(await revokeDevice({ command } as unknown as ApiClient, storage, 'The person signed out of the installed application.')).toBe(true);
    const [operation, input] = command.mock.calls[0] as unknown as [string, { path: { deviceId: string }; body: { reason: string } }];
    expect(operation).toBe('revokeMyDevice');
    expect(input.path.deviceId).toBe('00000000-0000-4000-8000-000000000001');
    expect(storage.data.size).toBe(0);

    writeStoredDevice(storage, { publicId: 'web-2', registrationId: '00000000-0000-4000-8000-000000000002' });
    expect(await revokeDevice({ command: () => Promise.reject(new Error('offline')) } as unknown as ApiClient, storage, 'reason of ten characters')).toBe(false);
    expect(storage.data.size).toBe(0);
    // A device that was never registered at the server has nothing to remove there.
    const silent = vi.fn();
    expect(await revokeDevice({ command: silent } as unknown as ApiClient, storage, 'reason of ten characters')).toBe(false);
    expect(silent).not.toHaveBeenCalled();
  });
});
