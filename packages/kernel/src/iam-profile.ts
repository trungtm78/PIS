import { DomainError } from './errors.ts';

/** The profile a person edits themselves (ST-IAM-006, IAM-05) and the rules of what they may write in it. */
export const PROFILE_LOCALES = ['vi-VN', 'en-US'] as const;
export type ProfileLocale = (typeof PROFILE_LOCALES)[number];

export interface ProfilePatch {
  displayName?: string;
  locale?: ProfileLocale;
  timeZone?: string;
  phoneE164?: string;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const MIN_NAME = 2;
const MAX_NAME = 120;
const MAX_ZONE = 64;

/** True when the text holds a control character (C0 or DEL): a name is written on one line and shows what it says. */
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** True for a name of the time-zone database that this runtime knows (`Asia/Ho_Chi_Minh`); `Intl` refuses the rest. */
export function isTimeZone(zone: string): boolean {
  if (zone === '' || zone.length > MAX_ZONE || /[^A-Za-z0-9_+\-/]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the body of an update says, checked: the name (2 to 120 characters, whitespace collapsed at the ends, NFC), a locale the screens are written in, a time zone that exists and a phone number in E.164.
 * A field that is absent is left as it is; a body that changes nothing is 422 (`body`), and a value that is not acceptable is 422 naming the field.
 */
export function parseProfilePatch(body: Record<string, unknown>): ProfilePatch {
  const patch: ProfilePatch = {};
  if (body.display_name !== undefined) {
    const name = typeof body.display_name === 'string' ? body.display_name.normalize('NFC').trim() : '';
    if (name.length < MIN_NAME || name.length > MAX_NAME || hasControlCharacter(name)) throw new DomainError('VALIDATION_FAILED', 422, 'display_name');
    patch.displayName = name;
  }
  if (body.locale !== undefined) {
    const locale = PROFILE_LOCALES.find((candidate) => candidate === body.locale);
    if (locale === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'locale');
    patch.locale = locale;
  }
  if (body.time_zone !== undefined) {
    if (typeof body.time_zone !== 'string' || !isTimeZone(body.time_zone)) throw new DomainError('VALIDATION_FAILED', 422, 'time_zone');
    patch.timeZone = body.time_zone;
  }
  if (body.phone_e164 !== undefined) {
    if (typeof body.phone_e164 !== 'string' || !E164.test(body.phone_e164)) throw new DomainError('VALIDATION_FAILED', 422, 'phone_e164');
    patch.phoneE164 = body.phone_e164;
  }
  if (Object.keys(patch).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'body');
  return patch;
}

/** `an.nguyen@example.vn` as `a***@example.vn`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
