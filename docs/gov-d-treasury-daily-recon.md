# Daily reconciliation with the Treasury (G4-4, PAY 3.3a, PAY-20)

Every working day the books are compared with the Treasury by project code and fund. The per-transaction reconciliation of ST-PAY-007 (`reconciliation_item`, `docs/pay-treasury-match.md`) is untouched and still answers "does this one transaction agree with this one payment"; this control answers "at the end of the day, do the books and the Treasury say the same, for each project and each fund".

## What is where

| Piece | File | Pure |
| --- | --- | --- |
| Compare, classify, opens-an-item, due day in working days, run status, policy reader | `packages/kernel/src/gov-d-recon.ts` | yes |
| The pass, the lines, the items, assign, resolve, reads | `packages/db/src/pay-treasury-daily-recon-store.ts` (`TreasuryDailyReconStore`) | no |
| The job (days that can still change, overdue items) | `packages/db/src/treasury-daily-recon-job.ts` (`TreasuryDailyReconJob`) | no |
| Commands and reads | `apps/api/src/modules/pay/treasury-daily-recon.controller.ts` | |
| Screen PAY-20 | `apps/web/src/screens/pay/dailyrecon/` | |
| Tables | `V1840` run, `V1841` line, `V1842` item | |
| Tests | `apps/api/test/gov/treasury-daily-recon.test.ts`, `packages/kernel/src/gov-d-recon.test.ts`, web `dailyrecon/*.test.ts(x)` | |

## The two sides of a day

A day is a calendar day in Vietnam time. Signed whole dong; a refund takes off.

* **Treasury**: the sum of `treasury_transaction` confirmed that day. A transaction with `reversal_of_id` or `direction = 'REFUND'` counts negative.
* **Books**: the sum of `payment_request.net_vnd` settled that day (`treasury_paid_on`, status SETTLED or REVERSED), less the net of the requests reversed whose refund transaction was confirmed that day.
* **Fund** of a line: `master_record_version.code` of the fund source of the allocation line that the transaction (or the payment it is matched to) names. Money that no fund can be found for is the key `UNMATCHED`.

Difference = Treasury less books.

## Kinds of difference

| Kind | When |
| --- | --- |
| `AMOUNT` | both sides have something and the figures differ |
| `MISSING_ON_TREASURY` | the books paid, the Treasury booked nothing |
| `MISSING_INTERNAL` | the Treasury booked, the books have nothing |
| `UNMATCHED` | the Treasury paid and no fund can be found (fund `UNMATCHED`) |
| `TIMING` | the same amount with the opposite sign stands on the neighbouring day of the same project and fund; the pair nets out and opens no item |

## When an item opens

`opensItem`: the kind is not TIMING and the difference is **strictly above** `threshold_vnd`, or, when the rule has `threshold_pct`, strictly above that percent of the larger side. A difference exactly equal to the threshold stays on the line without an item.

Each item is for one project, one fund, one day (one live item at a time). Its owner is the importer of the statement of that day, otherwise the person (or the worker) that ran the pass, and it must be an active member. Its due day is `due_days` working days after the day it was opened, counted on the published work calendar `DEFAULT` of the year; a year with no published calendar is counted by the week and the pass says `WEEKDAYS_ASSUMED`, never silently.

The two figures an item was opened with never change (the database guard refuses it); `latest_difference_vnd` follows later passes.

## Life of an item

`OPEN` -> `EXPLAINED` (the words of a person) -> `RESOLVED`, or -> `WRITTEN_OFF_APPROVED`; `OPEN` can also go straight to `RESOLVED` or `WRITTEN_OFF_APPROVED`; a later pass that finds the difference gone, within the threshold, or now a TIMING pair moves `OPEN` or `EXPLAINED` to `AUTO_CLEARED` with `cleared_run_id`, the pass that proves it. A write-off needs the document that approves it (a clean scan) and a person who is neither the owner, nor the person who explained it, nor the person who opened it (403 `SELF_APPROVAL_DENIED`); no figure changes.

## A pass is COMPLETE or PARTIAL, never "no difference"

