# PAY: the cumulative ledger (ST-PAY-001, slice PAY-1)

For each contract, BOQ item and acceptance (and party of a joint venture) the ledger keeps what was **accepted**, **requested** for payment, **paid**, **recovered** from the advance and **held back**
as retention (PAY 3.1, BR-PAY-01). The figures are held by the database, not by the application: a balance is the sum of its entries, an entry is never changed or deleted, and a mistake is
corrected by an entry that reverses another. All amounts are whole dong, kept as exact decimal text (`numeric(24,0)`; the code reads them as `BigInt`, never as a float).

## Tables

| table | what it is | kept by |
|---|---|---|
| `cumulative_ledger` | one balance for `(contract, boq item, acceptance, party)`; `accepted_vnd`, `requested_vnd`, `paid_vnd`, `advance_recovered_vnd`, `retention_held_vnd`, `version` | the CHECKs below, the identity guard, the sum rule |
| `cumulative_ledger_entry` | one entry of a balance: its kind, the five deltas, the advance still to recover after it, the entry it reverses, the request that asked for it | the guards below; append-only |
| `contract` (header) | `accepted_total_vnd`, `requested_total_vnd`, `paid_total_vnd`, `advance_paid_vnd`, `advance_recovered_vnd`, `retention_held_vnd`, `retention_released_vnd` | `contract_ledger_order_chk` (accepted ≤ value, requested ≤ accepted, paid ≤ requested), `contract_cash_out_chk` (advance + paid − recovered ≤ value), `contract_advance_order_chk` |

### Rules in the database (V002 and V1562)

| rule | how |
|---|---|
| `0 ≤ paid ≤ requested ≤ accepted`; `advance_recovered + retention_held ≤ requested`; nothing below zero | `cumulative_ledger_nonneg_chk`, `…_requested_le_accepted_chk`, `…_paid_le_requested_chk`, `…_deductions_chk` |
| one balance for each `(contract, item, acceptance, party)` | `cumulative_ledger_key_uq` (nulls not distinct) |
| an entry is never changed, deleted or truncated | `REVOKE UPDATE, DELETE, TRUNCATE … FROM machvon_app` and the trigger `cumulative_ledger_entry_append_only` (`LEDGER_ENTRY_IMMUTABLE`) for any other writer |
| a balance is never deleted, and what it is about never changes | `REVOKE DELETE, TRUNCATE`; `guard_ledger_identity` |
| an entry belongs to the balance it names (contract, item, acceptance) | `guard_ledger_entry_insert` |
| an entry that reverses another is its exact opposite (all five deltas), of the kind that kind of reversal reverses, on the same balance, and once | `guard_ledger_entry_insert`, `cumulative_ledger_entry_reversal_uq`, the sign checks of V002 |
| **at every commit a balance is the sum of its entries** | deferred constraint triggers `cumulative_ledger_sum` and `cumulative_ledger_entry_sum` (`LEDGER_SUM_MISMATCH`), so the two may be written in either order inside one transaction |
| an acceptance is recognised once on each balance | partial unique index `cumulative_ledger_entry_recognize_uq` |
| every identifier is looked up with the tenant; a contract's balances and a balance's entries are read in a stable order | tenant-leading indexes (V002), `cumulative_ledger_contract_order_idx`, `cumulative_ledger_entry_ledger_order_idx` |
| tenant isolation | `FORCE ROW LEVEL SECURITY` on both tables (V002) |

The same rules are checked first in the code (`packages/kernel/src/pay-ledger.ts`: `brokenRule`, `assertLedgerInvariants`, `assertEntryShape`; 409 `VALUE_EXCEEDED` naming the rule and the figures, 422
`VALIDATION_FAILED` for a wrong sign), so a refusal is a sentence and not a constraint name. A refusal that only the database made is a defect, and raises the alert `PAY_LEDGER_CHECK_VIOLATION`.

## Kinds of entry

`RECOGNIZE_ACCEPTANCE` (accepted +), `REVOKE_ACCEPTANCE` (reverses it), `CLAIM` (requested +), `CLAIM_RELEASE`, `PAYMENT` (paid +), `PAYMENT_REVERSAL`, `ADVANCE_RECOVERY`, `ADVANCE_RECOVERY_REVERSAL`,
`RETENTION_HOLD`, `RETENTION_RELEASE`, and `ADJUSTMENT` (ST-CTR-016: the money difference of a retroactive change of price, signed, on the accepted amount only, naming the line of the adjustment it comes from; it reverses nothing and is
corrected by a later adjustment; see `docs/ctr-retroactive-adjustment.md`). This story writes the first two; the others are the entry points the claim and payment stories use through `PayLedgerStore.post`.

