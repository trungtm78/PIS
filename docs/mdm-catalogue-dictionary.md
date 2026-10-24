# Catalogue and rule data dictionary (MDM, ST-MDM-003)

Every entry of these catalogues is a `master_record` with effective-dated `master_record_version` rows (BR-MDM-01, BR-MDM-02). The attributes below are the `attributes` object of a version; `packages/db/src/master-types.ts` is the single definition that the server enforces, `apps/web/src/screens/mdm/typeForms.ts` gives the forms the same attributes. Entries marked "baseline" are published by the platform in the namespace `PLATFORM` (`packages/db/src/master-baseline.ts`, job `master-baseline-sync`); a tenant never edits them.

## Catalogue types

| Type | Screen | Who writes (baseline policy) | Attributes | Rules the server enforces |
|---|---|---|---|---|
| `FUND_SOURCE` | MDM-04 | Platform only; retiring needs a successor | `category` (NSTW, NSDP, ODA, CTMTQG, OTHER), `relation` (ADDITIVE, SUBSET_OF), `onlending` (boolean, ODA only) | CTMTQG is always SUBSET_OF, else 422 `SUBSET_SOURCE_NOT_ADDITIVE` (BR-MDM-06); a subset names a parent that is not itself a subset (CTMTQG: NSTW or NSDP); ODA is ADDITIVE and says whether it is on-lent; no other category carries `onlending` |
| `PROGRAM` | MDM-05 | Platform, extended by the tenant with child entries | `kind` (CTMTQG, NATIONAL_TARGET, SECTORAL, LOCAL), `period_from`, `period_to` (years 2000..2100), `fund_source_key` | `period_to >= period_from`; a CTMTQG programme names a funding source of category CTMTQG; a named source must exist |
| `SECTOR` | MDM-06 | Platform, extended by the tenant | `sort_order` (optional); other attributes are free | none beyond the type of `sort_order` |
| `PROJECT_GROUP` | MDM-07 | Platform only; retiring needs a successor | `rank` (1..10) | `rank` is required |
| `PROJECT_TYPE` | MDM-07 | Platform, extended by the tenant | `kind` (CAPITAL_WORKS, PROCUREMENT, PREPARATION, OTHER, optional) | none |
| `PROJECT_STAGE` | MDM-08 | Platform only; retiring needs a successor | `sequence` (1..100), `allowed_next` (keys of other stages), `terminal` | a stage never leads to itself or to an unknown stage, lists no stage twice, and a terminal stage leads nowhere |
| `DECISION_AUTHORITY` | MDM-09 | Platform, extended by the tenant | `agency_key`, `decision_type_key`, `scope` (NATIONAL, MINISTRY, PROVINCE, COMMUNE) | the decision type must exist |
| `UNIT` | MDM-12 | Platform, extended by the tenant; retiring needs a successor | `dimension` (LENGTH, AREA, VOLUME, MASS, COUNT, OTHER), `factor` (positive decimal string to the base unit of the dimension), `scale` (0..8), `rounding` (HALF_UP, HALF_EVEN, DOWN, UP) | the factor is an exact decimal, never a float; zero is refused |
| `CURRENCY` | MDM-12 | Platform only; retiring needs a successor | `iso_code` (three capital letters), `scale` (0..4), `rounding` | the key of the entry is its ISO code |
| `DOCUMENT_TYPE` | MDM-13 | Platform, extended by the tenant | `checklist` (identifiers), `mime_types` (media types such as application/pdf, at least one), `max_size_mb` (1..2048) | media types are valid and unique |
| `CONTRACT_TYPE` | MDM-14 | Platform, extended by the tenant | `required_fields`, `version_policy` (NEW_REVISION, ANNEX_ONLY, LOCKED_AFTER_SIGNING), `is_annex` | none beyond the types |
| `PAYMENT_TYPE` | MDM-15 | Platform only; retiring needs a successor | `kind` (PAYMENT, ADVANCE, RETENTION_RELEASE), `conditions`, `rule_set_key` | none beyond the types |
| `ISSUE_CATEGORY` | MDM-17 | The tenant's own; a tree | `handler_unit_key`, `sla_priority_key` | the priority must exist; an entry that issues or SLA policies use is retired only with a successor (409 `MASTER_IN_USE`) |
| `PRIORITY` | MDM-18 | The tenant's own (the platform ships four) | `rank` (1..10), `response_hours`, `resolution_hours`, `working_calendar` (ALL_DAYS, WORKING_DAYS), `escalate_after_hours` | the answer time does not exceed the resolution time; the escalation comes within it |
| `CONTRACTOR_CRITERION` | MDM-19 | Platform, extended by the tenant | `category` (QUALITY, SCHEDULE, SAFETY, COST, COMPLIANCE), `scale_max` (1..100), `evidence_required` | none beyond the types |
| `EXPERT_ROLE` | MDM-20 | Platform, extended by the tenant | `specialty`, `conditions` | none beyond the types |
| `CONTACT_PURPOSE` | MDM-21 | Platform only | `consent` (NOT_REQUIRED, EXPLICIT), `security_level` (PUBLIC, INTERNAL, CONFIDENTIAL) | none beyond the types |
| `LANGUAGE` | MDM-22 | Platform only | `native_name` | the key is a language code (`vi`, `pt-BR`) |
| `SHARED_TEXT` | MDM-22 | The tenant's own | `translations`: a text per language code | language codes are valid, texts are not empty |
| `DECISION_TYPE` | MDM-10 | Platform, extended by the tenant | `required_fields` (lower-case identifiers), `template` | identifiers are unique |

