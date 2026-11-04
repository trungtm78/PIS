import { ApiError } from '@machvon/api-client';
import { daysBetween, isDay, isUuid } from '../model';
import type { PlanLine } from '../plan/model';
import { hasControlCharacter } from '../../control-characters';

/** LND-07: the payments of an approved plan to its households (ST-LND-007, LND 3.2, BR-LND-03). */
export const PAYMENTS_PATH = '/lnd/lnd-07';

/** The permission that gates the buttons of this screen; the server decides again on every request (the project and the units of the households included). */
export const WRITE_PERMISSION = 'land.payment.write';

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH_VOUCHER', 'TREASURY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'DEPOSITED', 'CANCELLED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TEXT_MAX_LENGTH = 2000;
export const ACCOUNT_MIN_LENGTH = 4;
export const ACCOUNT_MAX_LENGTH = 40;
const AMOUNT = /^[1-9]\d{0,23}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** A payment of a plan as the list answers it: the household by its code and the account only masked. */
export interface PaymentLine {
  id: string;
  householdId: string;
  householdCode: string;
  paymentNo: number;
  amountVnd: string;
  dueOn: string;
  paidOn: string | null;
  method: PaymentMethod | 'DEPOSITED' | null;
  bankAccountMasked: string | null;
  treasuryTransactionId: string | null;
  advanceId: string | null;
  voucherDocumentVersionId: string | null;
  depositReason: string | null;
  lateReason: string | null;
  status: PaymentStatus;
  version: number;
}

/** A payment the screen cannot read is dropped rather than shown half. */
export function toPaymentLine(raw: unknown): PaymentLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const householdId = text(row?.household_id);
  const householdCode = text(row?.household_code);
  const paymentNo = whole(row?.payment_no);
  const amount = text(row?.amount_vnd);
  const dueOn = text(row?.due_on);
  const status = oneOf(PAYMENT_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || householdId === undefined || householdCode === undefined || paymentNo === undefined || amount === undefined || dueOn === undefined || status === undefined || version === undefined) return undefined;
  const method = row.method === 'DEPOSITED' ? 'DEPOSITED' : (oneOf(PAYMENT_METHODS, row.method) ?? null);
  return {
    id,
    householdId,
    householdCode,
    paymentNo,
    amountVnd: amount,
    dueOn,
    paidOn: nullableText(row.paid_on),
    method,
    bankAccountMasked: nullableText(row.bank_account_masked),
    treasuryTransactionId: nullableText(row.treasury_transaction_id),
    advanceId: nullableText(row.advance_id),
    voucherDocumentVersionId: nullableText(row.voucher_document_version_id),
    depositReason: nullableText(row.deposit_reason),
    lateReason: nullableText(row.late_reason),
    status,
    version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

export const canPayWrite = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(WRITE_PERMISSION)) && mode !== 'READ_ONLY';

/** The plans a payment can be about: approved, being paid, or paid in full. */
export const PAYABLE_STATUSES: readonly PlanLine['status'][] = ['APPROVED', 'PAYING', 'COMPLETED'];
export const payablePlans = (plans: readonly PlanLine[]): PlanLine[] => plans.filter((plan) => PAYABLE_STATUSES.includes(plan.status));

/** Payments are scheduled on a plan that is approved or being paid. */
export const takesPayments = (plan: PlanLine): boolean => plan.status === 'APPROVED' || plan.status === 'PAYING';

/** A payment that waits is made or deposited. */
export const isOpen = (payment: PaymentLine): boolean => payment.status === 'PENDING';

/** Whether a payment made on `day` would be after the day it is due (the server counts again). */
export const isLateOn = (payment: PaymentLine, day: string): boolean => day > payment.dueOn;

/** The days left to the day a payment is due (negative once it has passed); 0 on the day. */
export const daysToDue = (payment: PaymentLine, today: string): number => daysBetween(today, payment.dueOn);

export interface PaymentTotals {
  scheduled: bigint;
  settled: bigint;
  pending: bigint;
}

