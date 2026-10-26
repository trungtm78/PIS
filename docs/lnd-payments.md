# LND-1: the payments of an approved plan (ST-LND-007)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.2, 4, BR-LND-01, BR-LND-03, BR-LND-07, BR-LND-10, UAT-AC378, UAT-AC383, UAT-AC397). Migration: `V1688__lnd1_compensation_payment.sql`. Screen LND-07. CXN-12 (the days) and CXN-02, so the story is DONE_UNCONFIRMED.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `scheduleCompensationPayments` | `POST /compensation-plans/{id}/payments` (If-Match) | `land.payment.write` over the project and the units of the households | Schedules payments for households that have an amount in the plan; the first moves the plan APPROVED to PAYING. |
| `confirmCompensationPayment` | `POST /compensation-payments/{id}/confirm` (If-Match) | the same | PENDING to PAID with the voucher; late payments say why; an advance is recovered through PAY. |
| `depositCompensationPayment` | `POST /compensation-payments/{id}/deposit` (If-Match) | the same | PENDING to DEPOSITED for money a household does not take, with the reason and the record of the deposit. |
| `listCompensationPayments` | `GET /compensation-plans/{id}/payments` | `land.read` and the units of the households | The payments of a plan inside the units of the reader; the account only masked. Additive. |
| `listUpcomingLandDeadlines` | `GET /land-deadlines/upcoming` | `land.read` over the project | The running timers that fall due within `within_days` (0 to 180, 14 by default), those already past, and the breached ones of the last days, the soonest first. |
| `getCompensationPlanTimers` | `GET /compensation-plans/{id}/timers` | `land.read` | Read in ST-LND-006; it also answers `payment_due_on` and the days left. |

`late_reason` is an optional field of `confirmCompensationPayment` (additive): UAT-AC378 needs a way to give the reason of a late payment and the design lists none.

## The days and the late payment (AC-ST-LND-007-1, UAT-AC378, BR-LND-03)

- A payment is due on the day of the plan (`payment_due_on`, 30 days after the approval by the rule `PAYMENT_30`) or on an earlier day the caller names; never after it and never on or before the day of the approval. Each payment starts the timer `PAYMENT_30` of `land_deadline` (subject PAYMENT) with the days between the approval and its due day and the version of the rule of the approval day (`422 TIMER_RULE_UNCONFIRMED` when none is in force).
- The day of a payment has come and is not before the approval. After its due day a payment says why (`422 PAYMENT_LATE_REASON_REQUIRED`, `late_reason`); on time it carries no reason (`422 VALIDATION_FAILED late_reason`). The table keeps the rule (`compensation_payment_status_chk`: a paid payment has a reason exactly when it was paid after its day).
- The timer ends by the day of the payment: on time it is SATISFIED on that day, after its day it is BREACHED (a timer that the job of the alerts already breached stays so). Deposit counts as delivering the money, by the same rule.
- Not done here: the daily job that sends the alerts at T-7 and T, breaches the timers on the day after and raises the issue that holds a code and no name (UAT-AC378 steps 1 and 3). The table keeps what it needs (`alert_level_sent`, `overdue_flagged_at`) and `listUpcomingLandDeadlines` shows what is due; the job belongs to the alerting stories.

## What a payment may be (BR-LND-05, BR-LND-03)

- For a household that has an amount in the plan, in the units of the caller and in the project of the plan; the payments of a household add up to no more than the plan holds for it (`422 PAYMENT_EXCEEDS_PLAN`, the payment named, with `scope: HOUSEHOLD` and what is left). Every household's limit together is the limit of the plan, which the database also holds against any other writer, over the whole plan whatever the caller sees (`plan_payment_totals`).
- Several payments of one household are numbered (`payment_no`); the unique key of the table is plan, household and number.
- A bank account is accepted, sealed with the envelope encryption of the platform (BR-LND-07) and shown masked (the last four characters); no command opens it. It is never in the audit row, an event or a log.

## The advance of the land clearance (AC-ST-LND-007-2, UAT-AC383, BR-LND-10)

A payment that names `advance_id` recovers that advance through the PAY command (`PayAdvanceStore.recordRecovery`, basis COMPENSATION_PAYMENT, the payment as source, the voucher as evidence) in the same transaction: more than is owed (`422 ADVANCE_RECOVERY_EXCEEDED`), an advance that cannot be recovered (`409 ADVANCE_STATE_INVALID`), an advance of another project (`422 VALIDATION_FAILED advance_id`) or a caller who does not reach the contract (`403 SCOPE_DENIED`) leave the payment unpaid. PAY writes its own audit row (`advance.recovered`) and event (`pay.advance.recovered.v1`). The story names a "suggestion" that PAY would make from an event; UAT-AC383 and the error codes of the command need the answer within the command, so the recovery is made in it and no suggestion is stored.

## What the plan, the households and the parcels do (BR-LND-05, LND 4)

The plan is completed when no payment waits and what was paid or deposited covers everything the plan holds (`PAYING` to `COMPLETED`, held also by the guard of the plan); a plan that is paid in part stays PAYING. A household whose payments cover its items and none waits moves from PLAN_LISTED to COMPENSATED, and a parcel all of whose households are compensated moves from PLAN_APPROVED to PAID; the functions of the database that do it (`advance_paid_subjects`) read every household whoever asks.

## Personal data (AC-ST-LND-007-3, UAT-AC397)

The amounts a household is paid are PERSONAL: the table has the unit policy, a payment is read and written inside the units of its household, and the screen says so. The audit row of a payment carries the id of the payment and the plan, the amount, the dates and the id of the advance, never the household or the account; the events carry the same. A replayed command is answered with the first answer: one payment effect, one audit row, one event.

## Not in this story

Cancelling a scheduled payment (the status exists and the table accepts it; no command), the job of the alerts and of the breached timers, the reveal of an account, and the move of the households to RESETTLED and CLOSED.
