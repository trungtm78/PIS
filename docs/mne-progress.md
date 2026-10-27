# Filing progress of the monitoring reports (ST-MNE-006)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F2, BR-MNE-04). No migration of its own (the day of the filing is `mne_report.filed_on` of V1705, ST-MNE-007) and no new operation: the screen MNE-09 reads `listMneObligations` (`mne.read`, in the units of the grant).

## What it shows

For each obligation of the year, in the units the reader may read: the unit, the period, the form, **the rule and the version of it that was applied** (the revision in force on the last day of the period, BR-MNE-02), the due date, **the day it was filed** and its progress, **in words and with the number of days**, never a colour alone:

| Progress | When | Text |
| --- | --- | --- |
| on time | filed on or before the due date | "On time" |
| late | filed after it | "N days late", counted from the day it was filed to the due date |
| open and late | not filed and past the due date | "Not filed, N days late to date", counted to today (Vietnam) |
| open | not filed and not yet due | "Not filed, not yet due" |

A report that was filed before the day was kept (no `filed_on`) and was late is "late, days not known". An obligation whose first revision a correction superseded is judged by the day the obligation was first filed, not by the status of that revision (ST-MNE-007).

`listMneObligations` now answers `filed_on` for each obligation, and `days_late` of a filed one is counted from that day (it was `null` for a late filing and `0` otherwise before). The screen sums the whole year by progress (reading the next pages until the list is complete), lists the late ones first (the longest first), can show only them, and reads the year the person chooses.

## Assumptions and limits

- The rule version is read from the shell the calendar made (`obligation_rule_id`), so a period follows the revision in force at its end even after a later revision exists: H1-2026 under a revision that takes effect on 2026-06-01 is due on the 15th of July while a revision of 2027 never changes it (the scenario of UAT-AC299, tested in the store and on the screen).
- The summary counts the obligations of the year for the units the reader reaches; it is not a ranking of units (that is DIS-20).
