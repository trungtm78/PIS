# Postings of capital from payments, and the nightly check of the balances (ST-CAP-006)

CAP 3.4, UAT-PLAN-01, UAT-PLAN-02, UAT-NFR-SECURITY-09. Nothing here is a screen or a command: it is the consumer `cap-payment-ledger` of the outbox, the store `CapPaymentLedgerStore` it calls and the job `capital-balance-reconcile`.

## The events and what they post

| Event (from PAY) | Posting |
|---|---|
| `pay.payment_request.submitted.v1` | `COMMIT` of the net, **unless** the contract holds the commitment of its value on the line (the activation of a contract commits it: ST-CAP-005); then nothing is committed again and the outcome is `covered`. |
| `pay.payment_request.returned.v1`, `…cancelled.v1` | `UNCOMMIT` of the commitment the request made itself, when it made one. |
| `pay.payment.settled.v2` | `UNCOMMIT` of the net and `DISBURSE` of the net, the `DISBURSE` dated by `confirmed_at`, the moment the Treasury confirmed it (its Vietnam date is `treasury_paid_on`). |
| `pay.payment.reversed.v1` | `REVERSAL` of the `DISBURSE`, dated by `refund_confirmed_at`; and, when the contract's own commitment paid it, `REVERSAL` of the `UNCOMMIT` too, so the amount is committed again and the acceptance can be claimed again. A request that committed capital of its own is finished: nothing is committed for it. |

The consumer reads `v1` of every event but the settlement, which it reads in `v2`; a request on no line (`allocation_line_id` null) posts nothing and is counted (`cap_payment_posting_total{outcome="no_line"}`).

## Rules

* **One posting for one fact.** The key of the ledger entry names the fact: `(source_ref_kind, source_ref_id, entry_type, allocation_line_id, source_ref_seq)`. `COMMIT`, `UNCOMMIT` and their reversal name the payment request, `DISBURSE` and the reversal of a disbursement name the Treasury transaction. A request that is returned and sent again commits again: that is the second posting (`source_ref_seq` 1), the first keeps 0 (V1368). Replaying an event, or delivering it twice under two ids, adds nothing.
* **The state of the request, not the order of the events.** The store reads `payment_request.status` under the lock of the balance: the sending of a request that is no longer in flight, the return of one that is in flight again, and the settlement of one that is not paid are `stale` and post nothing. A settlement read before the sending commits first (`COMMIT`, `UNCOMMIT`, `DISBURSE`), so the ledger tells the whole story and no balance goes below nothing. A refund read before the payment it undoes fails (404) and the relay tries again.
* **No overspending.** The balance of the line is locked first (the product's lock order); the room (`allocated - committed - disbursed`) is read under the lock and a commitment above it is 409 `BALANCE_INSUFFICIENT` before anything is written. Two commitments of 100 racing on a balance of 100: one is posted, the other fails and leaves no entry (the test in `packages/db/test/cap-payment-ledger-store.test.ts`).
* **The database holds the same rules** (V1368): an entry of a payment has a line and a project; a reversal of such an entry undoes one entry, of its line, for its whole amount, once.
* Each posting that moved something writes the audit row `capital_ledger.payment_posted` and the event `cap.ledger.payment_posted.v1` (the request, the line and the entries) in the same transaction, in the name of the system.

## The nightly check (`capital-balance-reconcile`)

At 02:00 Vietnam time (an hourly tick that works in that hour) each tenant is checked: for each appropriation of a project the allocated, committed and disbursed amounts its entries net to (a reversal counts as the opposite of the entry it undoes) against the sum of the balances of its lines. The gauge `cap_balance_drift_vnd` (per tenant) takes the sum of the differences without their sign, and the alert `CAP_BALANCE_DRIFT` fires above zero. **Nothing is corrected**: the job writes the audit row `cap.balance_drift_detected` and the event `cap.balance.drift_detected.v1` (once a day for each appropriation) and a person finds out which side is wrong (`docs/runbooks/alerts/CAP_BALANCE_DRIFT.md`).

The database refusing a rule the store should have kept (SQLSTATE 23514) raises `CAP_LEDGER_CHECK_VIOLATION` (`docs/runbooks/alerts/CAP_LEDGER_CHECK_VIOLATION.md`).
