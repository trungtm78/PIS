# Non-conformances and corrective actions (ST-QMS-006)

QMS 3.3, BR-QMS-07, UAT-AC361. Screen QMS-07 (a board). Six commands and two reads, all in the scope of the contract.

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `raiseNonconformance` | `POST /nonconformances` | `ncr.raise` | ∅ → `OPEN` |
| `assignCorrectiveAction` | `POST /nonconformances/{id}/corrective-actions` (If-Match) | `ncr.manage` | `OPEN`/`REOPENED`/`ACTION_*` → `ACTION_ASSIGNED` |
| `submitCorrectiveEvidence` | `POST /corrective-actions/{id}/evidence` | `ncr.respond` | action `ASSIGNED`/`REJECTED` → `SUBMITTED` |
| `verifyCorrectiveAction` | `POST /corrective-actions/{id}/verify` | `ncr.verify` | action `SUBMITTED` → `VERIFIED`/`REJECTED` |
| `closeNonconformance` | `POST /nonconformances/{id}/close` (If-Match) | `ncr.close` | `VERIFIED` → `CLOSED` |
| `reopenNonconformance` | `POST /nonconformances/{id}/reopen` (If-Match) | `ncr.close` | `CLOSED` → `REOPENED` |
| `get_resources_quality_nonconformance` (+ `_id`) | `GET /resources/quality_nonconformance` | `quality_nonconformance.read` | none |

The migration is `V1462__qms1_nonconformance.sql`. Events: `qms.ncr.raised.v1`, `qms.ncr.closed.v1`, `qms.ncr.reopened.v1`, `qms.corrective_action.assigned.v1`, `.submitted.v1`, `.verified.v1` (the verdict, `VERIFIED` or `REJECTED`, is `corrective_action_status` in the payload). Payloads carry ids, codes, statuses and counts, never the words of a note.

## Rules

- **Raising.** The contract must be `ACTIVE` (409 `CONTRACT_STATE_INVALID`). `CRITICAL` sets `blocks_acceptance`; the quality acceptance and the contract acceptance refuse to go on while one is not `CLOSED` (`OPEN_CRITICAL_NCR`, already in ST-QMS-005 and ST-CTR-009). A source names its own record: an `INSPECTION` needs `inspection_id`, a `MATERIAL_TEST` needs `material_test_id`, no other source takes one; every record named (inspection, test, diary, measurement) must belong to the contract. The person responsible and the day (in the future) are required; the number `NCR-###` is the next of the contract (the contract is locked).
- **The status follows the actions.** It is never typed: with no action it stays as raised or reopened; while one action waits for evidence (assigned or given back) it is `ACTION_ASSIGNED`; when all the rest are answered it is `ACTION_SUBMITTED`; when every action is verified it is `VERIFIED`. Every command bumps the version of the non-conformance, so each has its own version for its event and a stale `If-Match` is caught.
- **Evidence.** Only the person given the action answers (403 `SCOPE_DENIED`), with a document of the tenant that is `CLEAN` (422 `DOCUMENT_NOT_CLEAN`) or a photo of the same contract that is `CLEAN` (422 `FILE_NOT_CLEAN`), and a note; neither is 422 `EVIDENCE_REQUIRED`. An action given back is answered again and its verification is cleared.
- **Independence.** An action is verified by someone who neither carried it out nor is responsible for the non-conformance; the non-conformance is closed by someone who is none of the people responsible for it or for any of its actions (403 `SELF_APPROVAL_DENIED`).
- **Closing.** 422 `CORRECTIVE_ACTION_OPEN` unless there is at least one action and every action is verified (checked before the state, so the screen can say what is missing); then a note is kept as `closure_note`. A closed one is only reopened (a reason; the closing and the verification are cleared, `reopen_count` counts), then takes a new action and is closed again; the old actions stay verified.
- **The database keeps the edges.** The guard triggers of V1462 allow only the moves above on both tables, keep what a non-conformance and an action are about from changing, make a verified action final, make a closed non-conformance change only by being reopened, and nobody deletes either (`REVOKE DELETE`).
- **Reading.** The list is the newest first with a keyset cursor (creation time in microseconds and id), filters `contract_id`, `status`, `severity`; each line has its actions and `allowed` (assign, respond, verify, close, reopen), judged for the caller. The root cause is not shown to a guest contractor. A non-conformance outside the scope, or of another tenant, is 404.

## Screen QMS-07

Five lanes (raised and reopened, being put right, awaiting verification, verified, closed) with a card each: number, title, contract, severity, what it holds back, overdue, the person responsible and the day, the actions with their statuses. The buttons come from `allowed`: assign, send evidence (for each action the caller carries out), verify (for each action answered by someone else), close and reopen. Raising is offered to whoever holds `ncr.raise` for the contracts being performed.

Browser flow: `apps/web/e2e/qms-nonconformance-flows.spec.ts`; visual region QMS-07.
