# Weekly quick report (ST-MNE-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F3, FR-MNE-07). The legal basis, Công văn 3665/BTC-PTHT (2026), waits for **CXN-11**: the form, its cells and its template are working assumptions and say so (the label of the confirmation on the screen, the watermark `Mẫu chờ xác nhận pháp lý [CXN-11]` on every file). No migration and no new operation: the story lists none. The weekly report is a monitoring report like the others (MNE-03 writes it, MNE-05 approves and issues it, MNE-06 exports it); what this story adds is its form, its source of the slow projects and the screen MNE-07.

## What the form holds

`apps/api/src/modules/mne/form-pack.json` gives `CV3665-WEEKLY` its cells (they were empty while the story was waiting):

| Cell | Kind | Filled from |
| --- | --- | --- |
| `rate_pm_pct` | PERCENT | the frozen snapshot: disbursed over the plan assigned by the Prime Minister |
| `rate_total_pct` | PERCENT | the same snapshot: the same numerator over the whole plan |
| `plan_total_vnd`, `disbursed_treasury_vnd` | MONEY | the sums the two rates are made of |
| `slow_projects` | TEXT | the new source `SLOW_PROJECTS` (below) |
| `proposals` | TEXT | written by hand (the only cell the preparer writes) |

The two rates and the sums come from the **same code and the same snapshot as DIS-19** (`rateOfSums` over `DisSnapshotStore.rateSums`, the unit and its sub-units), so the figures cannot differ from the dashboard: 1000 billion from the Prime Minister, 1250 billion in all and 600 billion paid give 60.0000 and 48.0000. A rate with nothing to divide by is missing, never 0 (the report cannot be handed in until it has one).

The DOC template `MNE-CV3665-WEEKLY` (group `REPORT_MONITORING`, source module MNE, label CXN-11) is in the platform pack, so the form and the rule `WEEKLY_QUICK` (Friday 16:00, `PROVINCIAL_PEOPLE_COMMITTEE`) are no longer skipped when a tenant loads the MNE pack: the calendar generates a shell for each week of the reporting calendar, due on the Friday that closes it.

## The slow projects: source `SLOW_PROJECTS`

A form cell of kind TEXT may take `{ "kind": "SLOW_PROJECTS", "limit": 1..20 }` (5 when none is given). It is the only source that is a text, and a text with any other source, or a figure with this one, is refused when the form is read (422 `VALIDATION_FAILED`, `schema_json.fields[i].source`). Filled when a snapshot is attached, locked like any figure (422 `FIELD_SOURCE_LOCKED` when a narrative names it).

- **What counts**: the projects owned by the unit of the report or a unit under it that have an **open** (`OPEN`, `ACKNOWLEDGED`, `EXPLANATION_REQUESTED`) early warning of the rule **EW-01** (the cumulative rate behind the expected one, DIS). A closed warning, a warning of another rule and a project of another unit are not in it.
- **Order**: the furthest behind first (`gap_points` of the observed values of the warning, numeric), then by project code; cut at `limit`.
- **Leader**: the `LEADER_IN_CHARGE` of the project now, read as DIS-24 reads it; `chưa phân công` when there is none.
- **Text** (`slowProjectsText` of the kernel): one line each, `1. DA-02 - Cầu Bến Lức; lãnh đạo phụ trách: Nguyễn Văn A; chậm 35.5000 điểm so với kỳ vọng`; no project is slow: `Không có dự án nào đang bị cảnh báo chậm giải ngân.`. A line is cut at 190 characters, so that twenty of them always fit what a text cell takes (4000).

The list is filled once, from the warnings at the moment of the writing or of the attaching of the snapshot, and is frozen into the payload at the hand-in like every cell (the hash of issue covers it).

## Screen MNE-07

`apps/web/src/screens/mne/WeeklyQuickScreen.tsx`, route `/mne/mne-07`, permission `mne.read`. Read-only.

- The year and the **week** are the person's to choose; the weeks are the weekly obligations of the year (`listMneObligations`, all pages read), the latest due date first. It opens on the latest week that is due by today (Vietnam), the earliest of the year when none is due yet.
- For the week: the form, the status, the label of the confirmation, the unit, the period and **due date**, the day the figures are as of (or that no snapshot is attached yet), **the two rates side by side** (`data-rate="pm"` and `data-rate="total"`, with the words DIS-19 uses and the percent as it uses it), the two sums, the slow projects one line each, the proposals, and a link that opens the report in MNE-03.
- A rate that the report does not have says so ("Chưa có số liệu"); the two are always shown together.
- Seven states: loading, empty (no weekly obligation in the year), error, offline, denied, signed out, and the report of the week has its own states (denied or failed) while the picker stays.

## Assumptions and limits

- The weekly disbursement of the week (the difference of two closings, `weeklyActual` of DIS-24) is not a cell yet: the form holds the cumulative figures of the snapshot. CV 3665 decides the layout (CXN-11); the cell is added with the confirmed form.
- The list shows the warnings as they stand when the cell is filled. A re-evaluation of the warnings after that changes the DIS list, not a report that was handed in.
- The legal owner has not confirmed the form (review `legal-template`), so the story is DONE_UNCONFIRMED.
