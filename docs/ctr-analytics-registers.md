# Contract analytics, the registers and the rating (CA-3)

CA-3 completes the report hub of the contract portfolio (CTR-28, opened with `?report=<code>`) with six reports that are read from the registers of the contract and not from its ledger: claims and limitation (R8), quality defects (R9), obstacles (R10), audit findings and recoveries (R11), the rating of the performance of the contractor (R13, in the manner of the CPARS of the United States federal government) and the health of the contract in red, amber and green (R16). It stands on the foundation of CA-1 and CA-2: every indicator is defined once in the kernel (`CTR_INDICATORS` of `packages/kernel/src/ctr-analytics.ts`: formula, numerator, denominator, source tables, null policy), the filters, the sort and the cursor are on the server, the total is made from the same rows the page shows (so total = sum of the rows = the Excel read back), a figure that cannot be known is empty with a NAMED reason and never 0, and the file is xlsx, csv or pdf by the same endpoint.

No new endpoint carries the reports: `GET /contracts/analytics/reports/{code}` and `.../export` take the six new codes, with the same answer shape (columns, items, totals, breakdowns, rules, definitions, `next_cursor`), two more filters (`severity`, `state`, lists) and, on each item, the id of the record (`record_id`) next to the id of its contract.

## The reports

| Report | Row | Source | Indicators (all with an "i") |
|---|---|---|---|
| `claims-limitation` R8 | a claim | `change_request` (submitted events, change orders; a draft is not a claim, a promoted one goes on as its child), `warranty_claim` with `warranty_obligation` | `CLAIM_SETTLEMENT_RATE`, `CLAIM_LIMITATION_RISK` |
| `quality-defects` R9 | a non-conformance | `quality_nonconformance` | `DEFECT_CLOSURE_RATE`, `DEFECT_OVERDUE_RATE`, `DEFECT_REOPEN_RATE` |
| `obstacles` R10 | an issue linked to a contract | `issue` (the open issues of the project that name no contract are counted in `notes.unlinked_open_issues`, they are not in the table) | `OBSTACLE_OVERDUE_RATE`, `OBSTACLE_ESCALATION_RATE` |
| `audit-findings` R11 | a finding | `audit_finding` with its engagement, `audit_recommendation` (financial types) | `AUDIT_RECOVERY_RATE`, `AUDIT_OVERDUE_RECOMMENDATION_RATE` |
| `performance-rating` R13 | a contract that can be rated | the proposal from data (below), the stored proposal and the official evaluation | `RATING_COVERAGE`, `RATING_RESPONSE_RATE` |
| `contract-health` R16 | a contract | `contract_fact` (live or frozen) | `CONTRACT_RED_SHARE`, with `DAYS_LATE`, `CHANGE_GROWTH`, `GUARANTEE_COVERAGE`, `PAID_TO_ACCEPTED` |

A ratio is the sum of the numerators over the sum of the denominators of the rows (a flag column adds 1 or 0 per row), never the mean of the ratios; the rows that a ratio leaves out say why (`NOT_OPEN`, `NOT_DECIDED`, `NO_LIMITATION_TERM`, `NO_DUE_DAY`, ...). The groups of a breakdown are totals of their own rows and add up to the total.

**Live readings.** A register keeps no frozen copy, so the five register reports are read today: `snapshot_id`, `period` and a past `as_of` are refused (422). The health of the contract reads the fact and keeps the frozen period and the day. More than 20,000 records in a selection is 422 `REPORT_SELECTION_TOO_LARGE` (refused, never cut).

**Scope and confidentiality.** The selection is the one of the other reports (scope of `contract.analytics.read` over the contracts, the filters of the query). Audit data is CONFIDENTIAL: the findings are read through `engagementScope` of `listAuditEngagements` (an engagement outside every grant is not found), their words are never in a report, and their money follows `ledger.read` over the contract (`LEDGER_DENIED` in the cell, the total leaves the record out). The rating hides the financial score, the overall score and the rating of a contract whose ledger the reader may not see, because they are made of it.

## Claims and limitation, and the hook for GOV-8

The claim register of GOV-8 (`contract_claim`, lane `gov8`) was not on main when CA-3 was built, so the report reads the claim-like records that exist, mapped to one normal form (`ClaimRecord`): a variation event or change order (money from `estimated_delta_vnd` / `approved_delta_vnd`, days from `schedule_impact_days`) and a warranty claim. The limitation of a claim is judged by `limitationOf`:

- a warranty claim is in time when it was reported on or before the end of its warranty;
- a variation has a decision window: the rule `CONTRACT_CLAIM_LIMITATION` (`decision_window_days`, `near_days`; defaults 28 and 7, flagged UNVERIFIED, not law) added to the day it was submitted: open, it runs, comes near and lapses; decided, it is in time or out of time by the day of the decision;
- a record with no term is NOT_JUDGED, with the reason, and is left out of `CLAIM_LIMITATION_RISK`.

**Hook.** When `contract_claim` is on main, add a reader that maps a row to `ClaimRecord` (`code`, `kind`, `claimed_amount_vnd`, `claimed_days`, `settled_amount_vnd`, `granted_days`, `status`: SETTLED to GRANTED or PARTLY_GRANTED by the amount, `TIME_BARRED` and REJECTED to REJECTED, WITHDRAWN, the other statuses to OPEN; `awareness_on` as `filedOn`) with `limitation: { basis: 'CLAIM_TERM', on: <the day its term gives> }`, and append them to `CtrRegisterReader.claims` (`packages/db/src/ctr-register-reader.ts`). Nothing else changes: the columns, the totals and the file already read the normal form.

