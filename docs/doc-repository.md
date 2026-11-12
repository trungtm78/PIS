# Project document repository (DOC-2)

Requirements PD.01 and PD.02 of the customer dossier. Code: kernel `packages/kernel/src/doc-repository.ts`, `doc-compare.ts`, `doc-review.ts`; stores `packages/db/src/doc-repository-store.ts`, `doc-text-store.ts`, `doc-comment-store.ts`, `doc-review-store.ts`; API `apps/api/src/modules/doc/repository*.ts`, `text-extraction.ts`, `local-text-extractor.ts`; web `apps/web/src/screens/doc/repository/` (DOC-24 to DOC-27); migrations V2160 to V2163. Rules: DOC.md section 14 (BR-DOC-30 to BR-DOC-35).

## 1. What it keeps

A document belongs to one project and may link a contract and a package of that project. It has a class (a code of the kernel register `DOCUMENT_CLASSES`: adding a class needs no migration), a security class, a reference, an effective period and a note. Its versions are the files: PDF, Word (docx) or workbook (xlsx), up to 25 MiB, in the tenant object storage. A version is DRAFT, IN_REVIEW, SUPPLEMENT_REQUESTED, REJECTED or APPROVED (locked). Every read and command is judged in the scope of the caller over the project (owner unit, investor unit, or the project itself); outside the scope the document does not exist (404).

## 2. Files in

`uploadProjectDocumentFile` (multipart) judges the bytes, checks the content is the format it says, stores and scans the file (the mock scanner until ClamAV is bound) and answers key, hash, format and page count. `createProjectDocument` and `addProjectDocumentVersion` name the file by key and hash, open it again, read its text and write the version and its units in one transaction. A file already kept as a version of the document is refused (409 `DOC_VERSION_DUPLICATE`).

## 3. Text units and citations (the OCR contract)

`DocumentTextExtractionPort` (`text-extraction.ts`) is the only place text is read. It gets the bytes and the format and returns units with a place and, on a PDF page, a box in fractions of the page. Adapters: the local reader (Word paragraphs and table cells, every filled cell of a workbook, the text layer of a PDF grouped into lines and paragraphs; ToUnicode maps are honoured; no network, zip sizes are checked before anything is inflated) and the mock reader for tests. A scan has no text layer and reads as `NO_TEXT`; an OCR engine hosted by the tenant is bound as another adapter of the same port (no content is ever sent to an external service) and `rerunDocumentExtraction` reads the version again. Boxes of a PDF are approximate (glyph widths are estimated, page rotation is not applied); text and page are exact. A unit is kept append-only.

Citation id: `cit_` plus the first 20 hex characters of SHA-256 of `file sha256 + newline + locator key`. Locator keys: `p3/para2`, `para12` (Word has no fixed pages), `t2/r3c4`, `Budget!B7`. The same file read twice, or kept in two versions, gives the same ids. A reference another feature stores is `docver:<version id>#<citation id>`; `resolveDocumentCitation` returns the unit with the one before and after, the version and the document (this is the hook of AI-2 for exact citations).

## 4. Review (PD.01)

The review is the ADM approval workflow of the business type `document.review` (kernel `BUSINESS_TYPES`); the tenant publishes its definition with the usual maker-checker. Stages are the steps; reviewers of a stage are its tasks and decide in parallel; the step closes at `min_approvals`; a step may allow a return to an earlier one. `submitDocumentForReview` writes the round (`document_review`, round number, previous round), moves the version to IN_REVIEW and starts the instance in the same transaction (no published workflow: 422 `WORKFLOW_NOT_CONFIGURED`, nothing written). Reviewers decide with `decideApprovalTask`; the engine ends the round by calling the final command registered by `DocumentReviewBinding`: approved locks the version and sets it as the approved version of the document, returned is the request for a supplement (the reason of the reviewer is the conclusion note), rejected closes the round. A supplement is a newer version sent as the next round; the same file cannot be sent again. `withdrawDocumentReview` is for the sender while the round is open and cancels the instance. The board (`getDocumentReview`) shows stages, reviewers and what each decided, from the definition the round started on.

## 5. Comments, comparison, lock (PD.02)

Comments belong to a version, may be anchored to a citation of it and reply one level deep; the words and the author never change; they are OPEN or RESOLVED. They are allowed on a locked version. `compareDocumentVersions` compares the units of two versions (kernel `doc-compare.ts`): a longest common subsequence over unit digests, replaced units paired at 40 percent shared words and diffed word by word; a workbook cell by cell. The bound is 16 million table cells. The lock of an approved version is enforced by the database for every role; there is no unlock.

## 6. Governance notes

- Audit and events carry ids, counts and hashes, never titles, text, comment words or object keys. Opening the text of a CONFIDENTIAL or PERSONAL document and every download leave an audit row.
- Every number on a screen has its formula (`formula` of the comparison, the rule texts of the board) and `as_of`.
- No alert type is added: expiry of a document is shown as `effective_state`; an alert source for expiring documents is a follow-up for the alert centre.
- Legal numbers: none. The only threshold is the pairing similarity of the comparison (0.4), a working constant of the kernel.

## 7. Follow-ups left for other lanes

- AI-2: cite by `citation_ref`, read units through `listDocumentTextUnits` / `resolveDocumentCitation`; a consumer of `doc.repo.version_locked.v1` can index approved versions.
- Ops: bind an OCR reader hosted by the tenant behind `DOC_TEXT_EXTRACTION`; bind the real antivirus.
- WF-1 (done in parallel): the DIS review stays on its own path; this lane did not touch it.

- Enterprise edition (MD.02): `createProjectDocument` and `updateProjectDocument` take an optional `legal_doc_type`, a code of the catalogue `ENT_LEGAL_DOC_TYPE`, through the `ProjectDocumentExtension` seam (`PROJECT_DOCUMENT_EXTENSION`). The public edition binds none and refuses a named type; the enterprise one judges the code against the catalogue in force and keeps it in `project_document_legal_type`. See `docs/plans/aud5.md`.
