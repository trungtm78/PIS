# FND-1: the generalised funding and period model (semantics spec and what is implemented)

Status: **APPROVED** by the owner rule of 2026-11-08 (decide by the deepest governance, never cut scope; eng-review R15 asks for the approval before RPT-1, IND-1 and ENT-1 consume the model). **Steps 2, 3 and 4 are implemented** (section 13 lists what is built, what changed against this text and the kernel API that the later lanes consume); step 5 (the contract migration) waits for a later release by design. Every number or rule here that comes from the law or from the customer is marked **[ASSUMPTION A-n]** and listed in section 11. Module documents it reads and extends: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F1, F6, BR-DIS-01 to BR-DIS-13, DIS-19, DIS-21, DIS-24), `CAP.md` (F1, F6, BR-CAP-04, BR-CAP-10, BR-CAP-11, `appropriation`, `allocation_line`, `disbursement_schedule_line`), `MNE.md` (F3, BR-MNE-02, BR-MNE-05, `mne_report_form.schema_json`), `HOME.md` (HOME-01, HOME-03, BR-HOME-03). Code read: `packages/kernel/src/dis-report.ts`, `dis-snapshot.ts`, `dis-rates.ts`, `dis-progress.ts`, `analytics-rule-defaults.ts`, `governance-rules.ts`; `db/migrations/V002__schema.sql` (the bucket CHECKs), `V1362`.

The five steps of FND-1: (1) this spec (approved); (2) kernel: `FUNDING_TAXONOMY` rule type, figure engine, golden test (done); (3) migrations V2060 to V2064 (expand, done); (4) stores, controllers, screens (done: the figure store, ten operations, three screens DIS-27 to DIS-29); (5) contract migration V2065 (narrow: drop the defaults, make the pack part of the keys): not written, it belongs to the release after the one that ships steps 2 to 4.

## 1. The rule that governs the rest

**The public pack does not change.** Every figure, rate, null reason, rounding, hash and screen of the public edition stays byte-identical (section 9 says how this is proved). The model below is a generalisation in which the public edition is one instance (`PUBLIC` pack); it never reinterprets a public number.

## 2. What the system does today (the baseline)

| Fact | Where |
|---|---|
| A report and a snapshot count disbursement in **six cells**: bucket `CURRENT_YEAR`, `CARRYOVER`, `OTHER` times budget level `CENTRAL`, `LOCAL`; CTMTQG is a subset (never added) of the first two buckets (BR-DIS-01). | `dis-report.ts` `FUNDING_BUCKETS`, `BUDGET_LEVELS`, `FUNDING_CELLS`, `takesCtmtqg` |
| The bucket and level lists are **closed in the database** in six places (inventory in 7.1). | `V002__schema.sql` lines 1904-1905, 2133-2134, 2270, 2375-2376; `V1362` (`origin`); line 2474 (`denominator_kind`) |
| Plan: the plan version in force at the end of the period (CAP BR-CAP-10) is split into the part the Prime Minister gave (`PM`) and the part added locally (`LOCAL`) by the **origin** of the allocation line (`planSplitOf`). | `dis-snapshot.ts` |
| Actual: **the Treasury** (`treasury_transaction`, by the day it paid, reversals on the day of the reversal, from 1 January to the cutoff, BR-DIS-06) is the numerator of both rates, carried once per project on the line `CURRENT_YEAR/CENTRAL`; the **reported** cumulative of the accepted report is kept per cell and is the numerator of the carried-over rate. | `treasuryDisbursed`, `buildLines`, `rateOfSums` |
| Cumulative is **as reported** (year to date, BR-DIS-02, BR-DIS-12); the change of a period is the cumulative less the cumulative of the earlier period of the same type and year, null when there is none, a fall kept as a fall (BR-DIS-03). | `deltaOf`, `periodDeltaOf` |
| Two rates over one numerator, sum over sum, four decimals half up from whole dong, null with a reason (`ZERO_DENOMINATOR`, `NO_DATA`, `TREASURY_COVERAGE_NONE`), never zero (BR-DIS-04, 05, 08). | `ratesOf`, `groupRate`, `rateOfSums` |
| Period: weekly and monthly report revisions; `reporting_period.period_type` already allows `WEEK`, `MONTH`, `QUARTER`, `HALF_YEAR`, `YEAR` with status `OPEN`, `SOFT_CLOSED`, `LOCKED` and no overlap per (calendar, type); the schedule line allows months 1 to 13 (13 is the rectification period, CXN-31). | `V002` 2184-2204, `disbursement_schedule_line` |
| Snapshot: `PERIOD_CLOSE`, `ADHOC`, `MNE`; frozen with a SHA-256 of header and lines; carries `metric_set_version` and `definition_status`, **no taxonomy**. | `snapshotHash` |

What the enterprise edition needs and the code lacks: a second taxonomy (own equity, loan, other); a plan with an original and adjusted version, a quarter and a month phasing; an **estimate** for a period that is later replaced by an **actual** with the conversion kept; actuals from the **accounting system** (Oracle EBS) with a rule for when it and the report disagree; cumulative year to date **and since the start of the project**; monthly and quarterly snapshots for the parent group (PVN) that are immutable once closed, with a restatement path that never rewrites them.

## 3. Vocabulary and the shape of a figure

A figure is addressed by seven coordinates: **project** `j`, **class** `c` (first axis, stored in the existing column `bucket`), **tier** `t` (second axis, stored in `budget_level`), **measure** `m`, **figure kind** `k`, **plan year** `y`, **period** `p` (grain `g`, ordinal `o`), read **as of** a date `a` (the knowledge date) with actuals cut off at `a_c` (public: `treasury_cutoff_date`).

- **Class and tier** are defined by the taxonomy pack (section 4). The physical column names stay `bucket` and `budget_level` (renaming is not part of FND-1: it would touch every reader for no gain); documents and the contract call them class and tier from FND-1 on.
- **Measure** `m` says what is counted. Public: `DISBURSED` only. Enterprise: `EXECUTED` (value of the work done and recognised in the accounts) and `DISBURSED` (paid) **[ASSUMPTION A-1]**: the customer's forms are expected to carry both; the dictionary (IND-1) decides. A measure is never added to another measure.
- **Additive** money (a sum of the figures of projects, units, classes is the figure of the whole) versus **non-additive** (rates, shares, counts of kinds): rates carry numerator and denominator (BR-HOME-03) and a group's rate is Σ numerators over Σ denominators, never the mean of rates (BR-DIS-04). A subset or tag amount ("of which CTMTQG") is shown apart and is never in a total (FX-DIS-001).
- **Whole dong** as text, never a float; percent with four decimals, half up, computed from `bigint` (`percentWithFourDecimals`). Unchanged.
- **Absent is not zero.** A figure nobody has is `null` with a reason; in a **denominator** an absent plan counts as 0 and gives `ZERO_DENOMINATOR` (BR-DIS-08); in a numerator an absent figure gives `NO_DATA`. Never an exception, never 0%, never infinite.

## 4. `FUNDING_TAXONOMY`: the rule type (step 2)

A new `GovernanceRuleType` in `governance-rules.ts`, registered by a domain function (`registerFundingTaxonomyRules`, the pattern of Wave 0 step 1), versioned and approved through the governance store (maker is not checker, ADM-11 audit, outbox event on approval). `code` is the pack code. Modules hint: `['DIS', 'CAP', 'MNE', 'BI']`.

### 4.1 Params (the closed schema language of the module: `int`, `text`, `enum`, `list`, `object`)

