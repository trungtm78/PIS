# PAY_SETTLEMENT_OVERDUE

**Owner:** settlement-office · **Severity:** warning · **Rule:** `alerts/rules/PAY_SETTLEMENT_OVERDUE.json`

## What it means

A settlement of a project, a year or a contract (PAY-15) was sent and is still SUBMITTED or VERIFYING after the last day of its verification (`verification_due_on`). That day is the day of the submission plus the days the rule `PAY_SETTLEMENT_DEADLINE` gives the group of the project on that day; it is fixed when the settlement is sent and a later change of the rule does not move it. The job `settlement-deadline` (every morning at 06:00 Vietnam time, `docs/runbooks/jobs.md`) sets the gauge `pay_settlement_overdue` over all tenants, reminds each settlement 30 days and 7 days before its day (`pay.settlement.deadline_approaching.v1`) and reports it once when the day has passed (`pay.settlement.overdue.v1`), which ISS answers by opening one issue for the settlement (BR-ISS-07).

## What to do

1. Open PAY-15 and filter by the status SUBMITTED or VERIFYING: each settlement shows the group, the day it was sent, the deadline and the days left (negative when late).
2. Find who holds the file. A settlement that waits to be taken up needs an officer other than the one who sent it (`recordSettlementVerification`, outcome VERIFYING); one that is being verified needs the findings and the outcome VERIFIED or RETURNED.
3. A settlement that cannot be verified is given back with the findings (RETURNED); it is read again from the ledgers and sent again, and the new deadline runs from the new day.
4. If no issue was opened for a late settlement, check the category `PAYMENT` of the issue categories in master data (the intake retries, then dead-letters the event: see `INTEGRATION_INBOX_DEAD`). If the job is not running, see `docs/runbooks/jobs.md` and the alert `JOB_FAILED`; the next morning's pass counts every settlement again.
5. If the days of a group are wrong, the owner of the rule publishes a new version of `PAY_SETTLEMENT_DEADLINE` (key `VERIFY_DEADLINE`); settlements already sent keep the deadline they were given.
