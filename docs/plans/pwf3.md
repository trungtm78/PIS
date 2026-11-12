# PWF-3: KPIs of the workflow and the scores of the staff (lane pwf3)

Branch `lane/pwf3` (from main 39c7d7738). Spec: `Design/MACHVON_Design/01_Documents/05_modules/PWF.md` sections 3 F9 and F10, 5 BR-PWF-30 to 42, 6, 7; ledger R33, R34, R37, R43 of the plan "Đợt mới 2026-11-12".

## What the lane built

- **Migrations V3030 to V3034** (end of the block 3020 to 3039; V3020 to V3029 are left to pwf2 and are listed as `retired` in `blocks.json` of this branch until the two lanes merge): `task_kpi_result` (append only, a correction is a new row that names the old, one head per KPI), `staff_score_period` (DRAFT, LOCKED, OFFICIAL with trigger, no way back, overlap exclusion), `staff_score_line`, `staff_score_adjustment`, `staff_score_response`, `staff_score_signal` with the policy `scope_units_guard`, the retention function `pwf_expire_staff_scores`, and `project_task.kpi_recorded_version` for the incremental pass.
- **Privacy at the database (R33).** The policy of the four personal tables reads `app.scope_units` (`*` or the ids of the units, from the unit of the person at the period, kept on the line) and `app.score_subject`; without them no row is seen and none is written. The signals have no subject alternative. The application sets both through `enterScoreScope` before each read, from the grants held now (`scoreUnitsOf`), so a revoked grant reaches nothing and a manager of another unit gets 404.
- **Stores (`packages/db/src/pwf-*.ts`).** `pwf-score-facts` (batch loading of the facts of tasks, whatever their number), `pwf-kpi-store` (results, incremental), `pwf-score-compute` (pure: inputs to lines and signals, snapshot, hash, `verifySnapshot`), `pwf-score-store` (compute, lock, officialize, verify, retention), `pwf-score-adjustment-store` (adjustments and responses), `pwf-score-reads` (scoped reads, source authorisation of the tasks behind a point), `pwf-score-job` (hourly: results, officialize, retention).
- **API (`apps/api/src/modules/pwf`).** `kpi.controller` (getKpiOperations, listTaskKpiResults), `score.controller` (the seven commands), `score-reads.controller` (periods, lines, my score, line, compare, signals, export, overview), `score-response.flow` and `score-response.binding` (clock, ADM instance, real final command of the business type `score.response`).
- **Contract.** One operation added: `getStaffScoreOverview` (`staff_score.read_hr`), because a role can hold only permissions that appear in `openapi.json`, and `read_hr` of the spec had no operation; `StaffScorePeriod.policy_rule_id` became nullable (the built-in default has no rule row). Kernel: business type `score.response`, `assertAdjustmentRequestable`, the words of the export.
- **Web** (commits 5af964282 to d09d18afd): PWF-09 to PWF-14, KPI picker in the template editor, privacy of the cache, help topics, parts `pwf3web.*`.

## Decisions taken (owner rule: deepest governance, no cut of scope)

1. A task is scored in the period it is **resolved** (done or cancelled in it); a task still open at the end of a period whose baseline is due is scored there as overdue, in memory (not recorded), so that leaving a task open never hides it. Open tasks are read as of the end of the period, never as of the day the period is computed.
2. The window of a task for the split between holders is its **whole life** (start to end), not the part inside the period, so the score follows the person who did the work whenever the task closes.
3. The score uses the results recorded at the close of each task (`task_kpi_result`, the head of each KPI); a corrected fact adds a row, the locked period keeps pointing at the row it read through its snapshot.
4. The snapshot holds the inputs (policy params, KPI results with their hashes, calendar versions, the ledger, baselines, the people and their units) and the figures; its hash is taken over both, and `verify` computes the lines again from it.
5. An adjustment is asked for by one person and decided by another who is neither the maker nor the person scored; the sum of the approved points of a line stays inside `max_adjustment_points`; the computed score is never touched.
6. A response goes through the ADM engine when the tenant published a workflow for `score.response`; otherwise someone with `staff_score.approve` handles it directly. Both keep the clock `PWF_SCORE_RESPONSE` of the alert centre and end in the same domain step.
7. `handleStaffScoreResponse` takes the **version of the line** in `If-Match` (the response has none in the contract).
8. Signals of splitting use the phase of a task added by the project (own task) as the parent, because a task has no parent column.

## Not done here (named)

- Replacement period (`supersedes_period_id` exists in the table and the answers, no command writes it yet); a post-close correction is an adjustment, or a new draft after the old period is superseded by hand.
- `ALERT_TYPE` `PWF_SCORE_RESPONSE_OPEN`: the response shows in the alert centre as a native clock (`CLOCK_DEADLINE`); a typed alert needs a `WORK_SOURCES` entry, which is the lane of pwf2.
- Phone screens (MOB-81) and PWF-15.
- WEB-E2E cases UAT-PWF-10, 11, 12, 14 stay PLANNED (they need the e2e stack, which this lane does not run).
