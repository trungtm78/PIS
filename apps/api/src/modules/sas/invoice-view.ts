import type { InvoiceLineRow, InvoiceRow } from '@machvon/db';
import type { Schemas } from '../../contract-types';

export const invoiceLineView = (row: InvoiceLineRow): Schemas['InvoiceLine'] => ({
  id: row.id,
  invoice_id: row.invoiceId,
  line_no: row.lineNo,
  kind: row.kind as Schemas['InvoiceLine']['kind'],
  description: row.description,
  amount_vnd: row.amountVnd,
  vat_category: row.vatCategory,
  vat_vnd: row.vatVnd,
  ...(row.meter === null ? {} : { meter: row.meter }),
  ...(row.quantity === null ? {} : { quantity: row.quantity }),
  ...(row.unitPriceVnd === null ? {} : { unit_price_vnd: row.unitPriceVnd }),
});

/** The statuses from which the invoice can be sent to the provider. */
export const ISSUABLE: readonly string[] = ['Draft', 'IssueFailed'];

export const invoiceView = (row: InvoiceRow, lines: readonly InvoiceLineRow[]): Schemas['Invoice'] => ({
  id: row.id,
  subscription_id: row.subscriptionId,
  invoice_code: row.invoiceCode,
  period_start: row.periodStart,
  period_end: row.periodEnd,
  kind: row.kind,
  status: row.status,
  subtotal_vnd: row.subtotalVnd,
  vat_vnd: row.vatVnd,
  total_vnd: row.totalVnd,
  buyer: { code: row.buyer.code, name: row.buyer.name },
  ...(row.dueAt === null ? {} : { due_at: row.dueAt }),
  ...(row.issuedAt === null ? {} : { issued_at: row.issuedAt.toISOString() }),
  ...(row.number === null || row.provider === null || row.templateCode === null || row.series === null
    ? {}
    : {
        einvoice: {
          provider: row.provider,
          template_code: row.templateCode,
          series: row.series,
          number: row.number,
          ...(row.taxAuthorityCode === null ? {} : { tax_authority_code: row.taxAuthorityCode }),
          ...(row.lookupCode === null ? {} : { lookup_code: row.lookupCode }),
        },
      }),
  issue_attempts: row.issueAttempts,
  ...(row.nextAttemptAt === null ? {} : { next_attempt_at: row.nextAttemptAt.toISOString() }),
  ...(row.issueError === null ? {} : { issue_error: row.issueError }),
  version: row.version,
  lines: lines.map(invoiceLineView),
  actions: { issue: ISSUABLE.includes(row.status) },
});
