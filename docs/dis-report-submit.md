# DIS-5: handing in the weekly report (ST-DIS-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F1 step 8, BR-DIS-07, BR-DIS-09). Migration: `V1044__dis1_report_submit.sql`. Screen DIS-06 (`/dis/dis-06?report=<id>`) holds the button; the review it shows is the one the send is judged by.

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `post_reports_id_submit` | `POST /reports/{id}/submit` | `report.submit` | Hands a live draft in: `DRAFT` to `SUBMITTED` in one transaction, with the version the screen showed in `If-Match` and a key in `Idempotency-Key`. |

## The send

One transaction locks the report (scope of the caller, version of the screen), refuses a report that is no longer a draft, judges the period as a send is judged (a locked period takes nothing unless an approved reopening names the project: 409 `PERIOD_LOCKED`, the draft unchanged), and runs the review of BR-DIS-07. The first error of the review is the answer (409 for the state of the report or the period, 422 for the entries) naming its field, with the codes of every error in `error_codes`. Warnings do not block and come back with the answer.

What the send seals: who handed it in and when (`submitted_by`, `submitted_at`, the time of the server), whether it was late (by the calendar version the period is bound to, never a newer one), the SHA-256 of the content (`payload_hash`) and the workflow version of the review when one is published for `DIS_REPORT_REVIEW`. The trigger of V1044 fixes these for good once the report leaves the draft; the review that follows moves the status, who decided and the current mark and nothing else.

## A fall below the period before (AC-ST-DIS-005-5)

A cumulative that fell is not forced to zero and is not hidden: the send is refused (422) until `negative_delta_explanation` is given, and then goes with the warning `NEGATIVE_DELTA` and `period_delta_vnd` as it is (negative).

## Retries and races (AC-ST-DIS-005-3, -4, -6, -7)

The same key answers the first answer and changes nothing; the same key with another request is 409 `IDEMPOTENCY_CONFLICT`. Of two makers at the same version one hands in and the other is 409 `VERSION_CONFLICT` naming the version that won. One audit row `dis.report_submitted` and one event `report.submitted.v1` (key `report_revision:<id>:submitted`) are written with the report, so the relay and the inbox make a redelivery harmless. The counter `dis_submit_total` is labelled by lateness only.

## Rights (AC-ST-DIS-005-8)

The maker needs `report.submit` on the project and `report.read` to see the report: a reader and a person with no right are 403; another branch and another tenant are 404 and learn nothing (isolation case `post_reports_id_submit`; the fixture periods are bound to a real calendar version so that the owner reaches the report).
