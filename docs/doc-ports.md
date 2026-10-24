# DOC ports for source modules (ST-DOC-008)

A module that needs a state document (a decision, a letter, a report) never writes one itself and never marks its own record issued. It asks DOC, and it
marks its record issued only after the `doc.issued.v1` that names its reference and its hash. A module that stores a document id points at the document
only after DOC says it may be relied on. Code: `apps/api/src/modules/doc/` (`issue-request.service.ts`, `issue-consumer.ts`, `document-reference-port.ts`,
`issuance.ts`). Rules: DOC.md F2, BR-DOC-11, BR-DOC-17, BR-DOC-21.

## 1. Asking for a document

Three ways in, one judgement (`DocumentIssueService`):

| Way | Who | Notes |
|---|---|---|
| `DocumentIssueService.requestIssue(tx, ctx, input)` | a module in its own transaction | the request, the refusal and the events commit with the module's work |
| `POST /document-issue-requests` (`requestDocumentIssue`) | a service principal of the module, `doc.issue.request` on the **whole tenant** | a refusal answers 422 and is kept (the request is `REJECTED`, `doc.rejected.v1` is written in its own transaction) |
| the events `doc.issue_requested.v1` and `mne.report.issue_requested.v1` | the outbox | consumed once per delivery (inbox `doc-issue-request`) and once per `(source_module, event_id)` |

### The request

| Member | Meaning |
|---|---|
| `source_module` | module code, two to ten capitals (`MNE`, `DIS`, `CAP`, `PAY`...) |
| `source_ref` | what the document is for, e.g. `MNE:mne_report:<uuid>:r<revision>` (5 to 200 characters) |
| `template_code` | the template; the revision in force on `as_of_date` is chosen |
| `payload_ref` | where the module wrote the payload: an object key under `tenants/<tenant id>/` |
| `payload_sha256` | SHA-256 of the **canonical** payload (`payloadSha256` of `@machvon/kernel`: keys sorted, numbers as decimal text, NFC). DOC computes it again from the stored payload; it is never taken from the request |
| `event_id` | the id of the request: the same `(source_module, event_id)` is the same request |
| `as_of_date` | the day the template is looked up for |
| `signer_hint` | `drafting_unit_id` (**required**: the unit that drafts for the module), optional `membership_id` (the signer; left out when not an active member), `signing_mode` and `delegation_id` (a delegated mode needs a delegation, a direct one names none) |
| `recipients` | `[{ name, kind?, code?, unit_id? }]`, up to 500 |

The payload carries the members of the face of the document (`agency`, `place`, the placeholders of the template, optional `summary`, `signer_title`,
`signer_name`, `amount_vnd` as whole VND: the amount the matrix of authority reads).

### The outcome

| Outcome | Request | REST answer | Events |
|---|---|---|---|
| the payload, the hash, the template and the unit hold | `ACCEPTED`, a `DRAFT` outgoing document that carries `source_ref` and the hash | 200 with `resource_id` (the request), `outgoing_document_id`, `document_id` | `doc.issue_accepted.v1`, `doc.draft_created.v1` |
| refused | `REJECTED` with `reject_code` | 422 with the code, `fields` and `issue_request_id` | `doc.rejected.v1 { source_module, source_ref, payload_sha256, reject_code }` |
| the same event again | unchanged | the first answer (200, or the same 422 with `replayed`) | none |
| the same event with other content | unchanged | 409 `IDEMPOTENCY_CONFLICT` | none |
| the same content while its request is open (`RECEIVED`, `ACCEPTED`, `ISSUED`) | unchanged | 409 `ISSUE_REQUEST_ALREADY_OPEN` with `issue_request_id` and `outgoing_document_id` | none |

`reject_code`: `DOC_TEMPLATE_MISSING` (no revision of the template exists), `TEMPLATE_NOT_EFFECTIVE` (none in force on the day),
`PAYLOAD_HASH_MISMATCH` (the payload is not there, or its hash is not the declared one), `PAYLOAD_SCHEMA_INVALID` (not JSON, not an object, a required
member missing, an amount that is not whole VND, a bad recipient or hint), `STATE_SECRET_NOT_SUPPORTED` (the payload declares a level of state secret, BR-DOC-20).

New content for the same `source_ref` is a new request; the earlier one must be `CANCELLED` or `RECALLED` before the new one is issued (BR-DOC-17). Cancelling the
draft (`cancelOutgoingDocument`) sets the request `CANCELLED` and emits `doc.rejected.v1` with the cancel code (`SOURCE_WITHDRAWN`, ...); the content may then ask again.

### Becoming ISSUED

The request is `ISSUED`, and `doc.issued.v1` goes out **once**, in the transaction that issues the document (`OutgoingIssuance`, called by the command that issues a sealed document (ST-DOC-010) and by the
external registration):

```
doc.issued.v1 { tenant_id, document_id, outgoing_document_id, version, actor_id, occurred_at,
                source_module, source_ref, payload_sha256, document_number, symbol, issued_on,
                document_version_id, file_sha256, route }
```

The module matches `source_ref` **and** `payload_sha256` of its own record; an event with another hash is ignored and reported.

## 2. Pointing at a document

`DocumentReferencePort.assertUsable(tx, documentId, allowedDocTypes?)`, and `GET /documents/{id}/usability` (`resolveDocumentReference`, `doc.reference.check`):

- the document must exist for the tenant of the transaction (404 otherwise, another tenant's included);
- its effect must be `EFFECTIVE`, or `CORRECTED` (a corrected document stays in force; the answer lists the correction in `relations`);
- `PENDING`, `RECALLED`, `REPLACED`, `EXPIRED` answer 422 `DOCUMENT_NOT_EFFECTIVE` with `reason: NOT_EFFECTIVE`, `effect_status` and the `relations` (the documents that replaced or recalled it);
- a document of a kind the module does not accept answers 422 `DOCUMENT_NOT_EFFECTIVE` with `reason: DOC_TYPE_NOT_ALLOWED`.

The answer carries what is printed on the face of the document (kind, type, symbol, number, year, date, effect) and nothing of its content. A module calls the port before it writes any `*_document_id` column.

## Issued, delivered, acknowledged (ST-DOC-010)

`doc.issued.v1` is sent by `issueOutgoingDocument` (after the gate verified both signatures again) and by the registration of a document signed outside the
system, once per document (`outgoing_document:<id>:issued`). Its payload now carries `template_unconfirmed` (true when the document was issued with the written
reason of a legal officer while its template was not confirmed: a reference copy). A module that gets `doc.delivered.v1` (the first recipient has the document)
or `doc.acknowledged.v1` (every recipient that had to acknowledge has) learns the same facts the document row carries: `document_id`, `outgoing_document_id`,
`source_module`, `source_ref`, `payload_sha256`, `document_number`, `symbol`, `version` and the counts. Each is sent once, in the transaction of the command
that moved the document.
