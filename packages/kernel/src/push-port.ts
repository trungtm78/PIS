import { DomainError } from './errors.ts';

/**
 * The rules of a push message (ST-NOT-007, NOT 3.7, BR-NOT-11), judged before anything goes to FCM or APNs. A push is seen on a lock screen by whoever holds the phone, so it carries a neutral sentence and an opaque link
 * and nothing else: no figure, no name, no business link. The error codes of the two providers are classified once, here, into the words of the delivery engine: a failure to try again, a failure for good, and, for the
 * token the provider no longer knows, the revocation of the device.
 */
export const PUSH_CHANNELS: ReadonlySet<string> = new Set(['PUSH_FCM', 'PUSH_APNS']);
export const isPushChannel = (channel: string): boolean => PUSH_CHANNELS.has(channel);

/** The platforms a channel reaches: Firebase serves Android and the web, APNs serves iOS. */
export const PLATFORMS_OF_CHANNEL: Readonly<Record<string, readonly string[]>> = { PUSH_FCM: ['android', 'web'], PUSH_APNS: ['ios'] };

/** A device the message goes to: the registration (to revoke it) and its token (read from the vault for the call, never kept). */
export interface PushTarget {
  deviceId: string;
  token: string;
}

/** What the provider answers, in the words of the engine. `revoke` says the provider no longer knows the token: the device is revoked. */
export interface PushFailure {
  failureClass: 'RETRYABLE' | 'PERMANENT';
  revoke: boolean;
  retryAfterSeconds?: number;
}

/** Firebase Cloud Messaging (HTTP v1) error codes. [VERIFIED only after a sandbox spike: the list follows the public documentation.] */
export function classifyFcmError(code: string): PushFailure {
  switch (code) {
    case 'UNREGISTERED':
    case 'INVALID_ARGUMENT_TOKEN':
    case 'SENDER_ID_MISMATCH':
      return { failureClass: 'PERMANENT', revoke: true };
    case 'QUOTA_EXCEEDED':
      return { failureClass: 'RETRYABLE', revoke: false, retryAfterSeconds: 60 };
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return { failureClass: 'RETRYABLE', revoke: false };
    default:
      // The account is wrong, the message is wrong, or the code is one nobody has met: not the device's fault and not worth repeating.
      return { failureClass: 'PERMANENT', revoke: false };
  }
}

/** Apple Push Notification service reasons. [VERIFIED only after a sandbox spike: the list follows the public documentation.] */
export function classifyApnsReason(reason: string): PushFailure {
  switch (reason) {
    case 'BadDeviceToken':
    case 'Unregistered':
    case 'DeviceTokenNotForTopic':
    case 'ExpiredToken':
      return { failureClass: 'PERMANENT', revoke: true };
    case 'TooManyRequests':
      return { failureClass: 'RETRYABLE', revoke: false, retryAfterSeconds: 60 };
    case 'ServiceUnavailable':
    case 'InternalServerError':
    case 'Shutdown':
      return { failureClass: 'RETRYABLE', revoke: false };
    default:
      return { failureClass: 'PERMANENT', revoke: false };
  }
}

export const classifierOf = (channel: string): ((code: string) => PushFailure) => (channel === 'PUSH_APNS' ? classifyApnsReason : classifyFcmError);

/** The only link a push carries: it names the notification and nothing about what it is about, and opening it asks for the permission of the moment. */
export const OPAQUE_LINK = /^\/r\/[A-Za-z0-9_-]{16,64}$/;
export const opaqueLinkOf = (notificationId: string): string => `/r/${notificationId}`;

/** A sentence on a lock screen is short and finished. */
export const LOCK_SCREEN_MAX = 120;

/**
 * A push is lock-screen safe when its text is a finished sentence with nothing left to fill in, short, and its link is opaque. The template of a push is judged when it is written (no variable at all); this is the last
 * look before the provider, so that a template that predates the rule, or a bug, cannot put a figure or a name on a lock screen.
 */
export function assertLockScreenSafe(text: string, deepLink: string | undefined): void {
  if (text.trim() === '' || text.length > LOCK_SCREEN_MAX || /\{\{|\}\}/.test(text)) throw new DomainError('TEMPLATE_INVALID', 422, 'lockscreen_text');
  if (deepLink !== undefined && !OPAQUE_LINK.test(deepLink)) throw new DomainError('TEMPLATE_INVALID', 422, 'lockscreen_link');
}
