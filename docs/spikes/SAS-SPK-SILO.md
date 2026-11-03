# SAS-SPK-SILO: logical replication of one tenant to a silo on the selected cloud (ST-SAS-018, TK-SAS-018-4)

**Status: NOT RUN.** The effort estimate of the story says it in so many words: "logical replication on the chosen domestic cloud is unconfirmed; needs an R2 spike on the selected provider" (SAS.md risk table, owner: infrastructure tech lead, decision D02 on the cloud). No provider is selected, so there is nothing to run the replication on. This report states the question, the method to follow, the numbers to collect and what the platform already does so that a result can be plugged in without changing the contract. **No number below was measured.**

## Question

Can one tenant of the shared PostgreSQL cluster be copied to a database of its own, kept in step while it keeps writing, compared exactly with the original, and cut over with writes frozen for at most `write_freeze_max_minutes` (5 to 240), on the cloud chosen under D02, within the residency rules (data stays in a `vn-*` region, Luật Dữ liệu 60/2024/QH15)?

## Method to follow on the provider

1. **Prerequisites.** Both clusters on the same major PostgreSQL version; `wal_level = logical` on the source (the template `infra/postgres/postgresql.conf.tpl` already declares it for PowerSync, KERNEL-002); a role with `REPLICATION` on the source; the schema of the platform applied to the silo database from the template (the same migrations, `db/migrations`), so the silo has the same tables, constraints and guards.
2. **Row filter.** A publication with a row filter on `tenant_id` for every table of the tenant plane (PostgreSQL 15 or later: `CREATE PUBLICATION ... FOR TABLE t WHERE (tenant_id = '<id>')`); a subscription on the silo with `copy_data = true`. Check which version the provider offers; below 15 the filter does not exist and the fallback is a copy by `COPY (SELECT ... WHERE tenant_id = ...)` followed by a catch-up from the WAL, or a dump restore plus a longer freeze.
3. **Tables the filter cannot take.** Tables with no `tenant_id` (control plane) are not copied; tables partitioned or with no primary key need the replica identity set to `FULL`; sequences are not replicated and must be advanced on the silo before the switch; the objects of the object store (`tenants/<id>/...`) are copied by prefix with the checksum of each object.
4. **Foreign keys and guards.** The subscription applies as a role that does not fire the guard triggers of the platform (they exist to refuse application writes); after the copy the guards are active on the silo. Confirm with the owner role what the provider allows (`session_replication_role = replica` needs a superuser or an equivalent).
5. **Compare.** After the initial copy and at every pass run the measure of the platform on both sides: per table the number of rows, the sum of a hash of the content of every row, and the sum of every `numeric(24,0)` column (`packages/db/src/placement-measure.ts`; the SQL is the same on both sides). Inject one altered row on the silo and confirm the comparison finds it.
6. **Freeze and cut over.** Measure how long the last difference takes to apply after writes are refused (`tenant.write_frozen_until`), at the write rate of the largest tenant expected, and whether the comparison under the freeze fits in `write_freeze_max_minutes`. The routing switch itself is a change of `tenant.placement_id` and `isolation_mode`, which the per-placement connection router (not built, see `docs/sas-silo-promotion.md`) reads.
7. **Rollback.** Time the abort from CutoverFrozen (the freeze is lifted, the copy dropped) and from Switched (the routing returns while the silo has taken no write); see `docs/runbooks/silo-promotion-rollback.md`.

## What to collect (all to be measured, none is known)

| Item | Why |
| --- | --- |
| PostgreSQL major version and whether `CREATE PUBLICATION ... WHERE` is available | decides step 2 |
| Initial copy throughput (GB per hour) and the lag under the write rate of the largest tenant | sizes the window of the copy |
| Time to apply the last difference after the freeze | must fit `write_freeze_max_minutes` |
| Time of the full comparison (rows, key checksum, money) of the largest tenant | the comparison runs again under the freeze |
| Whether the apply role can skip the guards, and how | step 4 |
| Cost of a silo (instance, storage, backup, KMS key) per tenant | the commercial rule that decides who gets one |
| Residency: region of the silo, of its backups, of the key | `vn-*` only |

## What the platform already does, so the result plugs in

- The state machine, the comparison, the four-eyes approval, the bounded freeze, the switch, the 24 hours of observation, the rollback and the deletion of the old data after 30 days are built and tested (`docs/sas-silo-promotion.md`). The data path is one port, `PlacementMover` (`copy`, `sync`, `measureTarget`, `discardTarget`, `purgeSource`), with a stand-in for development and tests that moves nothing, and **none in production**: every operation is refused with `PLACEMENT_MOVER_UNAVAILABLE`, so no migration can claim to have copied anything.
- A real mover implements the five operations over the publication and subscription of step 2; `measureTarget` runs `measureTenantTables` against the silo.

## Decision

Not taken. Proposed once the provider is chosen (D02): run steps 1 to 7 on a copy of the largest tenant of a staging cluster, fill the table, and either bind a mover or choose the fallback of step 2. Until then a promotion cannot copy data in production, by design.
