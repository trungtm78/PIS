# My work (ST-HOME-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/HOME.md` (F5). One read, `getMyWork` (`GET /home/my-work`, `home.read`); no table, no migration. The screen is HOME-02. HOME keeps nothing: each task is a row of the table of its module, read **by the membership of the person who asks**, so the work of another person never appears, whatever rights the reader holds.

## What is in the list

| Kind | Of the module | A task is |
| --- | --- | --- |
| `APPROVAL` | ADM (`approval_task`) | a task assigned to the person that is `Pending` and not decided |
| `EXPLANATION` | PRJ (`explanation_request`) | a request asked of the person that is requested, sent back or overdue |
| `EXPLANATION_REVIEW` | PRJ | a request the person asked for (and did not ask of themselves) that was answered and waits for their conclusion |
| `REPORT_RETURNED` | DIS (`report_revision`) | a report of the person (created or handed in by them) that was returned or whose amendment was asked for |
| `REPORT_DRAFT_OVERDUE` | DIS | a draft of the person whose reporting period is past its deadline |
| `MNE_OBLIGATION` | MNE (`mne_report`) | a monitoring report (first revision) of the unit of the person, or the units under it, that is a draft or returned and is due within 14 days or late |

A report that a later revision supersedes (one that is not deleted), and a draft that was deleted, are not tasks. **What the person wrote is theirs to see only while they may read the place it is about**: the reports and the explanations to conclude are limited to the projects (and, for an explanation of a unit, the units) the reader may read with `home.read` now, and the monitoring reports to the units they may read; an explanation addressed to the person by name stays theirs. A source that has more than 2000 tasks is cut and the answer says so (`truncated`; the counts are then a lower bound). The cursor carries the place the page stopped at (kind, id and day), so a task that is done between two pages does not break the paging.

## The order, and what an item says

The order is the one of `orderWork` (kernel): **late first** (the earliest day first), then **near its day** (within 7 days of today in Vietnam), then the rest; inside the same day the kind that comes first (an approval, an explanation owed, a report returned, a draft past its period, an explanation to conclude, a monitoring report), then the id, so the same list is always in the same order. A task with no day comes last.

An item has `id`, `kind`, `title`, `subtitle` (the project or the unit), `status`, `due_on`, **`original_due_on`** (the day it was first asked for, which a new day set when a request was sent back does not hide), `bucket` (`OVERDUE`, `NEAR`, `LATER`), `overdue`, `days_late`, and `target` (the screen and the id it is opened from). `counts` are of the whole list, whatever page is shown: `total`, `overdue`, and one for each kind. `limit` is 1 to 200 (50 by default); the cursor is the place of the last item (its kind, id and day), and one that is not of that shape is 422.

## HOME-02

Three columns (late, near its day, the rest), each card with its kind, its title, the project or unit, the day it is due on, how many days late, and the first day when it is another, and a link to open it where it is done: an explanation to PRJ-19, a report to DIS-03 (`?report=`), a monitoring report to MNE-03 (`?report=`). The counts by kind are at the top. Seven states.

## Assumptions and limits

- The approval has no screen yet from which to open it (the approval inbox of ADM-012 is a later story): the card has no link, and says so by having none.
- The monitoring reports of the unit are those of the unit of the **membership** of the person (and under it): the story names no per-person assignment of an obligation.
- A draft report counts as work only when its period is past its deadline; one the person has until later to finish is not listed.
- The reports are those the person created or handed in; a focal officer of the project who did neither is not given the task (the assignment of a report to a person is not kept).
