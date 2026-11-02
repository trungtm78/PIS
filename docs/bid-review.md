# BID: the review of the findings of an analysis and the comparison of proposals (ST-BID-010, slice BID-1)

An expert of the evaluation team decides what stands for each finding of an AI analysis (BID 3 F6), and the proposals of a package are set side by side on the same criteria from what the experts decided. Everything the
model said is a proposal; what a person decided is a record of its own, and the award stays a decision of someone with the authority (BR-BID-09): nothing here accepts the findings at once, ranks the proposals or names a winner.

## Reviewing a finding (`reviewAnalysisFinding`, `bid.evaluate`, If-Match, Idempotency-Key)

`POST /analysis-findings/{id}/review` with `{ to_status, score_after?, reason }`. The finding is never updated: since V1352 the database refuses every UPDATE of `analysis_finding` (the review columns V1350 let an expert
write stay unused), and the decision is a row of `analysis_finding_review` that points at it. Refusals in order (nothing is written for them):

| step | refusal |
|---|---|
| the body: `reason` trimmed under 20 or over 4000 characters, `to_status` not one of the four | 422 `REASON_REQUIRED` (judged by the command, so every refusal has one code), 422 `VALIDATION_FAILED` |
| the finding is not one of a proposal the caller has the full view of (member of the evaluation team with `bid.evaluate` over the project, declared, released, no conflict standing: the reads of ST-BID-004/009) | 404, or 403 `CONFLICT_UNDECLARED` when the declaration is owed; a recused member gets 404 |
| the run does not wait for the experts (it must be AWAITING_REVIEW or COMPLETED) | 422 `RUN_NOT_COMPLETED` |
| the version the caller names in `If-Match` is not the finding's current one (the number of decisions made + 1) | 409 `VERSION_CONFLICT` with `current_version` |
| `score_after` outside 0 to the top of the scale of the criterion (two decimals), or any score for a criterion that is met or not | 422 `VALIDATION_FAILED` (`score_after`) |

Decisions of one proposal are taken one after the other (the advisory lock of the proposal, the same one the analysis and its cancellation take), so that the version a caller names is the one that stands and the order of
the decisions is the order they were made in (`decided_at` is taken after the lock with `clock_timestamp()`).

**The record of the decision of a person.** In the same transaction `AiDecisionStore.record` writes the `ai_decision_record` of the answer of the AI that the run was made of (`subject_module` BID, `subject_kind`
`analysis_finding`, `action_kind` DECISION, `rationale` = the reason, the hash of the answer of the request) and the review row points at it (`ai_decision_record_id`, required by a check); the command marks it applied
with its operation id and the new version of the finding. The decision is `ACCEPTED` when the status and the score that stood are kept (also when no score is given), `REJECTED` when the expert sets the finding back to
NEEDS_REVIEW so that no conclusion stands, and `ACCEPTED_WITH_CHANGE` for any other status or score (`reviewDecision`, a pure rule of the kernel).

**What stands.** The status and the score that stand for a finding are the ones of its latest decision; the finding keeps saying what the model said. `score_before` is the score that stood (the previous decision's `score_after`,
null for the first: the model gives no score), `score_after` is the score given or, when none is given, the one that stood. A decision can be changed afterwards: it is a new row, the old one stays in the history.
When the last finding of a run gets its first decision the run moves to COMPLETED (AWAITING_REVIEW to COMPLETED, version + 1); a run an expert decided on can no longer be cancelled.

Table `analysis_finding_review` (V1352, on the generated V002 table): `from_status`/`to_status`, `score_before`/`score_after`, `reason` (20 to 4000), `decision`, `ai_decision_record_id` (required), `checked_evidence_ids`
(at most 20), RLS by tenant, the guard `guard_analysis_finding_review` (owner of the schema not held): written only for a finding of a run that waits for the experts or is completed, never updated, deleted or truncated.

The answer is `BidFindingReviewed`: `review_id`, `decision`, `final_status`, `final_score`, `ai_decision_record_id`, `run_status`, `resource_version` (the new version of the finding). The audit row `bid.finding_reviewed`
(with the reason; no text of the finding) and the event `bid.finding.reviewed.v1` are written in the transaction.

