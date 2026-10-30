# The export of the records of the contractors for the national database (ST-CTR-015, CTR 3.6, CTR-24, CXN-EXE-01)

A legal owner exports the approved evaluations and the confirmed violations of a period as one file, whose SHA-256 names the batch, and writes down by hand the receipt number of the submission. There is no interface to the national system: the adapter is **PROPOSED** and its API **MISSING** (CXN-EXE-01), and the screen says so.

## The file

`exportContractorRecords` `POST /contractor-exports` (`contractor.export`): `scope` (`PERFORMANCE`, `VIOLATION`, `BOTH`), `period_from`, `period_to` (real days, the start not after the end, at most five years: 422 on `period_to`), `format` (`CSV`, `JSON`).

- The rows are the **approved evaluations that stand** (not the superseded ones), by the day they were approved, and the **confirmed violations**, by the day they were confirmed (Vietnam calendar), of the contracts the caller holds `contractor.export` over. Records that are not decided (a submitted evaluation, a recorded violation) are never in it.
- The columns are one list in the kernel (`CONTRACTOR_EXPORT_COLUMNS`): the format of the national database is pending (CXN-EXE-01), so the map of columns is the one place to change. A cell that does not apply to a kind of record is empty; the JSON carries only the columns that apply.
- The same records give the same bytes: the rows are in a fixed order, nothing in the file says when it was made, a CSV is UTF-8 with a byte-order mark and CRLF lines, and a text cell that begins like a formula is quoted. **The hash of the file is the key of the batch** (`contractor_export_file_uq`: scope, period, hash): asking again for the same records returns the same batch and makes no second file or event (UAT-AC315). Two people asking at once make one batch.
- A period with nothing in the caller's scope is 422 `EXPORT_EMPTY`; one with more than 20,000 rows of a kind is 422 `EXPORT_ROW_CAP_EXCEEDED`.
- The file is stored for the tenant (kind `contractor_export`, key by the id of the batch) and is clean as soon as it is stored. The trail (`ctr.contractor_export.generated`, `repeated` says whether it was a repeat) and the event (`ctr.contractor_export.generated.v1`, only for a new batch) carry the scope, the period, the rows and the hash, never a name or a tax number; those are in the file, which is `CONFIDENTIAL`.

## The receipt

`markContractorExportSubmitted` `POST /contractor-exports/{id}/mark-submitted`: a receipt number (1 to 100 characters) and the day of the submission (not after today). Only a `GENERATED` batch is submitted, once (409 `EXPORT_STATE_INVALID`); the receipt, the day, who wrote it and when never change (a trigger). The status moves `GENERATED` to `SUBMITTED_EXTERNALLY`; `CONFIRMED` and `FAILED` are not used yet (no confirmation comes back from the national system).

## The reads

`listContractorExports` `GET /contractor-exports` and `getContractorExportDownload` `GET /contractor-exports/{id}/download` (a signed link valid five minutes; the file itself is served by `contractor-exports/{id}/file`, public, for a good signature only). **A file holds what the person who asked for it was allowed to read**, so a batch is listed, handed out and marked as submitted only for the people who asked for its file (`contractor_export_access`, one row each, written by every call of `exportContractorRecords`, a repeat included: the same records are the same file whoever asks) and for whoever holds `contractor.export` on the whole tenant; any other caller gets 404, also for the receipt. The page is cut by a cursor (the newest first) and carries the state of the adapter.

## The table (V1393)

`contractor_export_batch` gains `version`, `submitted_by`, `submitted_at`; a batch never changes what it is (scope, period, format, hash, key, rows, maker) and is never deleted; a batch that was submitted has its receipt, day, person and time, and one that was not has none. `contractor_export_access` lists who may read a batch.

## The screen

**CTR-24** `ContractorExportScreen` (`/ctr/ctr-24`): the notice of the adapter, the form (what, period, format; the same checks as the server), the batches (a page at a time) with the period, the rows, the hash, the state and the receipt, the link to download and the dialog of the receipt. No form or receipt while the tenant is read-only.
