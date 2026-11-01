# Reconciliation of the invoices of the providers of AI (ST-LLM-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LLM.md` (F3, BR-LLM-06, LLM-21, UAT-AC462). Migration `V1148__llm1_invoice_reconciliation.sql`. Pure rules in `packages/kernel/src/llm-reconcile.ts`, storage in `packages/db/src/llm-reconcile-store.ts`, the API in `apps/api/src/modules/llm/reconcile.controller.ts`, the screen in `apps/web/src/screens/llm/`.

## The operations

| Operation | Who (on the whole tenant) | What it does |
| --- | --- | --- |
| `reconcileAiInvoice` `POST /ai-invoices/reconciliations` | `llm.finops` | Sets the invoice of a provider against the sum of the cost of its attempts in the period. The provider is the one whose code the `invoice_ref` is, or begins with followed by a dash (the longest code wins). 422 `VALIDATION_FAILED` names the field (no provider for the reference, an amount that is not a decimal of at most eight places or is below zero, a currency that is not three capitals, a period that is not a date or is longer than a leap year), 409 `RECONCILE_PERIOD_OPEN` while the period is not over in Vietnam time, 422 `CURRENCY_MISMATCH` when an attempt that cost something is in another currency, 409 `DUPLICATE_KEY` when the reference was reconciled for another period or amount. |
| `listAiInvoiceReconciliations` `GET /ai-invoices/reconciliations` | `llm.finops` | The reports, newest first, by `status` (`VARIANCE` or `RECONCILED`) and cursor. |
| `post_budgets_id_reconcile` `POST /budgets/{id}/reconcile` | `llm.finops`, `If-Match` | The owner of a budget decides on the reservations that still wait for their usage: `approve` releases the ones (the ones named in `evidence_ids`, or all that wait when none is named) whose usage never came and so settled for nothing; `return` and `reject` keep them waiting. The answer lists `released` and `kept`, the version of the budget goes up by one (`If-Match`), and a reservation that does not wait on this budget is 422 on `evidence_ids`. The reason takes 10 to 2,000 characters. |

## The figures

Money is an integer count of 1e-8 of the currency; nothing is computed on floating point. The variance is the invoice less the attempts; it is **inside the tolerance** when it is at most `0.50` percent of the invoice (`|variance| x 200 <= invoice`, exact), above or below. An invoice of nothing agrees only with attempts of nothing. The tolerance comes from the module (`RECONCILE_TOLERANCE_PERCENT`), not from a setting of the tenant.

## The report

A run is one row per `(tenant, provider, invoice_ref)`: the invoice, the period, the total of the attempts, the variance, the tolerance, the number of attempts counted, the attempts still waiting for their usage (`pending_attempt_ids`), the ones already reconciled and the reservations settled. A difference inside the tolerance is `RECONCILED` and final: asking again answers with the same report and writes an audit entry marked `replayed`, no event. A difference outside it is a `VARIANCE` with an owner (the one who ran it) and is run again when the usage of the late attempts has arrived; `run_count` says how many times.

An attempt that timed out and was paid for afterwards (late usage) is counted by the attempt that paid for it; the cost of an attempt is never edited to make the figures agree (BR-LLM-06) - the database refuses an update of the figures of an attempt that was written. The reservations whose usage arrived are settled by the run.

## The database

`ai_invoice_reconciliation` has row-level security by tenant; the facts of a run (provider, reference, invoice, period) and the owner cannot be changed, a `RECONCILED` report is final, rows are never deleted. The trigger `guard_llm_attempt_figures` stops an update of the cost and usage of an attempt by anyone but the owner role.
