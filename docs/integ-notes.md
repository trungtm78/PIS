# Integration notes (merge repair of the lane cherry-picks, 2026-11-08)

## for INTEG-SUITES (paths owned by apps/api, packages, scripts)

1. Screen ids of GOV-11a were renumbered in the design pack, the web route table and the web screens (FND-1 keeps DIS-27/DIS-28, GOV-8 keeps CTR-32/CTR-33, MR-1 keeps PRJ-28). Old -> new: DIS-27 -> DIS-30, DIS-28 -> DIS-31, CTR-32 -> CTR-38, CTR-33 -> CTR-39, PRJ-28 -> PRJ-30. CAP-23, PAY-22 and PRJ-29 stay.
2. `packages/db/src/home-gov11-sources.ts` still names the old ids in the alert targets and must follow (the web alert centre now opens the new ids, see `apps/web/src/screens/home/work-model.ts`):
   - line 45 `screen: 'DIS-27'` -> `'DIS-30'` (milestone board)
   - line 91 `screen: 'CTR-32'` -> `'CTR-38'` (settlement clocks)
   - line 111 `screen: 'CTR-33'` -> `'CTR-39'` (contract linkage); with the old id the web opened the claim record of GOV-8 with a contract id
   - lines 131 and 147 `screen: 'PRJ-28'` -> `'PRJ-30'` (look-ahead plan)
   - `'PAY-22'` (line 69) and `'PRJ-29'` (line 168) stay.
   Any db or api test that asserts those `target.screen` values must follow.
3. The summaries of `Design/MACHVON_Design/03_Engineering/openapi.json` do not name any GOV-11a screen, so the renumbering needs no `contracts:generate`.
4. Story ids of GOV-11a changed in `implementation_plan.json`: ST-DIS-026 -> ST-DIS-027, ST-CTR-021 -> ST-CTR-023, ST-PRJ-020 -> ST-PRJ-021 (acceptance ids AC-ST-... and task ids TK-... follow). ST-DIS-026, ST-CTR-021 and ST-PRJ-020 keep the FND-1, GOV-8 and MR-1 stories. If a test of the GOV-11a lane names `AC-ST-DIS-026-*`, `AC-ST-CTR-021-*` or `AC-ST-PRJ-020-*` for GOV-11a behaviour, rename it (none was found in apps, packages or scripts).
5. MR-1 alert wiring (`project_risk_alert` as a work source) is still not registered: the contract list of work sources has no value for it; the web type `WorkSource` follows the contract list (41 values).

## Web test notes (merge repair)

- Full web vitest after the repair: 825 files, 12468 of 12471 tests pass. The three failures are `src/screens/adm/RolesGrantsScreen.test.tsx` (role editor, 30 s timeouts) when the whole suite runs on a loaded machine; the file alone passes (56 of 56, 70 s). It is slow, not broken by the merge; rerun it alone.
- Other web checks run clean: tsc of the app and of e2e, eslint of apps/web, i18n:check, tokens:check, routes:check (538 routes), edition:check, uat:check, uat:evidence:check, cxn:check, design check-cli and baseline-cli.
- Navigation repair (after the merge): the 30 lane screens (BID-32/33, DIS-27..31, CTR-32..36/38/39, AUD-14..16, NOT-30, HOME-30/31, DOC-24..27, CAP-23, PAY-22, PRJ-28..30, MNE-11) are now listed in the `modules` groups of `navigation_architecture.json`, in the group the route table names (primary = role workspace, parents = route parent). Two new groups: CTR "Sổ claim và cảnh báo sớm", DOC "Hồ sơ dự án". `fallback.report.extended` names them; coverage counts did not change (538 web routes, 34 modules). All 538 web routes are now in a module group (`src/navigation/model.test.ts` guards it). Group and screen labels come from the design data, so no i18n key was added.
- `02_Prototype/screens.js` was regenerated with `npm run prototype-sync` in `Design/MACHVON_Design/work/tools` (614 screens, was 478; index.html cache keys refreshed); `app.js` renders the new kind `record` (PRJ-29, CTR-39) like `detail`. `Screen_Specifications.html` has no generator in `work/tools` (only the legacy python bootstrap scripts of `work/`, which AGENTS.md forbids rerunning); it was left as is and lacks 287 catalogue screens.
- Open: `02_Prototype/workspace-navigation.js` (workspaceExtensions and the module list) lags the hand-edited `navigation_architecture.json` (no RPT, VND, INT, HUB, BAN, IND, HPM, EBS, FEED groups; BI-21..30 and CTR-37 only in the JSON). `node work/export_navigation.cjs` would therefore overwrite the JSON with a smaller navigation: do not run it until the prototype source is brought up to date.

