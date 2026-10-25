# The file of the national bidding system and the milestones of a package (ST-BID-005)

The procurement planner reconciles the milestones of the packages with the Hệ thống mạng đấu thầu quốc gia by a file they download from it. The platform calls
no API of that system: the adapter is **PROPOSED** (`PROCUREMENT_FILE`, adapter status of the connector in MDM-24, source system `MUASAMCONG`), it reads the
file that a person hands over, and BID-19 says so. The test of the acceptance case (`UAT-AC454`) counts the connections the process opens while the commands
run: none leaves the machine.

## The layout is a working assumption

No sample of the file and no specification of the system were available (D05), so the adapter reads the smallest layout that names a package by what the
register holds and carries the milestone. The layout version `WORKING-ASSUMPTION-2026.1` is kept with every import (`file_import.format_version`), and a request
that names another `mapping_version` is refused before the file is opened (422 `VALIDATION_FAILED`, `mapping_version`). When the owner of the system confirms the
real layout, only `packages/kernel/src/procurement-file.ts` changes (the format is pure and tested with a file and an expected list).

| Column | Rule |
|---|---|
| File | CSV (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX; a header row; at most 5,000 rows |
| `package_code` | the code of the package in the register, at most 50 characters |
| `project_code` | optional: the internal code of its project, to tell apart two live packages with one code (else the row is `PACKAGE_AMBIGUOUS`) |
| `external_code` | the code of the package on the national network, at most 100 characters |
| `milestone_kind` | one of `INVITATION_PUBLISHED`, `CLARIFICATION_DEADLINE`, `BID_CLOSING`, `BID_OPENING`, `EVALUATION_DONE`, `RESULT_APPROVED`, `RESULT_PUBLISHED`, `CONTRACT_SIGNED` (any case) |
| `actual_at` | `YYYY-MM-DD` or `DD/MM/YYYY` (the day in Vietnam, its first instant) or an ISO date-time with its offset |
| Other columns | ignored; header names are read without regard to case and surrounding space |

## What a row does

The business key of a row is `project|package|kind`. A row is judged in this order and refused with its line, field and code (a row error, not a problem of the request):
`PACKAGE_CODE_EMPTY`, `EXTERNAL_CODE_EMPTY`, `CODE_INVALID`, `MILESTONE_KIND_INVALID`, `ACTUAL_AT_INVALID`, `ROW_DUPLICATE` (the later row of the file with the same key),
`EXTERNAL_CODE_CONFLICT` (the later package that claims a code the file gave to another), then against the register: `PACKAGE_NOT_FOUND` (no such package in the scope of the
caller), `PACKAGE_STATE_INVALID` (its plan is not in force: DRAFT, IN_REVIEW, SUPERSEDED, CANCELLED), `PACKAGE_AMBIGUOUS`, `ACTUAL_AT_IN_FUTURE`, `EXTERNAL_CODE_TAKEN` (another package
holds the code), `MILESTONE_ORDER_INVALID` (the date written would break the order of the milestones).

A row that passes is applied: the package is linked to its code (`procurement_external_link`, IN_SYNC), and the milestone is written when the register has none (`source = IMPORT`,
`import_batch_id`) or has no actual date (the planned date stays). A date the register already has is **not** overwritten: the same Vietnam day is in step, another day is a
difference `MILESTONE_DATE_MISMATCH` kept on the link (`diff_json.milestones`) with an owner (the planner who made the package while they are a member, else the person who loaded
the file) and a due time. A package already linked to **another** code is never relinked: nothing of the row is written and the disagreement is `EXTERNAL_CODE_MISMATCH`. The same key
again in a later file with other content is the framework's `DUPLICATE_CONFLICT`; the original stays.

## The commands

- `uploadProcurementFile` puts the file through the shared upload pipeline (judged by its bytes, scanned, stored for the tenant) and reads its layout at once (`IMPORT_SCHEMA_INVALID`, `IMPORT_EMPTY`).
- `importProcurementFile` with `mode: DRY_RUN` reads the file exactly as the apply will and **writes nothing** (no claim of the file, of a row, no batch, no quarantine, BR-BID-13): the answer is
  row by row `VALID` (with what would be done: `CREATE`, `FILL`, `UNCHANGED`, `MILESTONE_MISMATCH`, `CODE_MISMATCH`), `ERROR`, `DUPLICATE` or `CONFLICT`, with `rows_total`, `rows_ok`, `rows_error` and
  `already_applied`. A holder of `bid.import` on a unit subtree may dry-run the file for the packages of their units (the rows of other packages look like packages that do not exist).
- With `mode: APPLY` the command needs `bid.import` on the **whole tenant** (403 `SCOPE_DENIED` otherwise): the file spans every package and its hash is consumed once, so a unit-scoped planner who applied it would quarantine the rows
  of the packages outside their scope and shut the tenant-wide planner out with `IMPORT_FILE_ALREADY_APPLIED`. The file is applied through the file import framework (`docs/file-import.md`) once per `(tenant, SHA-256)`: the second apply is
  409 `IMPORT_FILE_ALREADY_APPLIED`. The valid rows are applied and the refused rows go to the quarantine and to the answer; a file none of whose rows can be taken is 422 `IMPORT_HAS_ERRORS` and nothing is written. The batch
  (`procurement_import_batch`: mode APPLY, adapter PROPOSED, counts, the faults of the rows) is opened before the rows and closed with the counts; an applied batch is never changed again (trigger of V1345).
- `recordProcurementMilestone` records the planned and/or the actual date of one milestone under the **version of the package** (`If-Match`; the package version moves with every record or import that writes a milestone). The dates of
  a package keep the order of the milestones, planned among planned and actual among actual (the same moment is allowed): 409 `MILESTONE_ORDER_INVALID` names the two kinds. A package in a plan not in force is 409 `PACKAGE_STATE_INVALID`; an
  actual date in the future, a date that is not an ISO date-time or a request with no date is 422. A milestone that a file wrote becomes MANUAL when the planner records it; a date that settles a difference with the file puts the link in step again.
- `listProcurementMilestones` and `listProcurementExternalLinks` (`bid.read`) read the milestones and the links of the packages of the projects in the scope of the caller.

## Pieces

| Piece | File |
|---|---|
| Layout, order of the milestones | `packages/kernel/src/procurement-file.ts` |
| Tables, guards | `db/migrations/V1345__bid1_procurement_import.sql` |
| Milestones, links, adapter, reads | `packages/db/src/bid-milestone-store.ts`, `bid-external-link.ts`, `bid-procurement-import.ts`, `bid-link-reads.ts` |
| API | `apps/api/src/modules/bid/milestone.controller.ts`, `procurement-import.controller.ts` |
| Screens | `apps/web/src/screens/bid/procurement/` (BID-17, BID-19) |
