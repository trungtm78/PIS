# SAS: restore of one tenant to a recovery point (ST-SAS-019, slice SAS-1)

A System Admin can restore one tenant to a recovery point: into a sandbox, or over the data of the tenant while it is Suspended (SAS.md 3.11, BR-SAS-12, SAS-21; NFR-AVAILABILITY-02 and 03). A second System Admin decides; the worker makes the
restore through the restore engine and compares the copy with what the backup recorded; the restore is Completed only when everything matches. The same record is the evidence of the quarterly restore drill
(`docs/runbooks/tenant-restore-drill.md`). Nothing here reopens a tenant: after an in-place restore the tenant stays Suspended until a System Admin resumes it (`resumeTenant`, ST-SAS-004).

## Asking for a restore (`requestTenantRestore`, `system.tenant.manage`, Idempotency-Key)

`POST /system/tenants/{tenantId}/restore-requests` with `{ recovery_point, target: SANDBOX | IN_PLACE, reason }`. The command acts as the tenant it names, so the row, its audit and its events belong to that tenant. Refusals in order (nothing is written for them):

| step | refusal |
|---|---|
| the shape (`target` not one of the two, `recovery_point` not a date-time), `reason` trimmed under 10 or over 2000 characters | 422 `VALIDATION_FAILED` (naming the field) |
| the tenant does not exist | 404 `RESOURCE_NOT_FOUND` |
| the tenant is not Active, Suspended or Offboarding (a tenant that was never provisioned, failed or is archived has no data to restore), or the target is `IN_PLACE` and the tenant is not Suspended | 409 `TENANT_STATE_INVALID` (UAT-AC171: an in-place request on an Active tenant) |
| the recovery point is not inside the window of the backups for the tenant (35 days back to now), or the engine holds no window at all | 422 `RECOVERY_POINT_UNAVAILABLE` |
| the target is `IN_PLACE` and another in-place restore of the tenant has not ended (the unique index on the open ones) | 409 `RESTORE_IN_PROGRESS` |

A request is written Requested at version 1 with the audit row `tenant.restore_requested` (CONFIDENTIAL; the target and the recovery point, never the reason). Sandbox restores are copies and run side by side; an in-place restore overwrites the data
of the tenant, so one runs at a time.

## Deciding (`decideTenantRestore`, `system.tenant.manage`, If-Match, Idempotency-Key)

`POST /system/restore-requests/{restoreId}/decision` with `{ decision: approve | reject, reason, evidence_ids }`. The path names only the request, so the control plane finds its tenant by the id alone (`restore_tenant_of`, as for an override). Refusals in order:

| step | refusal |
|---|---|
| `decision: return` (a restore has no rework: a change of mind is a new request) | 422 `VALIDATION_FAILED` (`DECISION_NOT_OFFERED`) |
| the request does not exist | 404 |
| the version in `If-Match` is not the current one | 409 `VERSION_CONFLICT` with `current_version` |
| the request is not Requested | 409 `STAGE_TRANSITION_DENIED` |
| the caller is the person who asked, whichever way they decide | 403 `SELF_APPROVAL_DENIED` |
| approving: the state of the tenant no longer allows it (an in-place restore of a tenant that was resumed meanwhile) | 409 `TENANT_STATE_INVALID` |
| approving: the recovery point left the window of the backups while the request waited | 422 `RECOVERY_POINT_UNAVAILABLE` |

Approved: the request is Approved (`202`), with `decided_by`, `approved_by` (the same person), `decided_at` and the reason; `evidence_ids` go into the audit row `tenant.restore_decided`. Rejected: no approver, and nothing is restored. Both are final
for the decision.

## The restore (job `tenant-restore`, every minute; `TenantRestoreWorkflow` of SAS.md 3.11)

For each tenant the job takes the oldest Approved restore (`for update skip locked`), Restoring (`started_at`), and then:

1. asks again for the state of the tenant (`assertRestorable`): an in-place restore of a tenant that is no longer Suspended ends as Failed with `TENANT_STATE_INVALID` and the engine is not called;
2. calls the restore engine: it restores the tenant to the recovery point and reports the instant it stopped at, where the copy is (a sandbox restore: `sandbox_ref`), what the backup recorded for the recovery point and what the restored copy holds. The request is
   Verifying from here;
3. verifies (`verifyRestore`, pure): table by table the same tables, rows, checksum and money totals, and no row of another tenant. A copy that matches is Completed with the report; one that does not is Failed (`VERIFICATION_MISMATCH`) **with** the report;
4. an error of the engine ends the restore as Failed with the class of the error (`error.name`) and never its message, which may hold data.

