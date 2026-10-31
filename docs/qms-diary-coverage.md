# The coverage of the site diary (ST-QMS-008)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/QMS.md` (3.1, BR-QMS-08, QMS-11, UAT-AC364). No migration. Operation: `getDiaryCoverage` (`GET /contracts/{id}/site-diaries/coverage?from&to`, `diary.read`). Job: `diary-coverage` (06:00 Vietnamese time).

## The rule

For a contract and a range of days, every **working day** of the calendar `WORKDAY_VN` up to today is one of three things:

- **SIGNED**: the main diary of the day is signed by the contractor or beyond (`CONTRACTOR_SIGNED`, `SUPERVISED`, `OWNER_CONFIRMED`, `LOCKED`);
- **DRAFT**: the main diary of the day is still a draft;
- **MISSING**: no main diary (`missing = working days - days with a main diary`).

The main diary of a day is the one that is not a copy of a device and not replaced: a correction stands in for the diary it replaced. A day off, a holiday of the calendar and a compensated working day are judged by the calendar; a diary on a day off is not counted. A copy of a device that nobody has settled (`CONFLICT_PENDING`) is counted on its own (`conflict`) and never added to the total, so `signed + draft + missing = working days`.

**Late signature.** The day (Vietnamese time) of the first signature of the contractor on the diary of the day, or on a correction of it, is `signed_on`. The working days from the day of the diary (not counted) up to `signed_on` (counted) are `working_days_to_sign`; one is allowed, so a signature after that is late by `late_days = working_days_to_sign - 1`. A diary signed the same day or the next working day, over a weekend as well, is in time. A correction signed weeks later does not make the diary late: the first signature counts.

**The range.** Without `to` it ends today; without `from` it starts on the first of the month of `to`. A day that is not a day, a start after the end or more than 366 days is 422 `VALIDATION_FAILED` naming `from` or `to`. Days after today are not counted (they are not missing yet): `through` is the last day counted, null when the whole range lies ahead. A year of the range with no published `WORKDAY_VN` calendar is 422 `CALENDAR_NOT_EFFECTIVE`.

**The scope.** The contract must be in the scope of the caller for `diary.read` (a grant on the project or the contract, or on the whole tenant); a contract out of reach does not exist for them (404). The read is one snapshot.

## The answer

`contract_id`, `contract_code`, `calendar_code`, `from`, `to`, `through`, `as_of`, `totals` (`working_days`, `with_diary`, `signed`, `draft`, `missing`, `late`, `conflict`), `days` (for each working day: `date`, `state`, `diary_id`, `status`, `conflict`, `signed_on`, `working_days_to_sign`, `late_days`) and `missing_dates`.

## The morning count

The job `diary-coverage` works in the 06:00 hour of Vietnamese time (the hourly tick does nothing in the other hours). For each contract in execution (`ACTIVE`) it counts the working days of the month up to yesterday that have no main diary, adds them up and sets the gauge `qms_diary_missing_days{tenant_id}`. It changes nothing and tells no one: the people who answer for a contract read the days on QMS-11.

## The screen (QMS-11)

`CoverageScreen`: a contract and a month; the figures; the month as a calendar from Monday to Sunday where each working day up to today says in words (never by colour alone) signed, draft or missing, how many working days late a signature was and whether a copy in conflict waits; a draft links to QMS-02 and a signed diary to QMS-03; the days that are missing are listed. A month that has not come says so; a contract that is not found or a year with no calendar is told in words.

## What is not done

- No notification of a missing diary: the gauge is set and the days are shown, but nobody is told and no alert rule reads the gauge.
- The calendar of a year after the last one published is not guessed: the read is refused for a year of the range; a signature in a year with no calendar is counted by the weekdays.
