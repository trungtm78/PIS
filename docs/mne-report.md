# The periodic overall report of monitoring and evaluation (ST-MNE-002)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md` (F3, BR-MNE-02). Migration `V1702__mne1_report_workflow.sql`. Operations: `createMneReport`, `editMneReport`, `submitMneReport`, `getMneReport`. Screen: MNE-03. Event: `mne.report.submitted.v1`.

## What a report is made of

A report is a row of `mne_report` on **the revision of its form in force on the last day of its period** (BR-MNE-02): `YEAR-2026` and `H2-2026` end on 2026-12-31, `H1-2026` on 2026-06-30, a weekly label (anything else) is read from the reporting period named by `period_id`. The form can be named by any of its revisions: the code is what counts. No revision in force is **422 `FORM_NOT_EFFECTIVE`** with `form_code`, `period_end` and `effective_from` of the nearest later revision. A report keeps the revision it was made on: closing that revision later changes nothing for it.

What a form asks for is data: `schema_json.fields[] { key, label, kind, required, source? }`.

| `kind` | value written |
| --- | --- |
| `MONEY` | whole dong as a decimal text |
| `PERCENT` | a decimal text with up to four decimals |
| `INTEGER` | a whole number |
| `TEXT` | up to 4000 characters |

A field with a `source` is **filled by the system and locked**; the others are written by the preparer. Sources: `SNAPSHOT_METRIC` (`plan_total_vnd`, `plan_pm_assigned_vnd`, `disbursed_treasury_vnd`, `rate_pm_pct`, `rate_total_pct`, `project_count`), `PROJECT_COUNT` (of a stage), `WARNING_COUNT` (open early warnings, of a severity), `APPROPRIATION_TOTAL` (published appropriations of a plan year). The form is read when it is drafted: a key that is not a name, a duplicate, an unknown kind or source, or a `TEXT` cell with a source is **422 `VALIDATION_FAILED`** naming the field. A form with no fields (the platform pack, while it waits for its legal confirmation) gives an empty shell.

## The figures

The snapshot must be **FROZEN** (422 `SNAPSHOT_NOT_FROZEN`), of kind `PERIOD_CLOSE` or `MNE`, and of a day not after the end of the period (else 422 `VALIDATION_FAILED` on `snapshot_id`). A report without one is **422 `SNAPSHOT_REQUIRED`**. The cells are filled from the lines of the snapshot with the same sums and the same rules as DIS-19: `DisSnapshotStore.rateSums` over the current-year bucket and kernel `rateOfSums`, so the rates of the report are the rates of the dashboard (the sum of the numerators over the sum of the plans, never the mean of rates). Plan 1250 billion (1000 billion from the Prime Minister) and 600 billion paid gives 48.0000% and 60.0000%. A rate with nothing to divide by is **null, never zero**, and a required cell that is null is missing when the report is handed in. The figures are those of the **unit and everything under it** (the project, for a project-level form): who may prepare the report for the unit is judged before they are read, so the report does not change with who edits it.

## Commands

- **create** (`mne.report.prepare`, in the units of the grant: 403 `SCOPE_DENIED`, 404 for a unit that is not there): the key is form code, unit, project, year and period; a second report of the key is **409 `REPORT_EXISTS`** and names the first (`report_id`). The filing calendar (ST-MNE-001) has already made a DRAFT shell of every obligation: it is **opened by an edit** that attaches the snapshot.
- **edit** (versioned, DRAFT only: 409 `REPORT_STATE_INVALID` names the state): a narrative is merged into the report; a cell with a source is **422 `FIELD_SOURCE_LOCKED`** (every one listed in `fields`), a cell the form does not have or a value of the wrong kind is 422 `VALIDATION_FAILED` on `narrative.<key>`; `null` clears a cell. `attachments` are documents that can be used (422 `DECISION_REQUIRED` otherwise), without repeats. `snapshot_id` attaches or replaces the snapshot and fills the locked cells again.
- **submit** (versioned): DRAFT to IN_REVIEW; needs the snapshot (422 `SNAPSHOT_REQUIRED`) and every required cell (422 `VALIDATION_FAILED`, `missing_fields`). It records who handed it in and when, and emits `mne.report.submitted.v1` for the reviewer (ST-MNE-003).
- **get** (`mne.read`): in the units of the grant, 404 outside them and for another tenant. It returns the cells of the form with their value, whether they are locked and where they come from, so that MNE-03 can open the HOME drill behind each.

A report that left DRAFT keeps its form, unit, project, period, snapshot and figures **in the database too** (`guard_mne_report`): a change is a new revision (ST-MNE-007).

## Screen MNE-03

Opened from the draft reports of the filing calendar (`?report=<id>`). The header names the form revision, the unit, the period and **the snapshot with its as-of date**; the table shows each cell with its value (dong with dots, percent, count), a **locked** mark and **a link to the HOME drill of the snapshot for every figure** (`/home/home-10?source=…&snapshot=…`), the narrative cells as text areas. Save sends only the cells that changed (an emptied cell as null); the hand-in saves what changed first and is offered only with a snapshot and with every required cell filled. A report that is not a draft, a reader, and a suspended tenant see it read-only with the reason. The seven standard states are the shared ones.

## Assumptions and limits

- The pack of forms (`form-pack.json`) has no fields yet: the layout of TT 44/2026/TT-BTC awaits the legal confirmation (CXN-10). The cells above are what a tenant (or the pack, once confirmed) declares in `schema_json`.
- A report has no project, evaluation or weekly editor here (MNE-04, MNE-07, MNE-08 are other stories); the commands accept a project, and its figures are those of that project.
- Attachments are accepted by the API; MNE-03 does not offer them yet.