## The rating of the performance of a contractor

**Rule.** `CONTRACT_PERFORMANCE_RATING` of the governance registry (registered in `governance-rules.ts`, parser `ratingParams`): the weights of the five criteria (they add to 100), the lines of the ratings (excellent, good, fair), the least number of criteria with data, the days a contract must be observed, and the penalties of each criterion. Defaults are those of the scorecard of CTR-23 and are flagged UNVERIFIED. A tenant approves a new version; the proposal keeps the version and the source of the rule it was judged by, and the digest of its inputs.

**Score.** Each criterion is 100 minus the penalties the data give, to a whole number: quality (open and closed defects by severity, reopenings), schedule (days late against the original due day, zero at `schedule_zero_score_days_late`), safety and environment (confirmed violations of those kinds), cooperation (open obstacles that are overdue or escalated), financial (guarantee not in force, paid over accepted, audit amounts not recovered). A criterion for which the data do not exist (no accepted work and no defects, a contract observed less than `min_observation_days`, no financial evidence) has NO score and a reason; the overall score is the mean of the criteria that have a score, in proportion to their weights, and is proposed only when at least `min_criteria` have one. The same function serves the report row and the command.

**Life.** `PROPOSED` (proposeContractRating, by `contractor.performance.propose`) -> `NOTIFIED` (notifyContractRating, a person other than the proposer) -> `RESPONDED` (recordContractRatingResponse: accept, dispute with grounds, no comment; late or not, the lateness is a figure) -> `ADOPTED` (adoptContractRating, a person other than the proposer: after the answer, or once the window ended with none, 409 `RATING_RESPONSE_WINDOW_OPEN` before that). A proposal that the contractor was not told of can be withdrawn. Adoption makes the evaluation of CTR-23 with the five scores (a criterion with no data needs an override with a reason of 20 characters; a score the data gave cannot be replaced), which then waits for its own approval by a second person; its approval is the fact `EVALUATION_APPROVED` that opens the posting of the evaluation (6 months). One live proposal per contract, kind and period (409 `RATING_PROPOSAL_EXISTS`). The table (`contract_rating_proposal`, V1924) holds the same edges and the maker-checker rules as CHECKs and a guard.

**The window of the contractor and e-GP.** Telling the contractor emits the fact `CONTRACTOR_NOTIFIED`: in the same transaction `EgpObligationStore.open` opens the obligation `CONTRACTOR_RESPONSE` (subject: the contractor by its tax code, source: the proposal, trigger: the instant it was told), whose deadline comes from the rule `EGP_POSTING_DEADLINES` (20 calendar days, moved to a working day) and the published working calendar (a year with no calendar is 422 `CALENDAR_NOT_EFFECTIVE`: a deadline is never guessed). That deadline is the end of the response window of the proposal: one source of the 20 days. The clock shown to the reader is the work-clock engine (`nativeClock`): running, near (within 24 working hours), lapsed, answered in time, answered late. The same fact is in the sweep of the obligations (`EGP_OBLIGATION_FACTS`, `FACT_QUERIES.CONTRACTOR_NOTIFIED`), idempotent with the command by the key (kind, source, instant).

**Known limits.** The weights of the official evaluation of CTR-23 are still `SCORECARD_RULE` (R-CTR-05): when a tenant changes the weights of the rating rule, the proposal and the evaluation made from it can show different overall scores; the evaluation is judged by its own approval. There is no alert type for a response window about to lapse yet (the obligation `EGP_POSTING_DUE` and `EGP_POSTING_OVERDUE` alerts cover its posting).

## Links to what exists

The rating report and the health report link to the scorecard (CTR-23), the payment integrity checks (G4-2) and the settlement of the project (PAY-15 and PAY-16); the hub card of each report names its source. These are links to the screens that hold the detail, not copies of their figures.

## BI

The registers are not part of the frozen contract fact, so none of the new indicators is a field of the dataset `DS-CTR` and there is no new metric file: giving a register indicator a metric needs a column on `contract_fact_snapshot_line` (a migration in the free tail of block CTR-4, 1925-1939) and a change of the builder, and is left as a follow-up. The health of a contract is already trended through the DS-CTR metrics of its inputs.

## Pieces

| Piece | File |
|---|---|
| Indicators (12 new) | `packages/kernel/src/ctr-analytics.ts` |
| Rows, totals, breakdowns, order, pages, filters and files of the register reports | `packages/kernel/src/ctr-register-reports.ts`, tests `packages/kernel/test/ctr-register-reports.test.ts` |
| Rating rule, proposal, life, clock, commands' inputs | `packages/kernel/src/ctr-performance-rating.ts`, tests `packages/kernel/test/ctr-performance-rating.test.ts` |
| Rules `CONTRACT_CLAIM_LIMITATION`, `CONTRACT_PERFORMANCE_RATING` | `packages/kernel/src/governance-rules.ts` |
| Registers reader | `packages/db/src/ctr-register-reader.ts` |
| Proposals store | `packages/db/src/ctr-rating-store.ts`, migration `db/migrations/V1924__ctr4_contract_rating_proposal.sql` |
| Reports on the endpoint | `apps/api/src/modules/ctr/analytics.controller.ts` |
| Rating commands and reads | `apps/api/src/modules/ctr/rating.controller.ts` |
| Screens | the six reports in the hub CTR-28, the proposals in CTR-37 (`apps/web/src/screens/ctr/analytics/`) |
