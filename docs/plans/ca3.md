# Plan of lane CA-3: the remaining contract analytics reports

Branch `lane/ca3`, worktree `D:\PIS-ca3`. Migrations only in the free tail of block CTR-4 (1924-1939). Stands on CA-1 and CA-2 (`packages/kernel/src/ctr-analytics.ts`, `ctr-reports.ts`, `ctr-money-reports.ts`, `apps/api/src/modules/ctr/analytics.controller.ts`, `apps/web/src/screens/ctr/analytics/*`, `docs/ctr-analytics-money.md`).

## Decisions (owner rule 2026-11-08: decide by governance, extensibility, no cut of scope)

1. **Same envelope, new codes.** The six new reports (`claims-limitation`, `quality-defects`, `obstacles`, `audit-findings`, `performance-rating`, `contract-health`) are served by the existing `GET /contracts/analytics/reports/{code}` and its export, with the same answer shape (columns, items, totals, breakdowns, rules, definitions, next_cursor), so the hub CTR-28 and `ReportPage` render them with no second page. A register report has one row per record (claim, defect, issue, finding) with `contract_id` and `record_id`; the totals are made from the same rows the page shows, so total = sum of rows = the Excel read back.
2. **Registers are read live.** A register is not part of the frozen contract fact, so `snapshot_id`, `period` and a past `as_of` are refused (422) for the five register reports; `contract-health` reads the fact and keeps both. A cap of rows (REPORT_SELECTION_TOO_LARGE) refuses rather than cuts.
3. **Claims.** The claim register of GOV-8 is not on main: the reports read the claim-like records that exist (variation events and change orders, warranty claims) through one normal form (`ClaimRecord`). The limitation term of a warranty claim is the end of the warranty; of a variation it is the decision window of the rule `CONTRACT_CLAIM_LIMITATION`; a claim with no term is "not judged" with the named reason. Hook: GOV-8 `contract_claim` maps to `ClaimRecord` with basis `CLAIM_TERM` (documented in `docs/ctr-analytics-registers.md`).
4. **Audit data is CONFIDENTIAL.** Findings are read through `engagementScope` and the money of a finding follows `ledger.read`; the description of a finding is never in a report.
5. **CPARS-style rating.** The score is proposed from data by the rule `CONTRACT_PERFORMANCE_RATING` (weights, penalties, thresholds, minimum criteria; a criterion with no data has no score, never 0). A proposal is stored (table `contract_rating_proposal`, V1924), notified to the contractor by a second person, the contractor answers inside the window (the window is the e-GP rule `EGP_POSTING_DEADLINES/CONTRACTOR_RESPONSE`, one source of the 20 days, clock by the work-clock engine), then a person other than the proposer adopts it: the adoption creates the DRAFT evaluation of CTR-23 (the existing maker-checker approves it and the e-GP fact `EVALUATION_APPROVED` follows). Notifying emits the fact `CONTRACTOR_NOTIFIED`, which opens the obligation `CONTRACTOR_RESPONSE`.
6. **Health.** The colour is the worst-of function reconciled in CA-2 (`healthOfFact`); the report adds the share of red contracts.

## Work list

- [x] indicators (12) and reasons in - [x] kernel: register reports, rating rule and proposal, state machine, tests (34 new tests)
- [x] db: V1924 proposal table, register reader, rating store, e-GP fact hook ( in the sweep and in the notify command)
- [x] api: the six reports on the report endpoint and its export, rating commands and reads, contract, authz, isolation cases
- [x] web: report codes in the hub, record filters, related links, CTR-32 with the steps, i18n parts, tests
- [x] docs (), design rows
- [ ] gates: API agreement test, isolation, command-conformance, outbox, dis-report, lint, typecheck
- [ ] Codex review with dispositions

## Not done, on purpose

- DS-CTR metric files: the registers are not in the frozen fact (needs a column on  and the builder: follow-up in the tail 1925-1939).
- The claim register of GOV-8 (not on main): the documented hook maps its table to .
- An alert type for a response window about to lapse (the e-GP posting alerts cover the posting).
- The pages of the design pack were not rebuilt ( is not installed in the worktree): run  where it is.
