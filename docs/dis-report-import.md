# DIS-8: the bulk import of weekly reports (ST-DIS-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F1, `report_import_batch`). Migration: `V1047__dis1_report_import.sql`. Screen DIS-10 (`/dis/dis-10`, `?import=<id>` reopens a batch).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `uploadReportImportFile` | `POST /report-imports/files` | `report.import` | Puts the workbook (CSV or XLSX) into the shared upload pipeline: judged by its bytes, scanned, stored private to the tenant; answers its key, hash, columns and number of rows. |
| `createReportImport` | `POST /report-imports` | `report.import` | The dry run: reads the file with the layout named by `mapping_version`, judges every row and keeps the batch with the fault of every row. |
| `getReportImport` | `GET /report-imports/{id}` | `report.import` | The batch: counts, status and every fault (`errors`: line, project code, column, code). A batch is its maker's alone (404 for anyone else): its faults name projects of the scope of that person. |
| `applyReportImport` | `POST /report-imports/{id}/apply` | `report.import` | Applies a batch without error: every row makes a draft, or brings up to date the draft the project has, source IMPORT. |

## The layout (mapping `DIS-WEEKLY-1`)

The only layout until the real workbook is sampled (D04): one row per project, `project_code`, the six cells `cy_central`, `cy_local`, `co_central`, `co_local`, `other_central`, `other_local` (whole dong), the CTMTQG inside the four sources that have it (`cy_central_ctmtqg`, `cy_local_ctmtqg`, `co_central_ctmtqg`, `co_local_ctmtqg`), optionally `total_cumulative_vnd` (it has to be the sum of the six cells), the four volumes with `physical_progress_pct` (all four or none) and `negative_delta_explanation`. A column the layout needs that the file lacks is 422 `IMPORT_SCHEMA_INVALID` naming them; a layout that is not known is 422 `MAPPING_VERSION_UNKNOWN`. A later layout is a new name: an old file is read the way it was. The registration for next month is entered on DIS-05; the report is on the basis YTD.

## The dry run (AC-ST-DIS-008-1, AC-ST-DIS-008-2)

Every row is judged on its own and nothing is skipped without a word: each fault comes with its line, its column and a code. A row can have several; `error_rows` counts rows. In the file: `PROJECT_CODE_REQUIRED`, `PROJECT_DUPLICATE_IN_FILE` (a project named twice is refused in both rows: it is not told which one is meant), `AMOUNT_INVALID`, `SUBSET_EXCEEDS_PARENT`, `TOTAL_MISMATCH`, `VOLUMES_INVALID`, `EXPLANATION_INVALID`. Against the register: `PROJECT_NOT_FOUND` (a project the caller may not import for is indistinguishable from one that does not exist), `PROJECT_STAGE_INVALID`, `PLAN_VERSION_NOT_EFFECTIVE`, `PERIOD_LOCKED` (for a project no approved reopening names), `REPORT_STATE_INVALID` (a report that was handed in, or a draft that was deleted, is in the period). The totals of a batch are of the rows that are in order: a row with a fault is never in `valid_rows`.

A batch is VALIDATED when no row has a fault and DRY_RUN when some have; only VALIDATED is applied. A file already applied to the period is 409 `IMPORT_FILE_ALREADY_APPLIED` at the dry run too. The file is the source of truth: the dry run and the apply read it from the object store and check its hash again (422 `VALIDATION_FAILED` naming `file_sha256` for other bytes).

## The apply

One transaction, with the period held (a shared lock) against a close or a lock until it ends. The batch is locked under the version the screen showed (409 `VERSION_CONFLICT`); the batches of the same file for the same period take turns (an advisory lock), so two applies at once give one APPLIED and one 409 `IMPORT_FILE_ALREADY_APPLIED`; a batch that still has errors is 422 `IMPORT_HAS_ERRORS`. Every row is judged again against the register as it is then: a project reported on, or a period locked, since the dry run is told before anything is written (422 `IMPORT_HAS_ERRORS`, 409 `PERIOD_LOCKED`). Then each row makes the draft of its project with `source_kind` IMPORT and `import_batch_id`, or brings up to date the live draft the project has (the cells, the volumes and the explanation of the file, on the basis of the layout, the year to date; the registration for next month and the year of the source of each cell, the narrative and the files stay), and the batch becomes APPLIED with who, when, and how many drafts were made and brought up to date. Nothing is handed in. The table (`report_import_batch_guard`) fixes what a batch is, never changes an applied batch, deletes none and keeps the graph (`DRY_RUN`/`VALIDATED` to `APPLIED`, `FAILED` or `CANCELLED`); `report_import_applied_uq` (V002) is applied once for a period and a file.

The audit rows are `dis.report_import_file_uploaded`, `dis.report_import_validated`, one row for each draft (`dis.report_created` or `dis.report_import_updated`) and `dis.report_import_applied`; the event is `report.import_applied.v1`.

## The screen

DIS-10: the year and the period, the layout (one, fixed), the file (the number of rows and columns it has is shown when it is stored), and "Chạy thử". The result has the counts, the sentence of the status, "Áp dụng tệp" (disabled while there is a fault) and the table of the faults with a filter by kind and by project code. DIS-01 leads to it for a person who holds `report.import`.

## Assumptions

- The layout is the synthetic template (the design says the column mapping awaits the sample data of D04).
- A file is limited by the tabular reader of the kernel (5,000 rows, 25 MB); one file is judged and applied in one transaction.
- The file import framework of the kernel (`docs/file-import.md`) is not used: its unit is a business key claimed for ever across files, and a weekly report is claimed by its project and period (one live draft, the table says so); the batch table of the design is the record here.
