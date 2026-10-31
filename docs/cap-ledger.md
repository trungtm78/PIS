# The capital ledger explorer (ST-CAP-014)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/CAP.md` (3.4, F9, CAP-21, UAT-AC227). No migration. Operation: `listCapitalLedger` (`GET /capital-ledger`, `capital.ledger.read`), which the contract already had; it gains the query `at` and a typed answer (`CapLedgerPage`). The ledger has no command.

## The read

`listCapitalLedger?appropriation_id=&allocation_line_id=&project_id=&at=&limit=&cursor=` lists the entries of the append-only `capital_ledger_entry`, newest first (posted moment, then id), a page at a time (the cursor is the moment and the id of the last entry). An id that is not an id, a cursor that is not one and an `at` that is neither a day nor an instant with its zone are 422 `VALIDATION_FAILED`.

- **The scope.** An entry that belongs to a project is read in the scope of the caller over that project (`capital.ledger.read` through a unit, a subtree or a project); an entry that belongs to no project, which is what the appropriation of a source of capital posts, only by someone who holds the right on the whole tenant. The balance is worked out over the same entries, so a scoped auditor's figures add up to what they see.
- **The moment.** `at` is a day (`YYYY-MM-DD`: everything posted up to the end of that day in Vietnam) or an instant with its zone (`2026-06-01T08:00:00Z`). Only the entries posted up to it count, in the page and in the balance. Without it the ledger is read up to now.
- **The balance.** The answer carries `balance` and `entry_count` for the **whole filter**, whatever the page: five columns, in whole dong. Each kind of entry moves one column up or down (`ledgerEffect` of the kernel): `APPROPRIATE` appropriated; `ALLOCATE`, `TRANSFER_IN`, `EXTEND_IN` allocated up and `REDUCE`, `TRANSFER_OUT`, `EXTEND_OUT`, `LAPSE` allocated down; `RESERVE` reserved up and `RELEASE` down; `COMMIT` committed up and `UNCOMMIT` down; `DISBURSE` disbursed up. A reversal undoes the effect of the entry it reverses. The balance is therefore exactly the sum of the entries listed (UAT-AC227: a reservation that was released once leaves nothing reserved, and the balance in between shows it reserved). `as_of` is the moment the balance is for.

## The screen (CAP-21)

`LedgerScreen`: a filter (the project, when the caller can read projects; the source of capital and the line by identifier) and the day to view ("view at the day"), the balance in five figures with the number of entries it adds up and the moment it is for, and the entries with the moment, the kind in words, the amount, the project, the reason and who posted them (a reversal says which entry it reverses), a page at a time. The only controls are the filter and the paging: nothing writes.

## What is not done

- The balance is worked out from the entries each time it is read; no snapshot of a past day is kept.
- The reservation job does not exist yet (ST-CAP-011): the reserve and release entries the screen shows are the ones other code posts.
- The filter by identifier takes the identifier of a source or a line; a picker for them is not offered.
