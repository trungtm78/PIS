# The scorecard of a contractor and the log of its violations (ST-CTR-014, CTR 3.6, BR-CTR-11, CTR-23)

A contract officer evaluates a contractor on a contract with five scores; the overall score is weighted by the rule `CTR.SCORECARD` and rated; another person approves it. Violations are recorded by one person and confirmed by another, and a sanction needs the document that decides it.

## The rule `CTR.SCORECARD`

Until the rule engine holds it (R-CTR-05) the rule is a constant of the kernel (`SCORECARD_RULE`, as `CTR.RETENTION` is of the BOQ): weights in whole percents 30 / 25 / 20 / 10 / 15 for quality, schedule, safety and environment, cooperation and finance (they add up to 100); ratings by thresholds of the overall score: `EXCELLENT` at 90, `GOOD` at 75, `FAIR` at 60, `POOR` below. The thresholds are an assumption awaiting the signature of the business owner (CXN-EXE-01), so the scorecard answers `rule.awaiting_confirmation = true` and CTR-23 says so. The sum is made on whole numbers (score times percent, in hundredths of a point), so the overall score is exact: 80/70/90/60/100 is `80.50`, `GOOD` (UAT-AC315). `weights_rule_version_id` stays empty.

## The commands

| Operation | Rule |
|---|---|
| `evaluateContractor` `POST /contracts/{id}/performance-evaluations` | the contract is in the scope of `contractor.performance.evaluate` (404 if it cannot be read, 403 `SCOPE_DENIED` if read but not evaluated); a periodic evaluation needs a contract that has started, a completion one a `COMPLETED` or `CLOSED` contract, a termination one a `TERMINATED` or `CLOSED` one (409 `CONTRACT_STATE_INVALID`); five whole scores 0 to 100, a period of up to 40 characters, remarks up to 2000 (422); the evaluation is made `SUBMITTED`; one that waits for the same contract, kind and period is 409 `EVALUATION_DUPLICATE`; one that was approved is replaced by a new revision (`revision + 1`, `supersedes_id`) |
| `approveContractorEvaluation` `POST /performance-evaluations/{id}/approve` | `contractor.performance.approve` in scope, If-Match; `SUBMITTED` only (409 `EVALUATION_STATE_INVALID`), stale version 409; **the evaluator may not approve** (403 `SELF_APPROVAL_DENIED`, also a check of the table); approving a revision supersedes the approved one before it, so one is approved for a period at a time; the note of the approver is kept on the row |
| `recordContractorViolation` `POST /contracts/{id}/violations` | `contractor.violation.record` in scope; a contract that has started; kind, severity, a day that is not after today (Vietnam), words up to 2000; evidence, if any, is a clean version of a file of the tenant (422, `DOCUMENT_NOT_CLEAN`); a violation from another module (QMS, PAY, ISS, AUD) names its record; the violation is `RECORDED` |
| `confirmContractorViolation` `POST /violations/{id}/confirm` | `contractor.violation.confirm` in scope, If-Match; `RECORDED` only (409 `VIOLATION_STATE_INVALID`); **not by whoever recorded it** (403 `SELF_APPROVAL_DENIED`); a sanction (`WARNING`, `LIQUIDATED_DAMAGES`, `TERMINATION`, `DEBARMENT_PROPOSAL`) needs a document of decision, given now or already on the violation (a termination suggests one with its document): without it 422 `DECISION_DOCUMENT_REQUIRED` and the violation stays `RECORDED` (UAT-PLAN-17); an amount belongs to `LIQUIDATED_DAMAGES` alone and there it is above zero |

The trail (`ctr.contractor_evaluation.submitted/approved`, `ctr.violation.recorded/confirmed`) and the events (`ctr.contractor_evaluation.submitted.v1`, `.approved.v1`, `ctr.violation.recorded.v1`, `.confirmed.v1`) carry ids, the contract, the period, the figures and the sanction; the remarks, the note and the description are the people's words and stay in the table.

## The table (V1392)

An evaluation says what it said and never changes (a trigger refuses a change of the scores, the period, the rule, the author; a correction is a new revision); its status only moves `SUBMITTED` to `APPROVED` to `SUPERSEDED`. One is open and one is approved for a contract, a kind and a period (partial unique indexes). A violation never changes what it says; its sanction is chosen once, at the confirmation, which names who confirmed and when, and not the one who recorded it; the amount is above zero exactly for liquidated damages. Neither table is ever deleted (`DELETE` and `TRUNCATE` are revoked from the application).

## The read and the screen

`getContractorScorecard` `GET /contractors/{id}/scorecard?from&to`: the contracts of the contractor that the caller reads (with whether they may evaluate or record on each), the evaluations (the day they were made) and the violations (the day they happened) in the range, a summary (the approved evaluations that stand, the average of their overall scores to the hundredth, the confirmed violations by severity) and the rule. A guest contractor is 403 (what the owner thinks of a contractor is the owner's); a caller sees only the contracts of their scope. Each line says whether the caller may approve or confirm it now.

**CTR-23** `ContractorScorecardScreen` (`/ctr/ctr-23?id=<contractor>`): the summary, the evaluations with the five scores, the overall score, the rating and the status, the rule with the note that its thresholds are an assumption, the log of violations, a filter by days, and the four dialogs. The dialog of an evaluation shows the overall score and the rating as the scores are typed. The screen needs `contractor.performance.read`, and shows no action while the tenant is read-only.
