# The earmark of capital (ST-CAP-011)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/CAP.md` (3.1 F4, BR-CAP-06, CAP-18, UAT-PLAN-10, UAT-AC227). Migration `V1370__cap1_fund_reservation.sql`. Operations: `createFundReservation` (`POST /fund-reservations`, `capital.reservation.manage`), `releaseFundReservation` (`POST /fund-reservations/{id}/release`, `capital.reservation.manage`, `If-Match`) and one read added to the contract, `listFundReservations` (`GET /fund-reservations`, `capital.read`). Job: `capital-reservation-expiry` (every 15 minutes).

## The rule

A reservation (`fund_reservation`) sets aside part of an allocation line for a purpose (`CONTRACT_PENDING`, `ADVANCE_PENDING`, `LAND_CLEARANCE`, `OTHER`) until an instant, optionally for an object (a kind and an id together). It is `ACTIVE`, then leaves ACTIVE once: `RELEASED` by a person, `EXPIRED` by the job, or `CONSUMED` by a payment (the payment consumer of PAY, not part of this story). What was reserved never changes (the table says so with a trigger); a reservation is never deleted.

- **Creating.** The amount is whole VND above zero (422 `amount_vnd`), the purpose one of the four, the last instant ahead of now and within 366 days (422 `expires_at`). The line must belong to a project in the scope of the caller for `capital.read` (404 otherwise) and the caller must hold `capital.reservation.manage` over that project (403 `SCOPE_DENIED` when they see it and may not act). A plan year that is soft-closed or locked takes no new reservation (409 `FISCAL_YEAR_LOCKED`).
- **The control.** The same availability policy as a commitment (ST-CAP-005): the policy that governs the line (project group > unit > fund source > tenant, the default 90/100) judges `(reserved when the policy counts reservations + committed + disbursed + the amount) / allocated`. At or above the warning threshold the caller must have accepted it (`avc_acknowledged`, else 422 `AVC_WARNING_ACK_REQUIRED` with the share and the thresholds); above the block threshold it is 422 `AVC_BLOCKED` whatever they accept; a line allocated nothing is blocked (`ZERO_ALLOCATION`). When a policy controls the appropriation, the appropriation is judged as well. The balances are locked in the one lock order of the product, so two reservations made at once that together would overspend a line are not both made.
- **What is written.** The reservation, the RESERVE ledger entry (`source_ref_kind` `RESERVATION`, the id of the reservation) with `reserved_vnd` raised in the same transaction, the audit row `capital.reservation_created` and the event `capital.reservation_created.v1`.
- **Releasing.** A reason of 5 to 2000 characters, against the version read (409 `VERSION_CONFLICT`); a reservation that is not ACTIVE is 409 `RESERVATION_NOT_ACTIVE`. A RELEASE entry takes the amount out of `reserved_vnd`; the audit row `capital.reservation_released` and the event `capital.reservation_released.v1` follow. The year is not looked at: capital returns to a line of a closed year too.
- **Expiring.** The job takes all the ACTIVE reservations whose last instant has passed (a backlog is closed in the one pass, with the balances of all of them locked together first, in the one lock order), closes each one (status EXPIRED, reason `EXPIRED`, closed by the member of the worker) with one RELEASE entry, the audit row `capital.reservation_expired` and `capital.reservation_released.v1` (status EXPIRED). The ledger dedupes by the reservation and the status leaves ACTIVE, so a second pass, or two at once, closes and announces nothing twice (UAT-AC227).
- **The nightly check.** `capital.balance-reconcile` now compares `reserved_vnd` with the ledger as well (RESERVE up, RELEASE down).

## The read

`listFundReservations` lists the reservations of the projects the caller sees capital of, newest first, by `status`, `allocation_line_id`, `project_id`, a page at a time (`limit`, `cursor`): the line, the project, the year, the purpose, the reference, the amount, the last instant, the status, the reason of the release, whether the warning was accepted, who made it and who closed it, and the version to send as `If-Match`.

## The screen (CAP-18)

`ReservationScreen`: the list with the project, the purpose, the amount, what is left of the time (days, then hours, then "over, waiting for the system to return the capital") and the status in words; a form to hold capital (`?line=` fills the line); a release form for each active reservation. A warning from the server is told in words with the share and the thresholds and asks for a tick before the request is sent again; changing the request takes the tick away. A reader sees the list and nothing to do.

## What is not done

- The consumption of a reservation by a payment (CONSUMED + RELEASE + COMMIT in one transaction, when PAY sends a request tied to a reservation) is the payment consumer of ST-PAY and is not built here.
- A reservation is not edited: a change is a release and a new reservation.
