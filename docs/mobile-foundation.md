# MOB: the Flutter application foundation (ST-MOB-001)

`apps/mobile` is the one Flutter code base of the iOS and Android application (D-B12). It holds the shell every later mobile story builds on: five tabs, routing with a deep-link guard, the generated API client, the theme from the design tokens, two languages, and the eight standard states of a screen including MOB-52 (empty) and MOB-53 (service error with retry). This page is the contract between the foundation and the stories that add screens on top of it; `Design/MACHVON_Design/01_Documents/05_modules/MOB.md` stays the authority on behaviour.

The foundation has no screen of business content. The sign-in, the tenant discovery, the offline queue and the lists are later stories (ST-MOB-002 onwards); where they plug in is listed under "Seams" below.

## Commands

All from `apps/mobile`. Flutter is pinned to 3.47.7 (the same as `.github/workflows/ci.yml`).

| what | command |
|---|---|
| dependencies | `flutter pub get` (the `pubspec.lock` of the application is committed; CI uses `--enforce-lockfile`) |
| static analysis | `flutter analyze` (must report no issue) |
| all tests | `flutter test` (add `--coverage`; the CI floor is 90 percent of lines) |
| regenerate the route table | `dart run tool/generate_routes.dart` (after `navigation_architecture.json` or `screen_catalog.json` change) |
| regenerate the feature list | `dart run tool/generate_registry.dart` (after you add or remove a feature directory) |
| refresh the golden images | `flutter test test/golden --update-goldens` (only when a shared state widget is meant to look different) |
| run | `flutter run --dart-define=MACHVON_API_BASE_URL=https://...` (the URL is required; plain http only for `localhost`, `127.0.0.1` or `10.0.2.2` in a debug build) |
| build | `flutter build apk --debug`, `flutter build ios --release --no-codesign` (CI job `Mobile`, `.github/workflows/mobile.yml`) |

`packages/mobile-api-client` (generated Dart client, `npm run contracts:generate` writes it) and `packages/mobile-tokens` (generated theme, `npm run tokens:generate`) are path dependencies. Never edit their generated files; never copy them into the application.

## Directory layout

```
apps/mobile/
  lib/
    main.dart                       starts the app: reads --dart-define, runs MachvonApp
    app/                            MachvonApp (Material app on the router), AppConfig
    core/                           the shared foundation; stories do not edit it, they use it
      api/                          DartIoHttpTransport, ProblemView (error mapping), decodeAnswer
      connectivity/                 Reachability (what the requests show about the connection)
      di/providers.dart             the Riverpod providers that wire the pieces together
      l10n/                         StringTable, AppStrings, context.t(...), the core strings
      navigation/                   route catalogue and table, router, shell, deep-link guard, feature/screen types
      session/                      SessionController port (signed out by default)
      state/                        StateBoundary, EmptyStateView, ProblemStateView, banners
      sync/                         SyncStatus (pending commands, conflicts) read by the banner
      theme/                        buildAppTheme (tokens + published tenant theme)
    features/                       one directory per capability, owned by the story that adds it
      registry.generated.dart       generated: the list of the features below
      foundation/                   MOB-52 and MOB-53
  tool/                             the two generators
  test/                             mirrors lib/; support/ holds the harness every test uses
```

## Decisions

**State management and DI: Riverpod (`flutter_riverpod`).** A provider is both the dependency-injection point and the state holder, and it can be overridden per test (`ProviderContainer(overrides: ...)`), so a test replaces the transport, the session or the feature list without any service locator or global. Providers are declared next to the thing they provide (`reachabilityProvider` in `connectivity/`, `sessionProvider` in `session/`), and `core/di/providers.dart` holds only the wiring (config, client, router, catalogue). It is the only state library; screens keep purely local state in `StatefulWidget`s.

**Routing: `go_router` with `StatefulShellRoute.indexedStack`.** One navigation stack per tab and every tab stays mounted, which is what restores the scroll position and the filter when the user comes back to a tab or pops a detail screen (AC-ST-MOB-001-1). The `redirect` of the router is the deep-link guard.

**HTTP: `dart:io` behind the `HttpTransport` port of the generated client.** No extra package. The transport never follows a redirect (the bearer token would follow it), refuses plain http outside a loopback debug build, times out, and caps the answer at 8 MiB.

**Languages: own `StringTable` (flat keys like the web), not ARB.** ARB keys cannot hold dots, and the project key convention is `module.screen.action.state`. A table is two Dart maps (vi, en), so each feature carries its own strings in its own file and no shared file is edited.

## How a screen is identified: FR and UI ids

A screen is identified by its screen id, never by a path or a class name. `lib/core/navigation/mobile_routes.generated.dart` lists the 72 screens of the mobile navigation (68 `MOB-nn` plus `QMS-09`, `QMS-10`, `DOC-22`, `DOC-23`), generated from `navigation_architecture.json` and `screen_catalog.json`. Each entry carries:

