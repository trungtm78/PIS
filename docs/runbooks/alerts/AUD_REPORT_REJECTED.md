# AUD_REPORT_REJECTED

**Owner:** audit-follow-up · **Severity:** warning · **Rule:** `alerts/rules/AUD_REPORT_REJECTED.json`

## What it means

AUD asked DOC to issue the report of the results of the recommendations of an engagement (`aud.report.issue_requested.v1`, ST-AUD-005) and DOC answered `doc.rejected.v1`: either it refused the request (the template is missing or not in force, the payload does not fit the template, the hash of the payload is not the one sent) or the draft it made was cancelled before it was issued. The consumer `aud-follow-up-report` moved the report to REJECTED with the reason DOC gave; the alert says the tenant, the report and the reason (`rejectCode`). The figures of the report stay as they were frozen.

## What to do

1. Read the reason on AUD-10 (the row of the report) and the alert.
   - `DOC_TEMPLATE_MISSING` or `TEMPLATE_NOT_EFFECTIVE`: the template `AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI` is not published, or not in force on the day. Ask the DOC owner to publish the template (its legal confirmation is separate, CXN-AUD-02).
   - `PAYLOAD_HASH_MISMATCH`: the file DOC read is not the one AUD stored. Do not retry by hand; open an incident, the file store may have been altered.
   - `PAYLOAD_SCHEMA_INVALID`: the payload lacks a field of the template, or the drafting unit does not exist. Fix the data (the unit, the conclusion symbol) and request a new revision.
   - A cancelled draft: the drafter in DOC withdrew it. Ask why before drafting again.
2. Request a new revision from AUD-10 for the same conclusion and day; it takes the next revision number and freezes the figures again. A rejected report is never issued afterwards.
3. The engagement cannot be closed until a report of each conclusion is ISSUED.
