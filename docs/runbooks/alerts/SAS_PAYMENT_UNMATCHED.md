# SAS_PAYMENT_UNMATCHED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_PAYMENT_UNMATCHED.json`

## What it means

A bank or a gateway told the platform that a payment came in (`receivePaymentWebhook`). The callback does not say which tenant it is for, so the payment is kept under the platform tenant and the job `payment-reconciliation` (every minute, `docs/runbooks/jobs.md`) matches it with the invoice whose code the payer wrote in the note of the transfer, only when exactly one invoice is named, it can be paid and the amount is exactly what is still to be paid. Every other payment waits: **Unmatched** (the note names no invoice) or **PendingReview** (it names several, an invoice that cannot be paid, or another amount). The gauge `payment_unmatched_total` is the number of payments that wait. A payment is never lost: it is recorded once for each transaction of the provider.

The usual causes: payers who write no code or a wrong one; an amount that is not the invoice's (a part payment, a bank fee deducted, two invoices paid together); an invoice that is not issued yet or is already paid.

## What to do

1. Open SAS-10 (`listBillingPayments`): each payment shows its amount, its note and its date.
2. Find the invoice it belongs to (SAS-09, `listTenantInvoices` of the tenant) and match it (`matchBillingPayment`, with a reason). The amount must be exactly what is still to be paid (422 `AMOUNT_MISMATCH` otherwise: nothing moves); the payment goes to the tenant of the invoice and the invoice is Paid.
3. For an amount that is not an invoice's (part payment, over payment, two invoices) do not edit anything: the platform has no operation for it yet (`TODOS.md`, ST-SAS-012); agree with the payer and the tenant owner, and leave the payment waiting.
4. Do not edit `billing_payment` in the database: the guards refuse it, and a payment moves to a tenant only through the match.
