# Work clocks, snoozing and reminders of the alert centre

Roadmap items G0-2 (clock engine, hook the clocks that exist), G2-1 (snooze: reason, caps, limit), G2-2 (two clocks, pause, re-claim) and G2-4 (reminder cadence). Lane GOV-2, block `V1900`-`V1919`. Code: `packages/kernel/src/work-clock.ts` (pure rules), `packages/db/src/home-work-*.ts` (stores), `apps/api/src/modules/home/work-action*.ts` and `work-reminder.job.ts` (commands, job).

The idea in one sentence: an item of the alert centre has two clocks, it can be put off and paused only for a reason a rule allows, it is reminded by a cadence a rule sets, and every number of every rule is data with a version, a source and a flag that says whether it was confirmed.

## The rules are data

The thresholds are three governance rules read through `GovernancePolicyPort` (`packages/db/src/governance-policy-port.ts`), code `DEFAULT`, never written in a controller or a screen. A province can approve its own version (maker and checker differ); until it does the built-in default of the platform applies and the decision carries the version `builtin` (an approved version is `v<n>`). Every default is a starting value of the research, flagged *chưa xác nhận* on every screen that shows it; none is a legal number.

| Rule type | Says | Built-in default |
|---|---|---|
| `SNOOZE_POLICY` | reasons, which reasons need words, longest postponement by severity (days), how many in a row, whether the last tells the next level | reasons `WAITING_INFORMATION`, `WAITING_THIRD_PARTY`, `SCHEDULED_ACTION`, `BLOCKED_BY_OTHER_WORK`, `ON_LEAVE`, `OTHER` (needs words); Khẩn 0 (never), Cần xử lý 3, Theo dõi 14; 2 in a row; the last one tells the next level |
| `CLOCK_POLICY` | time to take an item up, time to resolve it (when the module gives no day), silence threshold, longest pause, pause reasons | take up 2 / 8 / 24 working hours (Khẩn / Cần xử lý / Theo dõi); resolve 8 / 40 / 80; silent after 4 / 24 / 40; pause at most 30 days; reasons `WAITING_EXTERNAL_PARTY`, `LEGAL_OR_AUDIT_HOLD`, `DATA_CORRECTION`, `FORCE_MAJEURE`, `OTHER` |
| `REMINDER_POLICY` | how often an open item is reminded and the most reminders for one item | every 4 / 8 / 40 working hours; at most 40 / 20 / 8 |

`getWorkClockPolicies` (`GET /home/work-clocks/policies`) shows the three as they are in force today with version, formula, source and the years of the working calendar that are published. The screens read the reasons and the caps from it; they hold none.

## Working time

All counting is in working time on the published calendar `WORKDAY_VN` (`work_calendar_version`, ADM; `docs/adm-working-time.md`): weekdays and holidays of the calendar, 08:00-12:00 and 13:00-17:00 in Vietnam. `addWorkingTime` adds working minutes to a moment; `workingMinutesBetween` (added by this lane, its inverse) counts the working minutes between two moments, and is what a pause takes away. A year without a published calendar never gets a guessed day: the clocks that need it are absent and say `basis: CALENDAR_UNAVAILABLE`, a reminder is not invented, and a native clock cannot be started (422 `CALENDAR_NOT_EFFECTIVE`).

## The two clocks of an item

`itemClocks` (kernel) gives each item, when the module says when it started (`startedAt`):

- **claim** (time to take it up): starts at `startedAt`, due after the policy's working hours for the severity, plus the working time paused; `MET` or `MET_LATE` when somebody takes it up, `BREACHED` when the end passes untaken, `PAUSED` while a pause holds;
- **resolve** (time to resolve it): the due day of the module when it has one (a pause does not move a day the module owns, it only stops the clock from being called breached), otherwise the policy's working hours from the start;
- **needs re-claim**: an item somebody took up (lifecycle `CLAIMED`, nothing more from the module or from a handover) with no sign of work for the policy's silence threshold, counted from the latest claim. Taking it up again moves the latest claim and starts the count again.

An item whose module does not give a start (approvals, reports, diaries today) has no claim clock (`basis: NO_START`) and keeps its day; nothing is guessed. Starts that are read: early warning (`opened_at`), advance (day it became overdue), permit (30 days before the end, or the day after it ended), audit recommendation (day after the due day), issue (`overdue_since`), guarantee (30 days before the end).

## Snoozing (G2-1)

