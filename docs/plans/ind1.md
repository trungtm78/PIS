# Plan of lane IND-1 (indicator dictionary, data entry rules, Excel import mappings)

Branch `lane/ind1`, worktree `D:\PIS-ind1`, migration block 2080-2099 (V2080). Specification: `docs/ind-indicator-dictionary.md`; module spec `Design/MACHVON_Design/01_Documents/05_modules/IND.md`.

## Steps and state

1. Kernel (done): `ind-definitions.ts`, `ind-dictionary.ts`, `ind-entry.ts`, `ind-import-mapping.ts`; `KPI_DEFINITION` gets the dictionary members, `DATA_ENTRY_RULE` gets `VALUE_IN_RANGE`, surfaces, range and closed states, `INDICATOR_IMPORT_MAPPING` is registered (`registerIndicatorRules`).
2. Database (done): `V2080__ind1_figure.sql` (append-only `ind_figure`), `ind-store.ts`, `ind-import.ts`.
3. API (done): module IND (14 operations), entry guard in the DIS report and project commands, authz matrix, contract and clients, error codes `IND_ENTRY_RULE_VIOLATED`, `IND_MAPPING_NOT_APPROVED`.
4. Web (done): IND-01, IND-02, IND-03 with i18n parts `ind1.{vi,en}.json` (folded by the lead).
5. Design rows (done): stories ST-IND-001..003, traceability, backlog, test cases, navigation, UAT evidence.
6. Merge of main into the lane (done, commit f7d19d5e): shared JSON and generated files taken from main and the IND-1 rows re-applied by contract-patch and the design scripts; two broken places of main repaired (stray merge separators in the kernel index and a missing brace in the outbox consumers test); the FND-1 types that clash by name are exported as IndFigureRow and IndFigureFilter.
7. Open: isolation, conformance, outbox and DIS report tests on the merged branch, whole-repo lint once, Codex review through the heavy lane, triage and regression tests for valid findings.

Hook for FND-1 (kernel API section 13.3 of fnd-funding-model.md): the identities of 8/I4 are expressible as DATA_ENTRY_RULE rules of the kinds that exist (cumulative not above total, parts equal total); the funding totals enter as facts, so IND-1 keeps no dependency on the figure engine.

## Decisions

Rules and mappings are governance rules (versions, maker-checker, effective days); only approved tenant versions hold an entry; figures are append-only; a file never overwrites a held number; the period discipline of the weekly report is reused; audit keeps ids and numbers, never the words of a reason.

## Codex review (model gpt-6-astra, base main) and dispositions

| # | Finding | Disposition |
|---|---|---|
| 1 P1 | `listIndicatorImportRows` shows quarantined rows and differences of projects outside the scope of the caller | Valid. The rows are filtered by the project code of the business key against `projectScope`; a row with no key is for a caller who reaches the whole tenant. Test: API test of the rows read by the department admin and by the tenant admin. |
| 2 P1 | The rules judged the figures a row asks for, while the apply keeps a held number | Valid. `verdictOf` overlays only the figures that are new; held numbers stay as they are. Test: db test with a held total of 100, a file saying total 200 and a new cumulative 150 is refused (`ENTRY_RULE_BLOCKED`). |
| 3 P2 | One open item per row and code: only the first differing figure of a COLUMNS row was stored | Valid. A row whose figures differ gives one difference that lists every `INDICATOR=number` pair (one figure keeps the plain two numbers). Test: db test with two differing indicators. |
| 4 P2 | Write skew: two entries for different indicators validate against the old set | Valid. `IndFigureStore.lockSet` takes an advisory lock of the project and period before the figures are read, in the entry command and in the import adapter. Test: db test that a second session cannot take the lock. |

Not run by this lane, by the rule of the coordinator: isolation, reachability, command conformance, outbox consumers, DIS report and negative matrix suites (the lead runs them once on the merged tree). Entries are added: the 14 operations in the isolation expected list and full-rights set, the 5 required-query reads in `NOT_PLAIN_LISTS` and 2 IND lists in `LISTS_WITHOUT_ROWS` of the reachability test, the operation counts 689 and 445 of the conformance test, the prefix `ind` of the tenant owner. Failures seen on the merged branch that are not IND-1: `getFundingFigureHistory` answers 422 as a plain list, the e-GP obligation operations answer 403 where the isolation suite expects 404.
