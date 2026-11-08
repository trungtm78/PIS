# Plan of lane FEED-1: the feed of the Finance Department (fin.sotaichinh)

Branch `lane/feed1`, worktree `D:\PIS-feed1`, migration block FEED-1 2500-2519. Priority HIGH (owner request of 2026-11-08). Spec and decisions: `docs/finance-feed.md`.

## Decisions (owner standing rule: decided by governance and extensibility, scope not cut)

1. "ARM" is not defined anywhere. Read as: a data feed from the application of the Finance Department (Sở Tài chính) into this system that works like the real feed would, so the committee led by the head of Ban 57 (PA05, Công an tỉnh) can steer public investment across the province end to end. The real feed replaces the generator without touching a consumer.
2. Owner decision of the same day, replacing the "MÔ PHỎNG" parts of the first brief: build the REAL core first; no stamp, no demo-mode guard, no separate simulated figures. Records of every channel flow into the core alike. Only an internal provenance column (`channel` FILE | API_PUSH | GENERATOR, plus the run id and, for the generator, an epoch) is kept for audit and replay. The generator is "bộ sinh dữ liệu": a deterministic producer of realistic records that goes through the same layouts, dry run and apply as a file.
3. The FILE layout is a working assumption (`WORKING-ASSUMPTION-FIN-2026.1`), PENDING-EXTERNAL (R18) until the Finance Department publishes its own. API_PUSH is a port plus a stub that refuses with `FEED_API_UNAVAILABLE` (INT-1 machine account has not landed).
4. All the hub needs about the connector is in one plain constant, `packages/kernel/src/finance-feed-connection.ts`.

## Steps

| # | Step | State |
|---|---|---|
| 1 | Kernel: model, layouts, port and three adapters, generator, reader, management rules, rules registration (policy, freshness line, three KPIs, three alert types), connection descriptor, tests | done |
| 2 | Migrations V2500-V2503 (connection and events, runs and records, differences, reconciliation runs), RLS, append-only, maker-checker checks | done |
| 3 | DB stores: connection, records and runs, mapping on `master_crosswalk`, differences, reader, file import adapter; db tests through the lane | done (test file written; run result in the report) |
| 4 | Alerts into the alert centre (`CONNECTOR` source): FEED_STALE, FEED_UNIT_LATE, FEED_DISCREPANCY_LARGE | done |
| 5 | Contract (contract-patch: 20 operations, schemas, 6 error codes, screens FEED-01..FEED-05), generated clients | done |
| 6 | API: controllers, authz matrix, command registry, isolation fixtures and foreign-id cases, API tests, no-egress test | done (run results in the report) |
| 7 | Web: five screens, kit, states matrix, i18n parts, vitest (by a delegated agent) | done |
| 8 | Design JSON (story ST-FEED-001, traceability, backlog, test cases), `docs/finance-feed.md` | done |
| 9 | Edge collector agent (`scripts/feed-collector/`, Node, no native dependency, offline spool, idempotent push, heartbeat), fake-only tests | done |
| 10 | Gates: lint, typecheck, migrations:check, commands:check, contracts:check, error codes lint, isolation, conformance, outbox consumers, dis/report, Codex review and triage | in progress |

## Hooks left for other lanes

- BAN-1 reads only `ProvinceFactsReader` (db) / `aggregateFeedFacts` (kernel) and the `getFinanceFeedFacts` operation.
- INT-1: replace `FeedApiPushAdapter` by the machine-account endpoint calling `feedBatchOfRows`.
- Hub: adapt `FINANCE_FEED_CONNECTION` to the hub descriptor.
