# DOC: incoming documents (ST-DOC-011, slice DOC-1)

A letter that comes from outside is taken in, numbered in the incoming register, given to a unit and a handler with a deadline, worked and resolved (DOC.md F10, BR-DOC-18). Filing the resolved letter (state `FILED`) belongs to
ST-DOC-013; the state machine already knows it. A letter is a row of `incoming_document` on top of a `document` of the direction `INCOMING`; the history of the assignments is `incoming_assignment` (append-only).

## States and commands

| command | permission | from | to |
|---|---|---|---|
| `receiveIncomingDocument` | `doc.incoming.receive` (+ `doc.file.upload` for the file) | (new) | `RECEIVED` |
| `registerIncomingDocument` | `doc.incoming.register` | `RECEIVED` | `REGISTERED` (number from the INCOMING register of the unit of the caller, pattern `{number}/{unit}`) |
| `assignIncomingDocument` | `doc.incoming.assign` | `REGISTERED`, `ASSIGNED`, `PROCESSING` | `ASSIGNED` (reassigning keeps the earlier rows in the history) |
| `startIncomingDocumentProcessing` | `doc.incoming.process` | `ASSIGNED` | `PROCESSING` (only the handler, or a member of the unit when no handler was named) |
| `resolveIncomingDocument` | `doc.incoming.process` | `PROCESSING` | `RESOLVED` (a summary of 5 to 2000 characters; `late_days` recorded) |
| `rejectIncomingDocument` | `doc.incoming.register` | `RECEIVED` | `REJECTED` (a reason of 10 to 1000 characters, optionally `duplicate_of_id`) |

Any other pair is 409 `DOCUMENT_STATE_INVALID` with `incoming_status`. `FILED` and `REJECTED` are terminal (`guard_incoming_document`); the identity of a letter (its document, tenant and received day) cannot change, and
`register_id` and `duplicate_of_id` are set once.

## Taking a letter in

* The file is the one uploaded to `POST /document-files` (`uploadDocumentFile`); the body carries `file_object_key` and `file_sha256`. The server downloads it, checks that it is a PDF by its bytes, that the hash is the hash
  of those bytes, and that the scan is clean (`UPLOAD_NOT_PDF`, `HASH_MISMATCH`, `SCAN_PENDING`, `FILE_NOT_CLEAN`).
* **A level of state secret is never taken in** (BR-DOC-19, AC-ST-DOC-011-3): a title, symbol or sender that declares TỐI MẬT, TUYỆT MẬT, "độ mật: MẬT" or "(MẬT)" (case and diacritics folded) is refused with 422
  `STATE_SECRET_NOT_SUPPORTED`, and the refusal is audited as `DENIED` without keeping the text.
* **A letter that looks like one already there** (same sender, same original symbol and same day written on it, in the scope of the caller) is refused with 409 `INCOMING_DUPLICATE_SUSPECTED` carrying `duplicate_of_id`. It is
  taken in only with a `duplicate_override_reason` of at least ten characters, and then it keeps the link and the reason.
* The document type must be defined for the tenant (422 `VALIDATION_FAILED`, `doc_type_code`).

## Assigning and the deadline

The unit must lie in the scope of the assigner, else 422 `ASSIGNEE_OUT_OF_SCOPE`; a named handler must hold `doc.incoming.process` there. A deadline in the past (day of Vietnam) is 422 `DUE_DATE_IN_PAST`.

**Overdue** (AC-ST-DOC-011-2): the hourly job `markOverdueIncoming` (`incoming-jobs.ts`) looks at the letters that are `ASSIGNED` or `PROCESSING` with a deadline. A letter is late by the number of **working days** between
the deadline and today by the calendar `VN-STD` of the tenant (weekdays where no calendar is published). The first time it is late the job sets `overdue_since`, emits `doc.incoming_overdue.v1` once (event key
`incoming_document:{id}:overdue:{version}`, one per episode) and audits; running the job again announces nothing twice. `resolveIncomingDocument` records `late_days` so that the late letter stays visible after it is resolved.

## Reads

`listIncomingDocuments` (keyset by `received_at`, `id`; filters `status`, `overdue`, `year`) and `getIncomingDocument` (with `assignments`) answer in the scope of the caller: the unit of the register, the unit it was given
to, the one who took it in and its handler; a letter with no register yet is visible to whoever holds `doc.incoming.read` or a working permission anywhere. Each letter carries `overdue_days` and `actions`
(`register`, `reject`, `assign`, `startProcessing`, `resolve`) which say what the caller may do now; the screen shows a button only for those.

## Screens

* DOC-11 (`IncomingIntakeScreen`): the PDF, title, type (from the defined types), channel, sender, symbol and day on the letter, urgency; the duplicate warning with a link to the letter it looks like and the reason field;
  the refusal for a state secret in words. Read only without the permissions or in a read-only session.
* DOC-12 (`IncomingLedgerScreen`): the ledger, with filters (state, year, overdue), the chip "overdue N days" and a page at a time.
* DOC-13 (`IncomingHandlingScreen`): one letter with its facts and the history of the assignments; register, reject, assign or reassign, start, resolve (the dialog says how late the letter is). Every command is sent
  under the version shown (`If-Match`).

All three have the seven states and the keys `doc.incoming.*` in vi and en.

## Not here

`resolveIncomingDocument` takes an optional `response_outgoing_id`; when given it must be an outgoing document of the tenant that is issued (`ISSUED`, `DELIVERED` or `ACKNOWLEDGED`), else 422
`RESPONSE_DOCUMENT_NOT_ISSUED`; DOC-13 does not offer the field yet. The channels `EMAIL`, `LGSP` and `PORTAL` are accepted as a value but only the upload is built (the ports are ST-DOC-014). Filing is ST-DOC-013.
