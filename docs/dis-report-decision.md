# DIS-6: the decision of a reviewer, the return, the request for an amendment and the chain of corrections (ST-DIS-006)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F2, the state machine of section 4, BR-DIS-02). Migration: `V1045__dis1_report_decision.sql`. Screens DIS-07 (`/dis/dis-07?report=<id>`, the detail and the decision), DIS-08 (`/dis/dis-08?report=<id>`, the correction) and DIS-11 (`/dis/dis-11?report=<id>`, the history and the comparison).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `post_reports_id_decision` | `POST /reports/{id}/decision` | `report.review` | `approve`, `return` or `request_amendment`, with the version the screen showed in `If-Match`. |
| `post_reports_id_corrections` | `POST /reports/{id}/corrections` | `report.correct` | The next revision of a report that was accepted, returned or asked to be amended: a DRAFT that names the revision it corrects and why. |
| `getReportRevision` | `GET /reports/{id}` | `report.read` | Returns the decisions (`decisions`), who handed the report in and who accepted it, `returned_reason`, `supersedes_id` and `amendment_reason`. |

## The decision (AC-ST-DIS-006-1, AC-ST-DIS-006-3)

The graph is the one of the state machine and the table (`report_revision_guard`) refuses any other move: SUBMITTED or UNDER_REVIEW to ACCEPTED or RETURNED, ACCEPTED to AMENDMENT_REQUESTED, ACCEPTED or AMENDMENT_REQUESTED to SUPERSEDED. A decision off the graph is 409 `REPORT_STATE_INVALID` naming the status.

- `approve` makes the report ACCEPTED and the current one (`accepted_by`, `accepted_at`); the revision that was current before it becomes SUPERSEDED in the same step, so there is one current revision of a project in a period (V002 `current_report`).
- `return` needs `return_items` (1 to 20 items of 3 to 2000 characters, each once) and `due_at` after the decision (422 `VALIDATION_FAILED` naming `return_items` or `due_at`). The reason is kept on the report (`returned_reason`).
- `request_amendment` is for the accepted report; the reason is required, the items and the day are optional. The report stays the current one until the corrected revision is accepted, and the period after it keeps taking its change from it (the baseline of BR-DIS-03 reads an accepted report and one that is asked to be amended).
- `reject` is in the contract and not in the state machine: it is 422 on `decision`.
- Maker-checker: the person who handed the report in never decides on it, whatever the decision (403 `SELF_APPROVAL_DENIED`, state first, then the person; the denied attempt is on the trail as `command.denied:post_reports_id_decision`). The table says so twice (`report_revision_sod_chk` and the guard of `report_decision`).
- Every decision is kept once in `report_decision` (who, when, why, the evidence ids, the items, the day) and is never edited or deleted. The audit row (`dis.report_accepted`, `dis.report_returned`, `dis.report_amendment_requested`) keeps ids, codes and counts, never the words. The events are `report.accepted.v1` and `report.returned.v1` (the latter for a return and for a request for an amendment, with `decision`, the reason, the items and the day, which is what the notification to the maker needs).

## The correction (AC-ST-DIS-006-2)

A correction starts from a report that was accepted, returned or asked to be amended (409 `REPORT_STATE_INVALID` from any other), in a period that takes it (409 `PERIOD_LOCKED` unless an approved reopening names the project), and only from the latest revision. The reason is judged by the command, not by the schema: missing or under 10 characters is 422 `CORRECTION_REASON_REQUIRED` naming `amendment_reason`. A revision that is waiting (a live draft, or one handed in and not decided on) is 409 `REVISION_PENDING_EXISTS` naming it (`report_id`, `revision`, `report_status`); two makers at once get one draft (the unique index of the live draft decides).

The new revision carries over the cells, the volumes, the narrative and the files of the one it corrects, on the plan version in force at the end of the period. The cells and the volumes the request names replace the same ones (a cell it names keeps the registration for next month and the year of its source that the request does not name), and the explanation of a fall can be given. The revision that was corrected is never edited and keeps its `payload_hash`. The draft is edited, reviewed and handed in like any other (DIS-03 to DIS-06); when it is accepted it takes the place of the revision it corrects (BR-DIS-02). The event is `report.correction_started.v1`.

## The screens

DIS-07 shows the six cells with the CTMTQG apart, the explanation of a fall, the volumes, the registration for next month, the notes and the files as they were handed in (a reviewer reads all of it there), whether the revision is the current one, which revision it corrects and why, the decisions with what a return asked to be fixed and by when, and the buttons of the person: accept or return (reviewer), ask the amendment of the current accepted report (reviewer), correct (maker). DIS-08 puts the figures of the corrected revision beside the new ones, asks the reason, and leads to the new draft (DIS-04). DIS-11 lists every revision of the project in the period (all the pages) with the current one marked and compares two of them cell by cell with the change signed (a fall is negative and in colour, never zero; AC-ST-DIS-006-4). The list DIS-01 opens a draft on DIS-04 and every other report on DIS-07.

## Assumptions

- UNDER_REVIEW is reachable in the table and decidable from, but no command sets it: the design says "when a reviewer opens the report", and a read must not change a report. The withdrawal story (ST-DIS-007) says whether a reviewer's opening is a command of its own.
- Maker-checker is always on; there is no tenant setting that turns it off.
- `evidence_ids` are kept as given (up to 20 ids, each once); what they point at has no store in R1 to check them against.
