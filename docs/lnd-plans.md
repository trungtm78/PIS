# LND-1: the plan of compensation, support and resettlement (ST-LND-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.3, BR-LND-05, UAT-AC382, UAT-PLAN-30). Migration: `V1686__lnd1_compensation_plan.sql` (the tables `compensation_plan` and `compensation_plan_item` and the unit policy of the items are in `V002`). Screen LND-05. CXN-12, so the story is DONE_UNCONFIRMED.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `draftCompensationPlan` | `POST /compensation-plans` | `land.plan.write` over the project | An empty plan at its first revision: project, executor unit, kind of executor, code. |
| `addCompensationPlanItems` | `POST /compensation-plans/{id}/items` (If-Match) | `land.plan.write` over the project and the units of the households | Adds items to a draft; all of them or none. |
| `revisePlan` | `POST /compensation-plans/{id}/revise` (If-Match) | `land.plan.write` over the project and every unit of its items | A new draft revision with the items of a plan that was posted or approved. |
| `listCompensationPlans` | `GET /compensation-plans?project_id=` | `land.read` over the project | The plans of a project, every revision. |
| `listCompensationPlanItems` | `GET /compensation-plans/{id}/items` | `land.read` over the project and the units of the households | The items of a plan, inside the units of the reader. |

The two reads are additive to the design (CR-LND-04): the design lists no read for LND-05.

## The items (AC-ST-LND-005-1, UAT-AC382)

- **A compensation** (`COMPENSATION_LAND`, `COMPENSATION_ASSET`) rests on a record of the inventory of the same household (`basis_inventory_id`) that is **`CONFIRMED`** (`422 INVENTORY_NOT_CONFIRMED`, with the status of the record, for a draft and for an objected one alike). The item takes from the record its parcel, its amount and what the amount was counted from: the quantity, the unit, the unit price and the price decision with its revision (`compensation_plan_item_count_chk`: the amount is the quantity times the price to the dong). A caller cannot state another amount (`422`, `THE_AMOUNT_IS_THE_AMOUNT_OF_THE_RECORD`) or another parcel or kind than the record's; land is compensated as land and every other asset as an asset. A record is used once in a plan (a unique index; `ALREADY_IN_THE_PLAN`). The price of a record was judged in force on the day of the survey when the record was counted (ST-LND-004); the plan does not judge it again, so a decision that has expired since does not unmake a count.
- **A support or a resettlement** (`SUPPORT_*`, `RESETTLEMENT_*`) is an amount of a policy in whole dong, with its legal basis; it rests on no record.
- Every item says its legal basis (up to 500 characters), belongs to the unit and the project of its household (a trigger), and is written inside the units of the officer: a household outside them is "not found". A grant on a project reaches no household (the rule of ST-LND-002).
- **The totals** of a plan (compensation, support, resettlement) are the sums of its items by group, and the grand total is generated from them. They are kept by the command that adds the items, in the same transaction and under the lock of the plan, so a caller who sees only some units still moves the whole plan's totals correctly. They change only while the plan is a draft (a trigger). Items are never edited: the table refuses an update.
- A call adds at most 200 items; the first item that is wrong refuses the call, naming it (`items[2].basis_inventory_id`), and none is added.

## Revising (AC-ST-LND-005-2, UAT-PLAN-30)

A plan that was posted for comment, whose posting closed, or that was approved is not edited. `revisePlan` creates the next revision of the same code: a draft that supersedes the plan (`supersedes_id`), says why (`revision_reason`), and carries copies of all the items; the earlier revision is marked `REVISED`, keeps its items and its totals, and stays readable. Another revision of a plan that was replaced is refused (`409 PLAN_STATE_INVALID`), as is a revision of a draft (edit it) or of a plan that is being paid or completed. The caller has to see every item of the plan: a plan with items in units the caller does not reach cannot be copied by them (`403 SCOPE_DENIED`), because a copy that lost items would be another plan. An item whose record is no longer confirmed stops the copy (`422 INVENTORY_NOT_CONFIRMED`).

The states of a plan (`DRAFT`, `POSTING`, `POSTING_CLOSED`, `APPROVED`, `PAYING`, `COMPLETED`, `CANCELLED`, `REVISED`) and their edges are guarded by the database; posting, approval and payment are the commands of the next stories.

## Personal data

The items of a plan are the amounts that a household is to receive: they are classified PERSONAL and read only inside the unit of the household. The totals of a plan are shown to whoever reads the plans of the project. The audit row of the items carries the ids of the items, their number and the totals, never the id of a household or an amount of one; the events carry the counts and the grand total.

## Not in this story

Posting, the opinions of the households, the closing of the posting and the approval (ST-LND-006, see `docs/lnd-posting.md`), the payments (ST-LND-007), the cancellation of a plan, and a plan item that rests on a record that was replaced by a newer count.
