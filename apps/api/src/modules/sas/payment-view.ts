import type { PaymentRow } from '@machvon/db';
import type { Schemas } from '../../contract-types';

export const paymentView = (row: PaymentRow): Schemas['BillingPayment'] => ({
  id: row.id,
  provider: row.provider,
  txn_ref: row.txnRef,
  amount_vnd: row.amountVnd,
  method: row.method,
  received_at: row.receivedAt.toISOString(),
  match_status: row.status,
  memo: row.memo,
  ...(row.invoiceId === null ? {} : { invoice_id: row.invoiceId }),
  ...(row.matchedAt === null ? {} : { matched_at: row.matchedAt.toISOString() }),
  version: row.version,
  actions: { match: row.status === 'Unmatched' || row.status === 'PendingReview' },
});
