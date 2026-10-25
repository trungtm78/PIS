# CTR: the measurements of work under a contract (ST-CTR-008, slice CTR-1)

A contract that is being performed is paid for the work done. The work is recorded as **measurements**: the quantity of one BOQ item done in one period, recorded by the contractor (a guest,
in its own contract) or the supervisor, sent with its evidence, and approved by someone else. This story is the record: the acceptance (`createAcceptance`) that turns approved
quantities into a payable amount is ST-CTR-009.

## The rules (CTR 3.4, BR-CTR-03)

| rule | where it is kept | refusal |
|---|---|---|
| a quantity is recorded only on a contract being performed, under the revision in force | `CtrMeasurementStore.record` | 409 `CONTRACT_STATE_INVALID`, 422 `REVISION_NOT_EFFECTIVE` |
| a period never takes quantity away; the value is greater than zero, with six decimals at most | kernel `assertNotDecrease`, `quantityOf` | 422 `CUMULATIVE_DECREASE_WITHOUT_CORRECTION`, 422 `VALIDATION_FAILED` |
| what is recorded for an item (draft, sent and approved) never goes above its quantity in the revision in force | kernel `assertWithinBoq`, with the row of the item locked | 422 `QUANTITY_EXCEEDS_BOQ` (`remaining_quantity`, `boq_quantity`, `total_quantity`) |
| one live measurement of an item in a period | the store | 409 `MEASUREMENT_STATE_INVALID` (`reason: PERIOD_ALREADY_MEASURED`) |
| the number of the record is used once in a contract unless the person says why not | store + `measurement_reference_uq` | 409 `MEASUREMENT_REFERENCE_DUPLICATE` |
| a construction contract waits for the permits of the start of construction | `PmtGateStore.assertPasses('START_CONSTRUCTION')` | 422 `PERMIT_GATE_BLOCKED` |
| a measurement is sent with evidence | `submit`, `measurement_evidence_chk` | 422 `EVIDENCE_REQUIRED` |
| whoever recorded or sent a measurement does not decide it | `assertNotProposer`, `measurement_maker_checker_chk` | 403 `SELF_APPROVAL_DENIED` |
| an approved measurement is corrected, never edited; an active acceptance holds it | `correct`, `guard_measurement` | 409 `MEASUREMENT_IN_ACTIVE_ACCEPTANCE` |

The cumulative of a measurement is what was **approved** for the item before it plus its own quantity, written when it is recorded and again when it is approved (the approvals that came
between are counted). A draft does not move anyone's cumulative; it does count against the quantity of the item, so two people cannot both fit the last of it: the row of the item
(`boq_item`) is locked while a quantity is judged.

## Life of a measurement

`DRAFT → SUBMITTED → APPROVED | REJECTED | DRAFT` (given back), and `APPROVED → SUPERSEDED` when it is corrected. The correction supersedes the old one first and then inserts the next
revision (`revision + 1`, `correction_of_id`, `correction_reason`) as a DRAFT with the new quantity (zero or more), counted from what remains approved. The edges are kept by the
trigger `guard_measurement` (V1388): the identity never changes, a rejected or superseded measurement is kept as it is, an approved one keeps its quantity, cumulative, evidence and number,
a sent one keeps what was sent. `DELETE` and `TRUNCATE` are revoked from the application role.

## Who sees what

A draft is seen only by whoever recorded it (`viewer` of `list` and `find`); the others read the sent, approved, rejected and superseded measurements of the contracts in their scope
(`measurement.read`). A guest contractor holds its permissions over its own contract only, and sees there the stable BOQ item that the command names (`boq_item_id` of the BOQ read is
shown to the staff and to a guest who holds `measurement.record` over the contract).

## Screen CTR-10

`/ctr/ctr-10?contract=<id>`: a row for each item of the revision in force (quantity, approved, left), the dialog to record, the list of the measurements with the buttons the server
says the caller may use (`actions.submit`, `actions.decide`, `actions.correct`), and the dialogs to decide and to correct. A caller who may not read the BOQ still reads the
quantities. The period is chosen from the periods of the tenant; a caller who cannot read them types its identifier. The contract workspace (CTR-03) links to the screen.

## Events and audit

`ctr.measurement.recorded.v1`, `.submitted.v1`, `.approved.v1`, `.returned.v1`, `.rejected.v1`, `.corrected.v1`: identifiers, codes, quantities and statuses, never the words of a reason beyond the audit row
that keeps them.
