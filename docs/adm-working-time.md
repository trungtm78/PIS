# ADM working time: the contract of XM-ADM-01 (ST-ADM-010)

Every module that counts a deadline in working time (the approval tasks of ADM, the issue SLA of ISS, the conversation SLA
of OMNI, the reporting-period owners) counts it with one function and one source of calendars. This note is the module
contract for them.

## The two calendars and how they differ

| | Working calendar (ADM-07, this note) | Reporting calendar (MDM-11, master type CALENDAR) |
|---|---|---|
| Answers | Which days are worked, so how long a duration of hours lasts | Which reporting week a day belongs to and when that week's report is due |
| Data | `work_calendar_version`: working weekdays, holidays with legal basis, compensated working days, one version per calendar code and year | Master rule `CALENDAR`: week start, due weekday and time, time zone, versioned as a master record |
| Code | `packages/kernel/src/working-time.ts` (`addWorkingTime`) | `packages/kernel/src/reporting-calendar.ts` (`reportingPeriods`, `periodOf`, `isLate`) |
| Read by | `WorkCalendarStore.source` | `MasterRules.calendarPeriods`, `MasterRules.boundDeadline`, `MasterRules.isLate` |

Nothing is stored twice: the reporting calendar holds no holiday and the working calendar holds no week. They share the day
arithmetic (`dayOf`, `isoOf`, `weekdayOf`, exported by `reporting-calendar.ts`) and the time zone (`CALENDAR_TIMEZONES`,
`Asia/Ho_Chi_Minh`, fixed offset +07:00). A module that needs "the due time of the weekly report, counted in working hours"
takes the period and its `deadlineAt` from the reporting calendar and, if its rule says the deadline moves off a non-working
day, adds the working time with `addWorkingTime`. Both bind what they computed to the version they used.

## The function

```ts
addWorkingTime(calendars: WorkCalendarContent | WorkCalendarSource, start: Date, duration: { hours?: number; minutes?: number }, intervals?: WorkingInterval[]): Date
```

- Time counts only inside the working intervals of working days. The default intervals are 08:00-12:00 and 13:00-17:00
  (BR-ADM-08); a module with its own window passes `intervals` (the ISS SLA works 07:30-17:00).
- A start outside the intervals begins at the next interval. A duration that ends exactly where an interval ends falls due at
  that moment. A zero duration returns the start unchanged.
- A day is worked if it is a compensated working day, or if it is not a holiday and its ISO weekday (1 = Monday to 7 = Sunday)
  is in `working_days`. A holiday wins over a compensated day (the calendar refuses both on one date).
- A deadline may run into the next year: pass a `WorkCalendarSource` (`forYear(year)`). A year without a published calendar
  fails with 422 `CALENDAR_NOT_EFFECTIVE`; the function never guesses a weekly pattern. It counts no further than three years.
- Golden answers: `packages/contracts/test-vectors/work-calendar.json`, used by the kernel test. A port of the function (the
  mobile client, another language) must give the same answers.

## Getting the calendars

`new WorkCalendarStore().source(tx, calendarCode, fromYear)` returns the published versions of the calendar for the years from
`fromYear` to three years later. Call it inside the tenant transaction that stores the deadline.

## A deadline already counted does not move

Publishing a new version applies to the deadlines counted afterwards. The module that stores a deadline stores with it the
ids of the calendar versions it was counted by (the version of each year the count passed through, `WorkCalendarRow.id`),
the way a reporting period stores `calendarVersionId`. Recounting an old deadline is a deliberate act of that module, never a
side effect of a publication.

## Validation

`validateWorkCalendar` refuses a version with 422 `CALENDAR_INVALID` and lists every finding in `errors` as
`{ field, code, message }` (`message` is an i18n key under `adm.calendar.error`): a date that is not a date, a date outside
the year of the calendar, a date listed twice, no working weekday, a holiday without a name, a blank legal basis, a
compensated day that is a holiday or an ordinary working day.

## Events and permissions

`adm.work_calendar.published.v1 { id, calendar_code, year, revision }` after a publication. Both commands need
`adm.calendar.manage` on the whole tenant. The calendar is not maker-checker (BR-ADM-01 does not list it): the publisher may be
the author; both are audited.

## Used by the clocks of the alert centre

`workingMinutesBetween` (the inverse of `addWorkingTime`) and the calendar `WORKDAY_VN` are what the two clocks of an item, the pauses and the reminders of the alert centre count in; see `docs/work-clocks.md`.
