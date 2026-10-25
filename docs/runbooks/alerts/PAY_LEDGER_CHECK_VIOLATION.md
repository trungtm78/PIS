# PAY_LEDGER_CHECK_VIOLATION

**Owner:** platform-oncall · **Severity:** critical · **Rule:** `alerts/rules/PAY_LEDGER_CHECK_VIOLATION.json`

## What it means

The consumer of the acceptance events (`pay-acceptance-ledger`) tried to post an entry on the cumulative ledger of a contract and the database refused it with a check violation (SQLSTATE 23514): one of the CHECKs of `cumulative_ledger` (`0 <= paid <= requested <= accepted`, `advance_recovered + retention_held <= requested`), the guards of `cumulative_ledger_entry` (an entry belongs to its balance; a reversal is the exact opposite of what it reverses; an entry is never changed), the sum rule (`LEDGER_SUM_MISMATCH`) or the order CHECKs of the contract header (`contract_ledger_order_chk`, `contract_cash_out_chk`).

The store checks the same rules before it writes (409 `VALUE_EXCEEDED`, counted by `pay_value_exceeded_total`), so a violation that reaches the database means a path wrote around the store or the two sets of rules have drifted apart. Nothing was posted: the transaction was rolled back and the event stays undelivered for retry.

## What to do

1. The alert names the tenant, the acceptance and the event type. Read the error of the failed delivery in the outbox (`OUTBOX_EVENT_DEAD` follows if it keeps failing) to see which constraint refused.
2. Compare the balances of the contract with its entries: `select ledger_id, sum(accepted_delta_vnd) from cumulative_ledger_entry group by 1` against `cumulative_ledger.accepted_vnd`; the two must be equal.
3. Do not edit or delete a ledger entry or a balance to make the event pass: the entries are append-only and the database refuses it. A wrong entry is corrected by an entry that reverses it, posted by the command that owns the case.
4. When the cause is a defect in the store or in a command, fix it and let the event be delivered again; the consumer is idempotent (inbox dedupe and one `RECOGNIZE_ACCEPTANCE` for each balance).
