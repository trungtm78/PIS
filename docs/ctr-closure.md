# Closure of a contract (ST-CTR-012)

CTR 3.1 (the end of the life of a contract), the state machine of section 4, BR-CTR-09, UAT-AC300, CXN-EXE-04. Screen CTR-03 (the workspace of a contract). No migration: the edges `COMPLETED → CLOSED` and `TERMINATED → CLOSED` and the record of every change of status are already in V1380; the module is `apps/api/src/modules/ctr`; the guards are in `packages/kernel/src/contract-closure.ts`.

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `closeContract` | `POST /contracts/{id}/close` (If-Match) | `contract.close` | `COMPLETED` or `TERMINATED` → `CLOSED` |

Body: `settlement_revision_id` (required) and an optional `note`. The summary of the contract (`GET /contracts/{id}/summary`, for the staff) gains `closure` (the settlements that could serve, the advance still owed, the retention nothing carries, the guards not met) and `actions.close`. Event: `ctr.contract.closed.v1` (the ids, the statuses, the settlement, the advance owed and whether the settlement carried an exception); the audit row `contract.closed` has the same facts. Every change of status is also written to `contract_status_change`.

## Rules (UAT-AC300)

- **State.** Only a contract that was completed or terminated is closed; any other status, and a contract that is closed already, is 409 `CONTRACT_STATE_INVALID`. This is judged first. A stale version is 409 `VERSION_CONFLICT`. The person in conflict of interest with the contractor is blocked as in the other commands of the life of a contract.
- **The settlement.** The command names the settlement it rests on; it has to be a settlement of the contract (scope `CONTRACT`, this contract) or of its whole project (scope `PROJECT`, this project), otherwise 422 `VALIDATION_FAILED` (`NOT_FOUND`, `NOT_A_SETTLEMENT_OF_THE_CONTRACT`). An annual settlement serves no closure. It has to be `CLOSED` (422 `SETTLEMENT_NOT_CLOSED`).
- **The advance.** What was paid out as advance and not recovered is zero, or the settlement that closed carries the exception approved for it (the exception of `settlement_revision_close_chk`, approved by someone other than whoever drew it up): 422 `ADVANCE_OUTSTANDING` otherwise.
- **The retention.** Every hold with something still held is resolved (422 `RETENTION_UNRESOLVED` with the number of holds and the amount): released, or carried by the warranty — a hold that waits for the end of the warranty (`WARRANTY_END`) is carried while a warranty obligation of the contract that is not closed runs. Once the warranty is closed, what is left has to be released first (ST-CTR-010).
- **The order.** The first guard that is not met is the answer, in the order settlement, advance, retention; the extensions carry the amounts and `unmet`, the list of all the guards not met. A refusal changes nothing: the contract keeps its status and its version.
- **Afterwards.** A contract that is closed takes no step; the database refuses the way back (`COMPLETED`/`TERMINATED` are the only ways in, nothing leaves `CLOSED`).

## Screen

The workspace of a completed or terminated contract shows the conditions of its closure (the settlement closed, the advance recovered or excepted, the retention dealt with, each met or not, with what is left of the advance and of the retention) and, for whoever may close it, the button; the dialog offers the settlements that could serve (the only one is chosen) and a note, and refusals are worded.
