# DIS-20: the early-warning rules and the warnings (ST-DIS-012)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F7, BR-DIS-13). Migration: `V1049__dis1_early_warning.sql`. Screen DIS-20 (`/dis/dis-20`).

## What the story adds

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `createEarlyWarningRuleVersion` | `POST /early-warning-rules` | `warning.rule.manage` | A new revision of a rule (the first when the code is new), as a DRAFT. A metric the product does not compute is 422 `METRIC_UNKNOWN`; any other fault is 422 on its field. |
| `publishEarlyWarningRule` | `POST /early-warning-rules/{id}/publish` | `warning.rule.approve` | Publishes a draft under the version shown. The author is 403 `SELF_APPROVAL_DENIED`; the revision in force is retired in the same step; an older revision cannot take the place of a newer one (409 `STAGE_TRANSITION_DENIED`). Event `warning.rule_published.v1`. |
| `listEarlyWarningRules` | `GET /early-warning-rules` | `warning.read` | Additive read: every revision of every rule; for a draft, `preview.would_open`, the number of warnings it would open on the latest frozen close snapshot over the projects the caller may read (the preview of the policy editor). |
| `acknowledgeEarlyWarning` / `dismissEarlyWarning` | `POST /early-warnings/{id}/acknowledge`, `/dismiss` | `warning.handle` | A warning of a project in the scope of the caller, under the version shown, with a reason of at least five characters. OPEN to ACKNOWLEDGED (who, when, the note and the owner kept); OPEN or ACKNOWLEDGED to DISMISSED (the reason, who and when). Anything else is 409 `WARNING_STATE_INVALID` naming the status. Dismissal raises `warning.resolved.v1`. |
| `listEarlyWarnings` | `GET /early-warnings` | `warning.read` | The warnings of the projects in scope, newest first, narrowed by status, severity, rule code, project and unit, a page at a time. |

## Rules are data

A rule has a code, a metric, a comparator, a threshold, a severity, a scope, whether it asks for an explanation (`auto_explanation`), its legal basis and the days it is in force. Once it is made it never changes (`early_warning_rule_guard`): a change is the next revision, a draft until someone else publishes it (`early_warning_rule_sod_chk` of V002 and the check that a published rule has who approved it); one revision of a code is published at a time (unique index), the earlier one becomes RETIRED; two drafts of one code that arrive together are published one after the other (an advisory lock on the code). R1 evaluates rules of the scope PROJECT with four metrics (a rule of the scope UNIT or TENANT is refused until a release evaluates it):

| Metric | Comparator | Threshold (`threshold_json`) | Violated when |
|---|---|---|---|
| `YTD_RATE_GAP` (EW-01) | `GTE` | `{points, critical_points?}` | the project's rate on the whole year plan is at least `points` below the expected curve; at `critical_points` or more the severity is CRITICAL whatever the rule says |
| `REPORT_OVERDUE` (EW-02) | `MISSING` | `{grace_days, explanation_due_days}` | no report was handed in for the period and the deadline (by the Vietnam day) is more than `grace_days` past |
| `NATIONAL_CODE_MISSING` (EW-05, CXN-01) | `MISSING` | `{}` | the project has planned capital and no national project code |
| `PERIOD_DELTA_NEGATIVE` (EW-07) | `LT` | `{}` | what the project's cells changed in the period is below zero |

The expected curve is the share of the year gone on the cutoff day (a straight line over the days of the year; the line of what the project registered comes with the forecast). A project with no rate (the Treasury booked nothing) is not a project with a low rate: EW-01 is silent for it. Every tenant is given EW-01, EW-02, EW-05 and EW-07 as drafts by the baseline (`DisWarningStore.ensureSeedRules`), with thresholds that are assumptions awaiting the finance office.

## The warnings

- **The job** `dis.warning-evaluate` is `WarningEvaluateConsumer`, a consumer of the outbox for `snapshot.frozen.v1` (once per event: the inbox row is written with the warnings). It evaluates only a snapshot that is FROZEN, is a close figure, has not been superseded and is not of a period older than one that already has a frozen close snapshot (`OLDER_PERIOD`): the warnings of a year are shared by its periods, so the evaluations of a year take turns (an advisory lock) and an older period never overwrites what a newer one has said.
- **One warning for a key.** The `dedupe_key` is `rule_code|project|plan_year`, and for the rules of a period (`REPORT_OVERDUE`, `PERIOD_DELTA_NEGATIVE`) `rule_code|project|plan_year|period`; the unique index of V002 holds one open warning for it. A snapshot that finds the violation again updates the figure, the severity and the snapshot of the open warning and opens nothing; a violation that is gone closes the warning as RESOLVED with the reason `AUTO_CLEARED`; a violation that comes back after a closed warning opens a new one.
- **Events:** `warning.opened.v1 {warning_id, rule_code, severity, subject: {project_id, unit_id}, auto_explanation, explanation_due_days, dedupe_key, snapshot_id, observed}` (PRJ creates the explanation request from `auto_explanation`), `warning.resolved.v1 {warning_id, rule_code, resolution: AUTO_CLEARED | DISMISSED, project_id}`, `warning.rule_published.v1`. The gauge `dis_warning_open_gauge{severity}` counts what is still to be handled.
- **The table** (`early_warning_guard`): a warning is kept, what opened it (rule, project, unit, period, key) never changes, while it is open the figure, the severity and the snapshot follow the latest snapshot, it moves only OPEN to ACKNOWLEDGED to EXPLANATION_REQUESTED (set by PRJ with its request) or closes, and a closed warning is final.

## The screen

DIS-20: the rules with metric, threshold in words, severity, state in words, legal basis and the preview of a draft; "Công bố" for a draft (only for `warning.rule.approve`, and the refusal for the author is told in words); "Tạo quy tắc" and "Tạo bản mới" (only for `warning.rule.manage`) open the editor, whose threshold fields follow the metric and which is checked field by field and by the server; the warnings with rule, project, severity, what was seen against what was expected, state and, for a closed one, the reason; filters by status, severity and rule; "Tiếp nhận" and "Bỏ qua" (only for `warning.handle`, and only for a state that allows them) behind a dialog that asks for the reason.

## Assumptions

- The thresholds, the straight expected curve, and the rate on the whole plan as the figure EW-01 reads are proposals until the finance office signs them.
- EW-02 is evaluated when a close snapshot is frozen, with the day of that evaluation as "today": a snapshot frozen before the deadline opens nothing, and the next snapshot (or a rebuilt one) does; a daily check of the deadlines is part of the job platform (Temporal) that is not built.
- EW-03, EW-04, EW-06, EW-08 to EW-11 are R2.
