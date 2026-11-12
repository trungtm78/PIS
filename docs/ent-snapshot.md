# ENT-3a: the enterprise period snapshot (what is built)

Status: implemented (lane ENT-3a, migration V2660; the lock rule of section 8 is INT-2). Requirements DL.03 (the figures a period closes with) and BC.01 (one source for the reports), eng-review decisions R17 (immutable after close, revision with lineage), R21 (one reader) and R23. The model it stands on is `docs/fnd-funding-model.md` (sections 5, 6.5 and 13); the plan is `docs/plans/ent3a.md`. This document describes the code as it is; where something is a working assumption it says so.

## 1. What it is

When an enterprise reporting period (a month, a quarter or a year of the calendar `ENTERPRISE`) is closed, the platform freezes the figures of the period into one **snapshot** of kind `ENTERPRISE_CLOSE` in `machvon.period_snapshot`, hashed with SHA-256 (hash schema 2). Forms, the leadership dashboard (HOME-07, `getLeaderRates`) and anything that later needs "the official figure of the period" read that snapshot, and only through one reader (`EnterpriseFigureReader`), so one number never has two sources.

- Kind `ENTERPRISE_CLOSE` is never read by a reader of the public edition (they all look for `PERIOD_CLOSE`), so a public figure can never be replaced by an enterprise one. The check constraints `period_snapshot_enterprise_chk` (pack `ENTERPRISE`, hash schema 2) and `period_snapshot_enterprise_sod_chk` (the person who froze it is not the person who built it) are in V2660.
- The snapshot belongs to the pack `ENTERPRISE` (classes `EQUITY`, `LOAN`, `OTHER`; one tier `ALL`; measures `EXECUTED` and `DISBURSED`; see `enterprisePackParams` in `packages/kernel/src/fnd-taxonomy.ts`). It records which rule version of the pack it was built with (`taxonomy_rule_id`, `taxonomy_version`); `definition_status` is `PROPOSED_PENDING_SIGNOFF` while the pack is the unverified built-in default (every number of it is a working assumption of the customer spec until the indicator dictionary arrives), else `SIGNED`.

## 2. What is frozen

| Table | Content |
|---|---|
| `machvon.period_snapshot` | the header: period, kind, `as_of_at`/`as_of_date` (also the treasury cutoff), `status`, `row_count`, `payload_sha256`, `taxonomy_*`, `hash_schema`, `revision`, `supersedes_id`, `created_by`, `frozen_by`, `frozen_at`, `version` |
| `machvon.period_snapshot_figure` | the long-format figures (FND-1): one row per project, unit, class, tier, measure, figure kind, grain, plan year, ordinal; `amount_vnd` whole dong or null with a reason (`NO_DATA`, `ZERO_DENOMINATOR`, `ESTIMATE_GAP`); `basis`; `source_figure_id` back to the accepted `plan_figure_revision` it came from |
| `machvon.period_snapshot_indicator` | the figures of the indicator dictionary (`ind_figure`, a percent, a count, days...) in force at the freeze: value, unit, definition version, revision, `source_figure_id` (V2660) |

The figure kinds are those of the figure engine (`figureRowsOf`: `PLAN_YEAR`, `PLAN_ADJUSTED`, `PLAN_IN_FORCE`, `PLAN_MONTH` or `PLAN_QUARTER`, `ESTIMATE`, `ESTIMATE_AS_REPORTED`, `ACTUAL`, `CUMULATIVE_YTD`, `CUMULATIVE_SINCE_START`, `ESTIMATE_YEAR`) plus two the builder adds: `PLAN_TO_DATE` of each cell (the denominator of the phased rate) and `TMDT_IN_FORCE` of each project (class `TOTAL`, tier `ALL`: the total investment in force, the denominator of the since-start rate; it is never part of a class sum). A cell with no figure at all is left out; the reader reads an absent row as an absent figure.

All three tables are written once while the snapshot is `BUILDING` and never changed (the guard triggers `period_snapshot_figure_guard`, `period_snapshot_indicator_guard`; update, delete and truncate are revoked from the application role); they are tenant tables with row-level security forced.

## 3. The life of a snapshot

