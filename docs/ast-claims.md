# The claims against a warranty and the answer to them (ST-AST-004, AST 3.3, AST-05, UAT-AC390, UAT-AC391)

The owner reports a defect while the warranty lasts. The contractor answers within seven days and puts the defect right with evidence. Somebody who neither reported the defect nor said it was put right verifies the repair. A claim nobody answers by its day is flagged by a job and ISS is asked for an issue.

## The commands

| Command | Route | Right (over the contract or the receiving unit) | Body |
|---|---|---|---|
| `fileWarrantyClaim` | `POST /warranty-obligations/{id}/claims` | `warranty.claim` | claim number, day reported, defect, severity, location, evidence, responder contractor |
| `acknowledgeWarrantyClaim` | `POST /warranty-claims/{id}/acknowledge` (If-Match) | `warranty.respond` | the day committed to, a note |
| `recordWarrantyFix` | `POST /warranty-claims/{id}/fixed` (If-Match) | `warranty.respond` | the day, a note, a clean file or a clean photo of the contract |
| `verifyWarrantyClaim` | `POST /warranty-claims/{id}/verify` (If-Match) | `warranty.verify` | `VERIFIED` or `DISPUTED`, who bears the cost, a note |

A claim is read in the scope of the permission (404 if it cannot be read at all, 403 `SCOPE_DENIED` if it is read but not served), and a contractor member answers for the claims addressed to its own contractor and no other (403 `SCOPE_DENIED`).

| Rule | Answer |
|---|---|
| a claim is valid when it is reported from the day the warranty starts and before the day it ends (BR-AST-03) | else 422 `VALIDATION_FAILED` (reason `BEFORE_START`) or 422 `WARRANTY_EXPIRED` with `ends_on`, and nothing is written |
| the obligation is not closed | else 409 `WARRANTY_STATE_INVALID` |
| the responder is the contractor of the contract or one of its active parties | else 422 `VALIDATION_FAILED` (reason `NOT_A_PARTY`) |
| the claim number is new in the obligation | else 409 `CLAIM_NO_DUPLICATE` |
| evidence given at filing is a clean file or a clean photo of the contract | 422 `DOCUMENT_NOT_CLEAN`, `FILE_NOT_CLEAN`, or `VALIDATION_FAILED` (`NOT_FOUND`, `NOT_IN_CONTRACT`) |
| the claim is moved by the lifecycle only: `OPEN` to `ACKNOWLEDGED`; `ACKNOWLEDGED`, `REPAIRING` or `DISPUTED` to `FIXED`; `FIXED` to `VERIFIED` or `DISPUTED` | else 409 `CLAIM_STATE_INVALID` with the status |
| the version the caller saw is the version of the claim | else 409 `VERSION_CONFLICT` |
| the day committed to and the day fixed are not before the day reported | else 422 `VALIDATION_FAILED` (reason `BEFORE_REPORT`) |
| the repair comes with evidence | else 422 `EVIDENCE_REQUIRED` |
| the verifier is neither the person who reported the defect nor the one who said it was put right | else 403 `SELF_APPROVAL_DENIED` |

The response day is the day reported plus seven days. The seven days are an [ASSUMPTION] of the specification (R-AST-03: they belong to the rules of the tenant or the terms of the contract, which are not stated), so they are one constant of the kernel (`CLAIM_RESPONSE_DAYS`). A disputed repair is put right again by the contractor (`recordWarrantyFix` from `DISPUTED`) and verified again; until a claim is verified the obligation cannot be closed. The trail (`warranty_claim.filed`, `.acknowledged`, `.fixed`, `.verified`) and the events (`ast.warranty_claim.filed.v1` and the others) carry ids, the claim number, the severity, the days and who bears the cost, never the words of the defect or of the answers.

## The late answer and the issue

`ast-claim-overdue` (hourly, `AstClaimOverdueJob`): each `OPEN` claim whose response day is before today in Vietnam is flagged (`escalated_at`, written once; the claim is not changed otherwise, so the contractor still answers at the version it read), the trail `ast.warranty_claim_escalated` is written, and `ast.warranty_claim.overdue.v1` is announced once (`warranty_claim:<id>:overdue`). The event follows the common contract of the intake of ISS (`source_module` `AST`, `source_ref_id`, `reference_code` = the claim number, project, contract, owner unit, severity from the claim: critical, high for major, medium for minor). The intake opens one issue attributed to AST under the category `WARRANTY` that the tenant keeps in master data (MDM-17), and the claim keeps the issue (`issue_id`, written once). A second pass, the same delivery again, or a second event for the same claim opens nothing more (BR-ISS-07). A claim that was answered is never flagged.

## The table (V1525)

`warranty_claim` (V002, V1522) gains what the answer records (who acknowledged and when, the day committed to, who fixed it, the note, the evidence, the note of the verification, the time it was escalated); the days follow one another; a claim that is acknowledged or fixed names who and what; the verifier is neither the reporter nor the fixer; and a guard keeps what a claim says, lets the status move along the lifecycle only, and writes the issue, the escalation and the acknowledgement once. Nothing is deleted by the application.

## The reads and the screen

`listWarrantyClaims` `GET /warranty-claims?obligation_id&status` (`warranty.read`, newest first, every claim with the lateness of the answer, the issue and what the caller may do: `allowed.acknowledge`, `allowed.fix`, `allowed.verify`) was added because AST-05 has to show the board and the contract had no way to read the claims. `listExpiringWarranties` `GET /warranty-obligations/expiring?within_days` (default 90, up to 3650; the soonest first) lists the active obligations whose warranty ends within the days given and not yet today. The obligation view now names the contractor of the contract (`contractor`), the one a claim is addressed to.

**AST-05** `ClaimsScreen` (`/ast/ast-05?obligation=<id>`): a board with a column for what nobody has answered, what the contractor took on, what it says is put right, what is disputed and what is verified. Each card shows the severity, the contractor, the day to answer by (and that it is late, with the issue), the day committed to and who bears the cost, with the actions the server allows for the caller. The forms check what the server will check (a day inside the warranty, a clean day order, evidence for a repair); every refusal of the server is told in words and the board is read again after a refusal as well as after a success.

## Gaps and decisions

- The text says a late answer also suggests a violation to CTR. Only the issue is opened; nothing is suggested to CTR.
- `REPAIRING` has no command (a claim goes from acknowledged to fixed), and `CLOSED` none (a verified claim stays verified).
- The evidence of a claim or of a repair is typed as a code: there is no picker of files and photos in this screen.
