import { DomainError } from './errors.ts';
import { consentRequirement, isValidTimeZone, parseClock, preferenceChannelOf, quietHoursAt } from './notification-policy.ts';
import type { PreferenceChannel } from './notification-policy.ts';
import { ALERT_GOV_TEXT } from './messages/alert-gov-texts.ts';

/**
 * How a person is reached about alerts (roadmap G2-5, research A6, docs/alert-governance.md). Severity decides the channel: the bell of the application always tells the truth (it is the list itself and nothing here can hide an item from it);
 * the channels that interrupt (push, SMS, Zalo) are for what is urgent or to be acted on, they keep the quiet hours of the person (evenings, nights, weekends) except for an urgent alert of a type that may break them and that nobody took up in
 * time, they have a daily cap above which an urgent alert is grouped into one notice and anything else goes to the morning digest, and an item to be watched is never pushed, only digested. A push carries no amounts and no names
 * (R7 of the engineering review): a fixed sentence, a count and a link into the application, which asks for a login.
 *
 * Everything here is pure: the policy (the governance rule `ALERT_NOTIFY_POLICY`), the profile of the person, the clock and the counts of today come in as arguments.
 */

export const NOTIFY_RULE_TYPE = 'ALERT_NOTIFY_POLICY';
export const NOTIFY_DEFAULT_CODE = 'DEFAULT';

export type NotifySeverity = 'URGENT' | 'ACTION' | 'WATCH';
export const NOTIFY_SEVERITIES: readonly NotifySeverity[] = ['URGENT', 'ACTION', 'WATCH'];

/** The channels an alert can be sent on. The bell (`IN_APP`) is always on and is not a choice. */
export const ALERT_CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'ZALO'] as const;
export type NotifyChannel = (typeof ALERT_CHANNELS)[number];
/** The channels that interrupt a person: they keep the quiet hours and count against the daily cap. E-mail is read when the person chooses to. */
export const INTERRUPTING_CHANNELS: readonly NotifyChannel[] = ['PUSH', 'SMS', 'ZALO'];

type PerSeverity<T> = Readonly<Record<NotifySeverity, T>>;

export interface AlertNotifyPolicy {
  quiet_from: string;
  quiet_to: string;
  quiet_weekends: boolean;
  time_zone: string;
  digest_at: string;
  /** The most interrupting notices a person gets in a day (the research: 5 for the severities below urgent). */
  push_cap_per_day: number;
  /** After so many urgent notices within one hour the next ones are merged into one ("N urgent items"). */
  urgent_group_after_per_hour: number;
  /** The lowest severity a person may ask to be pushed for (never the one to be watched). */
  push_min_severity_floor: 'URGENT' | 'ACTION';
  default_channels: PerSeverity<readonly string[]>;
  /** Alerts with the same root (one cause key) are one card. */
  group_same_root: boolean;
  digest_max_lines: number;
  digest_lookahead_days: number;
}

/** Starting values of the research (Grafana IRM, Opsgenie and PagerDuty notification rules): quiet 21:00 to 06:30 and weekends, a cap of 5; to be calibrated on 4 to 6 weeks of real data. Not legal numbers. */
export function alertNotifyDefaults(): AlertNotifyPolicy {
  return {
    quiet_from: '21:00',
    quiet_to: '06:30',
    quiet_weekends: true,
    time_zone: 'Asia/Ho_Chi_Minh',
    digest_at: '07:30',
    push_cap_per_day: 5,
    urgent_group_after_per_hour: 3,
    push_min_severity_floor: 'ACTION',
    default_channels: { URGENT: ['IN_APP', 'PUSH'], ACTION: ['IN_APP', 'PUSH'], WATCH: ['IN_APP'] },
    group_same_root: true,
    digest_max_lines: 20,
    digest_lookahead_days: 3,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const clock = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || parseClock(value) === undefined) throw invalid(field);
  return value;
};
const whole = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
};

function channelList(value: unknown, field: string, allowInterrupting: boolean): string[] {
  if (!Array.isArray(value) || value.length > ALERT_CHANNELS.length) throw invalid(field);
  const seen = new Set<string>();
  for (const channel of value) {
    if (typeof channel !== 'string' || !(ALERT_CHANNELS as readonly string[]).includes(channel) || seen.has(channel)) throw invalid(field);
    if (!allowInterrupting && (INTERRUPTING_CHANNELS as readonly string[]).includes(channel)) throw invalid(field);
    seen.add(channel);
  }
  // The bell is always there: a policy that leaves it out is refused, not repaired.
  if (!seen.has('IN_APP')) throw invalid(field);
  return [...seen];
}