```
(period LOCKED) --build--> BUILDING --freeze (another person)--> FROZEN --reopen approved + build + freeze--> SUPERSEDED (the new one is FROZEN, revision + 1)
                              |
                              +-- built again before freezing --> FAILED (the discarded build)
```

Implemented by `EnterpriseSnapshotStore` (`packages/db/src/enterprise-snapshot-store.ts`).

1. **Readiness** (`readiness`, `GET /enterprise-snapshot-readiness?period_id=`): without writing anything, says whether the period is complete, which units have not submitted, which batches of actuals wait for their checker (`SUBMITTED`), and whether a frozen snapshot exists and an approved reopening allows a new revision.
2. **Build** (`build`, `POST /enterprise-snapshots`, permission `funding.snapshot.build`, over the whole tenant: an enterprise snapshot holds every project, so a person who sees only some is refused `403 SCOPE_DENIED`):
   - the period must be `LOCKED` (409 `PERIOD_STATE_INVALID`) and of the enterprise calendar with the dates of a month, a quarter or a year (422 `period_id`);
   - one build of a period at a time (advisory lock; 409 `SNAPSHOT_BUILD_IN_PROGRESS`);
   - a frozen snapshot of the period blocks a new build unless a period reopening was approved after its freeze (409 `SNAPSHOT_FROZEN`, `reopen_required`); the reopening has a reason and a different approver (`period_reopen`);
   - **completeness**: the input points are the owner units of the projects that have an `ENTERPRISE` plan for the plan year (the owner unit the project had at the end of the period, so a later transfer does not move the figures). The period is complete when every planned (project, class, tier, measure) cell has an accepted actual for every month of the period. A build on an incomplete period (or with no planned cell) is refused with 422 `ENTERPRISE_SNAPSHOT_INCOMPLETE`, listing the units in the order of their codes, their projects, the cells and the months missing, and the waiting batches (`completenessOf`, pure, in `packages/kernel/src/enterprise-snapshot.ts`). An absent actual is a gap, never zero: a project that really spent nothing says so with an accepted zero;
   - up to 5000 projects of the pack with figures in the year are read; the previous `BUILDING` snapshot of the period is marked `FAILED` and replaced.
3. **Review** while `BUILDING`: the snapshot is readable (DIS-33) so the checker can look before freezing.
4. **Freeze** (`freeze`, `POST /enterprise-snapshots/{id}/freeze`, permission `funding.snapshot.freeze`, over the whole tenant, versioned command): the person who froze is not the person who built (403 `SELF_APPROVAL_DENIED`); the period is still `LOCKED` and was not reopened since the build (409 `PERIOD_STATE_INVALID`); the row counts agree (409 `SNAPSHOT_NOT_BUILT`); the hash is computed from the rows it holds (`enterpriseSnapshotHash`: header, pack and version, every figure and every indicator in an order that does not depend on how they were read); the earlier `FROZEN` snapshot of the period becomes `SUPERSEDED`, keeping its hash, and the new one names it in `supersedes_id`.
5. **Verify** (`verify`): recomputes the hash of a frozen snapshot from the rows and compares it with the one kept; `getEnterpriseSnapshot` returns `hash_verified`.

The revision number is unique per tenant, period and kind (`period_snapshot_enterprise_revision_uq`), so the lineage is a chain. The official figure of a period is its latest `FROZEN` revision (`frozenOf`, `frozenForDates`).

## 4. The one reader

`EnterpriseFigureReader` (kernel, pure) takes the frozen rows (`EnterpriseSnapshotView` from `EnterpriseSnapshotStore.view`) and rebuilds the cells of the figure engine, so its ratios and money figures are exactly those of `indicatorsOf` and `moneyIndicatorsOf` over the same books. It answers, for a scope (the tenant, a unit, named projects): the cells (`figures`), every ratio of the pack with its numerator and denominator (`rates`, sum over sum, never an average of rates), the additive money figures in total or of one class (`money`, `amountOf`), the total investment and the since-start rate, the indicator figures and their sums, and the months and dates of the period. An absent figure is null with a reason, never 0.

## 5. Who reads it today

