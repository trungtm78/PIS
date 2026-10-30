import { ApiError } from '@machvon/api-client';

/** Permissions of the screens (x-permission in openapi.json). */
export const READ_PERMISSION = 'delivery_attempt.read';
export const MANAGE_PERMISSION = 'notification.channel.manage';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const MAX_DAILY_CAP = 10_000_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface ChannelRow {
  channel: string;
  delivered: number;
  read: number;
  ended: number;
  suppressed: number;
  unknown: number;
  failed: number;
  denominator: number;
  /** In percent, two decimals; undefined when nothing was sent in the period (there is no rate to show, not 0). */
  rate: number | undefined;
}

export interface AccountUse {
  id: string;
  channel: string;
  displayName: string;
  status: string;
  dailySendCap: number | undefined;
  sentToday: number;
  monthlyBudgetVnd: string | undefined;
  spentMonthVnd: string;
  heldByLimit: number;
  version: number;
}

export interface Overview {
  from: string;
  to: string;
  asOf: string;
  channels: ChannelRow[];
  accounts: AccountUse[];
}

export function toOverview(raw: unknown): Overview {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    from: text(view.from),
    to: text(view.to),
    asOf: text(view.as_of),
    channels: Array.isArray(view.channels)
      ? view.channels.filter(isRecord).map((row) => ({
          channel: text(row.channel),
          delivered: count(row.delivered),
          read: count(row.read),
          ended: count(row.ended),
          suppressed: count(row.suppressed),
          unknown: count(row.unknown),
          failed: count(row.failed),
          denominator: count(row.denominator),
          rate: typeof row.delivered_rate === 'number' ? row.delivered_rate : undefined,
        }))
      : [],
    accounts: Array.isArray(view.accounts)
      ? view.accounts.filter(isRecord).map((row) => ({
          id: text(row.channel_account_id),
          channel: text(row.channel),
          displayName: text(row.display_name),
          status: text(row.status),
          dailySendCap: typeof row.daily_send_cap === 'number' ? row.daily_send_cap : undefined,
          sentToday: count(row.sent_today),
          monthlyBudgetVnd: optional(row.monthly_budget_vnd),
          spentMonthVnd: text(row.spent_month_vnd) || '0',
          heldByLimit: count(row.held_by_limit),
          version: count(row.version),
        }))
      : [],
  };
}

/** The share of a limit that is used, in percent (0 to 100, more is shown as 100): undefined when there is no limit, or the limit is 0. */
export function utilisation(used: number | bigint | string, limit: number | bigint | string | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const cap = BigInt(limit);
  if (cap <= 0n) return undefined;
  const share = Number((BigInt(used) * 10_000n) / cap) / 100;
  return Math.min(100, share);
}

export const isSpentUp = (account: Pick<AccountUse, 'monthlyBudgetVnd' | 'spentMonthVnd'>): boolean => account.monthlyBudgetVnd !== undefined && BigInt(account.spentMonthVnd) >= BigInt(account.monthlyBudgetVnd);

// ---- the period -----------------------------------------------------------------------------------------------------------------------

export const PERIODS = ['day', 'week', 'month'] as const;
export type Period = (typeof PERIODS)[number];
const SPAN_MS: Readonly<Record<Period, number>> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

export function periodRange(period: Period, now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - SPAN_MS[period]).toISOString(), to: now.toISOString() };
}

// ---- the form of the limits -----------------------------------------------------------------------------------------------------------

export interface LimitsForm {
  cap: string;
  budget: string;
  clearCap: boolean;
  clearBudget: boolean;
  reason: string;
}

export const formOf = (account: Pick<AccountUse, 'dailySendCap' | 'monthlyBudgetVnd'>): LimitsForm => ({
  cap: account.dailySendCap === undefined ? '' : String(account.dailySendCap),
  budget: account.monthlyBudgetVnd ?? '',
  clearCap: false,
  clearBudget: false,
  reason: '',
});

export type LimitsProblem = 'cap' | 'budget' | 'reason' | 'nothing';

/** What the server would refuse, judged the way it does, so that the supervisor is told before sending. */
export function limitsProblems(form: LimitsForm, account: Pick<AccountUse, 'dailySendCap' | 'monthlyBudgetVnd'>): LimitsProblem[] {
  const found: LimitsProblem[] = [];
  const cap = form.cap.trim();
  const budget = form.budget.trim();
  if (!form.clearCap && cap !== '' && !(/^[0-9]{1,8}$/.test(cap) && Number(cap) >= 1 && Number(cap) <= MAX_DAILY_CAP)) found.push('cap');
  if (!form.clearBudget && budget !== '' && !/^[0-9]{1,15}$/.test(budget)) found.push('budget');
  if (form.reason.trim().length < REASON_MIN || form.reason.trim().length > REASON_MAX) found.push('reason');
  if (found.length === 0 && Object.keys(limitsBody(form, account)).length === 0) found.push('nothing');
  return found;
}

/** Only what changed: a value that differs from the one in force, and the flag that takes a limit off. An empty field leaves the limit as it is. */
export function limitsBody(form: LimitsForm, account: Pick<AccountUse, 'dailySendCap' | 'monthlyBudgetVnd'>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const cap = form.cap.trim();
  const budget = form.budget.trim();
  if (form.clearCap) {
    if (account.dailySendCap !== undefined) body.clear_daily_send_cap = true;
  } else if (cap !== '' && Number(cap) !== account.dailySendCap) body.daily_send_cap = Number(cap);
  if (form.clearBudget) {
    if (account.monthlyBudgetVnd !== undefined) body.clear_monthly_budget = true;
  } else if (budget !== '' && BigInt(budget).toString() !== account.monthlyBudgetVnd) body.monthly_budget_vnd = BigInt(budget).toString();
  return body;
}

// ---- what the server refused with -----------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  CHANNEL_ACCOUNT_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
