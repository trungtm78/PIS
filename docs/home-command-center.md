# Command center and overview (ST-HOME-001)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/HOME.md` (F1, BR-HOME-01). One operation, `getCommandCenter` (`GET /home/command-center`, `home.read`), no table and no migration: HOME owns no data and reads the frozen snapshots of DIS and the registers of DIS, PRJ and CAP in the scope of the reader. The two screens are HOME-09 (the command center) and HOME-01 (the executive overview). The formulas are proposals until the business owner signs them (**CXN-03**, D03): every tile says so.

## The answer

Query: `snapshot_id` (a frozen snapshot, the latest frozen `PERIOD_CLOSE` when none is given), `unit_id` (the units under it), `denominator_kind` (`PM_ASSIGNED` or `TOTAL`, echoed in the scope). The figures are the sums of the snapshot lines of the projects the reader may read; **the two rates are made by the same code as DIS-19** (`rateOfSums` over `DisSnapshotStore.rateSums`), so the dashboard and the center cannot disagree.

- `tiles`: `DISBURSEMENT_RATE_PM`, `DISBURSEMENT_RATE_TOTAL` (the same numerator over the plan of the Prime Minister and over the whole plan), `DISBURSED_TREASURY`, `PLAN_PM_ASSIGNED`, `PLAN_TOTAL`. Each has `value`, `numerator`, `denominator`, `null_reason`, `unit` (`PERCENT` or `VND`), `formula`, `definition_status` and a signed `context_token`.
- `snapshot_id`, `as_of_date`, `treasury_cutoff_date`, `definition_status`, `freshness` (`FRESH`, or `STALE` when the snapshot is more than 8 days older than today in Vietnam), `legal_confirmation_refs` (`CXN-03`), `scope` (`unit_id`, `denominator_kind`, `projects`, `scope_hash`).
- `open_warnings` (open, acknowledged or explanation requested), `overdue_explanations` (marked overdue, or requested or sent back with the day past), `pending_reallocations` (submitted proposals), `projects_without_data` (projects of the scope whose lines all have Treasury coverage `NONE`), `quality_badge` (`NOT_ASSESSED` until DGV feeds it, ST-HOME-007).

A figure that cannot be given is **null with its reason, never 0**: the Treasury that booked nothing gives no disbursed amount (`NO_DATA`) and no rate; a plan of nothing gives no rate (`ZERO_DENOMINATOR`). The plans stay figures of their own. Every null tile is counted in `home_null_tile_total{reason}`.

Refusals: 404 `RESOURCE_NOT_FOUND` when nothing is frozen (the screen shows the empty state with the way to DIS-21), 422 `SNAPSHOT_NOT_FROZEN` for a snapshot that is still being built, 403 `SCOPE_DENIED` for a unit the reader may not read (a unit that does not exist answers the same, so nothing is disclosed), 422 `METRIC_UNAVAILABLE` when the snapshot has no day (BR-HOME-01: no scope, day, snapshot, unit or formula, no figure), 422 `VALIDATION_FAILED` for a malformed query.

## The context token

Each tile carries `base64url(payload).base64url(hmac-sha256)` of `{tenantId, snapshotId, scopeHash, metricCode, unitId, exp}`, good for 30 minutes (`signHomeContext` of the kernel). The scope hash is the hash of the member, the version of their grants and the unit they narrowed to, so a token cannot be used by another scope. The HMAC covers a purpose prefix (`home-context:`), because the key is the one that signs the contexts of background work (`ORCHESTRATION_OPTIONS.contextKey`; a key of the process when none is configured): a token of one kind never passes for the other. `verifyHomeContext` answers 400 `INVALID_REQUEST` for a token that was altered, signed with another key or is not one (and says nothing of why), and 409 `SNAPSHOT_EXPIRED` for one that is good but old; HOME-10 (ST-HOME-002) takes the token back and judges the scope again at every step.

## What stays put

The figures belong to the snapshot: a project that changes, a report that is corrected and not accepted, a snapshot that is still being built do not move them. They change when a newer snapshot is **frozen** (UAT-AC06). On the screen the figures are never refreshed by themselves (no refetch on focus, on reconnection or by age); the screen asks in the background, once a minute, which snapshot is the latest, and when it is another than the one shown a banner offers it and the leader takes it with a click.

## Screens

- **HOME-09** (`CommandCenterScreen`): the context of the figures first (scope, day, snapshot id with the whole id in its title, Treasury cutoff, quality badge, the stale notice); the two rates side by side with the words DIS-19 uses and the numerator and denominator under each; the amounts with their unit of measure and formula; each tile's definition status (`CXN-03` while it is a proposal) and its way to the source (`/home/home-10?token=`); the counts of what waits, each leading to its screen (HOME-03, HOME-02, CAP-19); the footer "N projects have no data yet".
- **HOME-01** (`OverviewScreen`): the same body, with the filters: the unit (from the units the reader may read; left out when the list cannot be read), the year and the day the figures are as of (both of the snapshot, read-only).
- Seven states for both: loading, empty (nothing frozen, with the link to DIS-21), error, offline, denied, signed out, and a page of its own for a snapshot not frozen, a unit not the reader's and a figure that cannot be given. An answer that lacks the snapshot, the day, the scope or the definition is not shown (a tile without formula, unit or token is left out).

## Assumptions and limits

- The fund and the fiscal-year filters of HOME-01 wait for a read model that carries them: `getCommandCenter` has no such parameter, so the year is the year of the snapshot and there is no fund filter.
- `denominator_kind` is accepted and echoed; both rates are always given (a rate is never shown alone).
- The poll for a newer snapshot asks `getCommandCenter` without a snapshot; a push event (`snapshot.frozen.v1`, ST-HOME-007) will replace it.
- The cache of the story (`t:{tenant}:home:cc:{snapshot}:{scope_hash}`, TTL 10 minutes) is not built: the reads are cheap sums, and a cache is a decision for the load test (D09, p95 2 s at 5000 projects).
- The drill destination (HOME-10) is ST-HOME-002.
