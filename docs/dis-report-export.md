# The export of a frozen snapshot (ST-DIS-016)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F9, FR-DIS-17). No migration. Operations: `createReportExport` (`POST /report-exports`, permission `report.export`) and `getReportExportDownload` (`GET /report-exports/{id}/download`, same permission). Screen: DIS-17.

## What it does

**Making the file.** The caller names a snapshot, a format (`CSV`, `XLSX`, `PDF`), optionally the columns and the unit (`VND` or `MILLION_VND`). The snapshot must be `FROZEN` (422 `SNAPSHOT_NOT_FROZEN`; a superseded or only built snapshot is refused, export the newer one). The file holds the lines of the snapshot for the projects in the caller's scope *as it is now*; a caller who sees none of them gets 403 `SCOPE_DENIED`. The caps are 200 000 lines for CSV and XLSX, 5 000 for a PDF and 20 000 projects (422 `EXPORT_ROW_CAP_EXCEEDED`). The file is written to the object store of the tenant (purpose `report_export`), must be CLEAN, and the audit row `dis.report_exported` is its only record (the snapshot, format, rows, projects, columns, unit, definition status, size and SHA-256).

**The header.** Every format states: scope (the units of the lines), period, snapshot id, snapshot kind, the day of the figures, the Treasury cutoff, `currency_unit`, time of the file, `definition_status` and the number of lines. While the definitions are `PROPOSED_PENDING_SIGNOFF` the file also carries a notice that they await the D03 sign-off (CXN-03): the last line of a CSV or a sheet, and the footer of **every page** of a PDF. A figure the Treasury did not book is empty, never 0; million dong is written exactly (six decimals, no float). A text cell that begins with `= + - @` is written with a quote in front.

**The download.** `getReportExportDownload` is asked for each time: the file belongs to the person who made it (another person, or another tenant, finds no such export, 404); it judges the permission and the scope again, and if the caller no longer sees every project the file names it answers 403 `SCOPE_DENIED`, writes a DENIED audit row and issues no link (NFR-TENANCY-06). Otherwise it issues a signed link (`GET /report-exports/{id}/file?tenant&expires&signature`, public, five minutes) that serves the bytes with the type and the file name; a forged, altered, expired or foreign link all answer 401 `SIGNATURE_INVALID`. The audit row `dis.report_export_download` records the issue.

## Assumptions

- The first release exports the neutral layout; the official layout of TT 37/2025 through DOC belongs to the R2 export story.
- The link lives five minutes (the kernel caps a presigned link at `MAX_PRESIGN_TTL_SECONDS`), not the 15 of the design: a new link is asked for each time and the permission is judged each time, so the shorter life costs a click and not a right. The 200 000 line cap is an assumption of the design.
- The file is the property of its maker: a colleague with the same permission makes their own file. Sharing a file is a later story.
- The scope check at download compares the *set of projects* named in the audit record with the projects the caller sees now; a caller whose scope was replaced by a wider one still downloads. The file is not narrowed to the new scope.
- The screen needs `disbursement.read` besides `report.export` (the snapshots to choose from are listed under it); without it the screen says which permission is missing. The signed link is refused with 401 whatever is wrong with it, a tenant that is not an id included.
- The PDF is for reading (columns cut with an ellipsis, five thousand lines); the CSV or the workbook is for working with the figures. The workbook keeps money as text because a whole dong has up to 24 digits and a spreadsheet number keeps 15.
