# The feed of the Finance Department (lane FEED-1)

Connector `fin.sotaichinh`: the data of the application of the Finance Department (Sở Tài chính) comes into the system so that the committee led by the head of Ban 57 can steer public investment across the province. Plan: `docs/plans/feed1.md`. This page records the web side (screens FEED-01 to FEED-05) and the decisions that shape it.

## Channels and the layout

Records come by three channels, judged and stored alike: `FILE` (a person hands over a CSV or XLSX), `API_PUSH` (a port with a stub that answers `503 FEED_API_UNAVAILABLE` until the machine account of the integration lane exists) and `GENERATOR` (the data generator, "bộ sinh dữ liệu", a deterministic producer of realistic records that goes through the same layouts, dry run and apply as a file). The channel is a provenance column (with the run id and, for the generator, the epoch and the seed); no screen stamps, hides or separates records by channel, and no screen speaks of simulation (owner decision of 2026-11-08).

The file layout `WORKING-ASSUMPTION-FIN-2026.1` is an assumption until the Finance Department publishes its own: every screen that reads files carries the badge "Mẫu tệp là giả định (PENDING-EXTERNAL)" while the server says `acceptance = PENDING_EXTERNAL`, and the pending items (samples, push specification, machine account, thresholds) are listed on FEED-01.

## Screens (apps/web/src/screens/feed)

| Screen | What it does | Commands |
|---|---|---|
| FEED-01 `ConnectionScreen` | state of the connection, the three channels with the status of each adapter, freshness by the rule (age against the lines, the "i" with formula, source, as-of and legal status), the three quality indicators of the month (completeness, timeliness, discrepancy rate, each with numerator, denominator, as-of and "i"), late units, open alerts, findings, counts, last runs, positions, layouts, pending items, history | `setFinanceFeedConnectionState` (reason of 10 characters, `If-Match` version) |
| FEED-02 `RunsScreen` | upload a file, dry run row by row (nothing written), apply once per file (the same file again says it was applied), list of runs of every channel, filters, detail of a run with its refused rows | `uploadFinanceFeedFile`, `previewFinanceFeedFile`, `importFinanceFeedFile` |
| FEED-03 `MappingScreen` | unmapped feed project codes, mapping list with counts by state, propose by hand, approve or reject by a person other than the proposer, retire with a reason | `proposeFinanceFeedMapping`, `decideFinanceFeedMapping`, `retireFinanceFeedMapping` |
| FEED-04 `DifferencesScreen` | run the comparison for a fiscal year with an owner, worklist of differences (feed value, our value, delta, delta percent, owner, due), settle with `ACCEPT_FEED`, `KEEP_OURS`, `DISPUTE` (needs `evidence_ref`) or `WAIVE` (needs `review_on` inside one year) | `runFinanceFeedReconciliation`, `resolveFinanceFeedDifference` |
| FEED-05 `GeneratorScreen` | state, epoch, seed, fiscal year, month reached, parameters, start, stop, reseed, tick with a reason, history of moves and the runs produced | `controlFinanceFeedGenerator` |

Rules every screen follows: the rights of the person come from `actions` of the connection read (the server judges again); a read-only workspace locks every command; every list has the states loading, empty, partial (a cut list says how many there are in all), error (with a new try), stale (the last answer stays, with the moment it is as of), forbidden (403) and success; every number carries an "i" with formula, source and as-of; every command sends one idempotency key per intention and the versioned ones send the version the person saw (409 `VERSION_CONFLICT` offers the reload); a maker never approves (`can_decide`, `can_resolve` come from the server and the refusal `SELF_APPROVAL_DENIED` is said in place).

## Strings

`apps/web/src/i18n/parts/feed.{vi,en}.json`, keys `feed.<screen>.<area>.<thing>`, folded with `node scripts/fold-i18n-parts.mjs`.
