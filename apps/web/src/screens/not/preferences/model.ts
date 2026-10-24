import { ApiError } from '@machvon/api-client';

/** The category that stands for every category of events. */
export const ALL_CATEGORIES = '*';
export const PREFERENCE_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH', 'SMS', 'ZALO', 'WHATSAPP'] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];
export const DIGEST_MODES = ['IMMEDIATE', 'HOURLY', 'DAILY'] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];

/** The time zones the screen offers; the zone the person has saved is always offered too. */
export const TIME_ZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'UTC'] as const;

const CATEGORY = /^[a-z][a-z0-9_]{0,59}$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_ITEMS = 200;

export interface PreferenceCell {
  eventCategory: string;
  channel: PreferenceChannel;
  enabled: boolean;
  digestMode: DigestMode;
}

/** The preferences as the server holds them (`getMyNotificationPreferences`). */
export interface PreferenceView {
  /** The version a save is made under; 0 for a person who never saved. */
  version: number;
  isDefault: boolean;
  quietStart: string | undefined;
  quietEnd: string | undefined;
  timeZone: string;
  cells: PreferenceCell[];
  /** The channels the person cannot switch off: the inbox of the categories that hold an urgent event. */
  locked: Array<{ eventCategory: string; channel: PreferenceChannel }>;
}

/** What the person is editing. A cell that is not listed is on. */
export interface PreferenceDraft {
  /** `category|channel` of every cell that is switched off. */
  off: ReadonlySet<string>;
  /** The digest mode of a category (every channel of it). */
  digest: ReadonlyMap<string, DigestMode>;
  /** The categories shown as rows besides every category. */
  categories: readonly string[];
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
}

const isChannel = (value: unknown): value is PreferenceChannel => typeof value === 'string' && (PREFERENCE_CHANNELS as readonly string[]).includes(value);
const isDigest = (value: unknown): value is DigestMode => typeof value === 'string' && (DIGEST_MODES as readonly string[]).includes(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

export const cellKey = (category: string, channel: string): string => `${category}|${channel}`;

/** Reads the answer; one that is not readable is refused as a whole (the version in it decides what a save overwrites). */
export function toPreferenceView(raw: unknown): PreferenceView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const view = raw as Record<string, unknown>;
  if (typeof view.version !== 'number' || !Number.isInteger(view.version) || !isText(view.time_zone) || !Array.isArray(view.items)) return undefined;
  const cells: PreferenceCell[] = [];
  for (const entry of view.items as unknown[]) {
    const item = entry as Record<string, unknown> | null;
    if (item === null || typeof item !== 'object' || !isText(item.event_category) || !isChannel(item.channel) || typeof item.enabled !== 'boolean') return undefined;
    cells.push({ eventCategory: item.event_category, channel: item.channel, enabled: item.enabled, digestMode: isDigest(item.digest_mode) ? item.digest_mode : 'IMMEDIATE' });
  }
  const locked = (Array.isArray(view.locked) ? (view.locked as unknown[]) : []).flatMap((entry) => {
    const item = entry as Record<string, unknown> | null;
    return item !== null && typeof item === 'object' && isText(item.event_category) && isChannel(item.channel) ? [{ eventCategory: item.event_category, channel: item.channel }] : [];
  });
  return {
    version: view.version,
    isDefault: view.is_default === true,
    quietStart: isText(view.quiet_start) ? view.quiet_start : undefined,
    quietEnd: isText(view.quiet_end) ? view.quiet_end : undefined,
    timeZone: view.time_zone,
    cells,
    locked,
  };
}

export function draftOf(view: PreferenceView): PreferenceDraft {
  const digest = new Map<string, DigestMode>();
  for (const cell of view.cells) if (cell.digestMode !== 'IMMEDIATE') digest.set(cell.eventCategory, cell.digestMode);
  const categories = [...new Set([...view.cells.map((cell) => cell.eventCategory), ...view.locked.map((entry) => entry.eventCategory)])].filter((name) => name !== ALL_CATEGORIES).sort();
  return {
    off: new Set(view.cells.filter((cell) => !cell.enabled).map((cell) => cellKey(cell.eventCategory, cell.channel))),
    digest,
    categories,
    quietOn: view.quietStart !== undefined && view.quietEnd !== undefined,
    quietStart: view.quietStart ?? '21:00',
    quietEnd: view.quietEnd ?? '07:00',
    timeZone: view.timeZone,
  };
}

/** Whether the person cannot change the cell: the inbox of a category that holds an urgent event (or of every category when any does). */
export function isLocked(view: PreferenceView, category: string, channel: string): boolean {
  return channel === 'IN_APP' && view.locked.some((entry) => category === ALL_CATEGORIES || entry.eventCategory === category);
}

export const categoryIsValid = (name: string): boolean => CATEGORY.test(name);

/** The hours the draft means, or a reason they are not acceptable: both are clock times and they differ. */
export function quietProblem(draft: PreferenceDraft): 'clock' | 'empty' | undefined {
  if (!draft.quietOn) return undefined;
  if (!CLOCK.test(draft.quietStart) || !CLOCK.test(draft.quietEnd)) return 'clock';
  return draft.quietStart === draft.quietEnd ? 'empty' : undefined;
}

export interface PreferenceBody {
  items: Array<{ event_category: string; channel: PreferenceChannel; enabled: boolean; digest_mode: DigestMode }>;
  quiet_start?: string;
  quiet_end?: string;
  time_zone: string;
}

/** The body of the save: a cell is sent when it is off or its category has a digest mode; everything else is on by default. */
export function bodyOf(draft: PreferenceDraft): PreferenceBody {
  const items: PreferenceBody['items'] = [];
  for (const category of [ALL_CATEGORIES, ...draft.categories]) {
    const digestMode = draft.digest.get(category) ?? 'IMMEDIATE';
    for (const channel of PREFERENCE_CHANNELS) {
      const enabled = !draft.off.has(cellKey(category, channel));
      if (!enabled || digestMode !== 'IMMEDIATE') items.push({ event_category: category, channel, enabled, digest_mode: digestMode });
    }
  }
  return { items, ...(draft.quietOn ? { quiet_start: draft.quietStart, quiet_end: draft.quietEnd } : {}), time_zone: draft.timeZone };
}

export const tooManyItems = (draft: PreferenceDraft): boolean => bodyOf(draft).items.length > MAX_ITEMS;

export type ProblemReason = 'locked' | 'stale' | 'invalid' | 'denied' | 'session' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  MANDATORY_CHANNEL_LOCKED: 'locked',
  VERSION_CONFLICT: 'stale',
  VALIDATION_FAILED: 'invalid',
  SCOPE_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

export function problemReasonOf(error: unknown): ProblemReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}
