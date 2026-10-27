# MNE_REPORT_ISSUE_REJECTED

**Owner:** monitoring-evaluation · **Severity:** warning · **Rule:** `alerts/rules/MNE_REPORT_ISSUE_REJECTED.json`

## What it means

MNE asked DOC to issue an approved monitoring report (`mne.report.issue_requested.v1`, ST-MNE-003) and DOC answered `doc.rejected.v1`: it refused the request (the template is missing or not in force on the day, the payload does not fit the template, the hash of the payload is not the one sent) or the draft it made was cancelled before it was issued. The consumer `mne-report-issue` put the report back to APPROVED; the alert says the tenant, the report, the form and the reason (`rejectCode`). The figures and the hash of the report stay as they were frozen.

## What to do

1. Read the reason in the alert and in the audit row `mne.report_issue_rejected`.
   - `DOC_TEMPLATE_MISSING` or `TEMPLATE_NOT_EFFECTIVE`: the template named by the form (`doc_template_code`) is not published, or not in force on the day. Ask the DOC owner to publish it, or publish a new revision of the form that names a template in force (the template watermark waits for CXN-10).
   - `PAYLOAD_HASH_MISMATCH`: the file DOC read is not the one MNE stored. Do not retry by hand; open an incident, the file store may have been altered.
   - `PAYLOAD_SCHEMA_INVALID`: the payload lacks a field of the template, or the drafting unit does not exist. Fix the template or the unit; the payload of a report cannot be changed after approval (it is frozen), so a report whose payload is wrong is corrected as a new revision.
   - A cancelled draft: the drafter in DOC withdrew it. Ask why before asking again.
2. Ask for the issue again from MNE-05 once the cause is mended. The same payload and hash are sent with a new event id.
