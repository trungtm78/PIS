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
| `DECISION_TYPE` | MDM-10 | Platform, extended by the tenant | `required_fields` (lower-case identifiers), `template` | identifiers are unique |

A type without a definition (areas, agencies, ...) takes free attributes. An entry that breaks a rule is refused with 422 `VALIDATION_FAILED` naming the field (`attributes.<name>`, `parent_record_id`, `legal_basis`); nothing is written.

## Rule data (BR-MDM-09)

A rule type is a catalogue type whose attributes drive a decision of another module. Every rule carries a non-empty `legal_basis`, an effective range, `owner_module` (PRJ, CAP, DIS, PAY, CTR, MNE) and, while its confirmation has not arrived, `awaiting_confirmation = true` with `cxn` (a register entry `CXN-n` or a named `ASSUMPTION-...`). Unknown attributes are refused. Rule types are written by the platform by default; their changes are decided and published only by the members named in `master_type_approver` for the type (403 `SCOPE_DENIED` otherwise, and a type with no approver cannot be approved).

| Rule type (key) | Owner | Attributes | Baseline value | Legal basis and confirmation |
|---|---|---|---|---|
| `PROJECT_GROUP_THRESHOLDS` (`DEFAULT`) | PRJ | `bands`: list of `{sector_key or null, group_key, min_amount, max_amount or null}`; the bands of the default (no sector) and of each sector cover every amount once, from zero to open, edges exact decimal strings | C below 120 billion VND, B to 2,300 billion, A to 30,000 billion, QTQG above (working assumption) | Law 58/2024/QH15 as amended by 90/2025; awaiting CXN-32 |
| `NATIONAL_CODE_REQUIRED` (`DEFAULT`) | CAP | `mode` (BLOCK, WARN), `from_stage_key` | BLOCK from the stage PIPELINE | rule on the national project code; awaiting CXN-01 |
| `NATIONAL_CODE_FORMAT` (`DEFAULT`) | CAP | `pattern` (regular expression, at most 200 characters), `example` (matches the pattern, at most 64 characters) | `^\d{7}$`, example `7654321` | as above; awaiting CXN-01. A pattern is only run against strings of at most 64 characters |
| `APPRAISAL_CRITERIA` (`APPR-CRIT-2026r1`) | PRJ | `criteria`: list of `{code, name, max_score}` adding up to 100, `pass_threshold` (1..100) | five criteria (policy alignment 25, feasibility 25, effectiveness 20, capital readiness 20, risk 10), threshold 60 | criteria issued by the finance authority; awaiting ASSUMPTION-APPRAISAL-60 (PRJ 3.1 marks the 60-point threshold as an assumption) |

## Reading the rules (rule port)

`MasterRules` (`packages/db/src/master-rules.ts`) returns the version in force on a business date, never the latest:

- `read(tx, ruleType, key, asOf)`: the rule with `revision`, `validFrom`, `validUntil`, `legalBasis`, `ownerModule`, `awaitingConfirmation` and `cxn`; the platform's entry wins over a tenant's.
- `nationalCode(tx, asOf)`: `mode`, `fromStageKey`, the format when one is in force, and the reading of the rule.
- `suggestGroup(tx, { sectorKey, totalInvestmentVnd }, asOf)`: the group of the sector's own table when the rule has one, of the default table otherwise; an amount on an edge belongs to the band above it.

A module that applies a rule shows the confirmation it waits for while `awaitingConfirmation` is true.
