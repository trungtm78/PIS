# SAS_EINVOICE_ISSUE_FAILED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_EINVOICE_ISSUE_FAILED.json`

## What it means

An invoice goes to the e-invoice provider through the port `EInvoiceProviderPort` when a Billing Operator issues it (`issueEInvoice`, SAS-09) and, when the provider does not answer, the job `einvoice-billing` (every 5 minutes, `docs/runbooks/jobs.md`) asks again: 10 minutes after the first failure, then 1, 4 and 12 hours, five attempts within 24 hours of the first. After that the invoice is `IssueFailed` and nobody asks again by the clock. The gauge `einvoice_issue_failed_invoices` is the number of such invoices over all tenants. Nothing was lost: the invoice is still a complete Draft-like record (lines and totals fixed), and the reference key (the invoice id) lets the provider answer with the same invoice if it did issue one whose answer never arrived [CXN-INV-03].

The usual causes: the provider is down for longer than a day; its credentials or certificate ended; the tax authority service behind it is down. Until a contract with a real provider exists (D05/D06) the adapter is the MOCK, which fails only when a test or a drill tells it to.

## What to do

1. Open SAS-09 (`listTenantInvoices`) for the tenant: the invoice shows `IssueFailed`, the number of attempts and the error.
2. Mend the cause at the provider (status page, credentials, certificate).
3. Issue the invoice again (`issueEInvoice`, with the current `If-Match`): the first attempt is made at once; the provider answers with the number, series and codes, or with the invoice it already issued for the same reference key. Check at the provider that exactly one invoice exists for the key before and after.
4. If the provider issued the invoice but the platform never saw the answer, the second issue finds that invoice: do not create a second one by hand at the provider.
5. Do not edit `invoice` in the database: the guard refuses it for an issued invoice, and there is no cancel; a mistake in an issued invoice is an adjustment or a replacement (SAS-24).