| field | example for MOB-52 | meaning |
|---|---|---|
| `id` | `MOB-52` | the screen id of the design |
| `requirement` | `FR-MOB-52` | the functional requirement it implements |
| `uiTestId` | `UI-MOB-52` | the UI test id the backlog expects (derived) |
| `kind` | `empty` | the design kind (`form`, `list`, `approval`, ...) |
| `tab` / `isTabRoot` | `account` / false | the tab it opens in; roots are MOB-07, 09, 23, 32, 47 |

The location is derived, nothing is chosen by a story: a tab root is `/<tab>`, another screen of a tab `/<tab>/<id>`, a screen without the bottom navigation `/<id>`, the id in lower case (`/account/mob-52`, `/mob-02`). Screens that open without a session (MOB-01 to 04, MOB-44 session expired, MOB-54 forced upgrade) are listed in `core/navigation/route_policy.dart` and are shown outside the tabs; every other screen needs a session.

Every screen of the table can be opened from the first day: until a story implements one, the router shows `NotImplementedScreen`. So a story never adds routes, it implements the screens it owns.

## How to add a screen (no shared file is edited)

1. Pick the directory of your capability under `lib/features/`, lower_snake_case (`lib/features/reporting/`). One story owns a directory; never edit another story's directory.
2. Write the screen in its own file, `lib/features/reporting/screens/weekly_period_screen.dart`, as a function or widget. It receives a `ScreenContext` (path parameters, query parameters, an in-memory `extra`). A screen must open from its path parameters alone, because `extra` does not survive a restart.
3. Declare the feature in `lib/features/reporting/reporting_feature.dart` with a top-level `feature`:

   ```dart
   const MobileFeature feature = MobileFeature(
     id: 'reporting',
     strings: reportingStrings,                     // optional, see "Strings"
     screens: <ScreenSpec>[
       ScreenSpec(screenId: 'MOB-13', builder: buildWeeklyPeriodScreen),
       ScreenSpec(screenId: 'MOB-14', pathSuffix: '/:periodId', builder: buildQuantitiesScreen),
     ],
   );
   ```

   `pathSuffix` appends path parameters (`/account/mob-14/:periodId`); a tab root cannot take one. The id must be in the catalogue.
4. Run `dart run tool/generate_registry.dart`. It rewrites `lib/features/registry.generated.dart` from the directories, deterministically, so two stories that do this at different times produce the same file for the same set of directories. The test `registry_test.dart` fails if the file is stale, and it checks the whole registry: unknown screen ids, a screen implemented twice (both features are named), a tab root with parameters.
5. Navigate with `context.go(...)` or `context.push(...)` to the derived location. Use `ref.read(routeTableProvider).locationOf('MOB-14')` when you do not want to write the path.

## Strings

- Keys follow `module.screen.action.state` (three to five segments, the first in lower case): `mob.states.retry.action`, `dis.report.submit.pending`. A feature uses the prefix of its module (`dis.`, `iss.`, ...); the shared foundation uses `mob.shell`, `mob.states`, `mob.problem`, `mob.banner`, `mob.route`. A key declared twice fails at start.
- Declare both languages in the feature file (`StringTable(vi: {...}, en: {...})`, referenced from `MobileFeature.strings`). The two maps must have the same keys and the same `{placeholders}`.
- Use a literal key at the call site: `context.t('mob.states.retry.action')`, with values as `context.t('key', {'count': 3})`. Never build a key from parts: `registry_test.dart` reads every literal in `lib/`, requires it in both languages, fails on a key that is declared but never used, and fails on a call that is not a literal.
- A missing key shows the key itself, so the gap is visible instead of blank. No user-visible text is written in code; error text from the server is never shown (only the error code and the correlation id).

## The standard states (MOB-52, MOB-53 and the rest)

`ScreenState` has the eight states of the web: `defaultState`, `loading`, `empty`, `error`, `denied`, `expired` (licence), `signedOut` (lapsed session), `offline`. `StateBoundary` draws them:

```dart
StateBoundary(
  state: state,                       // from your data: loading, empty, error...
  problem: ProblemView.from(error, reachability: ref.watch(reachabilityProvider)),
  onRetry: reload,                    // the button appears only when you pass it
  activeFilters: const ['Đang thực hiện'], onClearFilters: clearFilters,
  child: theContent,
)
```

