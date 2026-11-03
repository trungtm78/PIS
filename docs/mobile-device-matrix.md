# MOB: the real-device matrix, accessibility with TalkBack and VoiceOver, performance on the target devices (ST-MOB-040)

`apps/mobile` is proven on a host (analysis, widget tests at three sizes and at 200 percent text, golden images) and nowhere else. This story is where it is proven on phones: the pilot device matrix, a screen reader on each platform, 200 percent text, measured start and list times, and the cases that break the network and kill the process. This page is the plan and the instruments. **Nothing on this page has been run on a device.** Every result table below is `NOT RUN`; the person who runs a row replaces that word with the number and attaches the evidence, and nobody else may.

Acceptance (ST-MOB-040): AC-ST-MOB-040-1 / UAT-NFR-ACCESSIBILITY-02 (names and roles, no clipping at 200 percent, 0 touch areas below 48 dp), AC-ST-MOB-040-2 / UAT-NFR-PERFORMANCE-02 (2.5 s p95 main content, 1 s p95 command), AC-ST-MOB-040-3 / UAT-AC502 (flapping, kill, licence, tenant change: one record, no lost field, the message matches the server). Requirements: NFR-ACCESSIBILITY-02, NFR-PERFORMANCE-02, NFR-OPERABILITY-03, NFR-AVAILABILITY-04. Findings of the review are in `docs/mobile-security-review.md` (ids `SYNC-01`, `NAV-01`, `NAV-02`, `PERF-01` matter here).

## The matrix

The pilot charter (D09) fixes the real list and is not in this repository. Until it is signed this is the **proposed** matrix; replace the example models with the ones the charter names, keep the roles.

| id | platform | example device | role | screen reader | notes |
|---|---|---|---|---|---|
| A1 | Android 14 | mid-range, 6 GB (Pixel 8a class) | reference of AC-ST-MOB-040-1 | TalkBack | the Android half of the acceptance criterion |
| A2 | Android 14 | low-end, 3 to 4 GB (Galaxy A15 class) | **target device class** for the budgets of AC-ST-MOB-040-2 | TalkBack | the slowest phone a pilot user is expected to own: the budget is judged here |
| A3 | oldest Android the build supports (`minSdk` of the Flutter template) | any | compatibility | TalkBack | secure storage and biometric prompt differ by OS version |
| I1 | iOS 18 | current iPhone | reference of AC-ST-MOB-040-1 | VoiceOver | the iOS half of the acceptance criterion |
| I2 | iOS 15 (deployment target of the project) | oldest iPhone that runs it | compatibility and performance floor | VoiceOver | |
| I3 | iOS 18 | smallest screen (iPhone SE class) | layout at 200 percent text | VoiceOver | |

Rooted or jailbroken devices for the security review are listed in `docs/mobile-security-review.md`, not here.

## What the host already proves

These run in `flutter test` and in the `Mobile` workflow. They are the reason a device run can concentrate on what a host cannot see.

| criterion | host test | what it covers |
|---|---|---|
| names, tap targets, contrast, no overflow at 200 percent of **every registered screen** | `test/hardening/accessibility_sweep_test.dart` | each of the 68 registered screens, found through the screen registry, opened at 360x800 and 200 percent and at 390x844, in the state it shows without its record; the app shell with its five tabs is in every screen that has one |
| the same on the content of a screen with data | the test of each feature (`expectScreenContract` / `meetsGuideline`); the sweep fails when a registered screen is named in no test file that checks them | content with data, forms, dialogs |
| the 48 dp and name audit on what a **device** draws | `tool/device/touch_target_audit.dart`, tested by `test/hardening/device_tools_test.dart` | the instrument used in the accessibility run; exit 0 clean, 1 findings, 65 a dump that is empty, not XML, cut short or unreadable (nothing was audited: never a PASS) |
| the verdict of the budgets | `tool/device/perf_verdict.dart`, tested by `test/hardening/device_tools_test.dart` | nearest-rank p95, at least 20 runs per device and metric, exit code |
| one record per submission, no lost field, the message follows the server | `test/hardening/resilience_matrix_test.dart` (24 seeded runs of cut networks, lost answers, kills before and after the work, server failures) and the tests of `command_queue_test.dart` | the logic of the queue against a faithful fake of `POST /sync/batches` and `GET /sync/commands/{key}` |
| an upload cut at a chunk or killed resumes without resending | `test/core/offline/attachment_uploader_test.dart` (AC-ST-MOB-009-1) | the logic of the uploader |
| licence expiry keeps the draft, tenant change sends nothing | `resilience_matrix_test.dart`, `sync_abuse_test.dart`, `test/features/account/account_test.dart` | |