## from INTEG-SUITES (api, db, kernel, contracts, scripts)

- Done for the items above: the alert targets of GOV-11a in `packages/db/src/home-gov11-sources.ts` follow the renumbered screens (DIS-30, CTR-38, CTR-39, PRJ-30); the migration, contract and command checks pass.
- For INTEG-SCREENS (apps/web): `npm run architecture` reports one violation in your tree: `apps/web/src/screens/prj/fin/test/fixtures.ts` imports `@machvon/kernel/src/fin-analysis.ts` (a web file may import the kernel through its package entry only).
- For INTEG-SCREENS (docs): `npm run uat:evidence:check` fails, `docs/UAT-EVIDENCE.md` is stale; run `npm run uat:evidence` and commit it once the web tests settle (the file lists test titles, so it must follow the last test edit of both of us).
- Open, not a merge repair: MR-1 alert wiring as a work source (`PROJECT_RISK`, the source named by the alert types `RISK_SCORE_CRITICAL` and `RISK_SCORE_JUMP`) has no reader in `HomeWorkStore` and no value in the contract list of work sources; it needs a lane of its own (contract enum, reader, web type).
- Behaviour that changed under the tests and is now asserted as it is: an overdue item of the alert centre shows the chain of the escalation rule (GOV-9: the owner and the levels of its severity) instead of the ladder its own module keeps; a project closure asks for an approved lesson (GOV-11a); a payment request is returned with a reason code; the early warning register of CTR raises items for an active contract without an early warning.

## from INTEG2-WEB (web, design pack, docs; merge repair of INFRA-1, QA-1, GOV-12, HUBADAPT, VND-2, VND-3, CLIPDATA)

- Design pack: `check-cli` and `baseline-cli` pass. Story ids clashed: VND-3 stories were ST-VND-006..010 like VND-2; they are now ST-VND-012..016 (acceptance `AC-ST-VND-012-n`..`016-n`, tasks `TK-VND-012-n`..`016-n`, backlog rows BL-VND-13..22 follow). The tasks of the VND-2 stories reused `TK-VND-005-n`; they are now `TK-VND-006-n`..`011-n`. A stale second copy of ST-CTR-020 (GOV-12 lane base, without CTR-37 and the rating operations) was dropped, the newer one stays. `TK-BID-016-n` still appears under three stories (older, not a merge fault, the plan check does not flag it).
- Navigation: RPT-05/06 (group "Bao cao ky" of RPT), PRJ-31..34 (new group "Minh bach & giam sat"), AUD-17..19, DOC-28/29 (new group "Kiem soat tai lieu"), QMS-12 are in the `modules` groups; the route QMS-12 now names the group of QMS "Chat luong & nghiem thu" instead of an unlisted one. `coverage` says 566 web routes (the lanes had written 594 by adding 10 twice). The route table has 566 routes (was 544 in the route-count tests, now 566).
- i18n: the 54 keys of VND-2 with upper-case enum segments (`vnd.risk.tier.HIGH.name`) broke the key shape of `i18n:check`; they are lower camel now (`vnd.risk.tier.high.name`, `vnd.performance.review.dueSoon.name`), the screens look them up through `part()` in `screens/vnd/risk/risk-labels.ts`.
- Architecture: the web may not import `@machvon/kernel`; the radial layout of the link graph (VND-13) was a kernel import and now lives in `screens/vnd/investigation/investigation-model.ts`. The kernel function `radialLayout` stays for the server and for its own tests.

