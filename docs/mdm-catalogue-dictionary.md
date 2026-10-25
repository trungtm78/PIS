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
| `ISSUE_CATEGORY` | MDM-17 | The tenant's own; a tree | `handler_unit_key`, `sla_priority_key` | the priority must exist; an entry that issues or SLA policies use is retired only with a successor (409 `MASTER_IN_USE`). The SLA of an issue is not read from the priority: ISS keeps its own versioned table `issue_sla_policy` per category entry, severity and unit (ST-ISS-001), which follows the entry through renames |
| `PRIORITY` | MDM-18 | The tenant's own (the platform ships four) | `rank` (1..10), `response_hours`, `resolution_hours`, `working_calendar` (ALL_DAYS, WORKING_DAYS), `escalate_after_hours` | the answer time does not exceed the resolution time; the escalation comes within it |
| `CONTRACTOR_CRITERION` | MDM-19 | Platform, extended by the tenant | `category` (QUALITY, SCHEDULE, SAFETY, COST, COMPLIANCE), `scale_max` (1..100), `evidence_required` | none beyond the types |
| `EXPERT_ROLE` | MDM-20 | Platform, extended by the tenant | `specialty`, `conditions` | none beyond the types |
| `CONTACT_PURPOSE` | MDM-21 | Platform only | `consent` (NOT_REQUIRED, EXPLICIT), `security_level` (PUBLIC, INTERNAL, CONFIDENTIAL) | none beyond the types |
| `TREASURY_OFFICE` | MDM-16 | The tenant's own | `level` (CENTRAL, PROVINCE, DISTRICT), `province` | none beyond the types; the Treasury code of an office is not an attribute but its ACTIVE crosswalk TREASURY/AGENCY_CODE |
| `LANGUAGE` | MDM-22 | Platform only | `native_name` | the key is a language code (`vi`, `pt-BR`) |
| `SHARED_TEXT` | MDM-22 | The tenant's own | `translations`: a text per language code | language codes are valid, texts are not empty |
| `DECISION_TYPE` | MDM-10 | Platform, extended by the tenant | `required_fields` (lower-case identifiers), `template` | identifiers are unique |

A type without a definition (areas, agencies, ...) takes free attributes; the areas, administrative units and agencies that the 2025 reform merged, split or moved are linked by successions (`docs/mdm-succession.md`, MDM-02, MDM-03, MDM-37). An entry that breaks a rule is refused with 422 `VALIDATION_FAILED` naming the field (`attributes.<name>`, `parent_record_id`, `legal_basis`); nothing is written.

## Rule data (BR-MDM-09)

A rule type is a catalogue type whose attributes drive a decision of another module. Every rule carries a non-empty `legal_basis`, an effective range, `owner_module` (PRJ, CAP, DIS, PAY, CTR, MNE) and, while its confirmation has not arrived, `awaiting_confirmation = true` with `cxn` (a register entry `CXN-n` or a named `ASSUMPTION-...`). Unknown attributes are refused. Rule types are written by the platform by default; their changes are decided and published only by the members named in `master_type_approver` for the type (403 `SCOPE_DENIED` otherwise, and a type with no approver cannot be approved).

