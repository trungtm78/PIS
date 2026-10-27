# Warnings and ranking of the command center (ST-HOME-003)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/HOME.md` (F3, F4, BR-HOME-05, BR-HOME-06). Two reads, `getHomeWarnings` (`GET /home/warnings`) and `getDisbursementRankings` (`GET /home/rankings`), both `home.read`; no table, no migration. The screens are HOME-03 (the list of warnings), HOME-06 (the profile of one) and HOME-04 (the ranking). HOME computes and keeps nothing: the warnings are those of DIS (ST-DIS-012), the ranking is the one DIS computed when the close snapshot was frozen (ST-DIS-013).

## getHomeWarnings

Query: `severity` (`INFO`, `WARNING`, `CRITICAL`), `rule_code`, `snapshot_id` (the snapshot a warning was opened on), `limit` (1 to 200) and `cursor` (the moment and the id of the last one), and `warning_id` for the profile. `rule_code` and `warning_id` are not in the contract of the list yet (`openapi.json` names `snapshot_id`, `severity`, `cursor`, `limit`): the server takes them, and the web client types the profile query accordingly; they are to be added to the next revision of the contract.

- **The list** is of the **open** warnings (`OPEN`, `ACKNOWLEDGED`, `EXPLANATION_REQUESTED`) of the projects the reader may read (the project scope of `home.read`), newest first. Each item has the rule (`code`, `name`, `metric_code`, `comparator`, `threshold`), `severity`, `status`, the `project`, `observed` (what the rule measured: for EW-01 `observed_pct`, `expected_pct` and `gap_points`), the `snapshot_id`, `opened_at`, `version`, the **leader in charge now** (read as DIS-24 reads it, `null` when none) and the **explanation** that was asked for (`id`, `status`, `due_at`, `is_late`, or `null`).
- **The profile** (`warning_id`) is of one warning **whatever its status** (a warning that was closed has a profile too) and adds the **evidence**, the cells of the project in the snapshot the warning was opened on with the day the figures are as of, and the **history**: opened, acknowledged (who, why), explanation asked for, explanation answered, resolved or dismissed (who, why), in the order of the moments, none before the day the warning was opened (`warningHistory` of the kernel). A warning that is not in the scope of the reader is 404 `RESOURCE_NOT_FOUND` and names nothing of it.
- Warnings of a unit (not of a project) are not in the list: the scope of the warnings of DIS is the project scope, as for DIS-23.

HOME-06 acts through the commands of other modules, each under its own right (a button the reader may not use is not there): **ask for an explanation** (`requestExplanation`, PRJ, `explanation.request`: the question, a day, the leader in charge as the one asked, the warning and its rule), **acknowledge** (`acknowledgeEarlyWarning`) and **dismiss** (`dismissEarlyWarning`) (DIS, `warning.handle`: a reason of five characters, the version the screen showed). A warning that moved (409 `VERSION_CONFLICT`) is read again and what was typed is kept; a state that does not allow the action (409), a right not held (403) and a request that is not good (422) are told in words. A closed warning, a warning with no leader (for the explanation) and a read-only system offer no action.

## getDisbursementRankings

Query: `snapshot_id` (a frozen snapshot that has a ranking; the latest frozen close snapshot that has one when none is named), `comparison_group`, `denominator_kind` (`PM_ASSIGNED`, `TOTAL_INCL_LOCAL`). 404 `RESOURCE_NOT_FOUND` when no snapshot has a ranking, or the one named is not frozen or has none. The answer: `snapshot_id`, `as_of_date`, `treasury_cutoff_date`, `definition_status`, `legal_confirmation_refs` (`CXN-03`), `visibility`, and `tables`: one for each comparison group and each denominator (**never mixed**: the order is not the same over the two, FX-DIS-007), each with `ranked` (rank, unit, plan, disbursed, rate, the rate with four decimals) and `excluded` (the unit with its reason and no position: `ZERO_DENOMINATOR`, `PLAN_BELOW_MINIMUM`, `NO_DATA`).

- **BR-HOME-06, the visibility**: the policy `ranking_visibility` of the tenant (`ALL`, or `OWN_ONLY`: only the units the reader may read) is applied by the server. The tenant setting does not exist yet: the policy is a provider (`HOME_RANKING_VISIBILITY`, a function of the tenant) that answers `ALL` when none is bound. With `OWN_ONLY` a unit keeps its rank among all the units (the table is not re-numbered for the reader).

## The screens

- **HOME-03**: filters (severity, rule), a table with the severity as an **icon and a word**, the rule, the project, the observed against the expected ("22% against the expected 45%"), the leader (or "not assigned"), the explanation (or "not asked for", with "late"), and the way to the profile; the next page. Seven states.
- **HOME-06**: the cause (rule, project, observed, gap, threshold with the note that it is a working assumption under CXN-03), the evidence (snapshot and day, the cells), the leader, the explanation, the history, and the actions above. A warning that is not there (404) is a page of its own; no warning named in the address asks nothing of the server. Seven states.
- **HOME-04**: the denominator is chosen (one table at a time for the group, the other is a table of its own), the group is chosen, the snapshot and the day are shown with the note that the formulas are proposals, and the units that were left out are listed with their reason below the table. A rate that is missing says "no data", never 0. Seven states (the 404 of a tenant with no ranking is the error state).

## Assumptions and limits

- The counts of the command center follow BR-HOME-05 (corrected here, ST-HOME-001): the overdue explanations count those marked overdue and those requested, sent back or answered whose day is past and that are not concluded; the reallocation proposals that wait are those submitted or approved and not yet applied.
- The profile does not show the names of who acknowledged or closed a warning (the history carries the member ids; the names of members are DIS-23's to show, with `warning.read`).
- The drill from the ranking and the warnings figures (HOME-10) has no tile yet.
