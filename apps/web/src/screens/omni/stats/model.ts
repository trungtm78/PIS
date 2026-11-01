/**
 * OMNI-10: the statistics of the interactions (ST-OMNI-008, BR-OMNI-09, UAT-AC199). Counts only, drawn from the conversations the reader may see and never from a message or a person: the share of conversations whose first reply came
 * within the deadline is the conversations answered in time over the conversations that had a first-response deadline in the period. With no such conversation there is no rate, and the screen says there is no basis to compute it.
 */
export const PERIODS = ['last7', 'last30', 'month'] as const;
export type Period = (typeof PERIODS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Vietnam time (UTC+7, no summer time): the day a deadline falls on is the day on the clocks of the people who work to it. */
const VIETNAM_OFFSET_MS = 7 * HOUR_MS;

export interface Range {
  /** Inclusive, in milliseconds since 1970. */
  startMs: number;
  /** Exclusive. */
  endMs: number;
  /** The first and the last day of the period, as dates. */
  startDay: string;
  endDay: string;
}

const dayOf = (ms: number): string => new Date(ms + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
const midnightOf = (ms: number): number => Math.floor((ms + VIETNAM_OFFSET_MS) / DAY_MS) * DAY_MS - VIETNAM_OFFSET_MS;

/** The period asked for, as it stands at `nowMs`: the last 7 or 30 days up to the end of today, or the calendar month of today. */
export function rangeOf(period: Period, nowMs: number): Range {
  const tomorrow = midnightOf(nowMs) + DAY_MS;
  let startMs: number;
  let endMs = tomorrow;
  if (period === 'month') {
    const local = new Date(nowMs + VIETNAM_OFFSET_MS);
    startMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - VIETNAM_OFFSET_MS;
    endMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - VIETNAM_OFFSET_MS;
  } else {
    startMs = tomorrow - (period === 'last7' ? 7 : 30) * DAY_MS;
  }
  return { startMs, endMs, startDay: dayOf(startMs), endDay: dayOf(endMs - 1) };
}

/** What the statistics need of a conversation: when it came, by which channel, in whose queue, until when the first reply was due, and when it was given. */
export interface StatConversation {
  channel: string;
  unitName: string | null;
  createdAtMs: number;
  dueAtMs: number | null;
  /** Whether the API says when the first reply was given at all (null: not yet); a rate needs it for every conversation it counts. */
  firstReply: { reported: false } | { reported: true; atMs: number | null };
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** A conversation as the register answers it; a row without a time of creation is dropped rather than counted in no period. */
export function toStatConversation(raw: unknown): StatConversation | undefined {
  if (!isRecord(raw)) return undefined;
  const createdAtMs = instant(raw.created_at);
  if (typeof raw.channel !== 'string' || createdAtMs === null) return undefined;
  return {
    channel: raw.channel,
    unitName: typeof raw.queue_unit_name === 'string' && raw.queue_unit_name !== '' ? raw.queue_unit_name : null,
    createdAtMs,
    dueAtMs: instant(raw.sla_first_response_due_at),
    firstReply: 'first_response_at' in raw ? { reported: true, atMs: instant(raw.first_response_at) } : { reported: false },
  };
}

/** Why a rate is shown, or why it is not: no conversation had a deadline in the period, the API does not say when the first reply came, or it is computed. */
export type Basis = 'noBasis' | 'unreported' | 'computed';

export interface Figures {
  /** Conversations that began in the period. */
  opened: number;
  /** Conversations with a first-response deadline in the period: the denominator of the rate. */
  denominator: number;
  /** Of those, answered first within the deadline; null while the API does not say when the first reply came. */
  answeredInTime: number | null;
  basis: Basis;
  /** The rate in percent with one decimal, written from whole counts; null when there is no rate. */
  rate: string | null;
}

export interface Group extends Figures {
  key: string;
}

export interface Statistics extends Figures {
  range: Range;
  byChannel: Group[];
  byUnit: Group[];
}

/** A share of whole counts in percent with one decimal ("87.5"), without a floating point number in between. */
export function percentOf(part: number, whole: number): string {
  const tenths = Math.round((part * 1000) / whole);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function figuresOf(conversations: readonly StatConversation[], range: Range): Figures {
  const within = (ms: number): boolean => ms >= range.startMs && ms < range.endMs;
  const due = conversations.filter((conversation) => conversation.dueAtMs !== null && within(conversation.dueAtMs));
  const opened = conversations.filter((conversation) => within(conversation.createdAtMs)).length;
  if (due.length === 0) return { opened, denominator: 0, answeredInTime: null, basis: 'noBasis', rate: null };
  if (due.some((conversation) => !conversation.firstReply.reported)) return { opened, denominator: due.length, answeredInTime: null, basis: 'unreported', rate: null };
  const answeredInTime = due.filter(
    (conversation) => conversation.firstReply.reported && conversation.firstReply.atMs !== null && conversation.dueAtMs !== null && conversation.firstReply.atMs <= conversation.dueAtMs,
  ).length;
  return { opened, denominator: due.length, answeredInTime, basis: 'computed', rate: percentOf(answeredInTime, due.length) };
}

function groupsOf(conversations: readonly StatConversation[], range: Range, keyOf: (conversation: StatConversation) => string): Group[] {
  const keys = [...new Set(conversations.map(keyOf))].sort((left, right) => left.localeCompare(right));
  return keys
    .map((key) => ({
      key,
      ...figuresOf(
        conversations.filter((conversation) => keyOf(conversation) === key),
        range,
      ),
    }))
    .filter((group) => group.opened > 0 || group.denominator > 0);
}

/** The key of the queue of the whole tenant, a conversation that sits in no unit queue. */
export const TENANT_QUEUE = '';

export function statisticsOf(conversations: readonly StatConversation[], period: Period, nowMs: number): Statistics {
  const range = rangeOf(period, nowMs);
  return {
    range,
    ...figuresOf(conversations, range),
    byChannel: groupsOf(conversations, range, (conversation) => conversation.channel),
    byUnit: groupsOf(conversations, range, (conversation) => conversation.unitName ?? TENANT_QUEUE),
  };
}
