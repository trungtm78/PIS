# DGV quality rules, runs and scorecards (ST-DGV-002)

What the quality of a dataset says, and what it refuses to say. Code: `packages/kernel/src/quality-rule.ts` (the rules and the arithmetic),
`packages/db/src/dgv-quality-*.ts` (stores, source, job), `apps/api/src/modules/dgv/dgv-quality.controller.ts`, migration `V1021`.

## How a snapshot is frozen, and what a run reads

A run measures **one frozen snapshot of the module that produces the dataset**. In R1 the only source is the lines of a DIS `period_snapshot`
(`period_snapshot_line`); the datasets of other producers have no source yet and a rule or a run on them is refused (`SOURCE_NOT_SUPPORTED` for a run
already requested). The snapshot is frozen by DIS (`freezePeriodSnapshot`: status `FROZEN`, `payload_sha256` and `frozen_at` set together, enforced by
`period_snapshot_frozen_chk`), which emits `snapshot.frozen.v1`. DGV adds three guards of its own:

1. A run is requested only against a snapshot whose status is `FROZEN` (a person may also pick a `SUPERSEDED` one, whose rows are final too). A snapshot
   that does not exist is 404 `SNAPSHOT_NOT_FOUND`; one still being built is 409.
2. The run stores the digest of the snapshot payload at request time (`quality_run.snapshot_sha256`). The job reads the snapshot again before it measures:
   a snapshot whose digest or status changed finishes the run as `FAILED / SNAPSHOT_CHANGED`; one whose lines do not add up to its `row_count` finishes
   it as `SNAPSHOT_INCOMPLETE`. A run that cannot be measured has no verdict and no score.
3. The run stores the rule versions it applies (`quality_run.rule_version_ids`, the approved versions of the contract at request time). Rule versions
   never change (guard trigger), so a run stays true to what was measured whatever happens to the rules later.

`snapshot_id` / `as_of` conventions of the reads: the scorecard carries `snapshot_id` (the frozen snapshot of the latest finished run), `snapshot_as_of`
(the instant that snapshot's figures are as of), `definition_status` (`PROPOSED_PENDING_SIGNOFF` while the capital business owner has not signed the
definitions, D03) and `as_of` (the instant the answer was read). The list reads (`get_resources_quality_run`, `get_resources_quality_rule_version`) are
lists over many snapshots and carry `as_of` only; one run (`get_resources_quality_run_id`) names its `snapshot_id`.

## Honest states (BR-DGV-01, BR-DGV-04)

- No finished run: badge `NOT_ASSESSED`, score `null` (never 0, never passed), every dimension not assessed. A run that is `RUNNING` or `FAILED` is not a
  result: the scorecard shows it as `pending_attempt` beside the last result.
- A run older than the freshness SLO of the dataset: badge `STALE`; the scorecard says the age and the SLO.
- A dimension no rule measured has no score. A rule that evaluated no row, or whose query failed, is an `ERROR` result: it is excluded from the score and
  keeps the run from reading `PASSED` (at best `WARNING`); a run in which no rule could be measured is `FAILED / NO_RULE_MEASURED`.
- Scores are cut, never rounded up (a rate of 99.9999996 is not 100). Rates are counted in millionths of a percent as whole numbers.
- The executive average (`searchCatalog.summary.average_score`) is the mean of the latest scores of the datasets that have one; `NOT_ASSESSED` datasets
  are left out and counted beside it, `STALE` ones keep their last score and are counted separately.

## Verdict of a run (BR-DGV-03)

`score = 100 x sum(w x rate) / sum(w)` over the measured rules. A failed INTEGRITY rule, or a failed HARD_BLOCK rule on a critical dataset, is a
`hard_fail`: the run is `FAILED` however high the score. Any failed rule fails the run; a warning, or a rule not measured, makes it `WARNING` at best.
`certified_blocked` is set for a hard fail or any failed HARD_BLOCK rule: BI must not use the snapshot for certified figures. A failed rule opens (or
joins the open one of the same rule code of the dataset) a `quality_incident`, owned by the dataset owner, SLA by severity (CRITICAL 4 h, HIGH 24 h,
MEDIUM 72 h, LOW 240 h); an INTEGRITY failure is always CRITICAL.

## Rules

A rule is declared as an allowlisted expression (`quality-rule.ts`): the operators each dimension may use, over the fields of the source, with typed
literals and size limits. Anything else (raw SQL, a function, an unknown key) is 422 `EXPRESSION_NOT_ALLOWED`. ACCURACY cannot be written yet (it needs a
confirmed source or an expert sample, ST-DGV-011). The threshold is `{min_pass_rate_pct, warn_pass_rate_pct?}`; an INTEGRITY rule must have 100. A rule
version is written by one person and approved by another (403 `SELF_APPROVAL_DENIED`, also a database CHECK); approving a newer revision supersedes the
older approved version and drafts. The commands need the permission on the whole tenant (datasets belong to no organisation unit).

## Execution

`runQualityChecks` answers 202 with a `RUNNING` run; the job `dgv-quality-run` (every 10 s, `packages/db/src/jobs.ts`) executes it once, in one
transaction (results, verdict, incidents, audit, events `dgv.quality_run.completed.v1` / `dgv.incident.opened.v1`), counting attempts so that a run that
keeps failing to execute finishes `FAILED / EXECUTION_FAILED` after five. The consumer of `snapshot.frozen.v1` requests one run per dataset of the producing
module that has approved rules (the contract with the highest revision among those that have), once per snapshot and dataset (partial unique index).
Telemetry: `dgv_quality_score{dataset}`, `dgv_hard_fail_total{dataset}`, `dgv_not_assessed_datasets_gauge`.

## Terms

DGV stores no definition of a term. The definitions that the DIS figures stand on live in the MDM glossary (`glossary-store.ts`, domain DISBURSEMENT); the
scorecard only reports whether the snapshot was built on signed ones.
