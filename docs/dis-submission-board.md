# The submission progress board and the monthly narrative (ST-DIS-015)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F4, AC-DIS-07). No migration. Operation: `getSubmissionProgress` (`GET /reporting-periods/{id}/submission-progress`, permission `report.read`). Screens: DIS-15 (board), DIS-13 (monthly narrative), PRJ-13 (monthly follow-up).

## The board

For a reporting period, one row for each unit that owns projects in the scope of the caller, and a total row. The projects that must report are those at a stage that reports (`REPORTABLE_PROJECT_STATUSES`: budgeted, implementation, suspended, completed). Each project is in one state, read from the statuses of its non-deleted reports of the period (kernel `submissionStateOf`):

- **Submitted**: any report is SUBMITTED, UNDER_REVIEW, ACCEPTED, SUPERSEDED or AMENDMENT_REQUESTED (it was handed in and not taken back or returned);
- **Draft**: it has reports and none of them was handed in (a draft, a returned report, a withdrawn one);
- **Not started**: it has no report.

Counts: must report, submitted, **submitted late** (of the submitted: the lateness that was stored when the first report came in, never recomputed, BR-DIS-09), draft, not started, and **overdue**: the deadline of the period (`reporting_period.deadline_at`, by the calendar version the period is bound to) has passed and nothing was handed in (a draft or not started). Before the deadline nothing is overdue. 10 projects with 6 on time, 1 late, 2 drafts and 1 not started give 10 / 7 (1 late) / 2 / 1 / 3.

Every number drills to the exact projects it counted: `state` (`MUST_REPORT`, `SUBMITTED`, `LATE_SUBMITTED`, `DRAFT`, `NOT_STARTED`, `OVERDUE`) with an optional `unit_id` returns the projects, ordered by project code, a page at a time (keyset cursor `code|id`). The list and the number come from the same classification (`inDrill`/`tallyBoard`), so they cannot disagree.

## The monthly narrative

A monthly report (`report_type = MONTHLY`, on a `MONTH` period) cannot be sent without the causes of its narrative: `reviewReport` adds the error `VALIDATION_FAILED` on `narrative.causes_text`, so DIS-06 shows it and the send answers 422. A weekly report does not need it. DIS-13 starts the monthly draft (`post_reports` with `report_type: MONTHLY`) and edits the four sections; sending goes through DIS-06. PRJ-13 reads the board with `state=MUST_REPORT&with_narrative=true`: the narrative of the report that stands for each project (the one handed in, else the latest draft); a project with none says so.

## Monthly periods

The monthly report needs a monthly period. `POST /reporting-periods/generate` with `period_type: MONTH` now generates the twelve calendar months of a year beside the weeks (kernel `monthlyPeriods`; code `M<year>-<mm>`). A month is due on the **5th of the next month** at the deadline time of the calendar, in its time zone (constant `MONTHLY_DEADLINE_DAY`; an assumption until D03 is signed, the calendar definition holds the weekly rule only). The deadline of a period, and so its lateness, is judged by its type (`periodOfType`, `BoundPeriod.periodType`), never by the weekly rule. Other types (quarter, half-year, year) are still refused.

## Assumptions

- **Overdue is what is still not in.** A report that came in after the deadline is submitted and late, not overdue; AC-ST-DIS-015-1 (7 submitted including 1 late, 3 overdue) is read this way. If the business wants a late report to stay overdue, the tally changes in one place.
- Returned and withdrawn reports leave the project as a draft (it must hand in again); a report asked to be amended after acceptance still counts as submitted.
- The deadline is the one stored on the period; a reopening of a locked period (ST-DIS-002) does not move it, so a report handed in under a reopening is late, as `judge` already says.
- Early-warning evaluation (ST-DIS-012) reads the weekly close snapshots only: a snapshot of a monthly period is skipped (`NOT_WEEKLY`), so it cannot open or clear what the weeks have said (found by the gpt-6-astra review).
- The board is built in memory from the projects in scope (one query); a tenant with very many reporting projects would want the counts in SQL.
