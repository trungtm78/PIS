# Plan of lane ENT-3e (enterprise edition: project codes through the crosswalk, project catalogue, CAP origins)

Branch `lane/ent3e`, worktree `D:\PIS-ent3e`, migration block 2740-2759 (slice name `ENT-3`, the tool accepts one trailing number only). Sources: plan "ENT-3" gaps G7, G8, G11 and eng-review R25 (expand then contract), customer spec MD.01, MD.02, CN.01, TH.03, `docs/hpm-ebs-connectors.md`, `docs/open-api.md`, `docs/fnd-funding-model.md`.

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)
1. The code of a project in EBS and in HPM is a row of `master_crosswalk` (subject PROJECT, maker-checker life of EGP-1, validity range) on the INT-1 rails: `external_type = PROJECT_CODE` and `source_system` = `EBS` or `HPM`, registered in `int_source_system`. The lane brief names the pair "external types EBS_PROJECT_CODE, HPM_PROJECT_CODE"; the pair is kept as the kernel-side names (`EBS_PROJECT_CODE = (EBS, PROJECT_CODE)`), not as two new type strings, because a second type string would need a second guard trigger, a second store and a second screen for the same maker-checker life that INT-03 already has (INT-1 trigger `guard_crosswalk_project_code`, unique indexes of V1940, open API `listOpenProjectCodes`). One table, one life, one screen.
2. Expand then contract (R25): the new path is crosswalk first (ACTIVE row valid on the day, found by external code), the direct match of the code against `project.code` stays as the fallback for one version. A code that has both is resolved by the crosswalk; the proposal of a mapping for EBS or HPM is refused when its external code is already the code of ANOTHER project (so a reconciled history can never silently change its project). The contract step (drop of the fallback) is a later version, noted in `docs/hpm-ebs-connectors.md`.
3. Catalogues of the enterprise edition are governance rule types registered by `registerEnterpriseCatalogueRules()` of the package (the public process never carries them): one rule code per entry, versioned and approved through the governance store (maker-checker, provenance, flagged UNVERIFIED until the customer confirms): `ENT_PROJECT_TYPE`, `ENT_START_FLAG`, `ENT_LIFECYCLE_MILESTONE`, `ENT_LEGAL_DOC_TYPE`. The project types are also published as MDM `PROJECT_TYPE` entries (kind `MAJOR_REPAIR` added to the closed kinds) so a project can point at them (`project_type_master_version_id`). No new table.
4. CAP origins: the pack (`FUNDING_TAXONOMY`) is the source of the origin list and gets an optional `origin_decisions` field (the document types that may back an origin; absent in the public pack, so its behaviour and golden tests do not move). The appropriation register writes the pack of the process (edition), refuses an origin that the pack does not list, refuses a budget level that the pack does not list (`ALL` for the enterprise pack) and refuses a decision document whose type is not bound to the origin when the pack binds it. The split between the PVN resolution (origin `GROUP_ASSIGNED`) and the decision of the company (origin `BOARD_APPROVED`) per project is read from the plan lines through the view `v_project_origin_decision` (project, plan year, origin, decision document, amount); no new table.

## Steps
- [x] 0. Block 2740-2759 registered; this plan.
- [ ] 1. Pure rules and tests: project code resolution (`project-codes.ts`), the catalogue pack and its pure helpers (`catalogue-rules.ts`), origin and level of a pack with decision types (`fnd-taxonomy.ts`).
- [ ] 2. Database: migration V2740 (view `v_project_origin_decision`, allocation_line carries the pack of its appropriation), `ProjectCodeResolver`, EBS import and reconciliation through it, HPM manifest with the project codes, appropriation register by pack, seed of the two systems.
- [ ] 3. Contract by `contract-patch`: `CapAppropriation` (origins, level `ALL`), coverage read of the project codes (`getProjectCodeCoverage`), screens none new (INT-03 and EBS-02 get the coverage strip).
- [ ] 4. API tests for the stores through the db lane (queued), web strip on INT-03 with the hook, i18n part `ent3e`, shared-suite entries.
- [ ] 5. Docs (`docs/hpm-ebs-connectors.md`, `docs/fnd-funding-model.md`), merge main, Codex review (or independent subagent review when Codex is rate limited), report.

## Tests per layer
- kernel/package (jest, no database): resolver table (crosswalk only, direct only, both equal, both different, none, expired window, retired), catalogue pack passes its own schema and refinements, start flag by year, milestone order, origin and level by pack, public pack unchanged (golden of `fnd-taxonomy` untouched).
- db: appropriation register in both packs, view split, resolver SQL, EBS import with crosswalk and regression with the already reconciled direct codes.
- api: coverage read, enterprise appropriation through the CAP controller.
- web: strip states (empty, partial, complete, error) with the hook.

## Risks
- DB suites cannot be run while the memory is tight or `verify-cli` runs: the DB tests are written, typed and linted, and listed in the report as not run.
- The enterprise plan-line bucket list (EQUITY, LOAN, OTHER) is out of this lane: the line path keeps the public buckets; the lines of an enterprise appropriation need the ENT-3a figure path (hook left in the report).