- **Content stays mounted** behind every message state, only hidden, so what the user typed survives an error and a retry (AC-ST-MOB-001-2). A screen that cannot build its content before its data arrives passes `keepContent: false`.
- **MOB-52** is `EmptyStateView`: title, guidance, the filters in use and "clear filters". **MOB-53** is `ProblemStateView`: title, the stable error code, the correlation id (selectable and copyable), retry. Both are also routable screens (`/account/mob-52`, `/account/mob-53`; MOB-53 takes a `ProblemView` as `extra`, and its retry goes back to the screen that failed).
- **Accessibility:** each message is one live region (TalkBack and VoiceOver announce title, body, code and reference once; the visible texts are excluded so they are not read twice) and buttons stay separate nodes. Everything scrolls, so 200 percent text never overflows; the device text scale is honoured without a clamp.
- **Banners** above the tabs: `mob.banner.offline` while `reachabilityProvider` is `offline`; the sync banner counts `syncStatusProvider` (pending commands, conflicts). Badges on the tabs come from `tabBadgeProvider`.

### Mapping a failure to a state: `ProblemView.from(error)`

| failure | state | shown |
|---|---|---|
| `ApiError` 401 or `SESSION_EXPIRED` | `signedOut` | code, reference |
| `ApiError` `LICENSE_EXPIRED` | `expired` | code, reference |
| `ApiError` 403 (`SCOPE_DENIED`, ...) | `denied` | code, reference |
| `NETWORK_ERROR` while the device is known to be offline | `offline` | code, reference |
| `NETWORK_ERROR` otherwise (a time-out, an unreachable server) | `error` with the time-out wording | code, reference |
| any other `ApiError` (409, 422, 5xx) | `error` | code, reference |
| `ContractMismatch` (the answer does not match the contract) | `error`, code `CONTRACT_MISMATCH` | code |
| anything else | `error`, code `CLIENT_ERROR` | code |

The correlation id is the one the client sent in `x-correlation-id` and the server logged (or the one in the problem body), so support can find the request. A failure that never reached the server has none and shows none. Business refusals (409 `VERSION_CONFLICT`, 422 `PERIOD_LOCKED`) are mapped by the screen that owns the command; the table is only the generic fallback.

**Retry of a command is not "send again":** a retry after a lost answer must reuse the `CommandAttempt` (the idempotency key and the version) of the first attempt, exactly as the web does. `onRetry` of a command screen calls the same attempt, never builds a new one.

## The API client

`apiClientProvider` is the generated `MachvonApiClient` with the transport of the application, the bearer token of the session (read for every request through `SessionController.accessToken()`), and the interface language as `Accept-Language`. Call an operation with its typed method or `execute(operationId, ...)`, then read the answer with `decodeAnswer(operationId, json)`: it uses the decoder generated from the contract and throws `ContractMismatch` naming the member when the backend renamed or retyped a field.

Contract tests (AC-ST-MOB-001-3): `packages/mobile-api-client/test/contract_responses_test.dart` reads and writes back all recorded responses (one per operation, written by the generator from `openapi.json`), and `apps/mobile/test/api/contract_wiring_test.dart` does the same through the client of the application and shows a renamed field failing with the member named. Both run in the `Mobile` workflow; a contract change that is not regenerated (`npm run contracts:generate`) fails there.

## Offline rules

The foundation provides the places, not the queue (ST-MOB-005, ST-MOB-006, ST-MOB-007 build on them). The rules every story keeps (MOB.md, BR-MOB-01 to 06):

- Only **commands** are queued offline, never table writes, never last-write-wins. Each carries its own `CommandAttempt` key; a submission that lost its answer is `UNKNOWN` ("Chưa xác định kết quả"), is looked up by key when the device is back, and is never created again.
- **Approvals, signing and anything that needs a final permission check are online only**, rechecked by the server. No approval from a cache, a swipe or a push.
- Cached data shows `as_of`; offline never shows "latest". Money fields are read-only reference data offline. The clock of the phone is never used to judge a licence or a deadline.
- A command that changes the money of a report is not merged automatically; the user chooses (MOB-42).
- Everything stored locally belongs to one tenant and is purged on sign-out and tenant switch; a command carries its tenant and user and is never sent under another tenant.
- `reachabilityProvider` is learned from real requests (an answer means online, a refused connection means offline); it is `unknown` before the first request and treated as online. 
  A request alone reports nothing while the screen is idle, so `ConnectivityMonitor` (`core/connectivity/connectivity_monitor.dart`, started by `SessionServices` while a person is signed in and the app is in the foreground) also reports: every 2 s it asks `dart:io` whether any non-loopback interface holds an address (none means airplane mode or a network taken down: offline at once, no traffic), and at most every 4 s (every tick while offline) it probes the API with a token-less read of `/mobile/version-policy` (any answer is online; a refused connection or no answer within 3 s is offline). The banner of the shell therefore shows within 2 s of the airplane mode on a phone whose interfaces go away, and within 7 s (probe interval 4 s plus time-out 3 s, under the 8 s target) on a device that keeps its interface up: an Android emulator in airplane mode keeps its virtual interface with an address, so the platform check says "online" and only the probe can tell. UAT run 5 measured 22 s on an idle Home tab and 45 s on the other tabs with the former values (5 s tick, probe every 20 s, 5 s time-out): the probe was the only signal and it ran too seldom. `ConnectivityPolicy` holds the three numbers; the probe costs about 15 small requests a minute in the foreground and none in the background. The queue and the uploads send again when the state turns online. No plugin is used; when the platform cannot list the interfaces the probe alone decides.
