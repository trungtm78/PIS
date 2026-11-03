# BID_REPORT_RECALLED

**Owner:** procurement-office · **Severity:** warning · **Rule:** `alerts/rules/BID_REPORT_RECALLED.json`

## What it means

DOC recalled the minutes of an evaluation report that BID had marked ISSUED (`doc.recalled.v1`, ST-BID-012). The consumer `bid-report-issue` kept the report as it is and recorded the day of the recall (`recalled_at`, shown on BID-13); the document it was issued as stays on the record.

## What to do

1. Find out why DOC recalled it (the register of outgoing documents, DOC-14).
2. Recalled minutes must not be relied on for the result of the selection of a contractor. The findings of the report stay frozen; the evaluation team makes a new report once the cause is understood (a new report that is issued supersedes this one), and tells the authority that decides the result.
