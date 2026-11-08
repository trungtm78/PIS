# Governance views on the phone (lane MOBILE2)

The phone app reads the governance modules of the web and never writes to them. This page says what the phone shows, which operation each screen reads, how alerts find their screen, how copies kept on the device behave, and what stays on the web. Behaviour authority: `Design/MACHVON_Design/01_Documents/05_modules/MOB.md` section 14; plan and decisions: `docs/plans/mobile2.md`; story ST-MOB-029.

## Screens and the operations they read

| Screen | What it shows | Reads | Permission |
|---|---|---|---|
| MOB-72 steering committee dashboard (tab Home, entrance from the committee card of the leader home) | Province disbursement against the expected curve and the year-end range; progress by sector, district, investor and fund source; projects needing attention with the reason; overdue directives by unit; units not reporting; alerts of the committee; changes since last week; the "i" of every figure (formula, source, as-of) | `getCommitteeWorkspace` | `committee.read` on the whole tenant |
| MOB-73 contractor risk list (tab Projects) | Contractors by tier (low, medium, high, critical) and score, next review date, overdue review, tier proposals waiting for confirmation, list totals, rule in force | `listVendorRiskGrades` | `vnd.read` |
| MOB-74 one contractor, risk and performance | Confirmed tier, score, factors and reasons in words, grading history; performance grade, posting clock, response clock, run of poor grades, suggestions | `getVendorRiskGrade`, `getVendorPerformance` | `vnd.read` |
| MOB-69 packages by step (existing) | Now also the statistics of the chosen node: median, longest and shortest days, late, stalled, held, without owner, top owners, unfinished items, weekly arrivals and departures | `getPackageProcessTreeNode` | as the web tree |

A figure the server did not send is not drawn, and a figure without a value is never read as 0. Colour always comes with an icon and words. A tier is a signal with its score, factors, reasons, rule version and the UNVERIFIED flag exactly as the server sends them, never a verdict.

## Alert source labels and targets

All 43 values of `WorkSource` in `openapi.json` have a label in words, kept as a table (source code to string key) in the dashboard feature; a test reads the contract and fails when a value has no label, so a new source cannot ship unlabelled. A value newer than the phone shows its raw code. Each alert also shows severity (icon and words) and its consequence line.

| Web target of the alert | Opens on the phone | Typical source |
|---|---|---|
| BID-29 package progress | MOB-70 package timeline | PROCUREMENT_WORKFLOW |
| PRJ-30 look-ahead, PRJ-03 project | MOB-10 project detail | LOOK_AHEAD, project sources |
| DIR-04 directive | DIR-06 directives | DIRECTIVE |
| BAN-05 committee | MOB-72 committee dashboard | COMMITTEE |
| VND-11, VND-12 contractor | MOB-74 contractor | VENDOR |
| ADM-06 approval task | MOB-24 (as before) | APPROVAL |
| any other target | no screen: handled from the actions of the alert (claim, assign, snooze) | |

## Read-only decisions

1. No command is offered on MOB-72 to MOB-74: no acknowledgement of a committee alert, no attention decision, no tier proposal or confirmation, no performance grading. A decision needs the roles, step-up and evidence the web enforces.
2. MOB-72 reads `getCommitteeWorkspace` when the screen opens and on an explicit refresh only. Scrolling, rotating the phone or returning to the screen does not read again.
3. A reader without the permission sees the permission-denied state, never an empty page that looks like "nothing to report".
4. New screens were added through `scripts/contract-patch.mjs add-screen`; routes are generated with `dart run tool/generate_routes.dart`.

## Offline and copies kept on the device

Reads go through `features/read_support`: the last answer is kept with its `as_of` and the moment the phone got it, per tenant and per person (BR-MOB-01, R6). Offline, the screen shows that copy with its as-of time and the words "stale" once it is older than its time to live; it is never presented as the latest. A copy is dropped on sign-out and on a change of tenant or person. Only answers are kept: no command is queued from these screens. The committee workspace is confidential and the server answers it with `Cache-Control: no-store`; the phone keeps it in the protected store of the session only so that the last answer can be shown with its as-of time, and drops it with the session.

## Audit of views

The committee workspace is classified CONFIDENTIAL. Every read writes one row of `committee_view_audit` on the server in the same transaction (who, committee role, screen, filters, as-of, record count, assurance level); a view that cannot be recorded is not answered. The phone therefore counts as one view per opening and one per explicit refresh. Reading the audit is itself audited and stays on the web.

## Edition switch

`--dart-define=MACHVON_EDITION` is untouched. The new screens are registered like the other feature screens and are present in every edition; what a person sees still depends on the permissions the server grants.

## What stays on the web

- Committee: acknowledging alerts, attention decisions, the meeting pack, the directive tracker commands, the roster and the view audit.
- Contractors: proposing and confirming a tier, grading performance, editing the rules (rule drafting and approval), registers, claims, investigations and exports.
- Procurement: moving a step, editing a workflow definition, checklist changes.
- Configuration of any kind: alert rules, thresholds, calendars, connectors.

## Verification

Screen contracts UI-MOB-72, UI-MOB-73, UI-MOB-74 (seven states, tap targets, screen reader) and UAT-PLAN-3101 (alert labels and targets, committee dashboard, risk views, node statistics, offline). The phone steps of the guide are chapter `m14-ban-chi-dao-rui-ro-nha-thau-dien-thoai` in `scripts/hdsd/mobile-chapters.json`; their state in `scripts/hdsd/verification.json` is UNTESTED until a walk on a device passes them.
