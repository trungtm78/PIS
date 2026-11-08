# The feed of the Finance Department (lane FEED-1)

Connector `fin.sotaichinh`. Plan and steps: `docs/plans/feed1.md`. Spec of the module: `Design/MACHVON_Design/01_Documents/05_modules/FEED.md`. Screens FEED-01 to FEED-05. Migration block FEED-1, `db/migrations/V2500` to `V2503`.

## 1. Purpose and decisions

The data of the application of the Finance Department (Sở Tài chính) comes into this system so that the committee led by the head of Ban 57 (PA05, Công an tỉnh) can steer public investment across the whole province: projects, the annual plan by fund, monthly disbursement with cumulative figures, contract and procurement milestones, by sector, district and investor. Everything is built to the pattern of the e-GP connector (`docs/egp-connector.md`): a port, adapters, a connection in the connection ledger, a record store, a mapping on `master_crosswalk` approved by a second person, a comparison with our own figures with an owner and a resolution for each difference, data-quality indicators in the KPI register, alert types, screens.

Decisions (owner standing rule, recorded here):

1. "ARM" was first read as a simulation mode; the owner then said it means ARM, cross-platform hardware and operating systems. The core below is real: no figure is stamped, separated or guarded as simulated. The edge collector agent (section 11) is what runs the collection on linux/arm64, linux/amd64, windows x64/arm64 and macOS arm64.
2. Records of every channel flow into the same store and are read alike. The channel (`FILE`, `API_PUSH`, `GENERATOR`) is kept only as internal provenance for audit and replay, with the run id and, for the generator, an epoch.
3. The FILE layout is a working assumption (`WORKING-ASSUMPTION-FIN-2026.1`), PENDING-EXTERNAL (eng-review R18) until the Finance Department publishes its own: UAT may run it, its verdict excludes it, and every screen that reads files says so. This label is about the unknown layout and has nothing to do with the generator.
4. Everything the Integration Hub needs about the connector is one plain constant, `FINANCE_FEED_CONNECTION` in `packages/kernel/src/finance-feed-connection.ts` (code, transport modes, layouts and versions with their PENDING-EXTERNAL status, freshness and policy rules, alert types, indicators, owner role, egress policy NONE, consumers).

## 2. The port and its three adapters (`packages/kernel/src/finance-feed.ts`)

```
FinanceFeedPort.read(request) -> FeedBatch { channel, adapterStatus, layoutVersion, acceptance, records, rejected, counts, digest }
```

| Adapter | Channel | Status | Does | Never does |
|---|---|---|---|---|
| `FeedFileAdapter` | FILE | PROPOSED | Reads a CSV or XLSX of one of the four kinds into a dry run; the apply goes through the file import framework (`docs/file-import.md`): once per `(tenant, SHA-256)`, valid rows kept, refused rows to the quarantine | Open a connection: no constructor argument, no client |
| `FeedApiPushAdapter` | API_PUSH | MISSING | Refuses every call with 503 `FEED_API_UNAVAILABLE` (`reason = MACHINE_ACCOUNT_PENDING`) until the machine-account facility of lane INT-1 and the specification exist | Anything else. `feedBatchOfRows(kind, rows)` already judges pushed rows with the very layouts a file uses; the day the machine account exists the endpoint authenticates the Finance application and calls it |
| `FeedGeneratorAdapter` | GENERATOR | MOCK | Produces the records of a whole province deterministically from its parameters (section 6) | Read or write anything. Its records are judged by `validateFeedRecords`, which reads each one back through the layout of its kind |

`financeFeedPortFor(channel)` gives the adapter. The command `pushFinanceFeedBatch` (`POST /finance-feed/push`, permission `fin.feed.push`) calls the port of API_PUSH and therefore answers 503 today.

**No connection leaves the machine.** `packages/kernel/test/finance-feed.test.ts` (group "no connection leaves the machine") replaces `fetch`, `net`, `tls`, `http`, `https`, `dns` and `dgram` with functions that fail and count, proves the replacement works, runs the three adapters, the layouts, the generator, the reader and the rules, asserts zero attempts, and reads the sources of the six kernel files for any import of a module that can open a connection.

## 3. The layouts of `WORKING-ASSUMPTION-FIN-2026.1`

