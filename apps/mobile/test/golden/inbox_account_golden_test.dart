import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/account/account_feature.dart' as account;
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;
import 'package:machvon_mobile/features/permissions/permission_providers.dart';
import 'package:machvon_mobile/features/phone_search/phone_search_feature.dart' as phone_search;
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:machvon_mobile/features/session/auth/auth_service.dart';
import 'package:machvon_mobile/features/session/auth/pending_work.dart';
import 'package:machvon_mobile/features/session/session_providers.dart';

import '../features/notification_inbox/notification_fixtures.dart';
import '../features/permissions/permissions_test.dart' show FakePermissions;
import '../features/session/support/app.dart';
import '../features/session/support/world.dart';
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the screens of MUX-3 wave A that belong to the notification inbox and the account tab: the inbox in the light mode, the
/// dark mode, at 200 percent text, empty and offline (the copy kept on the phone), and the account in the light mode, the dark mode and at 200
/// percent text. The texts are drawn with the test font, which Windows and Linux rasterise differently, so
/// each OS compares with goldens of its own (useOsGoldens); layout and touch targets are proved by the widget tests of the screens.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

class _NoPending implements PendingWork {
  @override
  Future<int> count() async => 0;

  @override
  Future<void> discardUnsent() async {}

  @override
  Future<void> sendNow() async {}
}

class _Info implements AppInfoSource {
  @override
  Future<AppInfo> read() async => const AppInfo(version: '1.4.0', build: '27', platform: 'android', osVersion: '14');
}

const Size _phone = Size(390, 844);

ScriptedServer _server({List<Map<String, Object?>>? items}) {
  final ScriptedServer server = ScriptedServer();
  server
    ..on('GET', '/me/notifications', (_) => notificationsPage(items ?? standardNotifications()))
    ..on('GET', '/home/my-work', (_) => <String, Object?>{'items': <Object?>[], 'counts': <String, Object?>{'urgent': 0, 'action': 0, 'watch': 0, 'total': 0}, 'view': 'mine'})
    ..on('GET', '/home/my-work/counts', (_) => <String, Object?>{'view': 'mine', 'counts': <String, Object?>{'urgent': 2, 'action': 1, 'watch': 0, 'total': 3}});
  return server;
}

Future<void> _inbox(WidgetTester tester, ScriptedServer server, {bool dark = false, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  await pumpWithServer(
    tester,
    features: <MobileFeature>[notifications.feature],
    server: server,
    location: '/inbox',
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
}

Future<void> _account(WidgetTester tester, {bool dark = false, double scale = 1.0}) async {
  useDevice(tester, _phone, textScale: scale);
  final World world = World();
  final AuthService seed = world.service();
  await seed.signIn(kOidcConfig);
  await pumpSessionApp(
    tester,
    world,
    location: '/account',
    features: <MobileFeature>[account.feature, phone_search.feature],
    overrides: <Override>[
      secureValueStoreProvider.overrideWithValue(world.store),
      pendingWorkProvider.overrideWithValue(_NoPending()),
      biometricGateProvider.overrideWithValue(world.biometrics),
      permissionPlatformProvider.overrideWithValue(FakePermissions()),
      appInfoSourceProvider.overrideWithValue(_Info()),
      if (dark) themeModeProvider.overrideWith(_Dark.new),
    ],
  );
}

void main() {
  useOsGoldens('test/golden/inbox_account_golden_test.dart');

  group('MUX-3 wave A the notification inbox (MOB-32)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _inbox(tester, _server());
      expect(find.text('Tất cả 4'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/inbox_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _inbox(tester, _server(), dark: true);
      expect(Theme.of(tester.element(find.text('Tất cả 4'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/inbox_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _inbox(tester, _server(), scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/inbox_text200.png'));
    });

    testWidgets('empty', (WidgetTester tester) async {
      await _inbox(tester, _server(items: <Map<String, Object?>>[]));
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/inbox_empty.png'));
    });

    testWidgets('offline: the copy kept on the phone, with the one strip of the shell', (WidgetTester tester) async {
      final ScriptedServer server = _server();
      await _inbox(tester, server);
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/inbox_offline.png'));
    });
  });

  group('MUX-3 wave A the account tab (MOB-47)', () {
    testWidgets('light', (WidgetTester tester) async {
      await _account(tester);
      expect(find.text('Ana'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/account_light.png'));
    });

    testWidgets('dark', (WidgetTester tester) async {
      await _account(tester, dark: true);
      expect(Theme.of(tester.element(find.text('Ana'))).brightness, Brightness.dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/account_dark.png'));
    });

    testWidgets('text 200 percent', (WidgetTester tester) async {
      await _account(tester, scale: 2.0);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/account_text200.png'));
    });
  });
}
