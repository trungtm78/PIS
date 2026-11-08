# The Integration Hub (`HUB`)

Lane HUB-1. Owner direction of 2026-11-08: the connectors to the national procurement network (e-GP), the Finance Department feed, HPM and Oracle EBS, the Treasury and national-code files, machine accounts and BI readers are **one Integration Hub** that manages every external data connection in the same way. Screens `HUB-01` (catalogue and health), `HUB-02` (connector detail), `HUB-03` (incident log). Code: `packages/kernel/src/connector-hub*.ts`, `connector-protocols.ts`, `etl-pipeline.ts`, `connector-conformance.ts`; `packages/db/src/hub-store.ts`, `hub-adapters.ts`; `apps/api/src/modules/hub/`; `apps/web/src/screens/hub/`. Migrations V2540 to V2545 (block 2540-2559).

**Reading of "CTL" in the owner's brief.** The owner asked for connection protocols and data-collection protocols "như là CTL". It is read as **ETL** (extract, transform, load), the standard model of collecting data from outside systems. The "ARM" clarification is read as ARM (Cross-Platform Hardware and OS): collectors may run on ARM hardware and any operating system (section 8).

The hub reads the connector tables of other lanes through descriptors and adapters. It never rewrites them. It owns only: the switch of a connector that has none of its own, the run log, incidents, health snapshots, mapping versions, watermarks, the dead-letter list, the lineage and the collector agents.

## 1. The descriptor contract

A connector plugs in by a `ConnectorDescriptor` (plain data, `connector-hub.ts`). The registry is open (`registerConnector`), like the governance rule type registry. A descriptor is judged when it is registered and in the conformance test.

| Field | Meaning |
|---|---|
| `code` | The code of the connector as the registry of connectors (ADM) knows it: `^[a-z0-9_.-]{3,60}$` |
| `name` | English name (the screens translate it by the key `hub.connector.<code>.name` and fall back to this) |
| `direction` | `INBOUND`, `OUTBOUND` or `BOTH`; there must be a protocol that can carry it |
| `protocols`, `plannedProtocols` | Codes of the protocol registry (section 4). A protocol that reaches another host is listed in `protocols` only with a declared egress |
| `layouts` | `{ code, version, acceptance, pending? }`: every layout is versioned; `acceptance` is `PENDING_EXTERNAL` (a working assumption waiting for the sample and the confirmation of the other side, eng-review R18), `ACCEPTED` or `NOT_APPLICABLE` |
| `freshness` | `{ ruleCode, defaults, unverified }`: the code under the rule type `CONNECTOR_FRESHNESS`; `null` when the age is not judged |
| `credentials` | `NONE`, `VAULT_REFERENCE` or `MACHINE_ACCOUNT` (with `scopes`). The secret itself is never in the database, only a `secret://` reference |
| `consumers` | The module codes that read the data |
| `alertTypes` | Alert types it can raise besides `CONNECTOR_FAILING` and (when the age is judged) `CONNECTOR_STALE`; each must be an `ALERT_TYPE` with owner, expected action and consequence |
| `ownerRole` | The role that answers for it (default `INTEGRATION_ADMINISTRATOR`) |
| `egress` | `{ policy: 'NONE' }` (default) or `{ policy: 'DECLARED', hosts, reason }` |
| `screens` | Screen ids it owns (BID-22 ...); the hub links to them by route |
| `ledger` | `{ kind, positions, sourceSystems, stateOwner }`: where its history lives (section 3) |
| `pipelines` | The ETL pipelines (section 5): one per layout is the usual shape |
| `sources` | Repo-relative files that implement it; the conformance helper reads them |

### How a lane adds a connector in 30 lines

