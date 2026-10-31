# The enforcement of a land recovery (ST-LND-011)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (3.3, UC-LND-03, LND-09, UAT-AC385). Migration `V1691__lnd1_enforcement_case.sql`. Operations: `startEnforcement` (`POST /land-enforcement-cases`) and `advanceEnforcement` (`POST /land-enforcement-cases/{id}/advance`, `If-Match`), both `land.enforce.write`, and one read added to the contract, `listEnforcementCases` (`GET /land-enforcement-cases`, `land.read`).

## The rule

A case is opened for a **parcel whose recovery was decided** and for a **household that was offered the money**, and goes through its steps one after the other:

`PERSUASION` → `NOTICE` → `ORGANIZATION_DECISION` → `ENFORCEMENT_DECISION` → `EXECUTING` → `COMPLETED`, and `SUSPENDED` from any step but the last.

The procedure is a working assumption until the business owner confirms it (CXN-12): the kernel (`packages/kernel/src/lnd-enforcement.ts`) holds it as pure functions, apart from the database.

- **The caller.** Holds `land.enforce.write` over the project and inside the units of the household: a unit outside the units of the caller does not exist for them (404), a caller who sees the project and does not hold the right is 403. `owner_unit_id` is the unit of the household (422 `owner_unit_id` otherwise).
- **Opening** (422 `PRECONDITION_NOT_MET` with a `reason`): `PARCEL_STATUS` (the parcel is approved, paid or disputed), `RECOVERY_DECISION_MISSING`, `PLAN_NOT_APPROVED` (the plan is approved, paying or paid), `HOUSEHOLD_NOT_ON_PARCEL`; and 422 `PAYMENT_NOT_OFFERED` with the reason `NO_PLAN_OR_HOUSEHOLD`, `PLAN_DOES_NOT_COVER_PARCEL` (the plan holds no item of the household for that parcel: the money offered for another parcel of the household does not count) or `NOT_PAID_OR_DEPOSITED` (what was paid or deposited on that plan covers everything the plan holds for the household and no installment is still waiting, as the plan moves the household to compensated; deposited when the household would not take it). `started_on` is not in the future. One case is open for a parcel at a time, suspended included (409 `ENFORCEMENT_CASE_EXISTS`; the partial unique index `land_enforcement_open_uq` is the backstop); once the case is completed the parcel is under enforcement and needs no other.
- **Advancing.** Refusals in order: 404 for a case outside the units of the caller, 409 `VERSION_CONFLICT` for another version than the one seen, 403 `SELF_APPROVAL_DENIED` for the person who drew the case up, 422 `ENFORCEMENT_STEP_INVALID` for a move the procedure does not allow (forward by one step, to `SUSPENDED` from any step but the last, from `SUSPENDED` back to the step it was suspended from or the one after it, never to the persuasion), then what the step needs.
- **What a step needs.** A decision step (`ORGANIZATION_DECISION`, `ENFORCEMENT_DECISION`, `EXECUTING`) comes with the document of the decision, a version scanned clean (422 `DECISION_DOCUMENT_REQUIRED`); `EXECUTING` also the day it is planned for (`planned_on`), `COMPLETED` the day it was carried out (`executed_on`, not in the future), `SUSPENDED` its reason (422 `VALIDATION_FAILED` naming the field). The days are not before the day the case was opened.
- **Execution** puts the parcel under enforcement (`ENFORCEMENT`) in the same transaction, the parcel locked first.
- **What is written.** The audit row `lnd.enforcement_started` or `lnd.enforcement_advanced` (classified as personal data, ids, the steps and the days) and the event `lnd.enforcement.started.v1` or `lnd.enforcement.advanced.v1`. Neither carries the words of the household nor the reason of a suspension.
- **The database.** Who the case is for (parcel, household, unit) never changes; the step graph is checked by the trigger `land_enforcement_case_guard` as the application checks it; a completed case is final; a case is suspended if and only if it knows the step it was suspended from; nothing is deleted.

## The read

`listEnforcementCases` lists the cases of a project inside the units of the reader, newest first (`step`, `limit`, `cursor`), with the household in its masked form only: its id, its code and the masked name of its head. Each case says what the caller may do with it (`allowed`: advance, suspend and the next step), which is false for a case the caller drew up and for a case outside the units over which the caller holds the right to enforce (a reader with a wider reading scope sees it and does not act on it).

## The screen (LND-09)

`EnforcementScreen`: a project is chosen (`?project=`); the cases are listed with the household masked, the step in words, the days and, for a suspended case, its reason. Somebody who holds `land.enforce.write` sees the button that opens a case: the parcel (only those with a recovery decision at a step that allows enforcement), the household, the plan (only approved ones), the enforcing unit, the legal basis and the day. Each case has a button that moves it: the fields are the ones the chosen step asks for (the document of a decision, the day planned, the day carried out, the reason of a suspension). The refusals are told in words, the reason included; the read-only mode and a reader see the list and nothing else. The server judges every command again.

## What is not done

- The rounds of persuasion are not recorded: the persuasion is one step.
- The procedure (the steps, the documents each decision needs, the reasons that block an opening) is an assumption until CXN-12 is answered.
- No contract (CTR) or intake (ISS) side effect follows a completed case, and no consumer reads `lnd.enforcement.*.v1` yet.
