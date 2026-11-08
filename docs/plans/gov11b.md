# Plan: GOV-11b, executive analytics G3-5 to G3-11

Branch `lane/gov11b`, migration block `GOVANA-1` = 2580 to 2599 (migration names `V25xx__govana1_<what>.sql`). The lane builds on the C-lane analytics already on main (KPI register, `rag-explain`, `home-changes`, BI metrics/datasets/certification, DS-DISB and DS-CTR adapters, `contract_fact`) and the FND-1 figure engine. Owner rule: decide every open choice by deepest governance and best extensibility, never cut scope. No figure is invented: a number that cannot be computed is N/A with a reason code.

## Slices (one vertical slice each: kernel, db, API, web, tests)

| Slice | Items | Migration numbers | Surface |
|---|---|---|---|
| FORECAST | G3-5, G3-11 forecast by fund source | 2594-2595 (only if state is needed) | year-end forecast with a band from the 4 to 8 week speed, cumulative and seasonality, "needed per week" |
| INSIGHT | G3-10, G3-11 backtest and trend ranking | 2596-2597 (only if state is needed) | heat-map by unit, fund source, contractor; backtest of early-warning thresholds; trend ranking |
| DECISION | G3-6 | 2580-2583 | decision log tied to HOME-03 and Urgent alerts, figures frozen at the time of the decision |
| TRUST | G3-7, G3-11 lineage | 2592-2593 | freshness SLA per dataset, "stale data" flag, quality scorecard per module and unit; metric <- dataset <- table <- module explorer |
| RANKING | G3-8 | 2584-2587 | multi-metric ranking, size normalisation, approved annotations for units blocked by outside causes, complaints about figures, disbursement rate paired with physical progress |
| BOTTLENECK | G3-9 | 2588-2591 | bottleneck analysis (held amount, standard cause, age of debt, holder), halted projects with reason record and restart plan |

## Steps (tick when done)

- [x] 0. Register block, plan file, shared helpers (mutex script), brief for the slices
- [x] 1. FORECAST: kernel `ana-forecast` (golden numbers), reader, API, screen with FlowChart band and "needed per week", 'i' formula/source/as-of, states matrix, i18n, tests
- [x] 2. INSIGHT: kernel heat-map, backtest and trend ranking, reader, API, screens, tests
- [x] 3. DECISION: kernel, migration (RLS, audit, outbox, tenant-leading indexes), store, API, screens, tests
- [x] 4. TRUST: kernel freshness and lineage graph from the metric files and registries (no new tables where possible), API, screens, tests
- [x] 5. RANKING: kernel, migration, store, API, screens, tests
- [x] 6. BOTTLENECK: kernel, migration, store, API, screens, tests
- [x] 7. Thresholds through the governance rules registry flagged unverified (`npm run governance:check`)
- [x] 8. BI metric files: no new BI metric indicator (the screens read the stored snapshot and the governance rules); `npm run bi:metrics:check` is green
- [x] 9. Integration: contracts regenerated, story and traceability rows, design pages, route table counts, UAT docs, isolation suite lists (foreign-id case per id-bearing operation; new GET without id in the implemented list and `LISTS_WITHOUT_ROWS`), command-conformance counts, outbox consumers, dis/report
- [x] 10. Gate: lint chain, typecheck, tests of what changed, self-scan, design check and baseline
- [ ] 11. Codex review (`codex review --base main`), triage of every finding, fixes with regression tests

## Tests per step

Kernel: unit tests with fixtures and golden numbers (a worked example per function, N/A cases, property checks of invariants). DB: store tests through the db lane (RLS, audit, outbox, idempotency, scope). API: controller tests through the db lane, authz matrix and isolation cases. Web: vitest of model and screens with the whole states matrix.

## Risks

- Shared files conflict between slices (openapi, vi.json, indexes): small anchored edits only, contract regeneration under a mutex.
- Memory: heavy commands one at a time through the mutex script, DB suites through the db lane.
- Source data that does not exist yet (physical progress, fund source on a payment) is read as N/A with a reason, never guessed.