/** What the payments the reader sees add up to: scheduled (all but cancelled), settled (paid or deposited) and still waiting. */
export function totalsOf(payments: readonly PaymentLine[]): PaymentTotals {
  const totals: PaymentTotals = { scheduled: 0n, settled: 0n, pending: 0n };
  for (const payment of payments) {
    if (payment.status === 'CANCELLED') continue;
    const amount = BigInt(payment.amountVnd);
    totals.scheduled += amount;
    if (payment.status === 'PENDING') totals.pending += amount;
    else totals.settled += amount;
  }
  return totals;
}

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'future' | 'early';

const wordsProblem = (value: string): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length > TEXT_MAX_LENGTH) return 'tooLong';
  return hasControlCharacter(words) ? 'invalid' : undefined;
};

export interface ScheduleForm {
  householdId: string;
  amountVnd: string;
  dueOn: string;
  bankAccount: string;
}

export const EMPTY_SCHEDULE_FORM: ScheduleForm = { householdId: '', amountVnd: '', dueOn: '', bankAccount: '' };

/** What is wrong with a payment before it is sent: a household, a whole amount above zero, a day if one is named, and an account in the form of one if one is given. */
export function validateSchedule(form: ScheduleForm, plan: PlanLine): Partial<Record<keyof ScheduleForm, FormProblem>> {
  const problems: Partial<Record<keyof ScheduleForm, FormProblem>> = {};
  if (form.householdId === '') problems.householdId = 'required';
  const amount = form.amountVnd.trim();
  if (amount === '') problems.amountVnd = 'required';
  else if (!AMOUNT.test(amount)) problems.amountVnd = 'invalid';
  const due = form.dueOn.trim();
  if (due !== '') {
    if (!isDay(due)) problems.dueOn = 'invalid';
    else if (plan.approvedOn !== null && due <= plan.approvedOn) problems.dueOn = 'early';
    else if (plan.paymentDueOn !== null && due > plan.paymentDueOn) problems.dueOn = 'future';
  }
  const account = form.bankAccount.trim();
  if (account !== '' && !ACCOUNT.test(account)) problems.bankAccount = account.length > ACCOUNT_MAX_LENGTH ? 'tooLong' : 'invalid';
  return problems;
}

export type ScheduleBody = {
  household_id: string;
  amount_vnd: string;
  due_on?: string;
  bank_account?: string;
};

export function scheduleBody(form: ScheduleForm): ScheduleBody {
  const body: ScheduleBody = { household_id: form.householdId, amount_vnd: form.amountVnd.trim() };
  if (form.dueOn.trim() !== '') body.due_on = form.dueOn.trim();
  if (form.bankAccount.trim() !== '') body.bank_account = form.bankAccount.trim();
  return body;
}

export interface ConfirmForm {
  paidOn: string;
  method: '' | PaymentMethod;
  voucherDocumentVersionId: string;
  treasuryTransactionId: string;
  advanceId: string;
  lateReason: string;
}

export const EMPTY_CONFIRM_FORM: ConfirmForm = { paidOn: '', method: '', voucherDocumentVersionId: '', treasuryTransactionId: '', advanceId: '', lateReason: '' };

const optionalId = (value: string): FormProblem | undefined => (value.trim() === '' || isUuid(value) ? undefined : 'invalid');

/** A payment is confirmed on a day that has come and is not before the plan was approved, by a method, with a voucher; one made after its day says why, and one on time does not. */
export function validateConfirm(form: ConfirmForm, payment: PaymentLine, plan: PlanLine, today: string): Partial<Record<keyof ConfirmForm, FormProblem>> {
  const problems: Partial<Record<keyof ConfirmForm, FormProblem>> = {};
  const day = form.paidOn.trim();
  if (day === '') problems.paidOn = 'required';
  else if (!isDay(day)) problems.paidOn = 'invalid';
  else if (day > today) problems.paidOn = 'future';
  else if (plan.approvedOn !== null && day < plan.approvedOn) problems.paidOn = 'early';
  if (form.method === '') problems.method = 'required';
  const voucher = form.voucherDocumentVersionId.trim();
  if (voucher === '') problems.voucherDocumentVersionId = 'required';
  else if (!isUuid(voucher)) problems.voucherDocumentVersionId = 'invalid';
  const treasury = optionalId(form.treasuryTransactionId);
  if (treasury !== undefined) problems.treasuryTransactionId = treasury;
  const advance = optionalId(form.advanceId);
  if (advance !== undefined) problems.advanceId = advance;
  if (day !== '' && isDay(day) && isLateOn(payment, day)) {
    const reason = wordsProblem(form.lateReason);
    if (reason !== undefined) problems.lateReason = reason;
  }
  return problems;
}

