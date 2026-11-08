# The risk register scored from live signals (MR.02, G1-14, screen PRJ-28)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md`. Migration `V2480__mr1_risk_signal.sql`. Story ST-PRJ-020. Operations: `getRiskSignalBoard`, `getProjectRiskSignals` (`project.read`), `listProjectRiskAlerts` (`project.risk.alert.read`), `acknowledgeProjectRiskAlert` (`project.risk.alert.acknowledge`). Error code 409 `RISK_ALERT_STATE_INVALID`.

## What it adds to PRJ-16

The register of PRJ-16 (`project_risk`) is what people write. This adds the lines the job `risk-rescore` writes from the facts of the system, and keeps one history for both:

- `project_risk_signal`: one line for each project and kind of signal, with likelihood, impact, score (likelihood x impact, 1 to 25, the same bands as PRJ-16), the evidence and the version of the rule that decided.
- `project_risk_score_history`: every score of a line (source JOB) and of a register risk (source MANUAL, written by a trigger so any command that moves a score is covered). Append-only for every role.
- `project_risk_alert`: the alert raised when a score crosses a line of the rule upwards.

## The signals

| Kind | Indicators (unit) | Read from |
|---|---|---|
| SCHEDULE_DELAY | SPI_SHORTFALL_PCT (percent), MILESTONE_SLIP_DAYS (days) | the earned value of the project (G1-4) and `project_milestone` |
| PAYMENT_INTEGRITY | PAYMENT_BLOCKED_DRAFTS, PAYMENT_SIGNAL_REQUESTS (count) | the latest integrity run of each payment request (G4-2) |
| CLAIM_EARLY_WARNING | OPEN_CLAIMS, EARLY_WARNINGS_HIGH (count) | the claim and early-warning registers of CTR when the tenant has them, and the critical warnings of the DIS |
| FUNDING_GAP | FUNDING_GAP_PCT (percent) | the registered disbursement of the plan year against the allocation of the same year |
| PROCUREMENT_DELAY | PROCUREMENT_SLIP_DAYS (days) | the milestones of the packages of the project whose contract is not signed |

A figure that could not be known is `null`, never zero: no baseline gives no SPI, no milestone no slip, no schedule for the year no funding gap, a tenant without the claim register no count of claims. A kind with no known indicator is not scored and its line is left as it was.

## The rule

Everything numeric is the governance rule `RISK_SIGNAL_POLICY` (code `DEFAULT`, owner PRJ), flagged not verified with its source and as-of day while it is the starting value: for each indicator four rising thresholds (below the first the likelihood is 1, from each threshold one more up to 5), the impact of each kind (1 to 5), the likelihood from which a line opens, the critical score (15), the jump points (6) and the statuses of the projects that are scored. The likelihood of a kind is the highest of its known indicators. The version that decided is on the line, its history and its alerts (`built-in:1` for the starting value nobody approved).

## The job

`risk-rescore`, every 3 hours, for each tenant. For each project and kind it opens a line (signal active, none or cleared before), re-scores it (likelihood or impact moved), clears it (signal fell below the opening line, likelihood 1) or keeps it (only the day it was looked at moves, no new version). Each opening, re-scoring and clearing writes a history row with the evidence, an audit row `project.risk_signal_scored` and the event `project.risk_signal_scored.v1` (with `severity`, the band) in the same transaction. Running it twice, or two runners at once, writes nothing the second time.

## The alerts

`RISK_SCORE_CRITICAL` (ACTION, owner PROJECT_OWNER, 72 hours) when a score goes up across the critical line; `RISK_SCORE_JUMP` (WATCH, 168 hours) when a line that stood rises by the jump points in one pass. Both are `ALERT_TYPE` defaults with the owner, the expected action and the consequence. An alert needs the score to go up across the line: a score that stays above it raises nothing. One alert for a subject, a type and a day; one standing critical alert at a time, resolved the day the score falls below the line (or the line is cleared, or the register risk is lowered or ended). The live risks of the register at or above the critical line get the same alert. Acknowledging an alert is a versioned command with a note; the alert, its score and its subject never change.

## The screen (PRJ-28)

The board lists the live lines and the live risks of PRJ-16 in the scope of the reader, highest score first, each with the score, the band in words, the trend against the score before (a word and an arrow), the day, the evidence and the standing alert. A project opens its lines, the history of every score and its alerts. Every number has its "i" with formula, source, as-of day and the version of the rule; the rule is marked not verified while it is the starting value.

## Hooks left for other lanes

- The alert centre reads `project_risk_alert` (lane HUBADAPT, step 4): source `PROJECT_RISK`, kinds `RISK_SCORE_CRITICAL` (ACTION) and `RISK_SCORE_JUMP` (WATCH), the open and acknowledged rows only, in the scope of the projects of the reader (in the view mine: the projects the reader answers for and what was handed over); the item opens PRJ-28 for the project. The reader is `packages/db/src/home-risk-committee-sources.ts`, the check on `work_action.source` is widened by `V2620__hub2_alert_sources.sql`.
- A signal kind of another lane (for example the claim register of GOV-8) is read through `to_regclass`, so it works before and after that lane is merged.
