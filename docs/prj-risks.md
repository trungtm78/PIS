# The risks of a project (ST-PRJ-010)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md` (3.1 F8, BR-PRJ-07, PRJ-16, UAT-AC209). Migration `V1208__prj1_project_risk.sql`. Operations: `registerProjectRisk`, `updateProjectRisk`, `closeProjectRisk` (`project.risk.manage`) and `listProjectRisks` (`project.read`). One error code is new: 409 `RISK_STATE_INVALID`.

## The score

A risk has a likelihood and an impact, each a whole number from 1 to 5. The score is `likelihood x impact` (1 to 25) and is the generated column of the table, so no client can send one (a `score` in a body is 400). The band of a score: 1 to 5 `LOW`, 6 to 14 `MEDIUM`, 15 and more `CRITICAL` (`riskLevelOf` of the kernel; the screen takes the band of every cell from the server and does not repeat the thresholds).

## The life of a risk

`OPEN` -> `MITIGATING` -> `ESCALATED`, and from any of them `CLOSED` or `ACCEPTED`, with a reason. Nothing is deleted (the application role has no `DELETE`), and the database keeps the order: an ended risk is never changed, a live one never goes back to an earlier status, a reason (10 to 2000 characters) is on an ended risk and only on one, and a risk keeps its project and its author.

- **Register** (`POST /projects/{id}/risks`): the project must be in the scope of the caller. A caller who can read the project but not manage its risks is 403 `SCOPE_DENIED`; one who cannot see it finds nothing (404). The code is unique inside the project (409 `RISK_CODE_DUPLICATE`; every write locks the project, so two registrations of one code at once are one 200 and one 409). The group is an `EFFECTIVE` entry of the master type `RISK_CATEGORY`, the owner is a member on the staff, in force, who holds `project.read` over the unit that owns or invests in the project (a risk kept by someone who cannot see the project would never be handled), and the linked issue, when there is one, belongs to the same project: each is 422 `VALIDATION_FAILED` on its field. A new risk is `OPEN`; the contract lets it be written `MITIGATING` or `ESCALATED`.
- **Update** (`POST /project-risks/{id}/update`, under the version the caller saw: 409 `VERSION_CONFLICT`): the body is the whole entry. A status that is not sent leaves the status where it is; one that is sent may stay or go on towards escalation, never back (409 `RISK_STATE_INVALID`). A risk that has ended is not updated (409 `RISK_STATE_INVALID`). The code may be renamed to one that is free. An owner or a group the risk already holds is not asked for again, so a risk whose owner has since left can still be corrected and closed; changing to a new owner is checked again.
- **Close** (`POST /project-risks/{id}/closure`, under the version): `CLOSED` or `ACCEPTED` and a `closed_reason` of 10 to 2000 characters. The reason is kept on the risk and in the `reason` of the audit row. A risk is not ended twice.

Each command leaves the audit row (`project.risk_registered`, `project.risk_updated`, `project.risk_closed`; the diff lists the fields that changed, not their values) and the event of the same transaction: `project.risk_registered.v1` for a registration, `project.risk_updated.v1` for an update and for a closure. The payload carries `risk_id`, `risk_version`, `code`, `status`, `likelihood`, `impact`, `score`, `severity` (the band, so `CRITICAL` from 15, which is what the executive warnings of HOME-03 take) and the owner and the day.

## The read

`GET /projects/{id}/risks?status=&cursor=&limit=` lists the risks of the project in the scope of `project.read`, the highest score first, then the earliest day, then the code (one page after the anchor; a status that is not one is 422). Each line carries the score and the band, the owner with a display name, the group with its label, `overdue` (a live risk whose day has passed, by the date in Vietnam) and the reason of an end. The answer also carries `matrix`, the 25 cells of likelihood and impact with the score, the band and the number of **live** risks in each, and `live_count`, `critical_count` and `overdue_count` of the whole project, whatever the filter and the page.

## The screen (PRJ-16)

`RiskScreen`: the project is chosen in the address (`?id=`) or from the list, the status narrows the table, and a 5 by 5 matrix puts in **every cell a number and a word** (the score and the band), never a colour alone (UI-PRJ-16); the cell also says how many live risks it holds, and its `aria-label` says everything. A manager registers a risk (the score is previewed from the likelihood and the impact and is only a hint), edits a live risk (the form offers its status and the ones after it) and closes or accepts it in a dialog that asks for the reason. A reader only reads; a session that is read only offers no action. The group is chosen from the entries of `RISK_CATEGORY` in force, or typed as an identifier when the list has none; the owner and the linked issue are typed as identifiers.

## What is not done

- The daily job `prj.risk-due` (warnings for critical or overdue risks) is not built; HOME-03 gets the critical risks from the event only.
- The master type `RISK_CATEGORY` has no catalogue yet (MDM): entries have to be created by the master-data tools before a risk can name one.
- A project in any stage takes risks; the module document does not say that a settled or cancelled project must refuse them.
- The link between a risk and an issue is the identifier on the risk; the issue does not show the risk.
