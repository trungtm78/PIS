import { DomainError } from './errors.ts';

/**
 * The cap and the budget of a channel account (ST-NOT-010, NOT 3.1 step 6, BR-NOT-13, BR-NOT-14). A channel that costs money has a daily cap on the messages sent and a monthly budget in VND; a message that would go over
 * waits for the next day or the next month, unless it is CRITICAL, which is never held back by money. The delivery rate is measured the way BR-NOT-14 says. The rules below are pure.
 */
export const VN_OFFSET_MS = 7 * 3_600_000;
export const MAX_DAILY_CAP = 10_000_000;

/**
 * The estimated price of one message, in VND, by channel [assumption until the price lists of the providers are in the SAS plan, D06]: the channels that cost nothing are priced 0, so a budget never holds them.
 */
export const CHANNEL_UNIT_COST_VND: Readonly<Record<string, number>> = {
  EMAIL: 0,
  SMS: 800,
  PUSH_FCM: 0,
  PUSH_APNS: 0,
  ZALO_OA: 0,
  ZALO_ZNS: 300,
  WHATSAPP: 1_000,
};

/** The usage meter a send is counted under in SAS (BR-SAS-15), for the channels that have one (the meters of the catalogue are e-mail, SMS and Zalo ZNS). */
const METERS: Readonly<Record<string, string>> = { EMAIL: 'notification.email', SMS: 'notification.sms', ZALO_ZNS: 'notification.zns' };
export const meterOfChannel = (channel: string): string | undefined => METERS[channel];

/** A channel costs money when its messages are priced above zero. */
export const isPaidChannel = (channel: string): boolean => (CHANNEL_UNIT_COST_VND[channel] ?? 0) > 0;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface ChannelLimits {
  dailySendCap?: number | null;
  monthlyBudgetVnd?: string | null;
}

/** What a change of limits may carry: a daily cap of 1 to ten million, a budget of 0 or more VND as a whole number written in decimal, `null` to take a limit off; at least one of them. */
export function assertLimits(raw: { daily_send_cap?: unknown; monthly_budget_vnd?: unknown; clear_daily_send_cap?: unknown; clear_monthly_budget?: unknown }): ChannelLimits {
  const limits: ChannelLimits = {};
  // A limit is taken off with its own flag (a generated client cannot write null); a value and the flag for the same limit contradict each other.
  if (raw.clear_daily_send_cap === true) {
    if (raw.daily_send_cap !== undefined && raw.daily_send_cap !== null) throw invalid('clear_daily_send_cap');
    limits.dailySendCap = null;
  }
  if (raw.clear_monthly_budget === true) {
    if (raw.monthly_budget_vnd !== undefined && raw.monthly_budget_vnd !== null) throw invalid('clear_monthly_budget');
    limits.monthlyBudgetVnd = null;
  }
  if (raw.daily_send_cap !== undefined && raw.clear_daily_send_cap !== true) {
    if (raw.daily_send_cap === null) limits.dailySendCap = null;
    else if (typeof raw.daily_send_cap === 'number' && Number.isInteger(raw.daily_send_cap) && raw.daily_send_cap >= 1 && raw.daily_send_cap <= MAX_DAILY_CAP) limits.dailySendCap = raw.daily_send_cap;
    else throw invalid('daily_send_cap');
  }
  if (raw.monthly_budget_vnd !== undefined && raw.clear_monthly_budget !== true) {
    if (raw.monthly_budget_vnd === null) limits.monthlyBudgetVnd = null;
    else if (typeof raw.monthly_budget_vnd === 'string' && /^[0-9]{1,15}$/.test(raw.monthly_budget_vnd)) limits.monthlyBudgetVnd = BigInt(raw.monthly_budget_vnd).toString();
    else throw invalid('monthly_budget_vnd');
  }
  if (Object.keys(limits).length === 0) throw invalid('daily_send_cap');
  return limits;
}

/** The start of the day of the instant in Vietnam (UTC+7, no summer time), and of the next day. */
export function dayStartVn(now: Date): Date {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - VN_OFFSET_MS);
}
export const nextDayStartVn = (now: Date): Date => new Date(dayStartVn(now).getTime() + 86_400_000);
/** The start of the month of the instant in Vietnam, and of the next month. */
export function monthStartVn(now: Date): Date {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - VN_OFFSET_MS);
}
export function nextMonthStartVn(now: Date): Date {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - VN_OFFSET_MS);
}

export interface LimitUse {
  /** Messages the account has sent today, and its spending this month in VND. */
  sentToday: number;
  spentThisMonthVnd: bigint;
}

export type LimitVerdict = { kind: 'WITHIN' } | { kind: 'HOLD'; until: Date; code: 'CHANNEL_CAP' | 'CHANNEL_BUDGET' };

/**
 * Whether one more message may go now (BR-NOT-13). A CRITICAL message is never held back by money. Any other message that would take the account over its daily cap waits for the next day, and one that would take it over its
 * monthly budget (the price of the message added to what was spent) waits for the next month. A channel that costs nothing is held by the cap only.
 */
export function judgeLimits(input: { limits: { dailySendCap: number | null; monthlyBudgetVnd: bigint | null }; use: LimitUse; channel: string; priority: string; now: Date }): LimitVerdict {
  if (input.priority === 'CRITICAL') return { kind: 'WITHIN' };
  const { limits, use } = input;
  if (limits.dailySendCap !== null && use.sentToday + 1 > limits.dailySendCap) return { kind: 'HOLD', until: nextDayStartVn(input.now), code: 'CHANNEL_CAP' };
  const cost = BigInt(CHANNEL_UNIT_COST_VND[input.channel] ?? 0);
  if (limits.monthlyBudgetVnd !== null && cost > 0n && use.spentThisMonthVnd + cost > limits.monthlyBudgetVnd) return { kind: 'HOLD', until: nextMonthStartVn(input.now), code: 'CHANNEL_BUDGET' };
  return { kind: 'WITHIN' };
}

export interface DeliveryCounts {
  delivered: number;
  read: number;
  /** Attempts that ended in the period, whatever their end, and those of them that were suppressed (never sent). */
  ended: number;
  suppressed: number;
  unknown: number;
}

/**
 * BR-NOT-14: `delivered_rate = |{Delivered, Read}| / (|attempts that ended in the period| - |Suppressed|)`; Unknown stays in the denominator and is shown on its own. 100 attempts with 5 suppressed and 11 unknown and 80
 * delivered give 80 / 95 = 84.21 %. A period with nothing sent has no rate (undefined), not 0.
 */
export function deliveredRate(counts: DeliveryCounts): { rate: number | undefined; denominator: number; unknown: number } {
  const denominator = counts.ended - counts.suppressed;
  if (denominator <= 0) return { rate: undefined, denominator: 0, unknown: counts.unknown };
  const rate = Math.round(((counts.delivered + counts.read) / denominator) * 10_000) / 100;
  return { rate, denominator, unknown: counts.unknown };
}
