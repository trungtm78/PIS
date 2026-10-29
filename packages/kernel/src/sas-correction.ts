import { VAT_CATEGORIES, invoiceTotals, priceLine } from './sas-billing.ts';
import type { PricedInvoiceLine, VatCategory } from './sas-billing.ts';

/**
 * The correction of an issued invoice (ST-SAS-013, SAS.md 3.7 item 4, BR-SAS-14): an invoice that went out is never cancelled, edited or deleted; a mistake is corrected by an **adjustment** (lines that add to or
 * take from what was invoiced, a negative line for a reduction) or a **replacement** (the whole invoice again, once for each original), each linked to the invoice it corrects, with the reason and the document
 * in which the buyer agreed (CXN-INV-02). What the buyer owes is then the sum of the invoices that stand less what was paid.
 */

export const CORRECTION_KINDS = ['ADJUSTMENT', 'REPLACEMENT'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export interface CorrectionLine {
  description: string;
  amountVnd: string;
  vatCategory: string;
}

export interface CorrectionInput {
  reason: string;
  agreementRef: string;
  lines: readonly CorrectionLine[];
}

export const MIN_CORRECTION_REASON = 10;
export const MIN_AGREEMENT_REF = 5;
export const MAX_CORRECTION_LINES = 50;
const MAX_DESCRIPTION = 500;
const WHOLE_VND = /^-?[0-9]{1,24}$/;

export type CorrectionDefect =
  | { field: 'correction_reason' }
  | { field: 'agreement_document_ref' }
  | { field: 'lines'; reason: 'EMPTY' | 'TOO_MANY' }
  | { field: 'lines'; index: number; reason: 'DESCRIPTION' | 'AMOUNT' | 'ZERO' | 'VAT' };

/** What is wrong with the shape of a correction, field by field; nothing when it is well formed. The totals are judged separately (they need the invoice). */
export function correctionDefects(input: CorrectionInput): CorrectionDefect[] {
  const defects: CorrectionDefect[] = [];
  if (input.reason.trim().length < MIN_CORRECTION_REASON) defects.push({ field: 'correction_reason' });
  if (input.agreementRef.trim().length < MIN_AGREEMENT_REF) defects.push({ field: 'agreement_document_ref' });
  if (input.lines.length === 0) defects.push({ field: 'lines', reason: 'EMPTY' });
  if (input.lines.length > MAX_CORRECTION_LINES) defects.push({ field: 'lines', reason: 'TOO_MANY' });
  input.lines.forEach((line, index) => {
    if (line.description.trim() === '' || line.description.length > MAX_DESCRIPTION) defects.push({ field: 'lines', index, reason: 'DESCRIPTION' });
    if (!WHOLE_VND.test(line.amountVnd)) defects.push({ field: 'lines', index, reason: 'AMOUNT' });
    else if (BigInt(line.amountVnd) === 0n) defects.push({ field: 'lines', index, reason: 'ZERO' });
    if (!(VAT_CATEGORIES as readonly string[]).includes(line.vatCategory)) defects.push({ field: 'lines', index, reason: 'VAT' });
  });
  return defects;
}

/** The lines of a correction priced as an invoice prices them, with their totals. Lines that are not well formed are the caller's to refuse first (`correctionDefects`). */
export function priceCorrection(kind: CorrectionKind, lines: readonly CorrectionLine[]): { lines: PricedInvoiceLine[]; subtotalVnd: string; vatVnd: string; totalVnd: string } {
  const priced = lines.map((line) => priceLine({ kind: kind === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'SUBSCRIPTION', description: line.description.trim(), amountVnd: line.amountVnd, vatCategory: line.vatCategory as VatCategory }));
  return { lines: priced, ...invoiceTotals(priced) };
}

export type CorrectionRefusal = 'ADJUSTMENT_ZERO' | 'ADJUSTMENT_BELOW_ZERO' | 'REPLACEMENT_NOT_ABOVE_ZERO';

/**
 * Whether the totals of a correction are acceptable. An adjustment must change something (a total of nothing is no adjustment) and may not take more than the invoice still stands for (the original and the
 * adjustments issued so far, `standingVnd`), so a series of reductions can never turn an invoice into a debt of the seller. A replacement must be for more than nothing: replacing an invoice by an empty one
 * would be the cancellation that does not exist.
 */
export function judgeCorrection(kind: CorrectionKind, totalVnd: string, standingVnd: string): CorrectionRefusal | undefined {
  const total = BigInt(totalVnd);
  if (kind === 'REPLACEMENT') return total > 0n ? undefined : 'REPLACEMENT_NOT_ABOVE_ZERO';
  if (total === 0n) return 'ADJUSTMENT_ZERO';
  return BigInt(standingVnd) + total < 0n ? 'ADJUSTMENT_BELOW_ZERO' : undefined;
}

/** The invoices that stand: issued and not replaced (a replaced original is stood in for by its replacement; a draft, a discarded or an unissued invoice is not owed). */
const STANDING_STATUSES: readonly string[] = ['Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted'];

export interface StandingInvoice {
  id: string;
  kind: string;
  status: string;
  totalVnd: string;
  /** The invoice this one corrects (corrections only). */
  relatedInvoiceId?: string | null;
}

/**
 * What the buyer owes: the total of the originals that are not replaced, plus the adjustments and the replacements that were issued, less what was paid (SAS.md 3.7 item 4). The adjustments of an invoice that has been
 * replaced are not counted: the replacement is the whole invoice again, with what the adjustments said already in it.
 */
export function receivableVnd(invoices: readonly StandingInvoice[], paidVnd: string): string {
  const replaced = new Set(invoices.filter((invoice) => invoice.status === 'Replaced').map((invoice) => invoice.id));
  const owed = invoices
    .filter((invoice) => STANDING_STATUSES.includes(invoice.status))
    .filter((invoice) => !(invoice.kind === 'ADJUSTMENT' && invoice.relatedInvoiceId != null && replaced.has(invoice.relatedInvoiceId)))
    .reduce((sum, invoice) => sum + BigInt(invoice.totalVnd), 0n);
  return (owed - BigInt(paidVnd)).toString();
}
