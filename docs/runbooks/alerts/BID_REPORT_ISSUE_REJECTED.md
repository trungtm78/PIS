# BID_REPORT_ISSUE_REJECTED

**Owner:** procurement-office · **Severity:** warning · **Rule:** `alerts/rules/BID_REPORT_ISSUE_REJECTED.json`

## What it means

Every member of the evaluation team signed an evaluation report, BID asked DOC to issue its minutes (`bid.report.issue_requested.v1`, ST-BID-012) and DOC answered `doc.rejected.v1`: it refused the request (the template is missing or not in force on the day, the payload does not fit the template, the hash of the payload is not the one sent) or the draft it made was cancelled before it was issued. The consumer `bid-report-issue` put the report back to SIGNED_OFF; the alert says the tenant, the report and the reason (`rejectCode`). The signatures, the dissent and the hash of the report stay as they were frozen.

## What to do

1. Read the reason in the alert and in the audit row `bid.report_issue_rejected`.
   - `DOC_TEMPLATE_MISSING` or `TEMPLATE_NOT_EFFECTIVE`: the template `BID-BB-DANH-GIA-HSDT` is not published, or not in force on the day. Ask the DOC owner to publish it (its watermark waits for CXN-BID-03).
   - `PAYLOAD_HASH_MISMATCH`: the file DOC read is not the one BID stored. Do not retry by hand; open an incident, the file store may have been altered.
   - `PAYLOAD_SCHEMA_INVALID`: the payload lacks a field of the template, is too long, or the drafting unit (the unit that owns the project) does not exist. Fix the template or the unit; the payload of a report cannot be changed once it is frozen.
   - A cancelled draft: the drafter in DOC withdrew it. Ask why before asking again.
2. Asking again is not an operation of the story yet: the report waits in SIGNED_OFF. Record the cause in the incident and ask the BID owner for the repeat of the request (the same payload and hash are sent with a new event id).
