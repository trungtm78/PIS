# AUD_RECOMMENDATION_REOPENED

**Owner:** audit-follow-up · **Severity:** warning · **Rule:** `alerts/rules/AUD_RECOMMENDATION_REOPENED.json`

## What it means

PAY took back a recovery (`pay.recovery.reversed.v1`) that had been linked to a recommendation that was already CLOSED. The consumer `aud-pay-recovery` wrote the line of the opposite sign in the ledger of recoveries, and because what is recovered was then less than what was recommended (and the authority had not accepted a dispute that excuses the difference), the recommendation went back to IN_PROGRESS: the event `aud.recommendation.reopened.v1`, the audit row `aud.recommendation_reopened` and the alert say which. The verifier and the owner of the work are told through the event; the card of the recommendation says so on the board (AUD-07).

## What to do

1. Read the alert: the tenant, the recommendation and the recovery that was reversed. The ledger of the engagement (AUD-08) shows the two lines, the recovery and its reversal, and the figure that is left to recover.
2. Ask PAY why it was reversed (a payment that was returned, a deduction that was cancelled). If the reversal was a mistake, PAY records the recovery again; the new event links a new line and the recommendation can be reported and verified again.
3. Do not edit the status of the recommendation or delete a line: the owner does the work again and reports it, and a verifier who had no hand in it closes it, as for any recommendation.
4. A reversal that arrives for an engagement that is already CLOSED is written in the ledger and does not reopen anything; the figure is the truth, and the engagement is reopened only through its own command.
