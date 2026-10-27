# Review, approval and issuance of the monitoring report (ST-MNE-003)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F3, section 4), `DOC.md` section 9 (BR-DOC-17). Migration `V1703__mne1_report_issue_workflow.sql`. Operations: `decideMneReport`, `requestMneReportIssue` (and `getMneReport`, which now shows the document). Screen: MNE-05. Events: `mne.report.approved.v1`, `mne.report.returned.v1`, `mne.report.issue_requested.v1`, `mne.configuration_alert.v1`, and from the consumer `mne.report.issued.v1`, `mne.report.issue_rejected.v1`, `mne.report.recalled.v1`.

## The road

`IN_REVIEW` -> `APPROVED` -> `ISSUING` -> `ISSUED`. The module never marks a report issued by itself: `ISSUED` comes only from `doc.issued.v1`.

- **Decide** (`mne.report.approve`, versioned, in the units of the grant): `approve` or `return`, with a reason of 5 to 2000 characters (422 `VALIDATION_FAILED` on `reason`). Approving is **403 `SELF_APPROVAL_DENIED`** for the person who wrote the report and for the one who handed it in (the same two rules are in the table: `approved_by` differs from `created_by` and from `submitted_by`). A return sends the report back to its preparer as a `DRAFT`; the decision, the day and the words stay on the report. A report that is not in review is 409 `REPORT_STATE_INVALID` naming the state.
- **Request issue** (`mne.report.issue`, versioned): only an `APPROVED` report. The payload DOC prints is built from the report (`title`, `period`, `body` with one line per cell, `agency`, `place`; money with dots, percent with its sign, a dash for an empty cell), its SHA-256 is **frozen** with it (`payload_sha256`, `payload_ref`, `issue_event_id`), the payload is written to the file store of DOC under `tenants/<tenant>/mne/reports/<id>/r<revision>.json`, and the event `mne.report.issue_requested.v1` carries `source_module` MNE, `source_ref` `MNE:mne_report:<id>:r<revision>`, the template code of the form, the reference and the hash. The report is `ISSUING`. The hash and the document are never changed afterwards (trigger).
- **Template missing** (AC-ST-MNE-003-2): when the form names a template that DOC does not have (it was retired after the form was published), the command commits an audit row `mne.report_issue_blocked` and an event `mne.configuration_alert.v1` (audience `FORM_ADMINISTRATOR`) and answers **422 `DOC_TEMPLATE_MISSING`**; the report stays `APPROVED` and nothing else is written.

## What DOC answers

The consumer `mne-report-issue` (`apps/api/src/modules/mne/report.consumer.ts`) reads `doc.issued.v1`, `doc.rejected.v1` and `doc.recalled.v1` that name `source_module` MNE. It believes an answer only when it names a report of the tenant by its reference and carries **the hash that was frozen** with it.

| Answer | Effect |
| --- | --- |
| `doc.issued.v1` with the document | `ISSUING` -> `ISSUED`, with `doc_document_id` and `issued_at`; the gauge `mne_issue_latency_seconds` takes the seconds since the approval |
| `doc.rejected.v1` with the reason | `ISSUING` -> `APPROVED`; alert `MNE_REPORT_ISSUE_REJECTED`; the request can be made again (same payload and hash, a new event id) |
| `doc.recalled.v1` | the report keeps its state and its document; `recalled_at` is set and the alert `MNE_REPORT_RECALLED` is raised: a correction is needed (ST-MNE-007) |

Another hash (or a report that was not asked for issue), an answer without its document or reason, or one that does not follow the state of the report changes nothing, is audited (`mne.report_exception`) and raised (`MNE_REPORT_EXCEPTION`). One delivery changes the report once; the same answer twice is a counted duplicate (`mne_report_event_total`). Runbooks: `docs/runbooks/alerts/MNE_REPORT_*.md`.

## Screen MNE-05

Opened from the reports of the year that wait for a decision, for issue, with DOC or issued (`?report=<id>`). It shows the content (read-only), the decision form (a reason of five characters at least, **approve** and **return**; hidden with the reason when the person wrote or handed in the report), the request for issue with the frozen hash, and **the live state of the document** as four stages (**being drafted, waiting for signature, numbered, issued**; none yet, or cancelled or recalled). While the report is `ISSUING` the screen reads it again every five seconds. A refusal is said in words (self-approval, version conflict, state, template missing). The seven standard states are the shared ones.

## Assumptions and limits

- The configuration alert for the form administrator is an outbox event and an audit row; its delivery as a notification to the holders of `mne.form.manage` belongs to the notification stories (NOT-004..006).
- `doc.recalled.v1` does not change the status (the table has no recalled state in MNE 3.1 section 4): the report carries `recalled_at` and a correction replaces it.
- The place of issue is in no record of the tenant: the payload carries a dash, which DOC's drafter completes before the document goes out (as AUD does).
- The signer is chosen in DOC from the drafting unit (`signer_hint.drafting_unit_id` is the unit of the report); the approver of MNE is not the signer.