| Rule type (key) | Owner | Attributes | Baseline value | Legal basis and confirmation |
|---|---|---|---|---|
| `PROJECT_GROUP_THRESHOLDS` (`DEFAULT`) | PRJ | `bands`: list of `{sector_key or null, group_key, min_amount, max_amount or null}`; the bands of the default (no sector) and of each sector cover every amount once, from zero to open, edges exact decimal strings | C below 120 billion VND, B to 2,300 billion, A to 30,000 billion, QTQG above (working assumption) | Law 58/2024/QH15 as amended by 90/2025; awaiting CXN-32 |
| `NATIONAL_CODE_REQUIRED` (`DEFAULT`) | CAP | `mode` (BLOCK, WARN), `from_stage_key` | BLOCK from the stage PIPELINE | rule on the national project code; awaiting CXN-01 |
| `NATIONAL_CODE_FORMAT` (`DEFAULT`) | CAP | `pattern` (regular expression, at most 200 characters), `example` (matches the pattern, at most 64 characters) | `^\d{7}$`, example `7654321` | as above; awaiting CXN-01. A pattern is only run against strings of at most 64 characters |
| `RETENTION_POLICY` (one per class of data) | DGV | `data_class`, `classification` (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED), `retention_years` (1..100) or `permanent`, `legal_hold_allowed` | financial and contract records 10 years, change requests 10, import batches 5, master data for ever (MDM 3.1 section 6) | retention rules of the platform; awaiting CXN-05. A change goes through a change request with its impact and is never applied in place. This entry is a baseline that no job executes: the versioned rule per record class that the nightly retention job reads is ADM `data_retention_policy` (ST-ADM-017), and a tenant policy for a class named here (its key in lower case) can never keep the class for less than this period (`docs/runbooks/retention.md`) |
| `CALENDAR` (`DEFAULT`) | DIS | `week_starts_on`, `deadline_weekday` (MONDAY..SUNDAY), `deadline_time` (`HH:MM` local), `timezone` (`Asia/Ho_Chi_Minh`, UTC+07 without daylight saving) | week from Saturday to Friday, due Friday 10:00 (03:00 UTC) | working assumption D03 until the owner of the capital business signs it; awaiting ASSUMPTION-D03 |
| `APPRAISAL_CRITERIA` (`APPR-CRIT-2026r1`) | PRJ | `criteria`: list of `{code, name, max_score}` adding up to 100 (the `max_score` of a criterion is its weight in the score of a sheet, BR-PRJ-03: `sum(score x weight) / 5`, a score being a whole number from 0 to 5), `pass_threshold` (1..100) | five criteria (policy alignment 25, feasibility 25, effectiveness 20, capital readiness 20, risk 10), threshold 60 | criteria issued by the finance authority; awaiting ASSUMPTION-APPRAISAL-60 (PRJ 3.1 marks the 60-point threshold as an assumption) |
| `LND_TIMER` (`NOTICE_AGRICULTURAL_90`, `NOTICE_NON_AGRICULTURAL_180`, `PLAN_POSTING_30`, `PAYMENT_30`, `COMPLAINT_RESOLUTION`) | LND | `days` (1..366; the two notices are 90 or 180, the lengths a parcel can carry), `day_count` (`CALENDAR` or `WORKING`), `calendar_code` (the published ADM working calendar; exactly when `day_count` is `WORKING`) | 90, 180, 30, 30 and 30 calendar days | Land Law 2024 and Decree 88/2024/ND-CP; awaiting CXN-12. The platform owns it (`PLATFORM_ONLY`); a deadline keeps the version of the rule it was counted by (docs/lnd-parcels.md) |
| `BID_PETITION` (`PROCESS`, `RESULT`) | BID | `days` (1..366), `day_count` (`CALENDAR` or `WORKING`), `calendar_code` (the published ADM working calendar; exactly when `day_count` is `WORKING`), `filing_days` (1..366, `RESULT` only: the days after the result is approved within which a petition about it may be lodged) | 7 calendar days for both kinds, no limit to lodge | Law on Bidding 22/2023/QH15 on petitions; awaiting CXN-BID-02. The platform owns it (`PLATFORM_ONLY`); a petition keeps the version of the rule it was counted by (docs/bid-petitions.md) |

## Bulk import (MDM-29, ST-MDM-006)

