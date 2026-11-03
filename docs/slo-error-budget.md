# SLO, burn-rate alerts and the error budget (ST-KERNEL-052)

The five core services (DIS, CAP, PAY, PRJ and IAM) have one objective: 99.9 percent of valid requests answered over 30 days (NFR-AVAILABILITY-01). That is a budget of 43.2 minutes of full outage in the window. The budget is
measured, shown on a dashboard, watched by two burn-rate alerts, and when it is spent the release pipeline stops feature releases. The time of a disaster-recovery drill is taken from the same budget. Nothing here is a commercial
SLA: its terms (D10) are outside this story.

Code: `packages/kernel/src/slo.ts` (the measure, the rules and the report), `scripts/deploy-gate.mjs` (the release gate), `infra/pipelines/production.json` (`errorBudget`, the policy), `alerts/rules/SLO_*.json` (the alerts).

## What is measured (the SLI)

One bucket for each minute and service: `{ minute, total, bad }`, fed from the metrics of the reverse proxy. A response is **bad** when it is a server error (5xx) or the request timed out (`isBadResponse`); everything else is good,
including 4xx answers (a refused request is the platform doing its job) and 429 (a tenant over its quota is throttled on purpose). A minute costs the share of its requests that failed: a minute in which a quarter of the requests
failed costs 0.25 minutes of budget. A minute with no request costs nothing.

## The budget and the dashboard figures (`budgetStatus`, `reportSlo`)

`budgetStatus` takes the buckets, the declared outages and the minute now, and gives the budget (43.2 minutes), the minutes consumed over the last 30 days, the minutes left and their percentage (negative once overspent), the
availability, `exhausted` (consumed has reached the budget) and `breached` (consumed is above it: the objective was missed), and the minute at which the running total reached the budget.

`reportSlo` runs once a minute for a service and publishes what the dashboard shows as gauges of that service:

| gauge | meaning |
|---|---|
| `slo_error_budget_consumed_minutes` | minutes of budget consumed in the last 30 days |
| `slo_error_budget_remaining_percent` | what is left, in percent of the budget |
| `slo_burn_rate{window}` | burn rate over each window (60m, 5m, 360m, 30m) |

So a 3 minute outage in which every request fails shows 3 minutes consumed, 93 percent left.

## Burn-rate alerts

A burn rate is how many times faster than the objective allows the budget is being spent: 1 spends exactly the budget in 30 days. A rule fires only while its **long window and its short window are both** at or above its rate. The long
window says the loss is real; the short one that it is still going on, which is why the alert clears within the short window once the cause is gone.

| alert | rate | windows | severity | what it catches |
|---|---|---|---|---|
| `SLO_FAST_BURN` | 14.4 | 60 minutes and 5 minutes | critical | 2 percent of the budget in an hour: an outage, a bad release |
| `SLO_SLOW_BURN` | 6 | 360 minutes and 30 minutes | warning | a leak that spends the budget in 5 days |
| `SLO_BUDGET_EXHAUSTED` | | | critical | the budget is spent; the context names the service and the figures |

A total outage burns at 1000 times, so the long window passes 14.4 in under a minute and the fast alert fires within the first minutes. A burn at exactly 14.4 times fires once the long window is full (an hour of it), because the
alert is about a loss that is real, not a blip. The rules are operations alerts delivered by webhook, never through the notification module (`docs/runbooks/alerts/README.md`).

## Declared outages and the DR drill (AC-ST-KERNEL-052-3)

A period in which the service was down by decision or by drill is declared as `{ startMinute, minutes, reason }`. Every minute of it costs a whole minute, whatever the buckets show (a cache that kept answering, retries that
succeeded) and without counting twice where the buckets also show failures. A 4 hour DR drill therefore consumes 240 minutes against a budget of 43.2: the budget is exhausted, the objective is breached (`breached`, availability
99.44 percent), and `SLO_BUDGET_EXHAUSTED` is raised. There is no exemption for planned work: the DR time and the objective are one budget.

## The error-budget policy in the pipeline (AC-ST-KERNEL-052-2)

`budgetReport(entries, generatedAt)` turns the statuses into the JSON the pipeline reads: `exhausted` (any service spent), `exhaustedAt` (the earliest moment a service reached the budget) and the figures of each service. The
workflow fetches it from the repository variable `SLO_BUDGET_REPORT_URL` before the gate, and again after the approval, because the budget can be spent while approvers decide.

`node scripts/deploy-gate.mjs check ... --kind <feature|reliability|security> --budget-report <file>` (the kind is the new input `kind` of the workflow, default `feature`):

| situation | result |
|---|---|
| `reliability` or `security`, whatever the budget or the report | allowed: a fix is how the budget is earned back |
| `feature`, budget not spent, report fresh | allowed |
| `feature`, budget spent | refused `BUDGET_EXHAUSTED`, naming the day it ran out and the day the post-mortem is due |
| `feature`, no readable report, or one older than `maxReportAgeMinutes` (15) | refused `BUDGET_UNKNOWN` / `BUDGET_STALE`: a gate that cannot see the budget cannot vouch for it |
| any other kind | refused `KIND_UNKNOWN` |

`node scripts/deploy-gate.mjs postmortem --repo <owner/name> --budget-report <file>` opens the post-mortem task as an issue labelled `post-mortem`, titled with the day the budget ran out, once (a second call finds it and opens
nothing), stating the day it is due: **5 working days** after the day the budget ran out, counted Monday to Friday on the calendar of Vietnam (UTC+7). Public holidays are not known to the script, so a holiday can only make the
real deadline later than the stated one. The gate job of the workflow runs it after the check, whatever the result of the check was.

`npm run infra:check` fails (`PIPELINE_ERROR_BUDGET`) when `infra/pipelines/production.json` does not block feature releases, does not allow both kinds of fix, lets one kind be both, has no maximum report age, or lets the
post-mortem wait more than 5 working days (`infra/policies/operations.json`).

## What is not built here

- The export that feeds the buckets from the reverse proxy and posts the budget report to `SLO_BUDGET_REPORT_URL` belongs to the deployment of the observability component (`infra/components/observability.json` is still `PLANNED`). Until the variable is set, a feature release with a configured production target is refused by the gate (`BUDGET_UNKNOWN`); fixes pass.
- The SAS-18 health screen still lists the SLO as an indicator without a source (`sas.health.pending.slo`); it can show the report when the export exists.
