# AUD-2: conclusions, findings and recommendations (ST-AUD-002)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/AUD.md` (sections 3.2, 5, BR-AUD-01, BR-AUD-05, BR-AUD-06, BR-AUD-11). Migration: `V1321__aud1_conclusion_money.sql`. Screens AUD-04 (receiving the conclusion, with its recommendations) and AUD-05 (the findings). It builds on [aud-engagements.md](aud-engagements.md).

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `recordAuditConclusion` | `POST /audit-engagements/{id}/conclusions` (If-Match on the engagement) | `aud.conclusion.record` over the scope of the engagement | Records the conclusion DOC received and moves the engagement to FOLLOW_UP in the same transaction. |
| `recordAuditFinding` | `POST /audit-conclusions/{id}/findings` | `aud.conclusion.record` | Adds a finding to the current conclusion. |
| `createAuditRecommendation` | `POST /audit-conclusions/{id}/recommendations` | `aud.conclusion.record` | Adds a recommendation (OPEN, no owner, no due day: the assignment is ST-AUD-003). |
| `listAuditConclusions` | `GET /audit-engagements/{id}/conclusions` | `aud.read` and the scope of the reader | The conclusions of an engagement with what their financial recommendations add up to and the shortfall. Additive. |
| `listAuditFindings` | `GET /audit-conclusions/{id}/findings` | `aud.read` | The findings of a conclusion by code, keyset paged. Additive. |
| `listAuditRecommendations` | `GET /audit-recommendations` | `aud.read` | The recommendations in scope; new filters `conclusion_id` and `engagement_id` beside the ones of the contract. |

## Recording the conclusion (AC-ST-AUD-002-2, UAT-AC434)

- The engagement must be ONGOING or AWAITING_CONCLUSION, else `409 ENGAGEMENT_STATE_INVALID` (the edge `recordConclusion` of the kernel state machine); a stale version is `409 VERSION_CONFLICT`.
- The document is a received (INCOMING) or REFERENCE document that DOC holds in force, else `422 DECISION_DOCUMENT_NOT_EFFECTIVE`, with one answer for a document that is missing, of another tenant or in another state.
- The days are in order: issued on or before received, received not in the future, the implementation and report deadlines (read from the conclusion, never hard-coded: CXN-AUD-01) not before the day of issue. The summary is at least 10 characters; the total is a whole number of dong written as a decimal string (`numeric(24,0)`).
- `supersedes_id`, and a second conclusion for the engagement, are `409 CONCLUSION_REVISION_INVALID`: the amended conclusions with their supersession are ST-AUD-007.
- The event `aud.conclusion.recorded.v1` and the audit row carry the codes, the ids, the days and the total, never the summary.

## The financial total check (AC-ST-AUD-002-1, BR-AUD-05)

- A financial recommendation (`FINANCIAL_RECOVERY`, `FINANCIAL_ADJUSTMENT`) names an amount above zero (`422 AMOUNT_REQUIRED` when it names none); one of another type names none (`422 VALIDATION_FAILED`).
- The financial recommendations of a conclusion, a new one included and a cancelled one left out, never add up to more than its total: `422 FINANCIAL_TOTAL_MISMATCH` with the figures in the problem (`total_financial_vnd`, `recommended_vnd`, `amount_vnd`, `remaining_vnd`, `excess_vnd`). Less than the total is allowed; AUD-04 shows the difference as a shortfall until the coordinator has dealt with it.
- The sum is read under a lock of the conclusion (`lock` takes it `FOR UPDATE`), so two recommendations sent at once cannot both fit. The table holds the same rule (`audit_recommendation_total_guard`, a trigger that locks the conclusion first), so a job or a later story that writes a recommendation cannot break it, and a recommendation that is not financial cannot carry money (`audit_recommendation_amount_kind_chk`).
- The screen refuses an amount above what is left before it sends it, and says what the server says is left when another recommendation took it first.

## Findings and the scope of the engagement

- A finding is about a project, a contract or a unit, each optional. The place must exist in the tenant (`404 RESOURCE_NOT_FOUND` for a place that is missing or of another tenant, the same answer for both, BR-IAM-01) and lie inside the scope of the engagement (`422 TARGET_OUT_OF_ENGAGEMENT`, a new registry code): a unit item covers the units under it and what is owned there, a project item its contracts and the unit that owns it, a contract item itself and the unit that owns its project (`withinEngagementScope`). The recommendation's `project_id` follows the same rule; its `finding_id` must be a finding of the same conclusion.
- Codes are used once in a conclusion: `409 FINDING_CODE_DUPLICATE`, `409 REC_CODE_DUPLICATE`.
- Only the current revision of a conclusion of an engagement that is FOLLOW_UP takes more: `409 CONCLUSION_REVISION_INVALID` for a superseded one, `409 ENGAGEMENT_STATE_INVALID` for an engagement that is closed.

## Who sees what (AUD 2, BR-AUD-11)

- Every command locks through `engagementScope` twice: `aud.read` decides whether the engagement is there (`404` for the engagement of another tenant or outside every grant) and `aud.conclusion.record` whether the caller may act (`403`). Reads use `aud.read` over the same scope.
- The data are CONFIDENTIAL: the trail and the events carry codes, ids and amounts, never the summary, the description, the legal basis or the words of a recommendation. No AI route reads them (NFR-PRIVACY-02).

## The screens

- AUD-04 asks for an engagement (the `engagement` of the address; the choice lists the ones that can take a conclusion or have one). Without a conclusion it shows the form to whoever may record an engagement that awaits it, a note to a reader, and the reason otherwise. With one it shows the conclusion, the money (total, recommended, shortfall with a warning while any is left) and the recommendations with a dialog to add one.
- AUD-05 lists the findings of the current conclusion (group, project or contract, unit, amount, severity, rule breached) with a dialog to add one whose places are the scope items of the engagement.
- The file of the engagement (AUD-03) links to both.

## Tests

`packages/kernel/test/aud-conclusion.test.ts`, `packages/db/test/aud-conclusion-store.test.ts` (including two recommendations at once and the trigger), `apps/api/test/aud/conclusion.test.ts`, the authz negative matrix and the tenant-isolation suite (the three commands and the three reads, with a conclusion, a finding and a recommendation of each tenant), `apps/web/src/screens/aud/conclusion/*.test.*`, and `apps/web/e2e/aud-conclusion-flows.spec.ts` with the visual regions of AUD-04 and AUD-05.