A catalogue is imported from a CSV file (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX file, at most 10 MB and 5,000 rows, a header in the first row. The type of the file is told by its bytes, the file is scanned, and its hash is kept: a file whose content was applied before is never applied again (409 `IMPORT_FILE_ALREADY_APPLIED`).

| Step | What happens |
|---|---|
| Upload (`uploadMasterImportFile`) | stored under the tenant prefix, scanned, read as a table; the answer names the columns and the number of rows |
| Stage (`stageMasterImport`) | the mapping (a column for the code, the name, the effective date, and optionally the parent, the end date, the legal basis and each attribute) is checked against the columns; every row is judged and the errors are kept (row, field, code); nothing else is written |
| Apply (`applyMasterImport`) | the file is read again and judged again; ATOMIC with one row in error changes nothing (422 `IMPORT_HAS_ERRORS`); PARTIAL leaves the rows in error out and lists them; a file with no row to create (a header only, or every row in error in PARTIAL) is 422 `IMPORT_EMPTY` and stays a dry run; the records and their change requests are created together, in one transaction, and submitted; the batch keeps who applied it (`applied_by`) |
| Decide (`decideMasterImport`) | the whole batch is approved or rejected by someone who did not apply it (four-eyes is judged on `applied_by`, which may differ from `created_by`, the person who staged the file) |
| Publish (`publishMasterImport`) | every record is put in force on one decision document, or none is; the batch becomes APPLIED |

The change requests of a batch belong to it: `decideMasterChangeRequest`, `submitMasterChangeRequest` and `post_master_records_id_publish` refuse them with 409 `STAGE_TRANSITION_DENIED` (detail `import_batch`), so a batch is never approved or published in part.

Lines and cells: a row error names the line of the file where the row starts (the header is the first line unless blank lines come before it; blank lines and the lines of a cell that runs over several are counted; in a workbook it is the row number of the sheet). An XLSX cell with a date or time style (the built-in formats and any custom format with a day, month, year, hour or second token, in the 1900 or the 1904 system of the workbook) is read as `yyyy-mm-dd` (with `Thh:mm:ss` when it has a time of day); the serial 60 (the 29 February 1900 that never was), the serial 0 and a number outside the calendar are left as they are and fail as `INVALID_DATE`.

References between rows: a row may name a row of the same file wherever it stands (a stage and the stage that follows it, rows that name each other); the references are judged against the file at the dry run and again when the records are created. A row that names a row left out is itself left out (`REFERENCE_SKIPPED`), until nothing changes.

Row error codes: `REQUIRED`, `INVALID_FORMAT`, `TOO_LONG`, `INVALID_DATE`, `INVALID_RANGE`, `DUPLICATE_IN_FILE`, `DUPLICATE_KEY`, `PARENT_NOT_FOUND`, `PARENT_CYCLE`, `PARENT_SKIPPED` (the parent row cannot be created), `REFERENCE_SKIPPED` (an attribute names a row that cannot be created), `INVALID_VALUE` (the rules of the type), `POLICY_LOCKED`, and the code of a rule of the type such as `SUBSET_SOURCE_NOT_ADDITIVE`. A cell is read by the kind of its attribute: integers and flags from their text (`true`, `yes`, `1`, `có`), lists split at `;`, `,` or `|`, structured values as JSON.

## Crosswalk and integration connectors (MDM-24, MDM-16, ST-MDM-007)

A code of another system (Treasury, the national investment system, procurement, budget codes) is mapped to an entry by a crosswalk: `(source_system, external_type, external_code)` has at most one ACTIVE mapping (409 `CROSSWALK_DUPLICATE`; retire the old one first, the row stays for history). A merged entry cannot be a target. `MasterCrosswalkStore.resolve` translates a list of codes at a date: a code with no ACTIVE mapping in force, or whose entry is retired or merged, is simply absent.

An import mapping may name a system and a code type and the columns that hold such codes (`parent_key` and `attributes.<name>`); the codes are translated through the crosswalk and a code without a mapping is the row error `CROSSWALK_MISSING` (a code that maps to an entry of another type is `PARENT_NOT_FOUND`), so nothing is ever created from a guessed code.

### The alias of a tenant on an entry of the platform (MDM-33, ST-MDM-002)

A tenant cannot change the code or the name of an entry of the PLATFORM namespace (403 `POLICY_LOCKED`). The one thing it may override is how the entry is shown to it: a label and a place in the order. It does so with a crosswalk row of the reserved system `TENANT_ALIAS` (`createMasterCrosswalk`, `master.crosswalk.manage`): the code type `LABEL` carries the label (the trimmed text, at most 100 characters), the code type `ORDER` carries the position (a whole number of at most six digits, stored without leading zeros); the method is `MANUAL` and there is no confidence. The target must be an entry of the PLATFORM namespace (422 `VALIDATION_FAILED` on `master_record_id` otherwise: an entry of the tenant is edited through its own change requests). An alias is not a code of another system, so it does not share the rule of one ACTIVE mapping per code: two entries may carry the same label or order, and the rule is one ACTIVE alias of each kind per entry (409 `CROSSWALK_DUPLICATE`; to change it, retire it with `retireMasterCrosswalk` and make another). The database holds the same rules (V1089: the kind, the digits, the method, the platform entry as the only target, the index of one alias per kind).

`searchMasterRecords` answers the alias in force on the date: `alias_label`, `alias_order`, and `display_label` (the alias or else the label of the version in force) and `display_order`; `label` stays the label of the platform. An import mapping may not name `TENANT_ALIAS` as the system of its translation (422 `VALIDATION_FAILED` on `mapping.crosswalk`).

Each tenant has four integration connectors from the baseline: `NATIONAL_PIM_FILE`, `TREASURY_STATEMENT_FILE`, `PROCUREMENT_FILE`, `BUDGET_CODE_FILE` (scope DEFAULT, adapter `PROPOSED`: the platform never calls a format verified on its own authority). MDM-24 shows the adapter badge. `resetIntegrationCursor` (permission `integration.cursor.reset`, a reason of at least 10 characters, a JSON object position of at most 8 KiB) sets the position, makes the connector ACTIVE, clears the last error and the last file hash (so the file can be read again), keeps the verdict on the adapter, and audits the reason. A missing reason is 422 `VALIDATION_FAILED` naming `reason`.

## Glossary (MDM-34, ST-MDM-008)

A business term (`glossary_term`) is a `term_code` (upper case letters, digits and `_`, at most 80) with a revision, a Vietnamese name, a definition of 20 to 2000 characters, an optional `formula_ref` (at most 120), a `domain` (same code form, at most 50), the `owner_membership_id` who decides and publishes it, and an optional legal basis. The content of a revision never changes (a database trigger refuses it); a change is the next revision.

States: `DRAFT` -submit-> `IN_REVIEW` -approve-> `APPROVED` -publish-> `PUBLISHED` -(next revision published)-> `DEPRECATED`; `IN_REVIEW` -reject-> `REJECTED` (final for that revision); `IN_REVIEW` -return-> `DRAFT` (the reason is kept; no operation edits a draft, see TODOS).

Rules:
- A code has one open proposal (`DRAFT`, `IN_REVIEW` or `APPROVED`) at a time; another is 409 `GLOSSARY_TERM_DUPLICATE`. A code with a `PUBLISHED` revision gets revision n+1 with `supersedes_id` set to it (a different `supersedes_id` is 422); after a rejection the next revision supersedes nothing. A revision keeps the domain of the term.
- The owner of a term is a person other than its proposer and an Active member of the tenant (422 `owner_membership_id` otherwise), so a proposed term can always be decided.
- Decide and publish check, in this order: the version (409 `VERSION_CONFLICT`), the proposer (403 `SELF_APPROVAL_DENIED`, whoever the owner is), the owner (403 `SCOPE_DENIED`: only `owner_membership_id` decides and publishes), the state (409 `STAGE_TRANSITION_DENIED`). The proposer is told first because that fact does not depend on who holds the domain; a person outside the owner scope is told `SCOPE_DENIED` and the term stays as it was. A decision needs a reason of 5 to 2000 characters.
- Publishing sets `effective_from` to today (Vietnam date) and turns the previous `PUBLISHED` revision into `DEPRECATED` in the same transaction; the database allows one `PUBLISHED` per `(tenant, term_code)`. Event `glossary.published.v1 {term_code, revision, domain}` (key: the revision's id). Audit actions `glossary.proposed`, `submitted`, `approved`, `rejected`, `returned`, `published`.
- `decided_by`/`decided_at`/`decision_reason` hold the last review decision, `published_by`/`published_at` the publication; CHECKs hold that neither the decider nor the publisher is the proposer and that each status carries its facts.

Seed (domain `DISBURSEMENT`, per tenant, by `applyBaseline`, only when absent in any status): `GIAI_NGAN_PERIOD` (delta of the period, BR-DIS-03), `GIAI_NGAN_YTD`, `GIAI_NGAN_PTD`, `MAU_SO_KH_TTG_GIAO` (denominator: plan assigned by the Prime Minister, `rate_pm_pct`), `MAU_SO_KH_TONG` (denominator: plan with the part assigned on top, `rate_total_pct`), all `IN_REVIEW`, owned by the tenant owner, with the basis "DIS BR-DIS-05, 06, 12 [CXN-03], working assumption awaiting D03 sign-off". The disbursement counted is the one paid by the Treasury on or before the cut-off date (BR-DIS-06). `GlossaryStore.definitionStatus(tx, 'DISBURSEMENT')` answers `SIGNED` only when all five have a `PUBLISHED` revision, `PROPOSED_PENDING_SIGNOFF` otherwise (with the missing codes).

## Reading the rules (rule port)

`MasterRules` (`packages/db/src/master-rules.ts`) returns the version in force on a business date, never the latest:

- `read(tx, ruleType, key, asOf)`: the rule with `revision`, `validFrom`, `validUntil`, `legalBasis`, `ownerModule`, `awaitingConfirmation` and `cxn`; the platform's entry wins over a tenant's.
- `nationalCode(tx, asOf)`: `mode`, `fromStageKey`, the format when one is in force, and the reading of the rule.
- `suggestGroup(tx, { sectorKey, totalInvestmentVnd }, asOf)`: the group of the sector's own table when the rule has one, of the default table otherwise; an amount on an edge belongs to the band above it.

- `calendarPeriods(tx, year, asOf)`: the periods of a year (`W<year>-<nn>`; the year and the number are those of the last day of the week, so no day belongs to two periods or to none) from the calendar in force on `asOf`, each with the id and the revision of the calendar version it came from.
- `boundDeadline(tx, { calendarVersionId, startsOn })` and `isLate(tx, bound, at)`: the deadline and the lateness of a period by the version of the calendar it was generated from, never by a newer one (no retroactive change). A module that stores a period stores `calendarVersionId` with it. DIS does so (ST-DIS-001): `reporting_period.calendar_version_id` (and `calendar_version`, the revision) is fixed when the period is generated, `DisPeriodStore.judge` decides `is_late` from it, and the column is one of `MASTER_REFERENCES`, so the impact preview of a change of the calendar counts the periods bound to it.

The kernel holds the pure parts: `reportingPeriods`, `periodOf` and `isLate` (`packages/kernel/src/reporting-calendar.ts`) and the exact rounding and conversion of amounts, `roundDecimal` and `convertDecimal` (`packages/kernel/src/decimal.ts`); the web previews the periods with the same rules, held to the same answers by `packages/contracts/test-vectors/reporting-calendar.json`.

A module that applies a rule shows the confirmation it waits for while `awaitingConfirmation` is true.