export interface ConfirmBody {
  paid_on: string;
  method: PaymentMethod;
  voucher_document_version_id: string;
  treasury_transaction_id?: string;
  advance_id?: string;
  late_reason?: string;
}

/** The body of a confirmation: the late reason goes only with a payment made after its day. */
export function confirmBody(form: ConfirmForm, payment: PaymentLine): ConfirmBody {
  const body: ConfirmBody = { paid_on: form.paidOn.trim(), method: form.method as PaymentMethod, voucher_document_version_id: form.voucherDocumentVersionId.trim().toLowerCase() };
  if (form.treasuryTransactionId.trim() !== '') body.treasury_transaction_id = form.treasuryTransactionId.trim().toLowerCase();
  if (form.advanceId.trim() !== '') body.advance_id = form.advanceId.trim().toLowerCase();
  if (isLateOn(payment, body.paid_on)) body.late_reason = form.lateReason.trim();
  return body;
}

export interface DepositForm {
  paidOn: string;
  depositReason: string;
  voucherDocumentVersionId: string;
}

export const EMPTY_DEPOSIT_FORM: DepositForm = { paidOn: '', depositReason: '', voucherDocumentVersionId: '' };

export function validateDeposit(form: DepositForm, plan: PlanLine, today: string): Partial<Record<keyof DepositForm, FormProblem>> {
  const problems: Partial<Record<keyof DepositForm, FormProblem>> = {};
  const day = form.paidOn.trim();
  if (day === '') problems.paidOn = 'required';
  else if (!isDay(day)) problems.paidOn = 'invalid';
  else if (day > today) problems.paidOn = 'future';
  else if (plan.approvedOn !== null && day < plan.approvedOn) problems.paidOn = 'early';
  const reason = wordsProblem(form.depositReason);
  if (reason !== undefined) problems.depositReason = reason;
  const voucher = form.voucherDocumentVersionId.trim();
  if (voucher === '') problems.voucherDocumentVersionId = 'required';
  else if (!isUuid(voucher)) problems.voucherDocumentVersionId = 'invalid';
  return problems;
}

export const depositBody = (form: DepositForm): { paid_on: string; deposit_reason: string; voucher_document_version_id: string } => ({
  paid_on: form.paidOn.trim(),
  deposit_reason: form.depositReason.trim(),
  voucher_document_version_id: form.voucherDocumentVersionId.trim().toLowerCase(),
});

export type CommandProblem =
  | 'exceedsHousehold'
  | 'exceedsPlan'
  | 'planState'
  | 'paymentState'
  | 'lateReason'
  | 'advanceExceeded'
  | 'advanceState'
  | 'documentNotClean'
  | 'ruleUnconfirmed'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  PLAN_STATE_INVALID: 'planState',
  PAYMENT_STATE_INVALID: 'paymentState',
  PAYMENT_LATE_REASON_REQUIRED: 'lateReason',
  ADVANCE_RECOVERY_EXCEEDED: 'advanceExceeded',
  ADVANCE_STATE_INVALID: 'advanceState',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  TIMER_RULE_UNCONFIRMED: 'ruleUnconfirmed',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

/** Maps the error of a command to what a dialog shows; a payment over what the plan holds for the household says so, and an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  if (!(error instanceof ApiError)) return 'general';
  if (error.code === 'PAYMENT_EXCEEDS_PLAN') return error.extensions?.scope === 'HOUSEHOLD' ? 'exceedsHousehold' : 'exceedsPlan';
  return PROBLEM_BY_CODE[error.code] ?? 'general';
}
