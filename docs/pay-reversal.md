# Reversing a payment that was settled (ST-PAY-008)

PAY 3.4, UAT-AC331. Screen PAY-08 (reverse and adjust, with the original entries and the entries that undo them side by side), reached from PAY-03 once a request is settled. **No call is made to the Treasury**: the refund it confirmed arrives like any other transaction (statement, callback, confirmation by hand) as a `REFUND` that names the payment it undoes.

## The command (`reversePayment`, `payment.reverse`, versioned)

`POST /payment-requests/{id}/reverse` with `reason`, `refund_treasury_transaction_id` and `approval_document_version_id`. The schema leaves all three optional and the store asks for them in this order (UAT-AC331 steps 1 to 3), so each answer says what is missing:

| Step | Refusal |
|---|---|
| no reason, or a blank one | 422 `VALIDATION_FAILED` on `reason` |
| the request is not SETTLED | 409 `PAYMENT_STATE_INVALID` (with its `status`) |
| no refund, or one that is not the refund of this payment | 422 `REFUND_NOT_CONFIRMED`, `reason` says which: `MISSING`, `NOT_FOUND` (also another project), `NOT_A_REFUND`, `OTHER_PAYMENT` (it undoes another payment), `AMOUNT` (not the net of the request; the two figures are told), `ALREADY_USED` (not UNMATCHED) |
| no approving document | 422 `APPROVAL_REQUIRED`; a document not scanned clean is 422 `DOCUMENT_NOT_CLEAN`, an unknown one 422 `VALIDATION_FAILED` |
| the caller matched the payment, or sent its file to the Treasury | 403 `SELF_APPROVAL_DENIED` (four eyes on money that goes back) |
| a stale version | 409 `VERSION_CONFLICT` |
| part of the retention was already released | 409 `PAYMENT_STATE_INVALID`, `reason` `RETENTION_RELEASED` |

## What it does (one transaction, under the lock of the contract, in the lock order of the product)

* The totals of the contract come back in one statement: `requested_total_vnd`, `paid_total_vnd`, `advance_recovered_vnd` and `retention_held_vnd` each less the figure of the request.
* Every effect on the ledger is undone by a new entry that is the exact opposite of the one it undoes and names it (`reversal_of_id`): `PAYMENT_REVERSAL` first (so the paid amount comes off before the claim does), then `ADVANCE_RECOVERY_REVERSAL`, `RETENTION_RELEASE` and `CLAIM_RELEASE`. The recovery taken from the tranches of the advance is given back by `REVERSE_RECOVER` entries of the advance journal. The entries say a fixed sentence (`The payment was reversed.`), never the words of the person (those stay on the request and in the audit row). An entry is undone once (`cumulative_ledger_entry_reversal_uq`), and nothing is updated or deleted but the balances that follow the entries (the sum of the entries is checked at every commit).
* The hold of retention of the request goes (`retention_hold`), as it does when a request is returned, but only while nothing of it was released.
* The refund is matched to the request, and the request becomes REVERSED with `claims_acceptance = false`, so the acceptance can be claimed again (UAT-AC331 step 4). The request keeps who reversed it, when, why, on which document and against which refund.
* A payment request for an **advance** gives the advance back to PLANNED when the Treasury has refunded it and nothing was recovered: an `advance_ledger_entry` `REVERSE_DISBURSE` undoes the `DISBURSE`, `paid_vnd`, `paid_on` and the last day of recovery are cleared, and the contract no longer shows the money out. A tranche of which something was recovered is 409 `ADVANCE_STATE_INVALID`.
* Audit row `payment_request.reversed` (with the reason) and the event `pay.payment.reversed.v1` (identifiers and figures, no words; the refund's time and the day the Treasury first confirmed the payment, so CAP can undo the DISBURSE, and DIS and MNE take the amount back from the right day). The consumers are other groups' stories.

## What the database holds (V1568)

A request is REVERSED only against the refund matched to it (a refund of the payment that settled it, for its net, once: `treasury_transaction_refund_request_uq`) and, for an advance request, with the advance planned again; what reversed a request is not changed afterwards; the match of a refund is checked by the guard of the transaction in the same way as the match of a payment; an advance goes from PAID back to PLANNED only with nothing recovered and the amount paid cleared; the hold of retention can be deleted with a reversed request.

## Screen PAY-08

The request (status, contract and a link to its ledger, the value of the work, what the Treasury paid, the day it confirmed it, and when it was reversed), the entries the payment put on the ledger beside the entry that undoes each (the release of a hold of retention names no entry, so it is paired with the hold on the same item that has the opposite figure), and, for who holds `payment.reverse`, the dialog: one of the refunds the Treasury confirmed for this very payment, the reason and the approving document. Reads: `get_resources_payment_request` (now also `settled_transaction_id`, `reversed_at`, `refund_transaction_id`), `getCumulativeLedger`, `get_resources_treasury_transaction` (now with `reversal_of_id`).

Browser flow: `apps/web/e2e/pay-payment-flows.spec.ts` (the last test); visual region PAY-08 (back link above the title).
