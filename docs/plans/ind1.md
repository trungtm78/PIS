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