/** The params of an `ALERT_NOTIFY_POLICY` rule, checked: an item to be watched is never pushed, the bell is always a channel, a rule that does not say all of it is refused. */
export function alertNotifyPolicyOf(params: unknown): AlertNotifyPolicy {
  if (!isRecord(params)) throw invalid('params');
  const channels = params.default_channels;
  if (!isRecord(channels)) throw invalid('default_channels');
  const zone = params.time_zone;
  if (typeof zone !== 'string' || !isValidTimeZone(zone)) throw invalid('time_zone');
  const floor = params.push_min_severity_floor;
  if (floor !== 'URGENT' && floor !== 'ACTION') throw invalid('push_min_severity_floor');
  if (typeof params.quiet_weekends !== 'boolean') throw invalid('quiet_weekends');
  if (typeof params.group_same_root !== 'boolean') throw invalid('group_same_root');
  const from = clock(params.quiet_from, 'quiet_from');
  const to = clock(params.quiet_to, 'quiet_to');
  if (from === to) throw invalid('quiet_to');
  return {
    quiet_from: from,
    quiet_to: to,
    quiet_weekends: params.quiet_weekends,
    time_zone: zone,
    digest_at: clock(params.digest_at, 'digest_at'),
    push_cap_per_day: whole(params.push_cap_per_day, 'push_cap_per_day', 0, 100),
    urgent_group_after_per_hour: whole(params.urgent_group_after_per_hour, 'urgent_group_after_per_hour', 1, 20),
    push_min_severity_floor: floor,
    default_channels: { URGENT: channelList(channels.URGENT, 'default_channels.URGENT', true), ACTION: channelList(channels.ACTION, 'default_channels.ACTION', true), WATCH: channelList(channels.WATCH, 'default_channels.WATCH', false) },
    group_same_root: params.group_same_root,
    digest_max_lines: whole(params.digest_max_lines, 'digest_max_lines', 5, 50),
    digest_lookahead_days: whole(params.digest_lookahead_days, 'digest_lookahead_days', 1, 14),
  };
}

// -- The profile of one person -------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a person chose; whatever they left out (null) is the policy's. */
export interface AlertProfile {
  channels: Partial<Record<NotifySeverity, readonly string[]>> | null;
  quiet: { from: string; to: string; weekends: boolean; timeZone: string } | null;
  digest_enabled: boolean;
  digest_at: string | null;
  push_min_severity: 'URGENT' | 'ACTION' | null;
  push_cap_per_day: number | null;
  group_same_root: boolean | null;
}

export const emptyAlertProfile = (): AlertProfile => ({ channels: null, quiet: null, digest_enabled: true, digest_at: null, push_min_severity: null, push_cap_per_day: null, group_same_root: null });

export interface EffectiveAlertProfile {
  channels: PerSeverity<readonly NotifyChannel[]>;
  quiet: { from: string; to: string; weekends: boolean; timeZone: string };
  digestEnabled: boolean;
  digestAt: string;
  pushMinSeverity: 'URGENT' | 'ACTION';
  pushCapPerDay: number;
  groupSameRoot: boolean;
  urgentGroupAfterPerHour: number;
  /** Where each effective value comes from: the person's own choice or the policy in force. */
  own: { channels: boolean; quiet: boolean; digestAt: boolean; pushMinSeverity: boolean; pushCapPerDay: boolean; groupSameRoot: boolean };
}

export interface ProfileDefect {
  field: string;
  code: 'UNSUPPORTED' | 'MALFORMED' | 'BELL_REQUIRED' | 'WATCH_NOT_PUSHED' | 'ABOVE_POLICY' | 'DUPLICATE' | 'SAME_TIME';
}

