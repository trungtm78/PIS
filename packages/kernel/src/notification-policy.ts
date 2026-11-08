/**
 * The rules of who may be written to, when and on which channel (ST-NOT-003, NOT 3.3, BR-NOT-07, BR-NOT-08), as pure functions and data tables:
 * the names the preference and consent records use for a delivery channel, the consent decision table, and the quiet hours of a person in
 * their own time zone. The database and the dispatcher only ask; a change of the law is a change of a row of a table here, not of a flow.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
/** BR-NOT-08 (an assumption pending the owner): the hours of a person who never chose their own. */
export const DEFAULT_QUIET_START = '21:00';
export const DEFAULT_QUIET_END = '07:00';

/** The channels of a preference or a consent: the push providers share one, and so do the Zalo services. */
export const PREFERENCE_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH', 'SMS', 'ZALO', 'WHATSAPP'] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

/** The channels a person can consent to: everything but the inbox, which needs no consent (BR-NOT-07). */
export const CONSENT_CHANNELS = ['EMAIL', 'SMS', 'ZALO', 'WHATSAPP', 'PUSH'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_PURPOSES = ['OPERATIONAL', 'REMINDER', 'ANNOUNCEMENT', 'SUPPORT_CONVERSATION'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

const PREFERENCE_CHANNEL_OF: Readonly<Record<string, PreferenceChannel>> = {
  IN_APP: 'IN_APP',
  // The staff channel of the organisation (WF-1): messages to its own staff on its own Teams, so it is judged like the inbox (no consent of a person outside the organisation, no quiet hours of a phone).
  TEAMS: 'IN_APP',
  EMAIL: 'EMAIL',
  SMS: 'SMS',
  WHATSAPP: 'WHATSAPP',
  PUSH: 'PUSH',
  PUSH_FCM: 'PUSH',
  PUSH_APNS: 'PUSH',
  ZALO: 'ZALO',
  ZALO_OA: 'ZALO',
  ZALO_ZNS: 'ZALO',
};

/** The category of an event type in the preferences of a person: the first segment of its name (`report` of `report.overdue`). */
export function eventCategoryOf(eventType: string): string {
  return eventType.split('.')[0] ?? eventType;
}

/** The channel of a preference or a consent that a delivery channel of the engine falls under, or undefined for a channel no record can name. */
export function preferenceChannelOf(deliveryChannel: string): PreferenceChannel | undefined {
  return PREFERENCE_CHANNEL_OF[deliveryChannel];
}

/** BR-NOT-08: quiet hours disturb a person on these channels; the inbox and e-mail are read when the person chooses to. */
const QUIET_HOURS_CHANNELS: ReadonlySet<PreferenceChannel> = new Set<PreferenceChannel>(['PUSH', 'SMS', 'ZALO', 'WHATSAPP']);

export function isQuietHoursChannel(deliveryChannel: string): boolean {
  const channel = preferenceChannelOf(deliveryChannel);
  return channel !== undefined && QUIET_HOURS_CHANNELS.has(channel);
}

/** The purpose of a consent that covers a notification of the given purpose (BR-NOT-02): security and digest messages have no consent of their own. */
const CONSENT_PURPOSE_OF: Readonly<Record<string, ConsentPurpose>> = {
  OPERATIONAL: 'OPERATIONAL',
  SECURITY: 'OPERATIONAL',
  REMINDER: 'REMINDER',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  DIGEST: 'ANNOUNCEMENT',
  SUPPORT_CONVERSATION: 'SUPPORT_CONVERSATION',
};

export function consentPurposeOf(notificationPurpose: string): ConsentPurpose | undefined {
  return CONSENT_PURPOSE_OF[notificationPurpose];
}

export type ConsentRequirement = 'NONE' | 'CONSENT';

interface ConsentRule {
  channel: PreferenceChannel;
  /** The purposes of the notification the row covers, or every purpose. */
  purposes: readonly string[] | 'ALL';
  requirement: ConsentRequirement;
}

/**
 * BR-NOT-07 as data, first matching row wins, and a message that no row covers needs consent. The legal basis of the public duty (the inbox,
 * the duty messages on a push whose device the person registered) is an assumption pending CXN-PDP-01; a different answer of the data
 * protection officer changes a row here and nothing else. E-mail has no public-duty row: the module cannot tell an address of the agency from a
 * personal one yet, and a personal address needs consent for every purpose.
 */
export const CONSENT_DECISION_TABLE: readonly ConsentRule[] = [
  { channel: 'IN_APP', purposes: 'ALL', requirement: 'NONE' },
  { channel: 'PUSH', purposes: ['OPERATIONAL', 'SECURITY', 'REMINDER'], requirement: 'NONE' },
  { channel: 'PUSH', purposes: 'ALL', requirement: 'CONSENT' },
  { channel: 'EMAIL', purposes: 'ALL', requirement: 'CONSENT' },
  { channel: 'SMS', purposes: 'ALL', requirement: 'CONSENT' },
  { channel: 'ZALO', purposes: 'ALL', requirement: 'CONSENT' },
  { channel: 'WHATSAPP', purposes: 'ALL', requirement: 'CONSENT' },
];

export function consentRequirement(channel: PreferenceChannel | undefined, notificationPurpose: string): ConsentRequirement {
  if (channel === undefined) return 'CONSENT';
  const rule = CONSENT_DECISION_TABLE.find((row) => row.channel === channel && (row.purposes === 'ALL' || row.purposes.includes(notificationPurpose)));
  return rule?.requirement ?? 'CONSENT';
}

/** A consent as the decision reads it: the latest one for the person, channel and purpose decides. */
export interface ConsentState {
  status: 'Granted' | 'Withdrawn' | 'Expired';
}

/** BR-NOT-07: whether a message may be written to the person. The latest consent decides; no consent at all is no consent. */
export function consentAllows(requirement: ConsentRequirement, latest: ConsentState | undefined): boolean {
  return requirement === 'NONE' || latest?.status === 'Granted';
}

// Clock times and time zones.

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Minutes after midnight of a clock time `HH:MM` (00:00 to 23:59), or undefined. */
export function parseClock(text: string): number | undefined {
  const match = CLOCK.exec(text);
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
}

export function isValidTimeZone(zone: string): boolean {
  if (zone === '' || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall clock of a zone at an instant. */
function localPartsOf(instant: Date, zone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(zone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year ?? 0, month: parts.month ?? 1, day: parts.day ?? 1, hour: parts.hour ?? 0, minute: parts.minute ?? 0 };
}

const MINUTE_MS = 60_000;

/** The offset of the zone from UTC at an instant, in milliseconds. */
function offsetMs(instant: Date, zone: string): number {
  const local = localPartsOf(instant, zone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** The instant at which the wall clock of the zone reads the given date and minute of the day (the later one when a change of clock repeats it). */
function instantOf(year: number, month: number, day: number, minuteOfDay: number, zone: string): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const first = wall - offsetMs(new Date(wall), zone);
  const second = wall - offsetMs(new Date(first), zone);
  return new Date(second);
}

export interface QuietHours {
  /** `HH:MM` on the wall clock of the zone. */
  start: string;
  end: string;
  /** An IANA zone. */
  timeZone: string;
}

export interface QuietVerdict {
  quiet: boolean;
  /** When the quiet hours that cover the instant end; set only when `quiet`. */
  endsAt?: Date;
}

/**
 * BR-NOT-08: whether the instant falls inside the quiet hours of a person, and when they end. The hours are on the wall clock of the person, so the
 * same instant is evening in one zone and night in another, and a window that crosses midnight (21:00 to 07:00) ends on the next calendar day.
 * Equal start and end, or a value that is not a clock time, mean no quiet hours.
 */
export function quietHoursAt(instant: Date, hours: QuietHours): QuietVerdict {
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start === undefined || end === undefined || start === end || !isValidTimeZone(hours.timeZone)) return { quiet: false };
  const local = localPartsOf(instant, hours.timeZone);
  const minute = local.hour * 60 + local.minute;
  const crossesMidnight = start > end;
  const quiet = crossesMidnight ? minute >= start || minute < end : minute >= start && minute < end;
  if (!quiet) return { quiet: false };
  // The end falls on the same calendar day, except for the part of a window that crosses midnight which is still before midnight.
  const dayShift = crossesMidnight && minute >= start ? 1 : 0;
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day + dayShift));
  return { quiet: true, endsAt: instantOf(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), end, hours.timeZone) };
}