## Accessibility run (AC-ST-MOB-040-1, UAT-NFR-ACCESSIBILITY-02)

Core screens: the ten of `qa/device/screens.core.txt` (sign-in, home, projects, weekly report first step, weekly report review and submit, approvals, notifications, queue, account, an empty list). NFR-ACCESSIBILITY-02 says "10 core MOB screens" without naming them: **ask the product owner to confirm this list**.

Set up each device once: Vietnamese interface; screen reader on; system text size at the largest setting. Android: also `adb shell settings put system font_scale 2.0` (the audit script does it and puts the old value back). iOS: Settings, Accessibility, Display and Text Size, Larger Text, Larger Accessibility Sizes, and move the slider until body text is twice its default height; write down the setting used.

For every core screen, in this order:

1. **Automatable on Android** (`qa/device/scripts/android_a11y_audit.sh <device> qa/device/screens.core.txt`): the dump of what the phone draws is audited for controls under 48 dp and controls with no name. Pass is 0 findings. On iOS use Xcode, Accessibility Inspector, Audit, on the same screens, and record the count of "Hit area is too small" and "Element has no description".
2. **By ear, with the screen reader**, swipe through the whole screen from the top without looking:
   - every control is read with its name and its role (button, switch, text field, tab, heading) and its state (selected, on, disabled, "2 of 5" for the tabs);
   - the order of reading is the order of the screen; a decorative icon is not read; nothing is read twice;
   - a message (empty, error, offline banner) is announced once when it appears, with its code and reference for an error;
   - after a dialog or the system browser of the sign-in closes, the focus returns to the control that opened it;
   - a form shows the error of a field next to the field and reads it; the on-screen keyboard does not hide the focused field.
3. **Text at 200 percent, by eye**: no text is cut or overlapped, no button is pushed out of reach, everything that matters can be scrolled to, and the figures of the weekly report (amounts in VND) are never truncated. Take a screenshot per screen.
4. **Gestures**: every action that has a swipe also has a button; the bottom navigation is reachable with the screen reader's own gestures.

Record in the table; a "fail" is a line of the fix list (TK-MOB-040-2) with the screen, the setting, the observation and a screenshot.

| device | screen | audit findings (dp / name) | reader: names & roles | reader: order & focus | 200 percent text | evidence |
|---|---|---|---|---|---|---|
| A1 | (ten rows per device) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A2 | | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| I1 | | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| I3 | | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Maestro cannot drive TalkBack or VoiceOver. `qa/device/flows/10_core_tabs_traversal.yaml` only proves the five tabs can be reached and are named on the device; it is run with the screen reader off as a smoke check and again by the tester with it on.

## Performance run (AC-ST-MOB-040-2, UAT-NFR-PERFORMANCE-02)

Budgets: **cold start to the main content p95 at most 2.5 s**, **list load p95 at most 2.5 s**, **command round trip p95 at most 1 s**, judged on the target device class (A2, I2) on the network of the matrix document, never on a desktop. At least **20 samples per device and metric**; fewer is `INSUFFICIENT`, not a pass (`tool/device/perf_verdict.dart`).

Conditions: release build (`--release`, not debug, not profile), device charged above 50 percent and cool, no other app in the foreground, a seeded tenant with the pilot data volume (list sizes of the charter), signed in, the same network for every run, the phone rested two minutes between devices.

| metric | how it is measured today | what the number means |
|---|---|---|
| `cold_start_main_content_ms` (Android) | `qa/device/scripts/run_cold_start_samples.sh`: force-stop, `am start`, then `uiautomator dump` until the content of the loaded home dashboard (the card of the two disbursement rates) is on screen, not the tab label | an **upper bound** (the dump adds 0.3 to 1 s): a pass is a pass, a fail near the budget is re-measured with a screen recording read frame by frame |
| `cold_start_main_content_ms` (iOS) | Instruments, App Launch template, or an XCTest `XCTApplicationLaunchMetric` plus a screen recording; the main content is the first frame with the loaded home dashboard drawn (the card of the two disbursement rates), not the tab bar | |
| `list_load_ms` | screen recording from the tap on the tab to the first frame with rows (both platforms); the tester reads the frame counts | needs 20 recordings per device: slow; the event `list.loaded` (`PERF-01`, fixed) gives the same figure from the phone itself |
| `command_round_trip_ms` | the event `command.round_trip` (`PERF-01`, fixed) is the time from the batch request to its answer on the phone, radio included; the API also logs the duration of every request with the correlation id (the server half) | measured on a device, the event is read from the telemetry of the run |

