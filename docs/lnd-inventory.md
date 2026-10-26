# LND-1: the inventory of the assets of the affected households (ST-LND-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.2, BR-LND-04, UAT-AC382, UAT-PLAN-29). Migration: `V1685__lnd1_inventory.sql` (the table `land_inventory_record` and its unit policy are in `V002`). Screen LND-04. CXN-12, so the story is DONE_UNCONFIRMED.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `recordInventory` | `POST /land-inventory-records` | `land.process` over the unit of the household | Counts one kind of asset of a household on a parcel it holds a right on. The record is a `DRAFT`. |
| `confirmInventory` | `POST /land-inventory-records/{id}/confirm` (If-Match) | `land.process` over the unit of the household | Records the answer of the household: `CONFIRMED` or `DISPUTED`. |
| `listInventoryRecords` | `GET /land-inventory-records?household_id=` | `land.household.read` over the unit of the household | The records of a household, by parcel. |

`listInventoryRecords` is additive to the design (CR-LND-03): the design lists no read for LND-04 and says the module has no generic reads.

## Counting (AC-ST-LND-004-1, UAT-PLAN-29)

- The amount is `quantity × unit price` rounded half up to the dong, on whole numbers (`packages/kernel/src/land-inventory.ts`); the quantity has at most six decimals and is above zero, the price is whole dong. The database holds the same rule (`land_inventory_amount_chk`): 80 m2 at 4.500.000 is 360.000.000.
- The unit price is typed by the officer; what the decision on land prices gives the platform is whether it was **in force on the day of the survey**. The decisions are master data of the tenant, type `LND_PRICE_DECISION` (key: the reference, e.g. `QD-GIA-2024`; attributes: `title`, `issuing_authority`), and their dates say when they apply, so a decision that was replaced is still the one a survey of its days rests on. A reference with no version in force on `surveyed_on` is `422 PRICE_DECISION_NOT_EFFECTIVE`. The record keeps the version it was counted by (`price_decision_version_id`, `price_decision_revision`).
- The household has to hold a right on the parcel (`household_parcel`), else `422 HOUSEHOLD_PARCEL_NOT_LINKED` (also a trigger). The survey is not in the future; the minutes of the count have to be a clean document version (`422 DOCUMENT_NOT_CLEAN`).
- A household outside the scope of the officer is `404`; a grant on a project reaches no household (the rule of ST-LND-002).

## The answer of the household

- A record is a `DRAFT` until the household answers. The answer is recorded by someone **other than the person who counted** (`403 SELF_APPROVAL_DENIED`; the database also holds `confirmed_by <> surveyed_by`), under the version the officer saw (`409 VERSION_CONFLICT`), and once (`409 INVENTORY_STATE_INVALID`).
- `CONFIRMED`: the day the household answered (not in the future, not before the survey) is stored. The household moves from `REGISTERED` to `INVENTORIED`, and from `DISPUTED` back to `INVENTORIED` when no other record is objected to; the parcel moves from `SURVEYED` to `INVENTORIED` with its first confirmed record.
- `DISPUTED`: the note says why (`422 VALIDATION_FAILED`, `note`); the household moves to `DISPUTED` and stays there while a record is objected to. A record that was objected to is not answered again; it is replaced by a newer count (`SUPERSEDED`, a status a later story sets, with the edges guarded now).
- Only a `CONFIRMED` record may support a plan item (AC-ST-LND-004-2, UAT-AC382): the plan stories (ST-LND-005) refuse `INVENTORY_NOT_CONFIRMED` against this status. This story only makes sure that a record cannot be confirmed without an independent officer and a price decision in force.

## Personal data

What is counted at a household is personal data (`land_inventory_record` is classified PERSONAL). The record is seen from inside the unit of the household only (`scope_units_guard` and the application test). The audit row and the event carry ids, the kind, the quantity, the unit price, the amount, the reference and the revision of the decision and the days; the description and the note of an objection stay in the record, and the stored answers of the commands are only a `CommandResult`. A test lists the audit rows, the events and the stored answers and fails if any holds the description or the note.

## Not in this story

The plan items that rest on a confirmed record (ST-LND-005), the replacement of a record by a newer count (`SUPERSEDED` is guarded by the database but no command sets it yet), the complaint that moves a parcel to `DISPUTED` (ST-LND-008), and the screen of the catalogue of price decisions (the generic catalogue commands of MDM create them).
