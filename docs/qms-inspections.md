# QMS: inspection requests (ST-QMS-004, slice QMS-1)

Work under a contract that is being performed is inspected before it is covered, built on or accepted. A contractor (a guest, in its own contract) or the supervisor **asks for an
inspection**; the supervisor **schedules** it with the people who take part and **records its result** against a checklist (QMS 3.2, BR-QMS-04). The acceptance minutes that follow a passed
inspection are ST-QMS-005; the non-conformance report that follows a failed one belongs to a later QMS story.

## The regime is rule data (BR-QMS-04)

The master rule type `QMS_REGIME` (platform-owned, `PLATFORM_ONLY`) states, for a span of days, which roles sign the acceptance minutes and which checklist each kind of inspection is held to:

| attribute | meaning |
|---|---|
| `required_roles` | the roles that sign the minutes of an inspection: `CONTRACTOR`, `SUPERVISOR`, `OWNER`, `DESIGNER` |
| `completion_required_roles` | the roles that sign the minutes of the completion of the works (defaults to `required_roles`) |
| `checklists` | for each kind of inspection, the items to answer: `{code, label}` |
| `legal_basis`, `awaiting_confirmation`, `cxn` | the law the regime comes from and the confirmation it waits for (`CXN-07`) |

The regime whose dates contain the **day the inspection is asked for** (`requested_for`, not the day the request is made) decides. The inspection keeps what it was given: the version of
the rule (`regime_rule_version_id`), a snapshot of the roles (`required_roles`), the checklist, and whether the regime waited for its confirmation (`regime_awaiting_confirmation`,
`regime_cxn`). A rule that is edited later changes no inspection that exists. No regime in force on the day is 422 `REGIME_NOT_EFFECTIVE`; the platform never picks a regime for a day
it does not cover.

The baseline pack carries `ND-06-2021` (until the end of 2026) and `ND-207-2026` (from 2027-01-01, with the designer among the signers), **both flagged as waiting for CXN-07**. The checklists in
the pack are working assumptions of the platform, not the text of a decree; the screen warns, with the number of the confirmation, on every inspection given an unconfirmed regime.

## Commands

| command | rule | refusal |
|---|---|---|
| `requestInspection` (`inspection.request`) | the contract is `ACTIVE`; a construction contract waits for the permits of the start of construction; the BOQ item and the diary belong to the contract; one open request for the same item, kind and day | 409 `CONTRACT_STATE_INVALID`, 422 `PERMIT_GATE_BLOCKED`, 409 `INSPECTION_DUPLICATE`, 422 `REGIME_NOT_EFFECTIVE`, 422 `VALIDATION_FAILED` |
| `scheduleInspection` (`inspection.manage`, versioned) | a `REQUESTED` inspection; a time not before now; participants are distinct, active members of the tenant | 409 `INSPECTION_STATE_INVALID`, 422 `VALIDATION_FAILED`, 409 version |
| `recordInspectionResult` (`inspection.record`, versioned) | a `SCHEDULED` inspection; every item of the checklist answered once (`PASS`, `FAIL` or `NA`); a `PASS` has no failed item; a `FAIL` or `CONDITIONAL` has at least one; a `CONDITIONAL` states its condition in the note of each failed item | 409 `INSPECTION_STATE_INVALID`, 422 `CHECKLIST_INCOMPLETE` (`reason`: `ANSWER_INVALID`, `ANSWER_DUPLICATED`, `ANSWER_UNKNOWN`, `ITEMS_MISSING`, `RESULT_CONTRADICTS`, `CONDITION_UNSTATED`) |
| `cancelInspection` (`inspection.manage`, versioned) | a `REQUESTED` or `SCHEDULED` inspection, with a reason | 409 `INSPECTION_STATE_INVALID`, 422 `VALIDATION_FAILED` |
| `listInspections`, `getInspection` (`inspection.read`) | the inspections of the contracts in the scope of the caller; `actions` tells what the caller may do with each | 404 outside the scope |

`PERMIT_GATE_BLOCKED` is answered **422** by the commands of the construction (the acceptance criterion of the story says so), 409 by the commands that cannot go on at all
(`assertGateOpen`). A caller that holds the permission over other contracts only is refused 403 `SCOPE_DENIED`; outside the read scope the inspection does not exist (404).

## Life of an inspection

`REQUESTED → SCHEDULED → RESULT_RECORDED`, and `REQUESTED | SCHEDULED → CANCELLED`. The trigger `guard_inspection` (V1460) keeps the edges: what the request said never changes, a recorded or
cancelled inspection is kept as it is (the result and the answers are written once), and `DELETE` and `TRUNCATE` are revoked. The result is what the next step starts from: the events carry
the codes of the failed items (`failed_item_codes`), never the words of a note.

## Screen QMS-04

`/qms/qms-04?contract=<id>`: the inspections of the scope (or of one contract), the regime and the roles that sign beside each, the warning `[CXN-07] chưa xác nhận` while the regime waits for its
confirmation, and the dialogs to ask, schedule, record the result and cancel. The result dialog holds the answers to the same rules as the server before it sends them.
