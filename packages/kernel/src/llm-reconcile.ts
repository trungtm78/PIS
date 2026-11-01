import { DomainError } from './errors.ts';

/**
 * The reconciliation of the invoice of a provider against the attempts made through it (ST-LLM-008, LLM.md F3, BR-LLM-06, LLM-21, UAT-AC462). The sum of the attempts that cost something is set against the invoice; a
 * difference inside the tolerance (0.5 percent of the invoice, an assumption of the module) is RECONCILED, a difference outside it is a VARIANCE that has an owner and lists the attempts still waiting for their usage. No attempt
 * is edited to make the figures agree. Money is kept as whole units of 1e-8, as integers, so that no float touches a figure. Pure functions of their input.
 */
export const RECONCILE_TOLERANCE_PERCENT = '0.50';
/** A tolerance of 0.5 percent as a fraction: 5 in 1,000. */
const TOLERANCE_NUMERATOR = 5n;
const TOLERANCE_DENOMINATOR = 1000n;
const SCALE = 100_000_000n;
const MONEY = /^(-?)([0-9]{1,18})(?:\.([0-9]{1,8}))?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PERIOD_DAYS = 366;

/** An amount as units of 1e-8; 422 `VALIDATION_FAILED` naming the field when it is not an amount. */
export function toUnits(text: string, field: string): bigint {
  const match = MONEY.exec(text.trim());
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  const [, sign, whole, fraction] = match;
  const units = BigInt(whole as string) * SCALE + BigInt((fraction ?? '').padEnd(8, '0'));
  return sign === '-' ? -units : units;
}

/** Units of 1e-8 as the text of an amount with the figures it needs, up to eight places. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = (absolute / SCALE).toString();
  const fraction = (absolute % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

const dayNumber = (day: string, field: string): number => {
  const match = DAY.exec(day);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Math.floor(parsed.getTime() / 86_400_000);
};

export interface ReconcileRequest {
  invoiceRef: string;
  invoiceAmount: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
}

export interface CheckedReconcile {
  invoiceRef: string;
  invoiceAmount: bigint;
  currency: string;
  periodFrom: string;
  periodTo: string;
}

/**
 * The request as the body gives it: a reference, an amount that is not negative, a currency of three capitals, a period of at most a year. The period has to be over (409 `RECONCILE_PERIOD_OPEN`): attempts
 * of a month that is still running are not all there, and an invoice for it cannot be agreed with them.
 */
export function checkReconcile(input: ReconcileRequest, today: string): CheckedReconcile {
  const invoiceRef = input.invoiceRef.trim();
  if (invoiceRef === '' || invoiceRef.length > 120) throw new DomainError('VALIDATION_FAILED', 422, 'invoice_ref');
  const invoiceAmount = toUnits(input.invoiceAmount, 'invoice_amount');
  if (invoiceAmount < 0n) throw new DomainError('VALIDATION_FAILED', 422, 'invoice_amount');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new DomainError('VALIDATION_FAILED', 422, 'currency');
  const from = dayNumber(input.periodFrom, 'period_from');
  const to = dayNumber(input.periodTo, 'period_to');
  if (to < from || to - from + 1 > MAX_PERIOD_DAYS) throw new DomainError('VALIDATION_FAILED', 422, 'period_to');
  if (to >= dayNumber(today, 'today')) throw new DomainError('RECONCILE_PERIOD_OPEN', 409);
  return { invoiceRef, invoiceAmount, currency: input.currency, periodFrom: input.periodFrom, periodTo: input.periodTo };
}

/** The variance (the invoice less the attempts: positive when the provider charges more than the attempts show) and whether it is inside the tolerance. */
export function compare(invoice: bigint, attempts: bigint): { variance: bigint; withinTolerance: boolean } {
  const variance = invoice - attempts;
  const size = variance < 0n ? -variance : variance;
  return { variance, withinTolerance: size * TOLERANCE_DENOMINATOR <= invoice * TOLERANCE_NUMERATOR };
}

/** The provider an invoice is for: the one whose code is the invoice reference, or the longest code the reference begins with followed by a dash (`VN1-2026-11` is for `VN1`). */
export function providerOfInvoice(invoiceRef: string, codes: readonly string[]): string | undefined {
  const reference = invoiceRef.trim().toUpperCase();
  const matching = codes.filter((code) => reference === code.toUpperCase() || reference.startsWith(`${code.toUpperCase()}-`));
  return matching.sort((a, b) => b.length - a.length)[0];
}
