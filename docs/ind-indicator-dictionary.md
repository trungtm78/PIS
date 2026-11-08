# IND-1: indicator dictionary, data entry rules and Excel import mappings

Status: implemented (kernel, db, API, web). Plan lane IND-1, customer dossier requirement DL.02. The customer's own dictionary (DL.01, DL.02) and form files are not received: every indicator, rule and mapping layout below is a **starting value** flagged unverified (`legalStatus: UNVERIFIED`) and every number built on a sample layout is `PENDING-EXTERNAL` (eng-review R18) until the customer's files exist.

Code: `packages/kernel/src/ind-definitions.ts` (shapes, schema, starting indicators), `ind-dictionary.ts`, `ind-entry.ts` (the pure judge), `ind-import-mapping.ts` (the pure format of a mapping); `packages/db/src/ind-store.ts`, `ind-import.ts`; `apps/api/src/modules/ind/*`, `apps/api/src/ind-entry-guard.ts`; migration `db/migrations/V2080__ind1_figure.sql` (block 2080-2099); screens IND-01 to IND-03 in `apps/web/src/screens/ind`; module spec `Design/MACHVON_Design/01_Documents/05_modules/IND.md`.

## 1. Decisions (owner standing rule: deepest governance, no scope cut)

1. **One register, not two.** An indicator is the `KPI_DEFINITION` rule of its code. Code, name, unit, formula, numerator, denominator, owner, period, version, approver and effective days come from `kpi-register.ts` and the governance store; IND-1 adds only optional members (`category`, `value_kind` ENTERED or DERIVED, `entry_field`, `vat_basis`, `aliases`, `required_on`). A KPI of the command centre that has none of them is a derived figure and cannot be entered. `indicatorOf` reads the extra members; `kpiDefinitionOf` is untouched.
2. **Rules are templates until the tenant approves them.** `DATA_ENTRY_RULE` was registered earlier with four starting checks. They stay as defaults, and IND-1 adds `VALUE_IN_RANGE`, the `surfaces` list, `min`, `max` and `closed_states`. Only an approved tenant version is held against an entry (`IndEntryRuleStore.inForce` skips `origin DEFAULT`), so a tenant that configured nothing sees no change in any command: the guard reads the rules once and finds none. The same holds for the sample mappings: a file is read only through an approved version (409 `IND_MAPPING_NOT_APPROVED`).
3. **Mappings are governance rules too.** `INDICATOR_IMPORT_MAPPING` gives versions, maker-checker approval (`SELF_APPROVAL_DENIED`), effective days and the history for free; the figure it writes names the mapping code, version and rule id. No second approval workflow exists.
4. **Figures are append-only.** `ind_figure` has a trigger and no UPDATE, DELETE or TRUNCATE for the application role. The first number is revision 1, a different number is the next revision with its reason (422 on `reason` without one), the same number changes nothing. A file never overwrites a held number: it becomes a difference (`IND_FIGURE_DIFFERS`) in the reconciliation queue of the file import framework, with an owner and a due time.
5. **The period discipline of the weekly report is reused.** The entry command refuses a locked period unless an approved reopening names the project (`DisPeriodStore.closedFor`, 409 `PERIOD_LOCKED`); the fact `periodStatus` is `REOPENED` in that case so that `PERIOD_LOCKED_AFTER_CLOSE` does not block what DIS allows. A configured rule can be stricter (`closed_states` may include `SOFT_CLOSED`).
6. **Audit keeps ids, codes and numbers, never the words of a reason.** One audit row per changed figure (`ind.figure_entered`, `ind.figure_revised`), one per applied file (`ind.import_applied`; the figures carry the import, line and mapping version themselves), `ind.entry_warned` when a WARN rule passes, `ind.entry_unchanged` when nothing changed.

## 2. Surfaces and facts

A rule names the **facts** it reads (`fields`, `total_field`) and optionally the surfaces it applies to: `DIS_REPORT`, `PRJ_PROJECT`, `INDICATOR_ENTRY`, `INDICATOR_IMPORT`.

