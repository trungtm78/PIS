# DIS-21: the period snapshot, built and frozen (ST-DIS-009)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F6, BR-DIS-01 to 06). Migration: `V1048__dis1_period_snapshot.sql`. Screen DIS-21 (`/dis/dis-21`).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `buildPeriodSnapshot` | `POST /period-snapshots` | `snapshot.build` | Builds the figures of a period for a kind (`PERIOD_CLOSE`, `ADHOC`, `MNE`) and a Treasury cutoff. The snapshot is BUILDING: nothing is frozen. |
| `freezePeriodSnapshot` | `POST /period-snapshots/{id}/freeze` | `snapshot.freeze` | Freezes a snapshot that was built, under the version the screen showed: the hash of what it holds is kept, the one frozen before for the same period and kind becomes SUPERSEDED. |
| `listPeriodSnapshotLines` | `GET /period-snapshots/{id}/lines` | `disbursement.read` | The lines of a snapshot in the scope of the caller, by project and cell, a page at a time. |
| `listPeriodSnapshots` | `GET /period-snapshots` | `disbursement.read` | Additive read for the screen: the snapshots of a tenant, newest first, narrowed by period, kind and status. With a period it also names the reports that were handed in for it and are not accepted. |

## What a line says

One line for each project and each of the six cells of the report (BR-DIS-01), written when the snapshot is built and never touched again:

- the plan in force at the end of the period (the newest version of the project published up to that day, in the fiscal year of the period), split into `plan_pm_assigned_vnd` (what the Prime Minister gave, and the capital carried over from it) and `plan_local_added_vnd` (a province, a ministry, a revenue increase) by the origin of the allocation line (`planSplitOf`), and `plan_total_vnd` (the two together);
- `disbursed_reported_vnd`: the cumulative of the **accepted** report of the period (the current revision that is ACCEPTED or AMENDMENT_REQUESTED), never a sum of periods (BR-DIS-02); a cell nobody reported is null, not zero; a report that was handed in and is not accepted is not in the figures and is named apart;
- `period_delta_vnd`: that cumulative less the accepted cumulative of the latest earlier period of the same type and year; null when there is no earlier period (not a change of zero);
- `disbursed_treasury_vnd`: what the Treasury paid from the first day of the year up to the cutoff, by the Vietnam day it paid it, a refund taken off on the day of the refund (BR-DIS-06, FX-DIS-005). The Treasury pays a project and not a source, so the figure is carried once, on the year plan of the central budget, with the two rates; null when it booked nothing;
- `ctmtqg_subset_vnd`, `registered_month_vnd` from the report; `forecast_eac_vnd` stays null until ST-DIS-018;
- the two rates, `rate_pm_pct` and `rate_total_pct` (BR-DIS-05, four decimals, rounded half up from whole numbers, never a float), with `rate_null_reason` (`ZERO_DENOMINATOR`, `NO_DATA`, `TREASURY_COVERAGE_NONE`) when one cannot be given: a rate with nothing to divide by is null, never zero (BR-DIS-08);
- a Treasury net below zero for the year (a refund of a payment of the year before) is shown as it is, with no rate (`rate_null_reason` `NO_DATA`) and `PARTIAL` coverage: it is a figure to look at, not a rate;
- `treasury_coverage`: `NONE` when the Treasury booked nothing, `PARTIAL` when there is no accepted report to compare with or the two differ by more than 5% (assumption), otherwise `COMPLETE`.

The snapshot carries `metric_set_version` (`DIS-METRICS-R1-PROPOSED`) and `definition_status`: `PROPOSED_PENDING_SIGNOFF` until every term that the glossary requires of the domain `DISBURSEMENT` (the five definitions of ST-MDM-008: `GIAI_NGAN_PERIOD`, `GIAI_NGAN_YTD`, `GIAI_NGAN_PTD`, `MAU_SO_KH_TTG_GIAO`, `MAU_SO_KH_TONG`; `GlossaryStore.definitionStatus`, the snapshot keeps no list of its own) is PUBLISHED in the glossary of the tenant, then `SIGNED` (CXN-03; DIS-21 shows the badge "CHỜ KÝ D03").

