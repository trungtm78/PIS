# BI exports and per-recipient schedules (ST-BI-008)

BI 3 F7: a file of the figures of a metric over a frozen version of the data, made for the scope a person has now; a schedule makes one such file for each recipient under that recipient's own scope. The right is judged when the export is asked for, again when it runs, and again when the link to the file is given.

## An export

`POST /bi/exports` (`requestBiExport`, `bi.export`) with `query_spec` (`metric_version_id`, at most one of `dimensions`, `filters`), `as_of_period`, an optional `snapshot_id` (a version of the dataset of that period) and `format` (`CSV`, `XLSX`, `PDF`). Anything else in the spec is 422 naming the field. The version read is the one named, or the latest frozen version of the period.

The job is made first, for the person and under their scope hash, and then judged: the person holds `bi.export` and the right to query over some scope now (else a DENIED job, `SCOPE_DENIED`); an access policy opens the dataset to them (`ACCESS_POLICY_MISSING`); the dataset is not `CONFIDENTIAL` or `PERSONAL` (`CLASSIFICATION_EXPORT_DENIED`, see TODOS: no policy says an export is allowed yet); the dimension is one they may read; the answer is read in full up to the cap of the format, **100,000 rows** for CSV and XLSX and 5,000 for PDF, and a larger one is DENIED (`EXPORT_ROW_CAP_EXCEEDED`, 422), never cut (`truncated` stays false). A refusal that is a record keeps its job (DENIED with `denied_reason`, no file) with the audit `bi.export_denied` and the event `bi.export.denied.v1`, and answers with the refusal. A bad request (an unknown field, a metric that is not certified, a period with no frozen version) is 422 and keeps nothing.

The file has a header (the metric by its revision and unit, the scope as the person was given it, the period, the snapshot, the dimension, when), the groups of the answer and the total; a group with no figure is empty with its reason, never zero; a cell that begins like a formula is quoted. It is stored as a file the platform made (`bi_export`), with its SHA-256 and `expires_at` seven days on; the job is READY. Audit `bi.export_request` (confidential), events `bi.export.requested.v1` and `bi.export.ready.v1`.

`GET /bi/exports` lists the jobs made for the caller; `GET /bi/exports/{id}` (`getBiExport`) reads one: a job of another tenant is 404, one of the tenant that is not the caller's is 403 `SCOPE_DENIED`, one whose days are over is 422 `EXPORT_EXPIRED`. For a READY job the person is judged again: they still hold both rights and the scope they have now is the scope the file was made under (same scope hash), else 403 `SCOPE_DENIED` and no link, so a person whose scope changed (narrowed or widened) is not handed a file cut under another scope. The link (`download.url`) is signed and lives five minutes; `GET /bi/exports/{id}/file?tenant&expires&signature` serves the bytes while the signature holds (401 `SIGNATURE_INVALID` otherwise).

## A schedule

`POST /bi/export-schedules` (`createBiExportSchedule`, `bi.export.schedule`) with `query_spec`, a five-field `cron` (409 `CRON_INVALID` naming the field), a `format` (`CSV`, `XLSX`, `PDF`, `LINK_ONLY`) and 1 to 500 `recipients` (members of the tenant that are active, 422 `RECIPIENT_OUT_OF_TENANT`), an optional `dashboard_id` the owner sees. The metric must be certified now. The time zone is `Asia/Ho_Chi_Minh`. `GET /bi/export-schedules` lists the caller's.

A schedule asks for the revision of the metric it was made with, as a dashboard does: a newer revision that replaced it does not stop it, a metric that was withdrawn does (its jobs are FAILED with `METRIC_NOT_CERTIFIED`). The filters of a spec are judged as the query judges them when the schedule or the export is made (an id, a list that is not empty, no order over ids), so a schedule that could never run is not kept.

The job `bi-export-schedule-runner` (every minute) makes, for a schedule whose next time after its last run has come, one job for each recipient, under that recipient's access as it is then (`loadAccessIn`): a recipient who lost the right (or is no longer active) gets a DENIED job and no file; an export that fails after the job was made ends as FAILED and the others are still made; a schedule with nothing to read (no frozen version) is skipped and told on the audit trail. `LINK_ONLY` makes the same CSV and says in the event (`link_only`) that the file is delivered behind the sign-in, where the right is judged again. The run is written on the schedule (`last_run_at`), so the same moment makes nothing twice. The files of a run are noted across its whole transaction: if anything after a file was stored undoes the transaction (a later recipient, the mark of the run, the commit), the files go too; the interactive export does the same through `afterRollback`. The job `bi-export-expiry` (hourly) removes the file whose seven days are over and makes its job EXPIRED, a batch of 200 at a time until none is left. Events `bi.export.ready.v1` and `bi.export.denied.v1` carry the recipient, for the notification module; metrics `bi_export_ready_total` and `bi_export_denied_total`.

## In the database (V1585)

`bi_export_job`: who it is for, what it asks, the scope and the format never change; it moves forward only (QUEUED, RUNNING, READY or DENIED or FAILED; READY to EXPIRED); the file, its digest, the expiry and how it ended are written once; a READY job has an expiry, a DENIED or FAILED one has no file and a DENIED one has a reason; rows never exceed the cap. `bi_export_schedule`: what it asks, its cron, recipients (one to 500) and owner never change, `last_run_at` only moves forward, RETIRED is final. Nothing is deleted. `denied_reason` and `last_run_at` are the two columns V002 did not have.

## Screens

- **BI-16** `ExportsScreen`: the exports made for the person (period and snapshot, dimension, scope, format, rows against the cap, state, expiry, the reason of a refusal), a button that gets the link at the moment of the download and shows it with when it ends, and the form to ask for an export (certified metric, a frozen period, a dimension or one figure, a format).
- **BI-12** `ExportSchedulesScreen`: the schedules (metric, cron and zone, format, recipients, last run, state), the note that every recipient has their own scope, and the form to make one (metric, dimension, cron, format, recipients by member id).

## What is not done

- There is no command to pause, change or retire a schedule, or to withdraw a job; the states are in the table and the guard.
- `CONFIDENTIAL` and `PERSONAL` datasets are not exported at all: the module document says "only where a policy allows it", and an access policy has no such attribute yet.
- The delivery is the event: the notification module that sends the file or the link to the recipient is not part of this story.
- The recipients are given by member id (no directory to pick from); the dimension labels in the header are fixed in Vietnamese.
