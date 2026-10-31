# PAY_ADVANCE_OVERDUE

**Owner:** treasury-office · **Severity:** warning · **Rule:** `alerts/rules/PAY_ADVANCE_OVERDUE.json`

## What it means

An advance is still owed (`outstanding_vnd > 0`) after the day it had to be recovered by. A land clearance advance (GPMB) is due 30 days after it was paid (`recovery_deadline`, rule `PAY.ADVANCE.GPMB_DAYS`, CXN-12); an advance of a contract is overdue from the day its member has asked to be paid up to the threshold of recovery and still owes it, or from the day its contract was completed or terminated. The job `advance-overdue` (every morning at 06:00 Vietnam time, `docs/runbooks/jobs.md`) sets the gauge `pay_advance_overdue` over all tenants, warns each advance at 7 days before its deadline and on it (`pay.advance.alert.v1`), writes the day it became overdue and reports it once (`pay.advance.overdue.v1`, which ISS answers by opening one issue for the advance, BR-ISS-07), and a week later escalates that issue to the leader. Nothing marks an advance as recovered: only a recovery does.

## What to do

1. Open PAY-12 and filter by the level of the alert: each advance shows the contract, the member, what is still owed, the deadline, the days late and the plan that was given, if any.
2. Find who answers for the advance. A recovery that no payment makes (a compensation, a refund) is recorded in PAY-07 with its basis and its evidence (`recordAdvanceRecovery`); the next payments of the member recover the rest.
3. When the money cannot be recovered at once, the person who answers gives the plan and the day it is due (`acknowledgeAdvanceAlert`): it is kept on the advance and in the audit trail, and the amounts do not change.
4. If no issue was opened for the advance, check the category `PAYMENT` of the issue categories in master data (the intake retries, then dead-letters the event: see `INTEGRATION_INBOX_DEAD`). If the job is not running, see `docs/runbooks/jobs.md` and the alert `JOB_FAILED`; the next morning's pass counts every advance again.
5. If the days of the warning or of the escalation are wrong, the owner of the rule changes them with the business owner (CXN-12); advances already alerted keep the level they reached.
