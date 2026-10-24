# File imports: the idempotent framework (ST-KERNEL-070, kit K6, NFR-OPERABILITY-06)

A file from an outside system (a Treasury statement, a national investment export, a procurement file, a catalogue) goes through one
framework. It identifies the file by its SHA-256 and each row by a business key and a row hash, so that:

- the same file is never applied twice, and two imports of it at once give exactly one `APPLIED` and one `ALREADY_IMPORTED`;
- the same business key is never applied twice, whichever file carries it (a repeat is skipped; the same key with other content leaves
  the original as it is and opens a `DUPLICATE_CONFLICT` item);
- a row that fails goes to quarantine with its line, field and a stable code;
- a difference between the file and what the module holds is a reconciliation item that has an owner and a due time.

The framework is a core and an adapter interface. It does not know any file layout: PAY, DIS, CAP, BID and MDM each plug in their own.

## What is where

| Piece | File | Pure |
| --- | --- | --- |
| Plan: file hash, row judgement, row hash, key and measure checks | `packages/kernel/src/file-import.ts` (`planFileImport`) | yes |
| Pipeline: claim the file, quarantine, claim rows, apply, open items | `packages/db/src/file-import-store.ts` (`FileImportStore.run`) | no |
| Reconciliation items: list, resolve, hand over | `packages/db/src/file-import-item-store.ts` (`FileImportItemStore`) | no |
| Tables | `db/migrations/V1002__kernel1_file_import.sql` | |

Tables (all tenant tables with row-level security): `file_import` (one row per try, with the hash and the counts),
`file_import_row` (one row per business key ever applied for a connector: the claim and the certified totals),
`file_import_quarantine` (the refused rows, append-only) and `file_import_reconciliation_item` (the differences).
The runtime role cannot delete or truncate any of them; a claimed row and a quarantined row cannot be updated either.

## How a module plugs a format in

A module writes one `FileImportAdapter<Row>` per connector. The pure half (`FileImportFormat`) is tested with a file and an expected list;
the other half writes to the module's own tables.

```ts
const adapter: FileImportAdapter<Statement> = {
  connectorCode: 'TREASURY_STATEMENT_FILE', // the name of the position in integration_cursor
  formatVersion: '2026.1',                   // kept with every import
  parse: (bytes) => sourceRowsOfTable(readTabularFile(bytes)), // or any reader; throw DomainError('IMPORT_SCHEMA_INVALID', 422, 'file')
  judge(row) {                               // pure: accept with a business key, or reject with a code and a field
    if (row.values.project_code === '') return reject('MISSING_PROJECT_CODE', 'project_code', row.values.statement_no);
    return accept({ businessKey: ..., fields: {...normalised...}, record: {...}, measure: row.values.amount });
  },
  mask: (values) => ({ statement_no: values.statement_no, account: '***' + values.account.slice(-3) }), // what a person may see of a refused row
  async examine(tx, entry) { /* read-only: does the project exist, is the period open; return a Rejection or undefined */ },
  async apply(tx, entry, context) { /* write the module row once; return the Difference[] found */ },
  async ownerFor(tx, { code, businessKey }) { /* the officer who owns this difference, or undefined for the fallback */ },
};

const result = await imports.run(tx, { adapter, bytes, fileObjectKey, importedBy, fallbackOwnerId, correlationId });
// result.outcome: APPLIED | ALREADY_IMPORTED | FAILED
```

The rules an adapter keeps:

