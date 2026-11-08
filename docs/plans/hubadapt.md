# Plan of lane HUBADAPT: Integration Hub adoption and the loose alert-source ends

Branch `lane/hubadapt`, worktree `D:\PIS-hubadapt`, migration block HUB-2 2620-2639 (the block 2560-2579 of the brief belongs to GOV-11 on main, so the next free one after GOV-12 at 2600 was registered).

Owner rule 2026-11-08: no scope cut, decide by deepest governance and extensibility. HUB-1 (descriptor registry, health model, protocols, ETL runner, conformance kit, collector agents) is on main; this lane makes every existing connection a registered connector and closes the alert sources that the earlier lanes left open.

## Decisions

1. One descriptor per connection, written as plain data next to the module that owns the connection when it is part of the public product (kernel `connector-hub-builtins.ts` and a new `connector-hub-adopted.ts`), and next to the enterprise package for HPM and EBS (registered when the enterprise edition loads, so the public edition never shows them).
2. A connector keeps its own import path and its own switch. The hub learns about it through (a) the file import framework positions it already uses, (b) a `HubStateAdapter` for connectors that own a switch (feed), (c) a new shared port `HubRunPort` in `packages/db` that a store calls in its own transaction to write one row into `hub_run_log` (idempotent by `source_ref`), (d) probes: a registered `HubProbe` per connector that the hub sweep calls to record one CHECK run per hour from the facts the connector already holds (machine accounts and BI readers). No behaviour of the connector changes.
3. HPM keeps its own policy rule `HPM_PUSH_POLICY`; the hub freshness is the rule code `HPM_PUSH` under `CONNECTOR_FRESHNESS` with the same numbers (a test holds them equal).
4. Alert sources: `PROJECT_RISK` (MR-1 `project_risk_alert`) and `COMMITTEE` (BAN-1 `committee_alert`) become work sources of the alert centre, with kinds, priorities, severity facets, consequences, ALERT_TYPE rows that already exist (owner, action, consequence), the web alert kit lists and the three contract enums. GOV-8 sources are checked and added only if missing.
5. HUB-01 gets a "Registry" tab: one row per descriptor with direction, protocols (running and planned), layouts with version and acceptance, freshness policy, credential need, consumers, alert types, egress, who owns the switch and where the history lives, next to the status. It is fed by one new read operation `listHubRegistry`.

## Steps

- [x] 0. Plan and migration block registered.
- [ ] 1. Kernel: descriptors for fin.sotaichinh, access.open-api, bi.read-views, indicator.import, master.data_import, backup.tenant (if it fits); conformance cases for each; alert types and freshness codes they need. Tests: `connector-hub.test.ts` additions.
- [ ] 2. Enterprise: descriptors hpm.reports and ebs.ledger, freshness code `HPM_PUSH`, registration when the edition loads. Tests: `connection-descriptors.test.ts`.
- [ ] 3. DB: `HubRunPort`, `HubProbe` registry and sweep hook, state adapters for fin.sotaichinh and the enterprise connections, feed and HPM report their runs through the port; access probe. Tests: `hub-adapt.test.ts` through the db lane.
- [ ] 4. Alert sources (MR-1, BAN-1, GOV-8 check): kernel kinds, db sources, migration V2620 for the check on `work_action.source`, `WORK_SOURCES`, web alert kit, work model, contract enums. Tests: kernel, db, web.
- [ ] 5. Registry read: operation `listHubRegistry` (contract-patch), controller, authz, story row. API test.
- [ ] 6. Web: Registry tab on HUB-01, i18n parts `hubadapt.{vi,en}.json`, vitest.
- [ ] 7. Shared suite entries (not run): isolation, reachability, command-conformance counts, outbox consumers, workers/jobs lists; docs (`docs/integration-hub.md`, finance feed, notes).
- [ ] 8. Gates: lint, typecheck, tests of what changed; Codex review (gpt-6-astra, base main) with triage.

## Risks

- A connector that reports to the hub run log and also has positions in the file framework would be counted twice: the port is used only for runs that do not pass through the framework (feed push and generator, HPM pushes, probes).
- `work_action.source` is guarded by a CHECK; the migration reads the constraint as it stands and adds the missing values only (the pattern of V2573).
- The three shared JSON files (openapi, error codes, screen catalogue) and the i18n catalogues are edited through the tools or with anchored one-line additions only.