A restore that has been Restoring or Verifying for six hours (the target to recover and two hours more) belongs to a process that is gone: the next pass makes it Failed (`Stalled`). The pass is idempotent. The job tells how many restores wait or run
(`tenant_restore_pending`) and how many failed in the last day (`tenant_restore_failed_24h`), for the alerts `SAS_TENANT_RESTORE_PENDING` and `SAS_TENANT_RESTORE_FAILED`.

## The verification report (the record of the drill)

`RestoreVerificationReport` (schema version 1), stored as `verification_report` and named by `verification_report_ref`, the sha256 of its canonical JSON (`sha256:...`), so the record cannot change without the reference showing it:

- `tables[]`: for each table `expected_rows`, `restored_rows`, the two checksums and for each money column (a numeric column whose name ends in `_vnd`) the total expected and restored, with a `match` for each; a table in one and not in the other is a
  difference too (`missing_table:`, `unexpected_table:`);
- `totals`: tables, rows and the sum of every money column, exactly (decimal arithmetic on text, no floating point);
- `foreign_rows`: rows of another tenant in the restored copy, which must be 0 (NFR-AVAILABILITY-03);
- `mismatches[]`: `rows:table`, `checksum:table`, `money:table.column`, `missing_table:table`, `unexpected_table:table`, `foreign_rows`; `matched` is true only when it is empty;
- `rpo_seconds`: how far before the recovery point asked for the copy stops; `rto_seconds`: from the approval to the end of the verification; the targets (900 s and 14 400 s, NFR-AVAILABILITY-02, awaiting decision D10) and `within_targets`. A copy that matches but
  misses a target is Completed and flagged: the drill reports the miss, it does not hide it.

The database holds the rules too (V1495): a Completed restore has a report that matched and its reference; the report never changes after it is set; the person who decided is never the one who asked, and the approver is the person who decided; a restore
moves forward only (Requested to Approved or Rejected, to Restoring, Verifying, Completed; any running state to Failed); what ended does not change; nothing is deleted; at most one in-place restore of a tenant is open; only a sandbox restore has a
`sandbox_ref`.

## Reads (`listTenantRestoreRequests`, `system.tenant.read`)

`GET /system/tenants/{tenantId}/restore-requests` (newest first, a page at a time) gives the status and version of the tenant, the window of recovery points the engine holds (`recovery_window`, null when none), the RPO and RTO targets and the restores with their
reports. A Platform Operator reads; only the System Admin asks and decides. The list is the tenant's alone: the report holds the figures of the tenant and nothing else.

## Screen SAS-21 (apps/web/src/screens/sas/RestoreScreen.tsx)

The tenant picker, the window card (status of the tenant, recovery points in UTC, scope, targets), the request form (recovery point in UTC, sandbox or in place, reason; in place is offered only while the tenant is Suspended; nothing can be asked for where no
engine is bound), the list (recovery point, target, status, requested, approver, sandbox, actions) and the verification report on request. The person who asked sees the request wait for another administrator and has no button to decide it. The seven
states render (loading, empty as a sentence in the list, error, denied, signed out, offline, and the default); a refusal is shown outside the form, which may disappear; the retry after a lost answer keeps the version and the idempotency key of the first
request; the list is read every five seconds while a restore waits or runs. All text is in `vi.json` and `en.json` under `sas.restore.*`.

## The engine, and what is NOT built (read this before relying on it)

The restore engine is a port (`TenantRestoreEngine`, `packages/db/src/restore-ports.ts`): `window(tenantId, now)` and `restore(job)`. **There is no real backup and restore behind it.** PITR of the domestic cloud, the WAL archive and the placement of a sandbox copy
are the subject of the infrastructure spike and of decision D10 (RPO/RTO targets); until a real engine is bound:

- in an environment that holds real data (`MACHVON_ENVIRONMENT` production, or not named) the engine is `UnboundRestoreEngine`: it holds no recovery point, so every request is 422 `RECOVERY_POINT_UNAVAILABLE`, SAS-21 says so, and no restore is ever claimed to have been made;
- elsewhere it is `MockRestoreEngine`: it has no backups, measures the tenant as it is now in one snapshot and uses that for both the backup and the copy, places a sandbox copy nowhere (`mock-sandbox/{id}`) and overwrites nothing. It proves the flow around the
  engine (request, decision, worker, verification, report, drill record, alerts), not a backup. Tests can make it fail, tamper with the copy or stop it before the recovery point.

Also open: the lifetime and cleanup of a sandbox copy, the signed minutes of a drill (the report is the evidence; the signature is a person's), and gating `resumeTenant` on a Completed in-place restore (today the System Admin judges it from the report).