| Param | Shape | Meaning |
|---|---|---|
| `pack_label` | text | Name shown to people ("Công", "Doanh nghiệp"). |
| `classes` | list of object (max 12, at least 2) `{ code (rule code pattern), label, additive: bool, takes_subsets: list of subset code }` | First axis. Must contain `OTHER`: nothing is unclassified. Codes are immutable once a snapshot used the version. |
| `tiers` | list of object (max 6, at least 1) `{ code, label }` | Second axis. A pack with no second axis has the single tier `ALL`. |
| `subsets` | list of object `{ code, label, of_classes }` | "Of which" amounts, never added (CTMTQG). Each must be a subset of listed classes and never exceeds its parent cell (`SUBSET_EXCEEDS_PARENT`, unchanged). |
| `tags` | list of object `{ code, label, carries_amount: bool }` | Descriptive labels on a line (lender, instrument). A tag with `carries_amount` is a subset by another name; one without is a label. Tags never change a total. |
| `measures` | list of `DISBURSED` / `EXECUTED` | Measures the pack counts. |
| `origin_groups` | object `{ PRIMARY: list of origin, ADDED: list of origin }` | Maps the origin of a plan line (CAP `origin`) to the part of the denominator it belongs to; every origin the pack accepts appears in exactly one list. Replaces `planSplitOf` as data, with the same answer for the public origins. |
| `entry_mode` | enum `CUMULATIVE_ENTRY`, `PERIOD_ENTRY` | What the person types in a report: the cumulative (public) or the period figure (enterprise); the other is derived (identity I-CUM). |
| `phasing_must_sum` | boolean | Whether quarter and month plans must add up to the year plan in force (hard rule `PHASING_SUM_MISMATCH`). Public false (as today: the registration of the month is a project's own), enterprise true **[A-2]**. |
| `actuals_source` | object per class `{ class_codes, source: TREASURY / ERP / REPORTED }` | Where `ACTUAL` of a class comes from (section 6). |
| `actuals_precedence` | enum `TREASURY_HEADLINE`, `REPORTED_UNTIL_RECONCILED` | The precedence rule (6.3). |
| `variance_tolerance` | object `{ pct, abs_vnd }` | Above it a difference between two sources needs an explanation (6.4). |
| `ratios` | list of object `{ code, numerator, denominator, class_filter, basis }` | Which of the ratios of section 5.3 the pack publishes. |
| `period_grains` | list of `WEEK`, `MONTH`, `QUARTER`, `YEAR` | Grains of figures the pack accepts. |

`refine` (cross-field, returns the offending field): class codes unique; `OTHER` present; every `of_classes` and `takes_subsets` code exists; `tiers` is `ALL` alone or two or more codes; `origin_groups` lists disjoint sets; every `ratios[].numerator` and `denominator` names a figure of 5.2; `actuals_source` covers every class.

### 4.2 Built-in defaults

**`PUBLIC`** (not marked unverified for the shape, which is the paper form SRC-01 to SRC-06; the formulas stay "CHỜ KÝ D03" through `definition_status`):

- `classes`: `CURRENT_YEAR` (additive), `CARRYOVER` (additive), `OTHER` (additive); `tiers`: `CENTRAL`, `LOCAL`; `subsets`: `CTMTQG` of `CURRENT_YEAR` and `CARRYOVER`; `tags`: none; `measures`: `DISBURSED`.
- `origin_groups`: `PRIMARY` = `PM_ASSIGNED`, `CARRYOVER`; `ADDED` = `LOCAL_ADDED`, `CENTRAL_SUPPORT`, `REVENUE_INCREASE` (today's `planSplitOf`; the tenant policy of BR-CAP-11 that moves `CENTRAL_SUPPORT` stays a CAP policy, unchanged).
- `entry_mode` `CUMULATIVE_ENTRY`; `phasing_must_sum` false; `actuals_source`: `CURRENT_YEAR` = `TREASURY`, `CARRYOVER` and `OTHER` = `REPORTED`; `actuals_precedence` `TREASURY_HEADLINE`; `variance_tolerance.pct` 5 (today's `TREASURY_GAP_THRESHOLD_PCT`, [CXN-03 proposal]).
- `ratios`: `RATE_PM`, `RATE_TOTAL` (class `CURRENT_YEAR`), `RATE_CARRYOVER` (class `CARRYOVER`), exactly as 5.3.

**`ENTERPRISE`** (every value **[ASSUMPTION A-3]**, unverified until the customer's indicator dictionary, DL.01 to DL.02, is received):

- `classes`: `EQUITY` (vốn chủ sở hữu), `LOAN` (vốn vay), `OTHER` (vốn khác), all additive; `tiers`: `ALL`; `subsets`: none; `tags`: `ODA`, `COMMERCIAL_LOAN`, `BOND`, `GROUP_LOAN` (vay nội bộ tập đoàn), all labels; `measures`: `EXECUTED`, `DISBURSED`.
- `origin_groups`: `PRIMARY` = `GROUP_ASSIGNED`, `BOARD_APPROVED`, `CARRYOVER`; `ADDED` = none (the enterprise has one denominator, 5.3).
- `entry_mode` `PERIOD_ENTRY`; `phasing_must_sum` true; `actuals_source`: `ERP` for all classes, with `REPORTED` as the owner's own figure; `actuals_precedence` `REPORTED_UNTIL_RECONCILED`; `variance_tolerance` 1 percent or 1,000,000 VND, whichever is larger.
- `ratios`: `RATE_YEAR_IN_FORCE`, `RATE_YEAR_ORIGINAL`, `RATE_PERIOD`, `RATE_YTD_PHASED`, `RATE_OUTLOOK_YEAR`, `RATE_SINCE_START`, `ESTIMATE_ACCURACY`, `STRUCTURE_SHARE`.

**Decision documents per origin (ENT-3e, CN.01).** `origin_decisions` is an optional list of `{ origin, kinds }` in the params: the kinds of decision document (codes of the legal-document catalogue, rule type `ENT_LEGAL_DOC_TYPE`) that may back an appropriation of the origin. The public pack lists none, so a public appropriation carries no kind and nothing about it changed. The enterprise default binds `GROUP_ASSIGNED` to the resolution or decision of the group (`GROUP_RESOLUTION`, `GROUP_DECISION`), `BOARD_APPROVED` to the resolution or decision of the company (`COMPANY_RESOLUTION`, `COMPANY_DECISION`) and `CARRYOVER` to any of the four. `appropriation.decision_kind` (V2740) keeps the kind: null for the public pack, required for the enterprise pack; the register judges it against the pack of the process (`assertAppropriationForPack`). The view `v_project_origin_decision` reads, per project, each plan line with its origin, the document that assigned it (symbol, day, kind) and the issuing authority, so how much of the plan of a project is the resolution of the group and how much the decision of the company is a grouping of that view. An enterprise appropriation draws plan lines in the classes of its pack (`EQUITY`, `LOAN`, `OTHER`; no subset; `allocation_line.taxonomy_pack` follows the appropriation).

### 4.3 Which pack applies

One tenant has one active pack; the edition manifest (ENT-0) names it (`PUBLIC` for the public edition, `ENTERPRISE` for the enterprise one). A snapshot belongs to exactly one pack and one version. Changing the pack of a tenant that already has a FROZEN snapshot is refused (409 `TAXONOMY_PACK_LOCKED`); a new **version** of the same pack takes effect from a day after the latest frozen `as_of_date`, and a version that removes or renames a class must ship a `class_crosswalk` (old code to new code) so that history can be read through it. A snapshot always keeps the version it was built with.

## 5. Figures, periods and indicators

### 5.1 Period grains and their relations

- Grains: `YEAR` (the plan year; the fiscal year is the calendar year **[A-4]**), `QUARTER` (Q1 to Q4), `MONTH` (1 to 12), `WEEK` (public reporting only). They are `reporting_period.period_type` values that exist today; `HALF_YEAR` stays for the legal 6-month report (MNE) and is **not** a figure grain.
- Containment is by dates, not by a column: month `m` is in quarter `ceil(m/3)`; a quarter is in its year; the calendar code separates calendars (`DEFAULT` public weeks and months; an enterprise calendar code for months, quarters and year), so the existing no-overlap constraint holds per (calendar, type).
- A **week** belongs to no month for sums: weekly figures are never added into months or quarters (BR-DIS-02). For display a week is shown under the month in which its end date falls **[A-5]**.
- **Month 13** (the rectification period to the end of January, CXN-31) exists only in the public pack: its figures belong to Q4 and to the plan year they rectify. The enterprise pack has twelve months; adjustments after the close of a month are booked as adjustments (5.4), not as a thirteenth month **[A-6]**.
- Lifecycle of a period, reused from DIS F4: `OPEN` (estimates and actuals accepted), `SOFT_CLOSED` (no new estimate; actuals and corrections still accepted; late flag), `LOCKED` (nothing changes; the snapshot is frozen). A year closes only when its twelfth month and its fourth quarter are `LOCKED`.

### 5.2 Figure kinds

Stored kinds (leaves) and derived kinds. `a` is the as-of date; "in force at `a`" follows BR-CAP-10 (the revision with the greatest `effective_at` not after `a`, old revisions never deleted).

| Kind | Stored or derived | Exact definition |
|---|---|---|
| `PLAN_YEAR` | stored: CAP `allocation_line` of the **first** published revision of the project's plan version for plan year `y` (measure `DISBURSED`); `plan_figure_revision` for a measure other than `DISBURSED` | The year plan as first approved. It never changes after publication. |
| `PLAN_ADJUSTED` | stored the same way | The year plan of the published revision in force at `a` **when that revision is not the first**; null otherwise. An adjustment is a full replacement carrying its decision document, not a delta. `PLAN_ADJUSTMENT_DELTA = PLAN_ADJUSTED - PLAN_YEAR`. |
| `PLAN_IN_FORCE` | derived | `PLAN_ADJUSTED` at `a` when it is not null, otherwise `PLAN_YEAR`. It is what the public edition divides by today (the plan version in force at the end of the period) and is the default denominator of every year ratio. An absent plan is 0 in a denominator. |
| `PLAN_QUARTER(q)` | stored in `plan_figure_revision` | The approved phasing of the year plan in force over quarter `q`, latest accepted revision with `as_of_date` not after `a`. With `phasing_must_sum`, `Σ_q PLAN_QUARTER = PLAN_IN_FORCE` for the same class, tier and measure, checked when the phasing is accepted and again when a year plan is adjusted (an adjustment that breaks the sum puts the phasing in `NEEDS_REPHASING` and blocks the next period's estimate until it is re-submitted). |
| `PLAN_MONTH(m)` | stored in `plan_figure_revision` | The same for a month: `Σ_{m in q} PLAN_MONTH(m) = PLAN_QUARTER(q)` when both exist. The public `disbursement_schedule_line` of kind `REGISTERED` is read as `PLAN_MONTH` and `FORECAST` as `ESTIMATE` through the figure view (7.4); the public data does not move. |
| `ESTIMATE(p; a)` | stored in `plan_figure_revision` | What the reporter expects the **whole** period `p` to come to, for a period that is open or whose actual is not yet in (the "ước thực hiện" of a monthly, quarterly or yearly report). Many revisions per period, each with its `as_of_date`; the current one is the latest accepted with `as_of_date` not after `a` and only while no `ACTUAL(p)` is accepted at `a`. An estimate of a period never includes an actual of another measure. |
| `ESTIMATE_AS_REPORTED(p)` | derived | The last accepted `ESTIMATE(p)` whose `as_of_date` is not after the **end date** of `p`: the estimate that went into the report of the period. Not affected by estimates made later. |
| `ACTUAL(p)` | stored in `plan_figure_revision` (enterprise); public: derived from the reported cumulative and the Treasury | The realised figure of period `p` from the source of the edition (section 6). Month grain is the leaf; `ACTUAL(q) = Σ ACTUAL(months of q)`; a quarter figure is never entered next to months (if both exist they must be equal, `GRAIN_SUM_MISMATCH`). A year grain `ACTUAL` exists only as `OPENING_BALANCE` (history before go-live). May be negative (a reversal or credit); a negative period needs an explanation (BR-DIS-03), is never forced to zero. |
| `CUMULATIVE_YTD(p)` | derived (enterprise); entered then kept (public) | `Σ ACTUAL(m')` over the months `m'` of the same plan year up to the end of `p` (for a quarter, up to its last month). Identity **I-CUM**: for a month other than the first of the year `CUMULATIVE_YTD(p) = CUMULATIVE_YTD(p-1) + ACTUAL(p)`; for the first month `CUMULATIVE_YTD = ACTUAL`. In the public pack the person types `CUMULATIVE_YTD` and `ACTUAL(p)` is **derived** as `deltaOf` does today (null when no earlier period, a fall kept), so BR-DIS-02 and BR-DIS-03 hold unchanged. Never summed across reports of the same year. |
| `CUMULATIVE_SINCE_START(p)` | derived | `OPENING_BALANCE + Σ ACTUAL(m')` over all months from the first period of the project in the system up to the end of `p`. `OPENING_BALANCE` is the history before go-live, entered once per (project, class, tier, measure, earlier year), approved, never edited. In the public pack this is `PROJECT_TO_DATE` (BR-DIS-12) as reported. |
| `TMDT_IN_FORCE` | read from PRJ | The approved total investment in force at `a` (the baseline of lane B2); the denominator of the since-start rate. |

### 5.3 Indicators, with their denominators

`PLAN(p)` below is the plan of the same grain as `p` (`PLAN_IN_FORCE` for a year, `PLAN_QUARTER`, `PLAN_MONTH`). A rate is `null` with a reason whenever its denominator is 0 or absent (`ZERO_DENOMINATOR`) or its numerator is absent (`NO_DATA`); the public coverage reason `TREASURY_COVERAGE_NONE` stays public. All rates are four decimals, half up, from whole dong, and a group's rate is Σ numerators over Σ denominators.

| Code | Pack | Formula (percent unless stated) | Denominator |
|---|---|---|---|
| `RATE_PM` | PUBLIC | `D / PLAN_IN_FORCE_PRIMARY(class CURRENT_YEAR, both tiers) x 100`, `D` = Treasury net paid from 1 January to the cutoff by the day it paid | The year plan of origins in `PRIMARY`. Can pass 100%. (BR-DIS-05, `ratesOf`) |
| `RATE_TOTAL` | PUBLIC | `D / (PRIMARY + ADDED plan of class CURRENT_YEAR) x 100` | The whole year plan in force. (BR-DIS-05) |
| `RATE_CARRYOVER` | PUBLIC | reported cumulative of class `CARRYOVER` over its plan, in its own tile, never mixed | The plan in force of class `CARRYOVER` (the Treasury pays a project, not a source). |
| `RATE_YEAR_IN_FORCE` | ENTERPRISE | `CUMULATIVE_YTD(p) / PLAN_IN_FORCE(year) x 100` per measure | `PLAN_IN_FORCE` of the year at `a`. |
| `RATE_YEAR_ORIGINAL` | ENTERPRISE | `CUMULATIVE_YTD(p) / PLAN_YEAR x 100` (shows what the adjustments did) | `PLAN_YEAR`. |
| `RATE_PERIOD` | ENTERPRISE | `ACTUAL(p) / PLAN(p) x 100` | The plan of the same grain. Null if the phasing does not exist. |
| `RATE_YTD_PHASED` | ENTERPRISE | `CUMULATIVE_YTD(p) / PLAN_TO_DATE(p) x 100`, `PLAN_TO_DATE(p) = Σ PLAN_MONTH(m)` for months up to `p` (months of closed quarters taken from `PLAN_QUARTER` when months are absent) | The phased plan up to the end of `p`. Pace, not completion. |
| `ESTIMATE_YEAR(a)` | ENTERPRISE (a figure, not a rate) | `Σ ACTUAL(m)` of the months closed at `a` + `Σ E(m)` of the others, `E(m) = ESTIMATE(m)` else `PLAN_MONTH(m)`; null with reason `ESTIMATE_GAP` when any month has neither | n/a. No silent fill with history (the public EAC of BR-DIS-11 keeps its own fall-back chain). |
| `RATE_OUTLOOK_YEAR` | ENTERPRISE | `ESTIMATE_YEAR(a) / PLAN_IN_FORCE(year) x 100` | `PLAN_IN_FORCE`. |
| `RATE_SINCE_START` | ENTERPRISE | `CUMULATIVE_SINCE_START(p) / TMDT_IN_FORCE x 100` | `TMDT_IN_FORCE` at `a`. Null when no approved total exists. |
| `REMAINING_YEAR` | both (money) | `PLAN_IN_FORCE - CUMULATIVE_YTD`; negative means over plan and is shown, never clamped | n/a. |
| `CONVERSION_DELTA(p)` | ENTERPRISE (money) | `ACTUAL(p) - ESTIMATE_AS_REPORTED(p)` | n/a. Null without an estimate. |
| `ESTIMATE_ACCURACY(p)` | ENTERPRISE | `ACTUAL(p) / ESTIMATE_AS_REPORTED(p) x 100` | `ESTIMATE_AS_REPORTED`. |
| `STRUCTURE_SHARE(c)` | ENTERPRISE | `CUMULATIVE_YTD(c) / Σ_c' CUMULATIVE_YTD(c') x 100` over the additive classes of the same scope and measure; also the same on `PLAN_IN_FORCE` | The sum of the classes, not the plan. |

Additivity: `ACTUAL`, `CUMULATIVE_*`, `PLAN_*`, `ESTIMATE`, `REMAINING_YEAR`, `CONVERSION_DELTA` are additive across projects, units and classes (the sum of the parts is the whole, `reconciles_to_parent` in BR-HOME-03); every `RATE_*`, `ESTIMATE_ACCURACY` and `STRUCTURE_SHARE` is not, and answers carry numerator and denominator. Each indicator becomes a `KPI_DEFINITION` rule (name, formula, numerator, denominator, exclusions, period, source, owner); the two public ones already are (`DISBURSEMENT_RATE_PM`, `DISBURSEMENT_RATE_TOTAL`, `analytics-rule-defaults.ts`) and are not edited.

### 5.4 Late adjustments and the two views

A correction that arrives after a month is `LOCKED` is booked as an `ACTUAL` of basis `ADJUSTMENT` in the **open** period, with `adjusts_period_id` pointing at the period it corrects and an explanation. Two views follow:

- **AS_REPORTED**: an adjustment counts in the period it was booked in. `PERIOD_CLOSE` snapshots use this view, so a closed period never changes.
- **RESTATED**: an adjustment counts in the period it corrects. Used by a `RESTATED` snapshot (6.5) and by trend charts that ask for it.

`CUMULATIVE_YTD` and `CUMULATIVE_SINCE_START` at the end of any period after the adjustment are equal in both views; only the period figures and the periods in between differ.

## 6. Sources of actuals, precedence and variance

### 6.1 Public

`ACTUAL` of class `CURRENT_YEAR` is the Treasury (BR-DIS-06); of the other classes the accepted report. Nothing new: this is `treasuryDisbursed` and the reported cells. The Treasury is the headline (`TREASURY_HEADLINE`): it is the numerator of both rates; the report is kept per cell; the two are compared per line (`coverageOf`: `NONE`, `PARTIAL`, `COMPLETE`, 5% of the report **[A-7, today's assumption of CXN-03]**). The coverage is the public form of the "source agreement" of 6.4.

### 6.2 Enterprise

Three kinds of figure exist for a (project, class, measure, month), each with its own `basis`:

| Basis | Written by | Meaning |
|---|---|---|
| `REPORTED` | the project owner, in the monthly report revision (DIS pattern: draft, submit, review, accept, immutable once submitted) | "As reported": what the owner stated and the unit leader and planning division accepted. |
| `ERP` | an import batch from Oracle EBS (lane ENT-2): file adapter now, `ErpPort` when the operator publishes an API; batch immutable, hashed, keyed by (tenant, ledger period, batch number) | What the books say, by the project code mapped through `master_crosswalk` and by the funding class mapped through the configured account map **[A-8]**. |
| `ADJUSTMENT` / `OPENING_BALANCE` | the reconciliation resolution (6.4) / the go-live import | See 5.4 and 5.2. |

### 6.3 Precedence (`REPORTED_UNTIL_RECONCILED`) **[A-9: reasoned default, the customer confirms]**

The **official** figure `OFFICIAL(p)` is the one every indicator, snapshot and report reads.

1. While `p` is `OPEN` or `SOFT_CLOSED`: `OFFICIAL` is the accepted `REPORTED` figure; if none, the latest `ERP` figure marked flash; else null (never 0).
2. When `p` closes, the snapshot freezes `OFFICIAL` **as it was** together with the `ERP` figure and the variance beside it. Later arrival of a different `ERP` figure never edits the frozen snapshot.
3. A variance above the tolerance (6.4) opens a reconciliation item. Resolutions: `ACCEPT_ERP` (an `ADJUSTMENT` of the difference is booked in the open period), `ACCEPT_REPORTED` (the owner is right; the ERP side is queried with the accounting division, no figure changes), `EXPLAINED` (timing or classification, with a reason and a date of expected convergence), `WAIVED` (approver, with a reason). The resolver is not the preparer of the report (SoD, CHECK as in `report_revision_sod_chk`).
4. At the close of a **year**, any unresolved variance blocks the close (409 `YEAR_CLOSE_BLOCKED_BY_VARIANCE`) unless waived; the official year figure is then the `ERP` figure, because the books are the record of the year (`YEAR_END_ERP_WINS`).
5. The reports to the parent group read `OFFICIAL` from the frozen snapshot and carry the snapshot revision (R17); a restatement is a new snapshot revision, and a delivery older than the latest accepted revision is refused by ENT-2.

### 6.4 Variance and its explanation

`variance = REPORTED - ERP` per (project, class, measure, month). It needs an explanation when `abs(variance) > max(tolerance.abs_vnd, tolerance.pct x abs(ERP) / 100)`. The explanation is 20 to 2000 characters (the same style as `negative_delta_explanation`), names a reason code (`TIMING`, `CLASSIFICATION`, `ACCRUAL`, `ERROR_REPORT`, `ERROR_ERP`, `OTHER`), the owner of the item and an expected resolution date; a late item raises an alert type with an owner, an expected action and a consequence (rule `ALERT_TYPE`, `ERP_VARIANCE_OPEN`, response time 5 working days **[A-10]**). The reconciliation table and its screens are ENT-2's; this spec fixes the semantics.

### 6.5 The closed-period snapshot

`period_snapshot` is the frozen "as reported" record. FND-1 adds:

- `taxonomy_pack`, `taxonomy_rule_id`, `taxonomy_version`: the pack, the governance-rule row and its version the snapshot was built with. The classes of its lines are meaningful only through this version, forever.
- `hash_schema` (1 or 2): `1` is the header hashed today (period, kind, as-of date, cutoff, `metric_set_version`, `definition_status`); `2` adds `taxonomy_pack`, `taxonomy_version`, the actuals precedence code and the list of figure kinds present. **A `PUBLIC` snapshot of taxonomy version 1 uses `hash_schema` 1 and therefore hashes byte-identically to today** (the golden test of section 9); verification of a stored hash always recomputes with the stored `hash_schema`.
- Kind `RESTATED` (alongside `PERIOD_CLOSE`, `ADHOC`, `MNE`): a snapshot built in the `RESTATED` view with `restates_snapshot_id` and a revision number; it never replaces the `PERIOD_CLOSE` record (which stays FROZEN and is the "as reported" evidence); the unique index of one FROZEN snapshot per (period, kind) is kept per kind.
- Figures: a long-format child, `period_snapshot_figure`, one row per (snapshot, project, unit, class, tier, measure, figure kind, grain, ordinal) with the amount or the null reason, the basis, and the `plan_figure_revision` id it came from; written once while the snapshot is BUILDING, then guarded exactly as `period_snapshot_line` (insert only while BUILDING, never updated or deleted). The public `period_snapshot_line` is untouched and is exposed in the same shape by the view of 7.4.

A quarter snapshot is built from the same stores at the quarter end, not from the three month snapshots; the build checks the three month snapshots against it and lists every difference as a **late adjustment inside the quarter** with its explanation (a difference without an adjustment behind it fails the build with `QUARTER_CONSISTENCY_BROKEN`).

## 7. Storage and the expand/contract migration plan

### 7.1 The CHECKs to open and narrow (inventory)

| Table | Constraint today | Role |
|---|---|---|
| `allocation_line` | `allocation_line_bucket_chk` (bucket), `allocation_line_level_chk` (level), `allocation_line_origin_chk` (`V1362`), `allocation_line_carryover_chk` (semantic, public) | CAP plan lines |
| `appropriation` | inline `origin` CHECK, `appropriation_carryover_chk` | CAP register |
| `funding_snapshot_line` | `funding_line_bucket_chk`, `funding_line_ctmtqg_bucket_chk` (semantic) | report cells |
| `period_snapshot_line` | inline CHECKs on `bucket` and `budget_level` (generated names) | frozen lines |
| `disbursement_schedule_line` | inline CHECKs on `bucket`, `budget_level`, `granularity`, `kind` | schedule |
| `disbursement_ranking` | `denominator_kind IN ('PM_ASSIGNED','TOTAL_INCL_LOCAL')` | public ranking; enterprise ranking is out of FND-1 |
| `period_snapshot` | `snapshot_kind` CHECK | add `RESTATED` (no class column) |

The semantic CHECKs (`*_carryover_chk`, `funding_line_ctmtqg_bucket_chk`) only fire on public class codes and stay as they are: an enterprise class never takes their values.

### 7.2 Phases (one migration series, block `V2060` to `V2079`, names `fnd1_*`; applied migrations are never edited)

1. **Expand (release N).**
   - `V2060 fnd1_taxonomy_columns`: `taxonomy_pack text NOT NULL DEFAULT 'PUBLIC'` on every table of 7.1 that has a class column (`allocation_line`, `funding_snapshot_line`, `period_snapshot_line`, `disbursement_schedule_line`) and on `report_revision` and `period_snapshot`; on `period_snapshot` also `taxonomy_rule_id uuid` (null means the built-in default), `taxonomy_version integer NOT NULL DEFAULT 1`, `hash_schema smallint NOT NULL DEFAULT 1`, `restates_snapshot_id uuid`, `revision integer NOT NULL DEFAULT 1`. A column added with a constant default is a catalogue change, not a row rewrite: it fires no trigger, so frozen snapshots and their guards are not touched and their hashes (which cover neither column for `hash_schema` 1) do not move. Nothing reads the columns yet.
   - `V2061 fnd1_open_class_checks`: for each table of 7.1, in one transaction: (a) a pre-check that counts rows outside the public values and raises if any; (b) **add** the new pack-aware CHECK `NOT VALID`: `(taxonomy_pack = 'PUBLIC' AND bucket IN (...) AND budget_level IN (...)) OR (taxonomy_pack = 'ENTERPRISE' AND bucket IN ('EQUITY','LOAN','OTHER') AND budget_level = 'ALL')` (the pack list is the **only** closed list left in the database, so a new pack is a new migration, on purpose; the kernel validates the classes of the pack's rule version, the database only the pack's shape); (c) **drop** the old closed CHECK (found through `pg_constraint` by definition, because some are generated names); (d) `VALIDATE CONSTRAINT`. Origins gain `GROUP_ASSIGNED`, `BOARD_APPROVED`; `granularity` gains `QUARTER`, `YEAR`; `kind` of the schedule is **not** extended (enterprise plans and estimates use `plan_figure_revision`).
   - `V2062 fnd1_plan_figure_revision`: the table of 7.3 with RLS (ENABLE, FORCE, `tenant_boundary`, `tenant_guard`), composite FKs, index on every `*_id`, guard trigger, SoD CHECK, outbox event `funding.figure_accepted.v1`; the table `funding_line_tag`; `period_snapshot_figure` and its guard.
   - `V2063 fnd1_snapshot_kind_restated`: `snapshot_kind` CHECK gains `RESTATED`; new `period_snapshot_guard` rules (a `RESTATED` snapshot must name `restates_snapshot_id`; the restated snapshot's period equals the restated one's).
   - `V2064 fnd1_figure_views`: `v_snapshot_figure` (7.4). No backfill is needed: the defaults of `V2060` already say "public, version 1, hash schema 1" for every existing row.
2. **Run on both**: release N writes new rows through the pack-aware code; old readers still work because public rows are unchanged. Gate to leave this phase: `npm run migrations:check`, the golden test (section 9), the DB tests of 10 green on the stack with both packs, one full public UAT regression.
3. **Contract (release N+1 or later, never in the same release).** `V2065 fnd1_contract`: drop the `DEFAULT 'PUBLIC'` of every `taxonomy_pack` and the `DEFAULT 1` of `taxonomy_version` and `hash_schema` so that every writer states them (gate: the DB test suite runs green with the defaults dropped on a scratch database before the migration is committed); make `taxonomy_pack` and `taxonomy_version` part of the unique keys that need them (`snapshot_line_cell_uq`); drop any compatibility view or trigger added for the phase. The old closed CHECKs are already gone in `V2061`; this step narrows defaults and keys, which is why the order is "open, then narrow".

Rollback: phases 1 and 2 are additive; the only destructive statement is the drop of an old CHECK, and its replacement accepts every row the old one accepted, so rolling the code back does not need a schema rollback.

### 7.3 `plan_figure_revision`

One append-only table for the stored kinds that CAP does not already own. Columns (all money `numeric(24,0)`, whole dong):

`tenant_id`, `id`, `project_id`, `taxonomy_pack`, `class_code` (stored in a column named `bucket` for symmetry with the other tables), `tier_code` (`budget_level`), `measure` (`DISBURSED` / `EXECUTED`), `figure_kind` (`PLAN_QUARTER`, `PLAN_MONTH`, `ESTIMATE`, `ACTUAL`, and for a measure other than `DISBURSED` also `PLAN_YEAR`, `PLAN_ADJUSTED`), `period_grain` (`MONTH`, `QUARTER`, `YEAR`), `plan_year`, `period_ordinal` (quarter 1 to 4, month 1 to 12, 0 for `YEAR` opening balances), `reporting_period_id`, `amount_vnd`, `basis` (`REPORTED`, `ERP`, `TREASURY`, `ADJUSTMENT`, `OPENING_BALANCE`, `PLAN_DECISION`, `OWNER_ESTIMATE`), `as_of_date`, `revision`, `supersedes_id`, `status` (`DRAFT`, `SUBMITTED`, `ACCEPTED`, `SUPERSEDED`, `WITHDRAWN`), **conversion link** `converted_from_id` (the `ESTIMATE` this `ACTUAL` replaces) with `estimate_amount_vnd` (copied at conversion, so the history reads without a join) and `conversion_reason` (`PERIOD_ACTUAL_IN`, `CORRECTION_IN_OPEN_PERIOD`, `LATE_ADJUSTMENT`, `RESTATEMENT`), `adjusts_period_id`, `source_report_revision_id`, `erp_batch_id`, `decision_document_id`, `explanation`, `prepared_by`, `approved_by`, audit columns, `version`.

Constraints and guards:

- CHECKs: `figure_kind` and `measure` lists; `figure_kind IN ('PLAN_YEAR','PLAN_ADJUSTED') AND measure = 'DISBURSED'` refused (CAP owns them); `period_grain = 'YEAR'` only with `basis = 'OPENING_BALANCE'`; `converted_from_id IS NULL OR figure_kind = 'ACTUAL'`; `approved_by IS NULL OR approved_by <> prepared_by`; `amount_vnd >= 0` except `figure_kind = 'ACTUAL'` (a reversal) and then `explanation IS NOT NULL`; `explanation` length 20 to 2000 when present.
- One **current** row per key: unique partial index on (`tenant_id`, `project_id`, `taxonomy_pack`, `bucket`, `budget_level`, `measure`, `figure_kind`, `period_grain`, `plan_year`, `period_ordinal`, `basis`) `WHERE status = 'ACCEPTED'`, `NULLS NOT DISTINCT`.
- Guard trigger, in the style of `period_snapshot_guard`: the identity columns, `amount_vnd`, `as_of_date`, `basis`, `prepared_by` never change after insert; the only updates are the status moves `DRAFT` to `SUBMITTED` to `ACCEPTED`, `SUBMITTED` to `DRAFT` (return) or `WITHDRAWN`, `ACCEPTED` to `SUPERSEDED`, plus `approved_by` on acceptance; **delete is refused**. A correction is a new row with `supersedes_id`.
- Conversion, **one transaction**: accepting an `ACTUAL` for a key (a) inserts it `ACCEPTED` with `converted_from_id` = the current accepted `ESTIMATE` of the same key and `estimate_amount_vnd` copied, (b) moves that `ESTIMATE` to `SUPERSEDED`, (c) writes the audit row `funding.estimate_converted` (ids, counts and the delta, never the amount in clear in the log of the application, as the other audit rows) and the outbox event. The history of a period is therefore: estimate revisions in `as_of_date` order, then the actual, each linked.

### 7.4 One reading shape for everyone

The view `v_snapshot_figure(snapshot_id, project_id, unit_id, class_code, tier_code, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason, basis)` unions `period_snapshot_figure` with the public `period_snapshot_line` mapped column by column: `plan_pm_assigned_vnd`, `plan_local_added_vnd` to `PLAN_IN_FORCE` with `origin_group` `PRIMARY` / `ADDED`; `disbursed_treasury_vnd` to `ACTUAL`/`CUMULATIVE_YTD` basis `TREASURY`; `disbursed_reported_vnd` to `CUMULATIVE_YTD` basis `REPORTED`; `period_delta_vnd` to `ACTUAL` basis `REPORTED`; `registered_month_vnd` to `PLAN_MONTH` of the next month; `forecast_eac_vnd` to `ESTIMATE_YEAR`. RPT-1 (form-pack), IND-1 (indicators), BI datasets and HOME read this shape; the public line table stays the source of truth for the public edition. The MNE form-pack gets one new `source.kind`, `FUNDING_FIGURE { figure_kind, class, tier, measure, grain, period_ref: CURRENT | PREVIOUS | YEAR_END, view }`, parsed by `parseReportSchema`; the existing `SNAPSHOT_METRIC` list (`plan_total_vnd`, `plan_pm_assigned_vnd`, `disbursed_treasury_vnd`, `rate_pm_pct`, `rate_total_pct`, `project_count`) is not changed.

## 8. Rules that make a closed period closed (immutability)

- **I1 Append-only.** `plan_figure_revision`, `period_snapshot_figure`, ERP batches and snapshots never update an amount or delete a row.
- **I2 Locked is locked.** No figure of a period whose `reporting_period.status` is `LOCKED` accepts a new revision, by any role (409 `FIGURE_PERIOD_LOCKED`). The only paths are the reopen window (DIS F4, `period_reopen`, a person other than the requester decides) and, for the enterprise edition, a late adjustment in the open period (5.4).
- **I3 No estimate after the actual.** An `ESTIMATE` cannot be accepted for a key that has an accepted `ACTUAL` (422 `ESTIMATE_AFTER_ACTUAL`); in `SOFT_CLOSED` no new estimate at all.
- **I4 Identities are checked on write.** I-CUM, `Σ months = quarter` (`GRAIN_SUM_MISMATCH`), `Σ quarters = PLAN_IN_FORCE` with `phasing_must_sum` (`PHASING_SUM_MISMATCH`), subset not above parent (`SUBSET_EXCEEDS_PARENT`), `cumulative <= total` and `equity + loan = total` as `DATA_ENTRY_RULE` rules of IND-1 which call the same kernel functions.
- **I5 The snapshot carries its meaning.** Pack, rule version, metric set, definition status, hash schema (6.5). The hash covers header and every line and figure; the same input gives the same hash and a changed figure does not.
- **I6 As reported is evidence.** A `PERIOD_CLOSE` snapshot, once FROZEN, is never superseded by a restatement; it may be superseded only by a later `PERIOD_CLOSE` of the same period built after a reopen, as today.
- **I7 Maker is not checker** on every accepted figure, resolution and waiver; audit rows carry counts, hashes and ids, never an amount.
- **I8 Every number says where it comes from**: formula (section 5), source basis (section 6), as-of date, pack and version (sections 4, 6.5).

## 9. The golden test that keeps the public edition identical

Step 2 delivers `packages/kernel/src/fnd-public-golden.test.ts` and its fixture `packages/kernel/test/fixtures/fnd-public-golden.json`. The fixture is **recorded from the code of commit `71e23a06`** (the `dis-*.ts` files are unmodified in the working tree at the time of writing) before any FND-1 code is written, by a one-off script committed beside it, and then never regenerated without a written reason.

1. **Engine equality.** For every fixture project (six cells, plans of every origin, reported cells, Treasury entries, previous cumulative) the new figure engine in the `PUBLIC` pack returns exactly what `buildLines` returns (every field of every `SnapshotLine`, as strings), and for every group exactly what `rateOfSums` returns, including `rateNullReason` and `treasuryCoverage`.
2. **The two ratios of HOME-01 and HOME-03.** `DISBURSEMENT_RATE_PM` and `DISBURSEMENT_RATE_TOTAL` (through `homeTiles(rateOfSums(sums, 'CURRENT_YEAR'), status)`) are identical on every fixture, tile by tile, including the formula text of the two KPI definitions.
3. **Hash equality.** `snapshotHash` of the header and lines of each fixture snapshot equals the recorded hash with `hash_schema` 1; a `hash_schema` 2 snapshot of the same lines hashes differently (so the two cannot be confused).
4. **Property test** (seeded): random cells and plans, both paths equal, and `groupRate` equals `rateOfSums` of the sums, never the mean of the rates.
5. **DB and API.** A frozen public snapshot already in the seed recomputes to its stored `payload_sha256`; the existing tests of `GET /disbursement-rates`, `period-snapshots`, HOME command centre and MNE reports pass **without any assertion edited**.

Fixture cases (all in whole dong): **G-1** (FX-DIS-004) plan given 1,000,000,000, added 250,000,000, `D` 600,000,000 gives `60.0000` and `48.0000`. **G-2** (FX-DIS-003) 50/100 and 90/900 million group to `14.0000`. **G-3** no plan of either kind: `ZERO_DENOMINATOR` whatever else is missing. **G-4** `PM` plan 0 and added 250,000,000 with `D` 100,000,000: `ratePmPct` null, `rateTotalPct` `40.0000`, reason `ZERO_DENOMINATOR` (as `ratesOf` does). **G-5** Treasury booked nothing, coverage `NONE`: `TREASURY_COVERAGE_NONE`; coverage not none and no figure: `NO_DATA`. **G-6** Treasury net below zero: `NO_DATA`, coverage `PARTIAL`. **G-7** rounding half up: 1 over 128 is `0.7813`. **G-8** the carried-over rate over reported cells. **G-9** (FX-DIS-005) cutoff on 30/09: paid 30/09 counts, 01/10 does not; a refund takes off on its own day. **G-10** (FX-DIS-001) six cells 100+200+30+70+0+20 give 420,000,000 and CTMTQG 40,000,000 stays out.

## 10. Tests of the new behaviour (step 2 onward)

Kernel (pure, unit and property): rule-type schema and `refine` of both packs; I-CUM for random year sequences in both entry modes; quarter and month sums; `PLAN_IN_FORCE` choice around the adjustment day; `ESTIMATE_YEAR` with and without gaps; the precedence rules of 6.3 step by step; variance threshold; `RESTATED` versus `AS_REPORTED` views equal at the end of a year. DB (serialised lane): guard trigger refuses delete and amount update; conversion in one transaction (a failure between steps leaves nothing); unique current index; RLS with a second tenant; the migration series applied on a copy that already holds public data, then the public golden (section 9) re-run; the contract migration refused while a NULL `taxonomy_version` exists. API and web belong to steps 4 and later and follow the end-to-end pattern of commit `47db69a2`.

## 11. Assumptions and open questions (dependencies)

**Assumptions** (each is configuration with its source and status, flagged "chưa kiểm chứng" on screens and in documents until confirmed):

| Id | Assumption |
|---|---|
| A-1 | Enterprise counts two measures, `EXECUTED` and `DISBURSED`. |
| A-2 | Enterprise quarter and month plans must add up to the year plan in force. |
| A-3 | The enterprise classes (`EQUITY`, `LOAN`, `OTHER`), tags and origins above. |
| A-4 | The enterprise fiscal year is the calendar year. |
| A-5 | A week is shown under the month in which it ends. |
| A-6 | The enterprise has no thirteenth month; late corrections are adjustments. |
| A-7 | The 5% Treasury-to-report threshold (CXN-03 proposal, today's). |
| A-8 | The ERP account and segment map that makes an EBS line "equity" or "loan" and "executed" or "paid". |
| A-9 | The precedence default (6.3), including `YEAR_END_ERP_WINS`. |
| A-10 | Tolerance (1% or 1,000,000 VND), five working days to resolve a variance, reasons list. |

**Open questions the customer or the capital owner must answer** (owners in the plan's dependency register; a deliverable built on a placeholder is PENDING-EXTERNAL and cannot be accepted, R18):

1. The customer's **indicator dictionary** (DL.01, DL.02): the exact names, units (million or billion dong, with or without VAT), and definitions of "thực hiện" and "giải ngân"; whether the plan exists per class or only in total; whether the adjusted plan is per class. Blocks: IND-1, ENT-1, the enterprise defaults of 4.2.
2. Which month-end the parent group's monthly and quarterly forms (PVN) take: the cut-off day, whether the quarter form restates months, whether "lũy kế" on them is from the start of the year or from the start of the project (our `YTD` and `SINCE_START` answer both, the form must say which).
3. The **Oracle EBS** extract: projects and task codes, the segment that carries the funding source, the period close calendar, whether flash (pre-close) balances exist. Blocks: A-8, 6.2 `ERP`, ENT-2.
4. Whether foreign-currency loans must be shown in the original currency and at which rate (this spec counts whole dong only).
5. Whether the public capital owner signs the formulas (D03, CXN-03); until then the public pack keeps `definition_status` `PROPOSED_PENDING_SIGNOFF` and nothing in this spec changes that.
6. Whether DIS-24 (`disbursement_schedule_line`) and `plan_figure_revision` should become one store later; FND-1 keeps both and bridges them with the view of 7.4.
7. Whether the enterprise ranks units (the `disbursement_ranking` denominators stay public-only here).

**Error codes** to register in step 2 (`error_codes.json`, `lint-error-codes`): `TAXONOMY_PACK_LOCKED`, `FUNDING_CLASS_UNKNOWN`, `FIGURE_PERIOD_LOCKED`, `ESTIMATE_AFTER_ACTUAL`, `CUMULATIVE_IDENTITY_BROKEN`, `PHASING_SUM_MISMATCH`, `GRAIN_SUM_MISMATCH`, `ACTUALS_VARIANCE_UNEXPLAINED`, `YEAR_CLOSE_BLOCKED_BY_VARIANCE`, `QUARTER_CONSISTENCY_BROKEN`. Reused unchanged: `SUBSET_EXCEEDS_PARENT`, `PERIOD_LOCKED`, `SNAPSHOT_FROZEN`, `VERSION_CONFLICT`, `VALIDATION_FAILED`.

## 12. What the later lanes may rely on once this is approved

- **RPT-1:** the `FUNDING_FIGURE` source kind and the view `v_snapshot_figure`; the `as_reported` and `restated` views; the snapshot revision and `hash_schema` for the hash on a delivery (R17).
- **IND-1:** the identities of section 8 (I4) as `DATA_ENTRY_RULE` codes calling the same kernel functions; the indicator list of 5.3 as `KPI_DEFINITION` seeds that the customer's dictionary replaces.
- **ENT-1:** the `ENTERPRISE` pack as the seed of the enterprise edition (labels and terminology come from the edition overlay, not from this rule); the monthly and quarterly period calendars (5.1).
- **ENT-2:** the reconciliation semantics of section 6 (item states, resolutions, tolerance, year-close block) and the delivery rule of 6.3 step 5.

## 13. Implementation status, changes against this text, and the kernel API

### 13.1 What is built

| Part | Where | Proof |
|---|---|---|
| Rule type `FUNDING_TAXONOMY` with the schema and the `refine` of 4.1 and the two built-in packs of 4.2 (PUBLIC flagged verified for its shape, ENTERPRISE flagged unverified, A-3) | `packages/kernel/src/fnd-taxonomy.ts`, registered in `governance-rules.ts` (`registerEnterpriseRules`) | `test/fnd-taxonomy.test.ts`, `governance:check` |
| Periods: grains, containment by dates, the lifecycle gate (`FIGURE_PERIOD_LOCKED`) | `fnd-period.ts` | `test/fnd-taxonomy.test.ts` |
| The figure engine: every figure kind of 5.2, every indicator of 5.3, as-of reads from append-only revisions, the two views of 5.4, the official actual of 6.3, the variance of 6.4, the transition history of 7.3 | `fnd-figures.ts`, `fnd-indicators.ts`, `fnd-actuals.ts`, `fnd-checks.ts` | `test/fnd-figures.test.ts`, `test/fnd-checks.test.ts` (unit and seeded property tests) |
| The public pack as data: `buildPackLines`, `publicRateSums`, `publicRateFigures`, `publicIndicatorsOf`; the snapshot hash under `hash_schema` 1 and 2 and the figure rows of a snapshot | `fnd-public.ts`, `fnd-snapshot.ts` | **the golden test** `test/fnd-public-golden.test.ts` (section 9, items 1 to 4) |
| Migrations V2060 to V2064: pack columns, open class CHECKs by pack, `plan_figure_revision` with its guard, `funding_line_tag`, `period_snapshot_figure` with its guard, kind `RESTATED`, the view `v_snapshot_figure` | `db/migrations/V2060` to `V2064` (block 2060 to 2079, slice `FND-1`) | `packages/db/test/fnd-figure-store.test.ts`, `rls-catalog` |
| The figure store: propose, submit, accept (with the conversion), send back, withdraw, the books for the engine (CAP year plans read as the first plan and its adjustments), the history | `packages/db/src/fnd-figure-store.ts` | `packages/db/test/fnd-figure-store.test.ts` |
| API: `getFundingTaxonomy`, `getFundingFigureBoard`, `listFundingFigureBatches`, `getFundingFigureBatch`, `getFundingFigureHistory`, `proposeFundingFigures`, `submitFundingFigures`, `acceptFundingFigures`, `returnFundingFigures`, `withdrawFundingFigures`; permissions `funding.read`, `funding.figure.prepare`, `funding.figure.accept`; module `FND` | `apps/api/src/modules/fnd/` | `apps/api/test/fnd/figure.test.ts`, the authz and isolation suites |
| Screens DIS-27 (figures and indicators with the `i` of formula, source and as-of), DIS-28 (prepare and approve batches), DIS-29 (history of a period) | `apps/web/src/screens/dis/funding/` | vitest of the screens |

### 13.2 Changes against the text above (decisions of the lane)

1. **The golden does not edit the public code.** The engine in `fnd-public.ts` is an independent implementation; `dis-snapshot.ts`, `dis-rates.ts`, `home.ts` stay byte-identical to commit `71e23a06`, and the test proves engine equals recorded fixture equals live code (field by field, tile by tile, hash by hash). The fixture was recorded by `packages/kernel/test/fixtures/fnd-public-golden.record.mjs` before any engine code existed; it was re-recorded twice afterwards only to give each fixed case its own project id and to add the two definitions of HOME-01/03 and the cases G-2a/G-2b (the recorded numbers of the cases did not change).
2. **7.3, `period_grain = YEAR`**: the text allowed it only for opening balances, which would forbid the year plan of a measure other than DISBURSED and the estimate of a year that 5.2 defines. The CHECK allows `YEAR` for `PLAN_YEAR`, `PLAN_ADJUSTED`, `ESTIMATE` and for `ACTUAL` with basis `OPENING_BALANCE` only; `plan_figure_kind_grain_chk` and `plan_figure_kind_basis_chk` pair every kind with its grain and basis.
3. **7.3, columns added**: `batch_id` (figures that are submitted and accepted together: the four quarters of a phasing), `flash` (an ERP figure taken before the books closed), `adjusts_plan_year` and `adjusts_ordinal` (the month a late adjustment corrects, next to `adjusts_period_id`), `taxonomy_rule_id` and `taxonomy_version` (the rule version the row was written under). The unique current key includes `adjusts_*` so that one booking period can carry the corrections of several earlier periods.
4. **7.3, the conversion is written at the acceptance**, not inserted accepted: the actual is prepared and submitted like any figure; accepting it (by another person) writes `converted_from_id`, `estimate_amount_vnd` and `conversion_reason` on it and supersedes the estimate in the same transaction; the guard lets the link be written once, at that move. A correction of an actual that already has one is `CORRECTION_IN_OPEN_PERIOD`. A rollback after the acceptance leaves both rows as they were (tested).
5. **7.1 and 7.2**: `appropriation` gets `taxonomy_pack` too (its inline `budget_level` and `origin` lists were closed as well); the schedule keeps granularity `WEEK` and `MONTH` (enterprise plans and estimates live in `plan_figure_revision`, so a `QUARTER` or `YEAR` schedule row would have no reader); the pre-check count of V2061 is not needed because the old CHECKs already hold for every row and the new one is added validated before the old ones are dropped.
6. **I2 (locked is locked)** gates estimates and actuals. A plan revision (a phasing) is allowed while a month of the year is locked: it carries its knowledge date and rewrites no history (every read is as of a day). The enterprise pack requires the whole set (4 quarters or 12 months) in one batch so that the sum rule can be judged.
7. **6.3 step 1**: with no accepted reported figure the engine takes the latest ERP figure whether or not it is flash (the figure says `flash` and the screens label it), instead of null for a closed-books figure that nobody reported.
8. **Entry mode.** The figure store writes the period figure (`PERIOD_ENTRY`). A pack headed by the Treasury (`TREASURY_HEADLINE`, the public pack) refuses actuals through this store (422 on `figure_kind`): its actuals are the Treasury and the reports of DIS, unchanged. `deriveActuals` implements both entry modes for the readers.
9. **Not built in this lane (hooks, section 13.4)**: the builder and the freeze of an enterprise snapshot (the tables, guards, hash schema 2 and the figure rows are built and tested; the command that reads the books into a BUILDING snapshot is RPT-1c), the reconciliation items and the ERP import (ENT-2; the kernel has the variance, the precedence and the year-close block), `funding_line_tag` writes, `V2065`.

### 13.3 The kernel API the later lanes consume (`@machvon/kernel`)

```
packs         builtInPack(code) | parseFundingPack(code, params) | refineFundingPack | FUNDING_TAXONOMY_RULE_TYPE | fundingPackCodeOfEdition(edition)
book          FigureBook { pack, figures: StoredFigure[], tmdt, yearsClosed }   (the store builds it: FndFigureStore.loadBooks)
figures       cellFigures(book, class, tier, query) | figuresOfProject(book, projectId, query)   query = { period, asOf, measure, view }
indicators    indicatorsOf(pack, projects, query)        ratios of the pack, sum over sum, numerator and denominator kept
              moneyIndicatorsOf(pack, projects, query, classCode?)   additive figures (REMAINING_YEAR, CONVERSION_DELTA, ...)
public        buildPackLines | publicRateSums | addPublicSums | publicRateFigures | publicIndicatorsOf
actuals       officialActual | varianceOf | varianceExplanation | periodHistory | assertYearMayClose | assertResolverIsNotPreparer
identities    assertCumulativeIdentity | assertPhasing | assertGrainSum | assertEstimateAllowed | assertSubsetWithinParent | deriveActuals | cumulativeOf
snapshots     snapshotHashFor(1|2, header, lines, extras?) | figureRowsOf(project, figures, query)
```

Every function is pure, exact (whole dong as text, `bigint` inside, four decimals half up) and never returns zero for a missing figure. RPT-1c reads `figureRowsOf` and the view `v_snapshot_figure`; IND-1 turns the identities into `DATA_ENTRY_RULE` codes that call the same functions and the ratios of the pack into `KPI_DEFINITION` seeds (`indicatorFormula(code)` has the sentence of each); ENT-1 takes `builtInPack('ENTERPRISE')` as its seed and the calendar code `ENTERPRISE` for months, quarters and the year (`FIGURE_CALENDAR`); ENT-2 uses `officialActual`, `varianceOf` and `assertYearMayClose`.

### 13.4 Hooks left for other lanes

- RPT-1c: a command that builds a `period_snapshot` of the enterprise pack (BUILDING with `taxonomy_pack`, `taxonomy_rule_id`, `taxonomy_version`, `hash_schema` 2), writes `figureRowsOf` rows, and freezes it with `snapshotHashFor(2, ...)`; the `FUNDING_FIGURE` source kind of the form pack.
- ENT-2: write `ERP` and `ADJUSTMENT` figures through `FndFigureStore.propose` with `basis: ERP`, `flash`, `erpBatchId`; the reconciliation table; the alert type `ERP_VARIANCE_OPEN`.
- The text of `edition-enterprise` `kpi-pack.vi.json` still names the class `DEBT`; the class of this pack is `LOAN` (spec 4.2).
- `V2065` (the contract phase) once a release has run with the defaults.
