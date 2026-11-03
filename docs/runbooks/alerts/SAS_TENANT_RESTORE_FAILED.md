# SAS_TENANT_RESTORE_FAILED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_TENANT_RESTORE_FAILED.json`

## What it means

The gauge `tenant_restore_failed_24h` is the number of restores of a tenant that ended as Failed in the last 24 hours (`tenant_restore_request` in status Failed, `completed_at` in the last day), as counted by the job `tenant-restore`. Any value above zero is worth a look: a restore that cannot be made or cannot be verified is a backup that cannot be trusted.

## What to do

1. Read the request on SAS-21 (or `tenant_restore_request`): `error_code` is the class of the failure, never its message.
   - `VERIFICATION_MISMATCH`: the copy did not match what the backup recorded. The report is kept with the request (`verification_report`): `mismatches` names each difference as `rows:table`, `checksum:table`, `money:table.column`, `missing_table:table`, `unexpected_table:table` or `foreign_rows`. A `foreign_rows` above zero means the restored copy holds rows of another tenant: stop, treat it as a tenant-isolation incident and do not use the copy.
   - `TENANT_STATE_INVALID`: the tenant was resumed between the approval and the start of an in-place restore; nothing was restored. Suspend it again and ask again.
   - `Stalled`: the process that made it was lost (see `SAS_TENANT_RESTORE_PENDING`).
   - any other class (for example `RestoreEngineUnbound`, or the name of an error of the engine): the engine could not be reached or refused; check it, then ask again.
2. A failed sandbox restore harms nothing. A failed in-place restore leaves the tenant Suspended: keep it so, and decide with the System Admin whether to ask again or to restore from a different recovery point.
3. Do not edit `tenant_restore_request` in the database: the guards refuse it. A new attempt is a new request, decided by a second administrator.