`snoozeWork` needs `reason_code` from the rule (and words of five characters or more when the reason needs them). It refuses with 422: `VALIDATION_FAILED` (no or unknown reason, no words), `WORK_SNOOZE_NOT_ALLOWED` (a Khẩn item, or past the day the module says it is due), `WORK_SNOOZE_TOO_LONG` (over the cap of its severity), `WORK_SNOOZE_LIMIT` (already postponed the allowed number of times in a row; a claim or a handover by anyone starts the count again). Each postponement stores the reason code, which one of the series it is, whether it was the last, and the version of the rule that allowed it. The last allowed one records a notice to the next level (`SNOOZE_FINAL_NOTICE`) and the event `home.work_snooze_final.v1`. The list of what is put off now inside a reader's scope is `getSnoozedWork` (screen HOME-12).

## Pausing (G2-2)

`pauseWorkClock` needs a reason code, words, the person who allowed it and an end no later than the policy's longest pause. The person who allowed it is an active member of a unit the caller may read and never the caller (`WORK_CLOCK_ALLOWER_INVALID`; the table refuses it too). While paused the clocks stop; the working time paused is added to their end. `resumeWorkClock` ends a pause early. A second pause while one holds is 409 `WORK_CLOCK_ALREADY_PAUSED`, a resume with none is 409 `WORK_CLOCK_NOT_PAUSED`. Pause and resume are rows of `work_action`.

## Reminders (G2-4)

The job `work-reminder` (every 15 minutes, `docs/runbooks/jobs.md`) goes through the list of each person who may read the alert centre and records every reminder that is due: one row of `work_reminder` (series key = item, person, number of the reminder) and the event `home.work_reminder.v1` in the same transaction. An item is due when the cadence of its severity has passed since the latest of its start, its claim, the end of a snooze or a pause and the last reminder. A snoozed item, a paused one, one that ran out of reminders, a resolved one, and any item in a year without calendar are not reminded. An item somebody took up that then went silent is noticed once for each claim to the next level (`RECLAIM_NOTICE`, `home.work_reclaim_notice.v1`); a claim of an item that was already taken up records the same notice. Who the next level is, and how a reminder reaches a person (quiet hours, grouping), belongs to delivery (G2-5, G2-6); the events name the item, the person and the kind and never the words of anyone.

## The clocks that were there before (G0-2)

| Module clock | Source | Starts | Stops | Pauses | Counts in | Migrated |
|---|---|---|---|---|---|---|
| DIS-20 | `EARLY_WARNING` | a rule fires and the warning opens | resolved or dismissed | an explanation is requested | calendar days | no |
| PAY-12 | `ADVANCE` | the recovery day of the advance passes unrecovered | recovered in full | none | calendar days | no |
| PMT-05 | `PERMIT` | 60 days before the permit ends | renewed or replaced | none | calendar days | no |
| ISS-09 | `ISSUE` | an issue is opened | resolved or closed | an extension granted by the unit | working time (SLA) | no |
| CTR-05 | `GUARANTEE` | 30 days before the guarantee ends | replacement verified or contract ends | none | calendar days | no |

They are wrapped, not changed: the alert centre reads them as they are, shows `existing_clock` beside the two clocks of the item, and moves none of their jobs onto the engine. Each can be moved later, one by one, when its module owner agrees and a test proves the same alerts at the same moments.

## Native clocks (G0-2)

A module with an obligation that has its own limit (a notice to post, a file to hand in; the e-GP lanes are the first users) starts a clock with `HomeWorkClockStore.start`: the owner (a person, a unit or both), the severity, the action expected and the consequence (both mandatory), the working minutes, the screen it opens. The end is counted on the published calendar when it starts and kept with the calendar versions that were read. One running clock for each (type, subject): starting it twice gives the one that runs. It is ended as `MET` or `CANCELLED` with who and why; never deleted. The alert centre lists the running clocks as the source `CLOCK` (kind `CLOCK_DEADLINE`, alert type `CLOCK` in the governance register; the consequence and the expected action of the item are the ones its module wrote when it started the clock, the type gives the frame: owner, response time, review day); the item is urgent once the end has passed and to be acted on when it is within the cadence of the reminder rule of its severity. The module that starts or ends a clock writes its own audit row and event.

## Decisions to review

- The block is V1900-V1919 (the design table put GOV-2 on V1730-V1749, which overlaps PAY-2 and PRJ-2).
- Clocks that need a start the module does not give are absent, not defaulted.
- "Next level" is recorded as an audience, not resolved to a person (delivery lane).
- "Allowed by" for a pause is any other active member of a readable unit; a dedicated permission can replace it later without changing the table.
- All numbers above are starting values to settle with the customer and the auditors.