/** Every defect of a profile, in the order of the fields; none when it is valid. The bell cannot be taken out, an item to be watched cannot be pushed, a person may lower the cap but not raise it above the policy. */
export function validateAlertProfile(profile: AlertProfile, policy: AlertNotifyPolicy): ProfileDefect[] {
  const defects: ProfileDefect[] = [];
  const add = (field: string, code: ProfileDefect['code']): void => void defects.push({ field, code });
  if (profile.channels !== null) {
    for (const severity of NOTIFY_SEVERITIES) {
      const list = profile.channels[severity];
      if (list === undefined) continue;
      const field = `channels.${severity}`;
      if (new Set(list).size !== list.length) add(field, 'DUPLICATE');
      else if (!list.every((channel) => (ALERT_CHANNELS as readonly string[]).includes(channel))) add(field, 'UNSUPPORTED');
      else if (!list.includes('IN_APP')) add(field, 'BELL_REQUIRED');
      else if (severity === 'WATCH' && list.some((channel) => (INTERRUPTING_CHANNELS as readonly string[]).includes(channel))) add(field, 'WATCH_NOT_PUSHED');
    }
  }
  if (profile.quiet !== null) {
    if (parseClock(profile.quiet.from) === undefined) add('quiet.from', 'MALFORMED');
    if (parseClock(profile.quiet.to) === undefined) add('quiet.to', 'MALFORMED');
    if (profile.quiet.from === profile.quiet.to) add('quiet.to', 'SAME_TIME');
    if (!isValidTimeZone(profile.quiet.timeZone)) add('quiet.time_zone', 'UNSUPPORTED');
  }
  if (profile.digest_at !== null && parseClock(profile.digest_at) === undefined) add('digest_at', 'MALFORMED');
  if (profile.push_min_severity !== null) {
    if (profile.push_min_severity !== 'URGENT' && profile.push_min_severity !== 'ACTION') add('push_min_severity', 'UNSUPPORTED');
    else if (profile.push_min_severity === 'ACTION' && policy.push_min_severity_floor === 'URGENT') add('push_min_severity', 'ABOVE_POLICY');
  }
  if (profile.push_cap_per_day !== null && (!Number.isInteger(profile.push_cap_per_day) || profile.push_cap_per_day < 0)) add('push_cap_per_day', 'MALFORMED');
  else if (profile.push_cap_per_day !== null && profile.push_cap_per_day > policy.push_cap_per_day) add('push_cap_per_day', 'ABOVE_POLICY');
  return defects;
}

/** 422 `ALERT_PROFILE_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidAlertProfile(profile: AlertProfile, policy: AlertNotifyPolicy): void {
  const defects = validateAlertProfile(profile, policy);
  if (defects.length > 0) throw new DomainError('ALERT_PROFILE_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

/**
 * The choices of a person laid over the policy. The quiet hours of the person come from the alert profile, else from `ownQuiet` (what the person set in the notification preferences, NOT-03), else from the policy: one answer, and it says whose it is.
 */
export function effectiveAlertProfile(policy: AlertNotifyPolicy, profile: AlertProfile | null, ownQuiet: { from: string; to: string; timeZone: string } | null = null): EffectiveAlertProfile {
  const chosen = profile ?? emptyAlertProfile();
  const channelsOf = (severity: NotifySeverity): readonly NotifyChannel[] => (chosen.channels?.[severity] ?? policy.default_channels[severity]) as readonly NotifyChannel[];
  const quiet = chosen.quiet ?? (ownQuiet === null ? null : { ...ownQuiet, weekends: policy.quiet_weekends });
  return {
    channels: { URGENT: channelsOf('URGENT'), ACTION: channelsOf('ACTION'), WATCH: channelsOf('WATCH') },
    quiet: quiet ?? { from: policy.quiet_from, to: policy.quiet_to, weekends: policy.quiet_weekends, timeZone: policy.time_zone },
    digestEnabled: chosen.digest_enabled,
    digestAt: chosen.digest_at ?? policy.digest_at,
    pushMinSeverity: chosen.push_min_severity ?? policy.push_min_severity_floor,
    pushCapPerDay: chosen.push_cap_per_day ?? policy.push_cap_per_day,
    groupSameRoot: chosen.group_same_root ?? policy.group_same_root,
    urgentGroupAfterPerHour: policy.urgent_group_after_per_hour,
    own: { channels: chosen.channels !== null, quiet: chosen.quiet !== null, digestAt: chosen.digest_at !== null, pushMinSeverity: chosen.push_min_severity !== null, pushCapPerDay: chosen.push_cap_per_day !== null, groupSameRoot: chosen.group_same_root !== null },
  };
}

