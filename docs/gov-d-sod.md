# Separation of duties at commit (G4-1)

Lane D of the governance deepening (`docs/governance-roadmap-10of10.md`, item G4-1). A person who drew up a record does not also approve it, and the platform checks it when the command is committed, not when someone audits later.
The matrix of duties is data (the governance rule `SOD_MATRIX`), the check is one guard called by the commands of CTR, PAY and BID, and an exception is a time-limited record that two other people approve.

## Where things live

| Part | File |
|---|---|
| Pure rules: catalogue of duties, reading of the matrix, judgement, life of an exception | `packages/kernel/src/gov-d-sod.ts` (tests beside it) |
| The rule type, its schema and the built-in default | `registerIntegrityRules` in `packages/kernel/src/governance-rules.ts` (`SOD_MATRIX`, owner ADM) |
| Tables | `db/migrations/V1830` to `V1834` (block GOV-7): `sod_exception`, `sod_exception_approval`, `sod_exception_use`, guard triggers, lookup indexes |
| Store and guard | `packages/db/src/gov-d-sod-store.ts` (`SodStore`, `SodGuard`, `SodRefusal`) |
| The line a command adds | `apps/api/src/sod-gate.ts` (`enforceSod`) |
| Commands and reads | `apps/api/src/modules/adm/sod.controller.ts` |
| Screens | ADM-24 `apps/web/src/screens/adm/sod/`, AUD-13 `apps/web/src/screens/aud/sod/`, strings `parts/gov-d-sod.{vi,en}.json` |
| Tests | `apps/api/test/gov/sod.test.ts`, `packages/kernel/src/gov-d-sod.test.ts`, the vitest files beside the screens |

## The matrix

`SOD_MATRIX` / `DEFAULT`: `conflicts[{action_a, action_b, scope, severity, exception_max_days}]` and `exception_approvers`. A tenant approves its own version (maker is not checker, `governance_rule`), else the built-in default applies.
Every number of the default is a starting value, flagged `unverified` and said so on ADM-24: formula, source, as-of day and rule version are shown with it (the "i" of the matrix).

* `scope`: the group the duties are counted in: `SAME_RECORD`, `SAME_PROJECT`, `SAME_CONTRACT`, `SAME_PACKAGE`. A record that does not belong to a kind of group (a bid has no contract) can never conflict in that scope.
* `severity`: `BLOCK` stops the command, `WARN` lets it through and leaves a row for the auditor.
* `exception_max_days`: the longest an exception for the pair may run; 0 means the pair takes none (the default for the two bid pairs).
* `exception_approvers`: the people an exception needs; the code never goes below 2 (`SOD_MIN_EXCEPTION_APPROVERS`).

Default pairs: contract draft x approve, measurement record x approve, acceptance record x approve, payment request x verify, payment request x approve (send to the Treasury), advance request x approve, bid evaluate x award, bid evaluate x sign-off (all `BLOCK`), and three cross-step pairs of one contract as `WARN`: acceptance approve x payment verify, measurement approve x payment request, contract approve x payment approve.

## The duties (found in the columns the modules already keep, no history to backfill)

| Duty | Held by (on the record or group) |
|---|---|
| `contract.draft` / `contract.approve` | `contract.created_by`, `submitted_by` / `signed_by`, `activated_by` |
| `measurement.record` / `measurement.approve` | `created_by`, `submitted_by` / `decided_by` |
| `acceptance.record` / `acceptance.approve` | `created_by`, `submitted_by` / `decided_by` |
| `payment.request` / `payment.verify` / `payment.approve` | `payment_request.created_by`, `submitted_by` / `verified_by` / `treasury_sent_by` (not ADVANCE for the first two) |
| `advance.request` / `advance.approve` | the same columns of a request of kind ADVANCE (the verification is the advance approval) |
| `bid.evaluate` | reviewers of a finding (`analysis_finding_review.reviewer_user_id`), the maker and the signers of the evaluation report of the package |
| `bid.award` / `bid.sign_off` | `procurement_result.created_by`, `submitted_by` / `approved_by`, `rejected_by` |

A person who sent a measurement back checked it as much as one who approved it, so a duty is held whatever the decision was.

## The guard

Each command does its own work, then calls `enforceSod(scope, database, { taking, subjectKind, recordId, command })` inside the same transaction. The guard reads the matrix on the Vietnam business day, finds the keys of the record (record, project, contract, package) and asks, for each pair that has the duty being taken, whether the actor already holds the other duty in that scope.

