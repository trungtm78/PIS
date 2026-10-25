# CTR_REVISION_OVERDUE

**Owner:** contract-office · **Severity:** warning · **Rule:** `alerts/rules/CTR_REVISION_OVERDUE.json`

## What it means

The job `revision-effective` (every hour, `docs/runbooks/jobs.md`) puts the revisions of the contracts in force when their first day has come. The gauge `ctr_revision_overdue` is the number, over all tenants, of the revisions still PENDING_EFFECTIVE more than a day after their first day. A revision is late because the job did not run for a day, or because it cannot take over:

* the contract is no longer being performed (completed, terminated or closed);
* the value of the revision is below what the contract has accepted or paid since the change was approved (BR-CTR-06), so putting it in force would break `contract_ledger_order_chk`.

Until it takes over, the old revision still prices the work, the value of the contract is unchanged and the capital has not been told of the change.

## What to do

1. Look at the timeline of the contract (CTR-26): the revision is shown "not yet in force" with its first day.
2. If the job is not running, see `docs/runbooks/jobs.md` and the alert `JOB_FAILED`; the next pass takes every due revision in the order of their days.
3. If the contract is no longer being performed, the change order cannot take effect: record why in the contract and leave the revision; it is not deleted.
4. If the value is below the floor, the change order has to be decided again with a value at or above what was accepted and paid (a new change order for the difference). Do not edit `contract_revision` in the database: the guard trigger refuses it.
