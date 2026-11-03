# Rolling back a promotion to a silo (ST-SAS-018, TK-SAS-018-4)

**Owner:** platform-oncall with a System Admin · **When:** a promotion that is not Completed must be undone, or the system rolled one back and the tenant has to be checked. Screen SAS-23; operation `abortPlacementMigration` (`POST /system/placement-migrations/{migrationId}/abort`, If-Match the version, a reason of 10 characters).

## What each point of the way does when it is aborted

| Status when aborted | Result | What is put back |
| --- | --- | --- |
| Planned, Copying, Verifying, AwaitingCutover | `Aborted` | nothing had changed for the tenant; the copy at the silo is destroyed by the next pass of the job (`target_discarded_at`) |
| CutoverFrozen | `RolledBack` | the freeze is lifted (`tenant.write_frozen_until` null): **writes work again at once**; the routing was never changed; the copy is destroyed |
| Switched (inside the 24 hours) | `RolledBack` | `tenant.placement_id` and `isolation_mode` go back to the pool; the copy is destroyed. **Refused with 409 `MIGRATION_STATE_INVALID` (`TARGET_CHANGED`) when the silo holds something the last comparison did not see**: data written to the silo since the switch cannot be carried back (no reverse replication exists), so the way back is closed |
| Completed, Aborted, RolledBack | refused, 409 `MIGRATION_STATE_INVALID` | the migration is over |

The system rolls a frozen migration back by itself (`ended_by` null) when the freeze of writes runs out before the switch (`FREEZE_EXPIRED`) or when the comparison made under the freeze disagrees (`FINAL_VERIFICATION_FAILED`). Both lift the freeze; the alert `SAS_PLACEMENT_FAILING` fires for a day.

## Procedure

1. Open the promotion on SAS-23. Read the Status, the freeze countdown and the comparison. If the tenant reports a fault after the switch, check first whether the silo has taken writes (the people of the tenant have worked on it since the switch): if so the rollback will be refused, and the fix is forward (repair on the silo), not back.
2. Choose the abort button and state the reason. For a frozen migration the screen says writes will work again at once.
3. Check afterwards: the status is `Aborted` or `RolledBack`; `write_frozen_until` is empty (writes of the tenant succeed); for a rolled back switch the placement and the isolation of the tenant are the old ones (`GET /system/tenants/{tenantId}`).
4. The next pass of the job destroys the copy (`target_discarded_at` is set). If it does not within a few minutes, see the alert `SAS_PLACEMENT_FAILING`. The old data at the pool was never touched, so nothing needs restoring.
5. Record the reason in the minutes. A new promotion can be planned at once (no migration is open); fix the cause first.

## When the tenant must go back after Completed

A Completed promotion is final: the old data is kept for 30 days and deleted after that unless a legal hold is in force (`source_purge_due_at`). Going back after Completed is not a rollback; it is a new move of the tenant, outside this story, and during the 30 days the old data is a recovery point for a restore (`docs/sas-tenant-restore.md`).
