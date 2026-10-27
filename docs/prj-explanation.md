# Explanation requests with due dates, overdue handling and review (ST-PRJ-006)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PRJ.md` (3.1 F10, BR-PRJ-08). Migration `V1206__prj1_explanation_workflow.sql`. Operations: `listExplanationRequests`, `requestExplanation`, `submitExplanation`, `reviewExplanation`. Screen: PRJ-19. Jobs: `prj-explanation-auto` (consumer of `warning.opened.v1`) and `prj-explanation-overdue` (every 15 minutes).

## The life of a request

`REQUESTED` -> (past its due moment) `OVERDUE` -> `RESPONDED` -> `ACCEPTED` or `RETURNED`; a returned request is answered again, and may become `OVERDUE` again at its new date. Nothing is deleted.

- **Request** (`explanation.request`): about a project or a unit in the scope of the caller (403 `SCOPE_DENIED` outside it, 404 when it does not exist), to a member of the staff who is active (422 otherwise; a member of another tenant is 404), due in the future, with a question of 10 to 2000 characters. One request is open at a time for a subject, a trigger and a period (409 `EXPLANATION_ALREADY_OPEN`); a warning has at most one request. When a warning is named it must be of the same subject and open (409 `WARNING_STATE_INVALID` otherwise): asking acknowledges an OPEN warning and moves it to `EXPLANATION_REQUESTED`, as the database allows no shorter way.
- **Answer** (`explanation.respond`): only by the person asked, under the version they saw (409 `VERSION_CONFLICT`), 20 to 2000 characters. A late answer is **taken** from OVERDUE as from REQUESTED; `is_late` is set when the answer is after the due moment in force. A request already answered or accepted is 422 `EXPLANATION_ALREADY_SUBMITTED`.
- **Conclusion** (`explanation.review`): by someone in the scope of the subject; **not the one who answered** (403 `SELF_APPROVAL_DENIED`, checked before the version). ACCEPTED or RETURNED with a note of 5 to 2000 characters; a RETURNED conclusion may give a new due date (`new_due_at`, in the future; 422 on an accepted one). The answering clears the earlier conclusion. A conclusion on a request that is not answered is 409 `STAGE_TRANSITION_DENIED`.
- **Acceptance resolves the warning** the request was for (`RESOLVED`, reason `EXPLANATION_ACCEPTED`) in the same transaction, with its own audit row.
- `original_due_at` is never moved: the screen tells a request overdue **with the date it was first asked for** even when a review gave it a later date.

## The request that a warning asks for by itself (AC-ST-PRJ-006-2)

The consumer `prj-explanation-auto` reads `warning.opened.v1` with `auto_explanation: true` (rule EW-02 and the others that set it): one request to the **leader in charge** of the project (an active `LEADER_IN_CHARGE` assignment of ST-PRJ-005), trigger = the rule code, period = the period of the warning, **due in the working days the rule gave** (`explanation_due_days` of the event: a whole number from 1 to 30; 3 when it is missing or not valid) counted from **the day the warning was opened** (`occurred_at` of the event, so a late delivery gives no more time; the clock when it is missing or in the future). The inbox row is written with the request, so a redelivery is a counted duplicate; another delivery for the same warning finds the request and writes nothing but an audit row `prj.explanation_auto_skipped`. A warning that is not open any more, or a project with no leader in charge, is skipped and the audit row says why. The audit row names no person and no text.

## The job `prj-explanation-overdue`

Every 15 minutes, for each tenant: a request that is `REQUESTED` or `RETURNED` and past its due moment becomes `OVERDUE`, once, with an audit row (`prj.explanation_overdue`: from status, due and first due date) and the gauge `prj_explanation_overdue_gauge`. The pass is idempotent. It is a plain job of the worker like the others (no Temporal timer: the first slice has none, see TODOS).

## Assumptions

- Three working days (MDM-18) is an assumption until **CXN-33** is confirmed. The days are counted on the published work calendar of the period of the warning; when the tenant has published none for the year, the count is by **weekdays** and the audit row says `calendar: WEEKDAYS_ASSUMED` (the platform does not stay silent about this).
- A due date is the **last moment of its day in Vietnam** (UTC+7).
- The text of a question or an answer is kept on the request only: no audit row, event or log carries it.

## Screen PRJ-19

The list (subject, basis, question, due with the textual "Quá hạn" and the first due date, status and the "answered late" flag) with a status filter and paging; a detail panel with the question beside the answer and the conclusion under them; three dialogs (request, answer, conclude) with the checks that can be made before sending and the refusals of the server in words. What a person may do is shown to them (the answer only to the person asked, the conclusion not to the one who answered) and judged again by the server.
