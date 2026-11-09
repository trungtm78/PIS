# LOG_CAPACITY_EXCEEDED

**Owner:** tenant-administration · **Severity:** critical · **Rule:** `alerts/rules/LOG_CAPACITY_EXCEEDED.json`

## What it means

A log class is over its cap and the nightly run did not bring it back. The gauge `log_capacity_exceeded` is 1 by `record_class` and `tenant_id`. Three causes: the class is the audit trail or its detail records (monitor-only: no job ever removes business evidence), no archive store is configured for the process (nothing is removed without a file that holds the rows), or every row is younger than the retention rule or under a legal hold (a cap never shortens retention).

## What to do

1. Open ADM-30 and read the row of the class: `eligible rows` is the number a cap may remove, `protected rows` the number the retention rule keeps.
2. If `eligible rows` is zero, the cap is lower than the retention rule can honour: raise the cap (a cap on rows below the protected rows is refused at the time it is set, so this means the volume grew since) or shorten nothing: the retention periods are fixed by BR-ADM-11 and the tenant policy of ADM-12.
3. For the audit classes, raise the cap with a reason and plan the archive transfer.
4. After the change, run the job `retention-purge` by hand (`docs/runbooks/jobs.md`); the alert resolves when the next measure is below the cap.
