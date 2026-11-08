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
