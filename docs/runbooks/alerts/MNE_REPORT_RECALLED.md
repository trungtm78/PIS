# MNE_REPORT_RECALLED

**Owner:** monitoring-evaluation · **Severity:** warning · **Rule:** `alerts/rules/MNE_REPORT_RECALLED.json`

## What it means

DOC recalled the document of a monitoring report that MNE had marked ISSUED (`doc.recalled.v1`, ST-MNE-003). The consumer `mne-report-issue` kept the report as it is and recorded the day of the recall (`recalled_at`, shown on MNE-05 and MNE-10); the document it was issued as stays on the record.

## What to do

1. Find out why DOC recalled it (the register of outgoing documents, DOC-14).
2. A recalled report must not be relied on or exported. Correct it as a new revision (ST-MNE-007, MNE-10); if it was already exported or submitted to the national system, tell the recipient.
