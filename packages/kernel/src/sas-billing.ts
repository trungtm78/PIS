import { addDays } from './billing-period.ts';

/**
 * The money rules of the billing run and of the e-invoice (ST-SAS-011, SAS.md BR-SAS-13, BR-SAS-14 and 3.7): whole VND, the VAT of each line rounded half up, the totals as
 * the sums of the lines, the lines of overage of a metered feature, the schedule on which a provider that does not answer is asked again, and when an invoice is overdue.
 * Amounts are text of whole VND (they can be negative on an adjustment line) and are computed in integers: nothing here touches a floating point number.
 */

export const VAT_CATEGORIES = ['NOT_SUBJECT', 'VAT_0', 'VAT_5', 'VAT_8', 'VAT_10'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

export const INVOICE_LINE_KINDS = ['SUBSCRIPTION', 'USAGE', 'ADJUSTMENT', 'DISCOUNT'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

/** The rate of each category in basis points (a hundredth of a percent); software services are NOT_SUBJECT unless the plan says otherwise (CXN-INV-01). */
const RATE_BASIS_POINTS: Readonly<Record<VatCategory, bigint>> = { NOT_SUBJECT: 0n, VAT_0: 0n, VAT_5: 500n, VAT_8: 800n, VAT_10: 1000n };

const WHOLE_VND = /^-?[0-9]{1,24}$/;
const DECIMAL = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;

export function isVatCategory(value: string): value is VatCategory {
  return (VAT_CATEGORIES as readonly string[]).includes(value);
}

function wholeVnd(value: string): bigint {
  if (!WHOLE_VND.test(value)) throw new RangeError(`not an amount of whole VND: ${value}`);
  return BigInt(value);
}

/**
 * The VAT of one line, rounded half up to whole VND (BR-SAS-14). A line that takes money off (negative) gets the VAT of its own size with the opposite sign, so that a
 * reduction undoes exactly the VAT that the line it corrects was charged.
 */
export function vatOf(amountVnd: string, category: VatCategory): string {
  const amount = wholeVnd(amountVnd);
  const size = amount < 0n ? -amount : amount;
  const vat = (size * RATE_BASIS_POINTS[category] + 5000n) / 10000n;
  return (amount < 0n ? -vat : vat).toString();
}

export interface InvoiceLineDraft {
  kind: InvoiceLineKind;
  description: string;
  /** Whole VND, negative for a line that takes money off. */
  amountVnd: string;
  vatCategory: VatCategory;
  /** Of a USAGE line: the meter, the quantity beyond the limit and the price of one unit. */
  meter?: string;
  quantity?: string;
  unitPriceVnd?: string;
}

export interface PricedInvoiceLine extends InvoiceLineDraft {
  vatVnd: string;
}

export interface InvoiceTotals {
  subtotalVnd: string;
  vatVnd: string;
  totalVnd: string;
}

export function priceLine(line: InvoiceLineDraft): PricedInvoiceLine {
  return { ...line, vatVnd: vatOf(line.amountVnd, line.vatCategory) };
}

/** `subtotal = sum of the amounts`, `vat = sum of the VAT of the lines`, `total = subtotal + vat`: the equation the table checks. */
export function invoiceTotals(lines: readonly PricedInvoiceLine[]): InvoiceTotals {
  let subtotal = 0n;
  let vat = 0n;
  for (const line of lines) {
    subtotal += wholeVnd(line.amountVnd);
    vat += wholeVnd(line.vatVnd);
  }
  return { subtotalVnd: subtotal.toString(), vatVnd: vat.toString(), totalVnd: (subtotal + vat).toString() };
}

const MICRO = 1_000_000n;

function micros(value: string): bigint {
  if (!DECIMAL.test(value)) throw new RangeError(`not a quantity: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole as string) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

const quantityText = (value: bigint): string => {
  const [whole, fraction] = [value / MICRO, (value % MICRO).toString().padStart(6, '0').replace(/0+$/, '')];
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
};

export interface MeteredFeature {
  featureCode: string;
  meter: string;
  /** The quantity the plan includes. */
  limit: string;
  /** The price of one unit beyond the limit, whole VND; a feature without one is never billed beyond its limit. */
  overagePriceVnd: string | null;
}

/**
 * The line for the use of a meter beyond what the plan includes (BR-SAS-13): `(used - limit) x price`, rounded half up to whole VND; nothing when the use is within the
 * limit, when the feature has no overage price, or when the amount rounds to nothing.
 */
export function usageLine(feature: MeteredFeature, used: string, vatCategory: VatCategory): InvoiceLineDraft | undefined {
  if (feature.overagePriceVnd === null) return undefined;
  const over = micros(used) - micros(feature.limit);
  if (over <= 0n) return undefined;
  const amount = (over * wholeVnd(feature.overagePriceVnd) + MICRO / 2n) / MICRO;
  if (amount === 0n) return undefined;
  return { kind: 'USAGE', description: `${feature.featureCode}: ${quantityText(over)} ${feature.meter} beyond the ${feature.limit} included`, amountVnd: amount.toString(), vatCategory, meter: feature.meter, quantity: quantityText(over), unitPriceVnd: feature.overagePriceVnd };
}

/**
 * The code of the original invoice of a subscription for a period: the same inputs always give the same code, so that a second run finds the first invoice. The invoice that takes the place of a
 * discarded draft of the same period is the second revision and has its own code (`-2`): a code is never used twice.
 */
export function invoiceCodeOf(subscriptionId: string, periodStart: string, revision = 1): string {
  const base = `INV-${periodStart.replaceAll('-', '')}-${subscriptionId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  return revision <= 1 ? base : `${base}-${revision}`;
}

/**
 * The part of the price of a period for the days that are billed: `amount x paid / total`, whole VND rounded down (the rule of the proration of BR-SAS-08), for a period whose first days were a trial.
 * All the days is the whole price.
 */
export function priceForDays(amountVnd: string, paidDays: number, totalDays: number): string {
  if (!Number.isInteger(paidDays) || !Number.isInteger(totalDays) || totalDays < 1 || paidDays < 0 || paidDays > totalDays) throw new RangeError('not a share of a period');
  return ((wholeVnd(amountVnd) * BigInt(paidDays)) / BigInt(totalDays)).toString();
}

/** The longest a provider that does not answer is asked, and how many times (SAS.md 3.7: five attempts in 24 hours, then IssueFailed). */
export const ISSUE_MAX_ATTEMPTS = 5;
export const ISSUE_WINDOW_MS = 24 * 3_600_000;
/** The wait after the first, second, third and fourth failed attempt. */
const ISSUE_BACKOFF_MS: readonly number[] = [10 * 60_000, 60 * 60_000, 4 * 3_600_000, 12 * 3_600_000];

/**
 * When the provider is asked again after `attempts` attempts that failed, the first of which was at `firstAttemptAt`; null when the attempts are used up or the next one
 * would fall outside the 24 hours, which is when the invoice becomes IssueFailed.
 */
export function nextIssueAttempt(attempts: number, firstAttemptAt: Date, failedAt: Date): Date | null {
  if (attempts < 1 || attempts >= ISSUE_MAX_ATTEMPTS) return null;
  const next = new Date(failedAt.getTime() + (ISSUE_BACKOFF_MS[attempts - 1] as number));
  return next.getTime() - firstAttemptAt.getTime() > ISSUE_WINDOW_MS ? null : next;
}

/** An invoice is overdue the day after its due day. */
export function isInvoiceOverdue(dueAt: string, today: string): boolean {
  return today > dueAt;
}

/** After this many days past due the control plane is told that a suspension could be proposed; only a System Admin decides it (BR-SAS-04). */
export const SUSPENSION_PROPOSAL_DAYS = 30;

export function suspensionProposed(pastDueSince: Date, now: Date): boolean {
  return now.getTime() - pastDueSince.getTime() >= SUSPENSION_PROPOSAL_DAYS * 86_400_000;
}

/** What a run of the billing may ask for: a period that has begun (not one still ahead) and no longer than a year; the days are `YYYY-MM-DD`, so text compares as dates do. */
export function isBillingPeriod(period: { start: string; end: string }, today: string): boolean {
  try {
    // addDays refuses a text that is not a calendar day (31 February), which Date.parse would roll into March.
    const [start, end] = [addDays(period.start, 0), addDays(period.end, 0)];
    return start <= end && start <= today && addDays(start, 365) >= end;
  } catch {
    return false;
  }
}
