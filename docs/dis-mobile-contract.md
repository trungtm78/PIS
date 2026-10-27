<!-- GENERATED from packages/contracts/src/dis-sync.ts and openapi.json (ST-DIS-017). Do not edit: change the source and run the generator; a test fails when this file is out of date. -->
# Contract pack of the weekly report for the mobile group (MOB-13..21)

Status: PROPOSED. The offline architecture (PowerSync, the Flutter queue) waits for the spikes of ST-KERNEL-002 and the mobile group; what is fixed here is the server side: the commands, the headers, the errors and the rows that sync.

## Commands

| operationId | Method and path | Permission | Offline | Errors | Rule |
|---|---|---|---|---|---|
| `post_reports` | `POST /reports` | `report.create` | queued | `PERIOD_LOCKED`, `PLAN_VERSION_NOT_EFFECTIVE`, `PROJECT_STAGE_INVALID`, `SCOPE_DENIED`, `DRAFT_EXISTS`, `FILE_NOT_CLEAN`, `SCAN_PENDING`, `HASH_MISMATCH` | Starts the draft. Carries `client_operation_id` (the local id): the same entries sent again are the same report, other entries under it are 409 IDEMPOTENCY_CONFLICT. |
| `post_reports_id_revisions` | `POST /reports/{id}/revisions` | `report.edit` | queued | `REVISION_IMMUTABLE`, `VERSION_CONFLICT`, `PERIOD_LOCKED`, `SUBSET_EXCEEDS_PARENT`, `FILE_NOT_CLEAN`, `SCAN_PENDING`, `HASH_MISMATCH` | Saves a step of the draft under `If-Match` (the version the phone read). A stale version is 409 VERSION_CONFLICT: the phone reads the report again and puts the figures to the user, it never overwrites money. |
| `uploadReportFile` | `POST /report-files` | `report.edit` | queued | `FILE_TYPE_NOT_ALLOWED`, `FILE_NOT_CLEAN`, `PAYLOAD_TOO_LARGE`, `SCAN_PENDING` | The file goes up when the phone is online; the draft links it after the scan is clean. |
| `post_reports_id_submit` | `POST /reports/{id}/submit` | `report.submit` | queued | `PERIOD_LOCKED`, `SUBSET_EXCEEDS_PARENT`, `NEGATIVE_DELTA_EXPLANATION_REQUIRED`, `CORRECTION_REASON_REQUIRED`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `VALIDATION_FAILED`, `REVISION_IMMUTABLE`, `PLAN_VERSION_NOT_EFFECTIVE` | Hands the draft in (the version of the last save). Whether the report is late is judged by the server at the time it arrives, not by the clock of the phone. |
| `deleteDraftReport` | `POST /reports/{id}/draft-deletion` | `report.edit` | queued | `REPORT_NOT_EDITABLE`, `VALIDATION_FAILED`, `VERSION_CONFLICT` | Deletes a draft softly, with a reason. |
| `restoreDraftReport` | `POST /reports/{id}/draft-restore` | `report.edit` | online only | `RESTORE_WINDOW_EXPIRED`, `REPORT_STATE_INVALID`, `SCOPE_DENIED`, `VERSION_CONFLICT`, `DRAFT_EXISTS` | The list of deleted drafts is on the server. |
| `withdrawReport` | `POST /reports/{id}/withdrawal` | `report.withdraw` | online only | `REPORT_STATE_INVALID`, `PERIOD_LOCKED`, `VALIDATION_FAILED`, `VERSION_CONFLICT` | A report that was handed in is withdrawn only while the server says nobody is reviewing it. |
| `post_reports_id_corrections` | `POST /reports/{id}/corrections` | `report.correct` | online only | `CORRECTION_REASON_REQUIRED`, `PERIOD_LOCKED`, `PLAN_VERSION_NOT_EFFECTIVE`, `REPORT_STATE_INVALID`, `REVISION_PENDING_EXISTS`, `VERSION_CONFLICT` | A correction starts from the report the server accepted. |

