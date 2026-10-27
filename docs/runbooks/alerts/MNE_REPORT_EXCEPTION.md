# MNE_REPORT_EXCEPTION

**Owner:** monitoring-evaluation · **Severity:** warning · **Rule:** `alerts/rules/MNE_REPORT_EXCEPTION.json`

## What it means

The consumer `mne-report-issue` received an event of DOC (`doc.issued.v1`, `doc.rejected.v1` or `doc.recalled.v1`) that names a monitoring report but did not apply it. The audit row `mne.report_exception` and the alert carry the reason:

- `HASH_MISMATCH`: the payload hash in the event is not the one frozen with the report (or the report was never asked for issue). The report is **not** moved. Either DOC issued something other than what MNE asked for, or the event was altered.
- `DOCUMENT_MISSING` or `REASON_MISSING`: the event lacks the document or the reason, so it cannot be applied.
- `STATE_UNEXPECTED`: the event does not fit the state of the report (for example an issue after a rejection, or a refusal after the report was issued). The report is not moved.

## What to do

1. Find the report in the alert (`reportId`) and the event (`eventId`) in the outbox of DOC.
2. For `HASH_MISMATCH`, compare the hash of the document in DOC with `payload_sha256` of the report. If they differ, open an incident: nothing issued by DOC for this report may be relied on until it is explained. Never mark the report issued by hand.
3. For the other reasons, ask the DOC owner to send the event again with its document or reason, or to cancel the draft.
