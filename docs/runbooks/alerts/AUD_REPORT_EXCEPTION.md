# AUD_REPORT_EXCEPTION

**Owner:** audit-follow-up · **Severity:** warning · **Rule:** `alerts/rules/AUD_REPORT_EXCEPTION.json`

## What it means

The consumer `aud-follow-up-report` received an event of DOC (`doc.issued.v1`, `doc.rejected.v1` or `doc.recalled.v1`) that names a report of AUD but did not apply it as it stood, or applied it and found something to be looked at. The audit row `aud.report_exception` and the alert carry the reason:

- `HASH_MISMATCH`: the payload hash in the event is not the one frozen with the report. The report is **not** moved. Either DOC issued something other than what AUD asked for, or the event was altered.
- `DOCUMENT_MISSING` or `REASON_MISSING`: the event lacks the document or the reason, so it cannot be applied.
- `STATE_UNEXPECTED`: the event does not fit the state of the report (for example an issue after a rejection). The report is not moved.
- `SELF_ISSUED`: the report was issued, but the signer DOC names is the person who asked for it. The report is ISSUED with the document, and no approver is recorded (the table keeps the two apart).
- `SIGNER_UNKNOWN`: the report was issued and the event did not name a signer.

## What to do

1. For `HASH_MISMATCH` and `STATE_UNEXPECTED` compare the document in DOC with the payload stored under the `payload_ref` of the report; if they differ, do not close the engagement on this report and open an incident with the DOC owner.
2. For `SELF_ISSUED` decide with the inspection coordinator whether the issue stands; a second person can approve the next revision. Nothing is edited by hand.
3. The report keeps its figures and its hash whatever happens; it is replaced only by a new revision.
