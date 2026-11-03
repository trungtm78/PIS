# SAS_PLACEMENT_MISMATCH

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_PLACEMENT_MISMATCH.json`

## What it means

The gauge `placement_migration_mismatch_total` is the number of promotions of a tenant to a silo that are `AwaitingCutover` and whose last comparison found the copy different from the original (`checksum_match` false), as counted by the job `placement-migration` (every minute, `docs/runbooks/jobs.md`). While it lasts the cutover cannot be approved: the approval is refused with 422 `MIGRATION_VERIFICATION_FAILED`. The gauge `placement_migration_attention{tenant_id}` names the tenant. A copy that is only a little behind the original (the tenant went on writing) heals at the next pass, because the job catches the copy up before it compares again; an alert that stays means the copy does not converge.

## What to do

1. Open the promotion on screen SAS-23 (or `GET /system/placement-migrations/{migrationId}`): the comparison lists every table, its rows, the checksum of its keys and its money sums on both sides. The tables with `match` false are the ones that differ; `mismatched_tables` names them.
2. Rows or checksum differ, money agrees: rows were added, removed or replaced in the copy or in the original. Wait one or two passes; if the original is still being written to, that is the cause (the final comparison is made with writes frozen, so this alone does not block the cutover once it is approved, but the approval needs an agreeing comparison first).
3. Money differs: do not approve. Find the table and the column in the comparison and compare the rows of the tenant on both sides by hand (a read of the silo through the support procedure of the cloud, never through the application). A money sum that differs is a copy that lost or altered a row.
4. If the copy cannot be made to agree, abort the promotion (`abortPlacementMigration`, screen SAS-23): before the cutover nothing was switched, the copy is destroyed and the tenant stays where it is. Then look for the cause (`docs/sas-silo-promotion.md`, "What is not built") before planning another.
5. Never edit `tenant_placement_migration` by hand: the guards refuse a change of what was compared, an approval or a status that is not on the way.
