# Plan of lane CLIPFEATURES (complete feature coverage of the two intro clips)

Branch `lane/clipfeatures`, worktree `D:\PIS-clipfeatures`. Owner request 2026-11-09: add to the intro clips the features that are still missing so that both clips present the product completely (public clip "Hệ thống quản lý đầu tư công", enterprise clip "Phần mềm quản lý đầu tư xây dựng" for Đạm Phú Mỹ). Vietnamese only; web, smartphone application and installed application (PWA). Chapter cuts may exceed 5 minutes; the main video stays at 10 to 12 minutes.

## Decisions (owner rule 2026-11-08: deepest governance, extensibility, no scope cut)

1. Audit first: the screens of `screen_catalog.json` that no scene shows are grouped by feature family (VND-2, VND-3, GOV-8 to GOV-12, FEED-1, BAN-1, MR-1, HUB, INT-1, IAM-2, AI-2, DOC-2, RPT-1, WF-1, IND-1, FND-1, ENT-2, PWA, look-ahead, PORTAL-2) and every family without a scene gets a chapter. The result is in the final report.
2. New chapters are shared chapter files (`scenarios/shared/*.json`, used by both clips, so footage and words are recorded once per data set) except the parts that exist in one edition only (`scenarios/public/*.json`, `scenarios/enterprise/*.json`).
3. The main video does not grow: one animatic scene `tour-more` names every added chapter in about half a minute, and the new chapters are chapter cuts (`mainOptional`). A chapter cut is the place where a feature is shown in full.
4. A scene whose screens or behaviour are not on main yet (ENT-3, ENT-4 lanes) carries `requires: [lane]`. The lane registry is `planned.json` `lanes` (`pending` or `merged`). `scenario.mjs check` and `clip-scripts-check` accept the scene while the lane is pending (strict reports it as waiting, not as an error); the recording tools (`make`, `tts`, `tts-edge`, `subtitles`) skip pending scenes unless `--include-pending`; flipping the lane to `merged` is a one-line edit.
5. Data: every chapter lists the seed groups it needs in `readiness.json`. Groups that do not exist yet are `plannedGroups` (`NOT_DONE`, with what they must create); the recording agents write them in `scripts/clip-seed-lib.mjs`. No figure is invented: figures are placeholders read from the stack at record time.
6. Narration: short sentences (at most 30 words), numbers spoken as words only for structural counts of the product, legal numbers carry the `unverified-legal` stamp, phonetic table extended where needed.

## Steps

- [ ] 1. Plan committed (this file).
- [ ] 2. Tool support for `requires` (scenario.mjs, production.mjs, make/tts/tts-edge/subtitles), `mainOptional` chapters, planned screens, planned seed groups; tests for each.
- [ ] 3. Shared chapters: contractors-plus, contractor-portal, claims-warnings, alerts-plus, delegation, audit-controls, risk-forecast, docs-ai-plus, correspondence, integration, field-ops, procurement-desk, project-life, reports-close, platform, phone-plus.
- [ ] 4. Public chapters: capital-control, payments, monitoring, portal-public. Enterprise chapters: ent-cycle (ENT-3, ENT-4, pending lanes), extra scenes of hpm-ebs.
- [ ] 5. Both scenarios: includes, tour scene, music cues, readiness groups, refs, shots, phonetics; `scenario.mjs stamp`; book generated with `clip-scripts-check.mjs book --write`.
- [ ] 6. Checks: `node --test scripts/clips/*.test.mjs scripts/clip-scripts-check.test.mjs`, `node scripts/clips/scenario.mjs check`, `node scripts/clip-scripts-check.mjs check`.
- [ ] 7. Independent read-only review of `git diff main...HEAD` (Codex is rate limited until 2026-11-10 23:17: a fresh Plan/Explore subagent), triage, fixes.

## Tests per step

- Step 2: unit tests in `scenario.test.mjs` and `production.test.mjs` for pending lanes, planned screens, `mainOptional`, planned groups; `make.test.mjs` for the skip.
- Steps 3 to 5: the existing whole-scenario tests (catalogue, contract, refs, phonetics, durations, stamps, music cues, readiness).

## Risks

- Screens of the ENT lanes have no id yet: planned ids (`planned:ent-*`) with the lane; the recording agent binds the real id at merge.
- Main video length: guarded by the existing 480 to 720 s check.
- Resource: no stack, browser, ffmpeg or TTS in this lane; only node tests when free memory allows.