// -- Quiet hours of a person (evenings, nights and weekends) ------------------------------------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<NotifySeverity, number>> = { URGENT: 0, ACTION: 1, WATCH: 2 };

/** The day of the week of an instant on the wall clock of a zone: 0 is Sunday, 6 is Saturday. */
export function weekdayInZone(instant: Date, zone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(instant);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

export interface QuietReading {
  quiet: boolean;
  /** When the quiet that covers the instant ends (the first instant, in steps of a quarter of an hour, that is not quiet); set only when quiet. */
  endsAt?: Date;
}

const QUARTER_MS = 15 * 60_000;
const MAX_QUIET_STEPS = 4 * 24 * 4;

/** Whether an instant is quiet for the person: inside the daily window, or on a weekend when the person keeps weekends quiet. */
export function quietAt(instant: Date, quiet: EffectiveAlertProfile['quiet']): QuietReading {
  const isQuiet = (at: Date): boolean => quietHoursAt(at, { start: quiet.from, end: quiet.to, timeZone: quiet.timeZone }).quiet || (quiet.weekends && [0, 6].includes(weekdayInZone(at, quiet.timeZone)));
  if (!isQuiet(instant)) return { quiet: false };
  let at = new Date(Math.ceil(instant.getTime() / QUARTER_MS) * QUARTER_MS);
  for (let step = 0; step < MAX_QUIET_STEPS && isQuiet(at); step += 1) at = new Date(at.getTime() + QUARTER_MS);
  return { quiet: true, endsAt: at };
}

// -- The decision for one alert and one person ----------------------------------------------------------------------------------------------------------------------------------------

export const NOTIFY_OCCASIONS = ['NEW_ITEM', 'REMINDER', 'ESCALATION', 'RECLAIM'] as const;
export type NotifyOccasionKind = (typeof NOTIFY_OCCASIONS)[number];

export interface NotifyOccasion {
  kind: NotifyOccasionKind;
  severity: NotifySeverity;
  /** Nobody took the item up in time (its claim clock is past): the one case in which an urgent alert may break the quiet hours, when its type allows it. */
  claimBreached: boolean;
  /** The alert type says an urgent alert of its kind may break the quiet hours. */
  typeMayBreakQuiet: boolean;
}

export interface NotifyContext {
  now: Date;
  profile: EffectiveAlertProfile;
  /** The interrupting notices already sent to the person in their day. */
  sentToday: number;
  /** The urgent notices already sent to the person in this hour. */
  urgentThisHour: number;
  /** Whether the person agreed to be written to on a channel that needs it (SMS, Zalo); the latest consent decides. */
  consent: Readonly<Partial<Record<NotifyChannel, boolean>>>;
}

export type NotifyDecision = 'SEND_NOW' | 'SEND_GROUPED' | 'HOLD_QUIET' | 'DIGEST' | 'SKIP_CAP' | 'SKIP_THRESHOLD' | 'SKIP_CONSENT';
export const NOTIFY_DECISIONS: readonly NotifyDecision[] = ['SEND_NOW', 'SEND_GROUPED', 'HOLD_QUIET', 'DIGEST', 'SKIP_CAP', 'SKIP_THRESHOLD', 'SKIP_CONSENT'];

export interface ChannelDecision {
  channel: NotifyChannel;
  decision: NotifyDecision;
  /** HOLD_QUIET: when the notice may go. */
  holdUntil: string | null;
  /** The notice broke the quiet hours and why. */
  bypass: 'URGENT_UNCLAIMED' | null;
  /** The notice went out inside the quiet hours of the person (only with a bypass). */
  inQuiet: boolean;
}

export interface NotifyPlan {
  /** The bell tells the truth whatever the rest says: it is always `true`, and nothing here can make it otherwise. */
  inApp: true;
  deliveries: ChannelDecision[];
  /** The item is listed in the next digest of the person (an item to be watched, and any notice that was held, capped or below the threshold). */
  digest: boolean;
}

/**
 * What to do about telling one person of one alert. The bell is always on. For each other channel the person chose for the severity: the threshold of the person first (below it, only the digest); the consent of the channel when it needs one;
 * the quiet hours (hold until they end, unless an urgent alert of a type that may break them was not taken up in time); then the daily cap (an urgent alert beyond it, or the fourth urgent notice of the hour, is sent grouped into one "N urgent"
 * notice; anything else goes to the digest). E-mail is read when the person chooses to, so it keeps neither the quiet hours nor the cap.
 */
export function planNotification(occasion: NotifyOccasion, context: NotifyContext): NotifyPlan {
  const { profile } = context;
  const chosen = profile.channels[occasion.severity];
  const deliveries: ChannelDecision[] = [];
  let digest = occasion.severity === 'WATCH' && profile.digestEnabled;
  const spill = (): void => {
    if (profile.digestEnabled) digest = true;
  };
  const quiet = quietAt(context.now, profile.quiet);
  const bypass = quiet.quiet && occasion.severity === 'URGENT' && occasion.typeMayBreakQuiet && occasion.claimBreached;
  for (const channel of chosen) {
    if (channel === 'IN_APP') continue;
    const make = (decision: NotifyDecision, extra: Partial<ChannelDecision> = {}): void => void deliveries.push({ channel, decision, holdUntil: null, bypass: null, inQuiet: false, ...extra });
    if (!(INTERRUPTING_CHANNELS as readonly string[]).includes(channel)) {
      make('SEND_NOW');
      continue;
    }
    // An item to be watched is never pushed; the person may also ask to be pushed for the urgent ones only.
    if (occasion.severity === 'WATCH' || SEVERITY_RANK[occasion.severity] > SEVERITY_RANK[profile.pushMinSeverity]) {
      make('SKIP_THRESHOLD');
      spill();
      continue;
    }
    const preference: PreferenceChannel | undefined = preferenceChannelOf(channel);
    if (consentRequirement(preference, 'REMINDER') === 'CONSENT' && context.consent[channel] !== true) {
      make('SKIP_CONSENT');
      spill();
      continue;
    }
    if (quiet.quiet && !bypass) {
      make('HOLD_QUIET', { holdUntil: quiet.endsAt === undefined ? null : quiet.endsAt.toISOString() });
      spill();
      continue;
    }
    const capped = context.sentToday >= profile.pushCapPerDay;
    if (occasion.severity === 'URGENT') {
      const grouped = capped || context.urgentThisHour >= profile.urgentGroupAfterPerHour;
      make(grouped ? 'SEND_GROUPED' : 'SEND_NOW', bypass ? { bypass: 'URGENT_UNCLAIMED', inQuiet: true } : {});
      continue;
    }
    if (capped) {
      make('SKIP_CAP');
      spill();
      continue;
    }
    make('SEND_NOW');
  }
  return { inApp: true, deliveries, digest };
}

// -- The words of a push: no amounts, no names ---------------------------------------------------------------------------------------------------------------------------------------

export const PUSH_KINDS = ['ITEM', 'ESCALATION', 'DIGEST', 'GROUP'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface PushPayload {
  kind: PushKind;
  severity: NotifySeverity;
  /** How many items the notice stands for (at least 1, at most 999). */
  count: number;
  /** A path into the application: the person logs in to see what it is about. */
  link: string;
  /** Notices that share it replace one another on the phone. */
  collapse_key: string;
  title: string;
  body: string;
}

const PATH = /^\/[a-z0-9][a-z0-9/_-]{0,80}(\?[a-z0-9_=&-]{1,80})?$/;

/**
 * The payload of a push (R7): a fixed title and sentence chosen by the kind and the severity, the number of items, and a path into the application. Nothing about the item reaches it: not its title, not an amount, not a name of a project, a
 * unit or a person. The text is picked from a closed catalogue, so no data can be put into it by mistake.
 */
export function buildPushPayload(input: { kind: PushKind; severity: NotifySeverity; count: number; link: string }): PushPayload {
  if (!(PUSH_KINDS as readonly string[]).includes(input.kind)) throw invalid('kind');
  if (!PATH.test(input.link)) throw invalid('link');
  const count = Math.min(999, Math.max(1, Math.trunc(Number.isFinite(input.count) ? input.count : 1)));
  return { kind: input.kind, severity: input.severity, count, link: input.link, collapse_key: `alert-${input.kind.toLowerCase()}-${input.severity.toLowerCase()}`, title: ALERT_GOV_TEXT.push_title(input.kind, input.severity), body: ALERT_GOV_TEXT.push_body(input.kind, count) };
}

const PUSH_KEYS = ['kind', 'severity', 'count', 'link', 'collapse_key', 'title', 'body'];

/** Refuses a payload that is not exactly what `buildPushPayload` gives for its kind, severity and count: an extra member, a changed sentence, or a link that is not a plain path. A guard for the code that sends, and for the tests. */
export function assertPushPayloadSafe(payload: PushPayload): void {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...PUSH_KEYS].sort().join(',')) throw invalid('payload');
  const expected = buildPushPayload({ kind: payload.kind, severity: payload.severity, count: payload.count, link: payload.link });
  if (expected.title !== payload.title || expected.body !== payload.body || expected.collapse_key !== payload.collapse_key || expected.count !== payload.count) throw invalid('payload');
}

