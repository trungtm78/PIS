# Contract analytics, the money reports (CA-2)

CA-2 deepens the five money reports of the report hub (CTR-28, opened with `?report=<code>`): schedule delay with earned value and the S-curve (R3), the three-way match with the payment clock (R4), advance ageing and recovery (R5), retention and guarantee exposure (R6) and change growth by tier (R7). It stands on the foundation of CA-1 (`packages/kernel/src/ctr-analytics.ts`, `ctr-reports.ts`, the view `contract_fact`, the frozen `contract_fact_snapshot`): every indicator is defined once in the kernel (formula, numerator, denominator, source, null policy), the filters, sort and paging are on the server, the total is the sum of the rows and is the figure of the Excel read back, and what cannot be known is NOT_APPLICABLE with a named reason, never 0.

No migration was added. Everything CA-2 needs is read from the existing tables, by `packages/db/src/ctr-money-store.ts`, for the same selection (scope, filters, ledger right) as the report.

## The figures

| Report | New figure | Defined in | Formula |
|---|---|---|---|
| R3 | `SPI`, `CPI`, BAC, PV, EV, AC, SV per contract and for the selection | `ctr-money-reports.ts` over `prj-evm.ts` | EV / PV and EV / AC (four decimals) as ratios of sums; a contract carries the share of its package that its value is of the values of all carriers (the rule of `PrjEvmStore.pick`, scope CONTRACT), so a contract and its project agree |
| R3 | S-curve of the selection | `evmCurveOf` | plan by the baseline in force and by version 0, EV and AC up to the as-of day; every point is what `lineEvm` gives for that day |
| R4 | match status | `matchStatusOf` | worst first: paid beyond accepted, accepted beyond measured, requested beyond accepted, measured not yet accepted; a gap is tolerated up to the larger of `tolerance_vnd` and `tolerance_pct` of the larger figure (rule `CONTRACT_THREE_WAY_MATCH`) |
| R4 | `MEASURED_TO_ACCEPTED` | `measuredToAcceptedOfSums` | accepted / measured |
| R4 | `ON_TIME_PAYMENT_RATE` | `paymentJudgement` | requests inside both steps of `CONTRACT_PAYMENT_CLOCK` / requests with at least one step behind them; a contract is late on its clock exactly when one of its requests is |
| R5 | `ADVANCE_RECOVERY_SHORTFALL`, recovery status | `advanceRecoveryOf` | per contract max(0, advance x min(1, accepted / value) - recovered), half up to the dong; `RECOVERED` within the tolerance of the rule `ADVANCE_RECOVERY` |
| R6 | `GUARANTEE_EXPOSURE`, ladders | `guaranteeExposureOfSums`, `retentionBandOf`, `guaranteeBandOf` | required less in force; retention held cut by the day it may be released, guarantees cut by the day they lapse (30 and 90 days) |
| R7 | `CHANGE_TIER_GROWTH`, tier split | `tierSplitOf` | sum of the deltas of the approved changes of the tier / original value of ALL the contracts of the selection, so the tiers add up to `CHANGE_GROWTH` |

## What the answer says

`GET /contracts/analytics/reports/{code}` keeps its shape and gains `breakdowns` (every group-by of the report), `rules` (each governance rule that judged the report: type, version, source, whether it is unconfirmed, its numbers) and, per report, `evm`, `tier_split` or `ladders`. `GET /contracts/analytics/reports/schedule-delay/s-curve` (`getContractScheduleSCurve`) is the curve of the same selection. Both read live; a frozen period does not hold the earned value, the request-level clock, the changes by tier or the ladders (`contract_fact` does not carry them), so a frozen reading says `NOT_IN_SNAPSHOT` for those cells and for the whole block, and never fills the gap with a zero. Everything the snapshot does hold (status, recovery, exposure by sums) is read from it.

The earned value is read for the selection and is refused (422 `REPORT_SELECTION_TOO_LARGE`) when more than 5000 contracts of it carry a package: it is never cut and answered in part. A reader without `ledger.read` over a contract gets `LEDGER_DENIED` for every figure that is made of the ledger (earned value, clock, match, recovery, retention), and the totals leave those contracts out.

## Decision: the colour of a contract, `CONTRACT_HEALTH_RAG`

CA-1 left two definitions of the colour: the rule type registered in `governance-rules.ts` was a weighted score (five factors, weights adding to 100, `score_green_at_most`, `score_amber_at_most`), and the kernel `contractHealthRag` was the worst of four indicators with thresholds of its own. Nothing read the registered rule, so the tenant could not move a threshold.

Decided: the colour is the WORST of the indicators that apply (days late, growth through changes, guarantee coverage, paid over accepted), and the registered rule now holds exactly the parameters of that function (`days_late_amber`, `days_late_red`, `change_growth_*_pct`, `guarantee_coverage_*_pct`, `paid_to_accepted_*_pct`), validated by the same parser (`contractHealthRagParams`). The controller reads the rule through `GovernancePolicyPort`, the answer names its version and source, and a tenant approves a new version to move a line. Reasons:

- a weighted average hides a red light: with five equal weights a contract 90 days late whose other four indicators are green scores 20, below the green line of 25, and is shown green. A contract is as bad as its worst indicator.
- the colour has to be explainable in one sentence to the person who signs the report ("red because it is 60 days late"); the `drivers` of the answer already say which indicator gave the colour.
- one parameter set, one parser, one rule: the registry and the function cannot drift apart again.

Adding a dimension (for example the SPI of a contract) is a new version of the rule type, not a constant in the code. The weighted score is not lost as an idea: it can be a separate ranking figure ("attention score") over the same indicators, which would not colour anything.

## Rules and thresholds

| Rule type | Params | Default (unconfirmed, flagged on every screen) |
|---|---|---|
| `CONTRACT_THREE_WAY_MATCH` | `tolerance_pct`, `tolerance_vnd` | 2 percent, 1,000,000 dong |
| `CONTRACT_PAYMENT_CLOCK` (CA-1) | `acceptance_to_request_days`, `request_to_treasury_days` | 14, 7 |
| `ADVANCE_RECOVERY` (money control, B2) | `toleranceVnd` | 0 |
| `CONTRACT_HEALTH_RAG` | the eight lines above | 1 / 30 days, 5 / 10 percent, coverage 100 / 80 percent, paid over accepted 100 / 110 percent |
| `EVM_POLICY` (B1) | EAC method, amber and red lines of SPI and CPI | built-in, version `built-in:1` |

None of them is law. Any legal ceiling stays a master rule flagged `awaiting_confirmation`.

## BI

The dataset `DS-CTR` reads the frozen fact one field at a time (one `sum` per metric), so a difference of two sums is read as the two sums. CA-2 adds the metric files `ctr_guarantee_required`, `ctr_guarantee_valid` (the two terms of the exposure), `ctr_accepted_value`, `ctr_paid_value` (the terms of paid ahead of acceptance) and `ctr_advance_recovered_ratio`. The earned value is already `prj_spi`, `prj_cpi`, `prj_eac` at project grain. The measured work, the request-level clock, the tier of a change and the ladders are not fields of `DS-CTR` yet: putting them there needs a column on `contract_fact_snapshot_line` (a migration in block 1924-1939 of CTR-4) and a change of the builder; it is left as a follow-up so that CA-2 stays without a migration.

## Hooks left

- Freeze the earned value per contract with the snapshot (today a frozen period has the project level `evm_frozen_result` only) so that a frozen R3 can show it.
- Retention holds and guarantees by kind (advance guarantee against the advance outstanding) as a further ladder.
