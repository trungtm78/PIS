import { ApiError } from '@machvon/api-client';

export const LOCALES = ['vi-VN', 'en-US'] as const;
export const TIME_ZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'] as const;
export const MIN_REASON = 10;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface ProfileView {
  id: string;
  displayName: string;
  emailMasked: string;
  phoneMasked: string | null;
  locale: string;
  timeZone: string;
  version: number;
}

export function toProfile(raw: unknown): ProfileView | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const displayName = text(row?.display_name);
  const version = row?.version;
  if (row === undefined || id === undefined || displayName === undefined || typeof version !== 'number') return undefined;
  return { id, displayName, emailMasked: text(row.email_masked) ?? '', phoneMasked: text(row.phone_masked) ?? null, locale: text(row.locale) ?? 'vi-VN', timeZone: text(row.time_zone) ?? 'Asia/Ho_Chi_Minh', version };
}

export interface SessionView {
  id: string;
  current: boolean;
  assurance: 'aal1' | 'aal2';
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  devicePlatform: string | null;
}

export function toSession(raw: unknown): SessionView | undefined {
  const row = record(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined || typeof row.current !== 'boolean') return undefined;
  return {
    id,
    current: row.current,
    assurance: row.assurance_level === 'aal2' ? 'aal2' : 'aal1',
    userAgent: text(row.user_agent_summary) ?? '',
    createdAt: text(row.created_at) ?? '',
    lastSeenAt: text(row.last_seen_at) ?? '',
    devicePlatform: text(record(row.device)?.platform) ?? null,
  };
}

export interface DeviceView {
  id: string;
  platform: string;
  devicePublicId: string;
  lastSeenAt: string;
  revoked: boolean;
}

export function toDevice(raw: unknown): DeviceView | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const platform = text(row?.platform);
  if (row === undefined || id === undefined || platform === undefined) return undefined;
  return { id, platform, devicePublicId: text(row.device_public_id) ?? '', lastSeenAt: text(row.last_seen_at) ?? '', revoked: row.status === 'REVOKED' };
}

// ---- the profile form --------------------------------------------------------------------------------------------------------------

export interface ProfileForm {
  displayName: string;
  locale: string;
  timeZone: string;
  phone: string;
}

export const formOf = (profile: ProfileView): ProfileForm => ({ displayName: profile.displayName, locale: profile.locale, timeZone: profile.timeZone, phone: '' });

export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidPhone';

export function validateProfile(form: ProfileForm): Partial<Record<keyof ProfileForm, FormProblem>> {
  const problems: Partial<Record<keyof ProfileForm, FormProblem>> = {};
  const name = form.displayName.trim();
  if (name === '') problems.displayName = 'required';
  else if (name.length < 2) problems.displayName = 'tooShort';
  else if (name.length > 120) problems.displayName = 'tooLong';
  if (form.phone.trim() !== '' && !/^\+[1-9][0-9]{7,14}$/.test(form.phone.trim())) problems.phone = 'invalidPhone';
  return problems;
}

/** Only what the person changed is sent: a field left as it was stays as it is on the server (the phone is shown masked, so it is sent only when a new one is typed). */
export function profileBody(form: ProfileForm, profile: ProfileView): Record<string, string> {
  const body: Record<string, string> = {};
  if (form.displayName.trim() !== profile.displayName) body.display_name = form.displayName.trim();
  if (form.locale !== profile.locale) body.locale = form.locale;
  if (form.timeZone !== profile.timeZone) body.time_zone = form.timeZone;
  if (form.phone.trim() !== '') body.phone_e164 = form.phone.trim();
  return body;
}

export interface FieldDifference {
  field: 'displayName' | 'locale' | 'timeZone';
  entered: string;
  current: string;
}

/** The fields the person entered that the profile, read again after a conflict, no longer agrees with: the two values stand side by side. */
export function differences(form: ProfileForm, original: ProfileView, current: ProfileView): FieldDifference[] {
  const list: FieldDifference[] = [];
  if (form.displayName.trim() !== original.displayName && form.displayName.trim() !== current.displayName) list.push({ field: 'displayName', entered: form.displayName.trim(), current: current.displayName });
  if (form.locale !== original.locale && form.locale !== current.locale) list.push({ field: 'locale', entered: form.locale, current: current.locale });
  if (form.timeZone !== original.timeZone && form.timeZone !== current.timeZone) list.push({ field: 'timeZone', entered: form.timeZone, current: current.timeZone });
  return list;
}

// ---- the refusals -----------------------------------------------------------------------------------------------------------------

export type Problem = 'versionConflict' | 'currentSession' | 'validation' | 'notFound' | 'denied' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'SESSION_CURRENT':
      return 'currentSession';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}
