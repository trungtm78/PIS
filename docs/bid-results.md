# The result of the selection of a contractor (ST-BID-006)

A proposer submits the result of the selection of a package and someone with the authority, who is not the proposer, approves it on a decision document or turns it down (BID 3 F7,
BR-BID-03). The decision is a person's: nothing a machine produced is read or written by these commands, and the screen BID-18 says so.

| Operation | Route | Permission | Moves |
| --- | --- | --- | --- |
| `submitProcurementResult` | `POST /procurement-results` | `bid.result.submit` | (nothing) → SUBMITTED |
| `decideProcurementResult` | `POST /procurement-results/{id}/decision` | `bid.result.approve` | SUBMITTED → APPROVED or REJECTED |
| `listProcurementResults` | `GET /procurement-results?package_id=` | `bid.read` | – |

Both commands act inside the scope of their permission over the project of the package. The store is `packages/db/src/bid-result-store.ts`, the rules of the outcomes are in the kernel
(`bid-result.ts`), the controller is `apps/api/src/modules/bid/result.controller.ts`.

## Submitting

Refusals, in order: the shape (422 `VALIDATION_FAILED`: an unknown outcome, an award without its winner or its price, a price that is not whole VND above zero, a winner or a price on an outcome
that has none), the package (404 outside the scope, 409 `PLAN_NOT_APPROVED` unless its plan is in force, status `APPROVED`), a result that is still open (409 `RESULT_STATE_INVALID`,
`reason: OPEN_RESULT`), the price (422 `PRICE_EXCEEDS_PACKAGE_BUDGET`, with both figures; the price of the package itself is within it), the winner (422 `CONTRACTOR_RESTRICTED`, 422
`CONTRACTOR_NOT_VERIFIED`; a winner that does not exist is a fault of the request) and the evaluation (409 `REPORT_NOT_ISSUED` unless the document is in force).

* **The evaluation.** The request names it in `evaluation_report_id`. Until the structured report exists (ST-BID-012) it is the evaluation minutes issued through DOC: a document of the tenant whose
  `effect_status` is `EFFECTIVE`. It is stored in `evaluation_minutes_document_id` (V1347) and the column `evaluation_report_id` stays empty.
* **One result is open for a package at a time**: a second is refused until the first is decided (unique index `procurement_result_one_open_uq`).

## Deciding

Refusals, in order: the result (404 outside the scope), the version (409 `VERSION_CONFLICT`), its state (409 `RESULT_STATE_INVALID` unless it is SUBMITTED), the proposer (403
`SELF_APPROVAL_DENIED`, for a rejection as well), the delegation limit (below), and what the decision needs.

* **Approving** needs a decision document in force: a `QD` document with `effect_status` `EFFECTIVE` (422 `DECISION_DOCUMENT_NOT_EFFECTIVE`; one that is no decision is a fault of the request).
  For an award the plan, the price and the winner are judged again at that moment (409 `PLAN_NOT_APPROVED`, 422 `PRICE_EXCEEDS_PACKAGE_BUDGET`, 422 `CONTRACTOR_RESTRICTED`): they may have
  moved since the submission. The package takes the status of the outcome: `AWARDED`, `NO_ACCEPTABLE_BID` or `CANCELLED`.
* **Rejecting** needs the reason in words (at most 2000 characters) and no document; the package stays open for a new result.
* **The delegation limit.** The approver's grant has to reach the rank of the approver role of the DoA rule of document type `BID_RESULT` for the value of the award (the price of the package for an
  outcome with no award). A tenant that configured **no** rule for `BID_RESULT` leaves the approval to the permission and its scope; one that configured rules is always limited, so a band that was
  left out is a refusal (422 `DOA_RULE_NOT_FOUND`) and never a permission. The helper is shared with the contracts (`apps/api/src/doa-delegation.ts`).
* The decision is audited (`procurement_result.approved` / `.rejected`, with the reason) and an approval emits `bid.result.approved.v1` with the package, the contractor, the price and the decision
  document, which is what the contracts are drafted from.

## What the database keeps

V1347 keeps what a result says as it was: the outcome, the winner, the price and the evaluation never change, a decided result is kept as it is, the status moves only along the edges, an outcome that
is not an award carries no winner and no price, a rejection has its decider (not the proposer), its day and its reason, and the runtime role cannot delete a result.

## The screen BID-18

`apps/web/src/screens/bid/result`: the package, the results with the winner, the price against the price of the package, the evaluation, who submitted and decided and the status, a dialog to submit and a
dialog to decide. A decision is offered only to someone who holds the permission and did not submit the result.
