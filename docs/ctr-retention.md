# Release of the retention (ST-CTR-010)

CTR 3.5, BR-CTR-09, UAT-AC309, UAT-AC397, CXN-EXE-04. Screen CTR-21 (retention by BOQ line and release). The migration is `V1391__ctr1_retention_release.sql`; the module is `apps/api/src/modules/ctr`; the rules of the condition, the amount and the maker are in `packages/kernel/src/ctr-retention.ts`.

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `releaseRetention` | `POST /retention-holds/{id}/release` (If-Match) | `retention.release` | `HELD` → `PARTIALLY_RELEASED` → `RELEASED` |
| `listRetentionHolds` | `GET /contracts/{id}/retention-holds` | `ledger.read` | none |

`listRetentionHolds` is additive to the design: the table has no generic read and CTR-21 needs the holds of a contract. It is guarded like the cumulative ledger it belongs to (`ledger.read` over the contract; a contractor of the contract gets 403, a contract outside the scope 404).

Events: `ctr.retention.released.v1` (the hold, the contract, the BOQ item, the payment request, the condition, the amounts and the totals of the contract after the release) and `ctr.retention.due.v1` (the reminder of the job). The release also writes an audit row with the same facts.

## Rules

- **The condition (BR-CTR-09).** The hold carries the condition it waits for. `WARRANTY_END`: every warranty obligation of the contract is closed (ST-AST-003), and there is at least one — a contract with no warranty obligation has not ended its warranty, it has not started one (422 `RELEASE_CONDITION_NOT_MET`, reason `NO_WARRANTY` or `WARRANTY_OPEN`). `COMPLETION`: the contract is `COMPLETED` or `CLOSED` (`CONTRACT_NOT_COMPLETED`). `MANUAL_DECISION`: the decision of the authority is attached as a clean document version, now or by an earlier release of the same hold (`DECISION_REQUIRED`; 422 `DOCUMENT_NOT_CLEAN` for a file that did not pass the scan). Whatever the condition, not before the earliest day (`release_not_before`, a Vietnam calendar day; the day itself is enough): reason `NOT_BEFORE`.
- **The amount.** At least a dong and at most what is still held (422 `RELEASE_EXCEEDS_HELD` with `held_vnd`, `released_vnd`, `left_vnd`, `amount_vnd`). A release in parts is allowed: `PARTIALLY_RELEASED` while something is held, `RELEASED` when everything has been released. A hold with nothing left takes no release whatever the amount, and that is the answer before the version the caller saw: the replay of a release under a new key after it succeeded is `RELEASE_EXCEEDS_HELD` with `left_vnd` 0 and no effect (AC-ST-CTR-010-2). The same key returns the first answer and writes nothing twice (the idempotency of the command).
- **The maker.** The person who sent the payment request the money was held from (the `created_by` of the hold) does not release it: 403 `SELF_APPROVAL_DENIED`. The database holds the same rule: `released_by <> created_by`.
- **On the books.** The release is one transaction: the contract is locked first (as every command that moves the money of a contract), then the hold; the totals of the contract move (`retention_released_vnd` up by the amount, the version of the contract up, so the cached pages of the ledger are never stale) and the cumulative ledger gets an entry `RETENTION_RELEASE` of minus the amount on the balance of the BOQ item and the acceptance, with the reason. The totals keep `released <= held` (`contract_retention_order_chk`).
- **The database.** `retention_hold_guard` keeps what a hold is (contract, BOQ item, acceptance, payment request, party, amount held, condition, earliest day), never takes back what was released, lets the status move only `HELD → PARTIALLY_RELEASED | RELEASED | FORFEITED` and `PARTIALLY_RELEASED → RELEASED | FORFEITED`, and keeps a hold that is over as it is. The checks say that what was released has its author, its day and its reason, that the status says how much is released, and that the reason is not empty.
- **The job `retention-due`** (docs/runbooks/jobs.md): at 06:00 in Vietnam, once per hold, the people who hold the contract are reminded that the earliest day has come (`due_notified_on` remembers it without changing the version of the hold). It releases nothing.

## Screen

CTR-21 reads `?contract=` (as the ledger PAY-10 does) and shows the contract, what it holds back and has released, and each hold: the BOQ item, what is held, the condition with whether it is met today and, if not, what it waits for (the earliest day, the open warranty, the contract not completed, the decision missing), the earliest day, what was released and when, what is left and the status. The button to release is offered for a hold the server says the caller may release; the dialog opens with what is left, asks for a reason and, when the condition is a decision of the authority that is not attached yet, for the document; refusals are worded.
