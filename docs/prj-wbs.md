# The work breakdown and the milestones of a project (ST-PRJ-009)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md` (BR-PRJ-08, PRJ-05, PRJ-07, UAT-AC218, UAT-PLAN-58). Migration `V1210__prj1_wbs_milestones.sql`. Operations: `addProjectComponent`, `addProjectMilestone`, `recordMilestoneProgress` (under the version of the milestone) and `setMilestoneDependency` (new, under the version of the milestone), all `project.update`; and three reads added to the contract, `listProjectComponents` and `listProjectMilestones` (`project.read`). One error code is new: 409 `MILESTONE_STATE_INVALID`.

A project that is closed, rejected or cancelled takes no change (422 `PROJECT_STAGE_INVALID`); the reads still answer. A caller who can read the project but not update it is 403 `SCOPE_DENIED`; one who cannot see it finds nothing (404). Every write locks the project, so a code is unique inside it without a race.

## The work breakdown (PRJ-05)

A component has a code (unique inside the project: 409 `COMPONENT_CODE_DUPLICATE`), a name, a parent of the same project that has not ended (the tree goes 6 levels deep; a parent that is not found, is of another project or would make it deeper is 422 on `parent_component_id`), a planned value in whole dong, a place among its brothers (`sort_order`) and the day it is valid from. The parent of a component never changes after it is written.

**BR-PRJ-08.** The planned value of the first-level components (those with no parent that have not ended) is set against `total_investment_vnd`. When it is more, the command is still accepted (200) and answers with `warnings: [{ code: "WBS_EXCEEDS_TOTAL", wbs_total_vnd, project_total_vnd }]` (`warnings` is an empty list otherwise); `listProjectComponents` says the same with `exceeds_total`. A component under a parent adds nothing to the sum. UAT-AC218: 30 + 10 + 8 = 48 billion against 45.

`listProjectComponents` lists the components in the order of the tree (each under its parent, by place then code) with their `depth`, with `wbs_total_vnd`, `project_total_vnd` and `exceeds_total`.

## The milestones (PRJ-07)

A milestone has a code (unique: 409 `MILESTONE_CODE_DUPLICATE`), a name, an optional component and an optional milestone it waits for (both of the same project, else 422), a **baseline day that never changes** and a planned day. It starts `PLANNED`.

- **`recordMilestoneProgress`**: `DONE` needs `actual_date`, a real day that is not in the future (422 on `actual_date` otherwise; a done milestone without a day is refused, UAT-AC218); `DELAYED` needs a `planned_date` later than the one it has and a reason of 5 to 2000 characters, and moves the planned day (the baseline stays); `CANCELLED` needs a reason. Each refuses the fields of the others. A milestone that is `DONE` or `CANCELLED` is not changed again (409 `MILESTONE_STATE_INVALID`); a delayed one may be delayed again, done or cancelled. The reason is kept on the milestone and in the `reason` of the audit row.
- **`setMilestoneDependency`**: makes the milestone wait for another one of the project, or for none (`null`). A dependency that would close a loop, including a milestone waiting for itself, is 409 `DEPENDENCY_CYCLE` and the dependencies stay as they were (UAT-PLAN-58); the database refuses a loop as well.
- **The delay** is counted in calendar days from the baseline: a milestone that was done is late by the days between its baseline and the day it was done; one that is still open by the days between its baseline and its planned day, or today when the planned day has passed; a cancelled one is late by none. `listProjectMilestones` returns `delay_days` and `delayed` (more than 0 days), so a milestone done 15 days after its baseline (UAT-AC218: 2026-02-15 and 2026-03-02) reads as late by 15 days.

Progress and dependency changes leave the audit row and `project.milestone_updated.v1` (the project, the milestone, its status, the baseline, planned and actual days and the delay).

## The screens

**PRJ-05** (`ComponentsScreen`) shows the tree with each component's code, parent and value, the first level against the total with the warning in words, and a form to add a component. **PRJ-07** (`MilestonesScreen`) shows each milestone with its baseline, planned and actual day, what it waits for and its status; a late milestone also carries a pill with the days (words, not colour alone); a dialog records the progress (done on a day, delayed to a later day with a reason, cancelled with a reason) and another changes the milestone it waits for, listing only the milestones that would close no loop. Both keep the project in the address (`?id=`) and start over when it changes.

## What is not done

- A component is not edited or retired after it is written (no command changes its value, name or validity); the sum of the children is not set against the value of their parent.
- A milestone cannot be done before the milestone it waits for, because the module document does not say so.
- The milestone dependencies are a flat list, not a chart; `project.milestone_updated.v1` is not consumed by anything yet.