## Lock order

Every writer of the ledger locks the **contract row first** (the `for update` of `settle`, the same lock CTR takes when it approves or revokes), then the balances of the acceptance in the order of
their identifiers (`lockLedgerRows`, the lock rank of `ledger-registry.ts`: balance 20, entry 40). Two writers therefore never wait for each other in a circle, and parallel claims on one balance
are serialised: the second sees what the first left (a test posts ten claims of 30,000,000 on a balance of 100,000,000 and exactly three succeed). The wait for the contract is measured
(`pay_ledger_lock_wait_seconds`, alert `PAY_LEDGER_LOCK_WAIT` above 2 s).

## Recognising an acceptance (`AcceptanceLedgerConsumer`)

The consumer `pay-acceptance-ledger` takes `ctr.acceptance.approved.v1` and `ctr.acceptance.revoked.v1` through `consumeOnce` (inbox row written with the work, so a redelivery after a crash is a
counted duplicate).

* It **reads the state of the acceptance** under the lock of the contract, not the order of the events: an approval is acted on only while the acceptance is `APPROVED`, a revocation only while it is
  `REVOKED`. An approval that arrives after the revocation posts nothing; a revocation that arrives before the approval is acted on when the approval is, because the acceptance is `REVOKED` by then
  and the approval is skipped.
* The lines come from `acceptance_line` (the same rows the event describes), summed by `(item, party)`: one `RECOGNIZE_ACCEPTANCE` entry for each balance, worth the lines. Exactly one, however often and by
  whoever the event is delivered (inbox dedupe, then the unique index, then the check of the store: 30 parallel deliveries leave one set of entries).
* Revoking posts `REVOKE_ACCEPTANCE` entries that are the exact opposite of the recognitions, once. If a claim already stands on the accepted value the reversal would break
  `requested ≤ accepted`: 409 `VALUE_EXCEEDED`, nothing is posted and the event stays undelivered (CTR does not let an acceptance be revoked while a payment request holds it).
* Entries leave the audit rows `ledger.acceptance_recognized` / `ledger.acceptance_revoked` and the events `pay.ledger.acceptance_recognized.v1` / `…_revoked.v1`, in the one transaction, in the name of
  the system. The version of the contract moves (the key of every cached page).

## Reading (`getCumulativeLedger`, `GET /contracts/{id}/cumulative-ledger`, `ledger.read`)

Parameters `boq_item_id`, `acceptance_id`, `cursor`, `limit` (1 to 200, default 50). The answer (`PayCumulativeLedger`) has the contract's totals and advance, the balances of the page with their entries, the
`total` of the lines the filter keeps (all pages), `reconciled` (the balances add up to `contract.accepted_total_vnd`), `next_cursor` and `as_of`.

* A contract outside the scope of the caller, or of another tenant, is 404. A **guest of the contractor never receives the ledger**, even with the permission: 403 `SCOPE_DENIED`, no ledger field in the body.
* The page is cached by `t:{tenant}:pay:ledger:{contract}:v{contract version}:{question}`; the version moves with every entry, so an older page is never asked for again, and any `pay.*` event about the contract
  drops what is kept for it (`AcceptanceLedgerConsumer` handles them; the cache is per process and bounded by size and time).
* Budget declared in `apps/api/test/pay/cumulative-ledger.test.ts` for a ledger of 3,000 balances: p95 under 5 s cold and 1 s warm (a loaded machine runs the suites in parallel) over HTTP.

## Screen PAY-10 (`/pay/pay-10?contract=…[&item=…][&acceptance=…]`)

Read-only: the contract and its totals, the reconciliation badge, filters by item and acceptance (server side), the balances with what is still free to request, the total of the lines the filter keeps, and
the entries of each balance on demand, a reversal marked. "Show more" follows the cursor. Browser flow `apps/web/e2e/pay-ledger-flows.spec.ts`; visual region `PAY-10`.

## Observability

| signal | kind | meaning |
|---|---|---|
| `pay_ledger_lock_wait_seconds` | gauge | how long the last writer waited for the lock of a contract; alert `PAY_LEDGER_LOCK_WAIT` above 2 s |
| `pay_value_exceeded_total{rule}` | counter | entries the store refused because they would break a rule of the ledger |
| `PAY_LEDGER_CHECK_VIOLATION` | alert (event) | the database refused (SQLSTATE 23514) what the store let through |
