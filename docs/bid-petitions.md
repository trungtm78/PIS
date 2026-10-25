# BID: the petitions of contractors (ST-BID-007, slice BID-1)

A contractor that disagrees with how a selection was run, or with its result, petitions the procuring entity (BID 3 F7, BR-BID-14). The entity answers with a document before a
deadline that the law sets (CXN-BID-02), or passes the petition on to the level above. This story keeps the petition, counts the deadline from **rule data**, shows what is overdue and
reminds the people who handle it.

## The deadline is rule data (BR-BID-14)

The master rule type `BID_PETITION` (platform-owned, `PLATFORM_ONLY`) has one entry for each kind of petition, `PROCESS` and `RESULT`:

| attribute | meaning |
|---|---|
| `days` (1..366) | the days the answer may take |
| `day_count` | `CALENDAR`, or `WORKING` with `calendar_code` naming a published ADM working calendar (exactly when `WORKING`) |
| `filing_days` (`RESULT` only, optional) | the days after the result is approved within which a petition about it may be lodged |
| `legal_basis`, `awaiting_confirmation`, `cxn` | the law the number comes from, and the confirmation it waits for (`CXN-BID-02`) |

The baseline pack carries seven calendar days for both kinds, flagged as waiting for the confirmation (the stricter reading of "7 working days"); a tenant that counts working days
publishes a version that names its calendar. The rule in force on the day a petition is **received** decides; the petition stores `days_applied` and `rule_version_id` and keeps them. No
rule in force is 422 `TIMER_RULE_UNCONFIRMED`; a count that passes into a year with no published calendar is 422 `CALENDAR_NOT_EFFECTIVE` (`addWorkingDays`, never a guess).
`due_on` is the **last day** to answer: the petition is overdue the day after.

## Commands

| command | rule | refusal |
|---|---|---|
| `receiveProcurementPetition` (`bid.petition.manage`) | the day is a day, not after today; a package of the scope; a contractor and a paper of the tenant; a petition about the result needs an **approved result** of the package, not before the day it was approved, and within `filing_days` of it when the rule sets them; one paper lodges one petition | 422 `VALIDATION_FAILED`, 404, 422 `PETITION_OUT_OF_TIME` (`reason`: `FUTURE`, `NO_RESULT`, `BEFORE_RESULT`, `FILING_WINDOW_PASSED`), 409 `PETITION_STATE_INVALID` (`DOCUMENT_ALREADY_LODGED`) |
| `resolveProcurementPetition` (`bid.petition.manage`, versioned) | `RESOLVED` answers it, `ESCALATED` passes it to the level above; each rests on a document of the tenant that is not the petition itself; an escalated petition is then `RESOLVED` by the level above | 422 `VALIDATION_FAILED` (no document), 409 `PETITION_STATE_INVALID`, 409 `CONFLICT_OF_INTEREST_BLOCKED`, 409 version |
| `listProcurementPetitions` (`bid.read`) | the petitions of the packages in the scope, the ones that wait first, `overdue` and `days_overdue` read from the clock, `viewer_in_conflict` and `actions.resolve` for the caller | 422 |

**Conflict of interest (AC-2).** Whoever has a declaration of conflict that stands between them and the contractor (the contractor named, or the whole package, and not allowed:
`BidConflictStore.blockingDeclaration`) does not answer the petition: 409 `CONFLICT_OF_INTEREST_BLOCKED` (`conflict_of: HANDLER`). The petition stays `RECEIVED`; a different person answers it.
The list tells the caller (`viewer_in_conflict`) and the screen offers them no button.

## The job `petition-due`

Hourly and idempotent (`docs/runbooks/jobs.md`): a petition `RECEIVED` or `PROCESSING` whose `due_on` has passed is overdue; the first pass that finds it overdue sends **one** reminder
(`bid.petition.overdue.v1`, a registered notification event type, about the package so the reader holds `procurement_package.read`), remembered in `overdue_notified_at`, and writes the audit row
`petition.overdue`. The gauge `bid_petition_overdue` feeds the alert `BID_PETITION_OVERDUE`. The job never answers a petition and never moves a deadline.

## The table (V1348)

`days_applied`, `rule_version_id`, `resolved_at`, `overdue_notified_at`; checks (the deadline is not before the day received, an answered petition has its document, its handler and its day, a petition that
waits has none); a unique index on the paper; the guard `guard_procurement_petition` (what a petition says never changes, the edges `RECEIVED → PROCESSING | RESOLVED | ESCALATED | WITHDRAWN`,
`ESCALATED → RESOLVED`, an answered or withdrawn petition is kept); `DELETE` and `TRUNCATE` revoked.

## Screen BID-20

`/bid/bid-20?package=<id>`: the package picker, the petitions with the last day, the days of the rule and the overdue badge, the dialogs to log and to answer a petition, and the declarations of
conflict of interest of the package (the same panel as BID-05, where they are declared and decided).
