# SLO_SLOW_BURN

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SLO_SLOW_BURN.json`

## What it means

A core service loses requests at 6 times the rate its 99.9 percent objective allows, over the last 6 hours and over the last 30 minutes. Nothing is down, but at this rate the 30 day error budget is spent in 5 days. The fast rule does not see a leak like this. See [the SLO policy](../../slo-error-budget.md).

## What to do

1. Group the failures of the service by operation and by status for the last 6 hours; a single operation with a high share of 5xx or timeouts is the usual cause.
2. Open a defect for it in the next working day; it is not a reason to wake anyone up.
3. If the budget is close to spent, treat the fix as a reliability fix: it is allowed through the release gate when feature releases are stopped.
