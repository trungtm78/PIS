# SLO_FAST_BURN

**Owner:** platform-oncall · **Severity:** critical · **Rule:** `alerts/rules/SLO_FAST_BURN.json`

## What it means

A core service (DIS, CAP, PAY, PRJ or IAM) answers valid requests with a server error or a timeout at 14.4 times the rate its 99.9 percent objective allows, both over the last hour and over the last 5 minutes. At that rate 2 percent of the 30 day error budget (43.2 minutes) goes in an hour. The alert names the service. It clears within 5 minutes after the cause is gone, because the 5 minute window must also be above the rate. See [the SLO policy](../../slo-error-budget.md).

## What to do

1. Open the SLO dashboard of the service (`slo_burn_rate`, `slo_error_budget_consumed_minutes`) and see since when it burns.
2. Look at the 5xx and timeouts of that service at the reverse proxy and at the last deployment: a deployment in the last hour is rolled back first (docs/runbooks/infra/rollback.md).
3. If a dependency is down (database, object storage, identity provider), follow its runbook in `docs/runbooks/infra`.
4. When the cause is removed, note the minutes lost in the incident record: they count against the budget whether or not they were planned.