A type without a definition (areas, agencies, ...) takes free attributes. An entry that breaks a rule is refused with 422 `VALIDATION_FAILED` naming the field (`attributes.<name>`, `parent_record_id`, `legal_basis`); nothing is written.

## Rule data (BR-MDM-09)

A rule type is a catalogue type whose attributes drive a decision of another module. Every rule carries a non-empty `legal_basis`, an effective range, `owner_module` (PRJ, CAP, DIS, PAY, CTR, MNE) and, while its confirmation has not arrived, `awaiting_confirmation = true` with `cxn` (a register entry `CXN-n` or a named `ASSUMPTION-...`). Unknown attributes are refused. Rule types are written by the platform by default; their changes are decided and published only by the members named in `master_type_approver` for the type (403 `SCOPE_DENIED` otherwise, and a type with no approver cannot be approved).

| Rule type (key) | Owner | Attributes | Baseline value | Legal basis and confirmation |
|---|---|---|---|---|
| `PROJECT_GROUP_THRESHOLDS` (`DEFAULT`) | PRJ | `bands`: list of `{sector_key or null, group_key, min_amount, max_amount or null}`; the bands of the default (no sector) and of each sector cover every amount once, from zero to open, edges exact decimal strings | C below 120 billion VND, B to 2,300 billion, A to 30,000 billion, QTQG above (working assumption) | Law 58/2024/QH15 as amended by 90/2025; awaiting CXN-32 |
| `NATIONAL_CODE_REQUIRED` (`DEFAULT`) | CAP | `mode` (BLOCK, WARN), `from_stage_key` | BLOCK from the stage PIPELINE | rule on the national project code; awaiting CXN-01 |
| `NATIONAL_CODE_FORMAT` (`DEFAULT`) | CAP | `pattern` (regular expression, at most 200 characters), `example` (matches the pattern, at most 64 characters) | `^\d{7}$`, example `7654321` | as above; awaiting CXN-01. A pattern is only run against strings of at most 64 characters |
| `RETENTION_POLICY` (one per class of data) | DGV | `data_class`, `classification` (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED), `retention_years` (1..100) or `permanent`, `legal_hold_allowed` | financial and contract records 10 years, change requests 10, import batches 5, master data for ever (MDM 3.1 section 6) | retention rules of the platform; awaiting CXN-05. A change goes through a change request with its impact and is never applied in place |
| `CALENDAR` (`DEFAULT`) | DIS | `week_starts_on`, `deadline_weekday` (MONDAY..SUNDAY), `deadline_time` (`HH:MM` local), `timezone` (`Asia/Ho_Chi_Minh`, UTC+07 without daylight saving) | week from Saturday to Friday, due Friday 10:00 (03:00 UTC) | working assumption D03 until the owner of the capital business signs it; awaiting ASSUMPTION-D03 |
| `APPRAISAL_CRITERIA` (`APPR-CRIT-2026r1`) | PRJ | `criteria`: list of `{code, name, max_score}` adding up to 100, `pass_threshold` (1..100) | five criteria (policy alignment 25, feasibility 25, effectiveness 20, capital readiness 20, risk 10), threshold 60 | criteria issued by the finance authority; awaiting ASSUMPTION-APPRAISAL-60 (PRJ 3.1 marks the 60-point threshold as an assumption) |

## Reading the rules (rule port)

`MasterRules` (`packages/db/src/master-rules.ts`) returns the version in force on a business date, never the latest:

- `read(tx, ruleType, key, asOf)`: the rule with `revision`, `validFrom`, `validUntil`, `legalBasis`, `ownerModule`, `awaitingConfirmation` and `cxn`; the platform's entry wins over a tenant's.
- `nationalCode(tx, asOf)`: `mode`, `fromStageKey`, the format when one is in force, and the reading of the rule.
- `suggestGroup(tx, { sectorKey, totalInvestmentVnd }, asOf)`: the group of the sector's own table when the rule has one, of the default table otherwise; an amount on an edge belongs to the band above it.

- `calendarPeriods(tx, year, asOf)`: the periods of a year (`W<year>-<nn>`; the year and the number are those of the last day of the week, so no day belongs to two periods or to none) from the calendar in force on `asOf`, each with the id and the revision of the calendar version it came from.
- `boundDeadline(tx, { calendarVersionId, startsOn })` and `isLate(tx, bound, at)`: the deadline and the lateness of a period by the version of the calendar it was generated from, never by a newer one (no retroactive change). A module that stores a period stores `calendarVersionId` with it.

The kernel holds the pure parts: `reportingPeriods`, `periodOf` and `isLate` (`packages/kernel/src/reporting-calendar.ts`) and the exact rounding and conversion of amounts, `roundDecimal` and `convertDecimal` (`packages/kernel/src/decimal.ts`); the web previews the periods with the same rules, held to the same answers by `packages/contracts/test-vectors/reporting-calendar.json`.

A module that applies a rule shows the confirmation it waits for while `awaitingConfirmation` is true.