`PERF-01` is fixed: the events `app.cold_start` (first line of `main` to the first frame), `list.loaded` (the wait of a `DataView` for the server's answer) and `command.round_trip` are in `kTelemetryEvents`, each with `duration_ms`. With them, the figures come from the pilot users' own phones and the p95 is computed on a month of real use, which is a better proof than 20 samples.

Verdict: write the samples as `metric,device,run,ms` (`qa/device/results/measurements.template.csv`), then `dart run tool/device/perf_verdict.dart <file>`; exit code 0 only when every pair passes.

| device | metric | runs | p95 | budget | verdict |
|---|---|---|---|---|---|
| A2 | cold_start_main_content_ms | NOT RUN | NOT RUN | 2500 ms | NOT RUN |
| A2 | list_load_ms | NOT RUN | NOT RUN | 2500 ms | NOT RUN |
| A2 | command_round_trip_ms | NOT RUN | | 1000 ms | NOT RUN |
| I2 | cold_start_main_content_ms | NOT RUN | NOT RUN | 2500 ms | NOT RUN |
| I2 | list_load_ms | NOT RUN | NOT RUN | 2500 ms | NOT RUN |
| I2 | command_round_trip_ms | NOT RUN | | 1000 ms | NOT RUN |

## Resilience run (AC-ST-MOB-040-3, UAT-AC502)

Per device A1, A2, I1, I2. The tester needs a seeded weekly report period in draft and read access to the server's records (API or SQL) to count them.

| case | steps | pass |
|---|---|---|
| R1 network flapping during a submit | fill the seeded figures, set airplane mode, press "Nộp báo cáo"; switch the radio on and off every 5 to 10 s for 2 minutes (Android: `flows/30_flapping_and_kill_during_submit.yaml`; iOS by hand) | the screen says "Chưa xác định kết quả" while no answer is known and never "Đã gửi" before the server says so; after the radio is steady the server holds **exactly one** revision of the report; every figure typed is on it |
| R2 app killed during a save | type figures, switch the radio off, press save/submit, kill the application from the app switcher at once, reopen | the figures are still in the draft (0 lost), the command is in the queue and goes out once when the radio returns |
| R3 app killed during an upload | attach a 12 MP photo and a 20 MB PDF, kill the application at about half of the progress, reopen with and without network | the upload resumes without sending the finished chunks again, one attachment exists on the server, it ends `CLEAN` |
| R4 licence expiry | with a command queued offline, expire the tenant's licence on the server, bring the radio back | the command is refused with `LICENSE_EXPIRED`, the draft keeps every field, the screens turn read only, no record is created |
| R5 tenant change | with a command queued for tenant A, switch to tenant B (second membership) | the switch is refused until the person decides ("send first or discard"); nothing of A is sent with B's token; after returning to A the command is still there |
| R6 revoked membership while offline | switch the radio off, revoke the membership on the server, reopen the application offline, then online | `SEC-01` is fixed on the host: at the first online contact the session ends and the encrypted file and its key are deleted; the device run proves it on the platform |

| device | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|
| A1 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A2 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| I1 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| I2 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Two findings were fixed and change how R1 and R2 are read. `SYNC-01`: the queue runner starts with the signed-in application, so after a kill the queued command goes out at start and the banner "N thay đổi đang chờ gửi" counts it. `NAV-01`: the queue list (MOB-41) opens from the banner and from the account tab, so the state of a queued command can be read there.

## Evidence to archive (TK-MOB-040-5)

One folder per run, `results/<device>/<yyyy-mm-dd>/`: the screen recording of each case (with the touches shown), the screenshots named by the flows, the `uiautomator` dumps and the audit output, the measurement CSV and the verdict, the Maestro JUnit files, the `adb logcat` (Android) or the Console log (iOS) of the run **after checking it for tokens** (the application writes none; the check is part of `docs/mobile-security-review.md`), the server record counts for R1 to R6, the build number and the commit. The fix list (TK-MOB-040-2) names a screen, a device, the observation, the evidence file and the remediation commit (TK-MOB-040-3).

## What only a device can prove

TalkBack and VoiceOver as spoken (names, roles, order, focus, announcements); the real text-scale behaviour of the platform and of the fonts the device uses; touch areas on real densities; start and list times, memory and frame rate on a low-end phone; the radio going away at an arbitrary instant and the process being killed by the platform, not by a test; the system browser, the biometric prompt, the permission prompts and the keyboard; a 12 MP photograph being compressed in an isolate on a mid-range phone; background and foreground behaviour and notifications. All of the above are `NOT RUN`.

## Exit criteria

ST-MOB-040 is done when A1, A2, I1 and I2 show every row above as measured with evidence, `PERF-01`, `SYNC-01` and `NAV-01` are fixed (they are, on the host; the device run shows them on the platform), and every failed row has a remediation commit and a repeat run.
