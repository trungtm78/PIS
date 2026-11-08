# Plan of lane HUB-1: the Integration Hub

Branch `lane/hub1`, worktree `D:\PIS-hub1`, migration block HUB-1 2540-2559.

Goal (owner, 2026-11-08): every external data connection (e-GP, Finance Department feed, HPM and EBS, Treasury, national codes, machine accounts, Lakehouse readers) is managed in one Integration Hub through a descriptor, with transport protocols and an ETL pipeline model.

## Steps and status

1. Kernel: descriptor, open registry, health, summary, runs, incidents, snapshots (`connector-hub.ts`), built-in descriptors, rule defaults (`INTEGRATION_HUB_POLICY`, alert types, KPI definitions) - DONE.
2. Kernel: transport protocol registry and ports (`connector-protocols.ts`), ETL model and runner (`etl-pipeline.ts`), conformance helper (`connector-conformance.ts`), collector agent rules - DONE with tests.
3. DB: migrations V2540 to V2545, `HubStore`, adapters (e-GP switch), tests through the db lane - DONE (test run result in the report).
4. API: contract-patch operations (17), controllers, authz matrix, isolation (foreign-id) cases, error codes, API tests - DONE.
5. Web: HUB-01 catalogue, HUB-02 connector detail with seven tabs, HUB-03 incident log, i18n, routes, navigation, design rows, tests - DONE.
6. Docs: `docs/integration-hub.md`, `HUB.md`, design JSON rows, rebuilt pages - DONE.
7. Gates: lint, typecheck, tests of what changed, isolation, command-conformance, outbox-consumers, dis-report; Codex review with triage - see the report.
8. Follow-ups (HUB-2): egress exception store and commands; the stage runner as the implementation of the existing imports; `HomeConnectorSources` over every connector; ADM working calendar for the schedule; real protocol adapters.

## Decisions

- Hub status words: HEALTHY, STALE, FAILING, DISABLED, PENDING_EXTERNAL, plus NEVER_RUN (a connector nobody used is not "fine" and not a fault).
- Acceptance of layouts is carried beside the status, never merged into it.
- Thresholds only through the rule `INTEGRATION_HUB_POLICY` and `CONNECTOR_FRESHNESS`.
- A protocol that reaches another host runs only behind a tenant-approved egress exception; real adapters are refusing stubs now. The store and commands of egress exceptions are a follow-up (HUB-2).
- Adapters read the connector tables of other lanes; the hub never writes them. The hub keeps its own state only for connectors without a switch of their own.
