# LND-1: the complaints of the households (ST-LND-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.3, 4, BR-LND-01, BR-LND-07, BR-LND-08, UAT-AC384). Migration: `V1689__lnd1_land_complaint.sql`. Screen LND-08. CXN-12 (the days to answer), so the story is DONE_UNCONFIRMED.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `fileLandComplaint` | `POST /land-complaints` | `land.complaint.write` over the project and the unit of the household | Files a complaint of a household, with its number, its days and its timer, and holds the household's parcels that are not yet paid as disputed. |
| `resolveLandComplaint` | `POST /land-complaints/{id}/resolve` (If-Match) | `land.complaint.resolve` over the project and the unit | Answers it: accepted or rejected with a reply document, or escalated with a note. |
| `listLandComplaints` | `GET /land-complaints?project_id=` | `land.read` and the units of the households | The complaints of a project inside the units of the reader, with the days left. Additive. |

## The days, the number and the timer (AC-ST-LND-008-1, UAT-AC384, BR-LND-01)

- The days to answer are those of the rule `COMPLAINT_RESOLUTION` in force on the day the complaint was filed (`422 TIMER_RULE_UNCONFIRMED` when there is none); a complaint filed on 2026-09-15 under a rule of 30 days is due on 2026-10-15. The rule version is kept on the timer of `land_deadline` (subject COMPLAINT).
- The number of a complaint is `LC-` and six digits, one after another in the project, from a counter that sees every unit (a count of the rows would see only the units of the caller); it is the only name of the complaint that leaves the unit of the household.
- The timer ends by the day of the answer: SATISFIED inside its days, BREACHED after them. An escalation ends it too, as the duty of this level ends there; the answer of the higher level that follows is recorded without moving the timer again.

## The words and the issue (UAT-AC384, BR-LND-07)

What the complainant says (`description`) and the reply (`resolution_note`) are personal data: the table has the unit policy of the household's unit, and the screen and the read show them only there. The audit row and the events carry the number, the subject, the channel, the dates and the counts, never the words or the household. `fileLandComplaint` emits `lnd.complaint.filed.v1` in the common contract of the issue intake of ISS (`source_ref_id`, `reference_code` = the number, `project_id`, `owner_unit_id`, the subject code): the intake (ST-ISS-005) opens an issue whose title is the kind of problem and the number, and the complaint remembers it (`issue_id`) in the transaction that opens it (`linkComplaintIssue`, registered in the intake). The issue is closed by the process of ISS, not by this module.

## Answering (AC-ST-LND-008-1)

- From RECEIVED, UNDER_REVIEW or ESCALATED (`409 COMPLAINT_STATE_INVALID` otherwise, and an escalated complaint is not escalated again), under the version the caller saw (`409 VERSION_CONFLICT`).
- The day of the answer has come and is not before the day it was filed. An acceptance or a rejection needs the reply document: none, one that does not exist or is not a document is `422 DECISION_DOCUMENT_REQUIRED` (also the CHECK `land_complaint_resolved_chk`), one not scanned clean is `422 DOCUMENT_NOT_CLEAN`; an escalation may carry one. A note in words is always asked for.
- The table keeps what a complaint says and the answer that was given (`land_complaint_status_chk`, the guard of the edges and of the answer).

## The parcels

Filing holds the parcels that the household has a right on and that are not yet paid: each goes to DISPUTED and the hold keeps the state it had (`land_complaint_hold`). A parcel that another complaint of the household already holds is held by this one too with the state the first found it in. An accepted or rejected answer lets the parcels of the complaint go, and each returns to the state it had unless another complaint still holds it (`parcel_held_by_another` reads every unit); an escalated complaint keeps its parcels disputed until the higher level answers. The states of the households are not changed by a complaint (the dispute of an inventory record is the household's own, ST-LND-004).

## Not in this story

Moving a complaint to UNDER_REVIEW and closing it (CLOSED) have edges in the table and no command; the daily job that raises the issue for a complaint that is past its day (the timers of the complaints are listed by `listUpcomingLandDeadlines`); a parcel that is paid while a complaint holds it is not moved to PAID until the hold is released and the payment is looked at again.
