# DIS-19, DIS-12, DIS-16: the two disbursement rates over a frozen snapshot (ST-DIS-010)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F6, BR-DIS-04, BR-DIS-05, BR-DIS-08, FX-DIS-003, FX-DIS-004). No migration: the story reads the lines that ST-DIS-009 froze (`docs/dis-snapshot.md`).

## The operation

`getDisbursementRates` (`GET /disbursement-rates`, permission `disbursement.read`, scoped to the projects the caller may see):

| Query | Meaning |
|---|---|
| `snapshot_id` | The snapshot to read. The most recent FROZEN `PERIOD_CLOSE` snapshot when absent; 404 `RESOURCE_NOT_FOUND` when there is none, or it is not the tenant's. |
| `unit_id`, `project_id`, `fund_source_version_id` | Narrow the lines the sums are made of. |
| `bucket` | `CURRENT_YEAR` (default): the Treasury over the year plan. `CARRYOVER`: what was reported over the plan of the capital carried over, apart (the Treasury pays a project, not a source). Anything else is 422. |
| `group_by` | `UNIT` or `PROJECT` (additive to the contract): one row for each, every row made from its own sums. |

The answer carries the snapshot (`snapshot_id`, kind, status, `as_of_date`, `treasury_cutoff_date`, `definition_status`), the scope, the figures of the whole scope and `groups`. Every row (the whole and each group) has the same figures: `projects`, `numerator_disbursed_vnd` (null when nobody has the figure), `plan_pm_assigned_vnd`, `plan_local_added_vnd`, `plan_total_vnd`, `rate_pm_pct`, `rate_total_pct`, `rate_null_reason`, `treasury_coverage`, `reported_vnd`, `ctmtqg_subset_vnd`; and `legal_confirmation_refs: ["CXN-03"]`.

## The rules

- **One numerator, two denominators** (BR-DIS-05, FX-DIS-004): 600 million over 1 billion given by the Prime Minister and over 1.25 billion with the 250 million the province added are `60.0000` and `48.0000`. The first can pass 100%.
- **Sum over sum** (BR-DIS-04, FX-DIS-003): the database adds the lines of a group (`DisSnapshotStore.rateSums`) and the rates are made from the sums (`rateOfSums`, kernel `dis-rates`); the rate of a group is never made from the rates of its parts: 50/100 and 90/900 million are 140/1,000 = `14.0000`, where the mean of 50% and 10% would say 30%. The groups of a partition add up to the whole (`addSums`).
- **A rate with nothing to divide by is null and says why** (BR-DIS-08, AC-ST-DIS-010-3): no plan of either kind is `ZERO_DENOMINATOR` (named first, whatever else is missing, so a project with no plan has no rate even when it was paid); a plan and no payment and no report is `NO_DATA`; a Treasury that booked nothing for any line is `TREASURY_COVERAGE_NONE`. Never 0%, never infinite. A net of the Treasury below zero for the year gives no rate (`NO_DATA`). Each null is counted once by its reason: `dis_rate_null_total{reason}`.
- **Coverage** of a group: `NONE` when the Treasury booked nothing for any line (or there is no line), `COMPLETE` when it agrees with the report on every line, `PARTIAL` in between.
- The kernel change of this story: `ratesOf` of the snapshot names the plan first (BR-DIS-08 lists the denominator first); the lines of the snapshot that are built after it follow the same order.

## The screens

| Screen | Route | What it shows |
|---|---|---|
| DIS-19 | `/dis/dis-19` (`?snapshot=`, `?unit=`, `?basis=`) | A pair of tiles for the scope (never one rate alone) with the formula and `CXN-03` in the tooltip and in the text that opens, the label "CHỜ KÝ D03" until the formulas are signed, the facts (numerator, plans, cutoff, coverage); a table by project with the two rates and the Treasury coverage; the capital carried over is read apart. |
| DIS-12 | `/dis/dis-12` | The totals by unit (the unit of each line as it was when the snapshot was built), the two rates of each from its own sums, the day the Treasury figures are cut off, a row for all of them made from the sums, a link of each unit to its projects on DIS-19. |
| DIS-16 | `/dis/dis-16` | The full table of the lines of a snapshot: the project and the cell pinned, the other columns chosen by the person and kept for the next visit (`localStorage`), the two rates one choice, "Trong đó CTMTQG" a column of its own and a total of its own, never added to the 420 million of the cells (FX-DIS-001), pages of lines on request. |

The three screens choose among the frozen snapshots (`listPeriodSnapshots?status=FROZEN`); none chosen is the most recent close figure.

## Assumptions

- The formulas are the proposals of ST-DIS-009 until D03 is signed; every answer and screen says so.
- DIS-12 groups by the unit captured in the snapshot (the owner unit of the project when it was built), not by the investor unit of the register of today: a figure that has to be reproduced cannot follow a register that changes. If the capital owner wants the investor, the snapshot has to capture it (a column of the line).
- The rate of the capital carried over uses what the projects reported (the Treasury does not split a payment by source); it is read with `bucket=CARRYOVER`.
- Filtering by `fund_source_version_id` narrows the lines; the Treasury figure is carried once on the year plan of the central budget, so such a filter can leave a group without its numerator.