```ts
// packages/kernel/src/my-connector.ts (or next to the connector's own module)
import { registerConnector, registerRuleDefaults, connectorFreshnessParams } from '@machvon/kernel';

export const MY_DESCRIPTOR: ConnectorDescriptor = {
  code: 'finance.dept_feed',
  name: 'Finance Department feed',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  plannedProtocols: ['SFTP', 'HTTPS_REST'],
  layouts: [{ code: 'FEED', version: 'WORKING-ASSUMPTION-2026.1', acceptance: 'PENDING_EXTERNAL', pending: ['SAMPLE_FEED'] }],
  freshness: { ruleCode: 'FINANCE_FEED', defaults: { maxAgeHours: 48, warnAfterHours: 24, staleSeverity: 'ACTION', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['DIS', 'HOME'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['FED-01'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: ['FINANCE_FEED_FILE'], sourceSystems: ['FINANCE_DEPT'], stateOwner: 'HUB' },
  pipelines: [{ code: 'FEED', name: 'Feed file', protocol: 'FILE_DROP', mode: 'INCREMENTAL', layoutCode: 'FEED', layoutVersion: 'WORKING-ASSUMPTION-2026.1', target: 'feed.import.apply', schedule: MANUAL_SCHEDULE }],
  sources: ['packages/kernel/src/finance-feed.ts', 'packages/db/src/finance-feed-store.ts'],
};
registerConnector(MY_DESCRIPTOR);            // once, where the module loads (the API module of the lane calls it)
// the freshness code, in the registration function of the lane's governance rules:
registerRuleDefaults('CONNECTOR_FRESHNESS', { FINANCE_FEED: { params: connectorFreshnessParams(MY_DESCRIPTOR.freshness!) } });
```

Then, in the lane's tests:

```ts
registerAllGovernanceRules(); registerConnector(MY_DESCRIPTOR);
expect(connectorConformanceProblems(MY_DESCRIPTOR)).toEqual([]);
expect(await runWithNetworkWatch(async () => { /* run the adapter */ })).toEqual([]);   // egress NONE only
```

A connector with a switch of its own (`stateOwner: 'CONNECTOR'`) also calls `registerHubStateAdapter(code, { read, set })` from `packages/db/src/hub-adapters.ts` (see the e-GP adapter, 25 lines): the hub then moves the switch through the connector's own store, so its history and its rules stay the connector's. A connector that reports its runs by command (an API pull, a machine account, a reader of the Lakehouse) uses `ledger.kind: 'HUB_RUNS'` and the command `recordHubRun`. Adapting FEED-1, ENT-2 and INT-1 at merge time is one descriptor each.

## 2. Health model

Pure function `connectorHealth` (kernel). In this order:

1. `DISABLED` when the switch is off (a reason is on record);
2. `FAILING` when the last `failing_after_runs` runs failed in a row (rule `INTEGRATION_HUB_POLICY`, default 1); alert `CONNECTOR_FAILING`;
3. with no successful run: `PENDING_EXTERNAL` when the layouts wait for the other side and nothing has run, else `NEVER_RUN`;
4. otherwise by the age of the last successful run against the rule `CONNECTOR_FRESHNESS` of its `ruleCode`: `STALE` beyond `max_age_hours` (alert `CONNECTOR_STALE` at `stale_severity`; the figures are blocked when the rule says so), `HEALTHY` otherwise (band `AGING` past `warn_after_hours`).

`NEVER_RUN` is the sixth word on top of the five the brief named: a connector nobody has used is not "fine" and not a fault, and is never shown as "no data". **The acceptance of the layouts is carried beside the status and never changes it**: data that rests on a working assumption is HEALTHY and says `PENDING_EXTERNAL` next to it. A run that moved data (a file applied, even with rows set aside) counts as a success for the age; a dry run counts for nothing.

All thresholds are rules (`CONNECTOR_FRESHNESS`, `INTEGRATION_HUB_POLICY`), our own operational choice flagged `UNVERIFIED` until the agency approves its own version.

### The KPI set (the KPI register, rule type `KPI_DEFINITION`)

| Code | Formula (summary) | Source |
|---|---|---|
| `HUB_CONNECTORS_HEALTHY_PCT` | HEALTHY connectors / monitored connectors x 100; monitored = enabled and not PENDING_EXTERNAL; no figure when nothing is monitored | `HubStore.readings` |
| `HUB_OLDEST_DATA_AGE_DAYS` | now minus the last successful run of the oldest enabled connector, in days | same |
| `HUB_FAILED_RUNS_7D` | runs with outcome FAILED started in the 7 days before now | file import framework and `hub_run_log` |
| `HUB_DISCREPANCY_BACKLOG` | open `file_import_reconciliation_item` rows of the connector positions | same |
| `HUB_PENDING_MAPPINGS` | `master_crosswalk` rows PROPOSED for the connectors' source systems | same |

