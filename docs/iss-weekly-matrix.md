# The weekly matrix of the issues (ST-ISS-006, ISS 3.1, BR-ISS-08, ISS-06, ISS-08, UAT-PLAN-25)

A leader reads, for an ISO week, how the issues of each unit moved: what stood open when the week began, what became open in it, what was closed, what stood open when it ended, and how many issues each unit had in each status at the end of it. Each count opens the list of the issues it counts.

## The weeks

A week is named `YYYY-Www` and runs from Monday to Sunday on the Vietnam calendar (`isoWeekRange` of the kernel; 2026 has 53 weeks, 2027 has 52). A name that is not a week, or a number the year does not have, is 422 `VALIDATION_FAILED` on `week`.

## The read

`getIssueWeeklyMatrix` `GET /issues/weekly-matrix?week=&unit_id=` (`issue.read`; never for a guest contractor: 403 `SCOPE_DENIED`). The issues are those in the scope of the caller (the same scope as the list, reporter included), of the unit when `unit_id` is given. The state of an issue at a moment is **read from its history**: the status the last event up to then moved it to (`issue_event.to_status`), and an issue that has no event yet did not exist. So a week that is over reads the same whenever it is asked for, and the week that is running is read up to now.

| Figure | Meaning |
|---|---|
| `opening` | issues open (not `CLOSED`) at the start of the week |
| `opened` | `CREATED` and `REOPENED` events in the week |
| `resolved` | `CLOSED` events in the week |
| `closing` | issues open at the end of the week: `opening + opened - resolved` for every row, and the `opening` of a week is the `closing` of the week before it |
| `overdue` | of the `closing` ones, those whose deadline (the one they had then) had passed, or that were late before their deadline was moved (BR-ISS-04) |
| `by_status` | the issues that existed at the end of the week, by the status they had then (their sum is the number of issues of the row) |

`rows` are by unit and group of issues (the category of the issue), `units` add the groups up, `totals` add the units up. An issue belongs to the unit and the group it has today (an issue moved between units counts for the unit it is in now).

## The drill-down

`get_resources_issue` takes `owner_unit_id`, `category_version_id`, `status` and `week`. With `week`, the status is the one the issue had when that week ended and issues that did not exist yet are left out, so **the list of a cell holds exactly the issues the cell counts** (UAT-PLAN-25: 24 issues, U1 14 and U2 10; OPEN 9, IN_PROGRESS 8, CLOSED 7; every count equals the database and U1 / OPEN lists its issues). Without `week` the status is the current one. With `week`, each issue is also returned with the status it had then, so a cell opens issues that read as the cell says. The deadline, the days overdue and the closing time on a card are the issue's today, not those of the week (the notice of ISS-01 says so); only the status is read at the end of the week. A week that has not begun has no issue in it, in the matrix and in the list. A value that is not an id, a status or a week is 422.

## The screens

**ISS-08** `IssueMatrixScreen`: the flows by unit and group (week, unit, group, raised, opening, handled, closing, with totals) and the units by status, every count linking to the list it opens. **ISS-06** `IssueProgressScreen`: by unit, the new, overdue and closed issues and the share of what was open that was closed. Both keep the week and the unit in the address (`?week=2026-W20&unit=`), move a week at a time, say a week that is not one is wrong without asking the server, and read the week of today when none is named. **ISS-01** shows a notice when it is opened from a cell, and how to clear it.
