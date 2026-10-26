# DIS-3: the weekly report draft and the six-cell funding matrix (ST-DIS-003)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F2, BR-DIS-01 to BR-DIS-04). Migration: `V1042__dis1_report_draft.sql`. Screens DIS-01 (`/dis/dis-01`, the reports), DIS-02 (`/dis/dis-02`, choose the period and the project), DIS-04 (`/dis/dis-04?report=<id>`, enter the disbursement by source) and DIS-18 (`/dis/dis-18?report=<id>`, draft saved).

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `post_reports` | `POST /reports` | `report.create` over the scope of the project | Starts the DRAFT of a project for a period: finds the plan in force at the end of the period, captures it, writes the six cells at nothing and the audit row. |
| `post_reports_id_revisions` | `POST /reports/{id}/revisions` (If-Match) | `report.edit` over the scope of the project | Saves the six cells (cumulative, the CTMTQG subset and the registered amount of next month), the basis of the measurement and, when a cell fell, the explanation. |
| `getReportRevision` | `GET /reports/{id}` | `report.read` | The report with its project, period, plan, cells (with what the plan allocated and what the period before had reached) and totals. |
| `get_resources_report_revision` | `GET /resources/report_revision` | `report_revision.read` | The list of DIS-01, newest first, with `summary` (the figures of the filter and the figures of everything the caller sees). |
| `get_resources_report_revision_id` | `GET /resources/report_revision/{id}` | `report_revision.read` | The same detail as `getReportRevision`. |

## The six cells (AC-ST-DIS-003-1, BR-DIS-01, FX-DIS-001)

The cells are the buckets CURRENT_YEAR, CARRYOVER and OTHER of the paper form, each at the CENTRAL and LOCAL level of the budget. `fundingCells` (`packages/kernel/src/dis-report.ts`) refuses a cell that is not a whole number of dong, a CTMTQG subset greater than its cell (422 `SUBSET_EXCEEDS_PARENT`, named by the member) and a CTMTQG in a cell of the OTHER bucket. `fundingTotals` adds the six cells and keeps the CTMTQG apart: FX-DIS-001 (100, 200, 30, 70, 0 and 20 million, 40 million of the first as CTMTQG) is 420,000,000, not 460,000,000, and the CTMTQG is 40,000,000. Money is dong as decimal text everywhere; the screen types it with dots and sends it without.

## The draft

- A project has one live DRAFT per period (`report_revision_draft_uq`): another is 409 `DRAFT_EXISTS` with the report, its revision and its status in the extensions (the screen leads to it); a period that already has a report that is no longer a draft is 409 `REPORT_STATE_INVALID`. The same `client_operation_id` with other content is 409 `IDEMPOTENCY_CONFLICT`; with the same content it answers the first report again and is audited as `dis.report_replayed`.
- `plan_version_id` is optional: the server finds the plan version in force at the end of the period. One that is named and is not that one is 422 `PLAN_VERSION_NOT_EFFECTIVE` with `effective_plan_version_id`.
- The stage of the project must report (`assertReportableStage`, 422 `PROJECT_STAGE_INVALID`). The report type must match the period (WEEKLY with a WEEK). A period that is not OPEN is refused as `DisPeriodStore.judge` says (409 `PERIOD_LOCKED`, lifted for the projects of an approved reopening, ST-DIS-002).
- The members of the later stories (`construction_vnd`, `acceptance_vnd`, `treasury_submitted_vnd`, `preparing_dossier_vnd`, `physical_progress_pct`, `narrative`) are refused 422 until ST-DIS-004; `measurement_basis` (PERIOD, YTD or PROJECT_TO_DATE) is kept on the report revision and ST-DIS-004 copies it to the progress snapshot.
- When a cell is below what the period before had reached, the report says so (`delta_vnd` negative) and a saved report needs the explanation of 10 to 2000 characters (`negative_delta_explanation`, BR-DIS-03).
- The trigger `report_revision_guard` fixes the identity of a report, never deletes it and freezes its content once it is no longer a DRAFT; `funding_snapshot_line_guard` lets the cells change only while the report is a live DRAFT and never changes what the plan allocated, the bucket or the level.
- Audit rows: `dis.report_created`, `dis.report_saved`, `dis.report_replayed`.

## The screens

DIS-01 lists the reports with the project, the period, the status, the cumulative and the CTMTQG apart, filters by year, week, annual plan (`plan_id`, the capital plan) and project, goes from page to page by the cursor, and gives two sets of figures: the total of the table and, once the table is filtered, the total of everything the caller sees (SRC-01/02). The button that starts a report is only for a person who holds `report.create` in a tenant that is not read only. DIS-02 asks for the year, the week and the project and tells a locked week with a way to the request to reopen it (DIS-22). DIS-04 shows the six cells with what the plan allocated, what the period before had reached, the change (a fall in a warning tone with the note and the box for the explanation) and the totals as they are typed; a refusal of the server that names a cell marks that cell. DIS-18 gives the code of the draft (`<project>/<period>/r<revision>`), the totals and the next steps, with the focus on the heading and a link back to the list.

## Tests

`packages/kernel/test/dis-report.test.ts`, `packages/db/test/dis-report-store.test.ts` (the triggers, the draft per period, the keyset, the scope), `apps/api/test/dis/report.test.ts` (HTTP, audit, replay, refusals), the authz matrix and the isolation suite, `apps/web/src/screens/dis/report/*.test.ts(x)` and `apps/web/e2e/dis-report-flows.spec.ts` (the maker draws the draft, enters FX-DIS-001, is refused a CTMTQG of 120 million against a cell of 100 million, saves; a second draft is refused with a way to the first; a reader sees and cannot change it).
