# Treasury statement import (ST-PAY-006, PAY 3.3, NFR-OPERABILITY-06)

PAY takes a statement file of the State Treasury through the idempotent file-import core of ST-KERNEL-070 (`docs/file-import.md`), with a concrete adapter.
The adapter is **PROPOSED** and the Treasury API is **MISSING**: the real layout of the statement is unknown until the agency gives anonymised samples
(R-PAY-04), so the layout below is a working assumption, kept as configuration and marked in every import by its version `ASSUMED-2026.1`. The platform never
calls this format verified on its own authority.

## What is where

| Piece | File | Pure |
| --- | --- | --- |
| Layout: headers (column map), judgement of a row, masks, business key | `packages/db/src/pay-treasury-statement-format.ts` (`createTreasuryStatementFormat`) | yes |
| Adapter: project and Treasury-office checks, write of the transaction | `packages/db/src/pay-treasury-statement-adapter.ts` | no |
| Import: runs the core, writes the PAY header and one line per row, mirrors conflicts, opens items for gaps in master data, totals | `packages/db/src/pay-treasury-import-store.ts` | no |
| Transactions: reads, confirmation by hand, callback | `packages/db/src/pay-treasury-transaction-store.ts`, `pay-treasury-callback.ts` | no |
| Commands and reads | `apps/api/src/modules/pay/` | |
| Screen PAY-13 | `apps/web/src/screens/pay/` | |
| Migration | `db/migrations/V1560__pay1_treasury_statement_import.sql` | |

The tables are those of V002 (`treasury_import`, `treasury_import_row`, `treasury_transaction`, `reconciliation_item`) with the additions of V1560.
`treasury_import.id` is the id of the `file_import` row of the core that claimed the file: the core owns the identity of the file, PAY keeps its own view.

## The working-assumption layout (version `ASSUMED-2026.1`)

A CSV (comma, semicolon or tab) or XLSX file with a header row. A header is compared without accents, case and punctuation (`Số chứng từ` is `so_chung_tu`), and
the column map is configuration (`DEFAULT_TREASURY_COLUMNS`; `createTreasuryStatementFormat({ columns })`): a different layout is another map, not new code.

| Field | Headers (default) | Required | Rule |
| --- | --- | --- | --- |
| `document_no` | `document_no`, `so_chung_tu` | yes | 1 to 100 characters, no control character, no `\|` |
| `document_date` | `document_date`, `ngay_chung_tu` | yes | `YYYY-MM-DD` or `DD/MM/YYYY`, a real calendar day |
| `project_code` | `project_code`, `ma_du_an` | yes | the `code` of a project of the tenant |
| `treasury_office_code` | `treasury_office_code`, `ma_kbnn` | yes | translated by the crosswalk `TREASURY` / `AGENCY_CODE` (see below) |
| `amount_vnd` | `amount_vnd`, `so_tien` | yes | whole VND, positive, at most 24 digits: plain digits or groups of three (`1.250.000`, `1,250,000`, `1 250 000`); never a fraction |
| `confirmed_at` | `confirmed_at`, `ngay_hach_toan` | yes | the booking time (the date that counts as disbursed, CV 16437/BTC-DTPT, CXN-03): a date is the start of that day in Vietnam, a time without an offset is Vietnam time |
| `direction` | `direction`, `loai_giao_dich` | no | `PAYMENT` (default); a `REFUND` row is quarantined (`REFUND_UNSUPPORTED`): a refund names the payment it undoes, which this layout cannot say |
| `payee_account` | `payee_account`, `so_tai_khoan` | no | never stored: a refused row shows it as `***` and its last three digits |

A file without a required column, with two columns that mean one field, that is not a table, or has no row is refused as a whole (422
`TREASURY_IMPORT_SCHEMA_INVALID`). The business key of a row is `KBNN_FILE|<document_no>|<document_date>|<project_code>`; the hash of a row is taken over the
normalised fields, so `1.250.000` and `1250000`, or `15/10/2026` and `2026-10-15`, are the same content.

## What happens to a file and its rows

1. The file (picked on PAY-13, uploaded first) is read from the object store of the tenant (`tenants/<tenant>/import/<file_object_id>`, scanned, CLEAN) and its SHA-256 must be the one the caller gives
   (422 `HASH_MISMATCH` before anything is written).
2. The core claims the file by `(tenant, connector, sha256)`. A file taken before answers `ALREADY_IMPORTED` with the first import and writes nothing; of two calls
   at once exactly one is applied (the connector position is locked, and the unique index of the claim is the last word). The connector position
   `integration_cursor TREASURY_STATEMENT_FILE` (ST-MDM-007) keeps the last file and its time; a paused or failed connector refuses the import (409
   `STAGE_TRANSITION_DENIED`) until the reset of MDM-24.
3. Every row is judged. A row that is refused goes to the quarantine with its line, field and code; the key of a refused row is not claimed, so a corrected file can
   take it. A row whose business key was applied before is skipped when its hash is the same (`DUPLICATE`) and, when it differs, leaves the first transaction as it is and
   opens `DUPLICATE_CONFLICT` (`CONFLICT`). A new row creates a `treasury_transaction` (source `FILE_IMPORT`, `UNMATCHED`).
