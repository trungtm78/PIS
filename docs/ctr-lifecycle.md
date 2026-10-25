# The review, the signing and the activation of a contract (ST-CTR-004)

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

## Events and audit

`ctr.contract.review_requested.v1`, `ctr.contract.returned.v1`, `ctr.contract.signed.v1`, `ctr.contract.activated.v1`, `ctr.commitment.changed.v1` (outbox, same transaction). Audit
actions: `contract.review_requested`, `contract.returned`, `contract.signed`, `contract.activated`, and the denied `contract.conflict_blocked`.
