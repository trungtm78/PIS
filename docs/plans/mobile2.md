# Plan of lane MOBILE2 (phone app covers the governance modules of the web)

Branch `lane/mobile2`, worktree `D:\PIS-mobile2`. Owner rule 2026-11-08: decide by deepest governance, best extensibility, no cut of scope. The phone is read-first: every new view only reads (the commands stay on the web), uses the cache rules of `read_support`, keeps its words in `*_strings.dart`, and never draws a figure the server did not send.

## Audit of `apps/mobile/lib/features` against the web (findings that drive the steps)

| Area | State on main | Gap |
|---|---|---|
| Alert centre | `alerts.dart` parses severity, consequence, clocks, snooze, pause; claim, assign, snooze flows exist | `alertSourceLabel` knows 21 of the 43 `WorkSource` values of the contract (CONNECTOR, EGP_POSTING, VENDOR, CONTRACT_CLAIM, CONTRACT_EARLY_WARNING, ESCALATION, COVERAGE, RED_FLAG, CONTRACT_CLOCK, DOC_REVIEW, DATA_FRESHNESS, ANOMALY, ALERT_FEEDBACK, PAYMENT_CLOCK, DISBURSEMENT_FORECAST, SETTLEMENT_CLOCK, CONTRACT_ADJUSTMENT, LOOK_AHEAD, LESSONS_LEARNED, PROJECT_RISK, COMMITTEE, OBLIGATION, EXPLANATION_CONCLUDE show the raw code); `alertScreenOf` opens only approval and project targets, so package, directive, committee, contractor and project-risk alerts do not open the phone screen that exists for them |
| Progress tree | MOB-69 packages by step, MOB-70 package with stepper and day-by-day timeline, MOB-71 outline tree (read only) | the statistics of a node (`getPackageProcessTreeNode`: median, longest, shortest days, stalled, held, no owner, top owners, unfinished items, weekly arrivals and departures) are not shown on MOB-69 |
| Committee (BAN-1) | card on the leader home (figures, 3 attention items, alerts) | no full read-only dashboard: rows by sector, district, investor, fund source, full attention list, directive tracker, units not reporting, changes since last week |
| Contractor risk and performance (VND-2) | none | no view of `listVendorRiskGrades`, `getVendorRiskGrade`, `getVendorPerformance` |
| Edition switch | `--dart-define=MACHVON_EDITION` | must stay untouched (tests keep passing) |

## Decisions

1. Source labels are data: one table `kAlertSourceKeys` (source code to string key) plus a `kAlertTargetScreens` table (web screen id to phone screen id and the way the id is carried). A test reads `Design/MACHVON_Design/03_Engineering/openapi.json` and fails when a `WorkSource` of the contract has no label, so a new source cannot ship unlabelled again. The raw-code fallback stays for a value newer than the phone.
2. Alerts open the phone screen when there is one: BID-29 to MOB-70 (package), PRJ-30 and PRJ-03 to MOB-10 (project), DIR-04 to DIR-06 (directives), BAN-05 to MOB-72 (committee), VND-11 and VND-12 to MOB-74 (contractor). An alert whose target the phone has no screen for is handled from its actions, as today.
3. MOB-72 reads `getCommitteeWorkspace` once (the server writes an audit row for every view, so it is read when the screen opens and on an explicit refresh only). The `CommitteeWorkspace` model of the home card is extended, not duplicated. A reader without `committee.read` sees the refusal state, not an empty page.
4. MOB-73 and MOB-74 read `vnd.read` operations; a signal is never shown as a verdict: tier, score, factors, reasons, rule version and the UNVERIFIED flag are shown as the server sends them.
5. New screens go through `scripts/contract-patch.mjs add-screen` (MOB-72 committee dashboard, MOB-73 contractor risk list, MOB-74 contractor risk and performance), navigation architecture rows, routes regenerated with `dart run tool/generate_routes.dart`.

## Steps

| # | Step | Tests | State |
|---|---|---|---|
| 1 | Plan, commit | | [x] |
| 2 | Alert sources: labels for all contract values, source-to-label test against the contract, target mapping for the new screens | `test/features/dashboard/alert_sources_test.dart`, existing alerts tests | [x] |
| 3 | Progress tree: statistics of a node on MOB-69 | `test/features/procurement_workflow/node_stats_test.dart` | [x] |
| 4 | Committee dashboard MOB-72 (and entrance from the home card) | `test/features/committee_dashboard` | [x] |
| 5 | Contractor risk list MOB-73 and detail MOB-74 (entrance from the projects list) | `test/features/vendor_controls` | [x] |
| 6 | Design rows (screens, navigation, story, backlog, traceability, test cases), `docs/mobile-governance-views.md`, hdsd phone steps ledger (`scripts/hdsd/verification.json`, `mobile-chapters.json`) | `check-cli.mjs --locale en`, `baseline-cli.mjs --locale en`, `generate_routes.dart --check` | [x] |
| 7 | `flutter analyze`, `flutter test`, repo scan, `npm run lint`, `npm run typecheck` | analyze clean; flutter test 2312 pass (5 Windows file-lock flakes of the photo and consent suites pass alone); typecheck green; lint chain green except the CRLF checkout quirk of `uat:check` | [x] |
| 8 | Codex review (model gpt-6-astra), triage, fixes with regression tests | see below | [x] |

## Risks

- Shared design files conflict at merge: edits are anchored (append at the end), screens only through the tool.
- Memory is tight: Flutter commands one at a time, check free RAM first.
- The ledger and chapters of the hdsd guide are generated or checked by scripts: run their checkers after editing.

## Codex review dispositions

1. P1 contractors without a confirmed grade were dropped (the contract makes  and  nullable in the register and  nullable in the grade): valid. Fixed: the item and the detail keep a null tier, the screens say "Not graded" with an icon and a word and draw no score; regression tests in the model, the list and the detail.
2. P2 the risk list kept rows and cursor of the old page after a refresh: valid. Fixed ( resets, an epoch drops answers of an older page); regression test refreshes and expects the old row and the "show more" button gone.
3. P2 the chips replaced their semantics without a tap action: valid for the new chips (vendor filters, committee cuts). Fixed with  on the replacement node and two tests that tap through the semantics tree. The same pre-existing pattern in the chips of MOB-69 (not in this diff) is left for its owner and noted in the report.
