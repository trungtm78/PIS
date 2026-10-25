# PAY_LEDGER_LOCK_WAIT

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/PAY_LEDGER_LOCK_WAIT.json`

## What it means

Every writer of the cumulative ledger takes the lock of the contract row first and the balances next, in the order of their identifiers (`packages/db/src/ledger-registry.ts`, lock ranks 20 and 40). The gauge `pay_ledger_lock_wait_seconds` is how long the last writer waited for the lock of its contract. Above 2 seconds (the budget of the sending of a payment request, PAY 3.1) another writer of the same contract (an acceptance, a revocation, a command of CTR or PAY: sending, checking or returning a request) held the lock for that long.

## What to do

1. Find the long transaction: `select pid, now() - xact_start as age, state, query from pg_stat_activity where state <> 'idle' order by xact_start;` and look for one that holds `machvon.contract` and has been open for seconds.
2. A transaction that waits on an external call while holding the contract is a defect: the call belongs outside the transaction.
3. Never terminate a backend that is in the middle of posting entries without checking the contract afterwards; the transaction rolls back as a whole, so the ledger stays consistent, but the event it was serving is delivered again.
4. If a single contract is hot (many parallel deliveries for the same contract), the consumer retries are harmless: the writers are serialised and the second sees what the first left.