// -- The morning digest ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const DIGEST_SECTIONS = ['OVERDUE', 'DUE_SOON', 'NEW', 'ON_BEHALF'] as const;
export type DigestSectionCode = (typeof DIGEST_SECTIONS)[number];

export interface DigestInputRow {
  source: string;
  id: string;
  title: string;
  subtitle: string | null;
  severity: NotifySeverity;
  dueOn: string | null;
  consequence: string | null;
  /** When the alert centre first saw it (null when unknown). */
  firstSeenAt: string | null;
  target: { screen: string; id: string };
  /** The person whose alert it is when the reader stands in for them. */
  onBehalfOf: string | null;
  snoozed: boolean;
}

export interface DigestLine {
  source: string;
  id: string;
  title: string;
  subtitle: string | null;
  severity: NotifySeverity;
  dueOn: string | null;
  /** What happens if it is not done; the line always has one, or says there is none known. */
  consequence: string | null;
  action: { screen: string; id: string };
  onBehalfOf: string | null;
}

export interface DigestSection {
  code: DigestSectionCode;
  count: number;
  lines: DigestLine[];
}

export interface Digest {
  sections: DigestSection[];
  total: number;
  /** Lines that did not fit the cap of the policy: the card says how many were left out, never drops them silently. */
  omitted: number;
}

