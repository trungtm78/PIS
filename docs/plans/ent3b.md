# ENT-3b: structured period narrative for the enterprise forms

Requirements: HSKT v0.3 DL.01 (the data set per project and period includes the eight narrative groups), CN.02 (entry of the narrative in one structure, inheritance from the previous period, standard cause list), CN.03 (the results of the leadership directives go into the report of the next period). Eng review R27 (no second table), R21 (one read path for figures is ENT-3a and is not touched here).

## Design decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)

1. One table. `report_narrative` (one row per report revision = per project and period) gets a versioned block per edition pack: `pack_code` + `pack_version` + `pack_fields` (jsonb, the eight fields), `cause_codes` (picklist codes), `directive_refs` (the directives rolled up, with their status on the last day of the period), and the inheritance trace (`inherited_from_report_id`, `inherited_at`, `inherited_by`, `inherited_hashes`). The public edition keeps its four columns untouched (pack_code NULL). The block rides with the DIS report draft: it is written only while the report is a live DRAFT (the existing child guard) and is part of the payload hash.
2. The eight fields: status of execution, milestone assessment, disbursement assessment, causes, difficulties, solutions, plan of next period, proposals. Each up to 4000 characters, trimmed, NFC.
3. Cause list: master data MDM-17 (`ISSUE_CATEGORY`, the standard issue and delay cause tree). The picklist stores codes of active records; free text stays in the `causes` field. A code that is not an active MDM-17 record is 422.
4. Inheritance is an explicit command that copies the previous period's narrative of the same project into the draft, with a trace; each copied field keeps its sha256 so the screen and the rules can tell "still the words of last period" from "rewritten". The trace is never accepted from a request body.
5. Directives: the read `getDirectivesForReport` (DIR-05, `DirDirectiveStore.forReport`) is called with the period of the report; the narrative context returns composed lines, the screen inserts them, the save records `directive_refs` (id, code, status at end). The server re-reads the directives in the caller's scope and refuses refs that are not among them.
6. Validation: a new entry surface `PERIOD_NARRATIVE` of the IND `DATA_ENTRY_RULE` (mandatory fields through the pseudo field `MANDATORY_FIELDS`, `FIELD_REQUIRED`, `PERIOD_LOCKED_AFTER_CLOSE`), judged on save (period state) and on submit (mandatory fields). A tenant with no approved rule sees no change. Two starter templates are added (not in force by themselves).
7. Excel: a new import mapping `ENT-NARRATIVE-1` on the existing report import operations (upload, dry run, apply, once per file hash) plus a template download; the dry run lists every fault with line and column; apply writes only to existing DRAFT reports.
8. Word: `fillNarrative` learns the token `{{narrative:PROJECTS}}` (one block of eight headed paragraphs per project) fed by `ReportFillData.narratives`; a field left empty keeps the square-bracket hint of the skeleton, nothing is invented. `narratives.ts` of the enterprise package gives all six PVFCCo forms the narrative skeleton and the committed templates are rebuilt.

## Steps (tick when done; one commit per step)

- [ ] 1. Plan and migration block (2680-2699 registered as `ENT3B-1`).
- [ ] 2. Kernel: `ent-narrative.ts` (fields, validation, inheritance, directive lines, import parse, entry facts), `fillNarrative` token, entry surface `PERIOD_NARRATIVE`, messages. Tests: kernel unit tests.
- [ ] 3. DB: migration 2680, store changes (read/write the block, previous report, cause catalogue, import judge/apply). Tests: db store test.
- [ ] 4. API + contract: narrative in report create/save/detail, `inheritReportNarrative`, `getReportNarrativeContext`, `downloadReportNarrativeTemplate`, import mapping, rules on save/submit, authz/isolation entries. Tests: api tests (listed, not run in the shared suites).
- [ ] 5. Enterprise package: six narrative skeletons, templates rebuilt, provider wiring of narratives in the report render. Tests: package tests.
- [ ] 6. Web: narrative screen (next free DIS id), hooks, model, i18n parts `ent3b.{vi,en}.json`. Tests: vitest.
- [ ] 7. Docs, story/traceability rows, shared-suite entries, independent review, merge main.

## Risks

- Contract footprint is large (openapi, authz matrix, isolation, generated files): operations are kept to three new ones; everything else extends existing operations.
- ENT-3a edits `bundles.ts` and the provider: only `narratives.ts`, `forms.ts` and the render input are touched here.
- DB and API jest only through the serialized lane and only when memory is free and no verify run is active.
