# MOB: home dashboards, projects, map, capital plan and report status (ST-MOB-010)

Nine screens of the Flutter application read data the web already shows and put it on a phone: the leader's command center (MOB-07), the officer's work (MOB-08), the funding structure (MOB-58), the project list (MOB-09) and detail (MOB-10), the field map (MOB-11), the lines of a capital plan (MOB-12), the projects that have not reported (MOB-57) and the issues of a week (MOB-59). They read only; nothing on them can be edited, and no command is sent from them. The screens are in `apps/mobile/lib/features/dashboard` (MOB-07, 08, 58) and `apps/mobile/lib/features/project_views` (MOB-09 to 12, 57, 59); what they share is `apps/mobile/lib/features/read_support`.

## One reading rule for all of them: `DataView` (BR-MOB-01, TK-MOB-010-4)

Every screen reads through `DataView<T>`, so the rules of the cache are written once and tried once (`test/features/read_support/data_view_test.dart`):

| rule | what the screen does |
|---|---|
| the server is asked first | the answer is shown and kept as a copy with its `as_of` (the moment the answer describes) and the moment the phone got it |
| the server cannot be reached (`NETWORK_ERROR`) | the copy is shown, above it the line "The server cannot be reached. Showing the copy kept on this device, as of {as_of}", and "Amounts are reference data and cannot be edited" |
| the copy is older than its time to live (12 hours by default, `defaultCacheTtl`) | it is marked out of date and says so |
| there is no copy | the offline state (code `NETWORK_ERROR`), never an empty page |
| the server refuses (401, 403, an expired licence) | the standard denied, signed-out or expired state; the copy is not shown and is deleted |
| the session changes tenant or person, or ends | the whole store is emptied (`readCacheProvider` listens to the session) and a copy is only ever read back under the tenant and the person it was read under |
| the answer lacks what the screen needs | `CONTRACT_MISMATCH` and the code, never half a page |

No text of the application says the data is the newest: the words are "figures as of {time}", "loaded at {time}" and "copy kept on this device"; a test reads every shared string for the words `latest`, `newest` and `mới nhất`. Money is read-only everywhere: the screens contain no input for an amount (the only input on the list is the search box), and a copy repeats that. The clock of the phone is used for one thing, the age of a copy (`clockProvider`); it never judges a deadline, a period or a licence: "overdue", "deadline passed" and "stale snapshot" are the server's words (`overdue`, `deadline_passed`, `freshness`), and the deadline is only *shown*, in Vietnam time (UTC+7, as the calendar of the reports counts).

The copy is held in memory (`InMemoryReadCache`) until the persistent store of ST-MOB-007 plugs in by overriding `readCacheProvider`; the contract it implements is `ReadCache` (read, write, forget, clear, by scope).

## The screens

| screen | operations | rules kept |
|---|---|---|
| MOB-07 leader home | `getCommandCenter` | the two disbursement rates side by side (one under the other at a text scale over 150 percent), each with its numerator and denominator in millions; a rate with no figure shows why (`ZERO_DENOMINATOR`, `NO_DATA`, `TREASURY_COVERAGE_NONE`) and is never 0 percent; a tile without formula, unit or token is not shown, and if one of the two rates is missing neither is shown as a pair; the scope is the one the server read in (the number of its projects); no snapshot yet (404) is the empty state; the snapshot's `freshness` is the server's |
| MOB-08 officer home | `getMyWork` (pages followed) | the work grouped as report deadlines, drafts and assigned work, late first, with the due day, the days late and the day it was first due; only an approval task opens (MOB-24) |
| MOB-58 funding structure | `listAppropriations`, `get_resources_allocation_line` | the web rule HOME-07: only published appropriations of a year; CTMTQG is "of which" under NSTW, read from the plan lines, and is in no total (420 million, never 460, UAT-AC240); a CTMTQG registered as a source of its own is a part of NSTW; a source with nothing says "no data" and is not zero; a part that could not be read says so |
| MOB-09 project list | `get_resources_project` | search (ignores case and the marks of Vietnamese) and stage filter on the copy in memory, so they work offline; every row says its `as_of` |
| MOB-10 project detail | `get_resources_project_id`, `listProjectMilestones`, `listProjectRisks` | stage, investment (read-only), milestones with delays, risk counts and the highest risks; a part the reader may not read says so (it is not shown as empty or zero) |
| MOB-11 field map | `get_resources_project`, `get_resources_project_id` | see "Map policy" |
| MOB-12 capital plan lines | `get_resources_plan_version`, `listCapitalPlanLines` | the published plan of the newest year (or `?plan=`), lines by fund source: allocated, CTMTQG "of which", disbursed; a line with no disbursement figure says so |
| MOB-57 projects not reported | `get_resources_reporting_period`, `getSubmissionProgress` (state `MUST_REPORT`), `get_resources_project` (leaders) | submitted projects are left out; so is any project whose unit is not among the units the board counted (0 out-of-scope projects); the deadline of the period in Vietnam time; overdue is the server's |
| MOB-59 weekly issues | `getIssueWeeklyMatrix` | ISO week (the week of today in Vietnam time, or `?week=`), arrows to the week before and after; opening, raised, resolved, closing and overdue per unit and group and for the whole scope |

The seven states (content, loading, empty, error, denied, expired licence, offline, and the ended session) are those of `StateBoundary`; each screen is driven through all of them and through the three device sizes at 200 percent text, with the tap-target, label and contrast guidelines, by `expectEveryState` and `expectScreenContract` (`test/features/support/screen_contract.dart`).

## Map policy (TK-MOB-010-2)

The API holds no coordinates for a project and the domestic tile provider is not chosen, so MOB-11 draws no basemap and downloads and stores no tile (`MapTilePolicy.downloadsTiles` and `storesTilesOffline` are false, and a test shows that the screen requests nothing but the register and the projects). Projects are placed under the area they pin; those that pin none are listed apart and never put in the middle of a province. How a position was fixed is always said in words (`LocationSource`: by area, from the device, entered by hand, BR-MOB-06), ready for the day coordinates exist. Changing the tile policy is a decision of the product owner and of Security (a cached tile shows where officers work).

## Not done here, and why

- The sync-contract entries of TK-MOB-010-5 (the tables and columns of these screens in the sync rules) belong to the PowerSync rules of ST-MOB-007; the screens read through the API and keep an in-memory copy until that store exists.
- MOB-09 has no "area" filter: the register line does not carry the area; MOB-11 groups by it, which costs one read per project (at most 100).
- "Person in charge" on MOB-57 comes from the project register, because the board does not carry it.

## What only a device can prove

Three days offline on a real phone with the persistent store (the copy survives a restart, and a revoked membership empties it), TalkBack and VoiceOver reading of the tiles and rows, and the look of the side-by-side rates on a 360 dp screen. These become external checks of the story.
