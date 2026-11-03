# SLO_BUDGET_EXHAUSTED

**Owner:** platform-oncall · **Severity:** critical · **Rule:** `alerts/rules/SLO_BUDGET_EXHAUSTED.json`

## What it means

The 30 day error budget of a core service is spent: the minutes it was down or failing (a minute with a quarter of its requests failing counts a quarter) add up to 43.2, the share a 99.9 percent objective allows. A declared outage, including a disaster-recovery drill, counts as 100 percent failure for its whole length; the DR time and the objective are one budget. When the minutes pass 43.2 the objective is breached and the alert says so. See [the SLO policy](../../slo-error-budget.md).

## What to do

1. Feature releases are now refused by the release gate (`scripts/deploy-gate.mjs`, reason BUDGET_EXHAUSTED). Reliability and security fixes still pass, with `--kind reliability` or `--kind security`.
2. Open the post-mortem task: `node scripts/deploy-gate.mjs postmortem --repo <owner/name> --exhausted-at <time>`. It is due within 5 working days of the day the budget ran out.
3. Tell the product owner which service is frozen and until when: the freeze lifts by itself when enough bad minutes leave the 30 day window, or when the post-mortem decision says otherwise.
