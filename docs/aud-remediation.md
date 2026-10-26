# AUD-3: assignment, remediation, dispute and separated verification (ST-AUD-003)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/AUD.md` (sections 3.3, 3.5, 4, 5, BR-AUD-04, BR-AUD-06, BR-AUD-08, BR-AUD-09, BR-AUD-11). Migration: `V1322__aud1_recommendation_flow.sql`. Screens AUD-06 (the table, with the assignment and the dispute) and AUD-07 (the follow-up board). It builds on [aud-conclusions.md](aud-conclusions.md).

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `assignAuditRecommendation` | `POST /audit-recommendations/{id}/assignment` (If-Match) | `aud.recommendation.assign` over the scope of the engagement | Gives an OPEN or ASSIGNED recommendation to a unit (and a person) with a day read from the conclusion. |
| `planRemediationAction` | `POST /audit-recommendations/{id}/actions` (If-Match) | `aud.recommendation.execute`, and the owner | Adds an action; the first moves ASSIGNED to IN_PROGRESS. |
| `completeRemediationAction` | `POST /audit-remediation-actions/{id}/completion` (If-Match on the action) | `aud.recommendation.execute`, and the owner | Marks an action done with a day and a document in force. |
| `submitRecommendationForVerification` | `POST /audit-recommendations/{id}/verification-request` (If-Match) | `aud.recommendation.execute`, and the owner | IN_PROGRESS to PENDING_VERIFICATION. |
| `verifyAuditRecommendation` | `POST /audit-recommendations/{id}/verification` (If-Match) | `aud.recommendation.verify` over the scope of the engagement | Closes it or sends it back (IN_PROGRESS). |
| `disputeAuditRecommendation` | `POST /audit-recommendations/{id}/dispute` (If-Match) | `aud.recommendation.execute`, and the owner | ASSIGNED or IN_PROGRESS to DISPUTED, with words and a document. |
| `recordAuditDisputeDecision` | `POST /audit-recommendations/{id}/dispute-decision` (If-Match) | `aud.recommendation.verify` | Records the answer of the authority: accepted goes to the verifier, rejected back to work. |
| `attachAuditEvidence` | `POST /audit-evidence` | `aud.recommendation.execute` | Puts a document in force in the register of evidence of an engagement, a finding, a recommendation or an action. |
| `listAuditRecommendations` | `GET /audit-recommendations` | `aud.read` | Now with the owner, the day, the dispute, the actions with their evidence, and filters (`conclusion_id`, `engagement_id`, `status`, `rec_type`, `owner_unit_id`, `overdue`). |

## The state machine (AUD 4)

`RECOMMENDATION_EDGES` in `packages/kernel/src/aud-recommendation.ts` is the only place that names the edges: OPEN or ASSIGNED to ASSIGNED; ASSIGNED or IN_PROGRESS to IN_PROGRESS (a second action is another row, not another edge); IN_PROGRESS to PENDING_VERIFICATION; PENDING_VERIFICATION to CLOSED or back to IN_PROGRESS; ASSIGNED or IN_PROGRESS to DISPUTED; DISPUTED to IN_PROGRESS (rejected) or PENDING_VERIFICATION (accepted); CLOSED to IN_PROGRESS (the system, when a recovery is reversed: ST-AUD-004). Any other step is `409 RECOMMENDATION_STATE_INVALID`. The table holds the same edges (`audit_recommendation_edges_guard`), so a job or a consumer cannot write a step the machine does not know. Only the recommendations of an engagement that is FOLLOW_UP move (`409 ENGAGEMENT_STATE_INVALID`).

## Assigning (AC-ST-AUD-003-1, UAT-AC435, BR-AUD-06, CXN-AUD-01)

- The unit must be in the tenant (`404`, the same answer for a unit that is missing and one of another tenant) and in the scope of the one who assigns (`422 OWNER_OUT_OF_SCOPE`: the grant of `aud.recommendation.assign` must reach it). A person, when one is named, is an active member (`422`).
- The day is today or later and not after the implementation deadline the conclusion states (`422 DUE_AFTER_CONCLUSION_DEADLINE`, the deadline in the problem); a conclusion that states none leaves the day to the leader. The deadline is read from the conclusion, never from a constant. A deadline extension with a document is not in this story (the request has no field for one).
- The linked issue of ISS (`create_issue`) is a later story (R2): asking for one is `422`, not ignored.