A working day with no applied statement (`treasury_import.statement_date`, status APPLIED or PARTIALLY_APPLIED) **and** no Treasury transaction is `PARTIAL / STATEMENT_MISSING`; a source that cannot be read is `PARTIAL / SOURCE_UNREADABLE` (the read is inside a savepoint, so one failing source does not poison the transaction). A PARTIAL pass opens no item and clears none: a day that was not seen whole proves nothing. A day nobody works with nothing from the Treasury is COMPLETE with no line.

The job leaves a day alone while its statement is not due yet: a day within `partial_after_days` of today with no statement and no transaction is not judged and nothing is written; a manual run always judges.

## Idempotency and history

Every pass has a hash over the day, the status, the thresholds and the lines (and what each line opened). The same lines as the latest pass of the day write nothing (`reused: true`); other lines make the next `run_no`. The passes and the lines are append-only (`REVOKE UPDATE, DELETE`), the items are never deleted.

## Thresholds

Rule type `RECONCILIATION_POLICY`, code `DEFAULT`, read through `GovernancePolicyPort` (an approved version in force on the day, else the built-in default). Built-in default (a starting value that nobody confirmed; the screen says so): `threshold_vnd` 1,000,000; `due_days` 3; `partial_after_days` 1; `threshold_pct` absent. Each pass stores the version that decided, its source (`RULE` or `DEFAULT`), whether it was unverified, and the numbers it used.

## Commands and reads

| Operation | Permission | Notes |
| --- | --- | --- |
| `runTreasuryDailyRecon` | `treasury.daily_recon.run` | the whole tenant only (403 `SCOPE_DENIED` otherwise); a day not after today and not older than 400 days |
| `assignTreasuryDailyReconItem` | `treasury.daily_recon.assign` | `If-Match`; an active member and a day not before today |
| `resolveTreasuryDailyReconItem` | `treasury.daily_recon.resolve` | `If-Match`; `EXPLAINED`, `RESOLVED`, `WRITTEN_OFF` |
| `listTreasuryDailyReconRuns` | `treasury.daily_recon.read` | with `from` and `to` also the state of each day (a day with no pass is said to have none) and the thresholds in force |
| `getTreasuryDailyReconRun`, `listTreasuryDailyReconItems`, `getTreasuryDailyReconItem` | `treasury.daily_recon.read` | only the lines and items of the projects in the scope of the caller; a caller who sees part of the projects gets no tenant total |

## Alert type TREASURY_RECON_ITEM_OVERDUE

Owner: the owner of the item. Expected action: explain or resolve the difference and say what became of it. Consequence: the indicator stays flagged and an issue is opened in ISS. Severity ACTION. The job reports an item past its due day once (`overdue_flagged_at`), with the audit row `pay.treasury_daily_recon_overdue` and the outbox event `pay.treasury_daily_recon.item_overdue.v1`, whose members are those of the issue intake (ids, `reference_code` `TR-<id>`, severity MEDIUM, `alert_type`); `iss-intake.ts` has the entry for it, so ISS opens one issue and the item remembers it (`issue_id`).

The alert centre of HOME reads it as the source `TREASURY_RECON` (`packages/db/src/home-integrity-sources.ts`, kind `TREASURY_RECON_ITEM_OVERDUE`, ACTION, opens PAY-20): an item that is OPEN or EXPLAINED and past its day, for its owner and for the leader accountable for its project, and in the view scope for whoever reads the project; the issue the job opened for it (its `source_ref_id` is the item) is the same cause and is folded into the item. The alert type is seeded in the registry (`registerIntegrityRules`), the event carries the type, and the overdue gauges `pay_treasury_daily_recon_open` and `pay_treasury_daily_recon_overdue` are set by the job and by every command.

## Not done on purpose

* No change of `reconciliation_item`, of the match, or of the statement import.
* No automatic write-off, and no choice of "the larger side".
* The calendar code is `DEFAULT`; a tenant that keeps another code for the Treasury working days changes the constant `DEFAULT_CALENDAR` of the store (a rule parameter is the next step if the customer asks).
