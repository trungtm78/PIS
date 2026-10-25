# PAY: the draft of a payment request (ST-PAY-002, slice PAY-1)

An accountant draws a **payment request** up from an approved acceptance (PAY 3.1 steps 1 and 2). The server works out every figure (gross, advance to recover, retention, net) from the acceptance and the
ledger; the client sends only the number of the file, the line of capital, a tax adjustment with its basis and, if wanted, an extra recovery. A draft takes **no claim** on the acceptance (the claim is taken
when the request is sent, a later story); it can be revised, given documents and cancelled. Sending, checking, the Treasury and settlement are other stories.

## Commands and reads

| operation | route | permission | what it does |
|---|---|---|---|
| `createPaymentRequest` | `POST /payment-requests` | `payment.create` | draws up a `DRAFT` from an approved acceptance (INTERIM), a planned advance (ADVANCE) or a settlement (FINAL) |
| `revisePaymentDraft` | `POST /payment-requests/{id}/draft` (If-Match) | `payment.create` | changes the number, the line of capital, the tax adjustment and basis, the extra recovery; the money is worked out again; a `RETURNED` request becomes `DRAFT` |
| `attachPaymentDocument` | `POST /payment-requests/{id}/documents` | `payment.document.attach` | attaches a clean version of a file; duplicate invoice numbers (below) |
| `cancelPaymentRequest` | `POST /payment-requests/{id}/cancel` (If-Match) | `payment.cancel` | `DRAFT`/`RETURNED` to `CANCELLED` with a reason |
| `get_resources_payment_request` (+ `_id`) | `GET /resources/payment_request` | `payment_request.read` | the requests in the scope of the caller (filters `contract_id`, `status`, `request_kind`; cursor); the detail has the lines and the documents |

Every command answers `PayPaymentCommandResult`: the usual `CommandResult` and the figures the server computed (`gross_vnd`, `advance_recovery_vnd`, `retention_vnd`, `tax_adjustment_vnd`, `net_vnd`), the
`plan_year` and `warnings`. **No API takes `status`, `gross_vnd`, `net_vnd`, `advance_recovery_vnd` or `claims_acceptance`** (BR-PAY-17): the allowlist of the request schema answers 400 `FIELD_NOT_ALLOWED`.

## The money (`packages/kernel/src/pay-money.ts`, pure BigInt functions)

| rule | formula |
|---|---|
| BR-PAY-03 gross | the sum of the lines of the acceptance (each worth `round(quantity x price of the day)`); the header gross is the gross of the acceptance (the database holds it) |
| BR-PAY-05 retention | per line `round(gross x pct / 100)` by the rounding rule of the line of the BOQ |
| BR-PAY-04 advance to recover | per party and tranche `floor(A x min(1, G / (theta x V)))` less what is recovered, not below zero, not above what is outstanding (`G` = gross asked for before, from the ledger, plus this request; `V` = the work of the party; `theta` = the threshold of the tranche, 80 percent by default) |
| extra recovery | on top of the formula, within the room the tranches have left (422 `VALIDATION_FAILED` `EXTRA_EXCEEDS_OUTSTANDING` above it), shared over the parties by the largest remainder on that room |
| the cap | recovery plus retention never go above the gross of a line, so no net is negative; what a line cannot carry is left to the next request |
| BR-PAY-07 allocation | the recovery of a party is shared over its lines by gross, floor first, the remainders to the largest fractional parts, ties to the smaller `boq_item_id`; no line above its capacity, the rest shared again among the others. 100 over 1:2 gives 33/67, 101 gives 34/67 |
| BR-PAY-06 net | header `net = gross - recovery - retention + tax adjustment`; a line `net = gross - recovery - retention` (the tax adjustment belongs to the whole request and needs its basis) |

The golden cases of the chief accountant are in `packages/kernel/test/pay-money.test.ts` (UAT-AC323, UAT-AC324, UAT-AC327).

## The guards (`PayPaymentStore`, in the order they are met)

1. The contract is locked first (the lock every command of money on a contract takes); one the caller cannot see is 404, one they can read and not change is 403 `SCOPE_DENIED`.
2. **Contract state** (BR-PAY-09, `pay-request.ts`): active takes every kind; suspended takes an interim request for an acceptance approved before the day it was suspended and no advance; terminated takes
   the final request only, for an acceptance approved up to the day it ended; completed takes the final request; any other state takes none: 409 `CONTRACT_STATE_INVALID` with the reason.
3. The acceptance is the contract's own and `APPROVED` (422 `ACCEPTANCE_NOT_APPROVED`); no request holds its claim (409 `ACCEPTANCE_ALREADY_CLAIMED`); other drafts of it are only a warning.
4. The number is unique within the contract, never overridable (409 `PAYMENT_REFERENCE_DUPLICATE`).
5. The national project code, by the rule of the day (CXN-01, `NATIONAL_CODE_REQUIRED` of the master rules): 422 where the rule blocks, a warning where it warns.
6. The line of capital (BR-PAY-14): of the project of the contract, in force (it has a balance), a plan year no earlier than the year of the acceptance and still open for payment (the end of the year, or the
   day an extension reaches): 422 `ALLOCATION_UNAVAILABLE` / `PLAN_YEAR_MISMATCH`. Whether the line has enough left is judged when the request is sent (UAT-AC342).

## Documents and duplicate invoices (BR-PAY-08)

A document is a clean version of a file (422 `DOCUMENT_NOT_CLEAN`), once on a request, with the checksum of the file. An invoice names its number and date. The same invoice number in the same contract is
409 `INVOICE_DUPLICATE`; it is let through when the call carries `duplicate_override_reason` and the caller holds `payment.verify` over the contract (the right of an approver of exceptions) and is not the person
who drew the request up (403 `SCOPE_DENIED`, 403 `SELF_APPROVAL_DENIED`); the reason and the approver are kept with the document and in the audit row. A reason for a number that was not used before is 422. The
same number in **another** contract of the tenant is only the warning `DUPLICATE_INVOICE_OTHER_CONTRACT`.

## What the database keeps (V1563)

The status moves along the edges of PAY 4 only; the amounts, the number and the line of capital change only while the request is a draft or returned; a line is a line of the acceptance of the request, worth
what the acceptance says; **at every commit the lines add up to the header** and the gross is the gross of the acceptance (`PAYMENT_NET_MISMATCH`); a document is clean, of the contract of the request, written
while it is a draft and never changed or deleted; a request is never deleted; a request is drawn only from an approved acceptance of its contract, for the project of the contract.

## Screens

* **PAY-01** the list (filters by contract and status; a link to the form for whoever may draw up).
* **PAY-02** the form: contract, approved acceptance, line of capital, number, tax adjustment and basis, extra recovery; nothing the server computes is asked for; the result shows the server's figures and the warnings.
* **PAY-03** the detail and documents: the figures (read-only), the documents, and the commands the server says the caller may give (revise, attach, cancel).
* **CTR-13** the valuation table: for each line the quantity, the price in force, gross, recovery, retention and net, then the tax adjustment of the whole request and the amount asked for.

Browser flow `apps/web/e2e/pay-payment-flows.spec.ts`; visual regions PAY-01, PAY-02, PAY-03, CTR-13.
