import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/photo_pipeline.dart';
import 'package:machvon_mobile/features/release/telemetry.dart';

import '../features/support/scripted_server.dart';
import '../support/harness.dart';

// The findings of docs/mobile-security-review.md that were OPEN when the review was written, each pinned first to what was true then
// and now flipped into a test of the fixed behaviour. The behavioural tests of each fix are named in its group; the tests here are the
// ones that keep the fix from being undone quietly (a provider that nothing starts, a screen nobody links, a platform file that lost
// its protection). SEC-01 is in sync_abuse_test.dart and test/app/session_services_test.dart.

String _read(String path) => File(path).readAsStringSync();

List<File> _lib() => Directory('lib').listSync(recursive: true).whereType<File>().where((File f) => f.path.endsWith('.dart')).toList();

String _unix(File f) => f.path.replaceAll(r'\', '/');

void main() {
  group('TK-MOB-041-3 AC-ST-MOB-040-3 UAT-AC502 SYNC-01 FIXED the queue runner, the upload runner and the banner publisher start with the signed-in application', () {
    testWidgets('SYNC-01 FIXED a signed-in start creates all of them, without a screen asking for them', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpApp(tester, transport: ScriptedServer());
      expect(container.exists(queueRunnerProvider), isTrue);
      expect(container.exists(uploadRunnerProvider), isTrue);
      expect(container.exists(syncStatusPublisherProvider), isTrue);
      expect(container.exists(syncCoordinatorProvider), isTrue);
    });

    testWidgets('SYNC-01 FIXED a start with nobody signed in creates none of them', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final ProviderContainer container = await pumpApp(tester, transport: ScriptedServer(), session: FakeSession(const SessionSnapshot.signedOut()));
      expect(container.exists(queueRunnerProvider), isFalse);
      expect(container.exists(syncStatusPublisherProvider), isFalse);
    });

    test('SYNC-01 FIXED the root of the application names the providers, and the publisher is read by it', () {
      final String root = Directory('lib/app').listSync().whereType<File>().map((File f) => f.readAsStringSync()).join('\n') + _read('lib/main.dart');
      for (final String name in <String>['queueRunnerProvider', 'uploadRunnerProvider', 'syncStatusPublisherProvider', 'syncCoordinatorProvider', 'scopeRevocationProvider']) {
        expect(root, contains(name), reason: name);
      }
      expect(_read('lib/app/app.dart'), contains('SessionServices'));
    });
  });

  group('TK-MOB-041-3 AC-ST-MOB-040-3 NAV-01 FIXED the queue and the offline settings can be reached from the shell', () {
    test('NAV-01 FIXED the account screen links MOB-41 and MOB-43 beside MOB-48 to 51, and the sync banner is a button', () {
      final String account = _read('lib/features/account/screens/account_screen.dart');
      for (final String linked in <String>['MOB-41', 'MOB-43', 'MOB-48', 'MOB-49', 'MOB-50', 'MOB-51']) {
        expect(account, contains("locationOf('$linked')"));
      }
      final String banners = _read('lib/core/state/status_banners.dart');
      expect(banners, contains('StatusBanner'), reason: 'the strip is drawn by the shared banner');
      expect(_read('lib/core/widgets/state_view.dart'), contains('TapTarget'), reason: 'a banner with onTap is one button');
      expect(_read('lib/core/widgets/tap_target.dart'), contains('InkWell'));
      expect(banners, contains('onTap'));
      expect(banners, contains('context.go('));
      final List<String> openersOf43 = <String>[
        for (final File f in _lib())
          if (RegExp(r"'MOB-43'").hasMatch(f.readAsStringSync()) && !_unix(f).endsWith('offline_feature.dart') && !_unix(f).contains('generated') && !_unix(f).endsWith('route_policy.dart')) _unix(f),
      ];
      expect(openersOf43, <String>['lib/features/account/screens/account_screen.dart'], reason: 'MOB-43 is opened from the account tab');
    });
  });

  group('TK-MOB-040-1 AC-ST-MOB-040-2 UAT-NFR-PERFORMANCE-02 PERF-01 FIXED the application reports how long its start, a read and a command took', () {
    test('PERF-01 FIXED kTelemetryEvents holds the three events and their time is the duration_ms of telemetry.dart', () {
      final List<String> timing = kTelemetryEvents.where((String e) => RegExp(r'cold_start|load|round_trip|latency|duration').hasMatch(e)).toList()..sort();
      expect(timing, <String>['app.cold_start', 'command.round_trip', 'list.loaded']);
      final List<String> users = <String>[
        for (final File f in _lib())
          if (f.readAsStringSync().contains("'duration_ms'")) _unix(f),
      ]..sort();
      expect(users, <String>['lib/features/release/telemetry.dart', 'lib/features/reporting/data/submit_funnel.dart']);
      for (final String caller in <String>['lib/main.dart', 'lib/core/offline/offline_providers.dart', 'lib/features/read_support/data_view.dart']) {
        expect(_read(caller), contains(RegExp('recordColdStart|reportColdStartAfterFirstFrame|recordCommandRoundTrip|recordListLoaded')), reason: caller);
      }
    });
  });

  group('TK-MOB-041-1 AC-ST-MOB-041-1 SEC-03 FIXED photographs and prepared uploads do not outlive their use', () {
    test('SEC-03 FIXED the picker file is deleted, a clean upload deletes its prepared copy, and iOS leaves the offline folder out of a backup', () {
      expect(const EvidenceLimits().retainOriginals, isTrue, reason: 'the retention policy is unchanged: the original is kept beside the sent copy until the server has the record');
      expect(_read('lib/features/field_evidence/device_sources.dart'), contains('picked.delete()'));
      expect(_read('lib/core/offline/attachments/attachment_uploader.dart'), contains('void _clean('));
      expect(RegExp(r'deleteSync').allMatches(_read('lib/core/offline/attachments/attachment_uploader.dart')).length, 3, reason: 'the copy fails, cancel(), and clean');
      expect(_read('lib/core/offline/queue/command_queue.dart'), contains('retireDraftFiles('));
      expect(_read('ios/Runner/AppDelegate.swift'), allOf(contains('isExcludedFromBackup = true'), contains('"offline"')));
      expect(_read('lib/core/offline/offline_providers.dart'), contains("'offline'"), reason: 'the folder the platform flag names is the folder the application uses');
    });
  });

  group('TK-MOB-041-1 SEC-04 FIXED the content is hidden in the app switcher and from a screen capture on the screens of money and decisions', () {
    test('SEC-04 FIXED both platform files carry the protection', () {
      expect(_read('android/app/src/main/kotlin/vn/machvon/machvon_mobile/MainActivity.kt'), contains('FLAG_SECURE'));
      final String ios = _read('ios/Runner/AppDelegate.swift') + _read('ios/Runner/SceneDelegate.swift');
      expect(ios, contains('UIScene.willDeactivateNotification'));
      expect(ios, contains('isCaptured'));
      expect(_read('lib/core/navigation/router.dart'), contains('SecureScreen('));
    });
  });

  group('TK-MOB-041-2 INTEG-01 FIXED the integrity and pinning policies are wired into the application', () {
    test('INTEG-01 FIXED the monitor, the state and the version policy import them', () {
      final List<String> users = <String>[
        for (final File f in _lib())
          if (!_unix(f).contains('lib/core/security/') && RegExp(r'security/(device_integrity|pinning_policy|integrity_state)\.dart').hasMatch(f.readAsStringSync())) _unix(f),
      ]..sort();
      expect(users, containsAll(<String>[
        'lib/features/release/integrity_monitor.dart',
        'lib/features/release/version_policy.dart',
        'lib/features/release/release_providers.dart',
        'lib/features/session/session_providers.dart',
        'lib/core/state/status_banners.dart',
      ]));
      expect(_read('lib/app/session_services.dart'), contains('integrityMonitorProvider'));
      expect(_read('lib/features/release/telemetry.dart'), contains("'device.integrity'"));
    });
  });
}
