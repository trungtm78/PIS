import { ApiError } from '@machvon/api-client';
import { groupDigits } from '../llm-model';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

export const RECONCILIATION_STATUSES = ['VARIANCE', 'RECONCILED'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];
export const PAGE_SIZE = 50;

// --- the money ---------------------------------------------------------------------------------------------------------------------------------

/**
 * An amount as the server sent it (a decimal string with up to eight places), with its thousands grouped and the zeros at the end of the fraction left out. Nothing passes through a floating point number,
 * and a minus sign stays: it says the invoice is lower than the attempts. What is not a decimal is shown as it came.
 */
export function money(value: string): string {
  const read = DECIMAL.exec(value);
  if (read === null) return value;
  const [, sign, digits, rawFraction] = read as RegExpExecArray & [string, string, string, string | undefined];
  const fraction = (rawFraction ?? '').replace(/0+$/, '');
  const whole = groupDigits(digits);
  const negative = sign === '-' && (whole !== '0' || fraction !== '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

export type VarianceDirection = 'none' | 'higher' | 'lower';

/** Which way the invoice differs from the attempts: negative means the invoice is lower than the attempts, positive that it is higher. */
export function direction(variance: string): VarianceDirection {
  const shown = money(variance);
  if (shown === '0') return 'none';
  return shown.startsWith('-') ? 'lower' : 'higher';
}

// --- the reconciliations -----------------------------------------------------------------------------------------------------------------------

export interface Reconciliation {
  id: string;
  providerCode: string;
  invoiceRef: string;
  invoiceAmount: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
  attemptsTotal: string;
  variance: string;
  tolerancePct: string;
  attemptCount: number;
  /** The attempts that still wait for their usage: the invoice cannot be set against them yet. */
  pendingAttemptIds: string[];
  reconciledCount: number;
  reservationsSettled: number;
  status: ReconciliationStatus;
  ownerId: string | null;
  runCount: number;
  lastRunAt: string | null;
  version: number;
}

const decimal = (value: unknown): string | null => (typeof value === 'string' && DECIMAL.test(value) ? value : null);
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

export function toReconciliation(raw: unknown): Reconciliation | undefined {
  if (!isRecord(raw)) return undefined;
  const status = RECONCILIATION_STATUSES.find((candidate) => candidate === raw.status);
  const invoiceAmount = decimal(raw.invoice_amount);
  const attemptsTotal = decimal(raw.attempts_total);
  const variance = decimal(raw.variance);
  if (
    status === undefined ||
    invoiceAmount === null ||
    attemptsTotal === null ||
    variance === null ||
    typeof raw.id !== 'string' ||
    typeof raw.provider_code !== 'string' ||
    typeof raw.invoice_ref !== 'string' ||
    typeof raw.currency !== 'string'
  )
    return undefined;
  return {
    id: raw.id,
    providerCode: raw.provider_code,
    invoiceRef: raw.invoice_ref,
    invoiceAmount,
    currency: raw.currency,
    periodFrom: text(raw.period_from) ?? '',
    periodTo: text(raw.period_to) ?? '',
    attemptsTotal,
    variance,
    tolerancePct: decimal(raw.tolerance_pct) ?? '0',
    attemptCount: count(raw.attempt_count),
    pendingAttemptIds: ids(raw.pending_attempt_ids),
    reconciledCount: ids(raw.reconciled_attempt_ids).length,
    reservationsSettled: count(raw.reservations_settled),
    status,
    ownerId: text(raw.owner_id),
    runCount: count(raw.run_count),
    lastRunAt: text(raw.last_run_at),
    version: count(raw.version),
  };
}

export interface ReconciliationPage {
  items: Reconciliation[];
  next: string | undefined;
}

export function toReconciliationPage(raw: unknown): ReconciliationPage {
  const body = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(body.items) ? body.items.flatMap((entry) => toReconciliation(entry) ?? []) : [],
    next: text(body.next_cursor) ?? undefined,
  };
}

// --- the run -----------------------------------------------------------------------------------------------------------------------------------

export interface RunForm {
  invoiceRef: string;
  invoiceAmount: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
}

export type RunField = keyof RunForm;
export type FormProblem = 'required' | 'invalid';
export const EMPTY_RUN: RunForm = {
  invoiceRef: '',
  invoiceAmount: '',
  currency: 'VND',
  periodFrom: '',
  periodTo: '',
};

const isDay = (value: string): boolean => {
  const moment = Date.parse(`${value}T00:00:00Z`);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(moment) && new Date(moment).toISOString().slice(0, 10) === value;
};

export function validateRun(form: RunForm): Partial<Record<RunField, FormProblem>> {
  const problems: Partial<Record<RunField, FormProblem>> = {};
  const ref = form.invoiceRef.trim();
  if (ref === '') problems.invoiceRef = 'required';
  else if (ref.length > 120) problems.invoiceRef = 'invalid';
  const amount = form.invoiceAmount.trim();
  if (amount === '') problems.invoiceAmount = 'required';
  else if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(amount)) problems.invoiceAmount = 'invalid';
  const currency = form.currency.trim();
  if (currency === '') problems.currency = 'required';
  else if (!/^[A-Za-z]{3}$/.test(currency)) problems.currency = 'invalid';
  if (form.periodFrom === '') problems.periodFrom = 'required';
  else if (!isDay(form.periodFrom)) problems.periodFrom = 'invalid';
  if (form.periodTo === '') problems.periodTo = 'required';
  else if (!isDay(form.periodTo) || (problems.periodFrom === undefined && form.periodTo < form.periodFrom)) problems.periodTo = 'invalid';
  return problems;
}

export function runBody(form: RunForm): Record<string, unknown> {
  return {
    invoice_ref: form.invoiceRef.trim(),
    invoice_amount: form.invoiceAmount.trim(),
    currency: form.currency.trim().toUpperCase(),
    period_from: form.periodFrom,
    period_to: form.periodTo,
  };
}

export interface RunResult {
  status: ReconciliationStatus;
  variance: string;
  attemptsTotal: string;
  pendingCount: number;
  reservationsSettled: number;
}

/** What the run answered: the figures of the report. An answer without them is not shown as if it had said nothing was wrong. */
export function toRunResult(raw: unknown): RunResult | undefined {
  if (!isRecord(raw)) return undefined;
  const status = RECONCILIATION_STATUSES.find((candidate) => candidate === raw.status);
  const variance = decimal(raw.variance);
  const attemptsTotal = decimal(raw.attempts_total);
  if (status === undefined || variance === null || attemptsTotal === null) return undefined;
  return {
    status,
    variance,
    attemptsTotal,
    pendingCount: ids(raw.pending_attempt_ids).length,
    reservationsSettled: count(raw.reservations_settled),
  };
}

// --- refusals ----------------------------------------------------------------------------------------------------------------------------------

export type RunReason = 'periodOpen' | 'currency' | 'duplicate' | 'scope' | 'validation' | 'general';

const REASON_BY_CODE: Readonly<Record<string, RunReason>> = {
  RECONCILE_PERIOD_OPEN: 'periodOpen',
  CURRENCY_MISMATCH: 'currency',
  DUPLICATE_KEY: 'duplicate',
  SCOPE_DENIED: 'scope',
  PERMISSION_DENIED: 'scope',
  VALIDATION_FAILED: 'validation',
};

export interface RunProblem {
  reason: RunReason;
  detail: string;
}

export function describeProblem(error: unknown): RunProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    detail: error.detail ?? '',
  };
}
