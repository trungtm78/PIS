# Warranty obligation and its closure (ST-AST-003)

AST 3.3, BR-AST-03, BR-AST-05, UAT-AC390, UAT-AC392, CXN-EXE-04. Screen AST-04 (warranty and what is held back). The migration is `V1522__ast1_warranty_obligation.sql`; the module is `apps/api/src/modules/ast`; the rules of the term, the end of the warranty and the closure are in `packages/kernel/src/ast-warranty.ts`; the minimum terms are rule data of the type `AST_WARRANTY` (MDM, `docs/mdm-catalogue-dictionary.md`).

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `createWarrantyObligation` | `POST /warranty-obligations` | `warranty.manage` | ∅ → `ACTIVE` |
| `closeWarrantyObligation` | `POST /warranty-obligations/{id}/close` | `warranty.manage` | `ACTIVE`/`EXPIRED` → `CLOSED` |
| `listWarrantyObligations` | `GET /warranty-obligations` | `warranty.read` | none |

`listWarrantyObligations` is the list of the screen (filters `contract_id`, `handover_id`, `status`; keyset cursor). It is additive to the design: the design lists only the obligations that expire soon (`listExpiringWarranties`, which belongs to the job story), and there is no generic read of the table. `construction_grade` is an optional field of `createWarrantyObligation`, also additive (see the decisions in TODOS.md).

Events: `ast.warranty.created.v1` and `ast.warranty.closed.v1` (`obligation_id`, `contract_id`, `handover_id`, the dates, the term, the grade, the version of the rule, the guarantee and the amount held back). The closed event is what lets CTR release the retention (`WARRANTY_END`) and the warranty guarantee; the consumer is the story that releases them (ST-CTR-010/012/013). Both commands write an audit row with the same facts.

## Rules

- **The term (BR-AST-03).** `ends_on` is `starts_on` plus `period_months` (the last day of the month when that month is shorter); the database checks it. The term is at least the minimum the rule in force states for the grade of the work (422 `WARRANTY_PERIOD_BELOW_MINIMUM` with `minimum_months` and `period_months`); a term equal to the minimum is created. A work whose grade is not stated is held to the **longest** minimum, so an unknown grade never lets a term through that the real grade would have refused. The obligation keeps the grade, the minimum applied and the version of the rule (`rule_version_id`), and the screen says when that rule still waits for the confirmation of its source (CXN-EXE-04: the 24 months for special works and grade I and 12 months for the others are trial figures, not regulation).
- **No rule, no judgement.** When the rule data states no minimum in force on the day, the answer is 422 `NO_EFFECTIVE_RULE`; the platform never judges a term by a number it made up.
- **What it is for.** The handover is `ACCEPTED` (422 `HANDOVER_NOT_ACCEPTED`) and is the one of the contract named; an asset, if named, belongs to that handover and is not disposed of. One obligation per contract, handover and asset (the whole handover is its own scope): a second one is 409 `WARRANTY_STATE_INVALID`.
- **What covers it.** A warranty guarantee of the contract (kind `WARRANTY`, status `ACTIVE`), an amount held back above nothing, or both (422 `GUARANTEE_REQUIRED` otherwise; the database checks it too).
- **Expiry.** An obligation has run out from its last day on. The job that marks obligations `EXPIRED` runs once a day, so an `ACTIVE` obligation whose last day has come is already expired for every rule: the reads show `EXPIRED`, the filter by status counts it as expired and it may be closed. A claim is valid only before the last day.
- **Closing (BR-AST-05).** Once, after the warranty has run out (422 `WARRANTY_NOT_EXPIRED` with the last day) and when no claim is open (422 `OPEN_WARRANTY_CLAIMS` with the numbers of the claims); a closed obligation is 409 `WARRANTY_STATE_INVALID`. A claim stops being open when its repair is verified by somebody other than the person who reported it (`VERIFIED`, `CLOSED`); an unanswered, repaired-but-unverified or disputed claim is open.
- **The database.** `warranty_obligation_guard` creates only `ACTIVE` obligations, never changes what an obligation is, allows only `ACTIVE → EXPIRED | CLOSED` and `EXPIRED → CLOSED`, keeps a closure as it was written and refuses a closure while a claim is open (`OPEN_WARRANTY_CLAIMS`). `warranty_claim_guard` refuses a claim opened (or opened again) on a closed obligation and locks the obligation row while it does, so a closure and a new claim cannot both pass their checks: the closure locks the row first and counts the claims after. `DELETE` is revoked on both tables.
- **Scope.** The same as the handover: by the contract (the owner and investor unit of the project, the contract for a guest contractor) **or** by the unit that receives the work. The read answers 403 or 404 according to whether the caller holds the permission anywhere.

## Screen

AST-04 lists the obligations (filtered by handover) with what they cover, the start and the end with the days left, the grade, the guarantee, the amount held back, the claims open and the status, and says when the rule is a trial figure. The project office creates an obligation for an accepted handover (the form offers the grades and the assets of the handover) and closes one the server says it may close; refusals are worded, with the minimum and the term, the last day, or the numbers of the claims still open.
