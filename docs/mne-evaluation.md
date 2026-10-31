# The investment evaluation of a project (ST-MNE-009)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F9, BR-MNE-08, MNE-08, UAT-AC292, UAT-PLAN-74). Migration `V1706__mne1_evaluation_workflow.sql`. Operations: `planMneEvaluation` (`POST /mne-evaluations`, `mne.evaluation.manage`), `submitMneEvaluation` (`POST /mne-evaluations/{id}/submit`, `mne.evaluation.manage`, `If-Match`), `decideMneEvaluation` (`POST /mne-evaluations/{id}/decision`, `mne.evaluation.approve`, `If-Match`), and two reads added to the contract, `listMneEvaluations` (`GET /mne-evaluations`, `mne.read`) and `listMneEvaluationProjects` (`GET /mne-evaluations/projects`, `mne.read`). The pure rules are `packages/kernel/src/mne-evaluation.ts`.

## The rule

An evaluation is **planned** for a project and a kind that its stage allows, **submitted** with what it found, and **decided** by somebody other than the person who planned it or submitted it. The status goes `PLANNED` → `SUBMITTED` (the step `IN_PROGRESS` exists in the table and is not entered by a command) → `APPROVED` or `RETURNED`; a returned evaluation is submitted again.

- **The kind and the stage** (409 `STAGE_TRANSITION_DENIED`, naming the kind and the stage): `INITIAL` and `MIDTERM` while the project is in `IMPLEMENTATION` (the initial one within 12 months of the day the project entered it, else the reason `INITIAL_WINDOW_PASSED`), `FINAL` when it is `COMPLETED` or `SETTLED`, `IMPACT` when it is `CLOSED`, `AD_HOC` at any stage. The kinds and their stages are a working assumption until the decree is confirmed (CXN-13).
- **The caller.** Plans and submits with `mne.evaluation.manage` over the project and decides with `mne.evaluation.approve` over the project; a project outside the scope of the caller is not there (404).
- **A submission** needs the conclusion (`SATISFACTORY`, `PARTIALLY_SATISFACTORY`, `UNSATISFACTORY`) and the day it was completed, which is not in the future (422 `VALIDATION_FAILED` naming the field); the findings are a list of objects, the recommendations at most 2000 characters, the report document an id of a document that exists. It is made at the version the caller saw (409 `VERSION_CONFLICT`) and from a state that allows it (409 `STAGE_TRANSITION_DENIED`).
- **A decision** is `approve` or `return` with a reason of at least 5 characters, by one who neither planned nor submitted the evaluation (403 `SELF_APPROVAL_DENIED`). Returning keeps the reason, who and when; submitting again clears the decision, so the one who returned may submit it again and a third person decides.
- **The overall report.** An approved evaluation is linked (`mne_report_id`) to the next overall report that is still being drawn up (`DRAFT`, `IN_REVIEW` or `RETURNED`, of no project) in the unit that owns the project or above it, the one due soonest. When there is none, the link stays empty.
- **The trail.** The audit rows `mne_evaluation.planned|submitted|approved|returned` and the events `mne.evaluation.planned|submitted|decided.v1` carry the ids, the kind, the statuses, the conclusion, the day and the report; the findings and the words of the decision are not repeated (the reason is the reason of the audit row).
- **The upgrade.** Evaluations written before the workflow kept who submitted and who decided are given what the table knew (the last person to touch an evaluation submitted it, an approval was decided by its approver, the day is the day it was last changed, the reason says it was decided before), and the checks of the workflow are added NOT VALID, so that they judge what is written from now on and do not refuse a database that holds a row of the old rules.
- **The database.** What the evaluation is about never changes; the status moves along the edges of MNE 4 and nowhere else; what was submitted does not change while it waits or after it was approved; an approved evaluation is final; the decider is neither the planner nor the submitter; the link to a report exists only on an approved evaluation; nothing is deleted.

## The read

`listMneEvaluations` lists the evaluations in the scope of the reader over the project, newest first (`project_id`, `status`, `limit`, `cursor`). Each carries `actions` (`submit`, `decide`) for the caller: `decide` is false for the person who planned or submitted it.

`listMneEvaluationProjects` lists the projects in the scope of the reader by code: what the filter and the plan of MNE-08 offer, so that a planner does not need the right to read the register of projects.

## The screen (MNE-08)

`EvaluationScreen`: the list with the project, the kind, the evaluator, the planned day, the status, the conclusion and the completion, filtered by project (`?project=`) and status; a button plans an evaluation (project, kind, evaluator, scope, day); each evaluation has the buttons that its `actions` allow: submit (a line for each finding, the conclusion, the recommendations, the day, an optional report document id; the reason of the last return is shown) and decide (approve or return with the reason). The refusals are told in words, the stage and the kind included; a reader and the read-only mode see the list only.

## What is not done

- The step `IN_PROGRESS` has no command (the document gives none): an evaluation goes from planned to submitted.
- The link to the report is made at the decision; a report drawn up later does not take the approved evaluations that came before it. The report itself reading the linked evaluations is a step of ST-MNE-002.
- The kinds, their stages and the twelve months are a working assumption (CXN-13).
