# DIS-4: the volumes, the registration for next month, the notes, the files and the review of the weekly report draft (ST-DIS-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F1 steps 3, 5, 6 and 7, BR-DIS-06, BR-DIS-07, BR-DIS-08, BR-DIS-12). Migration: `V1043__dis1_report_progress.sql`. Screens DIS-03 (`/dis/dis-03?report=<id>`, the volumes), DIS-05 (`/dis/dis-05?report=<id>`, the registration for next month) and DIS-06 (`/dis/dis-06?report=<id>`, the review). DIS-04 and DIS-18 of ST-DIS-003 join them in one set of steps (`StepNav`).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `post_reports`, `post_reports_id_revisions` | as in `docs/dis-report.md` | `report.create`, `report.edit` | Take the volumes, the narrative and the files besides the six cells. A save names what it changes: what it leaves out is kept. |
| `getReportRevision`, `get_resources_report_revision_id` | `GET /reports/{id}`, `GET /resources/report_revision/{id}` | `report.read`, `report_revision.read` | Return `progress`, `narrative`, `attachments` and, for a live draft, `review`. |
| `uploadReportFile` | `POST /report-files` (multipart) | `report.edit` | The upload door of a file of a report: judged by its bytes, stored private to the tenant, scanned. |

## The volumes (AC-ST-DIS-004-1)

`construction_vnd`, `acceptance_vnd`, `treasury_submitted_vnd` and `preparing_dossier_vnd` are whole dong and are named together (422 `VALIDATION_FAILED` naming the first that is missing, a negative or fractional amount or one that is not a number); `physical_progress_pct` is optional, 0 to 100 with up to two decimals. They are kept in `progress_snapshot` with the last day of the period as `as_of_date` and the basis of the report as `measurement_basis` (the trigger refuses another basis, and a save that changes the basis moves the volumes with it). The default basis is the year to date, which DIS-03 marks "CHỜ KÝ D03" until the capital owner signs BR-DIS-12.

## The registration for next month (AC-ST-DIS-004-3)

`next_month_vnd` and `next_month_ctmtqg_subset_vnd` of each cell were part of the six cells from ST-DIS-003; DIS-05 is their screen. The CTMTQG is inside the registration and exists only in the year plan and the carried-over plan (422 `SUBSET_EXCEEDS_PARENT` naming `funding_lines[i].next_month_ctmtqg_subset_vnd`). The REGISTERED schedule row of the next month is created when the report is accepted, which is the story of the decision (DIS-006).

## The notes

`narrative` is the whole narrative: `results`, `causes`, `solutions`, `proposals` (each at most 4000 characters, optional in the weekly report) and `linked_issue_ids` (issues of the project of the report, at most 50, each once; 422 `VALIDATION_FAILED` naming `narrative.linked_issue_ids[i]` for one that is not). What a save leaves out is removed, a narrative with nothing in it removes the row, and a save that does not name `narrative` keeps it. The trail keeps the number of sections and issues, never the words.

## The files (AC-ST-DIS-004-4)

`uploadReportFile` judges a file by its bytes (422 `FILE_TYPE_NOT_ALLOWED`, 413 `PAYLOAD_TOO_LARGE` above 25 MB, the limits of the purpose `document`), stores it and scans it: an infected file is refused (422 `FILE_NOT_CLEAN`) and removed again, a scan that is not finished is told to wait (409 `SCAN_PENDING`). The answer names the file by id, hash and name. A save names the whole list of `attachments` (at most 20): each file must be of this tenant (another tenant's file is a file that does not exist: 422 `VALIDATION_FAILED`), have the hash named (422 `HASH_MISMATCH`) and be clean. `report_attachment` keeps the id, hash, name, type, size and place of each file; the trail of the upload keeps hash, size and type, never the name.

## The review (AC-ST-DIS-004-2, BR-DIS-07)

`reviewReport` (`packages/kernel/src/dis-review.ts`) tells every error and every warning at once. Errors (stop a send, with the code the server answers): `REVISION_IMMUTABLE`, `PERIOD_LOCKED` (locked, no approved reopening covers the project), `PLAN_VERSION_NOT_EFFECTIVE`, `SUBSET_EXCEEDS_PARENT`, `NEGATIVE_DELTA_EXPLANATION_REQUIRED`, `VALIDATION_FAILED` on `progress` (the volumes are missing). Warnings (told, never block): `VOLUME_EXCEEDS_ALLOCATION` (the work built is more than the capital allocated; 2,038,000,000 against 1,000,000,000 is 203.8%), `TREASURY_GAP` (the cumulative reported differs from what the Treasury paid by more than 5% [assumption, CXN-03]) and `NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT`. The Treasury figure is the payments booked in the window of the basis on the Vietnam day (PERIOD: the period; YTD: the year up to the period; PROJECT_TO_DATE: all time up to it), refunds taken off; no payment in the window is no figure, not zero (BR-DIS-08).

## Tests

`packages/kernel/test/dis-progress.test.ts`, `dis-review.test.ts`, `packages/db/test/dis-report-store.test.ts` (the volumes, the narrative, the files, the guards, the issues, the Treasury window), `apps/api/test/dis/report.test.ts` (HTTP: volumes, review, narrative, upload door, linking, replay), `apps/web/src/screens/dis/report/*.test.ts(x)` and `apps/web/e2e/dis-report-steps-flows.spec.ts`.