4. Codes: the project must exist (`PROJECT_NOT_FOUND`); the Treasury office code must have an ACTIVE mapping `TREASURY` / `AGENCY_CODE` in force on the date of the voucher
   to an entry of kind `TREASURY_OFFICE` (`CROSSWALK_MISSING`, `CROSSWALK_TARGET_INVALID`). **A code without a mapping is a quarantine outcome and never creates a master entry.**
   Because the file identity is its bytes, a quarantined row is taken by importing a corrected file (for example only those rows) after the mapping exists.
5. Owners: a row refused for a gap in master data (the three codes above) opens an item with an owner and a due time (the importer, three days), so someone owns the gap;
   a conflict opens the item of the core and the same item in the PAY register `reconciliation_item` (kind `DUPLICATE_CONFLICT`, the transaction, the line of the file,
   both amounts, the signed difference). One open item per transaction and kind: a second file that contradicts the same transaction joins it.
6. The result: `treasury_import` (status `APPLIED`, or `PARTIALLY_APPLIED` when a row was quarantined or in conflict) and `treasury_import_row` (one per line: `NEW`, `DUPLICATE`,
   `CONFLICT`, `ERROR`, with the masked row). The certified total (`totals`) counts every business key once: a repeated file, a repeated or conflicting row and a quarantined row
   never move it (AC-ST-PAY-006-4).

All of it happens in the transaction of the command: a defect leaves nothing and the same file can be tried again. Nothing of a file that could not be read is kept (the
core's FAILED try is rolled back with the 422), so the connector is not stopped by a wrong upload.

## Commands and reads

| Operation | Rule |
| --- | --- |
| `uploadTreasuryStatementFile` (`treasury.import`) | whole tenant only. The file is judged by its bytes (CSV or XLSX, at most 10 MiB), read as a table, checked against the headers of the layout (`layout_ok`, and `missing_columns` in the words of the database) before anything is imported, scanned and stored under `tenants/<tenant>/import/<file_object_id>`. Nothing is imported by the upload. Audit `pay.treasury_file_uploaded`. |
| `listTreasuryImports` (`treasury.import.read`) | the imports of the tenant, newest first, the header of each without its lines; empty for a caller whose read is not on the whole tenant. |
| `importTreasuryStatement` (`treasury.import`) | whole tenant only (a file covers every project and consumes its identity once, so a narrower grant could shadow it for a wider one): 403 `SCOPE_DENIED` otherwise. Audit `pay.treasury_import_applied` or `pay.treasury_import_repeated`; event `pay.treasury_import.applied.v1` (not for a repeat). |
| `getTreasuryImport` (`treasury.import.read`) | whole tenant only, 404 otherwise; the header, the counts of the whole file, the adapter (`file_status` PROPOSED, `api_status` MISSING, layout version, connector state), the certified total, at most 500 lines with their masked rows, and the differences with owner and due time. |
| `confirmTreasuryManually` (`treasury.confirm_manual`) | the payment request must be `SENT_TREASURY` and in the scope of the caller (404 otherwise); the confirmer is not the person who drafted or sent it (403 `SELF_APPROVAL_DENIED`); the evidence must be a CLEAN document version; one live confirmation per request. An amount that is the net waits for the match (`UNMATCHED`); another amount is recorded in `EXCEPTION` and opens an `AMOUNT_MISMATCH` item with both figures and an owner: the larger figure is never chosen. The request does not move (settling it is `matchTreasuryTransaction`, ST-PAY-007). The answer is 200 with status `EXCEPTION`: an effect that must stay cannot ride on a 422 of the same transaction. |
| `receiveTreasuryCallback` (`treasury.callback.receive`) | adapter MOCK, API MISSING. Whole tenant (service principal). The signature is HMAC-SHA256 (hex) over the JSON array of the eight fields in the order of the contract; the keys come from the vault reference `secret://pay/treasury/<provider>` (environment `MACHVON_SECRET_PAY_TREASURY_<PROVIDER>` until the vault exists), so without keys every event is 401 `SIGNATURE_INVALID`. The event is written once to the integration inbox (provider, event id) and the transaction once (provider and business key): the same event, or the same voucher under another event id with the same content, answers the first result; the same voucher with other content, or an event id reused for other content, is 409 `TREASURY_TRANSACTION_DUPLICATE`. A refund and the providers `KBNN_FILE` and `MANUAL` are refused (422). |
| `get_resources_treasury_transaction` and `_id` (`treasury_transaction.read`) | the transactions of the projects in the scope of the caller, an allowlist (no deduplication key, hash or evidence); a project outside the scope is not found. |

## Governance in the database (V1560)

A transaction keeps what it says (a trigger refuses any change but the match status and the links of the match; a matched transaction is fixed); the runtime role cannot delete or
truncate the four tables and cannot update an import or its lines; one transaction per provider event; the source of a transaction must fit its kind; an open item is unique per
transaction and kind; the key from a transaction to its import is checked when the transaction ends (the file rows are written before the header).

## Observability

Counter `pay_treasury_import_rows{outcome}` (`NEW`, `DUPLICATE`, `CONFLICT`, `ERROR`) through the `PAY_METRICS` sink, and the counters of the core (`file_import_*`, `webhook_signature_failures_total`).
Nothing logs an account number or a name: a refused row keeps only the masked fields.