| Reader | How |
|---|---|
| `GET /enterprise-snapshots`, `GET /enterprise-snapshots/{id}?measure=` (permission `funding.snapshot.read`) | the list (filter by period and status) and the detail: totals, the share of each class, rates with both terms, by unit, by project, indicators, lineage, `hash_verified`, and `partial: true` when the caller's scope hides some projects (the figures are then those of the visible projects only) |
| Screens DIS-32 (build and review: readiness, missing units, waiting batches, the snapshots of the period, build with a confirmation) and DIS-33 (one snapshot, freeze) | `apps/web/src/screens/dis/enterprise/`; every figure comes from the API, none is computed in the browser |
| Report forms (RPT) | `EnterpriseSnapshotProvider` (`apps/api/src/editions/enterprise/snapshot-provider.ts`), registered by the enterprise seam: when a frozen snapshot of the month or quarter of the form exists the draft is filled from it (`data_source` LIVE, snapshot id and revision in `snapshot_ref`); when none exists the illustrative data and the DEMO stamp stay as they were. The forms stay `ILLUSTRATIVE` (layout status DEMO) until the customer supplies the real forms |
| Leadership dashboard and the funding structure of HOME-07 | `getLeaderRates` reads the latest frozen snapshot and the one before it through the reader; with none frozen it answers 200 with `snapshot: null` and the reason |

Events written to the outbox in the same transaction (ids, codes and counts, never an amount): `enterprise.snapshot_built.v1`, `enterprise.snapshot_frozen.v1`; counters `ent_snapshot_build_total`, `ent_snapshot_freeze_total`; build and freeze are commands of the command pipeline (audited, ADM-11, with idempotency).

## 6. The hook for HOME, BAN and HPM

Anything that needs the official figure of an enterprise period calls `EnterpriseSnapshotStore.frozenOf(tx, periodId)` (or `frozenForDates(tx, 'MONTH' | 'QUARTER' | 'YEAR', start, end)` when it knows the dates and not the id), then `view(tx, row)`, then builds an `EnterpriseFigureReader`. Nothing else may read `period_snapshot_figure` for a figure of the enterprise edition. The push to HPM (ENT-3c) carries the package of the staged approval (`pushPackageOf`, facts of the approved record) and does not yet read this snapshot; when the customer's HPM message shape is confirmed (`docs/integration/hpm-proposal.md`) the push reads the figures through the same reader. The customer's HPM technical information is still pending (PX-03 of `docs/delivery/11-pending-external-register.md`).

## 7. Working assumptions

- The classes, the measures and the actuals precedence (`REPORTED_UNTIL_RECONCILED`) of the pack are the working assumptions A-3 and A-9 of `docs/fnd-funding-model.md` until the customer's indicator dictionary and forms arrive; a tenant's approved `FUNDING_TAXONOMY` rule replaces them and the snapshot records the version it used.
- Which units are "input points" is derived from the owner unit of the planned projects; the customer's own list of input points (the org pack, ENT-3d) can narrow it later without changing the stored shape.

## 8. The lock of the period (INT-2)

The snapshot is built only on a `LOCKED` period, and an enterprise period that locks too early forces a reopening before the review of the planning board has finished. So in the enterprise edition the job `dis-period-autoclose` does not lock a month, a quarter or a year before the review step and the close step of its `REPORTING_SCHEDULE` have finished (`periodLockVerdict`, `packages/kernel/src/reporting-lock-gate.ts`; details in `docs/runbooks/jobs.md`). The public edition keeps its rule of three working days after the entry deadline.

## 9. Tests

`packages/kernel/test/enterprise-snapshot.test.ts` (completeness, rows to freeze, hash, the reader), `packages/db/test/enterprise-snapshot-store.test.ts` (build, stable hash, refusal with units, immutability, reopen rule, revision lineage, self-freeze refused, indicators carried), `apps/api/test/fnd/enterprise-snapshot.test.ts`, `apps/api/test/reports/report-engine.snapshot.enterprise.test.ts`, `apps/web/src/screens/dis/enterprise/EnterpriseScreens.test.tsx`, and the public golden test `fnd-public-golden` (a public figure is byte-identical).