1. **Business key**: what makes the row the same thing in every file (statement number and date, procurement code). 1 to 300 characters, no control characters, else the row is quarantined as `BUSINESS_KEY_INVALID`.
2. **`fields`** are the normalised content that the row hash is taken from. Trimming, case and date formats are the format's decision: two cells that mean the same must give the same `fields`. A row that comes back with other `fields` is a conflict, not a repeat.
3. **`measure`** (optional) is the exact decimal that the module certifies in its totals (an amount, an area), at most 24 integer and 6 fraction digits. Anything else is quarantined as `MEASURE_INVALID`; there is no float anywhere.
4. **`mask`**: without it nothing of a refused row is stored but its line, key, field, code and hash. Never put an account number, a tax id or a name in a preview.
5. **`examine`** only reads. It runs for a row not seen before; a row it refuses is quarantined and its key is not claimed, so a corrected file can take it.
6. **`apply`** runs once per business key ever, in the transaction of the import. It throws only for a defect (the whole import then rolls back and the same file can be tried again); a bad row is for `judge` or `examine`. It receives `context.importId` to store a reference to the import in the module's own row.
7. **Differences** (`{ code, expected, actual, detail, dueAfterSeconds }`) become items. Two decimals also give the signed difference. A difference met again for the same connector, key and code joins the open item instead of opening another.
8. **Owner**: `ownerFor` names the officer; if it names nobody, or somebody who is not an active member, the item goes to `fallbackOwnerId`, which must itself be an active member. An item always has an owner and a due time (`dueAfterSeconds` of the run, default 3 days; a difference may set its own).
9. Rows are claimed **in the order of their business keys**, not of the file, so two files that carry the same keys in opposite orders cannot deadlock on the key claims. A module that updates shared rows (a total per project) in `apply` should update them in a stable order too.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `APPLIED` | The file was read. `counts` say how many rows were applied, repeated (`duplicate`), in conflict, quarantined, and how many items opened. A file with quarantined rows is still `APPLIED`: the refused rows are the report. |
| `ALREADY_IMPORTED` | The same bytes were taken before for the connector (and did not FAIL). Nothing was written; `importId` and `counts` are the earlier ones. The response of the caller is 200 with this result, not an error. |
| `FAILED` | The file could not be read (`IMPORT_SCHEMA_INVALID`, `IMPORT_EMPTY`). The try is recorded with its reason and an outbox event `file_import.failed`; the same bytes may be tried again (a `FAILED` try does not block). The caller turns it into 422. |

A wrong `expectedSha256` (the hash that the upload recorded) is 422 `HASH_MISMATCH` before anything is written.

## Connector position (`integration_cursor`)

Pass `cursorScope` (normally `DEFAULT`) to keep the position of the connector in step:
the connector must be `ACTIVE` (otherwise 409 `STAGE_TRANSITION_DENIED`); a read file sets `last_file_sha256` and `last_success_at`;
an unreadable file sets the connector `FAILED` with `last_error_code`, and only the reset of MDM-24 (with its reason) starts it again.
A tenant without that row is not affected. The cursor row is locked, so imports of one connector take turns.

## Certified totals

`totals(tx, connectorCode, importId?)` returns `{ rows, measure, openDifferences }`: the number of rows ever applied, the exact sum of their
measures and the items still open. A quarantined row is never in it, a repeat adds nothing and a conflicting row does not change the
original, so importing a file again cannot move the total. A row that has an open `AMOUNT_MISMATCH` item is in the total: the module
decides whether a figure with open differences is certified (read `openDifferences`).

## Events and metrics

Outbox: `file_import.completed` (counts), `file_import.failed` (error code, file hash), `file_import.difference_opened` (item id, code,
owner, due time) so a notification module can tell the owner. Payloads carry no row content.
Counters: `file_import_rows_quarantined_total{connector,reason}`, `file_import_finished_total{connector,outcome}`.

## Limits and what the framework does not do

- One file is judged and applied in one transaction, at most 5,000 rows (`FILE_IMPORT_MAX_ROWS`; the same as the tabular reader). A larger
  file is split by the producer or needs the chunked variant in `TODOS.md` (ST-KERNEL-070).
- It does not authorise: who may start an import, read the quarantine or resolve an item is for the controller of the module (permission
  plus scope, audit with `scope.audit`). The stores record the people they are given.
- It has no concrete layout. The Treasury statement layout waits for the anonymised samples (R-PAY-04).