const day = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);

/**
 * The one card a person reads in the morning, instead of the push for what is only to be watched: what is overdue, what falls due within the lookahead days, what is new since the last digest, and what waits for them as a deputy. An item is in one
 * section only (overdue first, then due soon, then new; an item of another person is only in the section of what the person covers). Each line carries the consequence and where the action is. An item that was put off is not in it.
 */
export function composeDigest(rows: readonly DigestInputRow[], input: { today: string; lookaheadDays: number; maxLines: number; newSince: string | null }): Digest {
  const buckets: Record<DigestSectionCode, DigestLine[]> = { OVERDUE: [], DUE_SOON: [], NEW: [], ON_BEHALF: [] };
  const rank: Readonly<Record<NotifySeverity, number>> = SEVERITY_RANK;
  const ordered = [...rows].filter((row) => !row.snoozed).sort((left, right) => rank[left.severity] - rank[right.severity] || (left.dueOn ?? '9999-12-31').localeCompare(right.dueOn ?? '9999-12-31') || left.id.localeCompare(right.id, 'en'));
  for (const row of ordered) {
    const line: DigestLine = { source: row.source, id: row.id, title: row.title, subtitle: row.subtitle, severity: row.severity, dueOn: row.dueOn, consequence: row.consequence, action: row.target, onBehalfOf: row.onBehalfOf };
    if (row.onBehalfOf !== null) buckets.ON_BEHALF.push(line);
    else if (row.dueOn !== null && day(row.dueOn) < day(input.today)) buckets.OVERDUE.push(line);
    else if (row.dueOn !== null && day(row.dueOn) - day(input.today) <= input.lookaheadDays) buckets.DUE_SOON.push(line);
    else if (row.firstSeenAt !== null && (input.newSince === null || row.firstSeenAt > input.newSince)) buckets.NEW.push(line);
  }
  let room = input.maxLines;
  let omitted = 0;
  const sections: DigestSection[] = [];
  for (const code of DIGEST_SECTIONS) {
    const all = buckets[code];
    const lines = all.slice(0, Math.max(0, room));
    room -= lines.length;
    omitted += all.length - lines.length;
    sections.push({ code, count: all.length, lines });
  }
  return { sections, total: sections.reduce((sum, section) => sum + section.count, 0), omitted };
}
