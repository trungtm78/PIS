# CAP_BALANCE_DRIFT

**Owner:** capital-accounting · **Severity:** critical · **Rule:** `alerts/rules/CAP_BALANCE_DRIFT.json`

## What it means

The job `capital-balance-reconcile` (every night at 02:00 Vietnam time, `docs/runbooks/jobs.md`) adds up the entries of the capital ledger (`capital_ledger_entry`) for each appropriation of a project and compares them with the sum of the balances of its lines (`allocation_balance`): the allocated amount (ALLOCATE, REDUCE, TRANSFER and EXTEND pairs, LAPSE), the committed amount (COMMIT less UNCOMMIT) and the disbursed amount (DISBURSE). A reversal counts as the opposite of the entry it undoes. The gauge `cap_balance_drift_vnd` (labelled with the tenant) is the sum of the differences without their sign; the alert fires when it is above zero. The job **never changes a balance or an entry**: it reports.

For every appropriation that differs, the job writes the audit row `cap.balance_drift_detected` and the event `cap.balance.drift_detected.v1` (once a day for each appropriation), with the project, the columns and both figures. The reserved amount is not compared yet: the reservation of funds posts no entries.

## What to do

1. Read the audit row or the event for the appropriation: the column that differs, the figure of the ledger and the figure of the balance, and the sign of the difference (`balance - ledger`).
2. Find the entries that explain the balance: `select entry_type, amount_vnd, source_ref_kind, source_ref_id, posted_at from capital_ledger_entry where allocation_line_id = '<line>' order by posted_at`. A committed amount that is too high on the balance is usually a commitment whose entry was not written; a disbursed amount that is wrong usually means a payment event that is dead (`OUTBOX_EVENT_DEAD`, consumer `cap-payment-ledger`) or a settlement that was fixed by hand.
3. Do not edit a balance or delete an entry to make the figures agree: the entries are append-only and the balance follows them. The ledger is the record. A wrong entry is undone by a reversal posted through the command that owns the fact; a payment event that did not reach CAP is delivered again (the consumer is idempotent).
4. When the cause is a defect, fix it; the next night's run sets the gauge back to zero once the figures agree.
5. The procedure to reverse a payment posting is the reversal of the payment itself (PAY-08, `docs/pay-reversal.md`): the refund of the Treasury arrives as an event and CAP takes the disbursement back; it is never done by editing CAP.
