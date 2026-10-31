# The alerts of the advances that are not recovered in time (ST-PAY-011)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PAY.md` (3.2 steps 4 and 5, BR-PAY-11, PAY-11, PAY-12, UAT-AC328, UAT-AC329). Migration `V1571__pay1_advance_alert.sql`. Operations: `acknowledgeAdvanceAlert` (`POST /advances/{id}/acknowledge-alert`, `advance.alert.ack`, `If-Match`) and `listOverdueAdvances` (`GET /advances/overdue`, `advance.read`), both already in the contract. The job `advance-overdue` (`docs/runbooks/jobs.md`), the alert `PAY_ADVANCE_OVERDUE` and the gauge `pay_advance_overdue`.

## The rule

An advance that is **owed** (`PAID` or `RECOVERING` with `outstanding_vnd > 0`) is looked at every morning at 06:00 Vietnam time. The pure rule is `packages/kernel/src/pay-advance-alert.ts`; the days are a working assumption until the business owner confirms them (CXN-12).

- **A land clearance advance (GPMB)** has the deadline fixed when it was paid (`recovery_deadline`, thirty days after). Level 1 goes seven days before the deadline, level 2 on it, level 3 the day after it (`overdue_since` is written as that day) and level 4 seven days after it.
- **An advance of a contract** is overdue (level 3, `overdue_since` is the day it was found) from the day its member has asked to be paid up to the threshold of recovery and still owes it, or from the day its contract is completed, terminated or closed with the advance still owed; level 4 goes a week later. It has no level 1 or 2.
- **Each level goes once.** The highest level that went is kept in `last_alert_level` (and never goes down), so a second pass sends nothing more; an advance that is first found late gets the level it is at, and the levels it missed are not sent after the fact. A fully recovered advance is not looked at.
- **What a level does.** Levels 1, 2 and 4: the audit row `pay.advance_alerted` and the event `pay.advance.alert.v1` (ids, the level, the deadline and the amount owed; the `notification` member names the contract and the person who asked for the advance). Level 3: the audit row `pay.advance_overdue` and the event `pay.advance.overdue.v1`, which the issue intake of ISS answers by opening **one** issue attributed to PAY (BR-ISS-07; the key of the event is the advance and the level). Level 4 also raises that issue to level 2 of ISS for the unit that answers for it (reason `ADVANCE_OVERDUE_ESCALATED`, `iss.issue.escalated.v1` with the leaders to tell); an issue that is not open leaves the alert as it is.
- **Nothing marks an advance as recovered.** Only a recovery (`recordAdvanceRecovery`, or the payments of the member) moves `recovered_vnd`; the job writes `last_alert_level` and `overdue_since` and does not move the version a screen holds.

## The commands and the reads

`acknowledgeAdvanceAlert` stores a **plan** and its day on an advance that is overdue and owed: `note` (1 to 2000 characters) and `action_plan_due_on` (not before today). The amounts and the status do not change. 422 `ADVANCE_NOT_OVERDUE` for an advance that is not overdue or not owed, 422 `VALIDATION_FAILED` naming the field, 409 `VERSION_CONFLICT`, 403 / 404 by the scope of the contract. The plan can be given again (the latest stands; the audit trail keeps each). The audit row carries the note as its reason; the event carries ids, amounts and the day, never the note.

`listOverdueAdvances` lists the advances in the scope of the reader that were alerted and are still owed, newest first, narrowed to one `level` (1 to 4). Every advance of PAY-07 now also carries `overdue_since`, `acknowledgement` (`note`, `action_plan_due_on`, `acknowledged_by`, `acknowledged_at`) and `actions.acknowledge_alert`; `overdue_days` counts from the day after the deadline for a land clearance advance and from `overdue_since` for an advance of a contract.

## The screens

- **PAY-12** (`AlertBoardScreen`): the board of the advances under alert, narrowed by level (`?level=`), with the contract, the member, what is owed, the deadline, the days late, the level and the plan. Buttons: record a recovery (the dialog of PAY-07) and record a plan.
- **PAY-11** (`RequestAdvanceScreen`): the form of `requestAdvance` (contract in force, member, kind, amount, line of capital, optional tranche). The cap and the guarantee are not asked for: the server finds the guarantee that covers and works the cap out, says in words why it refuses (`ADVANCE_CONTRACT_NOT_EFFECTIVE`, `ADVANCE_GUARANTEE_REQUIRED` with the reason, `ADVANCE_CAP_EXCEEDED` with the cap, `ADVANCE_RULE_UNCONFIRMED`, `ADVANCE_OUTSTANDING_PRIOR`, `VALUE_EXCEEDED`), and the screen shows the cap it gave and whether the rule still waits for its confirmation.

## What is not done

- No consumer turns `pay.advance.alert.v1` into a notification yet: the event carries the `notification` member and waits for a published workflow of NOT.
- The days of the warning and of the escalation are not read from the rule `PAY.ADVANCE.GPMB_DAYS` beyond the deadline the payment fixed (CXN-12).
- Cancelling a planned advance stays in PAY-07.
