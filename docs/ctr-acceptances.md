# CTR: the acceptance of work (ST-CTR-009, slice CTR-1)

Work done under a contract is **measured** (docs/ctr-measurements.md) and then **accepted**: an approver turns approved measurements into a priced record, and the contract has accepted that much
(CTR 3.4, BR-CTR-05). Payment (PAY) starts from an approved acceptance, never from a measurement.

## Drafting (`createAcceptance`, `acceptance.create`)

| rule | refusal |
|---|---|
| the contract is `ACTIVE` | 409 `CONTRACT_STATE_INVALID` |
| the measurements are the contract's own, approved (a draft, a sent, a rejected or a corrected one is not) | 422 `MEASUREMENT_NOT_APPROVED` with `measurement_ids`; 422 `VALIDATION_FAILED` for an unknown id |
| none is held by an approved acceptance already | 409 `MEASUREMENT_ALREADY_ACCEPTED` with `measurement_ids` |
| all are of the period of the acceptance; the period and the paper (a clean file version) exist | 422 `VALIDATION_FAILED` |
| a revision of the contract is in force on the day of the acceptance, and prices every item | 422 `REVISION_NOT_EFFECTIVE`; 422 `VALIDATION_FAILED` (`NO_PRICE`, `AMOUNT_NOT_POSITIVE`) |
| minutes of quality that are named are the contract's own and not rejected or revoked | 422 `QUALITY_ACCEPTANCE_REQUIRED` |

Each line keeps the **price of the day**: the quantity of the measurement, the unit price and the retention of the revision in force on the day the acceptance is drawn up
(`accepted_on`), and the amount in whole dong, rounded the way that line of the BOQ is rounded (`amount = round(quantity × unit_price)`). An acceptance is worth the sum of its lines. A later revision
changes none of it (UAT-AC58); a mistake is corrected by revoking and drawing up again. Two acceptances may wait with the same measurement; `acceptance_line.active` is **false** until the acceptance
is approved (see the decision below), so the unique index `acceptance_line_measurement_uq` lets only one of them be approved.

## Sending (`submitAcceptance`, `acceptance.submit`, versioned)

`DRAFT → SUBMITTED` with the people who sign the paper (`signer_refs`, 1 to 20 objects). The measurements must still be approved and free (a correction supersedes a measurement), and minutes of
quality that were named must still be usable. The decision can send it back to the draft (`return`), which clears who sent it.

## Deciding (`post_acceptances_id_decision`, `acceptance.approve`, versioned)

`approve`, `return` or `reject`, with a reason and optional documents. Not by whoever drafted or sent the acceptance (403 `SELF_APPROVAL_DENIED`). Approving is refused, in this order:

1. the contract is no longer `ACTIVE` (409 `CONTRACT_STATE_INVALID`);
2. a measurement is no longer approved (422 `MEASUREMENT_NOT_APPROVED`) or an approved acceptance holds it (409 `MEASUREMENT_ALREADY_ACCEPTED`);
3. the contract asks for quality acceptance minutes (`requires_quality_acceptance`) and none that is approved covers the work (422 `QUALITY_ACCEPTANCE_REQUIRED`): the minutes named on the
   acceptance, or the latest approved minutes of the contract whose inspection one of the measurements was made against;
4. a serious non-conformance (`blocks_acceptance`, not `CLOSED`) is open on the work: on one of the measurements, on an inspection of one of the items, or on the contract in general
   (422 `OPEN_CRITICAL_NCR` with `nonconformance_ids`);
5. `accepted_total_vnd + amount` would go above `contract_value_vnd` (422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`, with the figures and `remaining_vnd`).

Then, in the one transaction: the acceptance is `APPROVED` (with the minutes of quality linked), its lines become active (a second active line for a measurement is refused by the database as 409
`MEASUREMENT_ALREADY_ACCEPTED`) and `contract.accepted_total_vnd` rises. `ctr.acceptance.approved.v1` carries a line for each measurement (`line_id`, `measurement_id`, `boq_item_id`, `party_id`,
`quantity`, `unit_price_snapshot`, `amount_vnd`, `retention_pct_snapshot`); PAY consumes it to recognise the acceptance in its ledger (ST-PAY-001: one entry for each line, its own key
`(contract, item, acceptance, party)`). Rejecting and sending back are audited with the reason and send no event.

## Revoking (`revokeAcceptance`, `acceptance.revoke`, versioned)

Only `APPROVED` acceptances, with a reason and a clean paper that approves the withdrawal. Not by whoever sent or approved it (403 `SELF_APPROVAL_DENIED`). Refused while a payment request holds the
acceptance (`payment_request.claims_acceptance`): 409 `ACCEPTANCE_ALREADY_CLAIMED`. The lines stop counting, `accepted_total_vnd` falls, and `ctr.acceptance.revoked.v1` tells PAY.

## The tables (V1389)

`acceptance`: the day (`accepted_on`), when it was sent, the reason and the documents of the decision, who rejected and who revoked it and why; checks on the words, the lists, the amount (> 0), the shape of each
status and the people; the guard `guard_acceptance` (what the acceptance says never changes, the edges `DRAFT → SUBMITTED → APPROVED | REJECTED | DRAFT`, `APPROVED → REVOKED`, an approval is kept, a sent
acceptance is worth its lines). `acceptance_line`: the guard `guard_acceptance_line` (written with a draft acceptance and inactive, never changed, active only with an approved acceptance and inactive again
with a revoked one). `DELETE` and `TRUNCATE` are revoked from the application role on both.

## Screen CTR-12

`/ctr/ctr-12?contract=<id>`: the contract in figures (value, accepted, still to accept), the acceptances with their lines priced as at the day, the minutes of quality and the serious non-conformances in
the way, and the dialogs to draw up (from the approved measurements of one period that no approved acceptance holds), send, decide and revoke.