Each carries formula, numerator, denominator, exclusions, source, owner, as-of and the unverified flag; the screens show them behind the "i".

### Alert types (`ALERT_TYPE`)

| Code | Owner | Expected action | Consequence |
|---|---|---|---|
| `CONNECTOR_STALE` (existing) | INTEGRATION_ADMINISTRATOR | check the connector, fetch the latest file, record the cause | figures from outside older than allowed must say so |
| `CONNECTOR_FAILING` | INTEGRATION_ADMINISTRATOR | open the connector, read the last failed run, fix the cause, run again, write the cause on the incident | figures stop at the last successful run and say so |
| `CONNECTOR_HUB_STALE` | INTEGRATION_ADMINISTRATOR | find why many connectors are stale at once, assign each, tell the leadership | aggregate reports may differ from reality |

The hub-wide alert is raised when the share of STALE connectors among those monitored reaches `hub_stale_ratio_percent` (and there are at least `hub_stale_min_connectors`).

## 3. Where the history lives

| `ledger.kind` | History | Examples |
|---|---|---|
| `FILE_FRAMEWORK` | `file_import` and `integration_cursor` rows under the connector's `positions`; the open differences from `file_import_reconciliation_item`; the pending mappings from `master_crosswalk` | e-GP (five positions), Treasury, national codes, procurement milestones |
| `HUB_RUNS` | `hub_run_log`, reported by command | API pulls, machine accounts, readers |
| `ADAPTER` | a registered adapter | a connector whose history is in its own table |

`hub_run_log`, `hub_incident_event`, `hub_connector_event`, `hub_health_snapshot` and `hub_lineage` are append-only (a trigger refuses update and delete, and the application role has no right to). Incidents: one open incident per connector and kind (`FAILING`, `STALE`, `HUB_STALE`), opened by the hub when the health says so, closed `AUTO_RESOLVED` when the condition clears, or reported, acknowledged and resolved by people with a reason. A **sweep** (`captureHubSnapshot`, run by a job or by the button) writes one snapshot per connector and one for the whole hub per hour (a repeat in the hour finds them) and brings the incidents in line.

## 4. Transport protocols (connection protocols)

`connector-protocols.ts`. A protocol is a **port** with a definition: its security needs (authentication types, TLS, signature), its **egress class** (`NONE`, `ALLOWLISTED_HOST`, `CUSTOMER_NETWORK`) and its failure semantics (retry, attempts, idempotency, delivery guarantee, watermark after load only). The registry is open (`registerProtocol`).

| Protocol | Directions | Egress | Auth | Implemented now |
|---|---|---|---|---|
| `FILE_DROP` | in, out | NONE | none | **end to end** (local folder; manifest with SHA-256 per file; arrival = stable size and time on N polls; CSV, XLSX, JSON, flat XML; a file is settled only after the load) |
| `WEBHOOK_INBOUND` | in | NONE | HMAC signature | **end to end** (HMAC-SHA256 of `timestamp.body`, constant-time compare, tolerance window against replay, idempotency key; duplicate answered as success and loaded once) |
| `GENERATOR` | out | NONE | none | **end to end** (deterministic producer, hash of what was handed over) |
| `HTTPS_REST` | in, out | ALLOWLISTED_HOST | API key, bearer, OAuth client, mTLS, basic | port + refusing stub + in-memory fake |
| `SOAP_XML` | in, out | CUSTOMER_NETWORK | WS-Security (modes as configuration), mTLS, basic, bearer | port + stub + fake; `soapEnvelope` builds the envelope the same way every time |
| `SFTP` | in, out | ALLOWLISTED_HOST | SSH key, basic | port + stub + fake (same drop-folder contract) |
| `DB_READ` | in | CUSTOMER_NETWORK | DB credentials, mTLS | port + stub + fake; `assertReadOnlyStatement` allows one SELECT and never a write |
| `MESSAGE_QUEUE` | in, out | CUSTOMER_NETWORK | SASL, mTLS, basic | port + stub + fake |
| `EMAIL_INBOX` | in | ALLOWLISTED_HOST | basic, OAuth | port + stub + fake |

