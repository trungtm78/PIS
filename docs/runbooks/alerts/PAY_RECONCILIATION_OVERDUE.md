# PAY_RECONCILIATION_OVERDUE

**Owner:** treasury-accounting · **Severity:** warning · **Rule:** `alerts/rules/PAY_RECONCILIATION_OVERDUE.json`

## What it means

An item of difference (`reconciliation_item`) opens when the Treasury confirms an amount that is not the net of the payment request it is matched to (UAT-AC12), or when a line of a statement contradicts one taken before. It has an owner and a due day from the moment it opens. The job `reconciliation-overdue` (every hour, `docs/runbooks/jobs.md`) sets two gauges over all tenants: `pay_reconciliation_open`, the items that still wait (OPEN or EXPLAINED), and `pay_reconciliation_overdue`, those among them whose due day has passed. The first pass that finds an item overdue reports it once (`pay.reconciliation.overdue.v1`), ISS opens one issue for it and the identifier of the issue is written back on the item.

While the request is not settled the money is not counted as paid (DIS and MNE count a disbursement from the day the Treasury confirmed it, which a difference does not give), so an overdue difference is a payment that stays open in the books.

## What to do

1. Open PAY-05 and filter the items by "overdue": each shows the two figures, the signed difference, the owner and the day it was due.
2. If the owner cannot act, give the item to someone who can (`assignReconciliationItem`, with a new due day).
3. Find the cause with the Treasury and explain the item (`resolveReconciliationItem`, resolution EXPLAINED, with a note), then resolve it when the correction is made.
4. A difference that cannot be recovered is written off by someone other than the owner, with the document that approves it; the figures of the item are never edited.
5. If no issue was opened for an overdue item, check the category `PAYMENT` of the issue categories in master data (the intake retries, then dead-letters the event: see `INTEGRATION_INBOX_DEAD`). If the job is not running, see `docs/runbooks/jobs.md` and the alert `JOB_FAILED`; the next pass counts every item again.
