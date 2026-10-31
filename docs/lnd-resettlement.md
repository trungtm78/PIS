# The allocation of resettlement (ST-LND-012)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (3.1 step 7, LND-12, UAT-PLAN-31). Migration `V1690__lnd1_resettlement_allocation.sql`. Operations: `allocateResettlement` (`POST /resettlement-allocations`, `land.resettle.write`) and two reads added to the contract, `listResettlementAllocations` (`GET /resettlement-allocations`) and `listResettlementCandidates` (`GET /resettlement-allocations/candidates`), both `land.read`.

## The rule

A plot (`PLOT`), a flat (`APARTMENT`) or a house (`HOUSE`) is allocated to **one household at a time**, on the **item of an approved compensation plan** that gives the household resettlement. The allocation (`resettlement_allocation`) belongs to the unit that answers for the household and is seen only from inside it: the policy `scope_units_guard` of the table says so as the application does.

- **The caller.** Holds `land.resettle.write` over the project and inside the units of the household: a household outside the units of the caller does not exist for them (404), a grant on the project alone reaches no household (404), and a caller who sees the project and does not hold the right is 403. `owner_unit_id` is the unit of the household (422 `owner_unit_id` otherwise).
- **Eligibility** (422 `HOUSEHOLD_NOT_ELIGIBLE`, with a `reason`): `NO_PLAN_ITEM` (the item is required), `PLAN_ITEM_NOT_FOUND`, `PLAN_ITEM_OF_ANOTHER_HOUSEHOLD` (the item belongs to another household or another project), `PLAN_NOT_APPROVED` (the plan is approved, paying or paid), `NOT_A_RESETTLEMENT_ITEM`, `UNIT_KIND_MISMATCH` (a land item gives a plot; a house item a house or a flat) and `ALREADY_ALLOCATED` (the item has its unit). The item is locked for the request, so two allocations asked for on it at once are made one after the other; the unique index `resettlement_plan_item_uq` is the backstop.
- **The unit.** One unit code is held by one household at a time: a second allocation of the code is 409 `UNIT_ALREADY_ALLOCATED` (the index `resettlement_unit_uq` decides, across units of the tenant that the caller may not see). A declined allocation gives the code back.
- **The fields.** `unit_code` 1 to 60 characters, `site_text` 1 to 300, `area_m2` above zero with at most two decimals, `priority_rank` 1 to 100000 (422 naming the field).
- **What is written.** The allocation with status `ALLOCATED` and `allocated_on` (today in Vietnam), the audit row `lnd.resettlement_allocated` (classified as personal data, ids and the unit only) and the event `lnd.resettlement.allocated.v1`. Neither carries the name of the household.
- **The database.** Who the household is, the plan item, the unit that answers, the unit and the code never change; an allocation that was handed over or declined is final; nothing is deleted.

## The reads

`listResettlementAllocations` lists the allocations of a project inside the units of the reader, newest first (`status`, `limit`, `cursor`), with the household in its masked form only: its id, its code and the masked name of its head. `listResettlementCandidates` lists the items of approved plans that give resettlement and have no unit yet, inside the units of the reader, with the kinds of unit each gives: what the form offers. A project the reader cannot reach has neither.

## The screen (LND-12)

`ResettlementScreen`: a project is chosen (`?project=`); the allocations are listed with the household masked; somebody who holds `land.resettle.write` sees the form: a candidate (household and item), the kind of unit among those the item gives, the code, the site, the area and the rank. The refusals are told in words, the reason of a household that is not eligible included. The form is locked while a request is on its way.

## What is not done

- Handing a unit over (`HANDED_OVER` with `handed_on`) and the household declining it (`DECLINED`) are states of the table that no command moves yet; the contract has no command for them.
- No consumer reads `lnd.resettlement.allocated.v1` yet.
