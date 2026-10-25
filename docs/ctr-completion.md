# Completion of a contract (ST-CTR-011)

CTR 3.2, BR-CTR-09, UAT-AC305. Screen CTR-03 (the workspace of the contract). One command: `completeContract` (`POST /contracts/{id}/complete`, `If-Match`, permission `contract.complete`), ACTIVE → COMPLETED. The migration is `V1390__ctr1_contract_completion.sql`.

## The guards, in the order they are judged

1. The contract is `ACTIVE` (409 `CONTRACT_STATE_INVALID`, with the status it is in) and the version is the one shown (409 `VERSION_CONFLICT`). The caller is not blocked by a conflict of interest with the contractor (409 `CONFLICT_OF_INTEREST_BLOCKED`, kept in the audit trail like the other commands of the life of a contract).
2. `completion_quality_acceptance_id` names minutes of this contract, for the completion of the work (`acceptance_scope = COMPLETION`), that are `APPROVED` — 422 `COMPLETION_ACCEPTANCE_REQUIRED` with `reason` `MISSING` (also for minutes of another contract), `NOT_COMPLETION` or `NOT_APPROVED`. A missing or empty field is the same code.
3. No serious non-conformance of the contract is open (`blocks_acceptance` and not `CLOSED`): 422 `OPEN_CRITICAL_NCR` with `nonconformance_ids`.
4. No measurement of the contract waits for a decision (`SUBMITTED`): 422 `MEASUREMENT_PENDING` with `measurement_ids`.
5. `completed_on` is a real day, not before the contract took effect nor before the day (Vietnam) the minutes were approved, and not in the future (422 `VALIDATION_FAILED`).

The identifiers are the first twenty of each kind.

## What it writes

The contract becomes `COMPLETED` with `completed_on`, `completion_quality_acceptance_id` and `completed_by` (CHECK `contract_completion_chk`: a completed contract has all three; the trigger `contract_completion_guard` keeps them from changing; from COMPLETED the only move left is CLOSED). One row of the history of the status (`contract_status_change`, command `completeContract`, reason `Completed on the acceptance <record no>`, the document of the minutes), one audit row `contract.completed` and the event `ctr.contract.completed.v1` (ids, status, `completed_on`, the minutes and their number; the version of the contract is the aggregate version).

## Reading

`GET /contracts/{id}/summary` gives the staff of an `ACTIVE` contract `completion` (`acceptances` with `id`, `record_no`, `approved_on`; `open_critical_ncr_ids`; `pending_measurement_ids`) and `actions.complete`. A guest contractor gets neither. CTR-03 shows the three checks as a card ("way to completion", each met or not with how many stand in the way), a button "Complete the contract" for whoever may, and a dialog with the approved minutes (chosen when there is only one) and the day; the refusals are worded, naming the non-conformances and the measurements.

Browser flow: `apps/web/e2e/ctr-completion-flows.spec.ts`.
