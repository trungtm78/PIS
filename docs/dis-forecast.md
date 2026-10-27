# The year-end estimate and the cumulative curve (ST-DIS-018)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F8, BR-DIS-11). No migration. Operation: `getDisbursementForecast` (`GET /disbursement-forecasts`, permission `disbursement.read`). Screen: DIS-23, read only.

## The estimate (BR-DIS-11)

For a frozen snapshot (the latest frozen close snapshot when none is named, 422 `SNAPSHOT_NOT_FROZEN` for one that is not frozen) and the projects in the scope of the caller:

- `disbursed` is what the lines of the snapshot say the Treasury paid up to the cutoff; null when it booked nothing for the project (no data is not zero).
- For each month after the month of the cutoff, up to December: the **forecast** of the month (CAP schedule, kind `FORECAST`, current, summed over the sources and the levels of the budget), else its **registration** (`REGISTERED`), else the month is **missing**. A row for month 13 (the adjustment month) is counted when there is one and is never missing.
- `eac = disbursed + the months that are known`; `gap = eac - plan_total` (negative: the year is expected to fall short); `ratio` is the estimate as a share of the plan, one decimal.
- `coverage`: COMPLETE when every month has a figure, PARTIAL when some do not, NONE when none does. A partial estimate is a **lower bound** and no reallocation is called for it.
- `reallocation_candidate`: true when the estimate is **below 80%** of the plan (80% itself is not below), false at or above, null when the estimate is not complete, there is no plan or no Treasury data.

The totals are the sums over all the projects in the scope (a unit, or one project, when asked for); the list of projects is a page at a time (keyset cursor `code|id`). A project the caller does not see does not exist for them (404 for `project_id`).

## The curve

`curve` is the cumulative amount by month: what the Treasury paid month by month from the transactions of the year (a refund takes off) up to the cutoff, ending, in the month of the cutoff, at the figure of the snapshot; and after it the forecast on top of that figure, as far as every month is known. A month that is not known ends the line: it is not drawn as a flat stretch. The screen draws a solid line with round markers for what was paid, a dashed line with square markers for the forecast and a dotted line for the plan, names each in a legend, and puts the same numbers in a table, so that no meaning rests on colour.

## The year and the adjustment month

The plan year is the fiscal year of the period of the snapshot (as for the lines of the snapshot), not the calendar year of the cutoff. A close of December whose Treasury cutoff is in the January after is in the **adjustment month** (month 13, `cutoff_month: 13`): the figure of the snapshot already holds the payments of that month up to the cutoff, so the schedule of month 13 is not added a second time and the year ends at the disbursement. The curve then has a point for month 13 that carries the figure of the snapshot.

The curve and the estimate add up the same projects (those with Treasury data), so the last month of the curve is the estimate. A month is **complete** in the sum only when every project added up has a figure for it; the line of the forecast stops at the first month that is not complete (internal flag, not in the response). The chart scales below zero when a refund took the net disbursement under it. Further pages of the project list ask for the snapshot of the first page, so a snapshot frozen while the screen is open cannot change the list in the middle.

## Assumptions

- The threshold of 80%, the order forecast, registration, missing, and the use of the Treasury figure as the base are proposals until D03 is signed (CXN-03): the screen and the response say so (`definition_status`, `reallocation_threshold_pct`).
- The historical expected curve of the design (a month with neither forecast nor registration) needs a year of history and waits for R2; here such a month stays missing and the estimate says it is partial.
- The estimate sums the sources and the levels of the budget of the plan year of the cutoff; carried-over capital is in the plan and in the figure of the snapshot as the lines have it.
- The earlier months of the curve are read from the transactions at the time of the request, so a transaction booked after the snapshot with a date before its cutoff would move an earlier month and not the figure of the cutoff, which is the snapshot's.
