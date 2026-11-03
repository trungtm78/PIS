# BID: the evaluation report and its sign-off, the minutes issued through DOC (ST-BID-012, slice BID-1)

The evaluation team of a package puts what its experts decided into one report (BID 3 F6), every member signs it, and the minutes are issued through DOC (DOC 9, BR-DOC-17). The report is made from the decisions of
people (`docs/bid-review.md`) and never from the words of the model; the award stays a decision of someone with the authority (BR-BID-09): nothing here ranks the proposals or names a winner, and the minutes say so.

## Making the draft (`createEvaluationReport`, `bid.evaluate`, Idempotency-Key)

`POST /evaluation-reports` with `{ package_id, criteria_version_id, run_ids, summary: { conclusion } }`. `run_ids` are the analyses that stand for the proposals the report covers (one for each proposal, each named once);
`conclusion` is the only thing the author writes (20 to 8000 characters once trimmed). Refusals in order (nothing is written for them):

| step | refusal |
|---|---|
| the shape: `conclusion` under 20 or over 8000 characters or beside another member of `summary`, `run_ids` empty, repeated or not ids | 422 `VALIDATION_FAILED` (`summary`, `run_ids`), 400 `FIELD_NOT_ALLOWED` for a member the contract does not name |
| the package is not one of a project the caller evaluates (`bid.evaluate` over it) | 404 |
| the caller owes the declaration about the package, or a conflict of interest shuts them out (declared and pending, `RECUSED`, `BLOCKED`) | 403 `CONFLICT_UNDECLARED`, 404 |
| a proposal waits for the declaration of the caller, the criteria version is not there or is of another package | 403 `CONFLICT_UNDECLARED`, 404, 422 `VALIDATION_FAILED` (`criteria_version_id`) |
| a run that is not the analysis standing for a proposal the caller has in full (unknown, of another package, replaced by a later run, cancelled, of a sealed proposal) | 404 on `run_ids`: nothing says why |
| a run that ran on other criteria than the version named | 422 `CRITERIA_VERSION_MISMATCH` (`run_ids` of the problem name them) |
| a run that does not wait for the experts (it ran, failed, was refused) | 422 `RUN_NOT_COMPLETED` |
| a finding of the runs that nobody decided | 422 `UNREVIEWED_FINDINGS` with `unreviewed_count` and the first twenty `finding_ids` |

The draft is written DRAFT at version 1 with the comparison of the chosen runs frozen in `summary_json`: for each proposal the weighted score, the criteria decided and the mandatory criteria not met; for each criterion
and proposal what the person decided (status, score, decision, moment) and its risk; the proposals of the package that are **not** in the report with the reason (`NOT_SELECTED`, `NO_ANALYSIS_RUN`,
`CRITERIA_VERSION_MISMATCH`); the criteria left out because their text falls under a rule of the criteria nobody may ask for, and the attributes the comparison never looks at. The same function as BID-10
(`compareProposals` of the kernel) builds it, so the table of the screen and the table of the minutes cannot differ. `summary_json.decisions_sha256` is the digest of the latest decision of a person about each finding of the
runs. The audit row `bid.report_drafted` and the event `bid.report.drafted.v1` carry ids, the code of the package, the runs and the digest, never the conclusion.

## Signing (`signOffEvaluationReport`, `bid.evaluate`, If-Match, Idempotency-Key)

`POST /evaluation-reports/{id}/sign-off` with `{ dissent? }` (an empty object when the member has none). The dissent is written by the member who holds it, in their own words (20 to 4000 characters), and kept word for
word in `dissenting_opinions` next to the signature (`signed_off_by` holds `{ membership_id, signed_at, dissent }`): nobody writes a dissent on behalf of another member. Refusals in order:

| step | refusal |
|---|---|
| the dissent is under 20 or over 4000 characters | 422 `VALIDATION_FAILED` (`dissent`) |
| the report is not of a package the caller evaluates | 404 |
| the caller owes the declaration about the package; or a conflict of interest shuts them out | 403 `CONFLICT_UNDECLARED`; 404 |
| the report is not a draft (it asked DOC for the minutes, or has them) | 409 `REPORT_STATE_INVALID` naming the state |
| the caller signed already | 422 `ALREADY_SIGNED_OFF` (except the confirmation below) |
| the version in `If-Match` is not the current one | 409 `VERSION_CONFLICT` with `current_version` |
| experts decided a finding of the runs again after the draft (the digest of the decisions is not the frozen one) | 409 `REPORT_OUT_OF_DATE`: a new report is made; the draft reads `stale` and offers no signature |
| the last signature, and the file store of DOC is not there / the template of the minutes is not in the library | 503 `PROVIDER_UNAVAILABLE` / 422 `DOC_TEMPLATE_MISSING`: the transaction is undone, the signature is not taken |

