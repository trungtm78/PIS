import { newCommandAttempt } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';

/** Where the page remembers which device record it registered: an opaque id and the id the server gave it. Nothing about a person is kept. */
export const DEVICE_STORAGE_KEY = 'mv.pwa.device';
/** The version the page tells the server (`app_version`). */
export const PWA_APP_VERSION = 'pwa-1.0.0';

export interface StoredDevice {
  publicId: string;
  registrationId?: string;
}

/** The public key of the application server (VAPID) as the push API wants it: bytes, from the base64url the key is written in. */
export function applicationServerKey(base64Url: string): Uint8Array {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** The `device_public_id` of a registration: 16 to 128 characters of `[A-Za-z0-9._:-]`, random, kept in the browser so a second registration updates the first. */
export function newDevicePublicId(random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16))): string {
  return `web-${Array.from(random(), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function readStoredDevice(storage: Pick<Storage, 'getItem'> | undefined): StoredDevice | undefined {
  try {
    const raw = storage?.getItem(DEVICE_STORAGE_KEY);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredDevice>;
    return typeof parsed.publicId === 'string' ? { publicId: parsed.publicId, ...(typeof parsed.registrationId === 'string' ? { registrationId: parsed.registrationId } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredDevice(storage: Pick<Storage, 'setItem'> | undefined, device: StoredDevice): void {
  try {
    storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Storage that refuses (a private window) only means the next registration makes a new record.
  }
}

export type PushSupport = 'supported' | 'unsupported' | 'unconfigured';

/** Whether this browser can subscribe, and whether this deployment has a VAPID key to subscribe with. */
export function pushSupport(env: { VITE_WEBPUSH_VAPID_PUBLIC_KEY?: string }, win: { Notification?: unknown; PushManager?: unknown } = window, container: ServiceWorkerContainer | undefined = navigator.serviceWorker): PushSupport {
  if (win.Notification === undefined || win.PushManager === undefined || container === undefined) return 'unsupported';
  return env.VITE_WEBPUSH_VAPID_PUBLIC_KEY === undefined || env.VITE_WEBPUSH_VAPID_PUBLIC_KEY === '' ? 'unconfigured' : 'supported';
}

export type PermissionState = 'granted' | 'denied' | 'provisional' | 'unknown';

export const permissionStateOf = (permission: NotificationPermission): PermissionState => (permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'unknown');

export interface PushDeps {
  client: ApiClient;
  vapidPublicKey: string;
  locale: string;
  registration: ServiceWorkerRegistration;
  requestPermission(): Promise<NotificationPermission>;
  storage: Storage | undefined;
}

export type EnableResult = { kind: 'enabled'; registrationId: string | undefined } | { kind: 'denied' } | { kind: 'failed' };

/**
 * Turns web push on for this device: asks the permission (from a tap of the person), subscribes with the VAPID key and hands the subscription to the
 * server as a device of platform `web` (the token of a web device is its subscription, kept in the vault of the server). The same device id is reused,
 * so asking twice updates one record.
 */
export async function enablePush(deps: PushDeps): Promise<EnableResult> {
  const permission = await deps.requestPermission();
  if (permission !== 'granted') return { kind: 'denied' };
  try {
    const subscription =
      (await deps.registration.pushManager.getSubscription()) ??
      (await deps.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(deps.vapidPublicKey) as BufferSource }));
    const device = readStoredDevice(deps.storage) ?? { publicId: newDevicePublicId() };
    const answer = await deps.client.command('registerDevice', {
      body: {
        device_public_id: device.publicId,
        platform: 'web',
        push_token: JSON.stringify(subscription.toJSON()),
        permission_state: 'granted',
        app_version: PWA_APP_VERSION,
        locale: deps.locale === 'en' ? 'en-US' : 'vi-VN',
      },
      attempt: newCommandAttempt(),
    } as never);
    const registrationId = (answer as { resource_id?: string } | undefined)?.resource_id;
    writeStoredDevice(deps.storage, { publicId: device.publicId, ...(registrationId === undefined ? {} : { registrationId }) });
    return { kind: 'enabled', registrationId };
  } catch {
    return { kind: 'failed' };
  }
}

/** Whether this page has a push subscription now. */
export async function hasPushSubscription(registration: ServiceWorkerRegistration | undefined): Promise<boolean> {
  try {
    return (await registration?.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}

/** Ends the subscription at the push service. Returns whether there was one. */
export async function unsubscribePush(registration: ServiceWorkerRegistration | undefined): Promise<boolean> {
  try {
    const subscription = await registration?.pushManager.getSubscription();
    return subscription == null ? false : await subscription.unsubscribe();
  } catch {
    return false;
  }
}

/**
 * Removes the device record at the server (best effort: the server also revokes it when the session ends) while the session can still ask, and forgets
 * the record in the browser either way, so the next registration is a new device with a new id.
 */
export async function revokeDevice(client: ApiClient, storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined, reason: string): Promise<boolean> {
  const device = readStoredDevice(storage);
  try {
    if (device?.registrationId === undefined) return false;
    await client.command('revokeMyDevice', {
      path: { deviceId: device.registrationId },
      body: { reason },
      attempt: newCommandAttempt(),
    } as never);
    return true;
  } catch {
    return false;
  } finally {
    try {
      storage?.removeItem(DEVICE_STORAGE_KEY);
    } catch {
      // Storage that refuses leaves a record that the next registration overwrites.
    }
  }
}
