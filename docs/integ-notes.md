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