## The baseline form (`post_findings_id_review`, `ai.review`, If-Match)

`POST /findings/{id}/review` with `{ decision: approve | reject, reason, evidence_ids }` is the same command: `approve` keeps the status that stands, `reject` leaves NEEDS_REVIEW, and the citations the expert checked
(each of the finding, at most 20) are kept in the review. The caller holds `ai.review` and, over the same project, `bid.evaluate`. `return` no longer exists: a finding has nothing to be returned to (the change is allowed in
`compat-allow.json`; nothing called the scaffold).

## Reads

`listAnalysisFindings` shows, apart from what the model said (`status`, `finding`, `evidence`), `final_status`, `final_score`, `reviewed_at`, `review_count`, `version` (what a review names in If-Match) and `reviews`
(the history, oldest first: reviewer with display name, from/to status, score before/after, reason, decision, record, checked citations). `get_resources_analysis_finding(_id)` and `get_resources_analysis_run(_id)` derive
`final_status`, `reviewed_count` from the decisions, the same way. The runs' `reviewed_count` counts the findings with a decision.

## Comparing proposals (`compareProposals`, `bid.evaluate`)

`GET /procurement-packages/{id}/proposal-comparison?criteria_version_id=` (default: the approved version of the package in force; 404 when there is none; 422 when the version is of another package). The package must be of
a project the caller evaluates (404 otherwise); the proposals in it are those the caller has the full view of (a sealed, replaced or recused one is not there and nothing says why), and 403 `CONFLICT_UNDECLARED` when any
stands waiting for the caller's declaration. For each proposal the standing analysis is its latest run that was not cancelled, refused or failed.

- `proposals`: the proposals whose standing run ran on the criteria version, in the order of the names of the contractors (never ranked), with `decided_count` of `criteria_count`, `mandatory_not_met`, and `weighted_score`
  (Σ score / scale * weight over the scored criteria, exact decimals, rounded half up to two; null until every scored criterion has a score a person gave).
- `rows`: per criterion, one cell per proposal holding only what a person decided (`decided`: status, score, decision, moment; null while nobody has) and its `risk`: UNDECIDED, NONE, ATTENTION, MANDATORY_NOT_MET (a
  mandatory criterion found contradicted or missing or scored below its threshold). The model's status and text are not in the comparison.
- `excluded`: the proposals left out and why: `CRITERIA_VERSION_MISMATCH` (its standing run ran on other criteria, with that version id), `NO_ANALYSIS_RUN`.
- `excluded_criteria`: criteria whose text (name or required evidence) falls under a rule of the criteria nobody may ask for (a version drafted before a rule was added) are never compared and are named;
  `excluded_attributes`: the codes of those rules (GENDER, ETHNICITY, RELIGION, MARITAL_STATUS, AGE, ORIGIN, LOCAL_PRESENCE), the personal attributes and the region the comparison never looks at (BR-BID-11).

Opening the comparison is recorded (`bid.comparison_opened`: package, version, how many compared and left out).

## Screens

BID-10 `/bid/bid-10?package=` (the comparison: version used, table criteria by proposals in the order the server gives, the human decision or "undecided" in each cell, the proposals left out and why, the attributes never
compared, no total that ranks, a notice that the award is decided by a person with the authority; each proposal links to BID-12 with the package, the proposal and the run) and BID-12 `/bid/bid-12?run=` (the findings of a
run: the AI proposal labelled as such apart from the decision of a person, the history of the review, and one form per finding with the status, the score and the reason of at least 20 characters; one review at a time, no
action that accepts all).

## What is not here

The evaluation report and its sign-off (`createEvaluationReport`, ST-BID-011 and after) that asks every finding to have a `final_status` (a finding's `final_status` is now the latest decision); the award itself (BID-18,
`decideProcurementResult`, which the expert is refused: `bid.result.approve` is another permission). The score of a finding exists only from the first decision: the model gives none, so `score_before` of the first decision is
null, and a score is asked only for criteria with a scale.
