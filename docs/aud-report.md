# AUD-5: the report of the results issued through DOC, and the closure of the engagement (ST-AUD-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/AUD.md` (sections 3.6 F6, 4, 5, BR-AUD-04, BR-AUD-10), `DOC.md` F2 (the issue port for source modules). Migration: `V1324__aud1_follow_up_report.sql`. Screen AUD-10 (`/aud/aud-10?engagement=<id>`), linked from AUD-03.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `requestAuditFollowUpReport` | `POST /audit-engagements/{id}/follow-up-reports` (If-Match of the engagement) | `aud.report.issue` over the scope of the engagement | Computes the figures of a conclusion as of a day, freezes them, stores the payload and asks DOC to issue it. |
| `closeAuditEngagement` | `POST /audit-engagements/{id}/closure` (If-Match) | `aud.engagement.close` over the scope of the engagement | FOLLOW_UP to CLOSED when nothing is open and DOC issued a report of every conclusion that stands; releases the hold. |
| `listAuditFollowUpReports` | `GET /audit-engagements/{id}/follow-up-reports` | `aud.read` | The reports with their frozen figures, hash, state, document, and who asked and approved. |

The request body is `{conclusion_id, as_of_date}` as the plan says, with two optional members the head of a Vietnamese state document needs and no record of the tenant holds: `place` (the locality; a dash when nobody says it, for the DOC drafter to complete) and `drafting_unit_id` (the only unit the engagement is about when it is about one, else it must be named; the unit's name is the agency of the head).

## The figures (AC-ST-AUD-005-1, BR-AUD-04)

`reportTotals(asOf, rows)` in `packages/kernel/src/aud-report.ts`: a recommendation counts as it stood on the day. Cancelled ones and ones given after the day do not count; one closed after the day was still in progress on it; the money recovered is the sum of the ledger lines recorded up to the day. The totals are `closed`, `in_progress`, `open`, `disputed`, `total`, `amount`, `recovered`, `remaining` (dong as decimal text) and the two rates, each with numerator and denominator (not applicable, never 0%, when nothing was recommended). R1 and R3 closed and R2 in progress with 1,200,000,000 recommended and 1,100,000,000 recovered give `closed: 2`, `in_progress: 1`.

## Frozen, hashed, issued by DOC

- The payload is scalars only (`reportPayload`): the head (`agency`, `place`), the engagement, the conclusion and the figures with the dong written with dots and the rates with a comma. The legal wording is the template's, `AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI` (`apps/api/src/modules/doc/template-pack.json`, group AUDIT_FOLLOWUP, watermarked "not legally confirmed" until CXN-AUD-02 is confirmed). The amount is not under `amount_vnd`, which DOC reads for the delegation of the signer.
- The payload is written once to the file store of DOC under `tenants/<tenant>/aud/follow-up-reports/<id>/r<revision>.json` and its SHA-256 (`payloadSha256`, canonical) is kept with the report. The table refuses to change the totals, the hash, the day, the revision, the payload reference and the event afterwards (`audit_follow_up_report_frozen_guard`) and never deletes a report.
- The event `aud.report.issue_requested.v1` is what DOC reads as a request (`ISSUE_REQUEST_EVENTS`; the source module defaults to AUD), with `source_ref` `AUD:audit_follow_up_report:<id>:r<revision>`, the template, the payload reference and hash, the event id, the drafting unit as the signer hint and the authority as the recipient. DOC reads the payload, computes the hash again and drafts or rejects.
- One live report for a conclusion and a day: another is 409 `FOLLOW_UP_REPORT_EXISTS` (with the report) while one waits for DOC or is issued; after REJECTED or RECALLED the next request is revision 2.

## What DOC answers (AC-ST-AUD-005-2)

The consumer `aud-follow-up-report` (`apps/api/src/modules/aud/report.consumer.ts`) reads `doc.issued.v1`, `doc.rejected.v1` and `doc.recalled.v1` that name `source_module` AUD and a report by its reference. It believes an answer only when the hash is the one frozen: ISSUED keeps the document and the signer DOC names as the approver (not the person who asked: then ISSUED with no approver and the alert `AUD_REPORT_EXCEPTION`), REJECTED keeps the reason (alert `AUD_REPORT_REJECTED`), RECALLED follows an issued report. A different hash, an answer out of order or without its document is kept out, audited as `aud.report_exception` and raised; the same answer twice is a counted duplicate (`aud_report_event_total`).

## The closure (BR-AUD-04, BR-AUD-10)

`closeAuditEngagement` locks the engagement, then reads the facts: 409 `OPEN_RECOMMENDATIONS_REMAIN` (with the count) while a recommendation is neither CLOSED nor CANCELLED, then 422 `FOLLOW_UP_REPORT_MISSING` while a conclusion that stands (not SUPERSEDED) has no ISSUED report. The day is from the start to today. The hold is released in the same transaction as the system. A reversal of a recovery re-reads the engagement under a share lock before it reopens a recommendation, so a closure and a reversal at once end one way or the other and never leave a reopened recommendation under a closed engagement.

## Who sees what (AUD 2, BR-AUD-11)

Every path goes through the scope of the engagement: outside it, or in another tenant, is 404; a reader of the engagement without the permission is 403. The trail and the events keep ids, codes, days, counts and the hash, never the words of the engagement.

## The screen

AUD-10 shows the engagement (status, closed day, links to its file and its ledger), the rule of the closure, and a table of the reports: day and revision, conclusion, the frozen counts and money with the two rates and their numerators and denominators, the hash (12 characters, the whole in the title), the state with DOC's reason in words, the document, who asked and who approved. The request dialog asks for the conclusion, the day (not before the conclusion was received, not in the future), the place and the drafting unit; the closure dialog asks for the day and says what closing does. Every refusal of the server is told in words, the open count included.

## Tests

`packages/kernel/test/aud-report.test.ts`, `packages/db/test/aud-report-store.test.ts` (the triggers, the revisions, the race of two requests, the closure and its lock against a reversal), `apps/api/test/aud/report.test.ts` (including DOC accepting the event and drafting from the template), `apps/api/test/aud/report.consumer.test.ts`, the authz negative matrix and the tenant-isolation suites, `apps/web/src/screens/aud/report/*.test.ts(x)`, and the browser flows `apps/web/e2e/aud-report-flows.spec.ts`.

## Decisions kept in `TODOS.md`

The closure asks for a report issued for each conclusion that stands, not for one issued after the last recommendation was closed (the plan says "a report ISSUED"); the e2e stack has no DOC drafter, so DOC's answers are written to the outbox as DOC writes them.
