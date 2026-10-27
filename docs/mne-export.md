# The export package and the receipt of the filing (ST-MNE-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F3, BR-MNE-05, CXN-05). Migration `V1704__mne1_export_package_workflow.sql` (table `mne_export_package` of V002). Operations: `generateMneExportPackage`, `recordMneSubmissionReceipt` (and `getMneReport`, which now lists the packages). Screen: MNE-06. Job: `mne-package-expiry`. **No call goes to the national system**: the files are filed by hand and the receipt is written down.

## The files

`generateMneExportPackage` (`mne.report.export`, versioned on the report, in the units of the grant) makes one file for each format asked for, for one target (`NATIONAL_PIM_SYSTEM`, `RECIPIENT_AGENCY`, `LGSP`):

- The report must have been **issued by DOC** (`ISSUED`, `EXPORTED` or `SUBMITTED_EXTERNAL`) and not recalled: otherwise 409 `REPORT_NOT_ISSUED` naming the state.
- Formats: `XLSX`, `PDF` and `CSV` are made; **`XML` is 422 `EXPORT_FORMAT_UNSUPPORTED`** (the national specification does not exist yet, CXN-05), and so is a format the form does not list in `export_formats`; a format twice is 422 `VALIDATION_FAILED` naming `formats[i]`.
- The content is the head of the report (form and revision, period, unit, due date, snapshot day, the hash frozen at issue, the document DOC issued), one row per cell of the form (label, value, unit, source), and the **watermark** of a form whose legal basis is not confirmed (the text of the form, or `CHƯA XÁC NHẬN PHÁP LÝ` when it names none; nothing once it is confirmed). Money is written in **million dong** without a float (`1250000.000000`), a rate with its percent unit, a count and a text as they are.
- The bytes are **the same for the same content** (the PDF carries the day of issue, not the day it was made), so the package is told apart by the **hash of the file**: the same content asked for again, with the same key or another, is the same package (`created: false`), unique by (report, target, format, hash).
- A file is put in the object store of the tenant under the purpose `report_export` after the antivirus passed it; its key is `tenants/<tenant>/report_export/<package id>`.
- The package says **how far the way to its target goes**: the adapter status of the integration connector that stands for it (`national_pim_file`, `recipient_agency_file`, `lgsp_file`), `MISSING` when the tenant has none. MNE-06 shows it ("Adapter: PROPOSED - manual filing").
- The first package moves the report `ISSUED` -> `EXPORTED`. Every request leaves the audit row `mne.export_requested` (and `mne.package_generated` for each new file).

## The download

`getMneReport` lists the packages with a **short-lived signed link** (five minutes) for the readers who may export; the others see that the files exist and get no link. The link serves the bytes at `GET /mne-export-packages/<id>/file` and nothing else (a forged, altered, expired or foreign link all answer 401 `SIGNATURE_INVALID`); the first time a file is served its package is `DOWNLOADED`, with the audit row `mne.package_downloaded`. A package whose file is no longer in the store is listed with no link; it does not stop the report from being read.

## The receipt

`recordMneSubmissionReceipt` (`mne.report.export`, versioned on the package) writes down the filing made by hand: `receipt_reference` is required (**422 `RECEIPT_REQUIRED`** when it is missing), `submitted_at` is the moment the person filed (not in the future, 422 `VALIDATION_FAILED`), and `receipt_document_id` is a document that can be used (422 `DECISION_REQUIRED` otherwise). The package is `SUBMISSION_CONFIRMED`, the report is `SUBMITTED_EXTERNAL`, and **`is_late`** is set from the Vietnam day of the filing against the due date of the report (BR-MNE-04). A package that is not offered any more (filed, refused or expired) is 409 `PACKAGE_STATE_INVALID`. The receipt is written once (the table refuses any change of it).

## The table and the job

`mne_export_package` keeps its report, target, format, file, hash and adapter status for good, moves only along `GENERATED` -> `DOWNLOADED` -> `SUBMISSION_CONFIRMED` (or to `REJECTED` or `EXPIRED`; those are final), keeps the receipt it was given, and is never deleted (retention permanent). The job `mne-package-expiry` (hourly) makes a `GENERATED` or `DOWNLOADED` package of more than 90 days `EXPIRED`, once, with the audit row `mne.package_expired`; the report keeps its state and the file is made again from the report.

## Screen MNE-06

Opened from the reports of the year that were issued, exported or filed (`?report=<id>`). It shows the report, the form to make the files (recipient and formats; the XML is not offered), the packages with **the short hash of each file (the whole hash in its title)**, the status, the adapter badge, the download and the receipt, and under each package that can still be filed the form to record it (reference and moment). A refusal is said in words. The seven standard states are the shared ones.

## Assumptions and limits

- The layout of the files follows the cells of the form, not an official specification of the national system (it does not exist yet): it is a proposal with the legal watermark. "Totals recomputed on export" has nothing to recompute here: the cells of a form are the figures of the snapshot as they are.
- The document the receipt may point to (`receipt_document_id`) is not offered by MNE-06; the API takes it.
- The XML is not made and no call is made to any host: the test records every outbound request of the process and finds none.
