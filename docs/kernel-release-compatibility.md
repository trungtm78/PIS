# Release compatibility: application N-1, release flags (ST-KERNEL-014)

A release can be rolled back without destroying data, and a route can be switched on after the deploy, only if three things hold: the schema that application N migrated is still one that application N-1 can read and write, the events that N wrote are still delivered when N-1 runs again, and a flagged route can be opened or closed without touching the schema. This page says what proves each and what only a real release can prove.

## The schema N-1 can live with (AC-ST-KERNEL-014-1, UAT-NFR-OPERABILITY-03)

Two checks look at it from two sides.

- `scripts/expand-contract-check.mjs` reads the text of the migrations: a destructive or tightening statement needs a `-- contract: ...; release <id>` marker in a migration of its own.
- `packages/db/test/support/schema-compatibility.ts` reads the catalog of the database: `readSchemaShape` gives every table and column of the `machvon` schema with its type, whether it is required and whether the database fills it when an insert leaves it out, and `compatibilityBreaks(previous, next)` names what application N-1 can no longer do. It finds a table or a column that is gone (a rename is a removal), a column whose type changed, a column N-1 writes as null that no longer accepts null, a default that N-1 relied on and that was removed, and a new required column with nothing to fill it. A nullable column, a defaulted column and a new table are not breaks.

`packages/db/test/schema-compatibility.test.ts` runs the second check against a real database: it applies the migrations after the baseline of `db/migrations/expand-contract.json` one at a time and demands that every break is in a migration that carries the contract marker. For each kind of break it also builds a table, takes the statement N-1 issues, applies the migration and shows that N-1 really fails with the code PostgreSQL gives, and that after an expand step N-1 reads what N wrote and writes its own.

The suite found one break the text check cannot declare: V1461 adds `quality_acceptance.content_hash` with a placeholder default and drops the default in the same migration, so every insert must supply it, and the marker for a contract step may not sit in a migration that also adds a column. No release wrote a quality acceptance, so nothing is lost, and the test lists it by name (it has to shrink when the migration is replaced and it must name every other break exactly).

The delivery after a rollback is in `packages/db/test/outbox-relay.test.ts`: 100 events of a version of their own are written, the relay of release N dies in the middle of the first batch, and the relay of release N-1 delivers all 100, once each, with their payload intact.

## A route behind a release flag (AC-ST-KERNEL-014-3)

`@RequiresFlag('<flag key>')` on a route or a controller (`apps/api/src/entitlements/feature-flag.guard.ts`) makes the route answer 503 `FEATURE_UNAVAILABLE` while the flag is not on for the tenant of the caller, and serve it once it is, for a cohort first if the rollout says so, without a deploy or a schema change (the test compares the shape of the schema and the ledger of migrations before and after). The key must be one of `DECLARED_FLAGS`, or the application does not start. The guard runs after the authentication and the policy guard, so a caller without the permission is told 403 and learns nothing about the flag; a route without a flag costs no read; with no control plane no flag is on and a flagged route stays closed. A flag decides a code path only: it never grants a right (BR-R07).

No existing route is behind a flag yet: `sas.silo_promotion` and `sas.tenant_restore_in_place` are declared and can be set, and putting their routes behind them is a decision of SAS (the routes act on a target tenant given in the path, while the guard judges the tenant of the caller).

## What only a real release proves

AC-ST-KERNEL-014-2 and AC-ST-KERNEL-033-2 (the rollback of a production or staging release in 15 minutes or less after a 5 percent canary, with the data N wrote still readable by N-1) need the pipeline and the ingress of spike 6; they are declared as external checks in `docs/story-status.json`.