### The no-egress rule

The platform opens no outgoing connection unless a tenant-approved egress exception exists. A descriptor whose protocol reaches another host must declare `egress: DECLARED` (hosts and reason); one with only egress-NONE protocols declares `NONE`, and the conformance test proves it twice: the source files import no `net`, `tls`, `http`, `https`, `http2`, `dns`, `dgram`, `child_process`, `cluster` or `worker_threads` module and call no `fetch`, `XMLHttpRequest`, `WebSocket`, axios, undici, node-fetch or got; and `runWithNetworkWatch` runs the adapter with every way out of Node replaced by a counting failure (it proves itself first) and must count zero. `protocolPortFor` gives a **refusing adapter** (503 `HUB_PROTOCOL_UNAVAILABLE`, reason `EGRESS_EXCEPTION_REQUIRED`, or `ADAPTER_NOT_IMPLEMENTED` once an exception exists). The decision of an exception is asked through `EgressExceptionPort` (default: none approved). The table and commands that store such an exception (decided by an administrator with a reason, logged in the audit log ADM-11, expiring) are a **follow-up (HUB-2)**; the gate itself is in place and tested.

## 5. ETL pipelines (data-collection protocols)

`etl-pipeline.ts`. The same shape for every connector:

1. **EXTRACT**: a protocol port gives a batch after a watermark (`INCREMENTAL`), the whole source (`FULL_SNAPSHOT`) or the changes the source offers (`CHANGE_FEED`), with the hash of the batch.
2. **VALIDATE**: layout version gate and the connector's schema and rule checks, per row; a bad row is a reject with a stable code.
3. **TRANSFORM**: a declarative **field mapping** with a version and an approver (`COPY`, `TRIM`, `UPPER`, `LOWER`, `CONSTANT`, `DAY`, `DECIMAL`, `UNIT` (exact decimal factor), `CROSSWALK` through `master_crosswalk`). A mapping runs only when approved by a person other than its proposer (`HUB_MAPPING_NOT_APPROVED`, `SELF_APPROVAL_DENIED`; also a CHECK in `hub_pipeline_mapping`).
4. **LOAD**: idempotent (the key of a record is the pipeline, its key and the hash of its content), a dry run first and then the apply through the connector's own command; a repeat is a DUPLICATE.
5. **REJECTS** (dead letter, `hub_pipeline_reject`): stage, code, field, the record as it arrived; reprocessed after correction (`decideHubReject`, REPROCESS needs an executor wired by the connector module, else 409 `HUB_PIPELINE_NOT_WIRED`; DISCARD needs a reason).
6. **RECONCILE**: counts of every stage, the batch hash, and whether in equals out (`balanced`).
7. **LINEAGE** (`hub_lineage`): source record to target record with the mapping and layout versions, for the lineage explorer (G3-11).
8. **SCHEDULE**: `MANUAL`, `EVERY_HOURS` or `DAILY` (Vietnam time, working days), a backfill window, a concurrency limit and a rate; `nextRunAt`, `backfillWindows`, `admitRun`, `paceMillis`.
9. **Run ledger**: every run is a `hub_run_log` row (append-only) with the stage counts, the batch hash and the watermarks.

**The watermark moves only after a successful load of a real run** (never for a dry run, never when the load failed); a failed load leaves it and the same records are read again, and the idempotency keys make the second pass harmless. Rows that are rejected do not hold the watermark back (they are in the dead-letter list); the run is `PARTIAL`. A concurrent move is refused (409 `VERSION_CONFLICT`).

Tests of the runner (`packages/kernel/test/etl-pipeline.test.ts`): clean batch, dry run, partial failure, failed load and retry, failed extract, replay, full snapshot, unapproved mapping, reject reprocess (still rejected, then resolved), and a run from a drop folder where a failed load keeps the file.

