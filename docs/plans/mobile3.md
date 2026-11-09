# Plan of lane MOBILE3 (phone: real push, alert routing, enterprise home, secure screens, read views)

Branch `lane/mobile3`, worktree `D:\PIS-mobile3`. Owner rule 2026-11-08: decide by deepest governance and best extensibility, never cut scope. The phone is read-first; strings only in `*_strings.dart`; new screens only through `scripts/contract-patch.mjs add-screen`.

## Decisions

1. Push adapter: the port `PushPlatform` stays; a new `FirebasePushPlatform` implements it over a thin gateway (`PushGateway`) that wraps `firebase_messaging`/`firebase_core`. Configuration is `--dart-define` only (`MACHVON_PUSH=fcm`, `MACHVON_FCM_API_KEY`, `MACHVON_FCM_APP_ID`, `MACHVON_FCM_SENDER_ID`, `MACHVON_FCM_PROJECT_ID`): `Firebase.initializeApp(options: ...)` is given the options in code, so no `google-services.json` or `GoogleService-Info.plist` is committed and a build without them still passes. Without the flag, or with a blank value, the null adapter (`NoPushPlatform`) is selected. The payload is id-only (`nid`): the deep link is the opaque link `/r/<id>`, anything else in the payload is ignored. The receipt acknowledgement is a port (`PushReceiptPort`, no-op default) that lane ENT-3c plugs a call into.
2. Alert routing: one table `kAlertTargets` extended for every target screen that the server names for payment clocks, contracts, issues, permits, audit, reports, diary and claims, mapped to the phone screens that exist (MOB-27, MOB-61, MOB-62, MOB-63, MOB-64, MOB-31, MOB-67, ...). A test reads the target screens the server sources write (`packages/db/src/home-*-sources.ts`) and fails when one has neither a rule nor an entry in the explicit "no phone screen" list.
3. Enterprise home: `EditionProfile` gets `homeCards` (builders); the enterprise profile supplies period status, HPM push and EBS status cards that read `listHpmPushes`, `getHpmConnection`, `getEbsConnection`, `listEbsDifferences`, reporting periods; the snapshot reader of ENT-3a is a hook (`enterpriseSnapshotReaderProvider`, default empty). Only `edition_seam.dart` names the enterprise folder.
4. Secure screens: MOB-65 (acceptance approval, decision papers), MOB-72 (confidential committee workspace), MOB-73 and MOB-74 (risk grades of contractors) are added to `kSecureScreenIds`; they are filmed no more, so `scripts/hdsd/not-filmed.json` lists them and their guide steps are removed.
5. New read-only screens: MOB-75 delegations and absences, MOB-76 KPI register, MOB-77 report catalogue (entrance: the account screen).
6. Documentation duplicates removed (MOB.md alert bullet, governance views page, mobile2 plan, security review count); stray JVM crash logs ignored by git.

## Steps

| # | Step | Tests | State |
|---|---|---|---|
| 1 | Plan, commit | | [x] |
| 2 | Documentation duplicates, `.gitignore` for crash logs | `check-cli` | [x] |
| 3 | Secure screens MOB-65, 72, 73, 74 and not-filmed ledger | `test/hardening/secure_window_test.dart`, `scripts/hdsd` node tests | [x] |
| 4 | Alert routing for payment, contract, issue, permit, audit, report, diary, claim sources | `test/features/dashboard/alert_routing_test.dart` | [ ] |
| 5 | Push adapter, permission flow, token refresh, revoke, payload deep link, receipt port | `test/features/notification_inbox/push_adapter_test.dart` | [ ] |
| 6 | MOB-75 delegations and absences, MOB-76 KPI register, MOB-77 report catalogue | `test/features/governance_reads` | [ ] |
| 7 | Enterprise home cards | `test/editions/enterprise_home_test.dart` | [ ] |
| 8 | Design rows, hdsd ledger, routes regenerated, shared suites entries | `check-cli`, `baseline-cli`, `generate_routes --check` | [ ] |
| 9 | `flutter analyze`, tests of the touched directories, independent review, merge main | | [ ] |

## Risks

- `flutter pub get` for the Firebase plugins needs the network or the pub cache; the plugins are in the cache.
- No device: the adapter is tested through the gateway with a fake; the native side (APNs capability, notification channel) is documented, not run.
- Memory is tight: Flutter commands one at a time, only when free RAM allows.