**The evaluation team** is whoever holds `bid.evaluate` over the project of the package (the register has no table of team members, `docs/bid-proposals.md`), judged by the grants in force and read in one query for all
of them. The report waits for every member of the team but the ones a decision shut out: `RECUSED` and `BLOCKED` are not waited for and sign nothing (the decision on the conflict already takes them out of the
signatures of the reports that are not issued, `BidConflictStore.removeFromSignOff`); a member who has not declared, or whose conflict is declared and not decided, **is** waited for (fail closed) and cannot sign until
the declaration stands. `awaiting` of the read says who and why. A team with nobody to wait for is never complete.

**The confirmation.** If a decision on a conflict cuts the team down to members who have all signed already, nobody is left to sign and the report would stay a draft. A member who signed may then call the same
operation without a dissent: it adds no signature and completes the report. With others still awaited, or with a dissent in the body, a second call is still 422 `ALREADY_SIGNED_OFF`. The command and the read
model ask the same pure function, `signOffKind(team, signers, member)` of the kernel (`SIGN`, `CONFIRM` or `ALREADY_SIGNED`), so `actions.sign_off` is true for the member who signed exactly when the confirmation is allowed (and the
report is a non-stale draft), and the screen offers it.

**Asking DOC.** The signature that leaves nobody to wait for moves the report DRAFT to SIGNED_OFF and, in the same transaction, to ISSUE_REQUESTED: the payload of the minutes (`title`, `body` with a block for each proposal and the
decision of the experts on each criterion, the proposals left out, the conclusion, the signatures with their moments and the dissent, `agency` = the owner unit of the project, `place` = a dash which DOC's drafter
completes) is built from the report, its SHA-256 is frozen with it (`payload_sha256`, `payload_ref` = `tenants/<tenant>/bid/reports/<id>/<sha256>.json`, `issue_event_id`, `issue_requested_at`), the payload is written to the
file store of DOC, and `bid.report.issue_requested.v1` carries `source_module` BID, `source_ref` `BID:evaluation_report:<id>`, `template_code` `BID-BB-DANH-GIA-HSDT`, the reference and the hash, and
`signer_hint.drafting_unit_id` (the owner unit). The consumer of DOC (`DocumentIssueConsumer`) reads that event like the ones of MNE and AUD. Every signature writes the audit row `bid.report_signed_off` and the event
`bid.report.signed_off.v1` (signatures, awaited, whether a dissent came with it, whether the team is complete; never the words); the one that asks DOC also writes `bid.report_issue_requested`.

## What DOC answers (the consumer `bid-report-issue`)

`apps/api/src/modules/bid/report.consumer.ts` reads `doc.issued.v1`, `doc.rejected.v1` and `doc.recalled.v1` that name `source_module` BID. It believes an answer only when it names a report of the tenant by its reference
and carries the hash that was frozen with it (`source_payload_sha256`, else `payload_sha256`: DOC's own hash changes when its drafter completes the place of issue); an answer for an earlier request (another
`source_event_id`) changes nothing.

| Answer | Effect |
|---|---|
| `doc.issued.v1` with the document | ISSUE_REQUESTED to **ISSUED**, `report_document_id` and `issued_at`; the minutes issued before for the package become SUPERSEDED (audit `bid.report_superseded`, event `bid.report.superseded.v1`); gauge `bid_report_issue_latency_seconds` |
| `doc.rejected.v1` with the reason | ISSUE_REQUESTED to SIGNED_OFF (signatures kept); alert `BID_REPORT_ISSUE_REJECTED` |
| `doc.recalled.v1` | `recalled_at` is set once and the alert `BID_REPORT_RECALLED` is raised; a recall that comes before the issue fails the delivery so that it is tried again |

Another hash, an answer without its document or reason, or one that does not follow the state of the report is audited (`bid.report_exception`), counted (`bid_report_event_total`) and raised
(`BID_REPORT_EXCEPTION`), and changes nothing. One delivery changes the report once. Runbooks: `docs/runbooks/alerts/BID_REPORT_*.md`. The module never marks a report issued by itself.

## Reads

