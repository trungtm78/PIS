# The life of a contract: review, signing, activation, suspension and termination (ST-CTR-004, ST-CTR-005)

A contract moves `DRAFT → IN_REVIEW → SIGNED → ACTIVE` (CTR 3.1 steps 3 to 5, BR-CTR-13, BR-CTR-15). The graph is one table in the kernel
(`packages/kernel/src/contract-lifecycle.ts`: `CONTRACT_TRANSITIONS`, `contractTransition`, `assertContractTransition`); a command from a status the table does not name is refused
with 409 `CONTRACT_STATE_INVALID` (extensions `contract_status`, `command`). The generic `PATCH`/`PUT` of a contract cannot change the status. `packages/db/src/ctr-contract-lifecycle-store.ts`
runs every command in one transaction under a row lock on the contract and the `If-Match` version; the controller is `apps/api/src/modules/ctr/lifecycle.controller.ts`.

| Command (operation) | Route | Permission | From → to |
| --- | --- | --- | --- |
| `submitContractForReview` | `POST /contracts/{id}/submit-review` | `contract.review.submit` | DRAFT → IN_REVIEW |
| `returnContractDraft` | `POST /contracts/{id}/return` | `contract.review.decide` | IN_REVIEW → DRAFT |
| `recordContractSigning` | `POST /contracts/{id}/sign` | `contract.sign` | IN_REVIEW → SIGNED |
| `post_contracts_id_activate` | `POST /contracts/{id}/activate` | `contract.activate` | SIGNED → ACTIVE |
| `cancelContractDraft` | `POST /contracts/{id}/cancel` | `contract.update` | DRAFT or IN_REVIEW → CANCELLED |
| `suspendContract` | `POST /contracts/{id}/suspend` | `contract.suspend` | ACTIVE → SUSPENDED |
| `resumeContract` | `POST /contracts/{id}/resume` | `contract.suspend` | SUSPENDED → ACTIVE |
| `terminateContract` | `POST /contracts/{id}/terminate` | `contract.terminate` | SIGNED, ACTIVE or SUSPENDED → TERMINATED |
| `getContractSummary` | `GET /contracts/{id}/summary` | `contract.read` | — |

Every move writes a row to `contract_status_change` (from, to, reason, effective day, command, actor); the table is append-only for the application role (`REVOKE UPDATE, DELETE,
TRUNCATE`, V1384).

## Sending to review

Judged in this order: the actor's conflict of interest (409 `CONFLICT_OF_INTEREST_BLOCKED`, `conflict_of: ACTOR`), the status, the ceiling of the estimate (422
`CONTRACT_VALUE_EXCEEDS_CEILING`), an approved capital plan of the project (422 `CAPITAL_PLAN_NOT_APPROVED`), the contractor (422 `CONTRACTOR_NOT_VERIFIED`/`CONTRACTOR_RESTRICTED`), the
bill of quantities of the draft revision adding up to the value (422 `BOQ_TOTAL_MISMATCH`) and, for a joint venture, shares of 100 % matching the work (422 `JV_SHARE_NOT_100`). The
note is optional (at most 2000 characters). The one who sends it is recorded (`submitted_by`).

## Giving back and the two-person rule

The reason is required. Neither the one who drafted the contract nor the one who sent it to review may give it back or sign it (403 `SELF_APPROVAL_DENIED`; `assertNotMaker`).

## Signing

* **The delegation limit.** The signer must hold `contract.sign` with a rank that reaches the approver role of the DoA rule for `CTR_CONTRACT` in force for the value of the contract
  (`DoaMatrixStore.resolve`, then `withinDelegation`). A leader below the band is refused 403 `SCOPE_DENIED` with `approver_role_id`; a tenant with no rule is refused 422
  `DOA_RULE_NOT_FOUND` (fail closed).
* **The file.** `signed_document_version_id` must be a clean file of the tenant (422 `DOCUMENT_NOT_CLEAN`) and never a sealed bid (`BID_PROPOSAL`).
* **Conflict of interest (BR-CTR-13).** A signer who is in conflict with the contractor (or the package) is blocked whatever is on record. When the one who sent the contract to review
  is in conflict, someone free of it signs only with `conflict_decision_ref`, the reference of the decision of the authority that dealt with it. Each block writes a denied audit row
  (`contract.conflict_blocked`) that survives the rollback.
* **The day.** `signed_on` is a real calendar day, not after today in Vietnam.
* The signature (`signed_by`, `signed_on`, `signed_document_version_id`, `conflict_decision_ref`) cannot change afterwards: a CHECK ties them together and the trigger
  `guard_contract_signature` refuses to rewrite or to clear them.

## Activation

