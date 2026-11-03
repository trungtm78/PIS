# SAS_TENANT_RESTORE_PENDING

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_TENANT_RESTORE_PENDING.json`

## What it means

The gauge `tenant_restore_pending` is the number of restores of a tenant that a second System Admin approved and that have not ended (`tenant_restore_request` in status Approved, Restoring or Verifying), as counted by the job `tenant-restore` (every minute, `docs/runbooks/jobs.md`). A restore of one tenant is made by the restore engine and then measured against its backup, so it takes minutes to hours (the target to recover is four hours, NFR-AVAILABILITY-02); a few at a time across tenants is normal. More than two, or a number that does not fall, means the worker is stuck, the engine is slow or the job is not running.

## What to do

1. Check that the job `tenant-restore` runs (`docs/runbooks/jobs.md`: API process only, one owner at a time under its lock).
2. A restore that has run for more than six hours (the target to recover and two hours more) belongs to a process that is gone: the next pass makes it `Failed` (`Stalled`), and the System Admin can ask again. An in-place restore that was lost leaves the tenant Suspended, with its data in whatever state the engine left it: do not resume the tenant (`resumeTenant`) until a restore of it is `Completed`, and read the report of the failed one first.
3. `RestoreEngineUnbound` in `error_code` means no engine is bound in this environment (production until the infrastructure spike has measured the point-in-time recovery of the domestic cloud, D10): no recovery point is offered and no restore can be asked for; bind the engine, do not edit the table.
4. Do not edit `tenant_restore_request` in the database: the guards refuse it, and a Completed restore with its report is the record of a drill.