- `syncStatusProvider` is written by the queue story; the foundation only reads it.

## Seams for the next stories

| story | plugs in by | what it replaces or fills |
|---|---|---|
| ST-MOB-002 sign-in (done) | `OidcSession` on `AuthService`, installed by `lib/app/bootstrap.dart`; see `docs/mob-session.md` | `SignedOutSession`; the guard sends a signed-out user to `/mob-02?return=...`, an ended session to `/mob-44`, a session that needs the second factor to `/mob-03`, a locked one to `/mob-02?unlock=1`; after the sign-in open `safeReturnLocation(returnParameter)` |
| ST-MOB-004 tenant discovery | `tenantThemeProvider.notifier.publish(overlay)` with the published hex colours; `appConfigProvider` per tenant | `buildAppTheme` applies the overlay only when the contrast rules of the web accept it whole |
| ST-MOB-005 queue | writing `syncStatusProvider`; the spike `offline_command_queue.dart` is the starting point | the sync banner |
| ST-MOB-015 deep links | overriding `deepLinkGuardProvider` (it may be asynchronous: resolve the opaque link on the server, then check tenant and permission); platform manifests get their link filters then | the default `SessionDeepLinkGuard`: session required, a `tenant` parameter other than the active tenant goes to MOB-45 |
| any story | `tabBadgeProvider.notifier.set(AppTab.approval, n)` | the tab badges |

## Security notes (review: security)

- Tokens are never logged, stored by the foundation, or put in a URL; the transport sends the `Authorization` header only to the configured HTTPS base URL, never follows a redirect, and refuses `http` outside a loopback debug build. `AppConfig` fails at start on a URL that is not acceptable.
- The deep-link guard runs in front of every location. The `return` location after sign-in must be a path of this application (`safeReturnLocation` refuses another site, a protocol-relative address, a backslash, control characters, more than 2048 characters).
- The tenant theme is applied only when the whole overlay passes the same checks as the web (hex colours only, the twelve known keys, contrast 4.5 for the six text pairs); an overlay that fails is ignored whole.
- Android: `allowBackup=false` and `usesCleartextTraffic=false`; the release build is signed only with `android/key.properties` (never committed) and stays unsigned without it, so it can never ship with the debug key. iOS keeps App Transport Security at its default (https only).
- Server text never reaches the screen: `ApiError.toString` is the code, and the views show only the code and the correlation id.

## Tests

- **Naming (required by the traceability script):** the ids (`AC-ST-MOB-001-1`, `UI-MOB-52`, `UAT-ACnnn`, `TK-MOB-001-n`) must appear in the title of a `group()` or `test()`. `scripts/uat-trace.mjs` does not read `testWidgets()` titles, so put the ids in the enclosing `group('AC-ST-MOB-001-1 UI-MOB-52 ...', () { testWidgets(...) })`. A `testWidgets` outside a group with an id is not traced.
- **Harness:** `test/support/harness.dart` has `pumpApp` (the whole application on a feature list, a signed-in `FakeSession`, a fake transport, Vietnamese by default), `useDevice(tester, size, textScale:)` (`kDeviceSizes` are 360x800, 390x844, 430x932), `pressBack`, `currentLocation`. `test/support/widget_host.dart` hosts one shared widget without a router. A screen story tests its screen with `pumpApp(features: [feature])`, never against a real network.
- **What every screen test checks:** no layout exception at the three sizes and at text scale 2.0 (`tester.takeException()` is null), `meetsGuideline(androidTapTargetGuideline)` and `iOSTapTargetGuideline` (with `debugDefaultTargetPlatformOverride`, reset in a `finally`), `labeledTapTargetGuideline`, `textContrastGuideline`, and the seven states of the screen where they apply.
- **Goldens:** `test/golden` holds the images of MOB-52 and MOB-53 at the three sizes and at 200 percent text. They use the test font and a 0.5 percent pixel tolerance so they hold on every OS.
- **Mutation check:** break the rule, see the test go red, restore, `cmp` against the backup, as for the web.

## Release channel and CI

`.github/workflows/mobile.yml` runs on every change to `apps/mobile`, the two packages or the two design files: generated files up to date, `flutter analyze`, `flutter test --coverage` with the 90 percent floor, the Android debug APK, the iOS release build without code signing. Signing, store upload, staged rollout and the forced-upgrade screen belong to ST-MOB-016.
