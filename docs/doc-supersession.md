# Replacing and correcting an issued document (ST-DOC-015)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DOC.md` (F9, BR-DOC-21, DOC-19, UAT-AC412). Migration `V1227__doc1_replacement_correction.sql`. Operations: `createReplacementDocument` (`POST /outgoing-documents/{id}/replacements`, `doc.outgoing.replace`, `If-Match`) and `createCorrectionDocument` (`POST /outgoing-documents/{id}/corrections`, `doc.outgoing.correct`, `If-Match`). The store is `packages/db/src/outgoing-supersession-store.ts`; the step that takes effect is in `apps/api/src/modules/doc/issuance.ts`.

## The rule

A replacement or a correction is a **new draft** that carries a relation to the issued document; the issued document does not change until the new one is **issued**. Then the system (in the transaction of the issue, for both ways a document becomes issued: the command and the registration of a document signed outside) changes the old one:

- **Replaced** (`REPLACES`): the outgoing document and its effect become `REPLACED`. It is no longer in force: `resolveDocumentReference` and the port every module calls before it writes a `*_document_id` answer 422 `DOCUMENT_NOT_EFFECTIVE` with the document that took its place. A replaced document is final (the database refuses any other state or effect afterwards).
- **Corrected** (`CORRECTS`): the outgoing document and its effect become `CORRECTED`; it is **still in force** with its correction, and the reference resolves with the link to the correcting document. A corrected document can be corrected again, replaced, or recalled (only on a basis: 422 `RECALL_BASIS_REQUIRED`, `basis: REQUIRED_FOR_CORRECTED`).
- A corrected document goes on working: it is still sent to new recipients, its deliveries are tried again and its receipts recorded, its signatures stay in the scheduled revocation check, it is filed into a dossier (the status stays CORRECTED) and it is a valid answer to an incoming letter.
- In both cases the **number of the old document stays booked** in the register, a history row (`REPLACED` / `CORRECTED`), an audit row (`outgoing_document.replaced|corrected`) and the event `doc.replaced.v1` / `doc.corrected.v1` (once per replacing or correcting document, carrying the old document, the new one and the effect) are written.

**The commands.**

- Allowed from `ISSUED`, `DELIVERED`, `ACKNOWLEDGED`, `FILED`, `ARCHIVED` and `CORRECTED`; any other state, a recalled or replaced document included, is 409 `DOCUMENT_STATE_INVALID`. A version that moved is 409 `VERSION_CONFLICT`.
- Only one replacement and one correction can be **open** (the new document not yet issued, and not cancelled) at a time: 409 `REPLACEMENT_ALREADY_OPEN` / 409 `CORRECTION_ALREADY_OPEN`. One of each may be open together. When the open draft is cancelled, or issued, the next can be made.
- The reason (at least 10 characters after trimming) is kept in the relation and in the audit row. A replacement may give a title (3 to 500 characters); the default is the title of the old document. A correction needs its words (at least 5 characters, at most 4000) and they are stored in the content of the draft under `correction` (`text`, `reason`, `corrects_document_id`).
- The draft is made in the drafting unit of the old document with its type, template, layout, urgency, circulation, recipients, classification, subject and content; it is signed in person (a delegation belongs to the document it was given for: the drafter chooses it again), by the same signer when the old one was signed in person. The drafter is the caller. It then goes through review, signature, number and seal as any draft; a correction takes a number of its own.
- The caller needs the permission over the unit that drafted the old document (403 otherwise); a document the caller cannot see, or another tenant's, is 404.

## The read

`getOutgoingDocument` carries `relations`: every relation of the document in both directions, newest first (`kind`: `REPLACES`, `CORRECTS`, `RECALLS`..., `direction`: `IN` when another document does it to this one, `OUT` when this one does it to another, the other document with its title, symbol and state, the note and the time).

## The screen (DOC-19)

The recall screen shows, for a document in force, the two forms (replace: title and reason; correct: the words and the reason), each for the person who holds its permission and not in a suspended tenant, then a link to the draft that was made. Documents that are `CORRECTED` and `REPLACED` are in the list. The relations of the document are a timeline with the state of the other document and a link to the draft or to the document.

## What is not done

- The correction is a draft with the words in its content; how the template prints them (a template of its own for corrections) is for the legal review of the templates (CXN-DOC-01).
- A replacement or a correction whose draft is returned and cancelled leaves its relation in place (relations are kept for good); it no longer counts as open.
