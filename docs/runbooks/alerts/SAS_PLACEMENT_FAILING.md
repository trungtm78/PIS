# SAS_PLACEMENT_FAILING

**Owner:** platform-oncall · **Severity:** critical · **Rule:** `alerts/rules/SAS_PLACEMENT_FAILING.json`

## What it means

The gauge `placement_migration_failing_total` counts, over all tenants, (a) the promotions to a silo that are not over and whose worker failed at its last pass (`last_error_code` is set), and (b) the promotions the system rolled back by itself in the last 24 hours (`status` RolledBack, `ended_by` null, `end_reason` `FREEZE_EXPIRED` or `FINAL_VERIFICATION_FAILED`). It is counted by the job `placement-migration` (every minute). The tenant is named by the gauge `placement_migration_attention{tenant_id}`, and by the audit trail of the migration.

## What to do

1. Open the promotion on screen SAS-23: the field Status shows the last failure by its class (`last_error_code`), never its message.
2. `PLACEMENT_MOVER_UNAVAILABLE`: the data path that copies the tenant to the silo is not bound in this environment (production has none until the replication on the chosen cloud is confirmed, spike R2, `docs/spikes/SAS-SPK-SILO.md`). Nothing was copied and nothing is claimed to have been. Abort the promotion (`abortPlacementMigration`) until a mover exists; do not retry by hand.
3. Another class (a network or database error): the job tries again at every pass, and every step is idempotent, so the migration goes on by itself once the cause is gone. If it does not within the hour, read the logs of the API process by the class and the tenant, and fix the connection to the silo.
4. `FREEZE_EXPIRED`: the switch did not happen inside the freeze of writes chosen for the promotion (the last difference or the last comparison took longer). Writes work again and the routing is the old one; nothing is lost. Plan the promotion again with a longer freeze (up to 240 minutes) in a quieter window.
5. `FINAL_VERIFICATION_FAILED`: with writes frozen, the copy still differed from the original in at least one table; the comparison that failed is kept on the migration. Treat it as `SAS_PLACEMENT_MISMATCH` step 3: find out why before another attempt.
6. The rollback procedure for a promotion that was switched is `docs/runbooks/silo-promotion-rollback.md`.
