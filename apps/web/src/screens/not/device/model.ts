export const READ_PERMISSION = 'device_registration.read';
export const PLATFORMS = ['ios', 'android', 'web'] as const;
export const STATUSES = ['Active', 'Revoked'] as const;
export type DeviceStatus = (typeof STATUSES)[number];
export type PermissionState = 'granted' | 'denied' | 'provisional' | 'unknown';

/** A push device as the operator sees it: no token, no reference and not the whole public id of the device (NOT-14). */
export interface DeviceView {
  id: string;
  membershipId: string;
  platform: string;
  deviceHint: string;
  permissionState: PermissionState;
  appVersion: string;
  locale: string;
  lastSeenAt: string;
  status: DeviceStatus;
  revokedAt: string | undefined;
  revokeReason: string | undefined;
}

export interface DevicePage {
  items: DeviceView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const PERMISSION_STATES: readonly string[] = ['granted', 'denied', 'provisional', 'unknown'];

export function toDevice(raw: unknown): DeviceView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    membershipId: text(raw.membership_id),
    platform: text(raw.platform),
    deviceHint: text(raw.device_hint),
    permissionState: PERMISSION_STATES.includes(text(raw.permission_state)) ? (raw.permission_state as PermissionState) : 'unknown',
    appVersion: text(raw.app_version),
    locale: text(raw.locale),
    lastSeenAt: text(raw.last_seen_at),
    status: raw.status === 'Revoked' ? 'Revoked' : 'Active',
    revokedAt: optional(raw.revoked_at),
    revokeReason: optional(raw.revoke_reason),
  };
}

export function toDevicePage(raw: unknown): DevicePage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toDevice(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

/** A device can be pushed to only while it is registered and the operating system allowed it. */
export const canReceivePush = (device: Pick<DeviceView, 'status' | 'permissionState'>): boolean =>
  device.status === 'Active' && (device.permissionState === 'granted' || device.permissionState === 'provisional');

/** The short form of the id of a member, for a table: enough to tell two apart. */
export const shortId = (id: string): string => id.slice(0, 8);