`GET /procurement-packages/{id}/evaluation-reports` (newest first) and `GET /evaluation-reports/{id}`, `bid.evaluate`, with the same gate of the declaration (403 `CONFLICT_UNDECLARED`; a member shut out by a conflict, a
package outside the project scope or another tenant: 404). A report shows its frozen `summary`, `signed_off_by` and `dissenting_opinions` with display names, `awaiting` (membership, name, standing
`UNDECLARED`, `PENDING`, `CLEAR`, `ALLOWED`), `payload_sha256`, `report_document_id`, `document_status` (the state of the document DOC drafted, as DOC keeps it), `stale`, `recalled_at` and
`actions.sign_off` (the draft waits for the caller, or for the confirmation of a member who signed when nobody is awaited any more, and nothing changed since; the server judges the command again).

## Screen BID-13

`/bid/bid-13?package=` (opened from a package). A panel makes the draft (the proposals of the comparison with how many criteria the experts decided for each, a checkbox to take one out, a link to the review of the
findings of the ones not complete, the conclusion with its count) and a card for each report: the stage (waiting for the signatures, with DOC, issued, replaced, refused by DOC), the table of the decisions of the
experts with the weighted score and the mandatory criteria not met, the proposals left out, the conclusion, who signed and who is awaited, the dissent in the words of the members, the document of DOC, and the form
that signs (with the optional dissent; for the confirmation above it shows a note and no field for a dissent, since the call takes none). The seven states of the standard, the declaration owed as a notice with the way to BID-05, one signature at a time (the field of the report on its way is read-only, the other forms
are closed), the refusal shown outside the form that may disappear because of it, and the retry after a lost answer with the same version and idempotency key.

## What the database holds (V1354)

The table `evaluation_report` comes from the generated V002 with its foreign keys and an index on each id. V1354 adds `payload_ref`, `issue_event_id`, `issue_requested_at`, `issued_at`, `recalled_at`; the checks that
tie the status to its columns (a report that asked DOC says with what; one that was issued or superseded has the document and the moment, and no other has a document; a report that left DRAFT has a signature; the
shape of the JSON columns and of the hash); one request and one document for each report; and the guard `guard_evaluation_report` (the owner of the schema is not held): a report is written as a draft that nobody
signed, made from at least one run, never deleted or truncated (`machvon_app` also loses DELETE and TRUNCATE), what it is made from never changes, the payload and the document are kept, the signatures are kept once DOC
was asked, and the status moves only along `DRAFT-SIGNED_OFF`, `SIGNED_OFF-DRAFT` (a member shut out), `SIGNED_OFF-ISSUE_REQUESTED`, `ISSUE_REQUESTED-ISSUED`, `ISSUE_REQUESTED-SIGNED_OFF` (DOC refused) and
`ISSUED-SUPERSEDED`. A second trigger on `analysis_finding_review` refuses a decision about a finding of a run that is in a report that asked DOC for the minutes, has them, or was superseded (`REPORT_FROZEN`);
`BidReviewStore.review` says it first as 409 `REPORT_FROZEN`: BID 4, the final status of a finding is immutable after the report is issued.

## Assumptions and what is not here

* **Legal template [CXN-BID-03].** The template `BID-BB-DANH-GIA-HSDT` (doc type `BB`) is in the platform pack with the watermark "CHƯA XÁC NHẬN PHÁP LÝ [CXN-BID-03]": the form of the minutes under Circular 79/2025/TT-BTC
  waits for the confirmation of legal. The tenant has to publish the document type `BB` (register and symbol pattern) before DOC can number the minutes.
* **No signature of the person in DOC.** The signatures of the team are the sign-offs of this module; the legal signature of the document (the signer, the digital signature) is the signing flow of DOC, which takes the
  draft from `signer_hint`: the unit that owns the project drafts, the signer is chosen in DOC. Nothing here fakes an external signature.
* **After a refusal of DOC** the report is SIGNED_OFF with all its signatures, but the story names no operation that asks DOC again; the cause is mended (runbook) and the repeat of the request is an operation to add.
* **Minimum size of the team** is not fixed here (the law asks for three or more experts for some selections): the team is whoever holds the right, and a report needs every one of them but the ones shut out.
* **The result of the selection** (`submitProcurementResult`, `docs/bid-results.md`) still names the minutes as a document of DOC (`evaluation_minutes_document_id`); linking it to an ISSUED report is the story of the result.
* A proposal withdrawn or replaced after the draft leaves the report as it was frozen; a new draft covers what stands.
