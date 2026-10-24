# The national project code file (ST-PRJ-004)

The planning officer reconciles the register with the national public investment system (Hệ thống TTQG về ĐTC) by a file they download from
it. The platform calls no API of that system: the adapter is **PROPOSED** (`NATIONAL_PIM_FILE`, adapter status of the connector in MDM-24), it
reads the file that a person hands over, and PRJ-21 says so (`Adapter: PROPOSED - nhập tệp thủ công`).

## The layout is a working assumption

No sample of the file and no specification of the national system were available (CXN-01, D05). The adapter reads the smallest layout that names a
project by what the register holds and carries the code. The layout version `WORKING-ASSUMPTION-2026.1` is kept with every import
(`file_import.format_version`), so the evidence shows which layout a file was read with, and a request that names another `mapping_version` is refused
before the file is opened (422 `VALIDATION_FAILED`, `mapping_version`).

| Item | Rule |
| --- | --- |
| File | CSV (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX; a header row; at most 5,000 rows (the limit of the file import framework) |
| `internal_code` | the internal code of the project in the register of the tenant (`project.code`), at most 50 characters |
| `national_project_code` | the code of the project in the national system, at most 50 characters |
| Other columns | ignored; header names are read without regard to case and surrounding space |

When the owner of the national system confirms the real layout, only `packages/kernel/src/national-code-file.ts` changes (the format is pure and
tested with a file and an expected list); the version string changes with it.

## What a row does

The business key of a row is its `internal_code`. A row is judged in this order and refused with its line, field and code (the code is a row
error, not a problem of the request):

| Code | Field | When |
| --- | --- | --- |
| `INTERNAL_CODE_EMPTY`, `NATIONAL_CODE_EMPTY` | the empty one | a cell is empty |
| `CODE_INVALID` | the cell | longer than 50 characters or with a control character |
| `NATIONAL_CODE_DUPLICATE` | `national_project_code` | the code repeats the code of an earlier row of the file, or another project holds it (the dry run of a unit-scoped officer judges only the projects in their scope, so it never reveals a code held outside it; the apply is made on the whole tenant and judges all) |
| `PROJECT_NOT_FOUND` | `internal_code` | no such project in the tenant, or outside the scope of the caller (the two look alike) |
| `PROJECT_STAGE_LOCKED` | `internal_code` | the project has ended (CLOSED, REJECTED, CANCELLED) and keeps its code |
| `NATIONAL_CODE_FORMAT_INVALID` | `national_project_code` | the code does not match the rule `NATIONAL_CODE_FORMAT` in force on the day |

A row that passes is applied: a project without a code gets it (a new version, one audit row and `project.national_code_assigned.v1` each); a project
that has the same code is left as it is; a project that holds **another** code is never overwritten: the disagreement is a difference
`NATIONAL_CODE_MISMATCH` (the code the register holds, the code the file says) with an owner and a due time, settled by hand with
`assignNationalProjectCode` (which needs a ground document once the project is under way).

## The commands

- `importNationalProjectCodes` with `dry_run: true` reads the file exactly as the apply will and writes nothing (no claim of the file, of a row,
  no quarantine): the answer is row by row `VALID` (with what would be done: `ASSIGN`, `UNCHANGED`, `MISMATCH`), `ERROR` (with its code), `DUPLICATE`
  (the same row was applied before) or `CONFLICT` (the same project with other content), and `already_applied` when the same bytes were applied. A holder of `project.national_code.manage` on a unit
  subtree may dry-run the file for the projects of their units (the rows of other projects look like projects that do not exist).
- With `dry_run: false` the command needs `project.national_code.manage` on the **whole tenant** (403 `SCOPE_DENIED` for a grant on a unit subtree or a project): the
  file spans every project and its hash is consumed once, so a unit-scoped officer who applied it would quarantine the rows of the projects outside their scope and
  shut the tenant-wide officer out with `IMPORT_FILE_ALREADY_APPLIED`. The file is applied through the file import framework (`docs/file-import.md`), once per `(tenant, SHA-256)`: the second apply
  is 409 `IMPORT_FILE_ALREADY_APPLIED`. The valid rows are applied and the refused rows go to the quarantine and to the answer (`errors`, at most
  500); a file none of whose rows can be taken is 422 `IMPORT_HAS_ERRORS` and nothing is written. The connector position `NATIONAL_PIM_FILE` /
  `DEFAULT` must be ACTIVE when the tenant has it (409 `STAGE_TRANSITION_DENIED` otherwise).
- `assignNationalProjectCode` assigns or changes the code of one project: the format of the rule, one code to one project in the tenant (409
  `NATIONAL_CODE_DUPLICATE`, also under a race), a project that has ended keeps its code (422 `STAGE_LOCKED_FIELD`), the same code is recorded as
  unchanged without a new version, and changing a code that was assigned once the project is under way (IMPLEMENTATION, SUSPENDED, COMPLETED, SETTLED)
  needs `evidence_document_id` (422 `DECISION_REQUIRED`).

## The rule that requires the code

`NATIONAL_CODE_REQUIRED` (mode BLOCK or WARN, from the stage the rule names) is one reading, `nationalCodeReading`, used by `startProjectImplementation`
(`422 NATIONAL_CODE_REQUIRED` under BLOCK; under WARN the move is made, the audit row says `national_code_warning` and the answer carries
`warnings: ["NATIONAL_CODE_REQUIRED"]`) and offered to the other modules by `NationalCodeGate.assess(tx, projectIds, today, target)`. The publication of a
capital plan (CAP) is to ask the gate for the projects the plan funds; that wiring belongs to the story of the publication.
