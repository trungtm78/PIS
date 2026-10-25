# CAP_LEDGER_CHECK_VIOLATION

**Owner:** platform-oncall · **Severity:** critical · **Rule:** `alerts/rules/CAP_LEDGER_CHECK_VIOLATION.json`

## What it means

The consumer of the payment events (`cap-payment-ledger`) tried to post an entry on the capital ledger and the database refused it with a check violation (SQLSTATE 23514): a CHECK of `allocation_balance` (`allocated >= committed + disbursed`, no negative amount), the guard of the reversal of a payment entry (a reversal undoes one entry, of its line, for its whole amount) or the rule that an entry of a payment has a line and a project.

The store checks the same rules before it writes (409 `BALANCE_INSUFFICIENT`), so a violation that reaches the database means a path wrote around the store or the two sets of rules have drifted apart. Nothing was posted: the transaction rolled back and the delivery stays for retry.

## What to do

1. The alert names the tenant, the event type and the event id. Read the failed delivery in the outbox (`OUTBOX_EVENT_DEAD` follows if it keeps failing) for the constraint that refused.
2. Compare the line with its entries: the balance columns against the sums in `docs/runbooks/alerts/CAP_BALANCE_DRIFT.md`.
3. Do not edit or delete a ledger entry or a balance to let the event through. Fix the cause and let the event be delivered again; the consumer is idempotent (inbox row and the key of the entry).
