# DIS-7: the withdrawal of a report, and the soft deletion and restore of a draft (ST-DIS-007)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F3). Migration: `V1046__dis1_report_withdraw.sql`. Screen DIS-09 (`/dis/dis-09?report=<id>`): the confirmation that names the report before anything is undone (it fixes the source defect SRC-06, a deletion that did not say what it deleted).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `withdrawReport` | `POST /reports/{id}/withdrawal` | `report.withdraw` | SUBMITTED to WITHDRAWN, with a reason of at least 20 characters. |
| `deleteDraftReport` | `POST /reports/{id}/draft-deletion` | `report.edit` | Soft-deletes a draft with a reason (at least 5 characters). |
| `restoreDraftReport` | `POST /reports/{id}/draft-restore` | `report.edit` | Brings back a draft that was deleted within 30 days, if the caller may edit the project now. |
| `get_resources_report_revision` | `GET /resources/report_revision?deleted=true` | `report_revision.read` | Lists the drafts that were deleted and can still be restored, instead of the reports that stand. |

## The withdrawal (AC-ST-DIS-007-3)

A report is withdrawn while it waits to be reviewed: SUBMITTED, not UNDER_REVIEW, and in a period that takes it (409 `REPORT_STATE_INVALID` naming the status, then 409 `PERIOD_LOCKED` unless an approved reopening names the project). The reason is judged by the command, not by the schema: under 20 characters is 422 `VALIDATION_FAILED` naming `reason`. The table keeps who withdrew, when and why with the status (`report_revision_withdrawn_chk`), fixed once written. The audit row `dis.report_withdrawn` keeps ids, codes and the length of the reason; the event `report.withdrawn.v1` carries the reason for whoever has to be told. The count `dis_report_withdrawal_total` is raised after the commit.

A withdrawn report is the end of that revision, and the period is reported again from it: a correction (`post_reports_id_corrections`) starts from a WITHDRAWN revision as from a returned one, and the new draft names the revision it replaces and why.

## The deletion and the restore (AC-ST-DIS-007-1, AC-ST-DIS-007-2)

Only a draft that stands is deleted (409 `REPORT_NOT_EDITABLE` naming the status for anything that was handed in, or for a draft that is deleted already). The deletion keeps the instant and the reason (`deleted_at`, `deleted_reason`); the draft leaves the lists and is not edited (409 `REVISION_IMMUTABLE`), and a deletion stands as it was made until the draft is restored (`report_revision_guard`). `GET /resources/report_revision?deleted=true` lists the drafts that were deleted within the last 30 days, in the scope of the caller.

A restore is within 30 days of the deletion, the last instant included (422 `RESTORE_WINDOW_EXPIRED` after it; 409 `REPORT_STATE_INVALID` for what was not deleted). The permission is judged again, now: a person who may no longer edit the project is 403 `SCOPE_DENIED` and the draft stays deleted. The draft comes back as it was, version moved once; the audit rows are `dis.report_draft_deleted` and `dis.report_draft_restored`.

## The screens

DIS-09 names the report (project, period and revision as its code), the period and the project, and asks the reason. For a draft it deletes it softly and leads back to the list; for a report that was handed in it withdraws it and leads to its detail (DIS-07); for a draft that was deleted it shows the reason and the last day, and restores it on one click (to DIS-04), or says the time has passed. Every refusal of the server has its sentence and what was typed is kept. The way in: the steps of a draft (DIS-03 to DIS-06) carry "Xóa bản nháp"; DIS-07 carries "Thu hồi báo cáo" for the maker who may withdraw; DIS-01 lists the drafts that were deleted under the reports.

## Assumptions

- The restore window is 30 days (DIS.md marks it as a working assumption); it is one constant in the kernel and in the screen.
- A draft that is deleted keeps the place of its revision: a new draft of the same project and period is not made while it is there (409 `REPORT_STATE_INVALID`, as for any revision that exists); restoring it is the way back. What happens to a deletion that is never restored (a purge after the window) belongs to the retention story.
- Every maker who holds `report.withdraw` on the project may withdraw, not only the person who handed the report in.
