# BID: the OCR of the pages of a proposal and its review (ST-BID-008, slice BID-1)

The analysis of a proposal reads each page of its files with an OCR engine (BID 3 F3, BR-BID-03/06). A page the engine is not sure of, or with a table that does not add up, must be
confirmed or corrected by a member of the evaluation team before the **financial analysis** may run: the price is computed in decimal code from tables a person has verified.

## What waits for a person

`classifyPage` (kernel `bid-ocr.ts`) gives a freshly read page its status:

| reading | status |
|---|---|
| confidence under the threshold (`OCR_CONFIDENCE_THRESHOLD`, 850 thousandths = 0.85, an assumption of the module design until the engine is evaluated in SPIKE-3) | `NEEDS_REVIEW` |
| a table whose stated `total` is not the **exact** decimal sum of its lines (integer math over decimal strings, up to 8 digits after the point), or tables that cannot be read | `NEEDS_REVIEW` |
| otherwise (0.85 exactly is accepted, 0.849 is not) | `AUTO_ACCEPTED` |

A table is `{ rows: [{ label, amount }], total }` with money as decimal strings. No float is involved anywhere: the confidence is a decimal string (`numeric(5,4)`) compared with the
threshold digit by digit.

`financialGate(pages)` is the gate of the analysis: **ready only when no page of the proposal is `NEEDS_REVIEW`**; otherwise it names the pages that hold the analysis back.
`BidOcrStore.gate(tx, versionIds)` answers it for the analysis (ST-BID-009), which has no viewer; `listProposalOcrPages` carries it as `financial_ready` / `blocked_pages`.

## The pipeline side: `BidOcrStore.recordPages`

`recordPages(tx, documentVersionId, pages, engineVersion)` is what the analysis workflow calls with the readings of the engine (the text of each page is already in the object store; the row keeps its key
and its SHA-256). It assigns the status with `classifyPage`, sets `table_mismatch`, and is **idempotent per page**: a page that was recorded keeps its first reading (the reading of the engine is a fact), so the
same call twice leaves the same pages. There is no OCR engine adapter in this story; the engine and the route for CONFIDENTIAL files are decided with SPIKE-3 and plugged in by ST-BID-009.

## Commands and reads

| operation | rule | refusal |
|---|---|---|
| `reviewOcrPage` (`bid.ocr.review`) | `CONFIRMED` keeps the reading; `CORRECTED` names the corrected text (`corrected_text_object_key`), which must be a clean plain text of the tenant that came through `uploadOcrCorrectionFile`, used for no other page or file. Only a page that waits is reviewed, once. The reviewer is the caller. | 404 (no full view), 403 `CONFLICT_UNDECLARED`, 409 `OCR_STATE_INVALID`, 422 `VALIDATION_FAILED` (`reason`: `FILE_KEY_INVALID`, `FILE_TYPE_INVALID`, `FILE_ALREADY_ATTACHED`), 404 for a key that is not the tenant's |
| `uploadOcrCorrectionFile` (`bid.ocr.review`) | the shared upload pipeline, `text/plain` only, at most 1 MiB, scanned before it is used | 422 `FILE_TYPE_NOT_ALLOWED`, 413 `PAYLOAD_TOO_LARGE`, 422 `FILE_NOT_CLEAN`, 409 `SCAN_PENDING` |
| `listProposalOcrPages` (`bid.ocr.read`) | the pages of a proposal (filters `document_version_id`, `review_status`; cursor), each with the confidence, the recognised text read from the object store and checked against its digest (`text_state`: `READABLE`, `DIGEST_MISMATCH`, `MISSING`), the corrected text for a corrected page, and the gate | 404, 403 `CONFLICT_UNDECLARED`, 422 |

**Who sees a page (BR-BID-03).** A page belongs to a proposal, and it exists only for whoever has the **full view** of that proposal in `BidProposalReads.find`: a member of the evaluation team (`bid.evaluate`) over the project
who also holds the OCR permission over it, after the opening of the bids, with the declaration of conflict of interest made and no conflict standing between them and the bidder. For anyone else (the clerk who receives proposals, a
member recused from the contractor or blocked, a sealed proposal, a replaced one, another tenant) the page and the proposal do not exist: 404. A member who owes the declaration is told so (403 `CONFLICT_UNDECLARED`), as on the proposal itself.

**Audit and events.** Reading the pages leaves the row `bid.ocr_opened` (proposal, package, contractor, revision, number of pages); a review leaves `bid.ocr_reviewed` and the event `bid.ocr.reviewed.v1`. Neither carries any of the text, not even the note (`has_note`).

## The table (V1349)

`document_page_ocr` gains `table_mismatch`, `review_note`, `corrected_text_object_key` and `corrected_text_sha256` (a corrected page has both; the same stored file cannot stand for two pages). The guard
`guard_document_page_ocr`: a page is written as read (`AUTO_ACCEPTED` or `NEEDS_REVIEW`, no reviewer, no note); **what the engine said never changes** (confidence, text key and hash, tables, engine, page, version); a page that waits moves
only to `CONFIRMED` or `CORRECTED`, by a person, once; an accepted or reviewed page stays so; a table that does not add up is never `AUTO_ACCEPTED`; `DELETE` and `TRUNCATE` are revoked and refused. The owner of the schema (the migrations) is not held by the guard.

## Screen BID-06

`/bid/bid-06?proposal=<id>`: the pages of the proposal side by side (the page, the confidence against the threshold, the text the engine recognised, and the text of the reviewer), the filters outside the empty boundaries, the gate of the financial analysis,
and the actions to confirm or correct a page with the idempotency key kept across retries. The text a reviewer has typed and not sent is never lost, and no text is ever logged.