## The work and the evidence (AC-ST-AUD-003-2, UAT-AC436, BR-AUD-09)

- The owner is the person the recommendation was given to or, when none was named, whoever a grant of `aud.recommendation.execute` links to the owner unit; anyone else is `422 NOT_OWNER` (the registry's status), checked before the version and the state.
- An action is completed on a day that has come with a document that DOC holds in force (`422 EVIDENCE_REQUIRED` for one that is missing, of another tenant or not in force); the document is also kept in the register of evidence (`audit_evidence`). AUD stores no file.
- The report needs no action planned and at least one done (`422 OPEN_ACTIONS_REMAIN`), and, for a financial recommendation, what was recommended recovered in full (`422 RECOVERY_INCOMPLETE`, with the figures) unless the authority accepted the dispute.

## Verifying and the dispute (AC-ST-AUD-003-3, UAT-AC441, BR-AUD-08)

- The verifier is neither the owner, nor the one who reported the work, nor the one who raised the dispute (`403 SELF_APPROVAL_DENIED`); the table holds it for a closed recommendation (`audit_recommendation_verifier_chk`, with the existing `close_chk`). Closing a financial recommendation needs what was recommended recovered, or the dispute accepted (`fin_close_chk`). A basis of closure, when named, is a document in force (`422 DOCUMENT_NOT_EFFECTIVE`); a return says what is left to do in at least 10 characters.
- A dispute carries words of at least 20 characters and a document in force; it keeps who raised it (`disputed_by`), clears the answer to an older dispute, and stops the day from counting (DISPUTED is exempt from being overdue). The answer of the authority needs a received or reference document in force (`422 DECISION_DOCUMENT_NOT_EFFECTIVE`) and is decided by someone with no hand in it; accepted, it becomes the basis of closure.
- The amount and the type of a recommendation do not change once it is assigned (`audit_recommendation_frozen_guard`): a change of amount needs an amended conclusion (ST-AUD-007).

## Who sees what (AUD 2, BR-AUD-11)

- A recommendation is found through the scope of its engagement (`aud.read`) or because it was given to the caller (by name or through a unit that a grant of execute reaches): `recommendationScope`. Otherwise `404`. The leader acts through the scope of `aud.recommendation.assign`, the verifier through the scope of `aud.recommendation.verify` (`403 SCOPE_DENIED` when they see it and are outside it).
- The trail and the events (`aud.recommendation.assigned.v1`, `aud.action.planned.v1`, `aud.action.completed.v1`, `aud.recommendation.submitted.v1`, `.closed.v1`, `.returned.v1`, `.disputed.v1`, `.dispute_decided.v1`) carry codes, ids, days and amounts, never the explanation, the comment of the verifier or the description of an action.

## The screens

- AUD-06 lists the recommendations (code, type, recovered of recommended, owner, day with the days late in words, status) with filters and the buttons of the caller: assign or reassign, dispute, record the answer of the authority.
- AUD-07 shows the board: one column for each stage (assigned, in progress, disputed, waiting for the verifier, closed), one card for each recommendation with its actions and evidence and the buttons of the owner (plan, complete, report, dispute, attach evidence) and of the verifier (verify, answer). A card does not move by dragging.
- A button is shown only to the person it fits; the server decides again on every request.

## Tests

`packages/kernel/test/aud-recommendation.test.ts`, `packages/db/test/aud-recommendation-store.test.ts` (including the triggers), `apps/api/test/aud/recommendation.test.ts`, the authz negative matrix and the tenant-isolation suite (the eight commands, with an action of each tenant), `apps/web/src/screens/aud/recommendation/*.test.*`, and `apps/web/e2e/aud-remediation-flows.spec.ts` with the visual regions of AUD-06 and AUD-07.