Every command is sent with `Idempotency-Key` (at least 16 characters; the local id), and a change of a versioned draft with `If-Match` (the version the phone read, as a strong ETag). The body of a draft is the DTO `ReportDraft` of the OpenAPI document, the same for the web and the phone.

## Rows that sync

Only these tables and columns go to the phone. Money columns are read only on the phone. The lines of the snapshots (`period_snapshot_line`), the amounts of the investment of a project and the personal data of households do not sync.

- `project`: `id`, `tenant_id`, `code`, `name`, `status`, `owner_unit_id`, `investor_unit_id`, `version`
- `reporting_period`: `id`, `tenant_id`, `code`, `period_type`, `start_date`, `end_date`, `deadline_at`, `status`
- `report_revision`: `id`, `tenant_id`, `project_id`, `period_id`, `plan_version_id`, `revision`, `status`, `is_current`, `version`, `report_type`, `measurement_basis`, `is_late`, `submitted_at`, `created_by`
- `funding_snapshot_line`: `id`, `tenant_id`, `report_revision_id`, `bucket`, `budget_level`, `disbursed_cumulative_vnd` (read only), `ctmtqg_subset_vnd` (read only), `next_month_registered_vnd` (read only), `next_month_ctmtqg_subset_vnd` (read only)
- `progress_snapshot`: `id`, `tenant_id`, `report_revision_id`, `measurement_basis`, `construction_value_vnd` (read only), `acceptance_value_vnd` (read only), `treasury_submitted_value_vnd` (read only), `preparing_dossier_value_vnd` (read only)
- `report_narrative`: `id`, `tenant_id`, `report_revision_id`, `results_text`, `causes_text`, `solutions_text`, `proposals_text`

## Buckets

- `dis_projects`: The projects the member reports on: the rows named by their scope, in their tenant.
- `dis_periods`: The reporting periods that take a report (open or soft-closed), for a member who has a scope in the tenant.
- `dis_reports`: The reports of the projects in the scope: the member's own drafts and the last revision handed in, with their cells, volumes and narrative.

The queries are in `infra/powersync/sync-rules.reference.yaml`: a reference for what may sync, proven on PostgreSQL, not the deployable file (the PowerSync dialect takes no join and no subquery). To be translated when the spike concludes:

- The scope of a member as a list of projects: `sync_membership_scope` rows of the kind `project`, one for each project the member reaches (a subtree grant is expanded by the projection job of MOB and ADM), so that the unit subtree is not a subquery of the data query.
- The period of a report: the status of the reporting period beside the report in a projection (`OPEN` or `SOFT_CLOSED` as a column), so that the period is not a join.
- The last revision handed in: a column of the projection that marks the revision of a project and period that is the latest not draft (`is_last_handed_in`), so that it is not a `NOT EXISTS`.
- The time of a scope row: the dialect has no clock in a query, so the projection job adds a row at its `effective_from` and ends it at its `effective_until` (the reference checks both ends with `now()`).
- The children of a report (cells, volumes, narrative): the same project and period columns copied to each, or a bucket parameter that lists the report ids, so that they are not joined to the report.

A token carries `sub`, `tenant_id`, `membership_id` and `scope_version`; nothing about permission is taken from a parameter of the client.

## Rules of the queue

- Every queued command carries the id of the tenant it was made under. When the person switches tenant or logs out, a command of the old tenant is never sent under the new one: the switch waits until the queue is sent or the person cancels, and the local database, keys and file cache of the old tenant are removed.
- The `Idempotency-Key` of a command is its local id, and a command sent again with the same key and the same body gets the same answer. A key is kept by the server for seven days.
- Money is shown from the server and written only through the commands above. There is no last-write-wins for money: a conflict (409 VERSION_CONFLICT, 409 IDEMPOTENCY_CONFLICT) is put to the user with both figures.
- The phone judges nothing the server judges: the period, the late mark, the plan version in force and the scope of the person come back with the answer.
- A person whose grant is revoked loses the rows at the next sync (the scope row is ended); a command that was queued before is refused with 403 SCOPE_DENIED or 404 when it is sent.