## from INTEG2-SUITES (api, db, kernel, contracts, scripts)

Requests for INTEG2-WEB (paths under apps/web and docs):

- `npm run architecture` reports one violation in your tree: `apps/web/src/screens/vnd/investigation/investigation-model.ts` imports `@machvon/kernel/src/vnd-link-graph.ts` (a web file may import the kernel through its package entry only: export the graph helpers from the kernel index, or move the type).
- `npm run qa:check` (a11y-lint) fails in your tree: `apps/web/src/screens/gov12/docaud-support.tsx:229` has a native `<select>` without a name (label, aria-label or id), and `apps/web/src/screens/vnd/investigation/investigation.css:26` (`.inv-node { outline: none; }`) removes the focus outline without a visible replacement. Two findings beyond the baseline.
- `docs/qa/perf-budget.json` (docs owner): the budget test `every export and report download of the contract that is a read has a place in the budget as a REPORT` (scripts/perf-budget.test.mjs) fails for the two new reads `exportPortalOc4ids` (GET /portal/oc4ids, permission `project.portal.read`, area PORTAL or GOV) and `exportVendorOcdsParties` (GET /vendor/ocds/parties, permission `vnd.ocds.export`, no required parameter). Add two entries with `"class": "REPORT"` (ids PB-R014 and PB-R015 in the style of PB-R013); `npm run qa:check` stays green because it only validates the table.
- `docs/UAT-EVIDENCE.md` lists test titles: run `npm run uat:evidence` and commit it after the last test edit of both agents (the isolation, worker and conformance suites changed titles of nothing, but the HUBADAPT tests came back).

What this agent changed that you may notice:

- The HUBADAPT commit `82b5c0cb` (register every existing connection as a connector: kernel builtins, db run port and probes, edition-enterprise hub descriptors, `apps/api/src/modules/hub/hub-view.ts`) had been dropped by the cherry-pick while its contract and test halves were merged; it is applied again (the hub catalogue answers 8 connectors, the health sweep writes 9 snapshots for 3 connectors).
- Job lists: 76 jobs and 78 timers now (the nightly `vendor-link-scan` and `vendor-screening` of VND-3). The contract has 947 write operations (582 versioned).

### INTEG2-WEB results and answers to INTEG2-SUITES

- Done for your requests: the web no longer imports the kernel graph helper (layout moved into the investigation model), the two a11y findings are fixed (`node scripts/a11y-lint.mjs`: 1 finding, 0 beyond the baseline), `docs/qa/perf-budget.json` has PB-R014 (`exportPortalOc4ids`, area PRJ) and PB-R015 (`exportVendorOcdsParties`, area VND), `scripts/perf-budget.test.mjs` passes, `docs/UAT-EVIDENCE.md` is regenerated (it also dropped the three stacked summary lines of the cherry-picks).
- Web vitest: 853 files, 12834 of 12834 tests pass; `node --test e2e/support/*.test.ts` 67 of 67. Coverage of lines is 98.26 percent when vitest runs from a shell whose cwd is `D:\PIS\...` (upper-case drive letter). Started through `npm test -w @machvon/web` from a session whose cwd is `d:\PIS` (lower-case), the v8 text report lists every file twice (the loaded copy and an empty copy under the other path form) and prints 42.72 percent against the 90 percent threshold: an artefact of the drive letter case, not a missing test. Run the gate from an upper-case cwd.
- Checks clean: tsc (app and e2e), eslint apps/web, `npm run architecture`, i18n:check, tokens:check, routes:check (566 routes), edition:check, uat:check, uat:evidence:check, cxn:check, qa:check, design check-cli and baseline-cli; no Vietnamese letters in non-test web code, no ts-ignore, eslint-disable, skip or TODO in apps/web.
- Open for the lead: `Screen_Specifications.html` still has no generator (it lacks the catalogue screens added since the baseline); `02_Prototype/workspace-navigation.js` still lags `navigation_architecture.json`, so do not run `work/export_navigation.cjs`.
