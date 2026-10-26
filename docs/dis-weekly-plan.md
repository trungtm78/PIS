# The weekly plan against the Treasury actuals (ST-DIS-014)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F8, Directive 162, FR-DIS-24). No migration. Operation: `listWeeklyDisbursementPlans` (`GET /weekly-disbursement-plans`, permission `disbursement.read`). Screen: DIS-24, read only.

## What it shows

One row for each project and week that has a current weekly commitment (`disbursement_schedule_line`, kind `WEEKLY_COMMITMENT`, grain `WEEK`, `is_current`; the cells of a week, by bucket and budget level, are added up):

- the commitment of the week;
- what the Treasury paid in the week (`actual_vnd`): the cumulative of the frozen close snapshot of the week less the cumulative of the latest week frozen before it (kernel `weeklyActual`). The first frozen week of the year is counted from the first day of the year and says so (`actual_from_year_start`). A week that is not frozen has no actual (`null`, not zero) and no difference. A week frozen with no figure for the project is a week of nothing paid. A refund can make a week negative; it is kept as it is;
- the difference (`difference_vnd` = actual less commitment, so a week that fell short is negative: -80 000 000 for 200 million committed and 120 million paid);
- the leader in charge: the current ACTIVE `LEADER_IN_CHARGE` of the project, with their display name; none when nobody is assigned.

A plan is never added to a disbursement: they are two columns and their difference. The read is bounded by the project scope of the caller (`projectScope`); the order is by project code and week start, paged by keyset cursor (`code|start_date`). `plan_year` defaults to the Vietnam year of the clock and must be 2000..2100; `project_id`, `unit_id`, `limit` and `cursor` are validated (422 `VALIDATION_FAILED`).

## Assumptions

- The weekly commitments are registered by CAP (`registerDisbursementSchedule` with the kind `WEEKLY_COMMITMENT`); this story only reads them. DIS-24 has no button that registers or changes one.
- The frozen weeks that give the actual are those of the fiscal year of the period the commitment names (CAP does not require it to equal the plan year); the cumulative starts again each fiscal year; the frozen snapshot of a week is its latest frozen `PERIOD_CLOSE` snapshot.
- The two-consecutive-negative-weeks warning (EW-09) belongs to the warning deepening story, not to this one.
