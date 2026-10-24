# Money integrity (ST-KERNEL-072)

Shared enforcement for every ledger of the product (CAP, PAY, DIS, CTR, LND). The money rules themselves stay in the module that owns
the ledger; this page is what each of them must follow so that no mix of concurrent users can overspend a balance or claim a fact twice.

## Amounts

- An amount is a decimal string, never a JavaScript number. All arithmetic goes through `packages/kernel/src/decimal.ts`
  (`addDecimal`, `subtractDecimal`, `compareDecimal`, exact BigInt) and the helpers of `money-ledger.ts` (`debitAmount`, `creditAmount`).
- VND is whole units (`numeric(24,0)`). An amount that the column cannot hold exactly is refused with 422 `VALIDATION_FAILED`;
  it is never rounded on its way in, so no unit is created or lost. A ledger in another currency or unit declares `scale` in the registry.
- Rounding happens only where a rule asks for it (taxes, unit conversion), with `roundDecimal` and an explicit mode, before the
  amount reaches the ledger. The ledger itself only adds and subtracts.

## Balances and the row lock

- A balance row is changed only after `SELECT ... FOR UPDATE` on its `(tenant_id, id)`. `debitBalance` / `creditBalance`
  (`packages/db/src/ledger-lock.ts`) lock, read, check, write and bump the version in one transaction: the second of two parallel spends
  waits for the first, sees what it left and gets 409 `BALANCE_INSUFFICIENT` (or 409 `VERSION_CONFLICT` when it carried a version it read
  earlier).
- A transaction that touches more than one row locks them with `lockLedgerRows` (or `transferBalance`, which does): rows are locked in
  the one order table lock rank, table name, id, each once. Two transactions that lock the same rows therefore never wait for each other
  in a cycle. Never lock ledger rows in any other order.
- The database is the last guard: every amount column has a validated `CHECK (column >= 0)`, so a writer that skips the application
  check still cannot drive a balance below zero.

## Entries and reversals

- An entry table is append-only for the application role (no UPDATE, no DELETE). A correction is a new entry with the opposite signed
  delta and `reversal_of_id` pointing at the original (`reverseEntry`); the pair nets to zero (`reversalCancels`, `netOfEntries`).
- A reversal is final: a reversal is never reversed, a new forward entry is posted instead. A unique partial index on
  `(tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL` lets an entry be reversed once.
- The balance moves in the same transaction as the entry that explains it.

## Claims

- A fact that may exist once (one active payment request per acceptance) is guarded by a unique index, not by a read-then-insert.
  The insert runs inside `withUniqueClaim(tx, { constraint, code }, work)`: the loser of a race waits for the winner to commit, hits the
  constraint and gets the stable 409 code (`ACCEPTANCE_ALREADY_CLAIMED`), and the transaction stays usable.
- Different idempotency keys do not matter: the constraint decides, so two requests with different keys still produce one success.

## Ledger lint and registry

`packages/db/src/ledger-registry.ts` lists every ledger table with its kind (BALANCE or ENTRY), lock rank, non-negative columns and
business key. `ledgerReport` (`ledger-lint.ts`, run by `packages/db/test/ledger-lint.test.ts` on the migrated schema in the db lane)
fails when:

- a table named `*_ledger`, `*_ledger_entry` or `*_balance` is not declared;
- a declared table or column does not exist;
- an amount column has no validated non-negative CHECK without an OR;
- there is no unique business key (partial only where declared) or no unique `(tenant_id, id)`;
- two tables share a lock rank;
- an ENTRY table is writable for UPDATE or DELETE by the application role.

A slice that adds a ledger adds its declaration, picking the next free lock rank, in the same change as its migration.

## Concurrency harness

`packages/kernel/src/concurrency-harness.ts` (`runConcurrently`, `runLoops`, `assertOneWinner`, `tallyOutcomes`) starts N commands at
one moment, repeats the scenario M times from a reset state and names the first loop that breaks an invariant.
`packages/db/test/ledger-concurrency.test.ts` applies it to the spend, transfer and double-claim scenarios, 100 loops each.
A new ledger command adds its scenario there (or in its own suite with the same helpers).
