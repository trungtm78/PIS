# The maturity of data governance (ST-DGV-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DGV.md` (3.1 F8, BR-DGV-08, DGV-16, DGV-17, DGV-21, UAT-AC53, UAT-AC492, UAT-AC493, UAT-AC494). Migration `V1028__dgv1_maturity.sql`. Pure rules in `packages/kernel/src/dgv-maturity.ts`, storage in `packages/db/src/dgv-maturity-store.ts`, the job in `dgv-maturity-job.ts`, the API in `apps/api/src/modules/dgv/dgv-maturity.controller.ts`, the screens in `apps/web/src/screens/dgv/maturity/`.

## The operations

| Operation | Who (over the whole tenant) | What it does |
| --- | --- | --- |
| `createMaturityRubricVersion` `POST /dgv/maturity-rubrics` | `data.maturity.manage` | Drafts the next revision of a rubric (422 `RUBRIC_WEIGHTS_INVALID` when the weights of the pillars do not add up to 100, 422 `VALIDATION_FAILED` naming the path otherwise). |
| `publishMaturityRubric` `POST /dgv/maturity-rubrics/{id}/publish` | `data.maturity.publish`, **not the drafter** | 404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` (not a draft), 403 `SELF_APPROVAL_DENIED`; the version it replaces becomes SUPERSEDED. |
| `createMaturityAssessment` `POST /dgv/maturity-assessments` | `data.maturity.manage` | Applies a published version (422 `RUBRIC_NOT_PUBLISHED`) to a scope with an assessor and a reviewer who are two members (422 `ASSESSOR_IS_REVIEWER`); every criterion starts NOT_ASSESSED; one assessment for a version, a scope and a period (409 `DUPLICATE_KEY`). |
| `recordMaturityEvidence` `POST /dgv/maturity-assessments/{id}/evidence` | `data.maturity.assess`, **the assessor of the assessment** | `If-Match` is the version of the row of the criterion that was read. 422 `EVIDENCE_REQUIRED`, `LEVEL_OUT_OF_RANGE`, `EVIDENCE_EXPIRED`; the first record puts the assessment IN_REVIEW. |
| `reviewMaturityEvidence` `POST /dgv/maturity-evidence/{id}/review` | `data.maturity.review`, **the reviewer of the assessment, not who recorded** | ACCEPTED or REJECTED with a note; 403 `SELF_APPROVAL_DENIED` for who recorded it, 403 `SCOPE_DENIED` for anybody else, 422 `EVIDENCE_EXPIRED` for an acceptance of evidence that has run out. A rejected row is NOT_ASSESSED again. |
| `post_maturity_assessments_id_publish` `POST /maturity-assessments/{id}/publish` | `data.maturity.publish`, **not the assessor** | `approve` publishes with the score, `return` sends the assessment back to the assessor, `reject` closes it (and frees its period). |
| `createMaturityMilestone` `POST /dgv/maturity-milestones` | `data.maturity.manage` | A milestone for a pillar of a published rubric: a level above where the pillar stands (422 `TARGET_BELOW_CURRENT`), a day that is not past, an owner who is a member. |
| `getMaturityScore` `GET /dgv/maturity-assessments/{id}/score` | `data.maturity.read` | The score with the coverage, the share asked for, the pillars and every criterion with what it counts as. |
| `listMaturityRubrics`, `listMaturityMilestones` | `data.maturity.read` | The versions of the rubrics and the roadmap, newest first, with the filters of the contract and a cursor. |
| `get_resources_maturity_assessment[_id]`, `get_resources_maturity_evidence[_id]` | `maturity_assessment.read`, `maturity_evidence.read` | The assessments (filters `status`, `rubric_version_id`) and the rows of the criteria (filter `assessment_id`) with the versions that a record or a review is made against. |

What the evidence says (`evidence_refs`, `review_note`, `na_reason`) is shown only to the assessor and the reviewer of the assessment and to those who hold `audit.read` on the whole tenant (the exposure policy of the contract); anybody else who may read the rows gets the criterion, its state and level, `evidence_count` and `evidence_redacted: true`.

Nothing here belongs to an organisation unit: each operation needs its permission through a grant on the whole tenant (403 `SCOPE_DENIED` for a grant on a unit).

## The rubric

Eight pillars, once each: GOVERNANCE, METADATA, QUALITY, INTEGRATION, SECURITY, LINEAGE_BI, AI_READINESS and VALUE_COST. Each has three to five criteria with a code (capitals, digits, hyphen, underscore; unique in the rubric), a weight above 0 and at most 100 with at most two decimals, a description for each of the levels 1 to 5, and optional references to the frameworks. The weights of the pillars add up to exactly 100 (the sum is made in hundredths, not in floating point). `framework_refs` maps names (DCAM, DMM) to places; it is a mapping for reference and nothing in the platform says an assessment is a certification against either. `min_coverage_pct` (1 to 100, two decimals) is the share of criteria that must be assessed for a total; `evidence_ttl_days` (1 to 3650) is how long evidence lasts. A version never changes after it is written, is published by somebody other than its drafter, and one version of a rubric is published at a time.

## The score (BR-DGV-08)

A criterion counts as **assessed** only when it is ASSESSED, a reviewer accepted it and its evidence has not run out on the day of the score; **not applicable** only when a reviewer accepted the reason; anything else is NOT_ASSESSED. So an assessor cannot make a criterion count, or leave the average, on their own word, and a rejected or expired record is never a level.

- `coverage = Σ w (assessed) / Σ w (assessed + not assessed)`; not applicable leaves both sides. 14 of 22 equal criteria is 63.64%, 17 of 22 is 77.27%. The test against `min_coverage_pct` is made on the fractions, not on the rounded value.
- `pillar level = Σ(w × level) / Σ w` over the assessed criteria of the pillar; a pillar with none is NOT_ASSESSED and has no level (not 0 and not 1).
- `overall level` is the weighted average of the pillars that have a level, only when coverage is enough; otherwise `overall_state = NOT_COMPUTED` and there is no level. Levels are rounded half up to two decimals.
- A **published** assessment is scored on the day it was published and never changes: evidence that runs out afterwards does not move it, and the database refuses a change to the assessment or to the rows under it.

## The assessment, the evidence and the separation of duties

`DRAFT` → `IN_REVIEW` (the first record) → `PUBLISHED` or `REJECTED`; `IN_REVIEW` → `DRAFT` when it is returned. The assessor is the only person who records; the reviewer named on the assessment is the only person who reviews, and never what they recorded; the person who publishes is not the assessor. The assessor and the reviewer are two people (also a check of the table). The evidence of a criterion is at least one record - a kind (ARTIFACT, LOG, INTERVIEW, TEST), what it refers to, an optional note - with a last day that is not before today and not later than the days the rubric allows (the day itself is given when none is). A level on a criterion that is NOT_ASSESSED is 422 (as the table says), as is a level out of 1 to 5.

## The roadmap

A milestone is PLANNED until a **published assessment of the whole tenant** with the same rubric (any revision) shows its pillar at the level or above (exactly: a level shown as 3.00 that is 2.996 does not reach 3); it is then ACHIEVED and names that assessment. A milestone whose day goes by without one is MISSED by the job and its owner is told. ACHIEVED and MISSED are final; the database refuses ACHIEVED without a published assessment.

## The job

`dgv-maturity-sweep` (hourly): the evidence of an assessment that is still DRAFT or IN_REVIEW and has run out becomes NOT_ASSESSED with review status EXPIRED, and the assessor is told which criteria (event `dgv.evidence.expired.v1`, audit `dgv.maturity_evidence_expired`); the milestones past their day become MISSED and their owners are told (event `dgv.maturity.milestone_missed.v1`, audit `dgv.maturity_milestone_missed`). Each is done once.

## Events and audit

`dgv.rubric.drafted.v1`, `dgv.rubric.published.v1`, `dgv.assessment.created.v1`, `dgv.evidence.recorded.v1`, `dgv.evidence.reviewed.v1`, `dgv.assessment.published.v1`, `dgv.milestone.created.v1`; audit `dgv.maturity_rubric_drafted`, `dgv.maturity_rubric_published`, `dgv.maturity_assessment_created`, `dgv.maturity_evidence_recorded`, `dgv.maturity_evidence_reviewed`, `dgv.maturity_assessment_published`, `dgv.maturity_assessment_returned`, `dgv.maturity_assessment_rejected`, `dgv.maturity_milestone_created`. The audit keeps counts of evidence, never the evidence.

## The database (V1028)

What the application checks first the tables hold again: a rubric version, an assessment, a row of evidence and a milestone are never deleted; a rubric version never changes what it says and is published by somebody other than its drafter; an assessment keeps its scope, rubric version, assessor and reviewer, moves forward only and is frozen once published (with the rows under it); a score exists only on a published assessment; ASSESSED needs a level, evidence and a last day, and NOT_ASSESSED has no level; ACCEPTED needs a reviewer who is not the assessor; a milestone moves forward only and is ACHIEVED only by a published assessment. The checks that rows of earlier fixtures could not meet are `NOT VALID`.

## The screens

DGV-21 (`RubricScreen`): the versions, the pillars and criteria with the five level descriptions, the mapping (with the note that it is no certification), the coverage and the days of evidence, the form to draft and the button to publish. DGV-16 (`AssessmentScreen`): the assessments, the coverage against the share asked, the total only when computed, the pillars and every criterion with what it counts as, the record form for the assessor, accept or reject for the reviewer, publish/return/reject for the person who is not the assessor, and the form to start one. DGV-17 (`RoadmapScreen`): the milestones with their state and the form to plan one.
