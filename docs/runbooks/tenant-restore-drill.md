# Quarterly single-tenant restore drill (ST-SAS-019, TK-SAS-019-4)

**Owner:** platform-oncall with two System Admins · **Frequency:** once a quarter, and when a new component that holds tenant data is introduced (NFR-AVAILABILITY-03) · **Evidence:** the verification report of SAS-21 and its sha256, in the signed minutes of the drill

The drill proves that one tenant can be restored from the backups without touching any other, and measures how long it takes and how much data it would lose (NFR-AVAILABILITY-02: RPO at most 15 minutes, RTO at most 4 hours; the targets await decision D10).
A drill is an ordinary **sandbox restore** (`docs/sas-tenant-restore.md`): nothing about the running tenant changes.

## Before the drill

1. A restore engine must be bound in the environment (`TenantRestoreEngine`). Where none is, SAS-21 says so, offers no recovery point and no drill can be made: that is a finding of the quarter, not a pass. The MOCK engine of non-production environments proves the flow only;
   a drill against it is rehearsal, and its minutes must say so.
2. Two different System Admins take part (one asks, one approves). Neither may be the tenant's owner acting for it.
3. Choose a tenant with enough data to mean something (several tables with money, documents) and a recovery point inside the window shown on SAS-21, at least a day old and not at a boundary of the window. Note the recovery point in UTC.

## The drill

1. **Ask** (System Admin 1, SAS-21): choose the tenant, the recovery point (UTC), target *Môi trường thử* (sandbox), and a reason that names the drill (`Quarterly restore drill YYYY-Qn`). Note the time.
2. **Approve** (System Admin 2, SAS-21): approve with the same reference as the reason. The person who asked cannot; if the button is missing, you are the wrong person.
3. **Wait** for the status to go Approved, Restoring, Verifying, Completed (the list refreshes every five seconds). The time from the approval to Completed is the RTO the report will state.
4. **Read the report** (*Xem báo cáo xác minh*): it must say the restore matches the backup, with, for every table, the same rows, the same checksum and the same money totals; *Dòng của tenant khác* must be *Không có*.
5. **Record** in the minutes: the tenant, the recovery point, the two administrators, the sandbox reference, the number of tables and rows, the money total, the RPO and RTO measured against their targets, the verdict *Đạt mục tiêu / Vượt mục tiêu*, and the reference
   `sha256:...` of the report. Both administrators sign. The report itself stays in `tenant_restore_request` (it cannot change after it is set, and the reference shows if it did).

## Reading the result

| the report says | meaning | do |
|---|---|---|
| matches, within the targets | the drill passes | sign the minutes |
| matches, outside the targets (RPO or RTO) | the data is whole but the targets are missed | sign the minutes with the finding; raise it for decision D10 and capacity |
| does not match (`Failed`, `VERIFICATION_MISMATCH`) | the backup and the copy differ; the differences are listed (`rows:`, `checksum:`, `money:`, `missing_table:`, `unexpected_table:`) | the drill fails; follow `SAS_TENANT_RESTORE_FAILED`; fix the backup before relying on it |
| rows of another tenant in the copy | an isolation incident | stop; do not use the copy; open an incident |
| `Failed` with another class (`RestoreEngineUnreachable`, `Stalled`, ...) | the engine or the worker failed | the drill did not run to its end; fix and ask again (a new request) |

## After the drill

The sandbox copy holds the data of a real tenant: it is removed when the minutes are signed (the lifetime of a sandbox is an open item of ST-SAS-019, `docs/sas-tenant-restore.md`). An in-place restore is never a drill.
A real incident uses the same screen with the real recovery point: the same two people, the same report, and for an in-place restore the tenant stays Suspended until a System Admin resumes it after reading the report.
