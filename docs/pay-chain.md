# The trace of a payment (ST-PAY-010)

PAY 3.4, UAT-AC67. Screen PAY-17 (the trace, read only). One operation: `getPaymentChain` (`GET /payment-chain?project_id=…&contract_id=…`, permission `payment.chain.read`, in the scope of the caller over the project).

## What it returns

The chain of a project, or of one of its contracts when `contract_id` is given, as nodes and edges:

| Node (`type`) | Where it comes from | `version` / `revision` |
|---|---|---|
| `project` | the project | version of the row |
| `contract` | each contract of the project (at most 50), with the revision in force | version of the row, `revision` of the contract |
| `measurement` | every measurement an acceptance of the contract rests on, and every revision of it that was corrected (the one replaced is `superseded`) | version of the row, `revision` of the measurement |
| `acceptance` | every acceptance of the contract | version of the row |
| `payment_request` | every payment request of the contract, with its gross (`amount_vnd`) and its net | version of the row |
| `treasury_transaction` | every transaction matched to those requests (the payment and a refund) | none: a Treasury transaction has no version, it never changes but for its match |
| `settlement_revision` | every settlement of the project or of the contract, the replaced ones marked | version of the row, `revision` of the settlement |

Edges say how they hang together: `HAS_CONTRACT`, `MEASURED_IN`, `CORRECTS` (a measurement and the revision it corrects), `ACCEPTED_AS` (a measurement and the acceptance that used it, **the revision it used**, not the newer one), `CLAIMED_BY` (an acceptance, or the contract for a request that has no acceptance such as an advance, and the payment request), `PAID_BY` (a request and its Treasury transactions), `SETTLED_IN` (a request and the settlement it is part of, or a settlement and the contract or project it settles). `totals` gives the payment requests that count (sent, checked, with the Treasury or settled), their gross, and the gross of the settled ones. At most 500 nodes of a kind are shown; `truncated` names the kinds of which more exist.

## What it never shows

Nothing that names a person: the nodes carry codes, statuses, versions, amounts and dates. A project of another tenant, a project outside the scope of the caller, a contract that is not the project's and **any request from a contractor who is a guest of the tenant** are all the same answer, 404 `RESOURCE_NOT_FOUND`, which says nothing of what exists. The row level security of the database is the last guard under the scope.

## Screen PAY-17

The project is picked from the list (or typed when the caller may not list projects), then a contract of its chain or all of them; the nodes are listed by kind in the order of the chain, each with its label, status, version and revision, a badge for a superseded revision, the amount and a link to the screen where it is worked on (project, contract, measurement, acceptance, PAY-03, the Treasury board PAY-05, PAY-15). It only reads.

Browser flow: the last test of `apps/web/e2e/pay-payment-flows.spec.ts`; visual region PAY-17 (title alone above the workspace).