Common to the four (as in `docs/egp-connector.md` section 4): a CSV (UTF-8, comma, semicolon or tab) or the first sheet of an XLSX; a header row; at most 5,000 rows; header names read without regard to case, spaces and hyphens; an unknown column is ignored; a column named twice is refused; `YYYY-MM-DD` or `DD/MM/YYYY` days; amounts in VND as plain digits with at most two decimals (no thousands separator); words read without regard to case. A file without a required column is 422 `IMPORT_SCHEMA_INVALID` with `missing_columns`; a file with no row is 422 `IMPORT_EMPTY`; a layout version the module does not read is 422 `FEED_LAYOUT_VERSION_UNKNOWN` naming the supported ones. A row whose business key repeats an earlier one: the same content once normalised is `DUPLICATE`, other content is `CONFLICT` (the first stands).

Every row carries `as_of`, the day the statement was true. The business key is the key of the thing plus `as_of`, so a later statement of the same thing is a new row and the earlier stays (restatements are history, not overwrites). `R` marks a column every row must fill.

| Kind (position) | Columns | Business key |
|---|---|---|
| `PROJECT` (`FIN_PROJECT_FILE`) | `feed_project_code` R, `as_of` R, `project_name` R, `sector_code` R, `district_code` R, `investor_code` R, `investor_name`, `total_investment`, `start_year`, `end_year` (not before the start), `project_status` (`ACTIVE` default, `SUSPENDED`, `COMPLETED`, `CANCELLED`), `our_project_code` (an exact mapping hint) | `feed_project_code|as_of` |
| `PLAN` (`FIN_PLAN_FILE`) | `feed_project_code` R, `fiscal_year` R, `fund_code` R (`NSTW`, `NSDP`, `ODA`, `TPCP`, `CTMTQG`, `OTHER`), `plan_amount` R, `as_of` R, `decision_no` | `code|year|fund|as_of` |
| `DISBURSEMENT` (`FIN_DISBURSEMENT_FILE`) | `feed_project_code` R, `fiscal_year` R, `month` R (1 to 12), `fund_code` R, `disbursed_month` R, `disbursed_cumulative` R (not below the month), `reported_on` R (the day the unit reported, not after `as_of`), `as_of` R | `code|year|month|fund|as_of` |
| `MILESTONE` (`FIN_MILESTONE_FILE`) | `feed_project_code` R, `milestone_kind` R (`PACKAGE_PUBLISHED`, `PACKAGE_AWARDED`, `CONTRACT_SIGNED`, `SITE_HANDOVER`, `ACCEPTANCE`, `SETTLEMENT`), `package_code`, `planned_on`, `actual_on` (one of the two required), `contract_value`, `as_of` R | `code|kind|package|as_of` |

Row codes of a dry run: `FIELD_REQUIRED`, `FIELD_TOO_LONG`, `CHARACTER_INVALID`, `ENUM_INVALID`, `DAY_INVALID`, `MONEY_INVALID`, `YEAR_INVALID`, `MONTH_INVALID`, `YEARS_ORDER_INVALID`, `CUMULATIVE_BELOW_MONTH`, `REPORTED_AFTER_AS_OF`, `MILESTONE_DATE_REQUIRED`, `ROW_DUPLICATE`, `ROW_CONFLICT`. The dry run (`previewFinanceFeedFile`) writes nothing and says what the apply would do with each valid row: `RECORD`, `RECORD_AND_PROPOSE` (a project row that names our code proposes the mapping) or `RECORD_AND_DIFFERENCE` (it names a code we do not have).

## 4. The connection `fin.sotaichinh`

`finance_feed_connection` (one row per tenant: `enabled`, reason, layout version, generator state, generator epoch, generator parameters, version) with `finance_feed_connection_event` (append-only history). The row, the entry of the connector registry (`integration_connector`: mode `FILE_IMPORT`, adapter `PROPOSED`, status `Draft`: only a VERIFIED adapter may be Active) and the four positions of the file import are created at the first command of the tenant; a read never writes. Switching needs a reason of 10 characters and the version (`If-Match`); records are taken only while the connection is on (409 `FEED_CONNECTION_DISABLED`), a dry run always works.

**Health** is the age of the last applied run (any channel) against the rule `CONNECTOR_FRESHNESS`, code `FIN_FEED` (default `warn_after_hours` 24, `max_age_hours` 48, `stale_severity` ACTION; our own operational choice, legal status UNVERIFIED): FRESH, AGING, STALE, NEVER_RECEIVED. A stale or never-used feed is shown as it is, never as "no data".

