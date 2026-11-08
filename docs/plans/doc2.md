# DOC-2 lane plan: project document repository, citable text, staged review, version comments

Branch `lane/doc2`, migration block 2160-2179 (V2160 to V2163 used). Requirements PD.01 and PD.02 of the customer dossier (plan, Dot 3 item 7).

## Decisions (owner rule: deepest governance, no scope cut)
- The review is the ADM approval workflow, business type `document.review`: stages are steps, parallel reviewers are the tasks of a step, a stage closes at `min_approvals`. A return is the supplement request; the supplement is a newer version sent as the next round. Decisions go through `decideApprovalTask`; the end of the workflow is the final command registered by `DocumentReviewBinding`. The DIS review is not touched.
- An approved version is locked by the database (trigger) and by the kernel; the next change is a new version. Comments stay allowed on a locked version.
- Citations are `cit_` plus 20 hex of SHA-256(file hash, place), so a second reading gives the same id; a reference is `docver:<version id>#<citation id>` (hook for AI-2: `resolveDocumentCitation`).
- No OCR port existed. `DocumentTextExtractionPort` is the seam; adapters: local (Word, workbook, PDF text layer, no network) and mock. A scan reads as NO_TEXT and is read again by `rerunDocumentExtraction` once an engine hosted by the tenant is bound.
- Files stay in the tenant storage; the download is a signed link of five minutes; no object key leaves the server.

## Steps
1. Kernel rules and tests (done, committed).
2. Migrations, stores, db tests (done, committed).
3. Reader of text, controllers, authz matrix, contract, design rows (API tests: extractor and repository over HTTP).
4. Web: DOC-24 repository, DOC-25 document with viewer and comments, DOC-26 review board, DOC-27 compare; i18n part `doc2`.
5. Docs: DOC.md section, `docs/doc-repository.md`.
6. Gates: lint, typecheck, kernel/db/api/web tests, isolation, conformance counts, outbox consumers, dis/report.
7. Codex review with the astra model, triage, fixes with regression tests.

## Codex review (model astra, read-only)
- P2 submission of a version older than the approved one could never be approved (the approved pointer only moves forward): valid; `planSubmission` takes `approvedVersionNo` and refuses with 422 DOC_REVIEW_VERSION_NOT_NEWER; kernel regression test; wired in `submitDocumentForReview`.
- P2 text held by PDF Form XObjects was dropped while the version read as EXTRACTED: valid; the reader follows `Do` into forms with their own matrix and fonts (depth 4, 500 forms per page); regression test with a form drawn through `embedPdf`.