**Status of the existing imports.** The e-GP, national-code, Treasury and procurement-milestone imports run on the file import framework (`FileImportStore`, one `file_import` row per file, idempotent by hash and business key). The hub shows them (history, health, differences, mappings) through their descriptors, and each descriptor declares its pipelines, but their code is **not yet rewritten as instances of the stage runner**; that migration (the e-GP import first, as the reference implementation: `dryRunEgpFile` is its VALIDATE, the apply of `EgpImportAdapter` its LOAD) is a follow-up. FEED-1 and ENT-2 should write their imports as pipelines from the start.

## 6. Commands and reads

Reads: `listHubConnectors`, `getHubConnector` (every tab), `listHubConnectorRuns`, `listHubRejects`, `listHubIncidents`, `getHubHealthSummary`, `listHubAgents`. Commands (all audited, announced in the outbox with ids and codes only): `setHubConnectorState` (If-Match, reason; delegated to the connector's own command when it has one), `recordHubRun`, `openHubIncident`, `decideHubIncident` (acknowledge or resolve, If-Match, reason), `captureHubSnapshot`, `proposeHubMapping`, `decideHubMapping` (If-Match, another person), `decideHubReject`, `registerHubAgent`, `heartbeatHubAgent`. Permissions `hub.read`, `hub.state.manage`, `hub.run.record`, `hub.incident.manage`, `hub.snapshot.capture`, `hub.mapping.propose`, `hub.mapping.approve`, `hub.reject.manage`, `hub.agent.manage`, `hub.agent.heartbeat`; every one is held over the whole tenant (a connection belongs to no unit). Error codes: `HUB_INCIDENT_STATE_INVALID`, `HUB_MAPPING_VERSION_TAKEN`, `HUB_MAPPING_STATE_INVALID`, `HUB_MAPPING_NOT_APPROVED`, `HUB_REJECT_STATE_INVALID`, `HUB_AGENT_CODE_TAKEN`, `HUB_AGENT_RETIRED`, `HUB_PIPELINE_NOT_WIRED`, `HUB_PROTOCOL_UNAVAILABLE`, `HUB_MANIFEST_INVALID`, `WEBHOOK_SIGNATURE_INVALID`.

The alert centre raises `CONNECTOR_FAILING` and `CONNECTOR_HUB_STALE` as kinds of work (source `CONNECTOR`); the severity facets are `FAILING_*` and `HUB_STALE_*` from the policy rule. The generalisation of `HomeConnectorSources` from the e-GP connection to every hub connector is a follow-up; the kinds, their consequences and their alert types are registered.

## 7. Built-in descriptors

`egp.muasamcong` (BID-22 to BID-24), `treasury.statement` (PAY-13), `procurement.milestones` (BID-17, BID-19), `national.project_codes` (PRJ-21). Written as data in `connector-hub-builtins.ts`; the e-GP one reads the constants of `egp.ts`, so a new layout version shows without an edit. The lead adapts EGP-2 (BID-32, BID-33), FEED-1, ENT-2 and INT-1 by descriptors.

## 8. Collector agents (ARM and any operating system)

`hub_collector_agent`: agent code, `os` and `cpu_arch` (`linux/arm64`, `windows/amd64`, `darwin/arm64`, `linux/riscv64` ...), version, the connectors it serves, spool depth, last heartbeat. Health from the heartbeat against `agent_stale_after_minutes` of the policy: `ONLINE`, `STALE`, `NEVER_SEEN`, `RETIRED`. Registered by `registerHubAgent`, beats by `heartbeatHubAgent` (machine account). Shown on the connector detail. The agent itself is built by FEED-1; the hub fixes only its registration and its health. The secret of an agent is a vault reference, never a column.

## 9. Not done, left for follow-ups

- Store and commands of egress exceptions (HUB-2); the gate and the refusing adapters are done.
- The stage runner as the implementation of the e-GP, national-code, Treasury, FEED-1 and ENT-2 imports (section 5).
- `HomeConnectorSources` over every connector.
- A working calendar from ADM for the schedule (the screen uses Monday to Friday).
- Real adapters for HTTPS_REST, SOAP_XML, SFTP, DB_READ, MESSAGE_QUEUE and EMAIL_INBOX.
- Notification channels and the e-signature as descriptors (the circuit state of channels would be an `ADAPTER` ledger).
