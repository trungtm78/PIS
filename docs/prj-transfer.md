# The transfer of a project between units (ST-PRJ-007)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md` (3.1 F10). Migration `V1207__prj1_project_transfer_workflow.sql`. Operations: `requestProjectTransfer`, `decideProjectTransfer` and, for PRJ-20, two reads added to the contract: `getProjectTransferImpact` (`GET /projects/{id}/transfer-impact`, `project.transfer.request`) and `listProjectTransfers` (`GET /project-transfers`, `project.read`). Screen: PRJ-20. Job: `prj-transfer-apply` (every 15 minutes).

## The life of a request

`REQUESTED` -> `APPROVED` -> `APPLIED` on its day; `REQUESTED` -> `REJECTED` or `CANCELLED` (returned). Nothing is deleted.

- **Request** (`project.transfer.request`, under the version of the project the asker saw: 409 `VERSION_CONFLICT` otherwise): the project must be in the scope of the caller (404 when it is not visible, 403 `SCOPE_DENIED` when it is readable but not theirs to transfer) and not settled or cancelled (422 `PROJECT_STAGE_INVALID`). `transfer_scope` is `OWNER_UNIT` or `INVESTOR_UNIT`; the unit that is left is the one the project has for that scope (a project with no investor unit has none to transfer: 422). The receiving unit must belong to the **same tenant** (a unit of another tenant does not exist: 404), be in force and differ from the current one (422). The effective day is today or later; the reason has 10 to 2000 characters; a decision document, when given, must be usable. One request is open at a time for a project and a scope (409 `TRANSFER_PENDING_EXISTS`).
- **Decision** (`project.transfer.approve`, under the version of the request): `approve`, `reject` or `return`, with a reason of 5 to 2000 characters. **The one who asked cannot decide** (403 `SELF_APPROVAL_DENIED`, checked before the version). `return` closes the request as CANCELLED so that the requester asks again with what was wrong put right; `reject` closes it as REJECTED. A request that does not wait is 409 `STAGE_TRANSITION_DENIED`.
- **The day.** An approval whose day has come is applied in the same transaction; otherwise the job applies it on its day (by the date in Vietnam): the project takes its new `owner_unit_id` or `investor_unit_id`, its version rises, the members who gain or lose sight of it through the two units get a new scope version (IAM reads the tree again), the audit row `prj.transfer_applied` and the event `project.transferred.v1` are written, and the pages of the project bank are read again. If the project changed unit in the meantime, the transfer is closed (CANCELLED, `prj.transfer_closed_stale`) and nothing is changed.

## History stays where it was

The lines of a snapshot store their unit when the snapshot is built, so a snapshot made before the day keeps the old unit; a snapshot of a period built after the transfer (a rebuild after a reopening) is attributed to the owner unit the project had on the **last day of the period** (the first transfer applied after that day names the unit it left), so rebuilding history does not move it to the receiving unit. Nothing is rewritten. **Limit:** who may *read the reports* of a project is still judged by the units the project has now (the scope predicates of DIS and PRJ read `owner_unit_id` and `investor_unit_id`); the reports of the weeks before the day are not made readable by the old unit again (see TODOS).

## The preview (PRJ-20)

`getProjectTransferImpact` counts, before the request is made: the **reports** (revisions) of the project, the **snapshot lines** and the **plan lines** (they follow the project), and the members who would **gain** or **lose** sight of the project (the permission `project.read` over the project through its owner and investor units, before and after, judged by the grants in force). It returns counts only. The members are read up to 2000 (the answer says `partial` beyond that).

## Assumptions and limits

- The job runs every 15 minutes and applies what is due by the Vietnam date, not once at 00:05 as the plan says: the pass is idempotent and a transfer is made within the quarter of an hour of its day starting. The pages of the project bank cached by the API process (60 seconds) are not cleared by the job.
- `return` has no status of its own in the data model of V002 (REQUESTED, APPROVED, APPLIED, REJECTED, CANCELLED): it is stored as CANCELLED, with the reason that says what to put right.
- Scope on transfer relies on IAM resolving scope from the tree of units at the time of each decision (the scope version of the affected members is raised); an effective-dated resolver is the IAM group's request.
