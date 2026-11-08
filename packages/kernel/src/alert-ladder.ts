import { DomainError } from './errors.ts';

/**
 * The channel ladder of an alert and its delivery receipts (GOV-10, roadmap G2-6), as pure rules. The delivery engine of notifications (retries, per-channel fallback after a failure, quiet hours, consent, circuit breakers) already
 * exists; the ladder is the layer above it that is about the ALERT: an urgent alert goes to the person in the application, then by push, and if nobody has seen it after the wait of the rung it goes to Zalo, then SMS, and
 * at the end it is handed to the escalation (the next level hears of it). A rung is satisfied by a receipt, not by having been sent: "sent" is not "told". The policy is the rule `ALERT_CHANNEL_LADDER` (one code per
 * severity); the numbers are starting values that are not confirmed with the customer. A message of the ladder carries no financial figure: a hint and a link that needs a login.
 */

export const LADDER_RULE_TYPE = 'ALERT_CHANNEL_LADDER';
export const LADDER_CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'ZALO', 'SMS'] as const;
export type LadderChannel = (typeof LADDER_CHANNELS)[number];
export const LADDER_SEVERITIES = ['URGENT', 'ACTION', 'WATCH'] as const;
export type LadderSeverity = (typeof LADDER_SEVERITIES)[number];

export interface LadderRung {
  channel: LadderChannel;
  /** Minutes to wait for a receipt after this rung is sent, before the next rung; ignored on the last rung (the wait before the hand-off is `hand_off_after_minutes`). */
  wait_minutes: number;
}

export interface LadderPolicy {
  rungs: LadderRung[];
  /** The receipt that ends the ladder: the message reached the device (`DELIVERED`) or the person opened it (`SEEN`). */
  stop_when: 'DELIVERED' | 'SEEN';
  /** What happens after the last rung without a receipt: the escalation takes over (`ESCALATE`), or the ladder ends exhausted (`NONE`). */
  hand_off: 'ESCALATE' | 'NONE';
  hand_off_after_minutes: number;
  /** A ladder that is still running after this many minutes is closed as expired. */
  expires_after_minutes: number;
}

export const ladderDefaults = (): Record<LadderSeverity, LadderPolicy> => ({
  URGENT: {
    rungs: [
      { channel: 'IN_APP', wait_minutes: 0 },
      { channel: 'PUSH', wait_minutes: 15 },
      { channel: 'ZALO', wait_minutes: 30 },
      { channel: 'SMS', wait_minutes: 30 },
    ],
    stop_when: 'SEEN',
    hand_off: 'ESCALATE',
    hand_off_after_minutes: 30,
    expires_after_minutes: 1440,
  },
  ACTION: {
    rungs: [
      { channel: 'IN_APP', wait_minutes: 0 },
      { channel: 'EMAIL', wait_minutes: 240 },
    ],
    stop_when: 'DELIVERED',
    hand_off: 'NONE',
    hand_off_after_minutes: 0,
    expires_after_minutes: 4320,
  },
  WATCH: { rungs: [{ channel: 'IN_APP', wait_minutes: 0 }], stop_when: 'DELIVERED', hand_off: 'NONE', hand_off_after_minutes: 0, expires_after_minutes: 10_080 },
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The params of an `ALERT_CHANNEL_LADDER` rule, checked: the first rung is the inbox (it needs no consent and is the truth of the bell), a channel appears once, and every wait is a whole number of minutes. */
export function ladderPolicyOf(params: unknown): LadderPolicy {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw invalid('params');
  const record = params as Record<string, unknown>;
  const rungs = record.rungs;
  if (!Array.isArray(rungs) || rungs.length === 0 || rungs.length > LADDER_CHANNELS.length) throw invalid('rungs');
  const parsed: LadderRung[] = rungs.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw invalid(`rungs[${index}]`);
    const { channel, wait_minutes: wait } = entry as Record<string, unknown>;
    if (typeof channel !== 'string' || !(LADDER_CHANNELS as readonly string[]).includes(channel)) throw invalid(`rungs[${index}].channel`);
    if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > 4320) throw invalid(`rungs[${index}].wait_minutes`);
    return { channel: channel as LadderChannel, wait_minutes: wait };
  });
  if (parsed[0]?.channel !== 'IN_APP') throw invalid('rungs[0].channel');
  if (new Set(parsed.map((rung) => rung.channel)).size !== parsed.length) throw invalid('rungs');
  const stopWhen = record.stop_when;
  if (stopWhen !== 'DELIVERED' && stopWhen !== 'SEEN') throw invalid('stop_when');
  const handOff = record.hand_off;
  if (handOff !== 'ESCALATE' && handOff !== 'NONE') throw invalid('hand_off');
  const after = record.hand_off_after_minutes;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0 || after > 4320) throw invalid('hand_off_after_minutes');
  const expires = record.expires_after_minutes;
  if (typeof expires !== 'number' || !Number.isInteger(expires) || expires < 1 || expires > 43_200) throw invalid('expires_after_minutes');
  return { rungs: parsed, stop_when: stopWhen, hand_off: handOff, hand_off_after_minutes: after, expires_after_minutes: expires };
}