## Build and freeze

- **Build.** The period is held (a shared lock) until the transaction ends. A cutoff has to be a real day, not before the period began and not after today (422 `treasury_cutoff_date`); `as_of_at` cannot be in the future. The official figure of a period (`PERIOD_CLOSE`) is built once the period is no longer open (409 `PERIOD_STATE_INVALID`; the job `dis.snapshot-weekly` builds after the lock) Every snapshot holds the whole tenant: a person whose `snapshot.build` covers only a part of the projects gets 403 `SCOPE_DENIED` for every kind (a part-built snapshot would replace the build that someone else is waiting to freeze, and would not be the figure of the executive). One build of a period and a kind holds its turn at a time (an advisory lock: a second one is 409 `SNAPSHOT_BUILD_IN_PROGRESS`, it does not wait), and a build that was never frozen is replaced by the next one (it becomes FAILED: it is not an official figure and cannot be frozen any more). The lines are read with a query for each kind of data, never for each project.
- **Freeze.** For a person whose `snapshot.freeze` covers the whole tenant (403 `SCOPE_DENIED` otherwise, before anything is touched). Locked under the version shown (409 `VERSION_CONFLICT`). 409 `SNAPSHOT_FROZEN` for a snapshot that is FROZEN or SUPERSEDED, 409 `SNAPSHOT_NOT_BUILT` for one that is FAILED. The hash is the SHA-256 of the header (period, kind, day, cutoff, formulas, definitions) and every line, in an order that does not depend on how they were read (`snapshotHash`): the same figures give the same hash and a changed figure does not. The previous FROZEN snapshot of the same period and kind is moved to SUPERSEDED first (its hash and lines do not change); the new one keeps `supersedes_id`.
- **The table.** `period_snapshot_guard` fixes what a snapshot is (period, kind, days, formulas, maker), allows only BUILDING to FROZEN or FAILED and FROZEN to SUPERSEDED, keeps a frozen snapshot's hash, who, when, row count and `supersedes_id`, and refuses a delete. `period_snapshot_line_guard` allows an insert only while the parent is BUILDING and refuses every update and delete. V002 holds one FROZEN snapshot for a period and a kind, the frozen check and the null reason of a rate.

The audit rows are `dis.snapshot_built` and `dis.snapshot_frozen` (counts, hash and ids, never an amount); the events are `snapshot.built.v1` and `snapshot.frozen.v1 {snapshot_id, period_id, as_of_date, treasury_cutoff_date, definition_status}`; the metrics `dis_snapshot_build_total` and `dis_snapshot_freeze_total` (by kind).

## The screen

DIS-21: year and period, the form of a build (kind, Treasury cutoff, starting at the last day of the period), the snapshots of the period with status, cutoff, label of the definitions ("CHỜ KÝ D03" until signed), short hash (the whole hash in the title of the cell) and the lines button; "Đóng băng" for a snapshot that was built, only for a person who holds `snapshot.freeze`, behind a confirmation that says what the freeze does and under the version the list showed; the reports waiting for review apart; the lines of the chosen snapshot with both rates side by side (never one alone), a figure nobody has as a dash with its reason, the change of the period with its sign, and "Tải thêm" for the next page. A locked period leads to DIS-22.

## Assumptions

- The formulas are proposals until D03 is signed: the split of the plan by origin (`LOCAL_ADDED`, `CENTRAL_SUPPORT`, `REVENUE_INCREASE` count as local), the 5% threshold of the Treasury coverage, the cutoff day by the Vietnam clock, the Treasury counted from 1 January of the fiscal year, and the Treasury carried once on the year plan of the central budget.
- The Treasury source is `treasury_transaction` (`confirmed_at` read as the Vietnam day it was paid; a refund is a row with `direction` REFUND) until PAY gives `treasury_paid_on`.
- `FAILED` is used for a build that a newer build replaced, so that the status list of the table (V002) stays as it was.
- The job `dis.snapshot-weekly` (build and freeze after the lock) and the performance test of 1,000 projects (AC-ST-DIS-009-5) are left for the platform slice that runs Temporal and the staging dataset; the build is set based, with a query for each kind of data.