## 5. Records, runs, mapping

- `finance_feed_run`: one row per applied run of any channel (a file, a push, a generator start, reseed or tick), append-only, with counts, the digest of the records and who ran it. A file is applied once per `(tenant, kind, SHA-256)` (unique index).
- `finance_feed_record`: one row per `(tenant, channel, epoch, kind, business key)`, append-only (trigger, no UPDATE or DELETE for any role). `channel`, `run_id` or `import_id`, and `epoch` (0 except for the generator) are provenance.
- **Mapping** of a feed project code to one of our projects on `master_crosswalk` (source system `FIN_SOTAICHINH`, external type `FIN_PROJECT`, subject `PROJECT`; no new table of identities). A mapping is PROPOSED by one person (for a file, the person who loaded it; a project record that names our code proposes it) and becomes ACTIVE only when another person approves it (`approved_by <> created_by` is a CHECK of the table); REJECTED and RETIRED are final; one feed code stands for one project at a time and one project holds one feed code at a time (409 `CROSSWALK_DUPLICATE`). A mapping to a code the feed has never sent is refused (422 `external_code`).

## 6. The data generator ("bộ sinh dữ liệu")

`packages/kernel/src/finance-feed-generator.ts`. Deterministic: the same parameters give the same records byte for byte (a test pins the digest); every random choice comes from a generator seeded by the seed and the thing it is about, so the figures of a month never depend on how far the data runs and a tick repeats every earlier record and adds only what is new (a test pins it).

| Parameter | Default | Meaning |
|---|---|---|
| `seed` | 57 | The seed |
| `fiscal_year`, `current_month` | the previous month of today | The data runs to the end of this month |
| `project_count` | 120 (10 to 1000) | Projects of the province by sector (8 sectors), district (12) and investor (10 units of the province and a project board for each district) |
| `late_units` | 3 (0 to 20) | Investors that are silent (no row until a later catch-up) or tardy (after the due day) in each month |
| `delayed_pct`, `ahead_pct` | 22, 12 | Share of projects behind the seasonal curve (30 to 70 percent of it) and ahead of it (120 to 155 percent) |
| `discrepancies` | 6 | Disagreements planted inside the data: a cumulative off, over the plan, a month stated again |
| `anchor_count` | 0 (up to 50) | Anchor the first projects on projects of ours that have a frozen DIS snapshot: our code, our plan and our figure (one in four off by 6 percent) so the exact mapping and the comparison have something to find |

The seasonal curve of public investment (shares of the year by month: 2, 3, 6, 6.5, 7, 8, 8, 8, 9, 11, 13, 18.5 percent) is `FEED_SEASONAL_WEIGHTS`. A project has 1 to 3 funds, a plan decision, four milestones (a delayed project is late on them) and, when it ends this year, an acceptance.

Control (`controlFinanceFeedGenerator`, permission `fin.feed.generator`, reason of 10 characters, `If-Match`): START (connection on, generator stopped; new epoch), STOP, RESEED (new seed, new epoch: the records of the epoch before are no longer read), TICK (one more month; refused after December). Every move is an audited event with its reason; the records go through `validateFeedRecords`, `writeRun` and, for anchored projects, the proposal of the exact mapping. Invalid moves are 409 `FEED_GENERATOR_STATE_INVALID`.

## 7. Comparison with our own figures and the difference worklist

For a fiscal year (`runFinanceFeedReconciliation`) every ACTIVE-mapped project is compared on three figures: the feed's plan against the plan of the latest frozen DIS snapshot of the year (`PLAN_VS_DIS`), the feed's cumulative disbursement against the DIS report (`DISBURSED_VS_DIS`) and against the Treasury statements of the year, payments less refunds (`DISBURSED_VS_TREASURY`). A figure we do not hold is not compared (it is not a difference: we cannot say who is right), except a plan we lack while the feed has one (`MISSING_OURS`). A difference exists when it is above `tolerance_pct` of ours (default 0.5) and is LARGE above `large_discrepancy_pct` (default 5); `diffFeedFigures` is exact (hundredths of a dong, no floats).

