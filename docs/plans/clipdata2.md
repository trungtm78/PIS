# Lane CLIPDATA2: the product-side blockers of the clip seed layer

Goal: build what the seed layer of the two clips (docs/clip-data.md, plan docs/plans/clipdata.md) could not do for want of product support, code only (no stack until the coordinator gives a window), with tests, and extend the groups and `verify` to use it.

## Steps

- [x] 1. Committee workspace from the finance feed where no frozen snapshot exists: kernel `feedFactsToProvinceFacts` (test `committee-feed-facts.test.ts`, run, 7 passed), db `FeedProvinceFactsReader` and `SnapshotOrFeedFactsReader` (new cases in `finance-feed-store.test.ts`, to run), default of the committee service.
- [x] 2. The `conflict` data command of the phone chapter (MOB-42): `makeDiaryConflict`, three tests (run, passed), the blocker removed from the verification ledger.
- [x] 3. Demo template pack of the Treasury payment forms (four DEMO templates, `DEMO_FORMS`), pack test (to run), seed confirmation by a person; groups for measurement, acceptance, payment, advance (some in the past through the stack clock) and their `verify`.
- [x] 4. The metric bundle inline in `syncMetricRegistry` (schema through contract-patch, regenerated contracts, `metricBundleSource`, API tests to run), group `clip-public-bi` (sync, two dashboards published by the leader) and its `verify`.
- [x] 5. Package states: proposals and results accept the packages an approved plan gives (`PLANNED`), unblocking tenders, awards and contracts; tests.
- [x] 6. Every text the groups write comes from the Vietnamese fixture (`clipText`).
- [x] 7. Docs (`docs/clip-data.md`, `committee-workspace.md`, `bi-metrics.md`, `pay-treasury-forms.md`), gates, Codex review and triage, report with the exact commands of the stack window.

## Tests

Pure (run): `node --test scripts/clip-seed.test.mjs scripts/hdsd/mobile-data.test.mjs`, `apps/web` `node --test e2e/hdsd/seed/clip/clip.test.ts`, kernel `jest test/committee-feed-facts`. Database lane (to run in a window): packages/db `finance-feed-store`, `bid-proposal-store`, `bid-result-store`, `bid-open-for-bids`; apps/api `bi-metrics`, `metric-bundle-source`, `template-pack`, `committee`.

## Risks

- The payment chain and the other new groups were written from the code, not run: expect first-run fixes. `verify` fails until the data is there.
- The clock shifts only `Date`; what the database stamps (`created_at`) stays real.
- No new operation was added, so no authz matrix, isolation, conformance-count or worker-list entry was needed (the changed operation `syncMetricRegistry` keeps its name, permission and scope).