* `BLOCK` and no usable exception: 422 `SOD_VIOLATION` with `action_a`, `action_b`, `taking`, `held`, `scope`, `exception_possible`. It never names the person or the record that made the actor hold the other duty. The command rolls back with everything it wrote.
* A usable exception (approved, for this person, this pair, this subject, today within its days): the use is recorded (`EXCEPTION_USED`) and the command goes on.
* `WARN`: recorded (`WARNED`), the command goes on.
* A refused attempt is kept (`BLOCKED` row of `sod_exception_use` and an audit row `sod.violation_blocked`, outcome DENIED) in transactions of their own after the rollback.
* A matrix or a duty column that cannot be read, or a record that is not found: 503 `SOD_CHECK_UNAVAILABLE`. It is never read as "no conflict" (fail closed, tested by renaming a column).

The check runs after the module's own checks, so the four-eyes rule of each command (`SELF_APPROVAL_DENIED`: not the one who drew it up or sent it) stays the floor that no exception lifts; an exception relaxes only the wider rules of the matrix (same contract, same project, WARN pairs, bid pairs, payment sent to the Treasury).

Hooked commands: `recordContractSigning`, `post_contracts_id_activate` (`contract.approve`), `post_measurements_id_decision` (`measurement.approve`), `post_acceptances_id_decision` (`acceptance.approve`), `post_payment_requests_id_submit` (`payment.request` or `advance.request`), `verifyPaymentRequest` (`payment.verify` or `advance.approve`), `markPaymentSentToTreasury` (`payment.approve`), `submitProcurementResult` (`bid.award`), `decideProcurementResult` (`bid.sign_off`), `reviewAnalysisFinding`, `post_findings_id_review`, `createEvaluationReport`, `signOffEvaluationReport` (`bid.evaluate`).

## Exceptions

`POST /sod-exceptions` asks (person covered, pair, subject, days, reason 10 to 500 characters); `/approve`, `/reject` (a reason), `/revoke` (a reason) are versioned (If-Match).

* The days start today or later, end on or after their start, and do not exceed `exception_max_days` counted with both ends (422 `SOD_EXCEPTION_WINDOW_INVALID`); the subject and the person must exist.
* It counts when the approvers the matrix asks for (at least 2) have approved, each a different person who is neither the one who asked nor the one it covers (403 `SELF_APPROVAL_DENIED`; the trigger `guard_sod_exception_approval` says it again in the database). One rejection by an eligible person ends the request.
* No two live exceptions (asked or approved) of one person, pair and subject cover the same day (exclusion constraint, 409 `SOD_EXCEPTION_STATE_INVALID`).
* It ends by the calendar: after `valid_to` the reader shows `EXPIRED` (nothing is written when time passes). An administrator with `adm.sod.exception.revoke` revokes a live one at once.
* The content of an exception never changes after it is asked; only status, counter and revocation move (guard trigger), and the approvals and uses are append-only tables.

Permissions (on the whole tenant): `adm.sod.read`, `adm.sod.exception.request`, `adm.sod.exception.approve`, `adm.sod.exception.revoke`; AUD reads with `aud.sod.read` (`GET /audit-sod/exceptions`, `GET /audit-sod/uses`).
Events (outbox): `adm.sod_exception.requested.v1`, `approval_recorded.v1`, `approved.v1`, `rejected.v1`, `revoked.v1`. Every command is audited with its reason.

## Alert types (registered in `registerIntegrityRules`)

* `SOD_EXCEPTION_EXPIRING`: owner ADM administrator, ACTION. Action: revoke it or ask for a new one with two approvers. Consequence: it lapses and the person is blocked again. Source: `SodStore.expiring(tx, today, days)`; the window is `SOD_EXPIRING_WITHIN_DAYS` (5 days).
* `SOD_EXCEPTION_USED`: owner AUD, WATCH. Action: look at what went through. Consequence: none, but an exception nobody reviews controls nothing. Source: `SodStore.usedSince(tx, since)`.

Both types are sources of the alert centre (integration GOV-INT): the source `SOD_EXCEPTION` of `packages/db/src/home-integrity-sources.ts` reads `SodStore.expiring` (kind `SOD_EXCEPTION_EXPIRING`, ACTION, opens ADM-24, for a reader who holds `adm.sod.read` on the whole tenant) and `SodStore.usedSince` over the last 14 days (kind `SOD_EXCEPTION_USED`, WATCH, one item for each exception that says how many times it was used, opens AUD-13, for a reader who holds `aud.sod.read` on the whole tenant). Nobody else has them unless somebody handed them the item; `getSodMatrix` also tells ADM-24 how many exceptions end within 5 days.

## Decisions

* The guard runs after the module's own work (not before) so existing four-eyes refusals keep their codes and tests, and a refusal rolls the work back as one unit.
* Cross-step pairs are `WARN`, not `BLOCK`: they are cheap to review and expensive to break the existing flows with; a tenant raises them by approving its own matrix.
* The bid pairs are bound to the three bid commands the plan names (evaluation = scoring panel, award = proposing the result, sign-off = deciding it); `exception_max_days` is 0.
* The subject of an exception is one record, project, contract or package, never wider.
