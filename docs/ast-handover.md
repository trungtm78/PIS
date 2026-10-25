# Handover of a work and its punch list (ST-AST-001)

AST 3.1, BR-AST-01, UAT-AC65, UAT-AC388, UAT-AC395. Screens AST-01 (the list) and AST-02 (the minutes and the punch list). The migration is `V1520__ast1_handover_punch.sql`; the module is `apps/api/src/modules/ast`.

| Operation | Route | Permission | Moves |
|---|---|---|---|
| `createHandover` | `POST /handovers` | `handover.manage` | ∅ → `DRAFT` |
| `addPunchItem` | `POST /handovers/{id}/punch-items` (If-Match) | `handover.manage` | handover → `PUNCH_PENDING`; item ∅ → `OPEN` |
| `markPunchItemFixed` | `POST /punch-items/{id}/fixed` | `handover.respond` | item `OPEN` → `FIXED` |
| `verifyPunchItem` | `POST /punch-items/{id}/verify` | `handover.verify` | item `FIXED` → `VERIFIED` or `OPEN` (`REOPEN`) |
| `waivePunchItem` | `POST /punch-items/{id}/waive` | `handover.waive` | item `OPEN`/`FIXED` → `WAIVED` |
| `post_handovers_id_decision` | `POST /handovers/{id}/decision` (If-Match) | `handover.approve` | `approve` → `ACCEPTED`, `return` → `PUNCH_PENDING`, `reject` → `REJECTED` |
| `getHandoverTrace` | `GET /handovers/{id}/trace` | `handover.read` | none |
| `get_resources_handover` (+ `_id`) | `GET /resources/handover` | `handover.read` | none |

Events: `ast.handover.drafted.v1`, `ast.handover.accepted.v1` (ids, `accepted_at`, the unit that receives), `ast.punch_item.added/fixed/verified/waived.v1` (the verdict, `VERIFIED` or `OPEN`, is `punch_item_status`). A handover that is given back or rejected leaves its audit row (`handover.returned`, `handover.rejected`) and no event: the design lists none.

## Rules

- **Drafting.** The contract is `ACTIVE` or `COMPLETED` (409 `CONTRACT_STATE_INVALID`); the project is the contract's; a handover of the completion needs approved minutes of the completion of this contract (422 `QUALITY_ACCEPTANCE_REQUIRED`, `reason` `MISSING`, `NOT_APPROVED` or `NOT_COMPLETION`), the others take any approved minutes of the contract if named; the permit gate `HANDOVER` passes (409 `PERMIT_GATE_BLOCKED`); the unit that receives exists; the minutes of the handover are a clean document (422 `DOCUMENT_NOT_CLEAN`); the number is unique per contract (422 `VALIDATION_FAILED`, `reason` `DUPLICATE`).
- **The punch list.** An item is added until the receiving unit has decided (409 `HANDOVER_STATE_INVALID`) with a severity, a day that is not past and optionally a place, a photo of the defect and the contractor that answers for it (the contractor of the contract or one of its parties). The database writes `open_critical_punch_count` (critical items not verified) and the snapshot `punch_list` in the same transaction as the item (trigger `handover_punch_item_refresh`). Every command bumps the version of the handover.
- **Putting right.** The contractor answers with a photo of the contract or a document, both clean, and a note (422 `EVIDENCE_REQUIRED`); a guest contractor answers only for the items it is responsible for (403 `SCOPE_DENIED`). Somebody else verifies (403 `SELF_APPROVAL_DENIED`); `REOPEN` clears the answer and counts a reopening.
- **Waiving.** Never a critical item, whatever its status (422 `CRITICAL_CANNOT_BE_WAIVED`, also the CHECK `punch_item_waiver_critical_chk`); not by the person who put the item on the list.
- **Deciding.** The receiving unit decides: `approve` needs somebody other than the drafter (403), no critical item open (422 `OPEN_CRITICAL_PUNCH` with the item numbers, judged from the items, not from the count) and the as-built dossier given or already held (422 `AS_BUILT_REQUIRED`); it sets `accepted_at`, `accepted_by`, `handed_on` and the dossier. The O&M manual and the warranty certificate are kept when given. `return` is for a handover with a list, `reject` for any handover not decided. A decided handover takes no more item, answer or decision (trigger `handover_guard`, status edges in both tables, nothing is deleted).
- **Scope.** A handover is judged by the contract (the owner and investor unit of its project, the project, the contract for a guest contractor) **or** by the unit that receives the work: a grant on that unit's subtree reaches the handover (`handoverScope`). A handover outside the scope is 404.
- **Trace (UAT-AC65).** One answer: the handover, its items (each with what the caller may do), the assets it produced, the dossier by role, the completion minutes, and the receiving unit.

## Screens

AST-01 lists the handovers with the unit, the critical defects still open and the status, filtered by contract, and drafts one. AST-02 shows the handover, the notices ("n critical defects still open", "the as-built dossier is missing", the reason of a rejection), the punch list with severity, day, contractor and the buttons the server allows for each item, the dossier and the assets, and the decision dialog. Browser flow: `apps/web/e2e/ast-handover-flows.spec.ts`; visual regions AST-01 and AST-02.