// -- receipts -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What is known of one rung: waiting to be sent, sent, reached the device, opened by the person, failed, or not sent for a reason. */
export type RungState = 'QUEUED' | 'SENT' | 'DELIVERED' | 'SEEN' | 'FAILED' | 'SUPPRESSED';
export const RUNG_STATES: readonly RungState[] = ['QUEUED', 'SENT', 'DELIVERED', 'SEEN', 'FAILED', 'SUPPRESSED'];

/** Why a rung was not sent. `NO_WORKFLOW`: the tenant has no published notification workflow for the event of this rung, so nothing could carry it. */
export const SUPPRESSION_REASONS = ['NO_CONSENT', 'QUIET_HOURS', 'DAILY_CAP', 'NO_CONTACT', 'NO_WORKFLOW', 'PROFILE'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface ReceiptEvidence {
  /** The notification of the rung exists (an event of the rung reached a workflow). */
  notificationExists: boolean;
  /** The person opened the notification in the application. */
  readAt: string | null;
  /** The statuses of the sends of the rung (`delivery_attempt.status`). */
  attemptStatuses: readonly string[];
  /** The notification was suppressed or closed by the engine, with its reason (consent, quiet hours). */
  suppressionReason: string | null;
}

const RANK: Readonly<Record<RungState, number>> = { QUEUED: 0, SUPPRESSED: 1, FAILED: 1, SENT: 2, DELIVERED: 3, SEEN: 4 };

/**
 * Whether a rung may move from one state to another: forward only (a seen rung is never shown as merely sent), except that a rung that is only sent, or queued, may still turn out to have failed or been suppressed
 * (the sends of the engine failed after the notification was first seen), and a failure or a verdict of "no workflow" may still be lifted by a later delivery.
 */
export function rungMayMove(from: RungState, fromReason: string | null, to: RungState): boolean {
  if (from === to) return false;
  if (from === 'QUEUED') return true;
  if (from === 'SENT') return to !== 'QUEUED';
  if (from === 'SUPPRESSED') return fromReason === 'NO_WORKFLOW' && to !== 'QUEUED';
  return RANK[to] > RANK[from];
}

/** The best state any evidence supports: a read beats a delivery beats a send; failure and suppression only count when nothing better happened (a message that arrived late wins over a failure that was reported late). */
export function receiptStateOf(evidence: ReceiptEvidence): RungState {
  if (!evidence.notificationExists) return 'QUEUED';
  let state: RungState = 'SENT';
  const consider = (candidate: RungState): void => {
    if (RANK[candidate] > RANK[state] || (state === 'SENT' && RANK[candidate] === 1)) state = candidate;
  };
  if (evidence.readAt !== null) consider('SEEN');
  for (const status of evidence.attemptStatuses) {
    if (status === 'Read') consider('SEEN');
    else if (status === 'Delivered') consider('DELIVERED');
  }
  if (state === 'SENT') {
    if (evidence.suppressionReason !== null) return 'SUPPRESSED';
    const statuses = evidence.attemptStatuses;
    if (statuses.length > 0 && statuses.every((status) => status === 'Failed' || status === 'Cancelled')) return 'FAILED';
    if (statuses.length > 0 && statuses.every((status) => status === 'Suppressed')) return 'SUPPRESSED';
  }
  return state;
}

export interface RungRecord {
  index: number;
  channel: LadderChannel;
  state: RungState;
  /** When the rung was sent (an ISO instant), null while it is not. */
  sentAt: string | null;
}

export type LadderMove =
  | { kind: 'SEND_RUNG'; index: number }
  | { kind: 'WAIT'; until: string }
  | { kind: 'ESCALATE' }
  | { kind: 'DONE'; by: 'RECEIPT' | 'ACTED' | 'CLEARED' }
  | { kind: 'EXHAUSTED' }
  | { kind: 'EXPIRED' };

export interface LadderInput {
  policy: LadderPolicy;
  rungs: readonly RungRecord[];
  now: Date;
  /** When the ladder started (an ISO instant). */
  startedAt: string;
  /** Somebody claimed, was given or took up the item: a person is on it, the ladder has done its job. */
  acted: boolean;
  /** The item is not produced any more: the condition cleared. */
  cleared: boolean;
  /** The hand-off to the escalation already happened. */
  escalated: boolean;
}

const MINUTE = 60_000;

/**
 * What to do next with the ladder of one alert for one person. The order of the questions is the order of precedence: the condition cleared; a person is on it; a receipt that satisfies the policy exists; the ladder ran
 * out of time; then the rungs: a rung that failed or was suppressed gives way at once to the next (a channel that cannot carry the message is not waited for), a rung that was sent is waited for by its `wait_minutes`,
 * and after the last rung the hand-off waits `hand_off_after_minutes` and then goes to the escalation, or the ladder ends exhausted.
 */
export function nextLadderMove(input: LadderInput): LadderMove {
  const { policy, rungs, now } = input;
  if (input.cleared) return { kind: 'DONE', by: 'CLEARED' };
  if (input.acted) return { kind: 'DONE', by: 'ACTED' };
  const wanted: RungState[] = policy.stop_when === 'SEEN' ? ['SEEN'] : ['DELIVERED', 'SEEN'];
  if (rungs.some((rung) => wanted.includes(rung.state))) return { kind: 'DONE', by: 'RECEIPT' };
  if (input.escalated) return { kind: 'EXHAUSTED' };
  if (now.getTime() - Date.parse(input.startedAt) >= policy.expires_after_minutes * MINUTE) return { kind: 'EXPIRED' };
  const last = rungs[rungs.length - 1];
  if (last === undefined) return { kind: 'SEND_RUNG', index: 0 };
  const spec = policy.rungs[last.index];
  const gone = last.state === 'FAILED' || last.state === 'SUPPRESSED';
  const sentAt = last.sentAt === null ? now : new Date(last.sentAt);
  const nextIndex = last.index + 1;
  if (nextIndex < policy.rungs.length) {
    // A channel that cannot carry the message is not waited for; one that carried it is waited for by the wait of its rung.
    const readyAt = new Date(sentAt.getTime() + (spec?.wait_minutes ?? 0) * MINUTE);
    return gone || readyAt.getTime() <= now.getTime() ? { kind: 'SEND_RUNG', index: nextIndex } : { kind: 'WAIT', until: readyAt.toISOString() };
  }
  if (policy.hand_off === 'NONE') {
    const endAt = gone ? sentAt : new Date(sentAt.getTime() + (spec?.wait_minutes ?? 0) * MINUTE);
    return endAt.getTime() <= now.getTime() ? { kind: 'EXHAUSTED' } : { kind: 'WAIT', until: endAt.toISOString() };
  }
  const handOffAt = gone ? sentAt : new Date(sentAt.getTime() + policy.hand_off_after_minutes * MINUTE);
  return handOffAt.getTime() <= now.getTime() ? { kind: 'ESCALATE' } : { kind: 'WAIT', until: handOffAt.toISOString() };
}

// -- the message ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The words a message of the ladder is made of: a type, a severity and a link. No amount, no percentage, no name of a contractor. */
export interface LadderPayload {
  alertType: string;
  severity: LadderSeverity;
  deepLink: string;
}

const AMOUNT = /\d[\d.,\s]{3,}|\d\s?%|\b(vnd|usd|dong)\b|[\u20ab$]|\u0111\u1ed3ng|t\u1ef7|tri\u1ec7u|billion|million/i;

/** A text that carries no financial figure: no run of four or more digits (with separators), no percentage, no currency word or sign. */
export const carriesNoFinancialFigure = (text: string): boolean => !AMOUNT.test(text);

/** The payload of a rung checked: only the three members, the type and the link are plain words, and the link is a path inside the application (it needs a login), never a full address with data in its query. */
export function assertLadderPayload(payload: unknown): LadderPayload {
  if (typeof payload !== 'object' || payload === null) throw invalid('payload');
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!['alertType', 'severity', 'deepLink'].includes(key)) throw invalid(`payload.${key}`);
  const { alertType, severity, deepLink } = record;
  if (typeof alertType !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(alertType)) throw invalid('payload.alertType');
  if (typeof severity !== 'string' || !(LADDER_SEVERITIES as readonly string[]).includes(severity)) throw invalid('payload.severity');
  if (typeof deepLink !== 'string' || !/^\/[A-Za-z0-9/_-]{1,120}$/.test(deepLink) || !carriesNoFinancialFigure(deepLink.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ''))) throw invalid('payload.deepLink');
  return { alertType, severity: severity as LadderSeverity, deepLink };
}

/** The channels that need the consent of the person (the inbox does not). */
export const channelNeedsConsent = (channel: LadderChannel): boolean => channel !== 'IN_APP';

/** The notification channel of the engine a rung is carried by, as the workflow definition names it. */
export const ENGINE_CHANNEL: Readonly<Record<LadderChannel, string>> = { IN_APP: 'IN_APP', PUSH: 'PUSH_FCM', EMAIL: 'EMAIL', ZALO: 'ZALO_ZNS', SMS: 'SMS' };

/** The event type that carries a rung of a channel into the notification workflows of the tenant. */
export const ladderEventType = (channel: LadderChannel): string => `home.alert_ladder_${channel.toLowerCase()}.v1`;