| Surface | Where | Facts the surface gives |
|---|---|---|
| `DIS_REPORT` | `post_reports`, `post_reports_id_revisions` | `CUMULATIVE`, `CTMTQG`, `NEXT_MONTH` (totals of the six cells), `CONSTRUCTION`, `ACCEPTANCE`, `TREASURY_SUBMITTED`, `PREPARING_DOSSIER`, `PHYSICAL_PROGRESS`, `TOTAL_INVESTMENT` (the register), period state |
| `PRJ_PROJECT` | `createProject` | `TOTAL_INVESTMENT` |
| `INDICATOR_ENTRY` | `enterIndicatorFigures` | the figures in force of the project and period by `entry_field`, overlaid with the figures of the request, `TOTAL_INVESTMENT` from the register when no figure gives it, period state |
| `INDICATOR_IMPORT` | `importIndicatorFile` | as `INDICATOR_ENTRY`, for the row |

The weekly report and the project register call `enforceReportEntry` and `enforceProjectEntry` (one line each in the command handlers, after the existing judgements). Existing DIS and PRJ tests pass unchanged.

## 3. Checks (`DATA_ENTRY_RULE.check`)

`CUMULATIVE_NOT_ABOVE_TOTAL` (one field, a `total_field`, optional `tolerance`), `PARTS_EQUAL_TOTAL` (two or more fields summing to the total within `tolerance`, default exact), `PERIOD_LOCKED_AFTER_CLOSE` (`closed_states`, default LOCKED), `FIELD_REQUIRED` (the pseudo field `MANDATORY_FIELDS` expands to the entry fields of the entered indicators whose `required_on` names the surface), `VALUE_IN_RANGE` (`min`, `max` as decimal text). Severity `BLOCK` stops the command with 422 `IND_ENTRY_RULE_VIOLATED` (detail = first rule code, extension `violations` lists every blocking rule with its message); `WARN` lets it through and leaves the audit row. All comparisons are exact decimal; a check whose facts are not there is skipped and listed, absence is the job of `FIELD_REQUIRED`. The FND-1 identities (`cumulative <= total`, `equity + loan = total`) are rules of these two kinds that take the funding totals as input facts: IND-1 does not depend on the FND-1 code.

## 4. Import mappings

Params: `layout` COLUMNS (one row per project; `project_column`, `period_column`, one column per indicator) or ROWS (one row per indicator of one project; `label_column`, `value_column`, project and period named by the request), `number_format` PLAIN or VN (`1.234,56`), and `lines` of `{ indicator, source, scale ONE/THOUSAND/MILLION/BILLION, required }`. The figure is stored in the unit of the register (whole dong for money). Headers and labels match without regard to case and spaces. A file the mapping cannot read as a whole (missing column, repeated header, repeated label, a required label absent) is 422 `IMPORT_SCHEMA_INVALID` naming what is missing. A row is refused with line, field and code: `PROJECT_UNKNOWN` (also for a project outside the scope of the caller), `PERIOD_UNKNOWN`, `PERIOD_AMBIGUOUS`, `PERIOD_LOCKED`, `INDICATOR_UNKNOWN`, `INDICATOR_NOT_ENTERABLE`, `NUMBER_INVALID`, `NUMBER_NOT_WHOLE`, `NUMBER_TOO_PRECISE`, `VALUE_REQUIRED`, `ROW_EMPTY`, `ENTRY_RULE_BLOCKED`. Business key: `project|period` (COLUMNS) or `project|period|indicator` (ROWS); a key is applied once, the same key with other content opens the framework's `DUPLICATE_CONFLICT` item. Dry run (`previewIndicatorImport`) judges exactly as the apply and writes nothing; the apply goes through `FileImportStore.run` once per file hash.

## 5. Hooks left for other lanes

- FND-1: register the enterprise indicators of section 5.3 of `fnd-funding-model.md` under `KPI_DEFINITION` (IND-1 seeds `RATE_YEAR_IN_FORCE`, `RATE_SINCE_START`, `REMAINING_YEAR`, `STRUCTURE_SHARE` and skips a code that already has a default); feed the funding totals as facts of the surfaces.
- RPT-1, ENT-1: read `ind_figure` through `IndFigureStore.current`; a report that uses a sample mapping or a starting indicator is `PENDING-EXTERNAL`.
- Authoring of definitions, rules and mappings uses `createGovernanceRuleDraft` and the other governance rule commands (screen ADM-19); the three IND screens link to it and do not add authoring endpoints.
- Mobile: no screen (the plan has none); the API is the same for a later phone screen.