In this order, so that each refusal leaves the contract `SIGNED` and the next condition unasked: the evidence documents (clean files of the tenant), the stage of the project (`IMPLEMENTATION`, 422 `PROJECT_STAGE_INVALID`), the
performance guarantee for categories that need one (422 `PERFORMANCE_GUARANTEE_MISSING`), the permit gate `CONTRACT_ACTIVATION` for construction and EPC contracts (409
`PERMIT_GATE_BLOCKED` with the blocking permit types), the commitment of the value against the line of capital of the package (`CapitalCommitments.checkAndCommit`; a package with no line of capital is refused with cause `NO_ALLOCATION_LINE`; a refusal is 422
`FUND_COMMIT_FAILED` with the `cause` the capital gave). The approver is not the maker (403 `SELF_APPROVAL_DENIED`) and holds the delegation limit like the signer. On success, in
the same transaction: the first revision becomes `EFFECTIVE` from `effective_from` (not before the day of the signing), the contract becomes `ACTIVE`, the ledger gets a `COMMIT` entry
and the events `ctr.contract.activated.v1` and `ctr.commitment.changed.v1` are written to the outbox.

## The summary and the workspace (CTR-03)

`GET /contracts/{id}/summary` returns the contract detail. For staff (`contract.read` over the contract) it adds the people behind the signature, `readiness` (bill of quantities,
guarantee, permit gate, line of capital, project stage) and `actions`: the command that applies to the status and that the caller may press (permission over the contract, not the
maker for the commands that approve). The summary is cached for 60 seconds per contract and version (`summary-cache.ts`; at most 1000 entries). A guest of a contract (a
contractor) sees neither `readiness` nor `actions`. The screen CTR-03 shows a button for exactly these actions and the checks before the activation; the server judges every command
again.

## Suspension, resumption and termination (ST-CTR-005, CTR-22)

All three rest on a **decision document** (a version of a file of the tenant that is not infected and not a sealed bid; a request without one, or with one that is none of these,
is 422 `DECISION_DOCUMENT_REQUIRED`), a reason of 1 to 2000 characters and a day. The day is a real calendar day not in the future in Vietnam: a suspension begins on or after the
day the contract took effect, a resumption is not before the suspension began, and a termination is not before the signature or the suspension. A caller in conflict of interest with the
contractor is blocked like at the signing (409 `CONFLICT_OF_INTEREST_BLOCKED`, kept in the audit trail).

* **Suspending** stores the reason, the document and `suspended_from` (the CHECK `contract_status_reason_chk` holds the first two). While the contract is suspended no new quantity and
  no new advance is taken (`acceptsNewWork` in the kernel, for the stories that record them), and the payments follow the matrix of BR-PAY-09, which reads `suspended_from`.
* **Resuming** puts the contract back to ACTIVE and clears the suspension. `extension_days` (1 to 3650) is a request: it is kept in the history and the event, and `completion_due` does not
  move; it changes only through an approved extension revision.
* **Terminating** is for good (TERMINATED, then only CLOSED). The one who proposed it may not approve it: whoever made the decision document, drafted the contract or sent it to review
  is refused (403 `SELF_APPROVAL_DENIED`), and the approver is within the delegation limit of the matrix like the signer. `guarantee_action` says what becomes of the **performance**
  guarantees that are ACTIVE: `CALL` calls each (422 `VALIDATION_FAILED` with `reason: NO_ACTIVE_GUARANTEE` when there is none to call), `RELEASE` releases each against the decision
  document by someone other than the one who registered it, and `HOLD` leaves them. The advance guarantees are never touched: the advance still owed stays on the contract
  (`advance_outstanding_vnd` does not change) for the settlement. One violation is suggested for the contractor (`contractor_violation`, RECORDED, penalty `TERMINATION`, resting on the
  decision document, once per contract: V1385), for a person to confirm with a decision.
* V1385 adds `terminated_by` (not the drafter), makes the end of a contract unchangeable and keeps the suggestion unique.
* Events: `ctr.contract.suspended.v1`, `ctr.contract.resumed.v1`, `ctr.contract.terminated.v1` (the terminated one lists the guarantees it called or released and the violation it
  suggested). Audit: `contract.suspended`, `contract.resumed`, `contract.terminated`, and `guarantee.called` / `guarantee.released` for each guarantee moved.
* `getContractSummary` adds `suspend`, `resume` and `terminate` to `actions`: the status allows it, the caller holds the permission over the contract and, for the termination, is not the
  maker of the contract.

The screen CTR-22 (`apps/web/src/screens/ctr/status`) offers the actions that apply, asks for the reason, the document and the day, says what the command does to the payments, warns that a
termination cannot be undone and asks for a confirmation; the workspace CTR-03 links to it. The server judges every command again.

## Events and audit

`ctr.contract.review_requested.v1`, `ctr.contract.returned.v1`, `ctr.contract.signed.v1`, `ctr.contract.activated.v1`, `ctr.commitment.changed.v1` (outbox, same transaction). Audit
actions: `contract.review_requested`, `contract.returned`, `contract.signed`, `contract.activated`, and the denied `contract.conflict_blocked`.
