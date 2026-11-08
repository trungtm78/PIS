# Plan of lane HUB-1: the Integration Hub

Branch `lane/hub1`, worktree `D:\PIS-hub1`, migration block HUB-1 2540-2559.

Goal (owner, 2026-11-08): every external data connection (e-GP, Finance Department feed, HPM and EBS, Treasury, national codes, machine accounts, Lakehouse readers) is managed in one Integration Hub through a descriptor, with transport protocols and an ETL pipeline model.

## Steps and status

1. Kernel: descriptor, open registry, health, summary, runs, incidents, snapshots (`connector-hub.ts`), built-in descriptors, rule defaults (`INTEGRATION_HUB_POLICY`, alert types, KPI definitions) - DONE.
2. Kernel: transport protocol registry and ports (`connector-protocols.ts`), ETL model and runner (`etl-pipeline.ts`), conformance helper (`connector-conformance.ts`) - DONE, tests in progress.
3. Kernel tests: hub, protocols, ETL runner (partial failure, retry idempotency, replay, watermark after load, reject reprocess), conformance of the built-ins.
4. DB: migrations V2540 to V2545 (state, run log with stage counts, incidents, snapshots, mapping versions and watermark, rejects and lineage, alert source), `HubStore`, file framework adapter, EGP adapter, conformance helper, tests through the db lane.
5. API: contract-patch operations, controllers, authz matrix, command registry, error codes, isolation (foreign-id) cases, API tests.
6. Web: HUB-01 catalogue, HUB-02 connector detail with tabs (overview, runs, pipeline, mapping, differences, credentials, layouts and policy), HUB-03 incident log; i18n parts; design rows.
7. Docs: `docs/integration-hub.md` (descriptor contract, protocols, ETL, no-egress rule, health model, 30-line connector recipe, reading of "CTL" as ETL), module spec HUB.md, design JSON rows.
8. Gates: lint, typecheck, tests of what changed, isolation, command-conformance, outbox-consumers, dis/report; Codex review `codex review --base main -c 'model="gpt-6-astra"' ...`, triage, fixes with regression tests.

## Decisions

- Hub status words: HEALTHY, STALE, FAILING, DISABLED, PENDING_EXTERNAL, plus NEVER_RUN (a connector nobody used is not "fine" and not a fault).
- Acceptance of layouts is carried beside the status, never merged into it.
- Thresholds only through the rule `INTEGRATION_HUB_POLICY` and `CONNECTOR_FRESHNESS`.
- A protocol that reaches another host runs only behind a tenant-approved egress exception; real adapters are refusing stubs now. The store and commands of egress exceptions are a follow-up (HUB-2).
- Adapters read the connector tables of other lanes; the hub never writes them. The hub keeps its own state only for connectors without a switch of their own.