Each difference is an item (`finance_feed_difference`) with an OWNER (accountable for settling it; `owner_id` of the command, the caller by default) and the MAKERS (who loaded the feed's records of the project and who froze our snapshot). The owner is never a maker (a project whose makers include the owner is not opened and is named in the answer, so the command is repeated with another owner), and the person who resolves is never a maker (403 `SELF_APPROVAL_DENIED`, ADM-11; the database holds both as CHECKs). One OPEN item exists per project, year and figure. Resolutions: `ACCEPT_FEED` (10 characters), `KEEP_OURS` (10), `DISPUTE` (20, with `evidence_ref`), `WAIVE` (20, with `review_on` after today and within 365 days); once only, 409 `FEED_DIFFERENCE_STATE_INVALID`; the resolution never edits another module's data. Each run is recorded (`finance_feed_reconciliation`: what it covered), which gives the discrepancy rate its denominator.

## 8. Data-quality indicators and alerts

Registered by `registerFinanceFeedRules` (`governance-rules.ts`), all UNVERIFIED defaults a tenant replaces by approving its own rule version:

| Code | Kind | Formula | Source and as-of |
|---|---|---|---|
| `FEED_COMPLETENESS` | KPI | units that reported the month / units with an active project that has a plan of the year, x 100 | `finance_feed_record`, the day of the reading |
| `FEED_TIMELINESS` | KPI | units that reported by the due day (end of the month + `report_due_days`, default 5) / units that reported, x 100 | same |
| `FEED_DISCREPANCY_RATE` | KPI | differences of the year / figures compared in the latest run, x 100 | `finance_feed_difference`, `finance_feed_reconciliation` |
| `FINANCE_FEED_POLICY` | rule | `tolerance_pct`, `large_discrepancy_pct`, `report_due_days`, `difference_due_days` | `DEFAULT` |
| `FEED_STALE` | ALERT_TYPE | owner integration administrator; expected action: check the connection, receive the latest data, record the cause; consequence: province figures older than allowed must say so; severity per the freshness rule | alert centre source `CONNECTOR` |
| `FEED_UNIT_LATE` | ALERT_TYPE | owner integration administrator; expected action: chase the unit and note the date it will report; consequence: the unit's figures are missing so the province rate is falsely low | one alert per late unit and month, WATCH |
| `FEED_DISCREPANCY_LARGE` | ALERT_TYPE | owner capital planner; expected action: the owner settles the difference with a reason; consequence: two sources contradict, a report to the leaders may be wrong | one alert per open large difference, ACTION |

The alerts are computed when the alert centre is read (`HomeConnectorSources`), so no job is needed. A connection never used, or switched off with a reason, raises none. `feedInternalFindings` also lists the disagreements inside the feed itself (`CUMULATIVE_MISMATCH`, `OVER_PLAN`, `RESTATED`, `UNKNOWN_PROJECT`); their count is on FEED-01.

## 9. The reader of the province facts (for lane BAN-1 and any consumer)

The one thing a consumer reads. It knows nothing of the adapters: `ProvinceFactsReader` (`packages/db/src/finance-feed-reader.ts`) takes the records, folds them (the latest statement of a thing by `as_of` wins, earlier ones stay in the store; statements after `as_of` are ignored), takes the current epoch of the generator and every record of the other channels, and sums in exact hundredths of a dong. Pure kernel counterparts: `foldFeedFacts`, `aggregateFeedFacts`, `feedQuality`.

HTTP (permission `fin.feed.read` over the whole tenant):

- `GET /finance-feed/facts?fiscal_year=&group_by=sector|district|investor|fund|month|project[&as_of=&sector=&district=&investor=&fund=]` returns `totals` and `groups`, each with `key`, `label`, `projects`, `plan`, `disbursed`, `cumulative`, `rate_pct` (two decimals), `channels` and `as_of_statement`; plus `freshness` (status, age, last run) and `acceptance`. For `month`, `disbursed` is the month and `cumulative` the running sum.
- `GET /finance-feed/projects?fiscal_year=&...` returns per project the plan and cumulative disbursement by fund, the twelve monthly figures, the latest month and the channel.
- `GET /finance-feed/quality?fiscal_year=&month=` returns the three indicators with numerator, denominator and as-of, every unit with its report status (`REPORTED_ON_TIME`, `REPORTED_LATE`, `LATE`, `PENDING`) and the findings.

Amounts are decimal strings of VND. A consumer shows `freshness` and `acceptance` beside the figures; a figure never hides that the data is old or that the layout is PENDING-EXTERNAL.

## 10. API, permissions, audit

Operations (`Design/MACHVON_Design/03_Engineering/openapi.json`, tag FEED): reads `getFinanceFeedConnection`, `listFinanceFeedRuns`, `getFinanceFeedRun`, `listFinanceFeedMappings`, `listFinanceFeedUnmapped`, `listFinanceFeedDifferences`, `getFinanceFeedQuality`, `getFinanceFeedFacts`, `listFinanceFeedProjects` (`fin.feed.read`); commands `setFinanceFeedConnectionState` (`fin.feed.admin`), `controlFinanceFeedGenerator` (`fin.feed.generator`), `uploadFinanceFeedFile` and `previewFinanceFeedFile` (`fin.feed.preview`), `importFinanceFeedFile` (`fin.feed.import`, whole tenant), `pushFinanceFeedBatch` (`fin.feed.push`), `proposeFinanceFeedMapping` and `retireFinanceFeedMapping` (`fin.feed.map`), `decideFinanceFeedMapping` (`fin.feed.map.approve`), `runFinanceFeedReconciliation` (`fin.feed.reconcile`), `resolveFinanceFeedDifference` (`fin.feed.resolve`). Every command writes an ADM-11 audit row and an outbox event with ids and codes only (`fin.feed.connection.changed.v1`, `fin.feed.generator.moved.v1`, `fin.feed.import.applied.v1`, `fin.feed.mapping.proposed|decided|retired.v1`, `fin.feed.reconciliation.completed.v1`, `fin.feed.difference.resolved.v1`); idempotency by the shared interceptor (`Idempotency-Key`).

New error codes: 503 `FEED_API_UNAVAILABLE`, 409 `FEED_CONNECTION_DISABLED`, `FEED_GENERATOR_STATE_INVALID`, `FEED_MAPPING_STATE_INVALID`, `FEED_DIFFERENCE_STATE_INVALID`, 422 `FEED_LAYOUT_VERSION_UNKNOWN`.

## 11. How the real feed replaces the generator, and the edge collector

Nothing a consumer touches changes. The reader reads `finance_feed_record`; the generator is one producer of it, like a file. To move to the real feed: (1) when the Finance Department publishes its layout, add it as a new layout version in `finance-feed.ts` (the working assumption stays readable) and ask the department to confirm it; the acceptance word clears only then; (2) when lane INT-1 gives the machine account, `FeedApiPushAdapter` is replaced by the endpoint that authenticates it and calls `feedBatchOfRows`; (3) stop the generator (`STOP`; its records of the last epoch stay in the store as history and are read until a reseed or the real data covers the same projects under other codes); (4) map the real codes (FEED-03).

Section 12 (the edge collector agent) is added when the collector is built.

## 12. Pieces

| Piece | File |
|---|---|
| Model, layouts, dry run, port, three adapters | `packages/kernel/src/finance-feed-model.ts`, `finance-feed.ts` |
| Generator | `packages/kernel/src/finance-feed-generator.ts` |
| Reader (fold, aggregate, findings, quality) | `packages/kernel/src/finance-feed-facts.ts` |
| Management rules (connection, generator moves, health, policy, mapping, comparison, resolution, alerts) | `packages/kernel/src/finance-feed-management.ts` |
| Hub description | `packages/kernel/src/finance-feed-connection.ts` |
| Words (sectors, districts, investors, alert and indicator texts) | `packages/kernel/src/messages/finance-feed-texts.ts` |
| Rules, indicators, alert types | `registerFinanceFeedRules` in `packages/kernel/src/governance-rules.ts` |
| Tests (kernel) | `packages/kernel/test/finance-feed.test.ts` |
| Migrations | `db/migrations/V2500` to `V2503` |
| Stores, file adapter, reader, alert source | `packages/db/src/finance-feed-*.ts`, `home-connector-sources.ts`; tests `packages/db/test/finance-feed-store.test.ts` |
| Controllers and views | `apps/api/src/modules/finance-feed/` |
| Screens | `apps/web/src/screens/feed/`, strings `apps/web/src/i18n/parts/feed.{vi,en}.json` |
