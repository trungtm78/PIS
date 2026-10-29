# SAS_TENANT_EXPORT_PENDING

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_TENANT_EXPORT_PENDING.json`

## What it means

The gauge `tenant_export_pending` is the number of exports of the data of a tenant that wait for the worker or are running (`tenant_export_job` in status Requested or Running), as counted by the job `tenant-export` (every minute, `docs/runbooks/jobs.md`). An export reads every table of the tenant in one snapshot and stores the files, so it takes minutes for a large tenant; one at a time for a tenant, a few at a time across tenants is normal. More than five, or a number that does not fall, means the worker is slow, stuck or not running.

## What to do

1. Check that the job `tenant-export` runs (`docs/runbooks/jobs.md`: API process only, one owner at a time under its lock). A job that failed leaves a row `Failed` with the class of the failure in `error_code`, and the owner can ask again.
2. An export that has run for more than two hours belongs to a process that is gone: the next pass makes it `Failed` (`Stalled`).
3. `ExportTooLarge` in `error_code` means the tenant holds more than 512 MiB (the export keeps a file in memory while it is made): this is the limit of R1 (`TODOS.md`, ST-SAS-016); agree with the owner on an export in parts, and do not raise the limit on a production process without sizing its memory.
4. Do not edit `tenant_export_job` in the database: the guards refuse it, and a Delivered export is what lets the tenant be archived.
